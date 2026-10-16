// Cleaning up after finished work (verbs.cleanupRepo, verbs.sweep, `orca archive` / `orca sweep`).
// Auto-archive: a merged PR's worktree is reaped and its card archived once the grace period is
// over; a closed PR's worktree goes but its branch stays; a worktree holding uncommitted or unpushed
// work is FLAGGED, never removed. `orca archive` on one instance removes a worktree living on the
// other by asking that instance. The sweep reports first and removes only with confirm.
// Real git (a bare "origin" + a clone), real Postgres, `gh` via the PATH shim, a stubbed `fetch`
// standing in for the other instance (the DOM preload's Response is not one Bun.serve accepts).
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as git from "../server/git";
import * as verbs from "../server/verbs";
import * as orchestrator from "../server/orchestrator";
import { run } from "../server/run";
import type { OrcaConfig, RepoConfig } from "../server/config";
import { CLEANUP_GRACE_MS, cleanupDecision, sweepText } from "../web/src/workstream";
import { installFakeGh, recordGhArgs, restorePath, setDonePrListFixture, setPrListFixture, setRefsFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

let dir: string, origin: string, here: string;
let pg: TestDb;
let repo: RepoConfig;
let prev: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
const NOW = Date.parse("2026-10-13T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(installFakeGh);
afterAll(restorePath);
beforeEach(async () => {
  prev = {
    ORCA_STATE_DIR: process.env.ORCA_STATE_DIR, ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE,
    ORCA_PRLIST_FIXTURE: process.env.ORCA_PRLIST_FIXTURE, ORCA_PRLIST_DONE_FIXTURE: process.env.ORCA_PRLIST_DONE_FIXTURE,
    ORCA_GH_REFS_FIXTURE: process.env.ORCA_GH_REFS_FIXTURE, ORCA_GH_ARGS_LOG: process.env.ORCA_GH_ARGS_LOG,
  };
  dir = realpathSync(await mkdtemp(join(tmpdir(), "orca-cleanup-")));
  process.env.ORCA_STATE_DIR = join(dir, "state");
  process.env.ORCA_INSTANCE = "local";
  pg = await freshSchema("cleanup"); process.env.ORCA_DATABASE_URL = pg.url; await db.close();
  origin = join(dir, "origin.git");
  await run(["git", "init", "--bare", "-q", "-b", "main", origin]);
  here = join(dir, "here");
  await run(["git", "clone", "-q", origin, here]);
  await run(["git", "-C", here, "config", "user.email", "t@orca.dev"]); await run(["git", "-C", here, "config", "user.name", "T"]);
  await writeFile(join(here, "README.md"), "# app\n");
  await run(["git", "-C", here, "add", "."]); await run(["git", "-C", here, "commit", "-q", "-m", "init"]); await run(["git", "-C", here, "push", "-q", "origin", "main"]);
  repo = { name: "r", repoPath: here, worktreeRoot: join(here, ".wt"), baseBranch: "main", previewServices: [], providers: ["claude"] };
  await setPrListFixture([]); // no open PRs
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await db.close(); await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(dir, { recursive: true, force: true });
});

/** A worktree with one commit of its own, pushed to origin unless `push: false`. Returns its head. */
async function workOn(branch: string, opts: { push?: boolean } = {}): Promise<{ worktreePath: string; sha: string }> {
  const wt = await git.createWorktree(repo.repoPath, repo.worktreeRoot, branch, "main");
  await writeFile(join(wt.worktreePath, `${branch}.txt`), `${branch}\n`);
  await run(["git", "-C", wt.worktreePath, "add", "."]); await run(["git", "-C", wt.worktreePath, "commit", "-q", "-m", `work on ${branch}`]);
  if (opts.push !== false) await run(["git", "-C", wt.worktreePath, "push", "-q", "origin", branch]);
  return { worktreePath: wt.worktreePath, sha: (await run(["git", "-C", wt.worktreePath, "rev-parse", "HEAD"])).trim() };
}
const branchExists = (b: string) => run(["git", "-C", here, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).then(() => true, () => false);
const worktrees = async () => (await git.listWorktrees(repo.repoPath, repo.worktreeRoot)).map((w) => w.branch).sort();

test("cleanupDecision: running and the grace period wait; uncommitted or unpushed work is flagged; else reap", () => {
  const clean = { now: NOW, running: false, dirty: [], unpushed: 0 };
  expect(cleanupDecision({ ...clean, doneAt: NOW - 60_000 })).toMatchObject({ action: "wait", why: "grace period (9 min left)" });
  expect(cleanupDecision({ ...clean, doneAt: NOW - CLEANUP_GRACE_MS })).toEqual({ action: "reap" });
  expect(cleanupDecision({ ...clean })).toEqual({ action: "reap" }); // unknown merge time: past the grace
  expect(cleanupDecision({ ...clean, running: true }).action).toBe("wait"); // even when every check passes
  expect(cleanupDecision({ ...clean, dirty: ["a.ts", "b.ts"], unpushed: 1 })).toEqual({ action: "flag", why: "2 uncommitted changes (a.ts, b.ts); 1 unpushed commit" });
});

test("C1: a merged PR's worktree is reaped and its card archived after the grace period; a closed one keeps its branch", async () => {
  const merged = await workOn("merged-x");
  const closed = await workOn("closed-y");
  await workOn("local-z"); // no PR: never touched
  await db.patchEnrichment("r", "merged-x", { title: "Merged work" });
  await db.patchEnrichment("r", "merged-x", { previewInstance: { instance: "local", key: merged.worktreePath, startedAt: iso(NOW) } });
  await setDonePrListFixture([
    { number: 1, title: "Merged work", url: "u1", headRefName: "merged-x", headRefOid: merged.sha, mergedAt: iso(NOW - 60_000), closedAt: iso(NOW - 60_000) },
    { number: 2, title: "Closed work", url: "u2", headRefName: "closed-y", headRefOid: closed.sha, mergedAt: null, closedAt: iso(NOW - 3_600_000) },
  ]);

  // Within the grace period the merged one waits; the closed one (an hour ago) goes now.
  const first = await verbs.cleanupRepo(repo, { now: NOW });
  expect(first.map((c) => `${c.branch}:${c.action}`).sort()).toEqual(["closed-y:reaped", "merged-x:waiting"]);
  expect(await worktrees()).toEqual(["local-z", "merged-x"]);
  expect(await branchExists("closed-y")).toBe(true); // closed unmerged: its branch is kept

  const later = await verbs.cleanupRepo(repo, { now: NOW + CLEANUP_GRACE_MS });
  expect(later.map((c) => `${c.branch}:${c.action}`)).toEqual(["merged-x:reaped"]);
  expect(existsSync(merged.worktreePath)).toBe(false);
  expect(await worktrees()).toEqual(["local-z"]);
  expect(await branchExists("merged-x")).toBe(false); // merged: the branch goes too
  expect(await db.enrichment("r")).not.toHaveProperty("merged-x"); // archived…
  expect([...(await db.archivedBranches("r"))].sort()).toEqual(["merged-x"]); // …not deleted
});

test("C1d: reaping a merged PR's worktree deletes its hosted screenshots (pr-assets/<pr>-…), and no other PR's", async () => {
  const merged = await workOn("shots-m");
  await setDonePrListFixture([{ number: 7, title: "With shots", url: "u7", headRefName: "shots-m", headRefOid: merged.sha, mergedAt: iso(NOW - CLEANUP_GRACE_MS), closedAt: iso(NOW - CLEANUP_GRACE_MS) }]);
  await setRefsFixture(["refs/heads/pr-assets/7-shots-m", "refs/heads/pr-assets/70-other"]); // a prefix match is not PR 7's
  const args = await recordGhArgs();
  expect((await verbs.cleanupRepo(repo, { now: NOW })).map((c) => `${c.branch}:${c.action}`)).toEqual(["shots-m:reaped"]);
  const log = await args();
  expect(log).toContain("api -X GET repos/{owner}/{repo}/git/matching-refs/heads/pr-assets/7");
  expect(log.split("\n").filter((l) => l.startsWith("api -X DELETE"))).toEqual(["api -X DELETE repos/{owner}/{repo}/git/refs/heads/pr-assets/7-shots-m"]);
});

test("C1b: a branch preview's read-only bridge never reaps a worktree", async () => {
  const merged = await workOn("merged-pb");
  await setDonePrListFixture([
    { number: 9, title: "Merged", url: "u9", headRefName: "merged-pb", headRefOid: merged.sha, mergedAt: iso(NOW - 3_600_000), closedAt: iso(NOW - 3_600_000) },
  ]);
  process.env.ORCA_PREVIEW_BRIDGE = "1";
  try {
    expect(await verbs.cleanupRepo(repo, { now: NOW })).toEqual([]);
    expect((await verbs.sweep({ repos: [repo] } as never, { confirm: true, now: NOW })).confirmed).toBe(false);
  } finally {
    delete process.env.ORCA_PREVIEW_BRIDGE;
  }
  expect(existsSync(merged.worktreePath)).toBe(true);
  expect((await verbs.cleanupRepo(repo, { now: NOW })).map((c) => c.branch)).toEqual(["merged-pb"]); // the real bridge acts on it
});

test("C1c: a branch reused after its PR merged (HEAD moved off the PR's head, or a message queued) is never reaped — by the tick or the sweep", async () => {
  const moved = await workOn("reused-m"); // the merged PR's head…
  await writeFile(join(moved.worktreePath, "again.txt"), "new work\n"); // …then new work on the reused branch
  await run(["git", "-C", moved.worktreePath, "add", "."]); await run(["git", "-C", moved.worktreePath, "commit", "-q", "-m", "new work"]);
  await run(["git", "-C", moved.worktreePath, "push", "-q", "origin", "reused-m"]);
  const queued = await workOn("reused-q"); // HEAD still the PR's head, but a message is waiting for it
  await db.queueMessage({ repo: "r", branch: "reused-q", worktreePath: queued.worktreePath, instruction: "start again", attachments: [] });
  const stale = await workOn("stale-s"); // the control: nothing since the merge
  await db.patchEnrichment("r", "stale-s", { title: "Stale" });
  await setDonePrListFixture([
    { number: 1, title: "Old", url: "u1", headRefName: "reused-m", headRefOid: moved.sha, mergedAt: iso(NOW - 3_600_000), closedAt: iso(NOW - 3_600_000) },
    { number: 2, title: "Old", url: "u2", headRefName: "reused-q", headRefOid: queued.sha, mergedAt: iso(NOW - 3_600_000), closedAt: iso(NOW - 3_600_000) },
    { number: 3, title: "Old", url: "u3", headRefName: "stale-s", headRefOid: stale.sha, mergedAt: iso(NOW - 3_600_000), closedAt: iso(NOW - 3_600_000) },
  ]);
  const cfg: OrcaConfig = { repos: [repo], portRange: [30000, 40000], staleHours: 24 };
  const dry = await verbs.sweep(cfg, { now: NOW });
  expect(dry.worktrees.map((w) => w.branch)).toEqual(["stale-s"]);
  expect(dry.branches.map((b) => b.branch)).toEqual([]);

  const out = await verbs.cleanupRepo(repo, { now: NOW });
  expect(out.map((c) => `${c.branch}:${c.action}`)).toEqual(["stale-s:reaped"]);
  expect(await worktrees()).toEqual(["reused-m", "reused-q"]);
  expect(await branchExists("reused-m")).toBe(true);
  expect(await branchExists("reused-q")).toBe(true);
  expect([...(await db.archivedBranches("r"))]).toEqual(["stale-s"]);
});

test("C1f: a worktree whose HEAD is BEHIND the merged PR's last head (a later commit pushed from elsewhere, never fetched here) is reaped, not kept as reused", async () => {
  const behind = await workOn("formula-behind"); // the worktree's HEAD — what it knows of the branch
  // Simulate the PR's last push landing on another machine: a separate clone (sharing no .git with
  // `here` or its worktrees) commits on top and pushes, so the new commit object never reaches here.
  const elsewhere = join(dir, "elsewhere");
  await run(["git", "clone", "-q", origin, elsewhere]);
  await run(["git", "-C", elsewhere, "checkout", "-q", "formula-behind"]);
  await run(["git", "-C", elsewhere, "config", "user.email", "t@orca.dev"]); await run(["git", "-C", elsewhere, "config", "user.name", "T"]);
  await writeFile(join(elsewhere, "late.txt"), "pushed from elsewhere\n");
  await run(["git", "-C", elsewhere, "add", "."]); await run(["git", "-C", elsewhere, "commit", "-q", "-m", "late push"]);
  await run(["git", "-C", elsewhere, "push", "-q", "origin", "formula-behind"]);
  const prHead = (await run(["git", "-C", elsewhere, "rev-parse", "HEAD"])).trim();
  expect(prHead).not.toBe(behind.sha); // the worktree's HEAD is not the PR's last head…
  await expect(run(["git", "-C", here, "cat-file", "-e", prHead])).rejects.toThrow(); // …and never fetched it

  await setDonePrListFixture([
    { number: 42, title: "Formula AI staging", url: "u42", headRefName: "formula-behind", headRefOid: prHead, mergedAt: iso(NOW - CLEANUP_GRACE_MS), closedAt: iso(NOW - CLEANUP_GRACE_MS) },
  ]);
  // The tick is first, so its own fetch-then-retry (git.isAncestor) is what proves the object —
  // nothing earlier in the test has fetched the PR's head into `here`.
  const out = await verbs.cleanupRepo(repo, { now: NOW });
  expect(out.map((c) => `${c.branch}:${c.action}`)).toEqual(["formula-behind:reaped"]);
  expect(await worktrees()).toEqual([]);
  expect(await branchExists("formula-behind")).toBe(false);
});

test("C1g: `orca sweep`'s dry run also reads a behind worktree as done, not reused (own fetch-then-retry)", async () => {
  const behind = await workOn("formula-behind2");
  const elsewhere = join(dir, "elsewhere2");
  await run(["git", "clone", "-q", origin, elsewhere]);
  await run(["git", "-C", elsewhere, "checkout", "-q", "formula-behind2"]);
  await run(["git", "-C", elsewhere, "config", "user.email", "t@orca.dev"]); await run(["git", "-C", elsewhere, "config", "user.name", "T"]);
  await writeFile(join(elsewhere, "late.txt"), "pushed from elsewhere\n");
  await run(["git", "-C", elsewhere, "add", "."]); await run(["git", "-C", elsewhere, "commit", "-q", "-m", "late push"]);
  await run(["git", "-C", elsewhere, "push", "-q", "origin", "formula-behind2"]);
  const prHead = (await run(["git", "-C", elsewhere, "rev-parse", "HEAD"])).trim();
  expect(prHead).not.toBe(behind.sha);
  await expect(run(["git", "-C", here, "cat-file", "-e", prHead])).rejects.toThrow(); // never fetched here

  await setDonePrListFixture([
    { number: 43, title: "Formula AI staging 2", url: "u43", headRefName: "formula-behind2", headRefOid: prHead, mergedAt: iso(NOW - CLEANUP_GRACE_MS), closedAt: iso(NOW - CLEANUP_GRACE_MS) },
  ]);
  const cfg: OrcaConfig = { repos: [repo], portRange: [30000, 40000], staleHours: 24 };
  const dry = await verbs.sweep(cfg, { now: NOW });
  expect(dry.worktrees.map((w) => `${w.branch}:${w.action}`)).toEqual(["formula-behind2:remove"]);
  expect(existsSync(behind.worktreePath)).toBe(true); // a dry run touched nothing
});

test("C2: a merged worktree with uncommitted or unpushed work is flagged, not removed; a squash-merged one whose remote branch is gone is reaped", async () => {
  const dirty = await workOn("dirty-a");
  await writeFile(join(dirty.worktreePath, "notes.md"), "not committed\n");
  const ahead = await workOn("unpushed-b");
  await writeFile(join(ahead.worktreePath, "more.txt"), "more\n");
  await run(["git", "-C", ahead.worktreePath, "add", "."]); await run(["git", "-C", ahead.worktreePath, "commit", "-q", "-m", "after the merge"]);
  // GitHub deleted the merged branch: its commits are on no remote ref any more, only in the PR's head.
  const squashed = await workOn("squash-c");
  await run(["git", "-C", here, "push", "-q", "origin", "--delete", "squash-c"]);
  const long = iso(NOW - 3_600_000);
  await setDonePrListFixture([
    { number: 3, title: "a", url: "u", headRefName: "dirty-a", headRefOid: dirty.sha, mergedAt: long },
    // No head known for this one: with it, a commit past the PR's head reads as a reused branch (C1c).
    { number: 4, title: "b", url: "u", headRefName: "unpushed-b", mergedAt: long },
    { number: 5, title: "c", url: "u", headRefName: "squash-c", headRefOid: squashed.sha, mergedAt: long },
  ]);

  const out = await verbs.cleanupRepo(repo, { now: NOW });
  const by = Object.fromEntries(out.map((c) => [c.branch, c]));
  expect(by["dirty-a"]).toMatchObject({ action: "flagged", why: "1 uncommitted change (notes.md)" });
  expect(by["unpushed-b"]).toMatchObject({ action: "flagged", why: "1 unpushed commit" });
  expect(by["squash-c"]!.action).toBe("reaped");
  expect(await worktrees()).toEqual(["dirty-a", "unpushed-b"]); // nothing lost
  expect(existsSync(join(dirty.worktreePath, "notes.md"))).toBe(true);
  expect(await branchExists("unpushed-b")).toBe(true);
  // The flag is on the card (and written once — a second pass with the same reason changes nothing).
  const e = await db.enrichment("r");
  expect(e["dirty-a"]!.cleanupBlocked).toMatchObject({ why: "1 uncommitted change (notes.md)" });
  expect(e["unpushed-b"]!.cleanupBlocked).toMatchObject({ why: "1 unpushed commit" });
  const at = (e["dirty-a"]!.cleanupBlocked as { at: string }).at;
  await verbs.cleanupRepo(repo, { now: NOW + 1 });
  expect(((await db.enrichment("r"))["dirty-a"]!.cleanupBlocked as { at: string }).at).toBe(at);

  // The change discarded: the next pass reaps it and the flag goes with the card. (Committing it
  // would move HEAD off the PR's head — a reused branch, kept: C1c.)
  await rm(join(dirty.worktreePath, "notes.md"));
  expect((await verbs.cleanupRepo(repo, { now: NOW + 2 })).find((c) => c.branch === "dirty-a")!.action).toBe("reaped");
  expect(await worktrees()).toEqual(["unpushed-b"]);
});

test("C3: `orca archive` and `orca sweep` on the cloud reach a worktree on the laptop by asking the laptop", async () => {
  process.env.ORCA_INSTANCE = "cloud"; // the orchestrator's instance
  const sql = await db.open();
  await sql`INSERT INTO worktree_inventory (user_id, instance, repo, branch, data, seen_at) VALUES (${db.currentUser()}, 'local', 'r', 'feat', ${{ worktreePath: "/laptop/wt/feat" }}, ${Date.now()})`;
  await db.patchEnrichment("r", "feat", { orchestrated: true });
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), body });
    const answer = String(url).endsWith("/api/cleanup/sweep")
      ? { reports: [{ instance: "local", confirmed: body.confirm, worktrees: [{ repo: "r", branch: "old", worktreePath: "/laptop/wt/old", reason: "merged", action: "remove" }], previews: [], branches: [] }] }
      : { ok: true, instance: "local" };
    return { ok: true, status: 200, json: async () => answer } as unknown as Response;
  }) as typeof fetch;
  const cfg: OrcaConfig = { repos: [repo], portRange: [30000, 40000], staleHours: 24, instances: { local: "http://laptop.test", cloud: "http://cloud.test" } };

  const said = await orchestrator.tool(cfg, "archive", { repo: "r", branch: "feat" });
  expect(said).toContain("Archived r/feat");
  expect(calls).toEqual([{ url: "http://laptop.test/api/workstreams/archive", body: { repo: "r", branch: "feat" } }]);

  // The sweep fans out the same way, with `local` so the laptop doesn't fan out again; dry run by default.
  calls.length = 0;
  const report = await orchestrator.tool(cfg, "sweep", {});
  expect(calls).toEqual([{ url: "http://laptop.test/api/cleanup/sweep", body: { confirm: false, local: true } }]);
  expect(report).toContain("Sweep dry run");
  expect(report).toContain("## local\nWorktrees:\n  would remove  r/old (merged) /laptop/wt/old");
});

