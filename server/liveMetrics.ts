// The machine card's high-resolution view of the box: one sample every 15 s for the last 6 hours,
// kept in memory as the fast path for every poll, and persisted in Postgres (`machine_sample`,
// server/db.ts) so a restart doesn't lose the chart. On 2026-10-19 an IO stall (iowait 80 %, reads
// at the EBS cap) looked like CPU on the old one-line chart. Each sample splits the CPU into work
// and iowait (/proc/stat), reads the root disk's MB/s (/proc/diskstats) and splits memory into used
// and cache (/proc/meminfo). Whole box only: no per-workstream split (Finn's call). Cost: three
// small /proc reads every 15 s, no process spawned. On macOS (no /proc) the CPU comes from
// os.cpus() ticks, and memory and disk take turns: one tick spawns `vm_stat`, the next `ioreg`, so
// a Mac spawns one small process every 15 s.
import { readFileSync } from "fs";
import * as os from "os";
import { parseProcStat, type ProcStatTimes } from "./health";
import * as cgroup from "./cgroup";
import * as heavy from "./heavy";
import { unqueuedSummary } from "./heavyLeaks";
import { run } from "./run";
import * as db from "./db";
import * as lease from "./lease";
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

// ---- macOS parsers (fixture-tested): no /proc there ----

/** os.cpus() summed over the cores, in the shape of a /proc/stat read, so `cpuSplit` serves both.
 *  macOS reports no iowait: it reads 0. */
export function darwinCpuTimes(cpus: { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]): ProcStatTimes {
  const t = { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0, total: 0 };
  for (const c of cpus) { t.user += c.times.user; t.nice += c.times.nice; t.system += c.times.sys; t.idle += c.times.idle; t.irq += c.times.irq; }
  t.total = t.user + t.nice + t.system + t.idle + t.irq;
  return t;
}

/** `vm_stat` as used, cache and available GB. used = active + wired + compressor (Activity Monitor's
 *  "Memory Used", the same figure as /api/health's header); cache = inactive + speculative, the pages
 *  the kernel takes back first (mostly file-backed), clamped to what used leaves; available = total −
 *  used. Undefined when the page size or a needed line is missing. */
export function parseVmStatMemory(text: string, totalBytes: number): { usedGb: number; cacheGb: number; availGb: number } | undefined {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  const pages = (k: string) => { const m = text.match(new RegExp(`^${k}:\\s+(\\d+)\\.`, "m")); return m ? Number(m[1]) : undefined; };
  const active = pages("Pages active"), wired = pages("Pages wired down"), inactive = pages("Pages inactive");
  if (!pageSize || active === undefined || wired === undefined || inactive === undefined || !(totalBytes > 0)) return undefined;
  const used = Math.min(totalBytes, pageSize * (active + wired + (pages("Pages occupied by compressor") ?? 0)));
  const cache = Math.min(totalBytes - used, pageSize * (inactive + (pages("Pages speculative") ?? 0)));
  const gb = (n: number) => round2(Math.max(0, n) / 1_073_741_824);
  return { usedGb: gb(used), cacheGb: gb(cache), availGb: gb(totalBytes - used) };
}

export type DiskBytes = { readBytes: number; writeBytes: number };

/** The bytes read and written since boot, summed over every block storage driver in
 *  `ioreg -r -c IOBlockStorageDriver -k Statistics -d 1 -w 0`. Undefined when no driver reports them. */
export function parseIoregDisk(text: string): DiskBytes | undefined {
  const sum = (k: string) => [...text.matchAll(new RegExp(`"Bytes \\(${k}\\)"=(\\d+)`, "g"))].reduce((n, m) => n + Number(m[1]), 0);
  if (!/"Bytes \((Read|Write)\)"=\d+/.test(text)) return undefined;
  return { readBytes: sum("Read"), writeBytes: sum("Write") };
}

