// One bridge per instance runs the background duties (server/primary.ts). Incident 2026-10-14: four
// full bridges started by hand from finished workstreams' worktrees kept running on the shared
// database after the worktrees were deleted, and one woke the orchestrator with a dead bin/ on PATH.
// This drives REAL bridges (server/index.ts subprocesses, one scratch schema, killed in afterAll):
//  - two bridges of one instance: the first holds the advisory lock, the second is secondary — it
//    refuses an orchestrator wake — and takes over once the first is gone;
//  - a bridge whose code sits under `.worktrees/` is secondary without ORCA_PRIMARY=1;
//  - a bridge whose own source directory is deleted exits.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import { freePort } from "../server/preview";
import { mainBin, worktreeRefusal } from "../server/primary";
import { SCREENSHOTS, followUpPrompt } from "../web/src/workstream";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const fetch = native.fetch; // happy-dom's preloaded fetch CORS-blocks a real port
const ROOT = join(import.meta.dir, "..");

let pg: TestDb;
let tmp: string;
const procs: Bun.Subprocess[] = [];

async function bridge(root: string, state: string, extra: Record<string, string> = {}): Promise<{ base: string; proc: Bun.Subprocess }> {
  const port = await freePort([20_000, 60_000]);
  const env = {
    ...process.env, ORCA_STATE_DIR: state, ORCA_DATABASE_URL: pg.url, ORCA_API_PORT: String(port), ORCA_BIND: "127.0.0.1",
    ORCA_INSTANCE: "solo", ORCA_ALLOW_WORKTREE_MIGRATIONS: "1", ORCA_PRIMARY_RETRY_MS: "200", ORCA_SOURCE_WATCH_MS: "200", ...extra,
  } as Record<string, string>;
  delete env.NODE_ENV;
  for (const k of ["ORCA_PREVIEW_BRIDGE", "ORCA_PREVIEW_HOST", "ORCA_PREVIEW_BIND", "SLACK_TOKEN"]) delete env[k];
  if (!("ORCA_PRIMARY" in extra)) delete env.ORCA_PRIMARY;
  const proc = Bun.spawn(["bun", "run", join(root, "server", "index.ts")], { cwd: root, env, stdout: "ignore", stderr: "ignore" });
  procs.push(proc);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) return { base, proc }; } catch { /* not up yet */ }
    await Bun.sleep(50);
  }
  throw new Error("bridge never came up");
}

/** The answering bridge's election state, as /api/config reports it. */
const role = async (base: string): Promise<{ primary: boolean; reason: string }> =>
  ((await (await fetch(`${base}/api/config`)).json()) as { bridge: { primary: boolean; reason: string } }).bridge;

async function until(fn: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return; await Bun.sleep(100); }
  throw new Error("condition never held");
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "orca-primary-"));
  pg = await freshSchema("primary");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  await db.saveConfig({ repos: [], app: { portRange: [30000, 40000], staleHours: 24 } });
  await db.close();
}, 30_000);

afterAll(async () => {
  for (const p of procs) p.kill();
  await Promise.all(procs.map((p) => p.exited));
  await db.close();
  await pg.drop();
  await rm(tmp, { recursive: true, force: true });
});

test("a bridge under .worktrees/ is refused background duties unless ORCA_PRIMARY=1", () => {
  expect(worktreeRefusal("/opt/orca/.worktrees/orca/x/server", {})).toContain("worktree");
  expect(worktreeRefusal("/opt/orca/.worktrees/orca/x/server", { ORCA_PRIMARY: "1" })).toBeUndefined();
  expect(worktreeRefusal("/opt/orca/server", {})).toBeUndefined();
});

test("every worker brief says to run Orca through scripts/preview-orca.sh, never server/index.ts", () => {
  expect(SCREENSHOTS).toContain("scripts/preview-orca.sh");
  expect(SCREENSHOTS).toMatch(/never start `server\/index\.ts`/);
  expect(followUpPrompt("tweak the header")).toContain("scripts/preview-orca.sh");
});

test("the orchestrator's PATH names the main install's bin/, which holds orca", () => {
  const bin = mainBin();
  expect(existsSync(join(bin, "orca"))).toBe(true);
  expect(bin).not.toContain("/.worktrees/");
});

test("only one bridge per instance holds the lock; the second runs no duties until the first is gone", async () => {
  const a = await bridge(ROOT, join(tmp, "a"), { ORCA_PRIMARY: "1" });
  await until(async () => (await role(a.base)).primary);
  const b = await bridge(ROOT, join(tmp, "b"), { ORCA_PRIMARY: "1" });
  await Bun.sleep(600); // a few of b's retries
  expect(await role(b.base)).toMatchObject({ primary: false, reason: expect.stringContaining("another bridge") });
  expect((await role(a.base)).primary).toBe(true);
  // A secondary never wakes the orchestrator.
  const asked = await fetch(`${b.base}/api/orchestrator/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }) });
  expect(asked.status).toBe(503);
  expect(((await asked.json()) as { error: string }).error).toContain("secondary");
  // The primary goes away (its connection, and the lock, with it): the secondary takes over.
  a.proc.kill();
  await a.proc.exited;
  await until(async () => (await role(b.base)).primary);
}, 60_000);

test("a bridge started from a worktree path is secondary, and exits when its source is deleted", async () => {
  // A copy of the bridge's code at <tmp>/.worktrees/copy — what a worker's hand-started bridge is.
  const copy = join(tmp, ".worktrees", "copy");
  await mkdir(join(copy, "web"), { recursive: true });
  for (const d of ["server", "shared", "bin"]) await cp(join(ROOT, d), join(copy, d), { recursive: true });
  await cp(join(ROOT, "web", "src"), join(copy, "web", "src"), { recursive: true });
  for (const f of ["package.json", "tsconfig.json", "orca.config.ts"]) await cp(join(ROOT, f), join(copy, f));
  await symlink(join(ROOT, "node_modules"), join(copy, "node_modules"));
  const w = await bridge(copy, join(tmp, "w"), { ORCA_INSTANCE: "stray" }); // its own instance: nobody else holds that lock
  await Bun.sleep(600);
  expect(await role(w.base)).toMatchObject({ primary: false, reason: expect.stringContaining("worktree") });
  // The worktree is reaped under it: the bridge leaves on its own.
  await rm(join(copy, "server"), { recursive: true, force: true });
  const code = await Promise.race([w.proc.exited, Bun.sleep(10_000).then(() => "still running")]);
  expect(code).toBe(0);
}, 60_000);
