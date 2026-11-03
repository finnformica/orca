// GitHub rate-limit resilience (Finn 2026-11-02: the GraphQL budget ran out twice; the board showed
// open PRs as "no PR" / local, and `orca archive` failed). A real bridge answers /api/prs and
// /api/github/limits against the fake GitHub; in-process calls cover the shared read, the separate
// GraphQL / REST blocks, the persisted last known state and the local verbs with GitHub down.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as gh from "../server/gh";
import * as github from "../server/github";
import * as verbs from "../server/verbs";
import * as orchestrator from "../server/orchestrator";
import { freePort } from "../server/preview";
import { lastPrDue, lastPrOf, prMemory, prsFromEnrichment } from "../server/prMemory";
import { runCmd } from "../server/run";
import type { OrcaConfig } from "../server/config";
import { githubLimits, limitBanner } from "../shared/githubLimits";
import { boardText } from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, recordGhArgs, setPrFixture, setPrListFixture } from "./helpers";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const fetch = native.fetch; // happy-dom's preloaded fetch CORS-blocks a real port
const ROOT = join(import.meta.dir, "..");
const MIN = 60_000;

let pg: TestDb, repo: string, worktrees: string, state: string, base: string;
let bridge: Bun.Subprocess | undefined;

const cfg = (): OrcaConfig => ({
  repos: [{ name: "r", repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"] }],
  portRange: [30000, 40000], staleHours: 24,
});
const OPEN_PR = {
  number: 7, title: "Seven", headRefName: "feat", headRefOid: "aaa111", baseRefName: "main", url: "https://github.com/acme/app/pull/7",
  state: "OPEN", isDraft: false, mergeable: "CONFLICTING", reviewDecision: "CHANGES_REQUESTED", author: { login: "active" },
  statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }],
};
const resetIn = (ms: number) => String(Math.floor((Date.now() + ms) / 1000));
const unlimit = () => { delete process.env.ORCA_GH_GRAPHQL_LIMITED; delete process.env.ORCA_GH_CORE_LIMITED; delete process.env.ORCA_GH_GRAPHQL_RATE_ERROR; };

beforeAll(async () => {
  repo = await makeScratchRepo();
  worktrees = await mkdtemp(join(tmpdir(), "orca-rl-wt-"));
  state = await mkdtemp(join(tmpdir(), "orca-rl-state-"));
  await installFakeGh();
  await setPrListFixture([OPEN_PR]);
  await setPrFixture({ state: "OPEN", mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [] });
  pg = await freshSchema("ratelimit");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  await db.saveConfig({
    repos: [{ name: "r", config: { repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"] } }],
    app: { portRange: [30000, 40000], staleHours: 24 },
  });
  await db.close();
  const port = await freePort([20_000, 60_000]);
  const env = { ...process.env, ORCA_STATE_DIR: state, ORCA_DATABASE_URL: pg.url, ORCA_API_PORT: String(port), ORCA_BIND: "127.0.0.1", ORCA_INSTANCE: "here", ORCA_ALLOW_WORKTREE_MIGRATIONS: "1", ORCA_PRIMARY: "1" } as Record<string, string>;
  delete env.NODE_ENV;
  for (const k of ["ORCA_PREVIEW_HOST", "ORCA_PREVIEW_BIND", "SLACK_TOKEN"]) delete env[k];
  bridge = Bun.spawn(["bun", "run", join(ROOT, "server", "index.ts")], { cwd: ROOT, env, stdout: "ignore", stderr: "inherit" });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("bridge never came up");
}, 60_000);

afterAll(async () => {
  unlimit();
  bridge?.kill();
  await db.close();
  await pg.drop();
  for (const d of [repo, worktrees, state]) await rm(d, { recursive: true, force: true });
});

beforeEach(() => { process.env.ORCA_DATABASE_URL = pg.url; github.resetCaches(); gh.resetPrCaches(); gh.setPrMemory(undefined); });
afterEach(unlimit);

const prs = async () => await (await fetch(`${base}/api/prs?repo=r`)).json() as gh.PrSummary[];
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) { const v = await read(); if (ok(v)) return v; await Bun.sleep(50); }
  return read();
}

test("RL1: a rate-limited board shows the last known PR state, marked stale — never 'no PR'", async () => {
  const fresh = await prs();
  expect(fresh).toHaveLength(1);
  expect(fresh[0]).toMatchObject({ number: 7, ciStatus: "failing", mergeable: "CONFLICTING" });
  expect(fresh[0]!.staleAt).toBeUndefined();
  // The read persists on the workstream's enrichment (server/prMemory.ts), for a restart.
  const stored = await until(() => db.enrichment("r"), (e) => Boolean(e.feat?.lastPr));
  expect(stored.feat?.lastPr).toMatchObject({ number: 7, ciStatus: "failing", state: "OPEN" });

  // GraphQL spent, REST not: which PRs are open comes from REST; CI / review / conflicts stay known.
  const reset = resetIn(30 * MIN);
  process.env.ORCA_GH_GRAPHQL_LIMITED = reset;
  const stale = await prs();
  expect(stale).toHaveLength(1);
  expect(stale[0]).toMatchObject({ number: 7, branch: "feat", ciStatus: "failing", mergeable: "CONFLICTING", reviewStatus: "changes_requested", staleReason: "GitHub rate limited" });
  expect(typeof stale[0]!.staleAt).toBe("number");

  // The banner's data: the GraphQL budget, until GitHub's reset.
  const limits = await (await fetch(`${base}/api/github/limits`)).json() as ReturnType<typeof githubLimits>;
  expect(limits.limited).toEqual([{ resource: "graphql", until: Number(reset) * 1000 }]);
});

test("RL2: after a restart (nothing in memory) and with REST spent too, the stored state is the answer", async () => {
  await db.patchEnrichment("r", "feat", { lastPr: lastPrOf({ number: 7, title: "Seven", branch: "feat", url: "u", state: "OPEN", isDraft: false, autoMergeEnabled: false, ciStatus: "passing", reviewStatus: "approved", mergeable: "MERGEABLE", externalFeedback: 0, additions: 1, deletions: 2 }, Date.now() - 5 * MIN) });
  gh.setPrMemory(prMemory(async (cwd) => (cwd === repo ? "r" : undefined)));
  process.env.ORCA_GH_GRAPHQL_LIMITED = resetIn(30 * MIN);
  process.env.ORCA_GH_CORE_LIMITED = resetIn(30 * MIN);
  const list = await gh.listPrs(repo);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ number: 7, branch: "feat", ciStatus: "passing", reviewStatus: "approved" });
  expect(list[0]!.staleAt).toBeLessThan(Date.now() - 4 * MIN); // its age is the age of the read

  // `orca board` says the PR is there, and that its state is stale.
  const text = boardText(await orchestrator.board(cfg()));
  expect(text).toContain("r/feat");
  expect(text).toContain("PR #7");
  expect(text).toContain("stale");
  expect(text).not.toContain("no PR");
});

