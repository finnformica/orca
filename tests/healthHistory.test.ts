// The health chip's history (instance_metric): each instance writes its own vitals once a minute and
// either instance reads them back from Postgres. Pinned here: the hours window, the 30-day prune on
// write (which only ever touches the writer's own rows), the `hours` clamp, and that a failed write
// is swallowed rather than surfacing anywhere else.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import { costSince, health, historyHours, resetCostWindow, sampleMetrics } from "../server/health";
import * as lease from "../server/lease";
import * as ledger from "../server/ledger";
import { sparklineSegments } from "../web/src/workstream";
import { freshSchema, type TestDb } from "./pg";

let pg: TestDb;
let prevDbUrl: string | undefined;
let prevInstance: string | undefined;
let prevStateDir: string | undefined;
beforeEach(async () => {
  prevDbUrl = process.env.ORCA_DATABASE_URL;
  prevInstance = process.env.ORCA_INSTANCE;
  prevStateDir = process.env.ORCA_STATE_DIR;
  pg = await freshSchema("healthhistory");
  process.env.ORCA_DATABASE_URL = pg.url;
  process.env.ORCA_INSTANCE = "cloud";
  process.env.ORCA_STATE_DIR = mkdtempSync(join(tmpdir(), "orca-state-")); // isolate leases from ~/.orca
  await db.close();
});
afterEach(async () => {
  await db.close();
  await pg.drop();
  if (prevDbUrl === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prevDbUrl;
  if (prevInstance === undefined) delete process.env.ORCA_INSTANCE; else process.env.ORCA_INSTANCE = prevInstance;
  if (prevStateDir === undefined) delete process.env.ORCA_STATE_DIR; else process.env.ORCA_STATE_DIR = prevStateDir;
});

const H = 3_600_000;
const sample = (cpuPct: number, runningAgents = 0) => ({ cpuPct, load1: cpuPct / 25, memUsedGb: 3.1, memTotalGb: 15.3, diskUsedGb: 11, runningAgents });

test("samples read back oldest first, within the hours asked for, for the instance asked about", async () => {
  const now = Date.now();
  await db.recordMetric(sample(10), now - 30 * H); // outside 24h
  await db.recordMetric(sample(20, 2), now - 2 * H);
  await db.recordMetric(sample(30, 1), now - 1 * H);
  process.env.ORCA_INSTANCE = "local";
  await db.recordMetric({ cpuPct: 99, load1: 1, memUsedGb: 1, memTotalGb: 8, runningAgents: 0 }, now - H); // another machine, no disk
  process.env.ORCA_INSTANCE = "cloud";

  const day = await db.metricHistory("cloud", 24, now);
  expect(day.map((p) => p.cpuPct)).toEqual([20, 30]);
  expect(day[0]).toEqual({ at: now - 2 * H, cpuPct: 20, load1: 0.8, memUsedGb: 3.1, memTotalGb: 15.3, diskUsedGb: 11, runningAgents: 2, costUsd: 0 });
  expect(day.map((p) => p.runningAgents)).toEqual([2, 1]);
  expect((await db.metricHistory("cloud", 48, now)).map((p) => p.cpuPct)).toEqual([10, 20, 30]);
  expect((await db.metricHistory("cloud", 1.5, now)).map((p) => p.cpuPct)).toEqual([30]);
  // Either instance reads the other's rows — the history is in the shared database.
  const local = await db.metricHistory("local", 24, now);
  expect(local.map((p) => p.cpuPct)).toEqual([99]);
  expect(local[0]!.diskUsedGb).toBeUndefined();
});

test("a row written before the running_agents column existed reads back as 0 sessions, not null", async () => {
  const now = Date.now();
  const sql = await db.open();
  await sql`
    INSERT INTO instance_metric (user_id, instance, at, cpu_pct, load1, mem_used_gb, mem_total_gb)
    VALUES (${db.currentUser()}, 'cloud', ${new Date(now - H)}, 15, 0.6, 3, 15)`; // no running_agents at all
  expect((await db.metricHistory("cloud", 24, now))[0]!.runningAgents).toBe(0);
});

test("a write prunes the writer's own rows past 30 days, never another instance's", async () => {
  const now = Date.now();
  await db.recordMetric(sample(1), now - 31 * 24 * H);
  await db.recordMetric(sample(2), now - 29 * 24 * H);
  process.env.ORCA_INSTANCE = "local";
  await db.recordMetric(sample(3), now - 31 * 24 * H);
  process.env.ORCA_INSTANCE = "cloud";
  await db.recordMetric(sample(4), now); // the write that prunes

  expect((await db.metricHistory("cloud", 24 * 40, now)).map((p) => p.cpuPct)).toEqual([2, 4]);
  expect((await db.metricHistory("local", 24 * 40, now)).map((p) => p.cpuPct)).toEqual([3]); // its own writer prunes it
});

test("the sampler records this machine, and a failed write is logged, not thrown", async () => {
  await sampleMetrics();
  const rows = await db.metricHistory("cloud", 1);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.memTotalGb).toBeGreaterThan(0);
  expect(rows[0]!.runningAgents).toBe(0); // nothing leased

  await db.close();
  process.env.ORCA_DATABASE_URL = "postgres://127.0.0.1:1/nowhere"; // nothing listens
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try { await sampleMetrics(); } finally { console.error = orig; }
  expect(errors).toHaveLength(1);
  await db.close();
  process.env.ORCA_DATABASE_URL = pg.url;
});

