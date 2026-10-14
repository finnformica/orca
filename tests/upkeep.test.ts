// Automatic PR upkeep (server/upkeep.ts): an orchestrated workstream's open PR that conflicts with its
// base, goes red on a required check or gets actionable review threads is Address-PR'd by Orca on its
// own — through the same verbs.addressPr the button and `orca address` use. The decision is pure
// (workstream.ts `upkeepDecision`), so most of this drives it directly: each trigger, each guard, the
// per-(head, reason) dedup, the backoff and the concurrency cap. Then the tick end-to-end: real git,
// real Postgres, the fake `gh`, a fake `claude` that records its launches.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agent from "../server/agent";
import * as db from "../server/db";
import * as git from "../server/git";
import * as upkeep from "../server/upkeep";
import * as verbs from "../server/verbs";
import { run } from "../server/run";
import { parseConfigDocument, type OrcaConfig, type RepoConfig } from "../server/config";
import {
  UPKEEP_MAX_STREAK, notificationActions, unhandedActionable, upkeepDecision, upkeepLabel, upkeepReasons, waitingOnUser,
  type UpkeepInput, type UpkeepRecord,
} from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, recordGhArgs, restorePath, setPrListFixture, setRequiredChecksFixture, setReviewEvidenceFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

const NOW = 1_000_000;
const pr = (over: Partial<UpkeepInput["pr"]> = {}): UpkeepInput["pr"] => ({ state: "OPEN", isDraft: false, mergeable: "MERGEABLE", ciStatus: "passing", head: "h1", ...over });
const input = (over: Partial<UpkeepInput> = {}): UpkeepInput => ({
  pr: pr(), orchestrated: true, optedOut: false, activity: { running: false, queued: 0 }, unresolved: 0, active: 0, cap: 2, ...over,
});
const rec = (over: Partial<UpkeepRecord> = {}): UpkeepRecord => ({ sha: "h1", tried: ["ci"], reasons: ["ci"], attempts: 1, streak: 1, at: 0, ...over });

