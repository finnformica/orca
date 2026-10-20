// The machine card's 15 s ring, persisted (server/db.ts `machine_sample`, server/liveMetrics.ts's
// batching into it). Pinned here: the migration creates the table, a write and a windowed read
// round-trip, a write prunes the writer's own rows past 7 days, and the buffer/flush/restore path
// in liveMetrics.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as lease from "../server/lease";
import {
  bufferMachineSample, flushMachineSamples, newestLive, pushLive, resetLive, restoreLiveRing, type LiveSample,
} from "../server/liveMetrics";
import { freshSchema, type TestDb } from "./pg";

let pg: TestDb;
let prevDbUrl: string | undefined;
let prevInstance: string | undefined;
let prevStateDir: string | undefined;
beforeEach(async () => {
  prevDbUrl = process.env.ORCA_DATABASE_URL;
  prevInstance = process.env.ORCA_INSTANCE;
  prevStateDir = process.env.ORCA_STATE_DIR;
  pg = await freshSchema("machinesample");
  process.env.ORCA_DATABASE_URL = pg.url;
  process.env.ORCA_INSTANCE = "cloud";
  process.env.ORCA_STATE_DIR = mkdtempSync(join(tmpdir(), "orca-state-")); // isolate leases from ~/.orca
  await db.close();
  resetLive();
});
afterEach(async () => {
  await db.close();
  await pg.drop();
  if (prevDbUrl === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prevDbUrl;
  if (prevInstance === undefined) delete process.env.ORCA_INSTANCE; else process.env.ORCA_INSTANCE = prevInstance;
  if (prevStateDir === undefined) delete process.env.ORCA_STATE_DIR; else process.env.ORCA_STATE_DIR = prevStateDir;
  resetLive();
});

const H = 3_600_000;
const s = (at: number, extra: Partial<LiveSample> = {}): LiveSample => ({ at, work: 10, iowait: 2, load1: 1, memUsedGb: 3, memCacheGb: 5, ...extra });

test("the migration creates machine_sample with an index on (instance, at)", async () => {
  const sql = await db.open();
  const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'machine_sample' AND table_schema = current_schema()`;
  expect((cols as { column_name: string }[]).map((c) => c.column_name)).toEqual(expect.arrayContaining([
    "instance", "at", "cpu_work_pct", "iowait_pct", "load1", "disk_read_mbs", "disk_write_mbs",
    "mem_used_gb", "mem_cache_gb", "mem_avail_gb", "swap_used_gb", "running_agents", "oom_kills",
  ]));
  const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'machine_sample' AND schemaname = current_schema()`;
  expect((idx as { indexname: string }[]).some((r) => r.indexname === "machine_sample_instance_at")).toBe(true);
});

test("recordMachineSamples and machineSampleHistory round-trip a batch, within the window asked for, for the instance asked about", async () => {
  const now = Date.now();
  await db.recordMachineSamples([
    { at: now - 3 * H, work: 5, iowait: 0, load1: 0.5, memUsedGb: 2, memCacheGb: 1, runningAgents: 1 },
    { at: now - H, work: 50, iowait: 10, load1: 2, readMBs: 4, writeMBs: 1, memUsedGb: 3, memCacheGb: 2, memAvailGb: 10, swapUsedGb: 0.1, runningAgents: 2, ooms: 1 },
  ]);
  process.env.ORCA_INSTANCE = "local";
  await db.recordMachineSamples([{ at: now - H, work: 99, iowait: 0, load1: 1, memUsedGb: 1, memCacheGb: 1 }]);
  process.env.ORCA_INSTANCE = "cloud";

  const window = await db.machineSampleHistory("cloud", 2, now);
  expect(window.map((p) => p.work)).toEqual([50]);
  expect(window[0]).toEqual({ at: now - H, work: 50, iowait: 10, load1: 2, readMBs: 4, writeMBs: 1, memUsedGb: 3, memCacheGb: 2, memAvailGb: 10, swapUsedGb: 0.1, runningAgents: 2, ooms: 1 });
  expect((await db.machineSampleHistory("cloud", 6, now)).map((p) => p.work)).toEqual([5, 50]);
  // Either instance reads the other's rows — the history is in the shared database.
  expect((await db.machineSampleHistory("local", 6, now)).map((p) => p.work)).toEqual([99]);
});

test("a write prunes the writer's own rows past 7 days, never another instance's", async () => {
  const now = Date.now();
  await db.recordMachineSamples([{ at: now - 8 * 24 * H, work: 1, iowait: 0, load1: 0, memUsedGb: 1, memCacheGb: 0 }]);
  process.env.ORCA_INSTANCE = "local";
  await db.recordMachineSamples([{ at: now - 8 * 24 * H, work: 2, iowait: 0, load1: 0, memUsedGb: 1, memCacheGb: 0 }]);
  process.env.ORCA_INSTANCE = "cloud";
  await db.recordMachineSamples([{ at: now, work: 3, iowait: 0, load1: 0, memUsedGb: 1, memCacheGb: 0 }]); // the write that prunes

  expect((await db.machineSampleHistory("cloud", 24 * 9, now)).map((p) => p.work)).toEqual([3]);
  expect((await db.machineSampleHistory("local", 24 * 9, now)).map((p) => p.work)).toEqual([2]); // its own writer prunes it
});

test("an empty batch and a preview bridge write nothing", async () => {
  await db.recordMachineSamples([]);
  process.env.ORCA_PREVIEW_BRIDGE = "1";
  try {
    await db.recordMachineSamples([{ at: Date.now(), work: 1, iowait: 0, load1: 0, memUsedGb: 1, memCacheGb: 0 }]);
  } finally { delete process.env.ORCA_PREVIEW_BRIDGE; }
  expect(await db.machineSampleHistory("cloud", 24)).toHaveLength(0);
});

test("bufferMachineSample flushes at most once a minute, with the live running-agent count", async () => {
  const now = Date.now();
  await bufferMachineSample(s(now), now); // the first call always flushes
  expect(await db.machineSampleHistory("cloud", 6, now + 1000)).toHaveLength(1);

  expect(bufferMachineSample(s(now + 15_000), now + 15_000)).toBeUndefined(); // too soon: stays buffered
  expect(await db.machineSampleHistory("cloud", 6, now + 20_000)).toHaveLength(1);

  lease.acquire({ key: "/wt/a", worktreePath: "/wt/a", branch: "a", provider: "claude", runId: "r1", pid: process.pid, startedAt: now });
  try {
    await bufferMachineSample(s(now + 60_000), now + 60_000); // a minute later: flushes the buffered pair
    const rows = await db.machineSampleHistory("cloud", 6, now + 65_000);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.runningAgents)).toEqual([0, 1, 1]); // the first flush had none leased
  } finally { lease.release("/wt/a"); }
});

