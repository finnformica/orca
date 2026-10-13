// Migration identity is id + name (server/db.ts `planMigrations`). The incident this pins: two
// branches each appended "the next id"; one branch's 13 reached the shared database first, the runner
// (keyed on the id alone) skipped main's 13 as applied, and every metrics sample then failed on the
// missing `running_agents` column. Now a recorded name that isn't main's is reported, and the step is
// re-run if it is idempotent, or the bridge refuses to start if it is not.
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as db from "../server/db";
import { freshSchema, type TestDb } from "./pg";

let pg: TestDb;
let prevDbUrl: string | undefined;
beforeEach(async () => {
  prevDbUrl = process.env.ORCA_DATABASE_URL;
  pg = await freshSchema("migrations");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await db.close();
  await pg.drop();
  if (prevDbUrl === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prevDbUrl;
});

/** Run `fn` against the schema with a plain connection — what another branch's runner would do. */
async function raw(fn: (sql: Bun.SQL) => Promise<unknown>): Promise<void> {
  const sql = new Bun.SQL(pg.url);
  try { await fn(sql); } finally { await sql.end(); }
}
const ledger = async () => (await db.open())`SELECT id, name FROM migration ORDER BY id`;
const hasRunningAgents = async () =>
  (await (await db.open())`SELECT 1 FROM information_schema.columns WHERE table_name = 'instance_metric' AND column_name = 'running_agents' AND table_schema = current_schema()`).length === 1;
async function captureErrors<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; logged: string[] }> {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try { return { result: await fn(), logged }; } catch (error) { return { error, logged }; } finally { console.error = orig; }
}

test("a fresh database records every step under its name", async () => {
  const rows = await ledger();
  expect(rows.map((r: { id: number; name: string }) => [Number(r.id), r.name])).toEqual(db.MIGRATIONS.map((s) => [s.id, s.name]));
  expect(await hasRunningAgents()).toBe(true);
  expect(db.migrationReport()).toMatchObject({ mismatches: [], refused: [], unknown: [] });
});

test("main's 13 recorded under another branch's name is reported loudly and re-run, healing the column", async () => {
  await db.open();
  await db.close();
  // The incident: a foreign 13 holds the id, and main's column never got added.
  await raw(async (sql) => {
    await sql`ALTER TABLE instance_metric DROP COLUMN running_agents`;
    await sql`UPDATE migration SET name = 'notification' WHERE id = 13`;
    await sql`INSERT INTO migration (id, applied_at, name) VALUES (99, 0, 'from-a-branch')`;
  });
  const { error, logged } = await captureErrors(() => db.open());
  expect(error).toBeUndefined();
  expect(logged.filter((l) => l.includes("MIGRATION MISMATCH"))).toEqual([
    `orca: MIGRATION MISMATCH — migration 13 is recorded as "notification" but this code's 13 is "instance-metric-running-agents" — not treated as applied; re-running it (idempotent)`,
  ]);
  expect(logged.some((l) => l.includes("migration 99") && l.includes("no such step"))).toBe(true);
  expect(await hasRunningAgents()).toBe(true);
  expect((await ledger()).find((r: { id: number }) => Number(r.id) === 13).name).toBe("instance-metric-running-agents");
  // /api/diagnostics carries the same verdict.
  expect(db.migrationReport()).toMatchObject({
    mismatches: [{ id: 13, recorded: "notification", expected: "instance-metric-running-agents", idempotent: true }],
    unknown: [{ id: 99, name: "from-a-branch" }],
  });
  await db.recordMetric({ cpuPct: 1, load1: 0, memUsedGb: 1, memTotalGb: 2, runningAgents: 3 });
  expect((await db.metricHistory(db.instanceName(), 1))[0]!.runningAgents).toBe(3);
});

test("a ledger from before names (the shared database today): unnamed idempotent steps re-run, the rest are stamped", async () => {
  await db.open();
  await db.close();
  await raw(async (sql) => {
    await sql`ALTER TABLE instance_metric DROP COLUMN running_agents`;
    await sql`ALTER TABLE migration DROP COLUMN name`;
  });
  const { error, logged } = await captureErrors(() => db.open());
  expect(error).toBeUndefined();
  expect(logged.filter((l) => l.includes("MISMATCH"))).toEqual([]); // no name isn't a conflict
  expect(await hasRunningAgents()).toBe(true);
  expect((await ledger()).map((r: { name: string }) => r.name)).toEqual(db.MIGRATIONS.map((s) => s.name));
});

