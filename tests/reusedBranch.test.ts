// A branch reused after its PR merged (the orchestrator `orca send`s new work to it; the worker
// resets onto main) must not read as Merged: GitHub still finds the old merged PR by head branch,
// and the board used to make the row DONE — hidden by the Agents page's default "Not merged" and
// missing from Running — while `orca board` (open PRs only) showed it as "no PR, agent:running".
// Both now go through ONE derivation, `mergedPrIsHistory`.
import { expect, test } from "bun:test";
import { NO_QUICK_FILTER, applyQuickFilter, boardText, mergedPrIsHistory, overviewStats, parseQuickFilter, type OverviewRow } from "../web/src/workstream";

const merged = { mergedAt: "2026-10-14T14:28:00Z", headSha: "aaa111" };
const afterMerge = Date.parse("2026-10-14T15:30:00Z");
const beforeMerge = Date.parse("2026-10-14T13:00:00Z");

test("a genuinely merged, idle workstream: the merged PR stands", () => {
  expect(mergedPrIsHistory(merged, undefined)).toBe(false); // no worktree behind it
  expect(mergedPrIsHistory(merged, { agentStatus: "done", queued: 0, agentStartedAt: beforeMerge, head: "aaa111" })).toBe(false);
  expect(mergedPrIsHistory(merged, { agentStatus: "idle" })).toBe(false); // nothing known since the merge
});

test("a reused branch: any sign of work since the merge makes the merged PR history", () => {
  expect(mergedPrIsHistory(merged, { agentStatus: "running", agentStartedAt: beforeMerge, head: "aaa111" })).toBe(true);
  expect(mergedPrIsHistory(merged, { agentStatus: "idle", queued: 1, head: "aaa111" })).toBe(true);
  expect(mergedPrIsHistory(merged, { agentStatus: "done", agentStartedAt: afterMerge, head: "aaa111" })).toBe(true); // a run after the merge
  // HEAD moved off the PR's head with new commits of its own (headBehindPr: false) — reuse.
  expect(mergedPrIsHistory(merged, { agentStatus: "done", agentStartedAt: beforeMerge, head: "bbb222", headBehindPr: false })).toBe(true);
  expect(mergedPrIsHistory(merged, { openPr: true })).toBe(true); // a newer open PR for the branch
});

test("a worktree behind the merged PR's head (a push landed from elsewhere and it never fetched) is not reuse", () => {
  // Equal heads: not reuse regardless of any ancestry fact.
  expect(mergedPrIsHistory(merged, { agentStatus: "idle", head: "aaa111" })).toBe(false);
  // Different head, proven an ancestor of (behind) the PR's last head: not reuse.
  expect(mergedPrIsHistory(merged, { agentStatus: "idle", head: "earlier000", headBehindPr: true })).toBe(false);
  // Different head, proven NOT an ancestor (it has commits the PR's head doesn't): reuse.
  expect(mergedPrIsHistory(merged, { agentStatus: "idle", head: "ahead999", headBehindPr: false })).toBe(true);
  // Different head, ancestry never checked (a pure-web caller with no git): defaults to reuse.
  expect(mergedPrIsHistory(merged, { agentStatus: "idle", head: "unknown777" })).toBe(true);
});

// What the store assembles for each case (store.assembleRows: a standing merged PR is a DONE row; a
// history one leaves the live row in its own lane).
const reused: OverviewRow = { repo: "branch-demo", branch: "orca/item-checks-on-review-page-804a8b", title: "Item checks", lane: "LOCAL", worktreePath: "/wt/x", agentStatus: "running" };
const done: OverviewRow = { repo: "branch-demo", branch: "orca/old", title: "Old", lane: "DONE", prNumber: 6200 };

test("the reused, running row shows under the default Not merged and Running; the merged one stays hidden", () => {
  const rows = [reused, done];
  expect(applyQuickFilter(rows, NO_QUICK_FILTER).map((r) => r.branch)).toEqual([reused.branch]);
  expect(applyQuickFilter(rows, parseQuickFilter("status=running")).map((r) => r.branch)).toEqual([reused.branch]);
  const stats = overviewStats(rows);
  expect(stats.running).toBe(1); // Overview's Running counts it
  expect(stats.mergedToday).toBe(1);
});

test("orca board names a standing merged PR and leaves a reused branch as its live state", () => {
  const text = boardText([
    { repo: "r", branch: "reused", agent: "running" },
    { repo: "r", branch: "old", agent: "done", pr: { number: 6200, merged: true } },
  ]);
  expect(text).toContain("r/reused | no PR | agent:running");
  expect(text).toContain("r/old | PR #6200 merged | agent:done");
});