test("RL3: a spent GraphQL budget does not block REST", async () => {
  process.env.ORCA_GH_GRAPHQL_LIMITED = resetIn(30 * MIN);
  await expect(gh.prStatus(repo, 7)).rejects.toBeInstanceOf(github.GitHubRateLimitError);
  const token = await github.tokenFor(repo);
  expect(github.rateLimitedFor(token, Date.now(), "graphql")).toBeGreaterThan(25 * MIN);
  expect(github.rateLimitedFor(token, Date.now(), "core")).toBe(0);
  expect(await gh.prDiff(repo, 7)).toContain("diff --git"); // a REST call still goes
  expect(github.rateLimitState().blocks.map((b) => b.resource)).toEqual(["graphql"]);
});

test("RL3b: a GraphQL rate-limit error (no reset in it) is checked against GET /rate_limit", async () => {
  const token = await github.tokenFor(repo);
  // GitHub says the budget is spent until its reset: the block runs to that reset, not one minute.
  const reset = resetIn(40 * MIN);
  process.env.ORCA_GH_GRAPHQL_RATE_ERROR = "1";
  process.env.ORCA_GH_GRAPHQL_LIMITED = reset;
  await expect(gh.prStatus(repo, 7)).rejects.toBeInstanceOf(github.GitHubRateLimitError);
  await until(async () => github.rateLimitedFor(token, Date.now(), "graphql"), (ms) => ms > 30 * MIN);
  expect(github.rateLimitState().blocks.find((b) => b.resource === "graphql")?.until).toBe(Number(reset) * 1000);

  // GitHub says the budget has quota (the error was wrong, or the window reset): the block goes.
  github.resetCaches();
  delete process.env.ORCA_GH_GRAPHQL_LIMITED;
  await expect(gh.prStatus(repo, 7)).rejects.toBeInstanceOf(github.GitHubRateLimitError);
  await until(async () => github.rateLimitedFor(token, Date.now(), "graphql"), (ms) => ms === 0);
  expect(github.rateLimitedFor(token, Date.now(), "graphql")).toBe(0);
  delete process.env.ORCA_GH_GRAPHQL_RATE_ERROR;
  expect((await gh.prStatus(repo, 7)).state).toBe("OPEN");
});

