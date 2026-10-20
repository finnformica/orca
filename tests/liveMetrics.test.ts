// The machine card's 15 s sampler (server/liveMetrics.ts): pure parsers fed fixture text copied from
// the box, and the sampler over a fixture /proc directory.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseProcStat } from "../server/health";
import { instanceStatus } from "../web/src/workstream";
import {
  bucketLive, byteRates, cpuSplit, createDarwinSampler, createLiveSampler, darwinCpuTimes, IOREG_CMD, parseIoregDisk, parseVmStatMemory, VM_STAT_CMD, diskCapMBs, diskRates, liveAnswer, noteLiveOom, parseDiskstats, parseMeminfo,
  pushLive, resetLive, rootDevice, type LiveSample,
} from "../server/liveMetrics";

const MOUNTINFO = `25 30 0:23 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw
28 1 259:1 / / rw,relatime shared:1 - ext4 /dev/root rw,discard,errors=remount-ro,commit=30
31 28 259:4 / /boot rw,relatime shared:3 - ext4 /dev/nvme0n1p16 rw
`;
const DISKSTATS = (read: number, write: number) => `   7       0 loop0 47538 0 4017081 1387323 0 0 0 0 0 311801 1387323 0 0 0 0 0 0
 259       0 nvme0n1 38328448 4763743 1929766895 180288523 17521896 55799891 1265275460 58315502 0 23549261 238604026 0 0 0 0 0 0
 259       1 nvme0n1p1 38325400 4762035 ${read} 180286622 17521565 55799814 ${write} 58313851 0 25741111 238600474 0 0 0 0 0 0
`;
const MEMINFO = `MemTotal:       16078392 kB
MemFree:         7568112 kB
MemAvailable:   13751040 kB
Buffers:          503620 kB
Cached:          4887888 kB
SwapTotal:       4194300 kB
SwapFree:        3982408 kB
`;
const STAT = (user: number, system: number, idle: number, iowait: number) =>
  `cpu  ${user} 0 ${system} ${idle} ${iowait} 0 0 0 0 0\ncpu0 1 2 3 4 5 6 7 8 0 0\n`;

describe("parsers", () => {
  test("rootDevice finds the device mounted at /", () => {
    expect(rootDevice(MOUNTINFO)).toEqual({ major: 259, minor: 1 });
    expect(rootDevice("")).toBeUndefined();
  });

  test("parseDiskstats reads one device's sector counters", () => {
    expect(parseDiskstats(DISKSTATS(100, 200), { major: 259, minor: 1 })).toEqual({ readSectors: 100, writeSectors: 200 });
    expect(parseDiskstats(DISKSTATS(100, 200), { major: 8, minor: 0 })).toBeUndefined();
  });

  test("diskRates gives MB/s and reads a counter reset as 0", () => {
    // 2048 sectors × 512 B = 1 MB over 1 s; 130 MB over 1 s.
    expect(diskRates({ readSectors: 0, writeSectors: 0 }, { readSectors: 2048 * 130, writeSectors: 2048 }, 1000)).toEqual({ readMBs: 130, writeMBs: 1 });
    expect(diskRates({ readSectors: 500, writeSectors: 500 }, { readSectors: 0, writeSectors: 0 }, 1000)).toEqual({ readMBs: 0, writeMBs: 0 });
  });

  test("parseMeminfo splits used (total − available) and cache (available − free)", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ totalGb: 15.33, usedGb: 2.22, cacheGb: 5.9, availGb: 13.11, swapUsedGb: 0.2 });
    expect(parseMeminfo("MemTotal: 1 kB\n")).toBeUndefined();
  });

  test("cpuSplit separates work from iowait", () => {
    // 1000 ticks: 150 user + 50 system = work 20 %, 700 iowait, 100 idle.
    const a = parseProcStat(STAT(0, 0, 0, 0))!, b = parseProcStat(STAT(150, 50, 100, 700))!;
    expect(cpuSplit(a, b)).toEqual({ work: 20, iowait: 70 });
    expect(cpuSplit(b, b)).toEqual({ work: 0, iowait: 0 });
  });
});

