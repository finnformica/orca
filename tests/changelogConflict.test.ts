// Changelog-only conflicts are Orca's to resolve, not an agent's. The incident: branch-demo PR #6189
// needed five worker runs that each only re-merged a CHANGELOG.md hunk where both sides had added an
// entry under the same heading. Now Address PR merges the base itself first (server/git.ts
// `mergeBaseUnioningChangelogs`): when every conflict is in a changelog file it keeps both sides'
// lines, commits, pushes and starts NO agent; anything else is aborted untouched and goes to the agent.
// Real git (a bare origin), the fake `gh`, a fake `claude` that records launches, real Postgres.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as git from "../server/git";
import * as verbs from "../server/verbs";
import { run } from "../server/run";
import { changelogOnlyConflict, isChangelogPath } from "../web/src/workstream";
import type { OrcaConfig, RepoConfig } from "../server/config";
import { installFakeGh, makeScratchRepo, restorePath, setPrListFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

let state: string, shim: string, repo: string, origin: string, worktrees: string, log: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};

const repoCfg = (extra: Partial<RepoConfig> = {}): RepoConfig =>
  ({ name: "r", repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"], ...extra });
const cfg = (extra: Partial<RepoConfig> = {}): OrcaConfig => ({ repos: [repoCfg(extra)], portRange: [30000, 40000], staleHours: 24 });
const GH_FIXTURES = ["ORCA_GH_FIXTURE", "ORCA_GH_REPO_FIXTURE", "ORCA_GH_GRAPHQL_FIXTURE", "ORCA_GH_RUN_LOG_FIXTURE"];
const sh = (dir: string, ...args: string[]) => run(["git", "-C", dir, ...args]);

beforeEach(async () => {
  prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_FAKE_LOG", ...GH_FIXTURES].map((k) => [k, process.env[k]]));
  // bun runs every file in one process: a fake-gh fixture an earlier file left set would answer this
  // PR's review threads / comments with that file's, and "nothing left for an agent" would never hold.
  for (const k of GH_FIXTURES) delete process.env[k];
  [state, shim, worktrees, log, origin] = await Promise.all(["state", "claude", "wt", "log", "origin"].map(async (n) => realpathSync(await mkdtemp(join(tmpdir(), `orca-cl-${n}-`))))) as [string, string, string, string, string];
  repo = await makeScratchRepo();
  process.env.ORCA_STATE_DIR = state;
  process.env.ORCA_FAKE_LOG = log;
  process.env.PATH = `${shim}:${prev.PATH}`;
  await installFakeGh();
  await writeFile(join(shim, "claude"), `#!/bin/sh
printf '%s' "$*" > "$ORCA_FAKE_LOG/$(date +%s%N)-$$"
printf '%s' '{"type":"result","subtype":"success","is_error":false,"result":"## Outcome\\\\nDone.","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  await chmod(join(shim, "claude"), 0o755);
  pg = await freshSchema("changelog");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  await run(["git", "init", "--bare", "-b", "main", origin]);
  await sh(repo, "remote", "add", "origin", origin);
});
afterEach(async () => {
  for (let i = 0; i < 200 && (await anyRunning()); i++) await new Promise((r) => setTimeout(r, 25));
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  restorePath();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, repo, worktrees, log, origin]) await rm(d, { recursive: true, force: true });
});

const anyRunning = async () => (await git.listWorktrees(repo, worktrees).catch(() => [])).some((w) => agent.isRunning(w.worktreePath));
const launches = async () => (await readdir(log)).length;

const CHANGELOG = "# Changelog\n\n## Unreleased\n\n- Older entry\n\n## 1.0.0\n\n- First release\n";
const withEntry = (entry: string) => CHANGELOG.replace("- Older entry\n", `- ${entry}\n- Older entry\n`);

/** main and `feat` both add an entry under the same heading (and, with `code`, both change src.txt),
 *  each pushed to origin — the PR #6189 shape. */
async function divergedBranches(opts: { file?: string; code?: boolean } = {}) {
  const file = opts.file ?? "CHANGELOG.md";
  const commit = async (files: Record<string, string>, msg: string) => {
    for (const [f, body] of Object.entries(files)) {
      await run(["mkdir", "-p", join(repo, f, "..")]);
      await writeFile(join(repo, f), body);
    }
    await sh(repo, "add", "-A");
    await sh(repo, "commit", "-m", msg);
  };
  await commit({ [file]: CHANGELOG, "src.txt": "one\n" }, "changelog");
  await sh(repo, "push", "-q", "origin", "main");
  await sh(repo, "checkout", "-q", "-b", "feat");
  await commit({ [file]: withEntry("Feature entry"), ...(opts.code ? { "src.txt": "feature\n" } : {}) }, "feat");
  await sh(repo, "push", "-q", "-u", "origin", "feat");
  await sh(repo, "checkout", "-q", "main");
  await commit({ [file]: withEntry("Main entry"), ...(opts.code ? { "src.txt": "main\n" } : {}) }, "main moves on");
  await sh(repo, "push", "-q", "origin", "main");
  await setPrListFixture([{ number: 7, title: "Feat", headRefName: "feat", url: "u", state: "OPEN", isDraft: false, mergeable: "CONFLICTING", reviewDecision: "", statusCheckRollup: [] }]);
}

test("CL1: a changelog-only conflict is unioned, committed and pushed — and no agent starts", async () => {
  await divergedBranches();
  const r = await verbs.addressPr(cfg(), repoCfg(), "feat");
  expect(r).toEqual({ status: "resolved", pr: 7 });
  expect(await launches()).toBe(0);
  expect(await db.turns("r", "feat")).toEqual([]);
  // Both entries, under the one heading, ours first; no markers. On origin, so the PR sees it.
  const pushed = await sh(origin, "show", "feat:CHANGELOG.md");
  expect(pushed).toBe(CHANGELOG.replace("- Older entry\n", "- Feature entry\n- Main entry\n- Older entry\n"));
  expect(pushed).not.toContain("<<<<<<<");
  // A real merge commit of origin/main, so GitHub no longer reports a conflict.
  await sh(origin, "merge-base", "--is-ancestor", "main", "feat");
  expect(await sh(origin, "log", "-1", "--format=%B", "feat")).toContain("changelog-only conflict");
});

test("CL2: a mixed conflict (changelog + code) is left untouched and handed to the agent", async () => {
  await divergedBranches({ code: true });
  const before = (await sh(origin, "rev-parse", "feat")).trim();
  const r = await verbs.addressPr(cfg(), repoCfg(), "feat");
  expect(r.status).toBe("running");
  for (let i = 0; i < 200 && (await anyRunning()); i++) await new Promise((res) => setTimeout(res, 25));
  const argv = await readFile(join(log, (await readdir(log))[0]!), "utf8");
  expect(argv).toContain("Merge conflicts"); // the agent is asked to resolve them
  // Orca's attempt left nothing behind: no merge in progress, a clean tree, nothing pushed.
  const wt = (await git.listWorktrees(repo, worktrees)).find((w) => w.branch === "feat")!.worktreePath;
  expect((await sh(wt, "status", "--porcelain")).trim()).toBe("");
  expect(await sh(wt, "rev-parse", "-q", "--verify", "MERGE_HEAD").catch(() => "none")).toBe("none");
  expect((await sh(origin, "rev-parse", "feat")).trim()).toBe(before);
});

test("CL3: the changelog pattern is per repo — a custom path resolves only when configured", async () => {
  await divergedBranches({ file: "docs/changes.md" });
  // The default (**/CHANGELOG.md) doesn't cover it: an ordinary conflict.
  expect((await verbs.settleConflict(repoCfg(), "feat")).outcome).toBe("conflict");
  expect((await verbs.settleConflict(repoCfg({ changelogFiles: [] }), "feat")).outcome).toBe("conflict"); // `[]` turns it off
  const r = await verbs.settleConflict(repoCfg({ changelogFiles: ["docs/*.md"] }), "feat");
  expect(r).toEqual({ outcome: "resolved", files: ["docs/changes.md"] });
  expect(await sh(origin, "show", "feat:docs/changes.md")).toContain("- Feature entry\n- Main entry\n");
  expect(await launches()).toBe(0);
});

test("CL4: never while an agent is running in the worktree", async () => {
  await divergedBranches();
  const wt = await verbs.ensureWorktree(repoCfg(), "feat");
  await writeFile(join(shim, "claude"), "#!/bin/sh\nsleep 1\n");
  await agent.runAgent(wt, "busy", { provider: "claude", branch: "feat" });
  expect((await verbs.settleConflict(repoCfg(), "feat")).outcome).toBe("busy");
  expect(await sh(origin, "show", "feat:CHANGELOG.md")).toBe(withEntry("Feature entry"));
});

test("CL5: changelog paths — the default matches CHANGELOG.md at any depth, and only that", () => {
  expect(isChangelogPath("CHANGELOG.md")).toBe(true);
  expect(isChangelogPath("packages/api/CHANGELOG.md")).toBe(true);
  expect(isChangelogPath("CHANGELOG.mdx")).toBe(false);
  expect(isChangelogPath("docs/CHANGELOG.md.bak")).toBe(false);
  expect(isChangelogPath("docs/changes.md", ["docs/*.md"])).toBe(true);
  expect(isChangelogPath("docs/a/changes.md", ["docs/*.md"])).toBe(false);
  expect(changelogOnlyConflict([])).toBe(false); // a failed merge with no conflicted path isn't ours
  expect(changelogOnlyConflict(["CHANGELOG.md", "src/app.ts"])).toBe(false);
});
