// The machine card's 15 s sampler (server/liveMetrics.ts): pure parsers fed fixture text copied from
// the box, and the sampler over a fixture /proc directory.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseProcStat } from "../server/health";
import {
  bucketLive, cpuSplit, createLiveSampler, diskCapMBs, diskRates, liveAnswer, noteLiveOom, parseDiskstats, parseMeminfo,
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