describe("bucketLive", () => {
  const s = (at: number, work: number, ooms?: number): LiveSample => ({ at, work, iowait: 10, load1: 1, readMBs: work, memUsedGb: 2, memCacheGb: 1, ...(ooms ? { ooms } : {}) });

  test("keeps every sample under the limit, and means each bucket over it", () => {
    expect(bucketLive([s(1, 10), s(2, 20)], 5, 0, 10)).toHaveLength(2);
    const out = bucketLive([s(1, 10), s(2, 30, 1), s(6, 50), s(7, 70, 2), s(8, 90)], 2, 0, 10);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ at: 2, work: 20, readMBs: 20, ooms: 1 });
    expect(out[1]).toMatchObject({ at: 8, work: 70, ooms: 2 });
  });

  test("drops samples outside the window", () => {
    expect(bucketLive([s(1, 10), s(20, 20)], 5, 0, 10).map((x) => x.at)).toEqual([1]);
  });
});

describe("sampler", () => {
  let dir = "";
  // The ring and the OOM count are module-level, shared with every other file `bun test` loads into
  // the one process — another file's `noteOomKill()` (health.ts calls `noteLiveOom()` too) can land
  // before this describe runs, in whatever order the runner's readdir gives (not file order; CI's
  // once put tests/healthHistory.test.ts's 3 OOM calls ahead of this file, and "ooms: 1" read 6).
  // A clean start, not just a clean end, makes this test independent of what ran before it.
  beforeEach(resetLive);
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); resetLive(); });

  const fixture = (stat: string, disk: string) => {
    writeFileSync(join(dir, "stat"), stat);
    writeFileSync(join(dir, "diskstats"), disk);
  };

  test("the first tick sets the baseline; the next one is a 15 s sample of the box", () => {
    dir = mkdtempSync(join(tmpdir(), "orca-live-"));
    mkdirSync(join(dir, "self"));
    writeFileSync(join(dir, "self", "mountinfo"), MOUNTINFO);
    writeFileSync(join(dir, "meminfo"), MEMINFO);
    let t = 0;
    const sampler = createLiveSampler({ procRoot: dir, now: () => t, load1: () => 3.456 });
    fixture(STAT(0, 0, 0, 0), DISKSTATS(0, 0));
    expect(sampler.tick()).toBeUndefined();
    t = 15_000;
    // 15 s of reads at 130 MB/s and writes at 2 MB/s; iowait 80 %.
    fixture(STAT(100, 50, 50, 800), DISKSTATS(2048 * 130 * 15, 2048 * 2 * 15));
    noteLiveOom();
    const v = sampler.tick();
    expect(v).toEqual({ at: 15_000, work: 15, iowait: 80, load1: 3.46, readMBs: 130, writeMBs: 2, memUsedGb: 2.22, memCacheGb: 5.9, memAvailGb: 13.11, swapUsedGb: 0.2, ooms: 1 });
    // The OOM count belongs to one sample only.
    t = 30_000;
    expect(sampler.tick()?.ooms).toBeUndefined();
  });

  test("off Linux (no /proc/stat) it records nothing", () => {
    dir = mkdtempSync(join(tmpdir(), "orca-live-"));
    const sampler = createLiveSampler({ procRoot: dir });
    expect(sampler.tick()).toBeUndefined();
    expect(sampler.tick()).toBeUndefined();
  });

  test("the ring keeps 6 hours and liveAnswer serves the asked range", () => {
    const H = 3_600_000;
    for (const at of [0, H, 5 * H, 7 * H]) pushLive({ at, work: 1, iowait: 0, load1: 0, memUsedGb: 1, memCacheGb: 0 });
    expect(liveAnswer(6, { now: 7 * H }).samples.map((x) => x.at)).toEqual([H, 5 * H, 7 * H]);
    expect(liveAnswer(1, { now: 7 * H }).samples.map((x) => x.at)).toEqual([7 * H]);
    expect(liveAnswer(24, { now: 7 * H, sliceMaxGb: 8.8 })).toMatchObject({ stepMs: 15_000, sliceMaxGb: 8.8, diskCapMBs: 125 });
  });

  test("/api/health's CPU is the ring's newest sample while it is under a minute old", () => {
    const { withLiveCpu } = require("../server/liveMetrics") as typeof import("../server/liveMetrics");
    const h = { cpuPct: 97, iowaitPct: 0, load1: 1 };
    const s: LiveSample = { at: 100_000, work: 4.4, iowait: 12.6, load1: 1, memUsedGb: 2, memCacheGb: 4 };
    expect(withLiveCpu(h, s, 130_000)).toEqual({ cpuPct: 4, iowaitPct: 13, load1: 1 });
    expect(withLiveCpu(h, s, 200_000)).toBe(h); // stale: health()'s own reading
    expect(withLiveCpu(h, undefined)).toBe(h);
  });

  test("the disk cap is ORCA_DISK_CAP_MBS when set, else 125", () => {
    expect(diskCapMBs(undefined)).toBe(125);
    expect(diskCapMBs("250")).toBe(250);
    expect(diskCapMBs("nope")).toBe(125);
  });
});