test("a mismatch on a step that isn't idempotent refuses to start, with instructions", async () => {
  await db.open();
  await db.close();
  await raw((sql) => sql`UPDATE migration SET name = 'someone-elses-3' WHERE id = 3`);
  const { error, logged } = await captureErrors(() => db.open());
  expect(error).toBeInstanceOf(db.MigrationRefused);
  const message = (error as Error).message;
  expect(message).toContain("refusing to start");
  expect(message).toContain(`migration 3 is recorded as "someone-elses-3" but this code's 3 is "repo-features-backfill"`);
  expect(message).toContain("UPDATE migration SET name");
  expect(message).toContain("bun run db:check");
  expect(logged.some((l) => l.includes("MIGRATION MISMATCH") && l.includes("migration 3"))).toBe(true);
});

test("every step named uniquely, ids strictly increasing, and an idempotent step is IF NOT EXISTS throughout", () => {
  // Increasing, not consecutive: an id held by another open branch (16, #152's) leaves a gap until it
  // lands, and migrate() needs only the order.
  const ids = db.MIGRATIONS.map((s) => s.id);
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
  expect(new Set(ids).size).toBe(ids.length);
  expect(new Set(db.MIGRATIONS.map((s) => s.name)).size).toBe(db.MIGRATIONS.length);
  for (const step of db.MIGRATIONS.filter((s) => s.idempotent)) {
    const statements = step.sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
    for (const st of statements) {
      // …or a backfill that only fills NULLs, so a re-run touches nothing it already wrote.
      expect(`${step.id}: ${st}`).toMatch(/^\d+: (CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS |ALTER TABLE \S+ ADD COLUMN IF NOT EXISTS |UPDATE (\S+) .* AND \S+ IS NULL$)/i);
    }
  }
});

test("re-running every step on a migrated database is harmless", async () => {
  await db.open();
  await db.close();
  await raw((sql) => sql`UPDATE migration SET name = NULL`);
  const { error } = await captureErrors(() => db.open());
  expect(error).toBeUndefined();
  expect(db.migrationReport()!.run.map((s) => s.id)).toEqual(db.MIGRATIONS.filter((s) => s.idempotent).map((s) => s.id));
  expect(db.migrationReport()!.stamp.map((s) => s.id)).toEqual([3]);
});

test("planMigrations: pending, matching, foreign and unknown ids", () => {
  const steps: db.MigrationStep[] = [
    { id: 1, name: "a", idempotent: true, sql: "" },
    { id: 2, name: "b", idempotent: false, sql: "" },
    { id: 3, name: "c", idempotent: true, sql: "" },
    { id: 4, name: "d", idempotent: true, sql: "" },
  ];
  const plan = db.planMigrations(steps, [{ id: 1, name: "a" }, { id: 2, name: "x" }, { id: 3, name: "y" }, { id: 7, name: null }]);
  expect(plan.run.map((s) => s.id)).toEqual([3, 4]);
  expect(plan.refused.map((m) => m.id)).toEqual([2]);
  expect(plan.mismatches.map((m) => m.id)).toEqual([2, 3]);
  expect(plan.unknown).toEqual([{ id: 7, name: null }]);
});

test("under bun test, only an orca_test_ schema may be migrated — never the shared database a worktree's .env names", async () => {
  expect(db.testDatabaseRefusal("postgres://box:5432/orca")).toContain("refusing to open a non-test database");
  expect(db.testDatabaseRefusal(pg.url)).toBeUndefined();
  expect(db.testDatabaseRefusal("postgres://box:5432/orca", "production")).toBeUndefined();
  process.env.ORCA_DATABASE_URL = "postgres://127.0.0.1:1/orca";
  await expect(db.open()).rejects.toThrow("refusing to open a non-test database");
});

