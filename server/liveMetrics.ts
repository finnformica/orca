// The machine card's high-resolution view of the box: one sample every 15 s for the last 6 hours,
// in memory only (no table — the 1-minute `instance_metric` history covers longer ranges). On
// 2026-10-19 an IO stall (iowait 80 %, reads at the EBS cap) looked like CPU on the old one-line
// chart. Each sample splits the CPU into work and iowait (/proc/stat), reads the root disk's MB/s
// (/proc/diskstats) and splits memory into used and cache (/proc/meminfo). Whole box only: no
// per-workstream split (Finn's call). Cost: three small /proc reads every 15 s, no process spawned.
import { readFileSync } from "fs";
import * as os from "os";
import { parseProcStat, type ProcStatTimes } from "./health";
import * as cgroup from "./cgroup";
import * as heavy from "./heavy";
import { machineSummary, type MachineReport } from "../web/src/workstream";

export const LIVE_SAMPLE_MS = 15_000;
export const LIVE_WINDOW_MS = 6 * 3_600_000;
/** The disk's throughput cap (MB/s) drawn on the Disk IO chart: `ORCA_DISK_CAP_MBS`, else the gp3
 *  baseline. A per-host setting, because the cap belongs to this machine's volume. */
export const DEFAULT_DISK_CAP_MBS = 125;
/** At most this many points per answer: a 6-hour ring is 1440 samples, and no 600px chart needs them. */
export const LIVE_MAX_POINTS = 360;

export type LiveSample = {
  at: number;
  /** % of all cores: work = user+nice+system+irq+softirq+steal; iowait. Idle is the rest. */
  work: number; iowait: number;
  load1: number;
  /** The root disk, MB/s. Absent without /proc/diskstats. */
  readMBs?: number; writeMBs?: number;
  /** GB. used = MemTotal − MemAvailable; cache = MemAvailable − MemFree (reclaimable page cache). */
  memUsedGb: number; memCacheGb: number;
  /** GB: MemAvailable, and swap in use (SwapTotal − SwapFree). Absent from samples before they were read. */
  memAvailGb?: number; swapUsedGb?: number;
  /** Agent runs OOM-killed since the previous sample. */
  ooms?: number;
};
export type LiveAnswer = {
  samples: LiveSample[]; stepMs: number; cores: number; memTotalGb: number;
  /** The agents' slice MemoryMax (GB), when the box runs agents in it. */
  sliceMaxGb?: number;
  diskCapMBs: number;
};

// ---- pure parsers (fixture-tested) ----

/** /proc/meminfo as used, cache, available and swap-used GB, or undefined when the lines are missing. */
export function parseMeminfo(text: string): { totalGb: number; usedGb: number; cacheGb: number; availGb: number; swapUsedGb: number } | undefined {
  const kb = (k: string) => { const m = text.match(new RegExp(`^${k}:\\s+(\\d+) kB$`, "m")); return m ? Number(m[1]) : undefined; };
  const total = kb("MemTotal"), free = kb("MemFree"), avail = kb("MemAvailable");
  if (total === undefined || free === undefined || avail === undefined) return undefined;
  const gb = (n: number) => Math.round((Math.max(0, n) / 1_048_576) * 100) / 100;
  return { totalGb: gb(total), usedGb: gb(total - avail), cacheGb: gb(avail - free), availGb: gb(avail), swapUsedGb: gb((kb("SwapTotal") ?? 0) - (kb("SwapFree") ?? 0)) };
}

/** The `major:minor` of the filesystem mounted at `/`, from /proc/self/mountinfo. */
export function rootDevice(mountinfo: string): { major: number; minor: number } | undefined {
  for (const line of mountinfo.split("\n")) {
    const f = line.split(" ");
    if (f[4] === "/" && /^\d+:\d+$/.test(f[2] ?? "")) {
      const [major, minor] = f[2]!.split(":").map(Number);
      return { major: major!, minor: minor! };
    }
  }
  return undefined;
}

export type DiskCounters = { readSectors: number; writeSectors: number };

/** One device's sector counters from /proc/diskstats (fields 6 and 10; a sector is 512 bytes there,
 *  whatever the device's own sector size). */
