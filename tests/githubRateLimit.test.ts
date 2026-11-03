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
import * as prSync from "../server/prSync";
import { prEvents, syncDue, isStale } from "../shared/prState";
import { runCmd } from "../server/run";
import type { OrcaConfig } from "../server/config";
import { githubLimits, limitBanner } from "../shared/githubLimits";
import { boardText } from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, recordGhArgs, setPrFixture, setPrListFixture, setViewFixture } from "./helpers";
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
  const env = { ...process.env, ORCA_STATE_DIR: state, ORCA_DATABASE_URL: pg.url, ORCA_API_PORT: String(port), ORCA_BIND: "127.0.0.1", ORCA_INSTANCE: "here", ORCA_ALLOW_WORKTREE_MIGRATIONS: "1", ORCA_PRIMARY: "1", ORCA_PR_SYNC_MS: "1000" } as Record<string, string>;
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

beforeEach(() => { process.env.ORCA_DATABASE_URL = pg.url; github.resetCaches(); gh.resetPrCaches(); prSync.resetPrSync(); });
afterEach(unlimit);

const prs = async () => await (await fetch(`${base}/api/prs?repo=r`)).json() as gh.PrSummary[];
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) { const v = await read(); if (ok(v)) return v; await Bun.sleep(50); }
  return read();
}

test("RL1: the board reads the PR-state table; a spent GraphQL budget only makes the row older, never 'no PR'", async () => {
  const fresh = await prs();
  expect(fresh).toHaveLength(1);
  expect(fresh[0]).toMatchObject({ number: 7, ciStatus: "failing", mergeable: "CONFLICTING" });
  expect(fresh[0]!.staleAt).toBeUndefined();
  expect(typeof fresh[0]!.syncedAt).toBe("number");
  // The answer is the table's row, which the sync job wrote.
  expect(await db.prState("r", 7)).toMatchObject({ branch: "feat", state: "OPEN", ciStatus: "failing", mergeable: "CONFLICTING", headSha: "aaa111" });

  // GraphQL spent, REST not: which PRs are open comes from REST; CI / review / conflicts and the
  // row's time stay. Past two sync intervals (2s on this bridge) the row says how old it is.
  const reset = resetIn(30 * MIN);
  process.env.ORCA_GH_GRAPHQL_LIMITED = reset;
  await Bun.sleep(2_200);
  const stale = await prs();
  expect(stale).toHaveLength(1);
  expect(stale[0]).toMatchObject({ number: 7, branch: "feat", ciStatus: "failing", mergeable: "CONFLICTING", reviewStatus: "changes_requested", syncedAt: fresh[0]!.syncedAt });
  expect(stale[0]!.staleAt).toBe(fresh[0]!.syncedAt);

  // The banner's data: the GraphQL budget, until GitHub's reset.
  const limits = await (await fetch(`${base}/api/github/limits`)).json() as ReturnType<typeof githubLimits>;
  expect(limits.limited).toEqual([{ resource: "graphql", until: Number(reset) * 1000 }]);
});