test("RL4: one open-PR read serves every caller until it is old or a mutation drops it", async () => {
  process.env.ORCA_GH_PR_CACHE_MS = "60000";
  try {
    const log = await recordGhArgs();
    await Promise.all([gh.listPrs(repo), gh.listPrs(repo), gh.listPrs(repo, "deploy")]);
    await gh.listPrs(repo);
    const searches = () => log().then((t) => t.split("\n").filter((l) => l.startsWith("graphql search")).length);
    expect(await searches()).toBe(1);
    await gh.editTitle(repo, 7, "Renamed"); // a mutation drops the read
    await gh.listPrs(repo);
    expect(await searches()).toBe(2);
  } finally {
    process.env.ORCA_GH_PR_CACHE_MS = "0";
    delete process.env.ORCA_GH_ARGS_LOG;
  }
});

test("RL5: local verbs work with GitHub down — archive keeps the branch, hide and status need no GitHub", async () => {
  const r = cfg().repos[0]!;
  const { branch, worktreePath } = await verbs.newWorktree(r, "archive me");
  await db.patchEnrichment("r", branch, { title: "Archive me", orchestrated: true });
  process.env.ORCA_GH_GRAPHQL_LIMITED = resetIn(30 * MIN);
  process.env.ORCA_GH_CORE_LIMITED = resetIn(30 * MIN);

  expect(await orchestrator.tool(cfg(), "hide", { repo: "r", branch, for: "1d" })).toContain("hidden");
  expect(await orchestrator.tool(cfg(), "unhide", { repo: "r", branch })).toContain("shows");
  expect(await orchestrator.tool(cfg(), "status", { repo: "r", branch, plan: "wait for GitHub" })).toContain("wait for GitHub");
  expect(await orchestrator.tool(cfg(), "stop", { repo: "r", branch })).toContain("Nothing running");
  expect(await orchestrator.tool(cfg(), "archive", { repo: "r", branch })).toContain("Archived");

  expect(await Bun.file(join(worktreePath, "README.md")).exists()).toBe(false); // the worktree is reaped
  expect((await db.archivedBranches("r")).has(branch)).toBe(true);
  // GitHub could not say whether it has a PR: the branch stays (a branch with a PR is never deleted).
  expect((await runCmd(["git", "-C", repo, "branch", "--list", branch])).stdout).toContain(branch);
});

test("RL6: the stored snapshot is rewritten on a change or when old, and a closed PR's is not read back", () => {
  const pr: gh.PrSummary = { number: 1, title: "t", branch: "b", url: "u", state: "OPEN", isDraft: false, autoMergeEnabled: false, ciStatus: "pending", reviewStatus: "none", mergeable: "MERGEABLE", externalFeedback: 0, additions: 0, deletions: 0, feedback: ["long text"] };
  const a = lastPrOf(pr, 1_000);
  expect(a).not.toHaveProperty("feedback");
  expect(lastPrDue(undefined, a)).toBe(true);
  expect(lastPrDue(a, lastPrOf(pr, 2_000))).toBe(false); // same state, a moment later
  expect(lastPrDue(a, lastPrOf({ ...pr, ciStatus: "failing" }, 2_000))).toBe(true);
  expect(lastPrDue(a, lastPrOf(pr, 1_000 + 10 * MIN))).toBe(true);
  const back = prsFromEnrichment({ b: { lastPr: a }, c: { lastPr: { ...a, branch: "c", number: 2, state: "MERGED" } }, d: {} });
  expect(back).toHaveLength(1);
  expect(back[0]).toMatchObject({ number: 1, branch: "b", ciStatus: "pending", staleAt: 1_000 });
  expect(back[0]).not.toHaveProperty("at");
});

test("RL7: the banner reads 'GitHub rate limited until HH:MM' at the latest reset, and nothing once it passed", () => {
  const now = Date.UTC(2026, 10, 2, 22, 50);
  const limits = githubLimits({ blocks: [{ resource: "graphql", until: now + 12 * MIN }, { resource: "graphql", until: now + 5 * MIN }, { resource: "core", until: now - MIN }] }, now);
  expect(limits.limited).toEqual([{ resource: "graphql", until: now + 12 * MIN }]);
  const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  expect(limitBanner(limits, now, hhmm)?.title).toBe("GitHub rate limited until 23:02");
  expect(limitBanner(limits, now, hhmm)?.detail).toContain("GraphQL");
  expect(limitBanner(limits, now + 13 * MIN, hhmm)).toBeUndefined();
  expect(limitBanner({ limited: [] }, now, hhmm)).toBeUndefined();
});
