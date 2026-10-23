// Run scope ownership (server/cgroup.ts `scopeOwner`, server/browserWatch.ts `sweepOrphanScopes`).
// Incident 2026-10-23: a test bridge with its own state dir read no leases there, so its orphan sweep
// killed every run scope on the box — the live bridge's workers ended with exit 137 and no OOM. A run
// scope's unit now names its owner (`orca-run-<owner>-<runId>`, the owner a hash of the state dir),
// and a bridge sweeps only its own.
//
// This drives a REAL second bridge (server/index.ts, its own state dir, one scratch schema) against
// REAL systemd user scopes in the agents' slice. Only the two scopes this test makes are touched: the
// live bridge on main matches only untagged names, and after this change it matches only its owner.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cgroup from "../server/cgroup";
import * as db from "../server/db";
import { readProcs, sweepOrphanScopes } from "../server/browserWatch";
import { freePort } from "../server/preview";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const fetch = native.fetch; // happy-dom's preloaded fetch CORS-blocks a real port
const ROOT = join(import.meta.dir, "..");
const real = process.platform === "linux" && cgroup.available();

let pg: TestDb;
let tmp: string;
let liveState: string; // the first bridge's state dir (the live one in the incident)
let testState: string; // the second bridge's own state dir
const procs: Bun.Subprocess[] = [];
const units: string[] = [];

/** A real process in a real run scope of `owner` in the agents' slice. */
async function runScope(owner: string): Promise<{ runId: string; proc: Bun.Subprocess }> {
  const runId = crypto.randomUUID();
  const unit = cgroup.runScopeUnit(runId, owner);
  units.push(unit);
  const proc = Bun.spawn(["systemd-run", "--user", "--scope", "--quiet", `--unit=${unit}`, `--slice=${cgroup.AGENTS_SLICE}`, "--", "sleep", "300"],
    { env: { ...process.env, ...cgroup.runtimeEnv() }, stdout: "ignore", stderr: "ignore" });
  procs.push(proc);
  await until(async () => readProcs().some((p) => p.pid === proc.pid && p.cgroup.includes(`/${unit}.scope`)));
  return { runId, proc };
}

async function until(fn: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return; await Bun.sleep(100); }
  throw new Error("condition never held");
}

async function bridge(state: string): Promise<Bun.Subprocess> {
  const port = await freePort([20_000, 60_000]);
  const env = {
    ...process.env, ORCA_STATE_DIR: state, ORCA_DATABASE_URL: pg.url, ORCA_API_PORT: String(port), ORCA_BIND: "127.0.0.1",
    ORCA_INSTANCE: "scope-test", ORCA_ALLOW_WORKTREE_MIGRATIONS: "1", ORCA_PRIMARY: "1", ORCA_PRIMARY_RETRY_MS: "200",
    ORCA_WATCH_INTERVAL_MS: "200",
  } as Record<string, string>;
  delete env.NODE_ENV;
  for (const k of ["ORCA_PREVIEW_BRIDGE", "ORCA_PREVIEW_HOST", "ORCA_PREVIEW_BIND", "SLACK_TOKEN"]) delete env[k];
  const proc = Bun.spawn(["bun", "run", join(ROOT, "server", "index.ts")], { cwd: ROOT, env, stdout: "ignore", stderr: "ignore" });
  procs.push(proc);
  const base = `http://127.0.0.1:${port}`;
  await until(async () => {
    const r = await fetch(`${base}/api/config`);
    return r.ok && ((await r.json()) as { bridge: { primary: boolean } }).bridge.primary;
  }, 30_000);
  return proc;
}

beforeAll(async () => {
  if (!real) return;
  tmp = await mkdtemp(join(tmpdir(), "orca-scope-owner-"));
  liveState = join(tmp, "live");
  testState = join(tmp, "test");
  pg = await freshSchema("scopeowner");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  await db.saveConfig({ repos: [], app: { portRange: [30000, 40000], staleHours: 24 } });
  await db.close();
}, 30_000);

afterAll(async () => {
  for (const p of procs) p.kill("SIGKILL");
  await Promise.all(procs.map((p) => p.exited));
  if (!real) return;
  for (const u of units) Bun.spawnSync(["systemctl", "--user", "stop", `${u}.scope`], { env: { ...process.env, ...cgroup.runtimeEnv() } });
  await db.close();
  await pg.drop();
  await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!real)("a second bridge with its own state dir sweeps only its own scopes; the first bridge's run is kept", async () => {
  const live = await runScope(cgroup.scopeOwner(liveState)); // the first bridge's worker: its lease is in liveState only
  const leaked = await runScope(cgroup.scopeOwner(testState)); // the second bridge's own leaked run: no lease anywhere
  await bridge(testState);
  // The second bridge's sweep runs: its own orphan dies on the second pass that sees it.
  await until(async () => leaked.proc.exitCode !== null || leaked.proc.signalCode !== null);
  expect(leaked.proc.signalCode).toBe("SIGKILL");
  // Many more passes: the first bridge's run is still alive.
  await Bun.sleep(1_500);
  expect(live.proc.exitCode).toBeNull();
  expect(live.proc.signalCode).toBeNull();

  // The first bridge, restarted with no lease for that run, still cleans up its OWN orphan.
  const suspects = new Set<string>();
  const pass = () => sweepOrphanScopes({ owner: cgroup.scopeOwner(liveState), known: () => new Set(), suspects });
  expect(pass()).toEqual([]); // first sight: a launch may not have its lease yet
  expect(pass().map((k) => k.runId)).toContain(live.runId);
  expect(await live.proc.exited).not.toBe(0);
}, 60_000);