describe("the card's live series (workstream.ts)", () => {
  const { liveCharts, nearestAt, stackRuns, usesLiveSource } = require("../web/src/workstream") as typeof import("../web/src/workstream");
  const s = (at: number, extra: Partial<LiveSample> = {}): LiveSample => ({ at, work: 30, iowait: 50, load1: 6, memUsedGb: 3, memCacheGb: 5, ...extra });

  test("up to 6 hours reads the ring; longer ranges the history", () => {
    expect([1, 6, 24, 168].map(usesLiveSource)).toEqual([true, true, false, false]);
  });

  test("liveCharts stacks work + iowait, read + write, used + cache; load is per core; samples with no disk are skipped from IO", () => {
    const c = liveCharts([s(1, { readMBs: 130, writeMBs: 2, ooms: 2 }), s(2)], 4);
    expect(c.cpu).toEqual([{ at: 1, v: [30, 50] }, { at: 2, v: [30, 50] }]);
    expect(c.io).toEqual([{ at: 1, v: [130, 2] }]);
    expect(c.mem[0]).toEqual({ at: 1, v: [3, 5] });
    expect(c.loadPerCore[0]).toEqual({ at: 1, v: 1.5 });
    expect(c.ooms).toEqual([{ at: 1, n: 2 }]);
  });

  test("stackRuns breaks the area at a gap; nearestAt picks the closest sample", () => {
    const pts = [1, 2, 3, 20, 21].map((at) => ({ at, v: [1] }));
    expect(stackRuns(pts, 5).map((r) => r.map((p) => p.at))).toEqual([[1, 2, 3], [20, 21]]);
    expect(nearestAt(pts, 10)?.at).toBe(3);
    expect(nearestAt([], 1)).toBeUndefined();
  });
});