describe("upkeepDecision (pure)", () => {
  test("UK1: each trigger — conflicts, a failed required check, unhanded review threads — addresses it, and only it", () => {
    expect(upkeepDecision(input({ pr: pr({ mergeable: "CONFLICTING" }) }), NOW)).toMatchObject({ action: "address", reasons: ["conflicts"] });
    expect(upkeepDecision(input({ pr: pr({ ciStatus: "failing" }) }), NOW)).toMatchObject({ action: "address", reasons: ["ci"] });
    expect(upkeepDecision(input({ unresolved: 2 }), NOW)).toMatchObject({ action: "address", reasons: ["review"] });
    const all = upkeepDecision(input({ pr: pr({ mergeable: "CONFLICTING", ciStatus: "failing" }), unresolved: 1 }), NOW);
    expect(all).toEqual({ action: "address", reasons: ["conflicts", "ci", "review"], record: { sha: "h1", tried: ["conflicts", "ci", "review"], reasons: ["conflicts", "ci", "review"], attempts: 1, streak: 1, at: NOW } });
    expect(upkeepReasons(pr({ ciStatus: "pending", mergeable: "UNKNOWN" }), undefined)).toEqual([]);
  });

  test("UK2: the guards — closed, draft, not orchestrated, opted out, waiting on the user, a running agent, queued messages", () => {
    const red = { pr: pr({ ciStatus: "failing" }) };
    const why = (over: Partial<UpkeepInput>) => { const d = upkeepDecision(input({ ...red, ...over }), NOW); return d.action === "skip" ? d.why : d.action; };
    expect(why({ pr: pr({ ciStatus: "failing", state: "MERGED" }) })).toBe("the PR is merged");
    expect(why({ pr: pr({ ciStatus: "failing", isDraft: true }) })).toBe("draft PR");
    expect(why({ orchestrated: false })).toBe("not an orchestrated workstream");
    expect(why({ optedOut: true })).toBe("opted out of auto-upkeep");
    expect(why({ waitingOn: "Finn to pick an approach" })).toContain("waiting on the user");
    expect(why({ waitingOn: "user decision on the API shape" })).toContain("waiting on the user");
    expect(why({ waitingOn: "CI on the new head" })).toBe("address"); // waiting on something else is not a pause
    expect(why({ activity: { running: true, queued: 0 } })).toBe("agent running");
    expect(why({ activity: { running: false, queued: 1 } })).toBe("messages queued for the agent");
    expect(waitingOnUser(undefined)).toBe(false);
  });

  test("UK3: one automatic address per (head, reason) — a new reason on the same head is addressed, a tried one is not retried", () => {
    // CI was addressed on h1; now a review thread arrives on the same head: only the review goes.
    expect(upkeepDecision(input({ pr: pr({ ciStatus: "failing" }), unresolved: 1, last: rec() }), NOW))
      .toMatchObject({ action: "address", reasons: ["review"], record: { tried: ["ci", "review"], reasons: ["review"], attempts: 2, streak: 2 } });
    // A new head is a clean slate for the dedup (the streak carries on).
    expect(upkeepDecision(input({ pr: pr({ ciStatus: "failing", head: "h2" }), last: rec() }), NOW))
      .toMatchObject({ action: "address", reasons: ["ci"], record: { sha: "h2", tried: ["ci"], attempts: 1, streak: 2 } });
  });

  test("UK4: backoff — a head that failed twice (or whose one try left nothing untried) gives up and says why; then it stays given up", () => {
    const twice = upkeepDecision(input({ pr: pr({ ciStatus: "failing" }), unresolved: 1, last: rec({ tried: ["ci", "conflicts"], attempts: 2 }) }), NOW);
    expect(twice).toMatchObject({ action: "give_up", reasons: ["ci", "review"], why: "CI, review still there after 2 automatic addresses on this commit" });
    const stuck = upkeepDecision(input({ pr: pr({ ciStatus: "failing" }), last: rec() }), NOW);
    expect(stuck).toMatchObject({ action: "give_up", why: "CI still there after an automatic address on this commit" });
    if (stuck.action !== "give_up") throw new Error("expected give_up");
    expect(stuck.record).toMatchObject({ sha: "h1", gaveUp: stuck.why, attempts: 1 });
    // Given up on h1: left alone (no second notification) until a push moves the head.
    expect(upkeepDecision(input({ pr: pr({ ciStatus: "failing" }), last: stuck.record }), NOW)).toMatchObject({ action: "skip", why: expect.stringContaining("gave up on this head") });
    expect(upkeepDecision(input({ pr: pr({ ciStatus: "failing", head: "h2" }), last: stuck.record }), NOW)).toMatchObject({ action: "address" });
  });

  test("UK5: across heads — a fix that goes red on every push stops after the streak; only a settled, green look resets it", () => {
    expect(upkeepDecision(input({ pr: pr({ ciStatus: "failing", head: "h9" }), last: rec({ streak: UPKEEP_MAX_STREAK }) }), NOW))
      .toMatchObject({ action: "give_up", why: `CI after ${UPKEEP_MAX_STREAK} automatic addresses in a row` });
    expect(upkeepDecision(input({ last: rec() }), NOW)).toEqual({ action: "healthy" });
    // CI still running (or not reported yet after a CI fix), or mergeability unknown: not healthy yet.
    expect(upkeepDecision(input({ pr: pr({ ciStatus: "pending" }), last: rec() }), NOW)).toMatchObject({ action: "skip" });
    expect(upkeepDecision(input({ pr: pr({ ciStatus: "none" }), last: rec() }), NOW)).toMatchObject({ action: "skip" });
    expect(upkeepDecision(input({ pr: pr({ mergeable: "UNKNOWN" }), last: rec() }), NOW)).toMatchObject({ action: "skip" });
    expect(upkeepDecision(input({ pr: pr({ ciStatus: "none" }) }), NOW)).toEqual({ action: "healthy" }); // a repo with no CI
  });

  test("UK6: the concurrency cap holds a new address, but never a give-up", () => {
    expect(upkeepDecision(input({ pr: pr({ ciStatus: "failing" }), active: 2, cap: 2 }), NOW)).toEqual({ action: "skip", why: "at the concurrency cap (2/2 automatic addresses running)" });
    expect(upkeepDecision(input({ pr: pr({ ciStatus: "failing" }), active: 1, cap: 2 }), NOW)).toMatchObject({ action: "address" });
    expect(upkeepDecision(input({ pr: pr({ ciStatus: "failing" }), active: 0, cap: 0 }), NOW)).toMatchObject({ action: "skip" }); // 0 = off
    expect(upkeepDecision(input({ pr: pr({ ciStatus: "failing" }), active: 2, cap: 2, last: rec() }), NOW)).toMatchObject({ action: "give_up" });
  });

  test("UK7: review threads count only when actionable and not yet handed; the card's line; the notifications' actions", () => {
    const thread = (id: string, over: Record<string, unknown> = {}) => ({ id, author: "rev", body: "Please rename this.", resolved: false, ...over });
    const s = { prAuthor: "me", comments: [], threads: [thread("a"), thread("b"), thread("c", { resolved: true }), thread("d", { author: "me" })] };
    expect(unhandedActionable(s)).toBe(2);
    expect(unhandedActionable(s, ["a"])).toBe(1);
    expect(upkeepLabel(rec({ reasons: ["conflicts", "ci"] }), true)).toBe("auto-addressing: conflicts, CI");
    expect(upkeepLabel(rec(), false)).toBeUndefined(); // its run is over
    expect(upkeepLabel(rec({ gaveUp: "CI still there" }), false)).toBe("auto-upkeep gave up: CI still there");
    expect(notificationActions({ kind: "upkeep_gave_up" }, { row: true, prUrl: true }).map((a) => a.id)).toEqual(["address", "viewPr", "open"]);
  });

  test("UK8: autoUpkeep (per repo) and autoUpkeepConcurrency (app) are validated config", () => {
    const doc = (extra: Record<string, unknown>, repo: Record<string, unknown> = {}) =>
      parseConfigDocument({ repos: [{ name: "r", repoPath: "/x", worktreeRoot: "/y", baseBranch: "main", previewServices: [], ...repo }], ...extra });
    expect(doc({ autoUpkeepConcurrency: 3 }, { autoUpkeep: false }).config).toMatchObject({ autoUpkeepConcurrency: 3, repos: [{ autoUpkeep: false }] });
    expect(doc({}, { autoUpkeep: "no" }).errors).toContain("repos[0].autoUpkeep must be true or false");
    expect(doc({ autoUpkeepConcurrency: -1 }).errors[0]).toContain("autoUpkeepConcurrency");
  });
});

