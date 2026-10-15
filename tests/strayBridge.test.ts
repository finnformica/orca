// Stray bridges (incident 2026-10-15): a branch preview's bridge on pre-#215 code outlived its
// worktree by 19h, ran the merge queue (whose reports wake the orchestrator) and launched the
// orchestrator's wakes with a deleted bin/ on PATH. Every guard that stops that, driven for real:
//  - a preview bridge holds no duty and launches nothing, whatever loop or route reaches it;
//  - a bridge notices its checkout going (source, git registration, cwd) and leaves;
//  - removing a worktree stops the Orca bridge running in it; sweep finds bun processes left on a
//    deleted cwd;
//  - the primary stops another bridge's orchestrator wake (real processes: a fake bridge + its child).
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as primary from "../server/primary";
import * as agent from "../server/agent";
import * as mergeQueue from "../server/mergeQueue";
import * as upkeep from "../server/upkeep";
import * as verbs from "../server/verbs";
import * as orchestrator from "../server/orchestrator";
import * as lease from "../server/lease";
import * as procs from "../server/proc";
import type { OrcaConfig, RepoConfig } from "../server/config";
import { sweepText } from "../web/src/workstream";
import { freshSchema, type TestDb } from "./pg";

const saved: Record<string, string | undefined> = {};
const ENV = ["ORCA_PREVIEW_BRIDGE", "ORCA_STATE_DIR"];
let pg: TestDb;
let savedUrl: string | undefined;
// For the whole file: SB6's eviction starts a fire-and-forget orchestrator.recover, which reads the
// database after the test returns.
beforeAll(async () => {
  pg = await freshSchema("straybridge");
  savedUrl = process.env.ORCA_DATABASE_URL;
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterAll(async () => {
  await Bun.sleep(100);
  await db.close();
  await pg.drop();
  if (savedUrl === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = savedUrl;
});
beforeEach(() => { for (const k of ENV) saved[k] = process.env[k]; delete process.env.ORCA_PREVIEW_BRIDGE; });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

/** A config any read of which fails the test: a guard must return before touching it. */
const untouchable = new Proxy({}, { get: () => { throw new Error("a preview bridge read the config"); } }) as OrcaConfig;

test("SB1 a preview bridge holds no duty and launches nothing — even with no election run", async () => {
  expect(primary.held()).toBe(true); // a plain process (a test, a script) that never elected
  process.env.ORCA_PREVIEW_BRIDGE = "1";
  expect(primary.held()).toBe(false);
  await expect(agent.launch("/tmp/x", "/tmp", "hi")).rejects.toThrow("launches no agent runs");
  expect(await mergeQueue.tick(untouchable)).toBeUndefined();
  expect(await upkeep.tick(untouchable)).toEqual([]);
  expect(await verbs.cleanupRepo(untouchable as unknown as RepoConfig)).toEqual([]);
  expect(agent.adoptLeases(async () => undefined)).toBe(0);
  expect(await orchestrator.evictForeignWake(untouchable, async () => {})).toBeUndefined();
});

/** A scratch checkout shaped like a linked worktree: `<root>/server/index.ts` and a `.git` file
 *  naming a gitdir. */
function checkout(): { root: string; server: string; gitdir: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "orca-stray-")));
  const root = join(base, "wt");
  const gitdir = join(base, "main.git", "worktrees", "wt");
  mkdirSync(join(root, "server"), { recursive: true });
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(root, "server", "index.ts"), "");
  writeFileSync(join(root, ".git"), `gitdir: ${gitdir}\n`);
  return { root, server: join(root, "server"), gitdir };
}

test("SB2 checkoutGone: source, git registration and cwd each count", () => {
  const live = () => undefined;
  const a = checkout();
  expect(primary.checkoutGone(a.server, a.root, live)).toBeUndefined();
  expect(primary.checkoutGone(a.server, a.root, () => `${a.root} (deleted)`)).toContain("was deleted");
  rmSync(a.gitdir, { recursive: true }); // `git worktree remove` / prune
  expect(primary.checkoutGone(a.server, a.root, live)).toContain("removed from git");
  const b = checkout();
  rmSync(join(b.server, "index.ts"));
  expect(primary.checkoutGone(b.server, b.root, live)).toContain("source");
  const c = checkout();
  expect(primary.checkoutGone(c.server, join(c.root, "gone"), live)).toContain("working directory");
  // A main install with a .git DIRECTORY (or none, a tarball) is never "unregistered".
  const d = checkout();
  rmSync(join(d.root, ".git"));
  mkdirSync(join(d.root, ".git"));
  expect(primary.checkoutGone(d.server, d.root, live)).toBeUndefined();
});

test("SB3 watchSource calls onGone once the worktree is unregistered, though its files remain", async () => {
  const a = checkout();
  let gone = 0;
  primary.watchSource(() => { gone++; }, a.server, 20, a.root);
  await Bun.sleep(80);
  expect(gone).toBe(0);
  rmSync(a.gitdir, { recursive: true });
  for (let i = 0; i < 50 && !gone; i++) await Bun.sleep(20);
  await Bun.sleep(60);
  expect(gone).toBe(1);
});

