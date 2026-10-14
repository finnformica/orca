// The health chip's history (instance_metric): each instance writes its own vitals once a minute and
// either instance reads them back from Postgres. Pinned here: the hours window, the 32-day prune on
// write (which only ever touches the writer's own rows), the `hours` clamp, and that a failed write
// is swallowed rather than surfacing anywhere else.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import { health, heartbeat, historyHours, importJournalBoots, monthCost, noteOomKill, sampleMetrics } from "../server/health";
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
  expect(await db.boots("cloud")).toHaveLength(1); // and heartbeats this kernel's boot

  await db.close();
  process.env.ORCA_DATABASE_URL = "postgres://127.0.0.1:1/nowhere"; // nothing listens
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try { await sampleMetrics(); } finally { console.error = orig; }
  expect(errors).toHaveLength(2); // the heartbeat and the sample fail apart, each logged

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

test("monthCost: the rate over the kernel boot ledger — journal backfill + heartbeat, Orca's own samples irrelevant", async () => {
  const M = 60_000;
  const monthStart = Date.UTC(2026, 9, 1), now = Date.UTC(2026, 9, 13, 12);
  // The journal remembers two boots: launched the 12th 09:00, rebooted (40s) the 13th 10:00.
  const shim = mkdtempSync(join(tmpdir(), "orca-journal-"));
  const us = (t: number) => t * 1000;
  const b1 = Date.UTC(2026, 9, 12, 9), b1end = Date.UTC(2026, 9, 13, 10), b2 = b1end + 40_000;
  writeFileSync(join(shim, "journalctl"), `#!/bin/sh\necho '${JSON.stringify([
    { index: -1, boot_id: "aaaa", first_entry: us(b1), last_entry: us(b1end) },
    { index: 0, boot_id: "bbbb", first_entry: us(b2), last_entry: us(b2 + 30 * M) },
  ])}'\n`);
  chmodSync(join(shim, "journalctl"), 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = `${shim}:${realPath}`;
  try { expect(await importJournalBoots()).toBe(2); } finally { process.env.PATH = realPath; }
  // The live boot's heartbeat — its id spelled with hyphens, as /proc has it — only widens its span.
  const idFile = join(shim, "boot_id");
  writeFileSync(idFile, "bb-bb\n");
  process.env.ORCA_BOOT_ID_FILE = idFile;
  try {
    await heartbeat(b2 + 45 * M);
    expect((await db.boots("cloud")).map((b) => [b.bootId, b.lastSeen])).toEqual([["aaaa", b1end], ["bbbb", b2 + 45 * M]]);
    // Orca's samples say nothing about the bill: a lone one changes nothing.
    await db.recordMetric(sample(1), b2 + 5 * M);
    // Orca hung after b2+45m, the machine kept running: the live boot counts to now.
    const c = await monthCost(0.24, { now });
    expect(c.upHours).toBeCloseTo((now - b1) / H, 6); // the 40s reboot billed too
    expect(c.usd).toBe(Math.round(((now - b1) / H) * 0.24 * 100) / 100);
    // No billing start: the 11 days before the ledger are unknown, not billed.
    expect(c.unknownHours).toBeCloseTo((b1 - monthStart) / H, 6);
    expect(c.usdMax).toBe(Math.round(((now - monthStart) / H) * 0.24 * 100) / 100);
    // With the launch configured, nothing before it is billed or unknown.
    const seeded = await monthCost(0.24, { now, billingSince: b1 });
    expect([seeded.unknownHours, seeded.assumedHours, seeded.usd]).toEqual([0, 0, c.usd]);
  } finally { delete process.env.ORCA_BOOT_ID_FILE; }
  // Another instance's ledger is its own; an instance with none bills nothing it can show.
  const other = await monthCost(0.24, { now, instance: "nowhere" });
  expect([other.usd, other.ledgerFrom]).toEqual([0, null]);
  expect((await monthCost(0, { now })).usd).toBe(0);
});

test("monthCostLabel: the month's total and how it was reached; * when hours are unknown", () => {
  const month = { usd: 5.52, upHours: 23.68, unknownHours: 0, usdMax: 5.52, assumedHours: 0, ledgerFrom: Date.UTC(2026, 9, 12) };
  expect(monthCostLabel(month, { hourlyUsd: 0.2331, source: "estimate", instanceType: "m7i.xlarge" })).toEqual({
    value: "$5.52",
    detail: "$0.23/h est. (m7i.xlarge) × 23.7 h up this month (UTC), from the machine's boot ledger\nLedger from 2026-10-12",
  });
  expect(monthCostLabel(month, { hourlyUsd: 0.0472, source: "config" })!.detail.split("\n")[0]).toBe("$0.047/h × 23.7 h up this month (UTC), from the machine's boot ledger");
  const unsure = monthCostLabel({ ...month, unknownHours: 12.04, usdMax: 8.33, assumedHours: 3, billingSince: Date.UTC(2026, 9, 1) }, { hourlyUsd: 0.2331, source: "config" })!;
  expect(unsure.value).toBe("$5.52*");
  expect(unsure.detail.split("\n").slice(1)).toEqual([
    "Ledger from 2026-10-12; billing since 2026-10-01",
    "3 h before the ledger assumed running (billing start in config)",
    "12 h unknown — counted as stopped; $8.33 if the machine was running",
  ]);
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
