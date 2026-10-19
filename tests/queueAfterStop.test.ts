// Queue drain after a stop (the 2026-10-18 loss: `orca stop`, then the queue resumed, and an older
// queued message — "back to three cards" — never reached the worker; only the newest did). Two
// causes, both covered here:
//   1. the queued launcher started a NEW session (no `--resume`), so a queued message ran without the
//      conversation, and the next `orca send` resumed a session that never saw it;
//   2. a claimed message whose launch failed stayed claimed — gone — and the next send went alone.
// Real git scratch repo, a fake `claude` that records its argv, real Postgres, the real verbs.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as verbs from "../server/verbs";
import { run } from "../server/run";
import type { OrcaConfig } from "../server/config";
import { installFakeGh, makeScratchRepo, setPrListFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

let state: string, shim: string, repo: string, worktrees: string, log: string, hold: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};
let failNext = 0;

const cfg = (): OrcaConfig => ({
  repos: [{ name: "r", repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"] }],
  portRange: [30000, 40000], staleHours: 24,
});
const repoCfg = () => cfg().repos[0]!;

beforeEach(async () => {
  prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_FAKE_LOG", "ORCA_FAKE_HOLD"].map((k) => [k, process.env[k]]));
  [state, shim, worktrees, log] = await Promise.all(["state", "claude", "wt", "log"].map(async (n) => realpathSync(await mkdtemp(join(tmpdir(), `orca-qstop-${n}-`))))) as [string, string, string, string];
  repo = await makeScratchRepo();
  await run(["git", "-C", repo, "branch", "feat"]);
  hold = join(state, "hold");
  process.env.ORCA_STATE_DIR = state;
  process.env.ORCA_FAKE_LOG = log;
  process.env.ORCA_FAKE_HOLD = hold;
  process.env.PATH = `${shim}:${prev.PATH}`;
  await installFakeGh();
  await setPrListFixture([]);
  // A fake claude: records its argv (one file per launch), waits while the hold file exists, answers.
  await writeFile(join(shim, "claude"), `#!/bin/sh
printf '%s' "$*" > "$ORCA_FAKE_LOG/$(date +%s%N)-$$"
while [ -f "$ORCA_FAKE_HOLD" ]; do sleep 0.02; done
printf '{"type":"result","subtype":"success","result":"## Outcome\\\\nDone.","is_error":false}'
`);
  await chmod(join(shim, "claude"), 0o755);
  pg = await freshSchema("queueafterstop");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  failNext = 0;
  // index.ts's relay, with the real launcher behind it — and a switch to make one launch fail.
  agent.onQueuedMessage(async (m) => {
    if (failNext > 0) { failNext--; throw new Error("launch failed"); }
    await verbs.launchQueued(cfg(), repoCfg(), m);
  });
});

afterEach(async () => {
  await rm(hold, { force: true });
  for (let i = 0; i < 400 && (await runningAnywhere()); i++) await new Promise((r) => setTimeout(r, 25));
  await agent.afterRunsSettled();
  agent.onQueuedMessage(async () => {});
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, repo, worktrees, log]) await rm(d, { recursive: true, force: true });
});

let wt = "";
async function runningAnywhere() { return Boolean(wt) && agent.isRunning(wt); }
const launches = async () => {
  const files = (await readdir(log)).sort();
  return Promise.all(files.map((f) => readFile(join(log, f), "utf8")));
};
async function settled(n: number) {
  for (let i = 0; i < 400; i++) {
    await agent.afterRunsSettled();
    const turns = await db.turns("r", "feat");
    if (turns.length >= n && turns.every((t) => t.finishedAt) && !agent.isRunning(wt)) return turns;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never settled at ${n} turn(s)`);
}

/** The first run on the branch, its session recorded as the card's pointer (what a browser or the
 *  orchestrator's hook records). */
async function firstRun() {
  wt = await verbs.ensureWorktree(repoCfg(), "feat");
  const r = await verbs.followUp(cfg(), repoCfg(), "feat", { instruction: "build the cards" });
  expect(r.status).toBe("running");
  return (await db.enrichment("r")).feat!.sessionId as string;
}

test("stop, then the queue resumes: every queued message runs in order, each on the SAME session", async () => {
  await writeFile(hold, "");
  const session = await firstRun();
  expect(session).toBeTruthy();
  // Typed while it runs: queued.
  expect((await verbs.followUp(cfg(), repoCfg(), "feat", { instruction: "back to three cards" })).status).toBe("queued");
  // `orca stop`: the run stops and the queue drains at once.
  expect((await verbs.stopWorkstream(repoCfg(), "feat")).runId).toBeTruthy();
  expect(agent.status(wt)).toMatchObject({ status: "running" });
  // The orchestrator's next `orca send` lands while that queued message runs: it queues behind it.
  expect((await verbs.followUp(cfg(), repoCfg(), "feat", { instruction: "and make them blue" })).status).toBe("queued");
  await rm(hold, { force: true });
  const turns = await settled(3);
  expect(turns.map((t) => t.instruction)).toEqual(["build the cards", "back to three cards", "and make them blue"]);
  const argv = await launches();
  expect(argv).toHaveLength(3);
  // Both follow-ups resumed the first run's session: the worker saw every message in one conversation.
  expect(argv[1]).toContain(`--resume ${session}`);
  expect(argv[1]).toContain("back to three cards");
  expect(argv[2]).toContain(`--resume ${session}`);
  expect(argv[2]).toContain("and make them blue");
  expect((await db.enrichment("r")).feat!.sessionId).toBe(session);
  expect(await db.queuedMessages("r", "feat")).toEqual([]);
});

test("a queued message whose launch fails goes back on the queue, and the next send goes after it", async () => {
  await writeFile(hold, "");
  const session = await firstRun();
  await verbs.followUp(cfg(), repoCfg(), "feat", { instruction: "back to three cards" });
  failNext = 1; // the dispatch at stop fails once
  await verbs.stopWorkstream(repoCfg(), "feat");
  // Not lost: still queued, and nothing runs.
  expect((await db.queuedMessages("r", "feat")).map((m) => m.instruction)).toEqual(["back to three cards"]);
  for (let i = 0; i < 200 && agent.isRunning(wt); i++) await new Promise((r) => setTimeout(r, 25));
  expect(agent.isRunning(wt)).toBe(false);
  // The next send on the idle worktree must not jump ahead: the older message goes first.
  await rm(hold, { force: true });
  expect((await verbs.followUp(cfg(), repoCfg(), "feat", { instruction: "and make them blue" })).status).toBe("queued");
  const turns = await settled(3);
  expect(turns.map((t) => t.instruction)).toEqual(["build the cards", "back to three cards", "and make them blue"]);
  const argv = await launches();
  expect(argv.slice(1).every((a) => a.includes(`--resume ${session}`))).toBe(true);
  expect(await db.queuedMessages("r", "feat")).toEqual([]);
});