describe("orca machine (machineSummary, machineText, machineReport)", () => {
  const { liveCharts, machineSummary, machineText } = require("../web/src/workstream") as typeof import("../web/src/workstream");
  const { machineReport } = require("../server/liveMetrics") as typeof import("../server/liveMetrics");
  const M = 60_000, NOW = 10 * 3_600_000;
  // An hour of 15 s samples: quiet, then the last 5 minutes an IO stall (iowait 80 %, reads 130 MB/s).
  const hour = (): LiveSample[] => Array.from({ length: 240 }, (_, i) => {
    const at = NOW - (239 - i) * 15_000, stall = at > NOW - 5 * M;
    return { at, work: stall ? 10 : 30, iowait: stall ? 80 : 0, load1: stall ? 6 : 2, readMBs: stall ? 130 : 1, writeMBs: 2, memUsedGb: 3, memCacheGb: 5, memAvailGb: 12, swapUsedGb: 0.2, ...(i === 10 ? { ooms: 2 } : {}) };
  });

  test("now is the newest sample; 5 min and 1 h are means over the card's own series", () => {
    const s = machineSummary(hour(), 4);
    expect(s.now).toMatchObject({ work: 10, iowait: 80, loadPerCore: 1.5, readMBs: 130, memAvailGb: 12, swapUsedGb: 0.2, ooms: 0, samples: 1 });
    expect(s["5m"]).toMatchObject({ work: 10, iowait: 80, readMBs: 130, samples: 20, ooms: 0 });
    // 20 of 240 samples in the stall: work (220×30 + 20×10)/240.
    expect(s["1h"]).toMatchObject({ work: 28.3, iowait: 6.7, ooms: 2, samples: 240 });
    // The same load per core the card's tooltip reads.
    expect(s.now!.loadPerCore).toBe(liveCharts(hour(), 4).loadPerCore.at(-1)!.v);
    expect(machineSummary([], 4)).toEqual({});
  });

  test("machineText prints one row per measure and a column per window", () => {
    const text = machineText({ instance: "cloud", at: NOW, cores: 4, memTotalGb: 15.3, sliceMaxGb: 8.4, diskCapMBs: 125, stepMs: 15_000, summary: machineSummary(hour(), 4), heavy: { running: 2, queued: 1 }, samples: [] });
    const lines = text.split("\n");
    expect(lines[0]).toBe("cloud · 4 cores · 15.3 GB RAM · a sample every 15 s · newest 1970-01-01 10:00:00 UTC");
    expect(lines[1]!.trim().split(/\s+/)).toEqual(["now", "5", "min", "1", "h"]);
    expect(lines.find((l) => l.startsWith("CPU work %"))!.split(/\s{2,}/)).toEqual(["CPU work %", "10.0", "10.0", "28.3"]);
    expect(lines.find((l) => l.startsWith("iowait %"))!.split(/\s{2,}/)).toEqual(["iowait %", "80.0", "80.0", "6.7"]);
    expect(lines.find((l) => l.startsWith("disk read MB/s"))!.split(/\s{2,}/)).toEqual(["disk read MB/s", "130.0", "130.0", "11.8"]);
    expect(lines.find((l) => l.startsWith("OOM kills"))!.split(/\s{2,}/)).toEqual(["OOM kills", "0", "0", "2"]);
    expect(lines.find((l) => l.startsWith("swap used GB"))).toContain("0.20");
    expect(lines.at(-2)).toBe("Heavy queue: 2 running, 1 queued");
    expect(lines.at(-1)).toBe("Disk cap 125 MB/s · agents memory limit 8.4 GB");
  });

  test("a short ring says how much the windows cover; an empty one says so", () => {
    const short = hour().slice(-8); // 2 minutes since a restart
    const text = machineText({ instance: "cloud", at: NOW, cores: 4, memTotalGb: 15.3, diskCapMBs: 125, stepMs: 15_000, summary: machineSummary(short, 4), heavy: { running: 0, queued: 0 }, samples: [] });
    expect(text).toContain("5 min covers only 2 min (the bridge restarted since)");
    expect(text).toContain("1 h covers only 2 min (the bridge restarted since)");
    expect(machineText({ instance: "cloud", at: NOW, cores: 4, memTotalGb: 15.3, diskCapMBs: 125, stepMs: 15_000, summary: {}, heavy: { running: 0, queued: 0 }, samples: [] }))
      .toContain("No samples yet: the bridge samples every 15 s and starts empty after a restart.");
  });

  test("machineReport reads the card's ring through liveAnswer", () => {
    resetLive();
    for (const s of hour()) pushLive(s);
    const r = machineReport("cloud", { now: NOW, sliceMaxGb: 8.4 });
    expect(r.samples).toEqual(liveAnswer(1, { now: NOW }).samples);
    expect(r.samples).toHaveLength(240);
    expect(r).toMatchObject({ instance: "cloud", at: NOW, sliceMaxGb: 8.4, diskCapMBs: 125, stepMs: 15_000, heavy: { running: 0, queued: 0 } });
    expect(r.summary).toEqual(machineSummary(r.samples, r.cores));
    resetLive();
  });
});