test("RL2: no reader of PR state calls GitHub; with GitHub down every reader still has the rows", async () => {
  process.env.ORCA_PR_SYNC_INLINE = "0";
  try {
    const r = cfg().repos[0]!;
    await setPrListFixture([OPEN_PR]);
    const sync = await prSync.syncRepo(r, { done: true });
    expect(sync.open).toBe(true);
    await setViewFixture({ ...OPEN_PR, files: [{ path: "a.ts", additions: 1, deletions: 0 }], changedFiles: 1 });
    await prSync.refresh(r, [7]); // a command's refresh: the merge gate's read, with the files
    const log = await recordGhArgs();
    const open = await prSync.openPrs(r);
    expect(open.map((p) => p.number)).toEqual([7]);
    await prSync.mergedPrs(r, Date.now() - 7 * 24 * 60 * MIN);
    await prSync.donePrs(r);
    expect((await prSync.mergeGate(r, 7))?.branch).toBe("feat");
    const board = boardText(await orchestrator.board(cfg()));
    expect(board).toContain("PR #7");
    expect(await log()).toBe(""); // not one GitHub request

    // GitHub down: the sync fails and records why; the readers answer from the table.
    process.env.ORCA_GH_GRAPHQL_LIMITED = resetIn(30 * MIN);
    process.env.ORCA_GH_CORE_LIMITED = resetIn(30 * MIN);
    expect((await prSync.syncRepo(r)).open).toBe(false);
    expect((await db.prSyncStatus("r")).error).toContain("rate limit");
    expect((await prSync.openPrs(r)).map((p) => p.number)).toEqual([7]);
    // An old sync is normal: `orca board` names its time and never says "no PR".
    process.env.ORCA_PR_SYNC_MS = "1";
    await Bun.sleep(5);
    const text = boardText(await orchestrator.board(cfg()));
    expect(text).toContain("PR #7");
    expect(text).toContain("last synced");
    expect(text).not.toContain("no PR");
  } finally {
    process.env.ORCA_PR_SYNC_INLINE = "1";
    delete process.env.ORCA_PR_SYNC_MS;
    delete process.env.ORCA_GH_ARGS_LOG;
  }
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
    const searches = () => log().then((t) => t.split("\n").filter((l) => l.startsWith("graphql search") && l.includes("is:open")).length);
    expect(await searches()).toBe(1);
    await gh.editTitle(repo, 7, "Renamed"); // a mutation drops the read, and the sync reads again at once
    expect(await searches()).toBe(2);
    await gh.listPrs(repo); // the sync's read serves it
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

test("RL6: events come from the diff of the old and new row; a write refreshes the row at once", async () => {
  process.env.ORCA_PR_SYNC_INLINE = "0";
  try {
    const r = cfg().repos[0]!;
    const pr = (over: Record<string, unknown>) => ({ ...OPEN_PR, number: 21, headRefName: "ev", headRefOid: "h1", mergeable: "MERGEABLE", statusCheckRollup: [{ name: "test", conclusion: "SUCCESS" }], ...over });
    await setPrListFixture([pr({})]);
    expect((await prSync.syncRepo(r)).events).toEqual([]);
    await setPrListFixture([pr({ statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }] })]);
    expect((await prSync.syncRepo(r)).events).toEqual([{ number: 21, event: "ci_failed" }]);
    expect((await prSync.syncRepo(r)).events).toEqual([]); // the same red head: once
    expect((await db.notifications()).some((n) => n.kind === "pr_ci_failed" && n.link?.pr === 21)).toBe(true);

    // It leaves the open list: REST says it merged, and the merge is the event a pr: wake waits on.
    await setPrListFixture([]);
    await setViewFixture({ state: "MERGED", headRefName: "ev", headRefOid: "h1", title: "Seven", mergedAt: new Date().toISOString() });
    expect((await prSync.syncRepo(r)).events).toContainEqual({ number: 21, event: "merged" });
    expect(await db.prState("r", 21)).toMatchObject({ state: "MERGED" });
    expect((await db.notifications()).some((n) => n.kind === "merged" && n.link?.pr === 21)).toBe(true);

    // A write goes to GitHub, and the sync reads the repo again at once.
    await setPrListFixture([pr({ number: 22, headRefName: "renamed", title: "New title" })]);
    await gh.editTitle(repo, 22, "New title");
    expect(await db.prState("r", 22)).toMatchObject({ title: "New title", state: "OPEN" });
  } finally {
    process.env.ORCA_PR_SYNC_INLINE = "1";
  }
});

test("RL6b: the sync's pure rules — when a repo is due, when a row is stale, which changes are events", () => {
  const now = 1_000_000;
  expect(syncDue({ attemptedAt: undefined, load: "normal", now, normalMs: 60_000 })).toBe(true);
  expect(syncDue({ attemptedAt: now - 30_000, load: "normal", now, normalMs: 60_000 })).toBe(false);
  expect(syncDue({ attemptedAt: now - 30_000, load: "fast", now, normalMs: 60_000 })).toBe(true);
  expect(syncDue({ attemptedAt: now - 120_000, load: "idle", now, normalMs: 60_000 })).toBe(false);
  expect(isStale(now - 100_000, now, 60_000)).toBe(false);
  expect(isStale(now - 130_000, now, 60_000)).toBe(true);
  const open = { number: 1, state: "OPEN", ciStatus: "passing", mergeable: "MERGEABLE", headSha: "a" };
  expect(prEvents(open, { ...open, ciStatus: "failing" }, now)).toEqual(["ci_failed"]);
  expect(prEvents({ ...open, ciStatus: "failing" }, { ...open, ciStatus: "failing", headSha: "b" }, now)).toEqual(["ci_failed"]);
  expect(prEvents(open, { ...open, mergeable: "CONFLICTING" }, now)).toEqual(["conflicts"]);
  expect(prEvents(open, { ...open, state: "MERGED" }, now)).toEqual(["merged"]);
  expect(prEvents(undefined, { ...open, state: "MERGED", mergedAt: now - 2 * 24 * 60 * MIN }, now)).toEqual([]); // an old merge seen first: no news
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
