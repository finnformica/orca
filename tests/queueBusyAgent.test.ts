// Queueing an action on a busy agent, server side (server/index.ts's /api/agent and /api/agents/run
// routes): Address PR / Resolve conflicts / Retry / Fix landing on a worktree whose agent is already
// running used to 409 ("an agent is already running for this worktree") for every action except a
// typed follow-up. Both routes now queue instead — the same contract `orca address`/`orca send`
// already had through verbs.followUp (verbs.ts) — and the queued instruction runs once the in-flight
// turn finishes. This spawns the REAL bridge (server/index.ts) as a subprocess against a scratch
// Postgres schema + scratch repo, with a controllable fake `claude` on PATH, and hits its actual
// HTTP routes — the only way to pin the route's own gate, as opposed to the lower-level queue/dispatch
// mechanics already covered by chatHistory.test.ts and verifyGate.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import { freePort } from "../server/preview";
import { makeScratchRepo } from "./helpers";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

// happy-dom's preloaded fetch CORS-blocks a real port; Bun's own (captured before happy-dom
// replaces the globals) is what a test driving the real bridge over HTTP needs.
const fetch = native.fetch;

let state: string, shim: string, repo: string, hold: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};
let proc: Bun.Subprocess | undefined;
let base: string;

const ROOT = join(import.meta.dir, "..");
const ENV_KEYS = ["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_API_PORT", "ORCA_ALLOW_WORKTREE_MIGRATIONS", "ORCA_PRIMARY", "NODE_ENV", "ORCA_BIND"];

beforeEach(async () => {
  prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  state = await mkdtemp(join(tmpdir(), "orca-queue-state-"));
  shim = await mkdtemp(join(tmpdir(), "orca-queue-claude-"));
  hold = join(state, "hold");
  repo = await makeScratchRepo();
  // A fake claude: blocks while the hold file exists (lets a test keep a run "busy" on demand),
  // then reports success. No commit, so the verification gate never engages.
  await writeFile(join(shim, "claude"), `#!/bin/sh
while [ -f "${hold}" ]; do sleep 0.02; done
printf '{"type":"result","subtype":"success","result":"## Outcome\\\\nDone.","is_error":false}'
`);
  await chmod(join(shim, "claude"), 0o755);

  pg = await freshSchema("queuebusy");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  // Seed the repo directly into the database so the subprocess's loadConfig() never falls back to
  // the checked-in orca.config.ts (which names real repos this sandbox doesn't have).
  await db.saveConfig({
    repos: [{ name: "r", config: { repoPath: repo, worktreeRoot: repo, baseBranch: "main", previewServices: [], providers: ["claude"] } }],
    app: { portRange: [30000, 40000], staleHours: 24 },
  });
  await db.close(); // the subprocess gets its own pool; don't hold this one open under it

  const port = await freePort([20_000, 60_000]);
  base = `http://127.0.0.1:${port}`;
  process.env.ORCA_STATE_DIR = state;
  process.env.PATH = `${shim}:${prev.PATH}`;
  process.env.ORCA_API_PORT = String(port);
  process.env.ORCA_BIND = "127.0.0.1";
  // This checkout is a linked worktree; allow its bridge to migrate the scratch schema above.
  process.env.ORCA_ALLOW_WORKTREE_MIGRATIONS = "1";
  process.env.ORCA_PRIMARY = "1"; // and to run its duties (the run-finished hook that sends the queue)
  delete process.env.NODE_ENV;
  proc = Bun.spawn(["bun", "run", join(ROOT, "server", "index.ts")], { cwd: ROOT, env: process.env as Record<string, string>, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 50));
    if (i === 399) throw new Error("bridge never came up");
  }
  process.env.ORCA_DATABASE_URL = pg.url; // this process's own db.ts reads turns/queued below
});

afterEach(async () => {
  proc?.kill();
  await rm(hold, { force: true });
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, repo]) await rm(d, { recursive: true, force: true });
});

