// A deploy with no gap (deploy/autodeploy.sh, deploy/orca@.service): with ORCA_REUSE_PORT=1 two
// REAL bridges (server/index.ts as subprocesses) listen on ONE port at once, each answers
// /api/config with its own pid, and once the old one is stopped the port is still served — the
// moment the script relies on. Without the flag the second bridge must fail to bind, the laptop's
// behaviour.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import { freePort } from "../server/preview";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const fetch = native.fetch;
const ROOT = join(import.meta.dir, "..");
let pg: TestDb;
let dirs: string[] = [];
const procs: Bun.Subprocess[] = [];

function spawnBridge(state: string, port: number, reuse: boolean): Bun.Subprocess {
  const env = { ...process.env, ORCA_STATE_DIR: state, ORCA_DATABASE_URL: pg.url, ORCA_API_PORT: String(port), ORCA_BIND: "127.0.0.1", ORCA_INSTANCE: "box", ORCA_ALLOW_WORKTREE_MIGRATIONS: "1", ORCA_PRIMARY: "1", ...(reuse ? { ORCA_REUSE_PORT: "1" } : {}) } as Record<string, string>;
  delete env.NODE_ENV;
  if (!reuse) delete env.ORCA_REUSE_PORT;
  const p = Bun.spawn(["bun", "run", join(ROOT, "server", "index.ts")], { cwd: ROOT, env, stdout: "ignore", stderr: "pipe" });
  procs.push(p);
  return p;
}
/** Drain a bridge's stderr as it comes (a full pipe would block it), keeping the text. */
const drain = (p: Bun.Subprocess): { text: () => string } => {
  let text = "";
  const reader = (p.stderr as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value); } })();
  return { text: () => text };
};
// Linux shares a port's new connections between SO_REUSEPORT listeners (what autodeploy.sh's pid
// handshake relies on); macOS hands them all to one listener until it closes. CI is Linux.
const LINUX = process.platform === "linux";

const pidOf = async (base: string): Promise<number | undefined> => {
  try {
    const r = await fetch(`${base}/api/config`, { headers: { connection: "close" } }); // a NEW connection each time, as curl does; keep-alive would pin one listener
    return r.ok ? ((await r.json()) as { bridge?: { pid?: number } }).bridge?.pid : undefined;
  } catch { return undefined; }
};

/** The set of pids that answered over `n` calls. */
async function answering(base: string, n: number): Promise<Set<number>> {
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) { const pid = await pidOf(base); if (pid) seen.add(pid); }
  return seen;
}

async function waitFor(base: string, pid: number, ms = 20_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await answering(base, 4)).has(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

beforeAll(async () => {
  pg = await freshSchema("reuseport");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  await db.saveConfig({ repos: [], app: { portRange: [30000, 40000], staleHours: 24 } });
  await db.close();
}, 30_000);

afterAll(async () => {
  for (const p of procs) p.kill();
  await db.close();
  await pg.drop();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

test("ORCA_REUSE_PORT=1: a second bridge listens beside the first on one port; each answers with its pid; the port is served on after the first stops", async () => {
  const port = await freePort([20_000, 60_000]);
  const base = `http://127.0.0.1:${port}`;
  const [s1, s2] = [await mkdtemp(join(tmpdir(), "orca-reuse-1-")), await mkdtemp(join(tmpdir(), "orca-reuse-2-"))];
  dirs.push(s1, s2);
  const old = spawnBridge(s1, port, true); drain(old);
  expect(await waitFor(base, old.pid)).toBe(true);
  const fresh = spawnBridge(s2, port, true); const freshErr = drain(fresh);
  if (LINUX) {
    expect(await waitFor(base, fresh.pid)).toBe(true); // what autodeploy.sh waits for: the NEW pid on /api/config
    const both = await answering(base, 40); // both live on the one port
    expect(both.has(old.pid)).toBe(true);
    expect(both.has(fresh.pid)).toBe(true);
  } else {
    await new Promise((r) => setTimeout(r, 8_000)); // the second bind must not fail
    expect(freshErr.text()).not.toMatch(/in use/i);
  }
  // The old one stops (a deploy's `systemctl stop` of the old slot): every answer is now the new one.
  old.kill("SIGTERM");
  await old.exited;
  expect(await waitFor(base, fresh.pid)).toBe(true);
  const after = await answering(base, 20);
  expect(after).toEqual(new Set([fresh.pid]));
}, 90_000);

// The laptop is a Mac; what Linux does without the flag is not part of the deploy contract.
test.skipIf(LINUX)("without the flag a second bridge on the port fails to bind (a laptop's stray bridge stays loud)", async () => {
  const port = await freePort([20_000, 60_000]);
  const base = `http://127.0.0.1:${port}`;
  const [s1, s2] = [await mkdtemp(join(tmpdir(), "orca-noreuse-1-")), await mkdtemp(join(tmpdir(), "orca-noreuse-2-"))];
  dirs.push(s1, s2);
  const first = spawnBridge(s1, port, false); drain(first);
  expect(await waitFor(base, first.pid)).toBe(true);
  const second = spawnBridge(s2, port, false); const err = drain(second);
  const until = Date.now() + 30_000;
  while (Date.now() < until && !/in use/i.test(err.text())) await new Promise((r) => setTimeout(r, 200));
  expect(err.text()).toMatch(/in use/i); // "Failed to start server. Is port N in use?"
  expect(await answering(base, 10)).toEqual(new Set([first.pid]));
}, 60_000);