// ---- macOS: no /proc. CPU from os.cpus(), memory from vm_stat, disk from ioreg. ----

// The real Apple Silicon `vm_stat` capture from tests/health.test.ts (page size 16384).
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               21309.
Pages active:                            612847.
Pages inactive:                          583296.
Pages speculative:                         4821.
Pages throttled:                              0.
Pages wired down:                        198532.
Pages purgeable:                          12044.
"Translation faults":                 892374651.
Pages copy-on-write:                    3847291.
Pages zero filled:                   412938475.
Pages reactivated:                       284719.
Pages purged:                           1829374.
File-backed pages:                       421837.
Anonymous pages:                         774306.
Pages stored in compressor:              892147.
Pages occupied by compressor:            213847.
Decompressions:                         3847291.
Compressions:                           5847392.
Pageins:                                8473921.
Pageouts:                                  48372.
Swapins:                                       0.
Swapouts:                                      0.
`;
// `ioreg -r -c IOBlockStorageDriver -k Statistics -d 1 -w 0` in its documented shape: the internal
// SSD and one mounted disk image, each with its own byte counters since boot.
const IOREG = (read: number, write: number) => `+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x100000412, registered, matched, active, busy 0 (0 ms), retain 7>
    {
      "Statistics" = {"Operations (Write)"=9518283,"Latency Time (Write)"=0,"Bytes (Read)"=${read},"Errors (Write)"=0,"Total Time (Read)"=4815162342,"Latency Time (Read)"=0,"Retries (Read)"=0,"Errors (Read)"=0,"Total Time (Write)"=2718281828,"Bytes (Write)"=${write},"Operations (Read)"=12233344,"Retries (Write)"=0}
    }

+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x1000a2c31, registered, matched, active, busy 0 (0 ms), retain 6>
    {
      "Statistics" = {"Operations (Write)"=0,"Latency Time (Write)"=0,"Bytes (Read)"=1048576,"Errors (Write)"=0,"Total Time (Read)"=1000,"Latency Time (Read)"=0,"Retries (Read)"=0,"Errors (Read)"=0,"Total Time (Write)"=0,"Bytes (Write)"=0,"Operations (Read)"=16,"Retries (Write)"=0}
    }
