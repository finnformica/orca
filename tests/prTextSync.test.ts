// orca send (server/verbs.ts followUp, the path behind the orchestrator's `send` and the board's
// typed follow-up) tells the agent to keep a branch's open PR title and body in sync with the code
// — one shared instruction (web/src/workstream.ts KEEP_PR_TEXT_IN_SYNC), only when the branch
// already has an open PR. The PR is looked up the same way verbs.addressPr finds its own.
// Real git scratch repo, the fake `gh`, a fake `claude` that records its launch argv, real Postgres.
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
import { installFakeGh, makeScratchRepo, restorePath, setPrListFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

let state: string, shim: string, repo: string, worktrees: string, log: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};

const repoCfg = (): RepoConfig => ({ name: "r", repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"] });
const cfg = (): OrcaConfig => ({ repos: [repoCfg()], portRange: [30000, 40000], staleHours: 24 });
const GH_FIXTURES = ["ORCA_GH_FIXTURE", "ORCA_GH_REPO_FIXTURE", "ORCA_GH_GRAPHQL_FIXTURE", "ORCA_GH_RUN_LOG_FIXTURE", "ORCA_PRLIST_FIXTURE"];

beforeEach(async () => {
  prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_FAKE_LOG", ...GH_FIXTURES].map((k) => [k, process.env[k]]));
  for (const k of GH_FIXTURES) delete process.env[k]; // another file's fixture must not leak in
  [state, shim, worktrees, log] = await Promise.all(["state", "claude", "wt", "log"].map(async (n) => realpathSync(await mkdtemp(join(tmpdir(), `orca-prsync-${n}-`))))) as [string, string, string, string];
  repo = await makeScratchRepo();
  await run(["git", "-C", repo, "branch", "feat-with-pr"]);
  await run(["git", "-C", repo, "branch", "feat-no-pr"]);
  process.env.ORCA_STATE_DIR = state;
  process.env.ORCA_FAKE_LOG = log;
  process.env.PATH = `${shim}:${prev.PATH}`;
  await installFakeGh();
  // A fake claude: records its argv (one file per launch), answers at once.
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
  restorePath();
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

test("orca send carries KEEP_PR_TEXT_IN_SYNC only for a branch that already has an open PR", async () => {
  await setPrListFixture([{ number: 9, title: "Feat", headRefName: "feat-with-pr", url: "u", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [] }]);
  expect((await verbs.followUp(cfg(), repoCfg(), "feat-with-pr", { instruction: "Also handle the empty case" })).status).toBe("running");
  expect(await launchedPrompt()).toContain(KEEP_PR_TEXT_IN_SYNC);

  await setPrListFixture([]); // feat-no-pr has no open PR
  expect((await verbs.followUp(cfg(), repoCfg(), "feat-no-pr", { instruction: "Also handle the empty case" })).status).toBe("running");
  expect(await launchedPrompt()).not.toContain(KEEP_PR_TEXT_IN_SYNC);
});
