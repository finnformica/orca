// orca send (server/verbs.ts followUp, the path behind the orchestrator's `send` and a queued
// follow-up) must never call GitHub to decide whether to keep a branch's open PR title and body in
// sync: a worker on another box, or a CI runner, may have no GitHub token at all. It only uses the
// PR number the CALLER already knows (`input.prNumber` — the same field the board shows), and falls
// back to no instruction (web/src/workstream.ts KEEP_PR_TEXT_IN_SYNC) when none is given.
// Real git scratch repo, no `gh` on PATH at all, a fake `claude` that records its launch argv, real
// Postgres.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as git from "../server/git";
import * as verbs from "../server/verbs";
import { run } from "../server/run";
import type { OrcaConfig, RepoConfig } from "../server/config";
import { KEEP_PR_TEXT_IN_SYNC } from "../web/src/workstream";
import { makeScratchRepo } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

let state: string, shim: string, repo: string, worktrees: string, log: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};

const repoCfg = (): RepoConfig => ({ name: "r", repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"] });
const cfg = (): OrcaConfig => ({ repos: [repoCfg()], portRange: [30000, 40000], staleHours: 24 });

beforeEach(async () => {
  prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_FAKE_LOG"].map((k) => [k, process.env[k]]));
  [state, shim, worktrees, log] = await Promise.all(["state", "claude", "wt", "log"].map(async (n) => realpathSync(await mkdtemp(join(tmpdir(), `orca-prsync-${n}-`))))) as [string, string, string, string];
  repo = await makeScratchRepo();
  await run(["git", "-C", repo, "branch", "feat-with-pr"]);
  await run(["git", "-C", repo, "branch", "feat-no-pr"]);
  process.env.ORCA_STATE_DIR = state;
  process.env.ORCA_FAKE_LOG = log;
  // Only the fake claude shim on PATH — deliberately no `gh` binary at all, so any GitHub call in
  // the send path would fail loudly (ENOENT) rather than being silently papered over by a fixture.
  process.env.PATH = `${shim}:${prev.PATH}`;
  await writeFile(join(shim, "claude"), `#!/bin/sh
printf '%s' "$*" > "$ORCA_FAKE_LOG/$(date +%s%N)-$$"
printf '%s' '{"type":"result","subtype":"success","is_error":false,"result":"## Outcome\\\\nDone.","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  await chmod(join(shim, "claude"), 0o755);
  pg = await freshSchema("prsync");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});

afterEach(async () => {
  for (let i = 0; i < 200 && (await anyRunning()); i++) await new Promise((r) => setTimeout(r, 25));
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, repo, worktrees, log]) await rm(d, { recursive: true, force: true });
});

const anyRunning = async () => (await git.listWorktrees(repo, worktrees).catch(() => [])).some((w) => agent.isRunning(w.worktreePath));

/** Wait for the one launch this call expects, read its argv, then clear the log for the next call. */
async function launchedPrompt(): Promise<string> {
  for (let i = 0; i < 400 && (await readdir(log)).length < 1; i++) await new Promise((r) => setTimeout(r, 25));
  const files = await readdir(log);
  expect(files.length).toBe(1);
  const prompt = await readFile(join(log, files[0]!), "utf8");
  await rm(log, { recursive: true, force: true });
  await mkdir(log);
  return prompt;
}

test("orca send never calls GitHub: KEEP_PR_TEXT_IN_SYNC only when the caller already knows the PR", async () => {
  expect((await verbs.followUp(cfg(), repoCfg(), "feat-with-pr", { instruction: "Also handle the empty case", prNumber: 9 })).status).toBe("running");
  expect(await launchedPrompt()).toContain(KEEP_PR_TEXT_IN_SYNC);

  expect((await verbs.followUp(cfg(), repoCfg(), "feat-no-pr", { instruction: "Also handle the empty case" })).status).toBe("running");
  expect(await launchedPrompt()).not.toContain(KEEP_PR_TEXT_IN_SYNC);
});