`;
const GB24 = 24 * 1_073_741_824;
const core = (user: number, sys: number, idle: number) => ({ times: { user, nice: 0, sys, idle, irq: 0 } });

describe("macOS parsers", () => {
  test("parseVmStatMemory: used is active + wired + compressor (the header's figure), cache is inactive + speculative", () => {
    // 16384 × (612847 + 198532 + 213847) = 15.64 GB used; 16384 × (583296 + 4821) = 8.97 GB cache, clamped to 24 − 15.64.
    expect(parseVmStatMemory(VM_STAT, GB24)).toEqual({ usedGb: 15.64, cacheGb: 8.36, availGb: 8.36 });
    expect(parseVmStatMemory(VM_STAT, 64 * 1_073_741_824)).toEqual({ usedGb: 15.64, cacheGb: 8.97, availGb: 48.36 });
    expect(parseVmStatMemory("no report", GB24)).toBeUndefined();
  });

  test("parseIoregDisk sums every driver's bytes; byteRates gives MB/s and reads a reset as 0", () => {
    expect(parseIoregDisk(IOREG(1000, 2000))).toEqual({ readBytes: 1000 + 1048576, writeBytes: 2000 });
    expect(parseIoregDisk("+-o IOBlockStorageDriver\n")).toBeUndefined();
    expect(byteRates({ readBytes: 0, writeBytes: 0 }, { readBytes: 30 * 1_048_576 * 40, writeBytes: 30 * 1_048_576 }, 30_000)).toEqual({ readMBs: 40, writeMBs: 1 });
    expect(byteRates({ readBytes: 9, writeBytes: 9 }, { readBytes: 0, writeBytes: 0 }, 30_000)).toEqual({ readMBs: 0, writeMBs: 0 });
  });

  test("darwinCpuTimes sums the cores into a /proc/stat shape with no iowait", () => {
    const a = darwinCpuTimes([core(0, 0, 0), core(0, 0, 0)]);
    const b = darwinCpuTimes([core(300, 100, 600), core(100, 100, 800)]);
    expect(b).toMatchObject({ user: 400, system: 200, idle: 1400, iowait: 0, total: 2000 });
    expect(cpuSplit(a, b)).toEqual({ work: 30, iowait: 0 });
  });
});

describe("the macOS sampler", () => {
  test("each tick spawns ONE command, vm_stat and ioreg in turn; samples carry CPU, memory and disk MB/s", async () => {
    resetLive();
    let t = 0, ticks = 0;
    const calls: string[][] = [];
    const sampler = createDarwinSampler({
      now: () => t, load1: () => 4.444, totalBytes: () => GB24,
      // 10 cores; each tick adds 1000 ticks per core, 250 of them busy: 25 % work.
      cpus: () => Array.from({ length: 10 }, () => core(200 * ticks, 50 * ticks, 750 * ticks)),
      run: async (cmd) => { calls.push(cmd); return cmd[0] === "vm_stat" ? VM_STAT : IOREG(ticks * 15 * 1_048_576 * 4, ticks * 15 * 1_048_576 * 2); },
    });
    const step = async () => { const v = await sampler.tick(); ticks++; t += 15_000; return v; };
    expect(await step()).toBeUndefined(); // baseline
    // Tick 2 (ioreg): memory from tick 1, no disk rate yet (one ioreg read).
    expect(await step()).toEqual({ at: 15_000, work: 25, iowait: 0, load1: 4.44, memUsedGb: 15.64, memCacheGb: 8.36, memAvailGb: 8.36 });
    await step(); // vm_stat
    noteLiveOom();
    // Tick 4 (ioreg): 30 s since the last ioreg read, 4 and 2 MB/s.
    expect(await step()).toEqual({ at: 45_000, work: 25, iowait: 0, load1: 4.44, readMBs: 4, writeMBs: 2, memUsedGb: 15.64, memCacheGb: 8.36, memAvailGb: 8.36, ooms: 1 });
    expect(calls).toEqual([VM_STAT_CMD, IOREG_CMD, VM_STAT_CMD, IOREG_CMD]);
    resetLive();
  });

  test("a failed command keeps the last reading, and no memory reading means no sample", async () => {
    let t = 0;
    const sampler = createDarwinSampler({ now: () => (t += 15_000), totalBytes: () => GB24, cpus: () => [core(t, 0, t)], run: async () => { throw new Error("vm_stat: not found"); } });
    expect(await sampler.tick()).toBeUndefined();
    expect(await sampler.tick()).toBeUndefined();
  });
});

describe("instanceStatus", () => {
  test("unreachable beats all; health or a fresh sample is online; nothing is loading", () => {
    const now = 1_000_000_000;
    expect(instanceStatus({ down: true, health: true, now })).toBe("unreachable");
    expect(instanceStatus({ down: false, health: true, now })).toBe("online");
    expect(instanceStatus({ down: false, health: false, newestSampleAt: now - 60_000, now })).toBe("online");
    expect(instanceStatus({ down: false, health: false, newestSampleAt: now - 10 * 60_000, now })).toBe("loading");
    expect(instanceStatus({ down: false, health: false, now })).toBe("loading");
  });
});