test("bun run db:check prints applied vs expected and exits 1 when a start would be refused", async () => {
  await db.open();
  await db.close();
  const check = () => {
    const p = Bun.spawnSync(["bun", "run", "scripts/db-check.ts"], { env: { ...process.env, ORCA_DATABASE_URL: pg.url }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  };
  let r = check();
  expect(r.code).toBe(0);
  expect(r.out).toContain("13  instance-metric-running-agents");
  expect(r.out).toContain("result: up to date");

  await raw((sql) => sql`UPDATE migration SET name = 'notification' WHERE id = 13`);
  r = check();
  expect(r.code).toBe(0);
  expect(r.out).toContain(`MISMATCH: migration 13 is recorded as "notification"`);

  await raw((sql) => sql`UPDATE migration SET name = 'other' WHERE id = 3`);
  r = check();
  expect(r.code).toBe(1);
  expect(r.out).toContain("REFUSE to start");
});

// 2026-10-13: #132's `notification` table already existed on the shared database (an unmerged
// branch's bridge had created it under another id), its step was a plain CREATE TABLE, and both
// bridges crashed at boot on "relation already exists". Every step must be re-runnable.
test("every step is idempotent: marked so, and no bare CREATE TABLE / INDEX", () => {
  for (const s of db.MIGRATIONS) {
    // A pure data backfill (3) may be one-shot; anything that creates or alters schema must re-run cleanly.
    if (/\b(CREATE|ALTER)\b/.test(s.sql)) expect({ id: s.id, idempotent: s.idempotent }).toEqual({ id: s.id, idempotent: true });
    expect({ id: s.id, bare: s.sql.match(/CREATE (UNIQUE )?(TABLE|INDEX) (?!IF NOT EXISTS)/g) ?? [] }).toEqual({ id: s.id, bare: [] });
  }
});

test("a table a foreign branch already created does not crash the runner: its step is a no-op and gets recorded", async () => {
  await raw(async (sql) => {
    // The shape #132's branch created — same as main's 15, but no migration row for it.
    await sql.unsafe(db.MIGRATIONS.find((s) => s.name === "notification")!.sql);
  });
  const rows = await ledger();
  expect(rows.map((r: { id: number; name: string }) => r.name)).toContain("notification");
  expect(db.migrationReport()).toMatchObject({ refused: [] });
});

test("18 tags the orchestrator's turns with their source — reports alone are the agents', anything you said is yours", async () => {
  await db.open();
  const at = Date.now();
  const add = (branch: string, runId: string, instruction: string | undefined, prompt = "p") =>
    db.startTurn({ repo: branch === "orchestrator" ? "@orca" : "r", branch, runId, provider: "claude", instruction, prompt, startedAt: at });
  await add("orchestrator", "reports", "[worker finished] r/a — done\nOutcome: ok\n\n[worker finished] r/b — error\nResponse: boom");
  await add("orchestrator", "mixed", "[worker finished] r/a — done\nOutcome: ok\n\ncarry on");
  await add("orchestrator", "typed", "ship the cache");
  await add("orchestrator", "legacy", undefined, "You are Orca's orchestrator\n\n## New\n[worker finished] r/c — done\nOutcome: ok");
  await add("feature", "worker", "[worker finished] looks like one but is a worker's own turn");
  // A row the bridge wrote with its source (after this step) is never rewritten.
  await db.startTurn({ repo: "@orca", branch: "orchestrator", runId: "written", provider: "claude", instruction: "[worker finished] r/d — done", prompt: "p", startedAt: at, source: "human" });

  await (await db.open()).unsafe(db.MIGRATIONS.find((m) => m.id === 18)!.sql); // the backfill, re-run: idempotent
  const sourceOf = async (branch: string) =>
    Object.fromEntries((await db.turns(branch === "orchestrator" ? "@orca" : "r", branch)).map((t) => [t.id, t.source]));
  expect(await sourceOf("orchestrator")).toEqual({ reports: "agents", mixed: "human", typed: "human", legacy: "agents", written: "human" });
  expect(await sourceOf("feature")).toEqual({ worker: undefined });
  expect(db.MIGRATIONS.find((m) => m.id === 18)).toMatchObject({ name: "turn-source", idempotent: true });
});