async function settled(branch: string, n: number) {
  for (let i = 0; i < 400; i++) {
    const turns = await db.turns("r", branch);
    if (turns.length >= n && turns.every((t) => t.finishedAt)) return turns;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never settled at ${n} turn(s)`);
}

test("POST /api/agent: Address PR landing on a busy worktree is queued, not refused — and runs once the in-flight turn finishes", async () => {
  await writeFile(hold, ""); // hold the first run "busy"
  const first = await fetch(`${base}/api/agent`, {
    method: "POST",
    body: JSON.stringify({ repo: "r", key: repo, worktree: repo, branch: "feat", prompt: "do the first thing", action: "launch", instruction: "do the first thing" }),
  }).then((r) => r.json());
  expect(first.status).toBe("running");

  // Address PR arriving while that run is still in flight — this used to 409 (action !== "followup").
  const res = await fetch(`${base}/api/agent`, {
    method: "POST",
    body: JSON.stringify({ repo: "r", key: repo, worktree: repo, branch: "feat", prompt: "address prompt (unused once queued)", action: "address", instruction: "Address the PR: conflicts, CI, review" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("queued");
  expect(body.queued.instruction).toBe("Address the PR: conflicts, CI, review");

  // Queued, visible, and NOT dispatched yet — the first run is still busy.
  expect((await db.queuedMessages("r", "feat")).map((m) => m.instruction)).toEqual(["Address the PR: conflicts, CI, review"]);
  expect((await db.turns("r", "feat")).filter((t) => t.finishedAt)).toHaveLength(0);

  await rm(hold, { force: true }); // let the first run finish — the queued address should fire next
  const turns = await settled("feat", 2);
  expect(turns).toHaveLength(2);
  expect(turns[0]?.instruction).toBe("do the first thing");
  expect(turns[1]?.instruction).toBe("Address the PR: conflicts, CI, review"); // delivered after the turn finished
  expect(await db.queuedMessages("r", "feat")).toEqual([]); // drained
});

test("POST /api/agents/run: a busy worktree queues too, instead of 409ing", async () => {
  await writeFile(hold, "");
  const first = await fetch(`${base}/api/agents/run`, {
    method: "POST",
    body: JSON.stringify({ repo: "r", worktreePath: repo, branch: "feat2", prompt: "launch it", action: "launch", instruction: "launch it" }),
  }).then((r) => r.json());
  expect(first.status).toBe("running");

  const res = await fetch(`${base}/api/agents/run`, {
    method: "POST",
    body: JSON.stringify({ repo: "r", worktreePath: repo, branch: "feat2", prompt: "retry it", action: "rerun", instruction: "Retry the failed run" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("queued");
  expect(body.queued.instruction).toBe("Retry the failed run");

  await rm(hold, { force: true });
  const turns = await settled("feat2", 2);
  expect(turns[1]?.instruction).toBe("Retry the failed run");
});

test("GET /api/queued returns a queued message's attachments whether they're in the structured field or embedded in its instruction text", async () => {
  // A browser-originated follow-up stores refs in the structured field (server/index.ts's /api/agent).
  await db.queueMessage({
    repo: "r", branch: "feat3", worktreePath: repo, instruction: "look at this",
    attachments: ["orca-attachment://11111111-1111-1111-1111-111111111111/bug.png"], provider: "claude",
  });
  // The orchestrator's `orca send --attach` (verbs.followUp) bakes the ref into the instruction text
  // itself (withAttachments) instead — the structured field is empty, and used to mean the queued
  // bubble showed no attachment at all.
  await db.queueMessage({
    repo: "r", branch: "feat3", worktreePath: repo,
    instruction: "fix the bug\n\nAttached files (Read these for extra context):\n- orca-attachment://22222222-2222-2222-2222-222222222222/notes.txt",
    attachments: [], provider: "claude",
  });

  const res = await fetch(`${base}/api/queued?repo=r&branch=feat3`);
  expect(res.status).toBe(200);
  const queued = await res.json();
  expect(queued).toHaveLength(2);
  expect(queued[0].attachments).toEqual(["orca-attachment://11111111-1111-1111-1111-111111111111/bug.png"]);
  expect(queued[1].attachments).toEqual(["orca-attachment://22222222-2222-2222-2222-222222222222/notes.txt"]);
});