test("SB4 bridgeAncestor: the nearest Orca bridge above a run, none for an adopted (reparented) one", () => {
  const table: procs.ProcRow[] = [
    { pid: 1, ppid: 0, command: "/sbin/init" },
    { pid: 10, ppid: 1, command: "sh -c cd '/wt/x' && '/opt/orca/scripts/preview-orca.sh' 10191" },
    { pid: 11, ppid: 10, command: "bun server/index.ts" },
    { pid: 12, ppid: 11, command: "claude -p --resume abc --output-format stream-json" },
    { pid: 20, ppid: 1, command: "claude -p --resume def" }, // its bridge died: reparented
    { pid: 30, ppid: 1, command: "/home/orca/.bun/bin/bun run /opt/orca/server/index.ts" },
    { pid: 31, ppid: 30, command: "bash /home/orca/.local/bin/claude -p hi" }, // a shim between
    { pid: 32, ppid: 31, command: "node claude-real -p hi" },
  ];
  expect(procs.bridgeAncestor(12, table)?.pid).toBe(11);
  expect(procs.bridgeAncestor(20, table)).toBeUndefined();
  expect(procs.bridgeAncestor(32, table)?.pid).toBe(30);
  // A prompt naming server/index.ts never makes an agent a bridge.
  expect(procs.isOrcaBridgeCommand("claude -p 'restart bun server/index.ts'")).toBe(false);
  expect(procs.isOrcaBridgeCommand("bun -e const main = `http://127.0.0.1:${process.env.MAIN}`")).toBe(true);
  expect(procs.isOrcaBridgeCommand("bun test tests/x.test.ts")).toBe(false);
});

/** A fake "bridge": `bun <root>/server/index.ts` run IN the worktree, which spawns a long child (its
 *  "wake") and reports the child's pid. */
async function fakeBridge(root: string): Promise<{ bridge: Bun.Subprocess; child: number }> {
  writeFileSync(join(root, "server", "index.ts"), `
    const c = Bun.spawn(["sleep", "60"], { stdout: "ignore" });
    console.log(c.pid);
    await Bun.sleep(60_000);
  `);
  const bridge = Bun.spawn(["bun", join(root, "server", "index.ts")], { cwd: root, stdout: "pipe", stderr: "ignore" });
  const reader = bridge.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return { bridge, child: Number(new TextDecoder().decode(value).trim()) };
}
const dead = async (pid: number) => { for (let i = 0; i < 100 && lease.pidAlive(pid); i++) await Bun.sleep(30); return !lease.pidAlive(pid); };

test("SB5 removing a worktree stops the bridge running in it; sweep finds one on a deleted cwd", async () => {
  const a = checkout();
  const { bridge, child } = await fakeBridge(a.root);
  try {
    expect((await procs.bridgesIn(a.root)).map((p) => p.pid)).toEqual([bridge.pid]);
    expect(await procs.strayProcesses().then((ps) => ps.some((p) => p.pid === bridge.pid))).toBe(false); // cwd still there
    expect(await procs.stopBridgesIn(a.root)).toEqual([bridge.pid]);
    expect(await dead(bridge.pid)).toBe(true);

    const b = checkout();
    const stray = await fakeBridge(b.root);
    rmSync(b.root, { recursive: true, force: true }); // the worktree deleted under it
    const found = (await procs.strayProcesses()).find((p) => p.pid === stray.bridge.pid);
    expect(found?.cwd).toContain(b.root);
    // The sweep's report names it; --confirm is what stops it (verbs.sweep → procs.terminate).
    expect(sweepText([{ instance: "cloud", confirmed: false, worktrees: [], previews: [], branches: [], processes: [{ pid: found!.pid, command: found!.command, cwd: found!.cwd! }] }]))
      .toContain(`would stop  pid ${found!.pid}`);
    expect(procs.terminate([found!])).toEqual([stray.bridge.pid]);
    expect(await dead(stray.bridge.pid)).toBe(true);
    try { process.kill(stray.child); } catch { /* gone */ }
  } finally {
    try { process.kill(child); } catch { /* gone */ }
    bridge.kill();
  }
});

test("SB6 the primary stops another bridge's orchestrator wake — and leaves its own and an adopted one", async () => {
  process.env.ORCA_STATE_DIR = mkdtempSync(join(tmpdir(), "orca-stray-state-"));
  const cfg = { repos: [] } as unknown as OrcaConfig;
  const a = checkout();
  const { bridge, child } = await fakeBridge(a.root);
  try {
    const claim = (pid: number) => lease.acquire({ key: orchestrator.dir(), worktreePath: orchestrator.dir(), provider: "claude", runId: "r-stray", pid, startedAt: Date.now() });
    // Our own wake (its parent is this process) — left alone.
    const own = Bun.spawn(["sleep", "60"]);
    claim(own.pid);
    expect(await orchestrator.evictForeignWake(cfg, async () => {})).toBeUndefined();
    own.kill();
    // A wake with no bridge above it (as after a restart) — left to recover().
    claim(child);
    const reparented = (await procs.processTable()).map((r) => (r.pid === child ? { ...r, ppid: 1 } : r));
    expect(await orchestrator.evictForeignWake(cfg, async () => {}, reparented)).toBeUndefined();
    // Launched by another bridge: both stopped.
    const evicted = await orchestrator.evictForeignWake(cfg, async () => {});
    expect(evicted).toEqual({ bridge: bridge.pid, run: child, runId: "r-stray" });
    expect(await dead(bridge.pid)).toBe(true);
    expect(await dead(child)).toBe(true);
  } finally {
    try { process.kill(child); } catch { /* gone */ }
    bridge.kill();
  }
});