// ---- end-to-end: the tick against real git, Postgres, the fake gh and a fake claude ----

let state: string, shim: string, repo: string, worktrees: string, log: string, pg: TestDb;
let prev: Record<string, string | undefined> = {};
const GH_FIXTURES = ["ORCA_GH_FIXTURE", "ORCA_GH_REPO_FIXTURE", "ORCA_GH_GRAPHQL_FIXTURE", "ORCA_GH_RUN_LOG_FIXTURE", "ORCA_GH_RULES_FIXTURE", "ORCA_GH_ARGS_LOG"];
const repoCfg = (extra: Partial<RepoConfig> = {}): RepoConfig =>
  ({ name: "r", repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"], ...extra });
const cfg = (extra: Partial<RepoConfig> = {}, app: Partial<OrcaConfig> = {}): OrcaConfig => ({ repos: [repoCfg(extra)], portRange: [30000, 40000], staleHours: 24, ...app });
const anyRunning = async () => (await git.listWorktrees(repo, worktrees).catch(() => [])).some((w) => agent.isRunning(w.worktreePath));
const idle = async () => { for (let i = 0; i < 200 && (await anyRunning()); i++) await new Promise((r) => setTimeout(r, 25)); };
const launches = async () => (await readdir(log)).length;
const kinds = async () => (await db.notifications()).map((n) => n.kind).sort();
const record = async (branch = "feat") => (await db.enrichment("r"))[branch]?.upkeep as UpkeepRecord | undefined;
/** One open PR on `feat`, red on its required check unless `ci` says otherwise. */
const openPr = (over: { ci?: string; mergeable?: string; sha?: string; isDraft?: boolean } = {}) => setPrListFixture([{
  number: 7, title: "Feat", headRefName: "feat", headRefOid: over.sha ?? "sha1", baseRefName: "main", url: "https://github.com/acme/app/pull/7",
  state: "OPEN", isDraft: over.isDraft ?? false, mergeable: over.mergeable ?? "MERGEABLE", reviewDecision: "",
  statusCheckRollup: [{ name: "check", conclusion: over.ci ?? "FAILURE" }],
}]);

beforeEach(async () => {
  prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_FAKE_LOG", ...GH_FIXTURES].map((k) => [k, process.env[k]]));
  for (const k of GH_FIXTURES) delete process.env[k]; // another file's fixture must not answer this one's PR
  [state, shim, worktrees, log] = await Promise.all(["state", "claude", "wt", "log"].map(async (n) => realpathSync(await mkdtemp(join(tmpdir(), `orca-uk-${n}-`))))) as [string, string, string, string];
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
  pg = await freshSchema("upkeep");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  await setRequiredChecksFixture([]);
  await setReviewEvidenceFixture({ data: { repository: { pullRequest: { author: { login: "me" }, reviewThreads: { nodes: [] } } } } });
  await run(["git", "-C", repo, "branch", "feat"]);
  await verbs.ensureWorktree(repoCfg(), "feat");
  await db.patchEnrichment("r", "feat", { orchestrated: true, title: "Feat" });
});
afterEach(async () => {
  await idle();
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  restorePath();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, repo, worktrees, log]) await rm(d, { recursive: true, force: true });
});

