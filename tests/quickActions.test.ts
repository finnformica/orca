// The actions bar's state-aware quick actions (workstream.quickActions): one pure mapping from a
// workstream's state to at most two toolbar verbs, first matching rule wins. One test per rule.
import { describe, expect, test } from "bun:test";
import { quickActions, reviewProblems, type QuickActionContext, type QuickActionRow, type ReviewItem } from "@/workstream";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const ctx: QuickActionContext = { hasWork: true, slackChannel: true, now: NOW };
const openPr: QuickActionRow = { lane: "IN_REVIEW", prNumber: 7, hasRemote: true, mergeable: "MERGEABLE", ciStatus: "passing", reviewStatus: "review_required" };
const approved: QuickActionRow = { ...openPr, lane: "MERGEABLE", reviewStatus: "approved" };
const ids = (row: QuickActionRow, c: Partial<QuickActionContext> = {}) => quickActions(row, { ...ctx, ...c }).map((a) => a.id);
const item = (over: Partial<ReviewItem>): ReviewItem => ({ id: "x", kind: "thread", body: "Handle null here", bot: false, line: "", ...over });

describe("quickActions", () => {
  test("1. no PR: a local branch with commits → Create PR (Promote without a remote); nothing without commits", () => {
    const local: QuickActionRow = { lane: "LOCAL", hasRemote: true };
    expect(quickActions(local, ctx)).toEqual([{ id: "createPr", label: "Create PR", disabled: undefined }]);
    expect(quickActions({ ...local, hasRemote: false }, ctx)[0]!.label).toBe("Promote");
    expect(ids(local, { hasWork: false })).toEqual([]);
    expect(quickActions({ ...local, agentStatus: "running" }, ctx)[0]!.disabled).toMatch(/running/);
  });

  test("1. a promoted, clean local branch → Merge", () => {
    expect(ids({ lane: "MERGEABLE", hasRemote: false })).toEqual(["merge"]);
  });

  test("2. a draft PR → Ready for review; Address PR beside it only for a real problem", () => {
    const draft = { ...openPr, lane: "DRAFT" as const, isDraft: true };
    expect(ids(draft)).toEqual(["markReady"]);
    expect(quickActions(draft, ctx)[0]!.label).toBe("Ready for review");
    expect(ids({ ...draft, mergeable: "CONFLICTING" })).toEqual(["markReady", "addressPr"]);
    expect(ids({ ...draft, ciStatus: "failing" })).toEqual(["markReady", "addressPr"]);
    expect(ids(draft, { reviewProblems: 1 })).toEqual(["markReady", "addressPr"]);
    expect(ids(draft, { reviewProblems: 0 })).toEqual(["markReady"]); // nits only: no Address PR
  });

  test("3. a real problem → Address PR alone (no Slack, no auto-merge); disabled with the reason while an agent runs", () => {
    for (const row of [{ ...openPr, mergeable: "CONFLICTING" as const }, { ...openPr, mergeClean: "conflict" as const }, { ...openPr, ciStatus: "failing" as const }, { ...openPr, reviewStatus: "changes_requested" as const }]) {
      expect(ids(row)).toEqual(["addressPr"]);
    }
    expect(ids(openPr, { reviewProblems: 2 })).toEqual(["addressPr"]);
    expect(ids(approved, { reviewProblems: 1 })).toEqual(["addressPr"]); // approved, but a severe finding is open
    expect(ids({ ...approved, ciStatus: "failing" })).toEqual(["addressPr"]);
    expect(ids({ ...openPr, ciStatus: "failing", autoMergeEnabled: true })).toEqual(["addressPr"]);
    expect(quickActions({ ...openPr, ciStatus: "failing" }, ctx)[0]).toEqual({ id: "addressPr", label: "Address PR", disabled: undefined });
    expect(quickActions({ ...openPr, ciStatus: "failing", agentStatus: "running" }, ctx)[0]!.disabled).toMatch(/running/);
    // Review data not loaded (an Agents row before its digest is cached): what IS known still decides.
    expect(ids({ ...openPr, ciStatus: "failing" }, { reviewProblems: undefined })).toEqual(["addressPr"]);
    expect(ids(openPr, { reviewProblems: undefined })).toEqual(["slack", "autoMerge"]);
  });

  test("3. what counts as a real review problem: severe bot items and a person's unresolved non-nit thread", () => {
    expect(reviewProblems({ severe: [], human: [] })).toBe(0);
    expect(reviewProblems({ severe: [item({ bot: true, severity: "warning" }), item({ bot: true, severity: "critical" })], human: [] })).toBe(2);
    expect(reviewProblems({ severe: [], human: [item({})] })).toBe(1); // no marker → treated as a warning: people are never ignored
    expect(reviewProblems({ severe: [], human: [item({ body: "nit: rename this" })] })).toBe(0);
    expect(reviewProblems({ severe: [], human: [item({ body: "FYI this landed upstream" })] })).toBe(0);
    expect(reviewProblems({ severe: [], human: [item({ kind: "comment", body: "Looks good overall" })] })).toBe(0); // a top-level comment has no resolved bit
  });

  test("4/5. open, not approved, only nits or nothing unresolved → Send to Slack + Enable auto-merge; no Address PR", () => {
    expect(quickActions(openPr, { ...ctx, reviewProblems: 0 })).toEqual([
      { id: "slack", label: "Send to Slack", slackKind: "notify" },
      { id: "autoMerge", label: "Enable auto-merge", tip: expect.stringMatching(/checks and reviews pass/) },
    ]);
    expect(ids({ ...openPr, ciStatus: "pending" })).toEqual(["slack", "autoMerge"]); // running CI isn't a problem
    expect(ids(openPr, { slackChannel: false })).toEqual(["autoMerge"]); // no channel: nowhere to post
  });

  test("4/5. once posted → Bump on Slack, its tooltip saying when", () => {
    const sent = { ...openPr, slackNotifiedAt: "2026-10-15T09:00:00Z" };
    expect(quickActions(sent, ctx)[0]).toEqual({ id: "slack", label: "Bump on Slack", slackKind: "bump", tip: "Bump on Slack — posted 3h ago" });
  });

  test("6. approved, CI still pending → Merge + Enable auto-merge, never Slack", () => {
    const pending = { ...approved, ciStatus: "pending" as const };
    expect(ids(pending, { reviewProblems: 0 })).toEqual(["merge", "autoMerge"]);
    expect(ids({ ...openPr, reviewStatus: "approved", ciStatus: "pending" })).toEqual(["merge", "autoMerge"]); // reviewStatus alone, before the lane follows
  });

  test("6b. approved and already safe to merge (CI passing/none, no conflict) → Merge alone: GitHub refuses to arm auto-merge on a PR this clean and merges it instead, so a second button would be redundant", () => {
    expect(ids(approved, { reviewProblems: 0 })).toEqual(["merge"]); // approved is CI passing + MERGEABLE already
    expect(ids({ ...approved, ciStatus: "none" })).toEqual(["merge"]);
    expect(ids({ ...openPr, reviewStatus: "approved" })).toEqual(["merge"]); // reviewStatus alone, before the lane follows
    // Already armed or queued still shows its own state — that toggle has something to show even
    // though the PR also happens to be safe to merge right now.
    expect(ids({ ...approved, autoMergeEnabled: true })).toEqual(["merge", "disableAutoMerge"]);
    expect(ids({ ...approved, mergeWhenGreen: { by: "orchestrator" } })).toEqual(["merge", "autoMerge"]);
  });

  test("7. auto-merge already on → Disable auto-merge in its place, saying it merges once checks and reviews pass", () => {
    expect(ids({ ...openPr, autoMergeEnabled: true })).toEqual(["slack", "disableAutoMerge"]);
    const on = quickActions({ ...approved, autoMergeEnabled: true }, ctx)[1]!;
    expect(on).toMatchObject({ id: "disableAutoMerge", label: "Disable auto-merge" });
    expect(on.tip).toMatch(/Auto-merge on.*checks and reviews pass/);
    expect(on.on).toBe(true);
  });

  test("7. on Orca's own merge queue → a lit, non-clickable Auto-merge on indicator, never Enable", () => {
    const queued = quickActions({ ...openPr, mergeWhenGreen: { by: "orchestrator" } }, ctx);
    expect(queued.map((a) => a.id)).toEqual(["slack", "autoMerge"]);
    expect(queued[1]).toMatchObject({ label: "Auto-merge on", on: true, disabled: expect.stringMatching(/merges it once checks pass/) });
    expect(quickActions({ ...approved, mergeWhenGreen: {} }, ctx)[1]!.disabled).toMatch(/Auto-merge on/);
    expect(ids({ ...openPr, mergeWhenGreen: {}, ciStatus: "failing" })).toEqual(["addressPr"]); // a problem still wins
  });

  test("8. an agent running: Slack and auto-merge stay available", () => {
    const busy = { ...openPr, agentStatus: "running" as const };
    expect(quickActions(busy, ctx).every((a) => !a.disabled)).toBe(true);
    expect(ids(busy)).toEqual(["slack", "autoMerge"]);
  });

  test("9. a merged workstream has none", () => {
    expect(ids({ ...openPr, lane: "DONE" })).toEqual([]);
  });

  test("never more than two icons, and Merge when green is never one", () => {
    const rows: QuickActionRow[] = [openPr, approved, { ...openPr, lane: "DRAFT", isDraft: true, ciStatus: "failing" }, { ...openPr, autoMergeEnabled: true, slackNotifiedAt: "x" }];
    for (const row of rows) for (const reviewProblems of [undefined, 0, 3]) {
      const out = ids(row, { reviewProblems });
      expect(out.length).toBeLessThanOrEqual(2);
      expect(out as string[]).not.toContain("mergeWhenGreen");
    }
  });
});
