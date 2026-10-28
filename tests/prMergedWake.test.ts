// `orca wake --on pr:<repo>#<n>:merged` fires for EVERY merge, not only the merge queue's own: a PR
// merged in the GitHub UI or by another person (the poller's done list, via verbs.cleanupRepo), a PR
// the poller never lists (another author, an old merge: the wake's own read, scheduledWake.watchPrs),
// and the queue. Each path emits the one `merged` event (key merged:<repo>#<n>), so a wake fires once
// and leaves the pending list. Real Postgres, the fake GitHub from helpers.ts, a scratch repo.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as db from "../server/db";
import * as mergeQueue from "../server/mergeQueue";
import * as orchestrator from "../server/orchestrator";
import * as router from "../server/integrations/router";
import * as verbs from "../server/verbs";
import * as wakes from "../server/scheduledWake";
import type { OrcaConfig, RepoConfig } from "../server/config";
import { SCHEDULED_WAKE_MARKER } from "../shared/scheduledWake";
import { MERGED_NEWS_MS, seenMergedNotifications } from "../shared/notifications";
import { installFakeGh, makeScratchRepo, restorePath, setDonePrListFixture, setPrListFixture, setViewFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

let pg: TestDb, repoPath: string, prevDb: string | undefined;
const delivered: string[] = [];
const deliver = async (t: string) => { delivered.push(t); };
const iso = (ms: number) => new Date(ms).toISOString();

// bun runs every test file in one process, and a listener cannot be removed: it stays for the process.
// Off after this file, or it claims the wakes of a later file's tests (scheduledWake.test.ts).
let listening = false;
beforeAll(async () => {
  await installFakeGh();
  listening = true;
  router.onNewEvent((e) => { if (listening) void wakes.onEvent(e, deliver).catch(() => {}); });
});
afterAll(() => { listening = false; restorePath(); });
beforeEach(async () => {
  prevDb = process.env.ORCA_DATABASE_URL;
  pg = await freshSchema("prwake");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  repoPath = await makeScratchRepo();
  delivered.length = 0;
  await setPrListFixture([]);
  await setDonePrListFixture([]);
});
afterEach(async () => {
  mergeQueue.onReport(undefined);
  await db.close();
  await pg.drop();
  if (prevDb === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prevDb;
  await rm(repoPath, { recursive: true, force: true });
});

const repo = (): RepoConfig => ({ name: "r", repoPath, worktreeRoot: join(repoPath, ".wt"), baseBranch: "main", previewServices: [], mergePolicy: { whenGreen: "any" } });
const cfg = (): OrcaConfig => ({ repos: [repo()], portRange: [30000, 40000], staleHours: 24 });
const settle = async (n: number) => { for (let i = 0; i < 80 && delivered.length < n; i++) await new Promise((r) => setTimeout(r, 25)); };
const pending = async () => (await wakes.list()).map((w) => w.on);
const view = (over: { number: number; branch: string; state: string; ci?: string; mergeable?: string }) => setViewFixture({
  number: over.number, title: "Some PR", headRefName: over.branch, url: `https://github.com/acme/app/pull/${over.number}`, isDraft: false,
  headRefOid: "sha1", state: over.state, mergeable: over.mergeable ?? "MERGEABLE", reviewDecision: "",
  statusCheckRollup: over.ci ? [{ name: "check", conclusion: over.ci }] : [], files: [{ path: "a.ts" }], changedFiles: 1,
});

test("PW1: a merge outside the queue that the poller sees fires each pending pr:…:merged wake once — an Orca auto-PR and a hand-opened PR alike", async () => {
  const now = Date.now();
  await wakes.wakeTool("chief", [], { on: "pr:r#7:merged", note: "Hand PR landed" }, undefined, now);
  await wakes.wakeTool("chief", [], { on: "pr:r#8:merged", note: "Auto PR landed" }, undefined, now);
  await wakes.wakeTool("chief", [], { on: "pr:r#9:merged", note: "Still open" }, undefined, now);
  await db.patchEnrichment("r", "orca/add-cache", { orchestrated: true, title: "Add cache" }); // the auto-PR's card
  await setDonePrListFixture([
    { number: 7, title: "Hand fix", url: "u7", headRefName: "finn/hand-fix", headRefOid: "a", mergedAt: iso(now - 60_000), closedAt: iso(now - 60_000) },
    { number: 8, title: "Add cache", url: "u8", headRefName: "orca/add-cache", headRefOid: "b", mergedAt: iso(now - 120_000), closedAt: iso(now - 120_000) },
  ]);
  await verbs.cleanupRepo(repo(), { now });
  await settle(2);
  expect(delivered.sort()).toEqual([
    `${SCHEDULED_WAKE_MARKER} w1 · on pr:r#7:merged (orca.pr.merged)\nHand PR landed`,
    `${SCHEDULED_WAKE_MARKER} w2 · on pr:r#8:merged (orca.pr.merged)\nAuto PR landed`,
  ]);
  expect(await pending()).toEqual(["pr:r#9:merged"]);
  // The next pass is a repeat: no second row, no second fire.
  await verbs.cleanupRepo(repo(), { now: now + 10_000 });
  await new Promise((r) => setTimeout(r, 150));
  expect(delivered).toHaveLength(2);
  const merged = (await db.notifications()).filter((n) => n.kind === "merged");
  expect(merged.map((n) => [n.title, n.link?.pr]).sort()).toEqual([["Add cache", 8], ["finn/hand-fix", 7]]);
});

test("PW2: a pending wake reads its own PR — a merge the poller never lists (another author, an old merge) fires it once; CI red fires a ci_failed wake", async () => {
  const now = Date.now();
  await wakes.wakeTool("chief", [], { on: "pr:r#6648:merged", note: "Coworker merged it" }, undefined, now);
  await view({ number: 6648, branch: "someone/else", state: "OPEN", ci: "IN_PROGRESS" });
  await wakes.watchPrs(cfg(), now);
  await new Promise((r) => setTimeout(r, 150));
  expect(delivered).toEqual([]); // open and pending: nothing yet
  await view({ number: 6648, branch: "someone/else", state: "MERGED" });
  await wakes.watchPrs(cfg(), now);
  await settle(1);
  expect(delivered).toEqual([`${SCHEDULED_WAKE_MARKER} w1 · on pr:r#6648:merged (orca.pr.merged)\nCoworker merged it`]);
  expect(await pending()).toEqual([]);
  await wakes.watchPrs(cfg(), now);
  expect(delivered).toHaveLength(1);

  await wakes.wakeTool("chief", [], { on: "pr:r#12:ci_failed", note: "Fix CI" }, undefined, now);
  await view({ number: 12, branch: "feat", state: "OPEN", ci: "FAILURE" });
  await wakes.watchPrs(cfg(), now);
  await settle(2);
  expect(delivered[1]).toBe(`${SCHEDULED_WAKE_MARKER} w2 · on pr:r#12:ci_failed (orca.pr.ci_failed)\nFix CI`);
  expect(await pending()).toEqual([]);
});

test("PW3: the merge queue's own merge fires a pending pr:…:merged wake once, with the same key the poller uses", async () => {
  const now = Date.now();
  mergeQueue.onReport(async () => {});
  await wakes.wakeTool("chief", [], { on: "pr:r#7:merged", note: "Queue merged it" }, undefined, now);
  await view({ number: 7, branch: "feat", state: "OPEN", ci: "SUCCESS" });
  expect(await orchestrator.tool(cfg(), "merge", { repo: "r", pr: "7", "when-green": "" })).toContain("Merged r PR #7");
  await settle(1);
  expect(delivered).toEqual([`${SCHEDULED_WAKE_MARKER} w1 · on pr:r#7:merged (orca.pr.merged)\nQueue merged it`]);
  // The poller then sees the same merge: a repeat, one row.
  await setDonePrListFixture([{ number: 7, title: "Some PR", url: "u7", headRefName: "feat", headRefOid: "sha1", mergedAt: iso(now), closedAt: iso(now) }]);
  await verbs.cleanupRepo(repo(), { now });
  await new Promise((r) => setTimeout(r, 150));
  expect(delivered).toHaveLength(1);
  expect((await db.notifications()).filter((n) => n.kind === "merged")).toHaveLength(1);
});

test("PW4: the poller announces only recent merges, and only merges", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  const done = new Map([
    ["new", { reason: "merged", at: now - 60_000, number: 1 }],
    ["old", { reason: "merged", at: now - MERGED_NEWS_MS - 1, number: 2 }],
    ["shut", { reason: "closed", at: now, number: 3 }],
    ["nonum", { reason: "merged", at: now }],
  ]);
  expect(seenMergedNotifications("r", done, { new: "New work" }, now)).toEqual([
    { repo: "r", branch: "new", kind: "merged", title: "New work", link: { pr: 1 }, key: "merged:r#1", body: "PR #1 merged on GitHub." },
  ]);
});