test("flushMachineSamples forces the buffered batch out now, bypassing the throttle", async () => {
  const now = Date.now();
  await bufferMachineSample(s(now), now);
  expect(bufferMachineSample(s(now + 15_000), now + 15_000)).toBeUndefined(); // buffered, not flushed yet
  await flushMachineSamples();
  expect(await db.machineSampleHistory("cloud", 6, now + 20_000)).toHaveLength(2);
});

test("restoreLiveRing seeds the ring from the database, merging with samples collected since boot", async () => {
  const now = Date.now();
  await db.recordMachineSamples([{ at: now - 2 * H, work: 1, iowait: 0, load1: 0, memUsedGb: 1, memCacheGb: 0 }]);
  pushLive(s(now)); // a sample the sampler already collected before the restore resolved
  await restoreLiveRing("cloud", now);
  expect(newestLive()).toEqual(s(now));
  await db.close();
  process.env.ORCA_DATABASE_URL = "postgres://127.0.0.1:1/nowhere"; // nothing listens
  const orig = console.error;
  console.error = () => {};
  try { await restoreLiveRing("cloud", now); } finally { console.error = orig; } // logged, never throws
  expect(newestLive()).toEqual(s(now)); // the ring is left as it was
  await db.close();
  process.env.ORCA_DATABASE_URL = pg.url;
});