test("C4: the sweep lists finished worktrees, stale branches and keeps unsafe ones — and changes nothing until confirmed", async () => {
  const arch = await workOn("arch-w"); // archived card, worktree left behind, everything pushed
  await db.patchEnrichment("r", "arch-w", { title: "Archived" });
  await db.archive("r", "arch-w");
  await run(["git", "-C", here, "branch", "old-z", "origin/main"]); // a known branch with no worktree, nothing of its own
  await db.patchEnrichment("r", "old-z", { title: "Old" });
  const wip = await workOn("wip-q", { push: false }); // known, never pushed: its commit exists only here
  await git.removeWorktree(repo.repoPath, wip.worktreePath);
  await db.patchEnrichment("r", "wip-q", { title: "WIP" });
  await run(["git", "-C", here, "branch", "someone-elses", "origin/main"]); // not Orca's: never listed
  await setDonePrListFixture([]);
  const cfg: OrcaConfig = { repos: [repo], portRange: [30000, 40000], staleHours: 24 };

  const dry = await verbs.sweep(cfg);
  expect(dry.worktrees).toEqual([{ repo: "r", branch: "arch-w", worktreePath: arch.worktreePath, reason: "archived", action: "remove", why: undefined }]);
  expect(dry.branches.map((b) => `${b.branch}:${b.action}`).sort()).toEqual(["arch-w:remove", "old-z:remove", "wip-q:keep"]);
  expect(dry.branches.find((b) => b.branch === "wip-q")!.why).toBe("no open PR, but 1 commit exists only on it");
  expect(sweepText([dry])).toContain("would remove  r/arch-w (archived)");
  expect(existsSync(arch.worktreePath)).toBe(true); // a dry run touched nothing
  expect(await branchExists("old-z")).toBe(true);

  const applied = await verbs.sweep(cfg, { confirm: true });
  expect(applied.worktrees[0]!.done).toBe(true);
  expect(applied.branches.filter((b) => b.done).map((b) => b.branch).sort()).toEqual(["arch-w", "old-z"]);
  expect(existsSync(arch.worktreePath)).toBe(false);
  for (const b of ["arch-w", "old-z"]) expect(await branchExists(b)).toBe(false);
  for (const b of ["wip-q", "someone-elses", "main"]) expect(await branchExists(b)).toBe(true);
  expect(sweepText([applied])).toContain("removed  r/arch-w");
});