describe("upkeep tick (end-to-end)", () => {
  test("UK9: a red PR is Address-PR'd once, notified and recorded; the same head red again gives up and tells the user, once", async () => {
    await openPr();
    const [first] = await upkeep.tick(cfg());
    expect(first?.decision).toMatchObject({ action: "address", reasons: ["ci"] });
    await idle();
    expect(await launches()).toBe(1); // the one Address PR run, through verbs.addressPr
    expect((await db.turns("r", "feat")).map((t) => t.instruction)).toEqual(["Address the PR: conflicts, CI, review"]);
    expect(await record()).toMatchObject({ sha: "sha1", tried: ["ci"], reasons: ["ci"], attempts: 1 });
    expect(await kinds()).toContain("auto_address");

    // The run finished but the head didn't move and CI is still red: no second run — it gives up.
    expect((await upkeep.tick(cfg()))[0]?.decision).toMatchObject({ action: "give_up" });
    expect((await upkeep.tick(cfg()))[0]?.decision).toMatchObject({ action: "skip" });
    expect(await launches()).toBe(1);
    expect((await db.notifications()).filter((n) => n.kind === "upkeep_gave_up")).toHaveLength(1);
    expect((await record())?.gaveUp).toContain("CI still there");

    // A push (new head) that goes green clears the record.
    await openPr({ ci: "SUCCESS", sha: "sha2" });
    expect((await upkeep.tick(cfg()))[0]?.decision).toEqual({ action: "healthy" });
    expect(await record()).toBeUndefined();
  });

  test("UK10: the record is the restart-proof dedup — written before the launch, so a fresh process does not re-fire", async () => {
    await openPr({ mergeable: "MERGEABLE" });
    await db.patchEnrichment("r", "feat", { upkeep: { sha: "sha1", tried: ["ci"], reasons: ["ci"], attempts: 1, streak: 1, at: 1 } satisfies UpkeepRecord });
    expect((await upkeep.tick(cfg()))[0]?.decision).toMatchObject({ action: "give_up" });
    expect(await launches()).toBe(0);
  });

  test("UK11: nothing for a workstream that isn't orchestrated, a draft, a busy agent, an opted-out repo, or past the cap", async () => {
    await openPr();
    await db.patchEnrichment("r", "feat", { orchestrated: false });
    expect(await upkeep.tick(cfg())).toEqual([]);
    await db.patchEnrichment("r", "feat", { orchestrated: true });
    const ghArgs = await recordGhArgs();
    expect(await upkeep.tick(cfg({ autoUpkeep: false }))).toEqual([]);
    expect(await ghArgs()).toBe(""); // an opted-out repo costs no gh call
    expect((await upkeep.tick(cfg({}, { autoUpkeepConcurrency: 0 })))[0]?.decision).toMatchObject({ action: "skip", why: expect.stringContaining("concurrency cap") });
    await openPr({ isDraft: true });
    expect((await upkeep.tick(cfg()))[0]?.decision).toEqual({ action: "skip", why: "draft PR" });
    expect(await launches()).toBe(0);
  });

  test("UK12: an unhanded review thread is a trigger; once Address PR has handed it over, it no longer is", async () => {
    await openPr({ ci: "SUCCESS" });
    await setReviewEvidenceFixture({ data: { repository: { pullRequest: { author: { login: "me" }, reviewThreads: { nodes: [
      { id: "T1", isResolved: false, isOutdated: false, path: "a.ts", line: 1, comments: { nodes: [{ author: { login: "rev" }, body: "Please rename this.", url: "u", createdAt: "2026-10-14T00:00:00Z" }] } },
    ] } } } } });
    expect((await upkeep.tick(cfg()))[0]?.decision).toMatchObject({ action: "address", reasons: ["review"] });
    await idle();
    expect((await db.enrichment("r")).feat?.handedReviewThreadIds).toEqual(["T1"]);
    // Still unresolved, but handed: CI green and clean, so the PR is healthy — no second run.
    expect((await upkeep.tick(cfg()))[0]?.decision).toEqual({ action: "healthy" });
    expect(await launches()).toBe(1);
  });
});