export function parseDiskstats(text: string, dev: { major: number; minor: number }): DiskCounters | undefined {
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (Number(f[0]) === dev.major && Number(f[1]) === dev.minor && f.length >= 10) {
      return { readSectors: Number(f[5]), writeSectors: Number(f[9]) };
    }
  }
  return undefined;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Read and write MB/s between two diskstats reads `ms` apart. A counter that went back (a reset) reads 0. */
export function diskRates(prev: DiskCounters, curr: DiskCounters, ms: number): { readMBs: number; writeMBs: number } {
  const rate = (d: number) => (ms > 0 && d > 0 ? round1((d * 512) / 1_048_576 / (ms / 1000)) : 0);
  return { readMBs: rate(curr.readSectors - prev.readSectors), writeMBs: rate(curr.writeSectors - prev.writeSectors) };
}

/** Work and iowait as % of all cores between two /proc/stat reads, to 0.1. */
export function cpuSplit(prev: ProcStatTimes, curr: ProcStatTimes): { work: number; iowait: number } {
  const total = curr.total - prev.total;
  if (total <= 0) return { work: 0, iowait: 0 };
  const iowait = curr.iowait - prev.iowait;
  const work = total - (curr.idle - prev.idle) - iowait;
  const pct = (n: number) => Math.min(100, Math.max(0, round1((n / total) * 100)));
  return { work: pct(work), iowait: pct(iowait) };
}

const optional = <K extends string>(k: K, v: number | undefined) => (v === undefined ? {} : { [k]: v } as Record<K, number>);

/** Means of the samples per time bucket, at most `max` buckets over [from, to]. OOM kills add up. Pure. */
export function bucketLive(samples: LiveSample[], max: number, from: number, to: number): LiveSample[] {
  const inRange = samples.filter((s) => s.at >= from && s.at <= to);
  if (inRange.length <= max) return inRange;
  const width = Math.max(1, (to - from) / max);
  const groups = new Map<number, LiveSample[]>();
  for (const s of inRange) {
    const b = Math.min(max - 1, Math.floor((s.at - from) / width));
    (groups.get(b) ?? groups.set(b, []).get(b)!).push(s);
  }
  const mean = (g: LiveSample[], f: (s: LiveSample) => number | undefined, r = round1) => {
    const v = g.map(f).filter((n): n is number => n !== undefined);
    return v.length ? r(v.reduce((a, b) => a + b, 0) / v.length) : undefined;
  };
  return [...groups.values()].map((g) => {
    const ooms = g.reduce((n, s) => n + (s.ooms ?? 0), 0);
    return {
      at: g[g.length - 1]!.at, work: mean(g, (s) => s.work)!, iowait: mean(g, (s) => s.iowait)!,
      load1: mean(g, (s) => s.load1, round2)!,
      ...optional("readMBs", mean(g, (s) => s.readMBs)), ...optional("writeMBs", mean(g, (s) => s.writeMBs)),
      memUsedGb: mean(g, (s) => s.memUsedGb, round2)!, memCacheGb: mean(g, (s) => s.memCacheGb, round2)!,
      ...optional("memAvailGb", mean(g, (s) => s.memAvailGb, round2)), ...optional("swapUsedGb", mean(g, (s) => s.swapUsedGb, round2)),
      ...(ooms ? { ooms } : {}),
    };
  });
}

// ---- the sampler (I/O) ----

const read = (path: string): string | undefined => {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
};

let ring: LiveSample[] = [];
let ooms = 0;
/** health.noteOomKill counts here too, so the live Memory chart keeps its OOM marks. */
export function noteLiveOom(): void { ooms++; }

/** The sampler: each `tick()` reads the counters and returns one sample (none on the first tick,
 *  which only sets the baseline, and none off Linux). `procRoot` lets a test feed fixture files. */