/** Read and write MB/s between two byte counts `ms` apart. A counter that went back reads 0. */
export function byteRates(prev: DiskBytes, curr: DiskBytes, ms: number): { readMBs: number; writeMBs: number } {
  const rate = (d: number) => (ms > 0 && d > 0 ? round1(d / 1_048_576 / (ms / 1000)) : 0);
  return { readMBs: rate(curr.readBytes - prev.readBytes), writeMBs: rate(curr.writeBytes - prev.writeBytes) };
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

export const VM_STAT_CMD = ["vm_stat"];
export const IOREG_CMD = ["ioreg", "-r", "-c", "IOBlockStorageDriver", "-k", "Statistics", "-d", "1", "-w", "0"];

/** The macOS sampler. CPU on every tick (os.cpus(), no spawn); memory and disk take turns, so each
 *  tick spawns ONE command: even ticks `vm_stat`, odd ticks `ioreg`. A sample carries the newest
 *  memory reading and the disk rate over the last two `ioreg` reads (30 s apart). No sample on the
 *  first tick, nor until a memory reading exists. Swap is absent: `vm_stat` does not report it. */
export function createDarwinSampler(o: {
  now?: () => number; load1?: () => number; cpus?: () => Parameters<typeof darwinCpuTimes>[0];
  totalBytes?: () => number; run?: (cmd: string[]) => Promise<string>;
} = {}) {
  const now = o.now ?? Date.now;
  const load1 = o.load1 ?? (() => os.loadavg()[0] ?? 0);
  const cpus = o.cpus ?? os.cpus;
  const totalBytes = o.totalBytes ?? os.totalmem;
  const exec = o.run ?? ((cmd: string[]) => run(cmd));
  let n = 0;
  let prevCpu: ProcStatTimes | undefined;
  let mem: ReturnType<typeof parseVmStatMemory>;
  let disk: { at: number; bytes: DiskBytes } | undefined;
  let io: { readMBs: number; writeMBs: number } | undefined;
  return {
    async tick(): Promise<LiveSample | undefined> {
      const at = now();
      const cpu = darwinCpuTimes(cpus());
      const turn = n++ % 2;
      try {
        if (turn === 0) mem = parseVmStatMemory(await exec(VM_STAT_CMD), totalBytes()) ?? mem;
        else {
          const bytes = parseIoregDisk(await exec(IOREG_CMD));
          if (bytes) { io = disk ? byteRates(disk.bytes, bytes, at - disk.at) : io; disk = { at, bytes }; }
        }
      } catch { /* the command is missing or failed: keep the last reading */ }
      const last = prevCpu;
      prevCpu = cpu;
      if (!last || !mem) return undefined;
      const kills = ooms;
      ooms = 0;
      return {
        at, ...cpuSplit(last, cpu), load1: round2(load1()), ...(io ?? {}),
        memUsedGb: mem.usedGb, memCacheGb: mem.cacheGb, memAvailGb: mem.availGb, ...(kills ? { ooms: kills } : {}),
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

// ---- persisting the ring across a restart (machine_sample table, server/db.ts) ----
// The ring was in memory only: every deploy, every crash, lost the whole 6-hour chart (`orca machine`
// said "1 h covers only 11 min (the bridge restarted since)" seconds after a routine restart). Each
// 15 s sample is buffered here and flushed to Postgres about once a minute — few writes, not one a
// tick — and the newest 6 hours are read back to seed the ring before the sampler starts ticking.
// The ring stays the fast path for every poll: nothing below is read again until the next restart.
// A real gap in the samples (the bridge really was down) needs no special drawing: it is a gap in
// `at`, and `stackRuns` already breaks the chart's area there instead of bridging it.

export const MACHINE_SAMPLE_FLUSH_MS = 60_000;
let pendingSamples: LiveSample[] = [];
let lastFlushAt = -Infinity; // so the very first sample always flushes, whatever `now`'s scale is

/** Buffer a sample and flush the batch once a minute has passed since the last flush (the very
 *  first call always flushes). Dropped while the database is down (logged once, by db.ts) or on a
 *  write failure — the table is advisory, like the lease and the ledger: losing a batch loses only
 *  the restart gap, never a live sample the ring already has. Callers don't need the returned
 *  promise (the sampler's tick doesn't await it); tests do, to make a flush deterministic. */
export function bufferMachineSample(sample: LiveSample, now = sample.at): Promise<void> | undefined {
  pendingSamples.push(sample);
  if (now - lastFlushAt < MACHINE_SAMPLE_FLUSH_MS) return undefined;
  lastFlushAt = now;
  return flushBatch();
}

async function flushBatch(): Promise<void> {
  if (!pendingSamples.length) return;
  const batch = pendingSamples;
  pendingSamples = [];
  if (db.unavailableSince() !== null) return; // dropped, like a skipped instance_metric sample
  const runningAgents = lease.live().length;
  try { await db.recordMachineSamples(batch.map((s) => ({ ...s, runningAgents }))); } catch (e) { db.logUnlessDown("orca: failed to save machine samples")(e); }
}

/** Force the buffered batch to Postgres now, bypassing the once-a-minute throttle — the SIGTERM /
 *  SIGINT path, so shutdown doesn't wait up to a minute for the last few samples to land. */
export async function flushMachineSamples(): Promise<void> {
  lastFlushAt = Date.now();
  await flushBatch();
}

/** Restore the ring from the last 6 hours of `machine_sample` rows before the sampler starts
 *  ticking, so a restart keeps its chart instead of starting empty. Merges rather than replaces, so
 *  a sample the fresh tick already pushed while this was in flight survives. A missing table, an
 *  unreachable database, or any other read failure just leaves the ring as it was — advisory, like
 *  the lease and the ledger. */
export async function restoreLiveRing(instance = db.instanceName(), now = Date.now()): Promise<void> {
  try {
    const history = await db.machineSampleHistory(instance, 6, now);
    const cutoff = history.length ? history[history.length - 1]!.at : -Infinity;
    const cut = now - LIVE_WINDOW_MS;
    ring = [...history, ...ring.filter((s) => s.at > cutoff)].filter((s) => s.at >= cut);
  } catch (e) {
    db.logUnlessDown("orca: failed to restore the machine ring")(e);
  }
}

/** Start the 15 s sampler. Every bridge runs it (preview bridges too): on Linux it only reads /proc,
 *  on macOS it spawns one small command a tick. Restores the ring from the database first — never
 *  awaited, so a slow or unreachable database never delays the sampler starting. */
export function startLiveSampler(ms = LIVE_SAMPLE_MS, platform = process.platform): ReturnType<typeof setInterval> {
  void restoreLiveRing();
  const s: { tick(): LiveSample | undefined | Promise<LiveSample | undefined> } = platform === "darwin" ? createDarwinSampler() : createLiveSampler();
  let busy = false;
  const tick = async () => {
    if (busy) return; // a slow spawn never stacks ticks
    busy = true;
    try {
      const v = await s.tick();
      if (v) { pushLive(v); bufferMachineSample(v); }
    } catch (e) {
      console.error(`orca: live metrics sample failed: ${e instanceof Error ? e.message : e}`);
    } finally { busy = false; }
  };
  void tick();
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

const unqueuedField = () => { const u = unqueuedSummary(); return u ? { unqueued: { count: u.count, names: u.names } } : {}; };

/** `GET /api/machine` and `orca machine`: the last hour of the SAME ring the card reads (through
 *  `liveAnswer`, as /api/health/live does), its windows (`machineSummary`, over the card's
 *  `liveCharts`), and the heavy queue's counts. */
export function machineReport(instance: string, o: { now?: number; sliceMaxGb?: number } = {}): MachineReport {
  const a = liveAnswer(1, { now: o.now, sliceMaxGb: "sliceMaxGb" in o ? o.sliceMaxGb : sliceMaxGbHere() });
  const q = heavy.slots().view();
  return {
    instance, at: a.samples.at(-1)?.at ?? o.now ?? Date.now(), cores: a.cores, memTotalGb: a.memTotalGb,
    ...(a.sliceMaxGb ? { sliceMaxGb: a.sliceMaxGb } : {}), diskCapMBs: a.diskCapMBs, stepMs: a.stepMs,
    summary: machineSummary(a.samples, a.cores), heavy: { running: q.running.length, queued: q.queued.length, ...unqueuedField() }, samples: a.samples,
  };
}

/** /api/health's CPU and iowait from the ring's newest sample when it is under `maxAgeMs` old, so the
 *  card's header, its CPU chart and `orca machine` show ONE reading. (health()'s own delta is "since
 *  any caller last read /proc/stat": two polls close together read noise, e.g. 97 % beside a 4 % chart.) */
export function withLiveCpu<T extends { cpuPct: number; iowaitPct?: number }>(h: T, newest: LiveSample | undefined, now = Date.now(), maxAgeMs = 60_000): T {
  return newest && now - newest.at <= maxAgeMs ? { ...h, cpuPct: Math.round(newest.work), iowaitPct: Math.round(newest.iowait) } : h;
}
export const newestLive = (): LiveSample | undefined => ring[ring.length - 1];

/** Tests: empty the ring and the flush buffer/throttle. */
export function resetLive(): void { ring = []; ooms = 0; pendingSamples = []; lastFlushAt = -Infinity; }
