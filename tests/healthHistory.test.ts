// The health chip's history (instance_metric): each instance writes its own vitals once a minute and
// either instance reads them back from Postgres. Pinned here: the hours window, the 30-day prune on
// write (which only ever touches the writer's own rows), the `hours` clamp, and that a failed write
// is swallowed rather than surfacing anywhere else.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import { health, historyHours, sampleMetrics } from "../server/health";
import * as lease from "../server/lease";
import { accruedCost, countMax, instanceSeries, rateLabel, sparklineSegments } from "../web/src/workstream";
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
  expect(day[0]).toEqual({ at: now - 2 * H, cpuPct: 20, load1: 0.8, memUsedGb: 3.1, memTotalGb: 15.3, diskUsedGb: 11, runningAgents: 2 });
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

test("the sampler no longer writes model spend: cost_usd (migration 17) stays NULL, unused", async () => {
  await sampleMetrics();
  const sql = await db.open();
  const [row] = await sql`SELECT cost_usd FROM instance_metric WHERE instance = 'cloud'`;
  expect(row.cost_usd).toBeNull();
  expect(Object.keys((await db.metricHistory("cloud", 1))[0]!)).not.toContain("costUsd");
});

test("accruedCost: the machine's rate over the time between samples, flat across a gap where it was down", () => {
  const M = 60_000, H = 60 * M;
  // Up for 30 minutes (a sample a minute), down for 2 hours, up again for 30 minutes.
  const up = (from: number) => Array.from({ length: 31 }, (_, i) => ({ at: from + i * M }));
  const samples = [...up(0), ...up(30 * M + 2 * H)];
  const pts = accruedCost(samples, 0.24);
  expect(pts[0]).toEqual({ at: 0, v: 0 }); // the range's cost starts at its first sample
  expect(pts[30]!.v).toBeCloseTo(0.12, 10); // half an hour at $0.24/h
  expect(pts[31]!.v).toBeCloseTo(0.12, 10); // the 2h gap adds nothing
  expect(pts.at(-1)!.v).toBeCloseTo(0.24, 10); // an hour up in all, not 3
  // A pause up to 5 minutes is still up (a slow sample), past it is down.
  expect(accruedCost([{ at: 0 }, { at: 5 * M }], 12).at(-1)!.v).toBeCloseTo(1, 10);
  expect(accruedCost([{ at: 0 }, { at: 5 * M + 1 }], 12).at(-1)!.v).toBe(0);
  // No rate (the laptop): flat zero.
  expect(accruedCost(samples, 0).every((p) => p.v === 0)).toBe(true);
  expect(accruedCost([], 1)).toEqual([]);
});

test("rateLabel: the rate in the chart's caption, marked when it is an estimate", () => {
  expect(rateLabel({ hourlyUsd: 0.2331, source: "estimate", instanceType: "m7i.xlarge" })).toBe("Cost accrued · $0.23/h est. (m7i.xlarge)");
  expect(rateLabel({ hourlyUsd: 0.24, source: "config" })).toBe("Cost accrued · $0.24/h");
  expect(rateLabel({ hourlyUsd: 0.0472, source: "config" })).toBe("Cost accrued · $0.047/h");
  expect(rateLabel({ hourlyUsd: 0, source: "none" })).toBe("Cost accrued");
  expect(rateLabel(undefined)).toBe("Cost accrued");
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

test("instanceSeries: the newest sample (live when newer) is every series' raw last point and the header's latest; cost accrues at the rate", () => {
  const rec = (at: number, cpuPct: number, runningAgents = 1) => ({ at, cpuPct, memUsedGb: 2, runningAgents });
  const history = [rec(-5, 99), rec(10, 10), rec(20, 30, 2)]; // the first is outside [0, 100]
  const live = { at: 25, cpuPct: 42, memUsedGb: 3, runningAgents: 4 };
  const s = instanceSeries(history, live, 0, 100, 300, 3_600_000); // $1 per ms, to keep the arithmetic whole
  expect(s.cpu.map((p) => p.v)).toEqual([10, 30, 42]);
  expect(s.latest).toEqual({ at: 25, cpuPct: 42, memUsedGb: 3, runningAgents: 4, costUsd: 15 });
  expect(s.cost.map((p) => p.v)).toEqual([0, 10, 15]); // from the range's first sample to the live one
  expect(instanceSeries(history, live, 0, 100).latest!.costUsd).toBe(0); // no rate: nothing accrues
  expect(s.agents.at(-1)).toEqual({ at: 25, v: 4 });
  // An older live reading is ignored: the recorded sample is newer, and is the latest.
  expect(instanceSeries(history, { ...live, at: 15 }, 0, 100).latest!.cpuPct).toBe(30);
  // Many samples: downsampled, but the last point is the raw newest, not its bucket's mean.
  const many = Array.from({ length: 1000 }, (_, i) => rec(i, i === 999 ? 100 : 0));
  const d = instanceSeries(many, null, 0, 1000, 50);
  expect(d.cpu.length).toBeLessThanOrEqual(50);
  expect(d.cpu.at(-1)).toEqual({ at: 999, v: 100 });
  expect(instanceSeries([], null, 0, 100)).toEqual({ cpu: [], mem: [], agents: [], cost: [], latest: null });
});

test("countMax: an even whole top for the agents axis, so the middle tick is whole", () => {
  expect([0, 1, 2, 3, 4, 7].map(countMax)).toEqual([2, 2, 2, 4, 4, 8]);
});