export function createLiveSampler(o: { procRoot?: string; now?: () => number; load1?: () => number } = {}) {
  const proc = o.procRoot ?? "/proc";
  const now = o.now ?? Date.now;
  const load1 = o.load1 ?? (() => os.loadavg()[0] ?? 0);
  const dev = rootDevice(read(`${proc}/self/mountinfo`) ?? "");
  let prev: { at: number; stat: ProcStatTimes; disk?: DiskCounters } | undefined;
  return {
    tick(): LiveSample | undefined {
      const at = now();
      const stat = parseProcStat((read(`${proc}/stat`) ?? "").split("\n", 1)[0] ?? "");
      const mem = parseMeminfo(read(`${proc}/meminfo`) ?? "");
      if (!stat || !mem) return undefined; // not Linux
      const disk = dev ? parseDiskstats(read(`${proc}/diskstats`) ?? "", dev) : undefined;
      const last = prev;
      prev = { at, stat, disk };
      if (!last) return undefined;
      const io = disk && last.disk ? diskRates(last.disk, disk, at - last.at) : undefined;
      const kills = ooms;
      ooms = 0;
      return {
        at, ...cpuSplit(last.stat, stat), load1: round2(load1()), ...(io ?? {}),
        memUsedGb: mem.usedGb, memCacheGb: mem.cacheGb, memAvailGb: mem.availGb, swapUsedGb: mem.swapUsedGb, ...(kills ? { ooms: kills } : {}),
      };
    },
  };
}

/** Push a sample and drop what fell out of the 6-hour window. */
export function pushLive(sample: LiveSample, window = LIVE_WINDOW_MS): void {
  ring.push(sample);
  const cut = sample.at - window;
  let i = 0;
  while (i < ring.length && ring[i]!.at < cut) i++;
  if (i) ring = ring.slice(i);
}

/** Start the 15 s sampler. Every bridge runs it (preview bridges too): it only reads /proc. */
export function startLiveSampler(ms = LIVE_SAMPLE_MS): ReturnType<typeof setInterval> {
  const s = createLiveSampler();
  const tick = () => {
    try {
      const v = s.tick();
      if (v) pushLive(v);
    } catch (e) {
      console.error(`orca: live metrics sample failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  tick();
  return setInterval(tick, ms).unref();
}

/** The disk cap for this host: `ORCA_DISK_CAP_MBS` when it is a positive number, else the default. */
export function diskCapMBs(raw = process.env.ORCA_DISK_CAP_MBS): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : DEFAULT_DISK_CAP_MBS;
}

/** The last `hours` (at most 6) of samples, bucketed to `LIVE_MAX_POINTS`. */
export function liveAnswer(hours: number, o: { sliceMaxGb?: number; now?: number } = {}): LiveAnswer {
  const to = o.now ?? Date.now(), from = to - Math.min(hours, 6) * 3_600_000;
  return {
    samples: bucketLive(ring, LIVE_MAX_POINTS, from, to), stepMs: LIVE_SAMPLE_MS,
    cores: os.cpus().length || 1, memTotalGb: Math.round((os.totalmem() / 1_073_741_824) * 10) / 10,
    ...(o.sliceMaxGb ? { sliceMaxGb: o.sliceMaxGb } : {}),
    diskCapMBs: diskCapMBs(),
  };
}

/** The agents' slice MemoryMax the charts draw, when this box runs agents in it. */
export const sliceMaxGbHere = (): number | undefined => (cgroup.available() ? cgroup.agentsSliceMaxGb() : undefined);

/** `GET /api/machine` and `orca machine`: the last hour of the SAME ring the card reads (through
 *  `liveAnswer`, as /api/health/live does), its windows (`machineSummary`, over the card's
 *  `liveCharts`), and the heavy queue's counts. */
export function machineReport(instance: string, o: { now?: number; sliceMaxGb?: number } = {}): MachineReport {
  const a = liveAnswer(1, { now: o.now, sliceMaxGb: "sliceMaxGb" in o ? o.sliceMaxGb : sliceMaxGbHere() });
  const q = heavy.slots().view();
  return {
    instance, at: a.samples.at(-1)?.at ?? o.now ?? Date.now(), cores: a.cores, memTotalGb: a.memTotalGb,
    ...(a.sliceMaxGb ? { sliceMaxGb: a.sliceMaxGb } : {}), diskCapMBs: a.diskCapMBs, stepMs: a.stepMs,
    summary: machineSummary(a.samples, a.cores), heavy: { running: q.running.length, queued: q.queued.length }, samples: a.samples,
  };
}

/** Tests: empty the ring. */
export function resetLive(): void { ring = []; ooms = 0; }