test("the sampler counts live leases as running agents, not dead or expired ones", async () => {
  lease.acquire({ key: "/wt/a", worktreePath: "/wt/a", branch: "a", provider: "claude", runId: "r1", pid: process.pid, startedAt: Date.now() });
  lease.acquire({ key: "/wt/b", worktreePath: "/wt/b", branch: "b", provider: "claude", runId: "r2", pid: process.pid, startedAt: Date.now() });
  lease.acquire({ key: "/wt/c", worktreePath: "/wt/c", branch: "c", provider: "claude", runId: "r3", pid: process.pid, startedAt: Date.now() - 10_000, timeoutMs: 1 }); // expired
  try {
    await sampleMetrics();
    const rows = await db.metricHistory("cloud", 1);
    expect(rows[0]!.runningAgents).toBe(2);
  } finally {
    lease.release("/wt/a"); lease.release("/wt/b"); lease.release("/wt/c");
  }
});

test("the live reading counts live leases too, so the card's Agents · N is the same count the sampler writes", async () => {
  expect((await health()).runningAgents).toBe(0);
  lease.acquire({ key: "/wt/live", worktreePath: "/wt/live", branch: "live", provider: "claude", runId: "rl", pid: process.pid, startedAt: Date.now() });
  try { expect((await health()).runningAgents).toBe(1); } finally { lease.release("/wt/live"); }
});

test("cost: each sample records what the ledger's runs that finished since the previous one cost — counted once, across a restart too", async () => {
  ledger.clear();
  resetCostWindow();
  await sampleMetrics(); // first sample: nothing has run
  ledger.record({ kind: "run", provider: "claude", status: "done", costUsd: 0.5 });
  ledger.record({ kind: "run", provider: "codex", status: "done" }); // no cost reported: 0
  ledger.record({ kind: "pr-description", provider: "claude", status: "done", costUsd: 9 }); // not a run
  await Bun.sleep(2);
  await sampleMetrics();
  await Bun.sleep(2);
  await sampleMetrics(); // nothing new: 0, not 0.5 again
  // A restart: the window is re-seeded from this instance's newest row, so a run that finished
  // while the bridge was down is counted once — and nothing earlier is counted twice.
  ledger.record({ kind: "run", provider: "claude", status: "error", costUsd: 0.25 });
  resetCostWindow();
  await Bun.sleep(2);
  await sampleMetrics();
  const rows = await db.metricHistory("cloud", 1);
  expect(rows.map((r) => r.costUsd)).toEqual([0, 0.5, 0, 0.25]);
  ledger.clear();
});

test("cost: a row from before migration 17 reads back as $0", async () => {
  const sql = await db.open();
  await sql`
    INSERT INTO instance_metric (user_id, instance, at, cpu_pct, load1, mem_used_gb, mem_total_gb, running_agents)
    VALUES (${db.currentUser()}, 'cloud', ${new Date(Date.now() - H)}, 15, 0.6, 3, 15, 1)`;
  expect((await db.metricHistory("cloud", 24))[0]!.costUsd).toBe(0);
});

test("costSince: runs only, in (from, to], summed", () => {
  const e = (at: number, costUsd?: number, kind: "run" | "pr-description" = "run") => ({ at, kind, provider: "claude" as const, status: "done" as const, costUsd });
  expect(costSince([e(10, 1), e(20, 2), e(30, 4), e(25, 8, "pr-description"), e(22)], 10, 30)).toBe(6);
  expect(costSince([], 0, 1)).toBe(0);
});

test("hours: 24 by default, never past the 30 days kept", () => {
  expect(historyHours(null)).toBe(24);
  expect(historyHours("")).toBe(24);
  expect(historyHours("abc")).toBe(24);
  expect(historyHours("-3")).toBe(24);
  expect(historyHours("6")).toBe(6);
  expect(historyHours("100000")).toBe(720);
});

test("sparkline: x by time, y from 0 to max, broken where the sampler went quiet", () => {
  const from = 0, to = 100 * 60_000;
  const pts = [{ at: 0, v: 0 }, { at: 60_000, v: 50 }, { at: 50 * 60_000, v: 100 }, { at: 51 * 60_000, v: 200 }];
  expect(sparklineSegments(pts, { from, to, max: 100, w: 100, h: 10 })).toEqual(["0.0,10.0 1.0,5.0", "50.0,0.0 51.0,0.0"]); // clamped to max
  expect(sparklineSegments([{ at: -1, v: 5 }], { from, to, max: 100, w: 100, h: 10 })).toEqual([]); // outside the window
});
