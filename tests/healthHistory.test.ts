// The health chip's history (instance_metric): each instance writes its own vitals once a minute and
// either instance reads them back from Postgres. Pinned here: the hours window, the 32-day prune on
// write (which only ever touches the writer's own rows), the `hours` clamp, and that a failed write
// is swallowed rather than surfacing anywhere else.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import { health, historyHours, monthCost, noteOomKill, sampleMetrics } from "../server/health";
import * as lease from "../server/lease";
import { countMax, instanceSeries, monthCostLabel, sparklineSegments } from "../web/src/workstream";
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

test("a write prunes the writer's own rows past 32 days (a whole month for its cost), never another instance's", async () => {
  const now = Date.now();
  await db.recordMetric(sample(1), now - 33 * 24 * H);
  await db.recordMetric(sample(2), now - 31 * 24 * H);
  process.env.ORCA_INSTANCE = "local";
  await db.recordMetric(sample(3), now - 33 * 24 * H);
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

test("an agent run OOM-killed in its scope is recorded once, on the next sample — and kept for the one after if that write fails", async () => {
  noteOomKill(); noteOomKill();
  await sampleMetrics();
  await sampleMetrics();
  expect((await db.metricHistory("cloud", 1)).map((p) => p.oomKills ?? 0)).toEqual([2, 0]);

  noteOomKill();
  await db.close();
  process.env.ORCA_DATABASE_URL = "postgres://127.0.0.1:1/nowhere";
  const orig = console.error;
  console.error = () => {};
  try { await sampleMetrics(); } finally { console.error = orig; }
  await db.close();
  process.env.ORCA_DATABASE_URL = pg.url;
  await sampleMetrics();
  expect((await db.metricHistory("cloud", 1)).map((p) => p.oomKills ?? 0)).toEqual([2, 0, 1]);
});

test("monthCost: the rate over this month's uptime — a gap over 5 minutes is down, last month's samples don't count", async () => {
  const M = 60_000;
  const monthStart = Date.UTC(2026, 9, 1), now = Date.UTC(2026, 9, 13, 12);
  // Last month's tail, right up to midnight: none of it is this month's.
  for (let i = 10; i >= 1; i--) await db.recordMetric(sample(1), monthStart - i * M);
  // Up 30 minutes (a sample a minute), down 2 hours, up 30 minutes; then a 5-minute pause (still up)
  // and a 5-minutes-and-a-second one (down).
  const up = async (from: number) => { for (let i = 0; i <= 30; i++) await db.recordMetric(sample(1), from + i * M); };
  const day = monthStart + 3 * 24 * H;
  await up(day);
  await up(day + 30 * M + 2 * H);
  const end = day + 60 * M + 2 * H;
  await db.recordMetric(sample(1), end + 5 * M);
  await db.recordMetric(sample(1), end + 10 * M + 1000);
  process.env.ORCA_INSTANCE = "local";
  await db.recordMetric(sample(1), day + 10 * M); // another machine's samples are its own
  process.env.ORCA_INSTANCE = "cloud";

  expect(await db.uptimeMs("cloud", monthStart, 5 * M)).toBe(65 * M);
  const c = await monthCost(0.24, "cloud", now);
  expect(c).toEqual({ usd: 0.26, upHours: 65 / 60, since: monthStart });
  expect((await monthCost(0, "cloud", now)).usd).toBe(0);
  expect((await monthCost(0.24, "nowhere", now)).usd).toBe(0);
});

test("monthCostLabel: the month's total, and the rate × hours behind it, marked when the rate is an estimate", () => {
  const month = { usd: 5.52, upHours: 23.68 };
  expect(monthCostLabel(month, { hourlyUsd: 0.2331, source: "estimate", instanceType: "m7i.xlarge" })).toEqual({ value: "$5.52", detail: "$0.23/h est. (m7i.xlarge) × 23.7 h up this month (UTC)" });
  expect(monthCostLabel(month, { hourlyUsd: 0.0472, source: "config" })!.detail).toBe("$0.047/h × 23.7 h up this month (UTC)");
  expect(monthCostLabel(month, { hourlyUsd: 0, source: "none" })).toBeNull(); // the laptop
  expect(monthCostLabel(undefined, { hourlyUsd: 0.24, source: "config" })).toBeNull(); // an older bridge
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

test("instanceSeries: the newest sample (live when newer) is every series' raw last point and the header's latest; disk skips missing readings; OOM kills are marks", () => {
  const rec = (at: number, cpuPct: number, runningAgents = 1, diskUsedGb?: number, oomKills?: number) => ({ at, cpuPct, memUsedGb: 2, runningAgents, diskUsedGb, oomKills });
  const history = [rec(-5, 99, 1, 9, 3), rec(10, 10, 1, 20, 1), rec(15, 20, 1), rec(20, 30, 2, 21, 2)]; // the first is outside [0, 100]
  const live = { at: 25, cpuPct: 42, memUsedGb: 3, runningAgents: 4, diskUsedGb: 22 };
  const s = instanceSeries(history, live, 0, 100);
  expect(s.cpu.map((p) => p.v)).toEqual([10, 20, 30, 42]);
  expect(s.latest).toEqual({ at: 25, cpuPct: 42, memUsedGb: 3, runningAgents: 4 });
  expect(s.disk).toEqual([{ at: 10, v: 20 }, { at: 20, v: 21 }, { at: 25, v: 22 }]); // no 0 for the sample without one
  expect(s.ooms).toEqual([{ at: 10, n: 1 }, { at: 20, n: 2 }]); // only inside the range
  expect(s.agents.at(-1)).toEqual({ at: 25, v: 4 });
  // An older live reading is ignored: the recorded sample is newer, and is the latest.
  expect(instanceSeries(history, { ...live, at: 15 }, 0, 100).latest!.cpuPct).toBe(30);
  // Many samples: downsampled, but the last point is the raw newest, not its bucket's mean.
  const many = Array.from({ length: 1000 }, (_, i) => rec(i, i === 999 ? 100 : 0));
  const d = instanceSeries(many, null, 0, 1000, 50);
  expect(d.cpu.length).toBeLessThanOrEqual(50);
  expect(d.cpu.at(-1)).toEqual({ at: 999, v: 100 });
  expect(d.disk).toEqual([]); // no readings at all: an empty line, not zeros
  expect(instanceSeries([], null, 0, 100)).toEqual({ cpu: [], mem: [], agents: [], disk: [], ooms: [], latest: null });
});

test("countMax: an even whole top for the agents axis, so the middle tick is whole", () => {
  expect([0, 1, 2, 3, 4, 7].map(countMax)).toEqual([2, 2, 2, 4, 4, 8]);
});
