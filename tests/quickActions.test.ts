// The actions bar's state-aware quick actions (workstream.quickActions): one pure mapping from a
// workstream's state to its toolbar verbs, first = primary. Every state the bar distinguishes.
import { describe, expect, test } from "bun:test";
import { quickActions, type QuickActionContext, type QuickActionRow } from "@/workstream";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const ctx: QuickActionContext = { hasWork: true, slackChannel: true, mergePolicy: { whenGreen: "any" }, nowMs: NOW, staleHours: 24 };
const openPr: QuickActionRow = { lane: "IN_REVIEW", prNumber: 7, hasRemote: true, mergeable: "MERGEABLE", ciStatus: "passing", reviewStatus: "review_required" };
const ids = (row: QuickActionRow, c: Partial<QuickActionContext> = {}) => quickActions(row, { ...ctx, ...c }).map((a) => a.id);

describe("quickActions", () => {
  test("a local branch with commits → Create PR (Promote without a remote); nothing without commits", () => {
    const local: QuickActionRow = { lane: "LOCAL", hasRemote: true };
    expect(quickActions(local, ctx)).toEqual([{ id: "createPr", label: "Create PR", disabled: undefined }]);
    expect(quickActions({ ...local, hasRemote: false }, ctx)[0]!.label).toBe("Promote");
    expect(ids(local, { hasWork: false })).toEqual([]);
    expect(quickActions({ ...local, agentStatus: "running" }, ctx)[0]!.disabled).toMatch(/running/);
  });

  test("a promoted, clean local branch → Merge", () => {
    expect(ids({ lane: "MERGEABLE", hasRemote: false })).toEqual(["merge"]);
  });

  test("a draft PR → Ready for review; Address review beside it when something is outstanding", () => {
    expect(ids({ ...openPr, lane: "DRAFT", isDraft: true })).toEqual(["markReady"]);
    expect(quickActions({ ...openPr, lane: "DRAFT", isDraft: true }, ctx)[0]!.label).toBe("Ready for review");
    expect(ids({ ...openPr, lane: "DRAFT", isDraft: true, ciStatus: "failing" })).toEqual(["markReady", "addressPr"]);
  });

  test("conflicts, failing CI, unresolved threads or changes requested → Address review alone", () => {
    expect(ids({ ...openPr, mergeable: "CONFLICTING" })).toEqual(["addressPr"]);
    expect(ids({ ...openPr, mergeClean: "conflict" })).toEqual(["addressPr"]);
    expect(ids({ ...openPr, ciStatus: "failing" })).toEqual(["addressPr"]);
    expect(ids({ ...openPr, reviewStatus: "changes_requested" })).toEqual(["addressPr"]);
    expect(ids(openPr, { unresolved: 2 })).toEqual(["addressPr"]);
    // Approved but red still needs the fix first, not a merge.
    expect(ids({ ...openPr, lane: "MERGEABLE", reviewStatus: "approved", ciStatus: "failing" })).toEqual(["addressPr"]);
    expect(quickActions({ ...openPr, ciStatus: "failing", agentStatus: "running" }, ctx)[0]!.disabled).toMatch(/running/);
    expect(quickActions({ ...openPr, ciStatus: "failing" }, ctx)[0]!.label).toBe("Address review");
  });

  test("open, clean, nothing outstanding, not approved → Send to Slack, then Bump once it's stale", () => {
    expect(quickActions(openPr, ctx)).toEqual([{ id: "slack", label: "Send to Slack", slackKind: "notify" }]);
    const sent = { ...openPr, slackNotifiedAt: new Date(NOW - 2 * 3600_000).toISOString() };
    expect(ids(sent)).toEqual([]); // just sent: the ⋯ menu still has "Send message again"
    const stale = { ...openPr, slackNotifiedAt: new Date(NOW - 30 * 3600_000).toISOString() };
    expect(quickActions(stale, ctx)).toEqual([{ id: "slack", label: "Bump on Slack", slackKind: "bump" }]);
    expect(ids(openPr, { slackChannel: false })).toEqual([]); // no channel: nowhere to post
    expect(ids({ ...openPr, ciStatus: "pending" })).toEqual([]); // CI still running is not clean yet
  });

  test("approved and clean → Merge when green (primary) + Merge; pending CI → Merge when green alone", () => {
    const approved = { ...openPr, lane: "MERGEABLE" as const, reviewStatus: "approved" as const };
    expect(quickActions(approved, ctx)).toEqual([
      { id: "mergeWhenGreen", label: "Merge when green", disabled: undefined },
      { id: "merge", label: "Merge" },
    ]);
    expect(ids({ ...approved, ciStatus: "pending" })).toEqual(["mergeWhenGreen"]);
  });

  test("Merge when green is disabled with the merge queue's own reason when the policy refuses it", () => {
    const approved = { ...openPr, lane: "MERGEABLE" as const, reviewStatus: "approved" as const };
    const never = quickActions(approved, { ...ctx, mergePolicy: undefined });
    expect(never[0]!.disabled).toBe("Not queued: this repo's mergePolicy.whenGreen is \"never\": merging is the user's");
    expect(never[1]).toEqual({ id: "merge", label: "Merge" }); // merging by hand still works
    expect(quickActions(approved, { ...ctx, mergePolicy: { whenGreen: "small" } })[0]!.disabled).toMatch(/marked small/);
    expect(quickActions({ ...approved, mergeWhenGreen: { small: true } }, { ...ctx, mergePolicy: { whenGreen: "small" } })[0]!.disabled).toMatch(/Already queued/);
    expect(quickActions({ ...approved, autoMergeEnabled: true }, ctx)[0]!.disabled).toMatch(/Already queued/);
  });

  test("a merged workstream has none", () => {
    expect(ids({ ...openPr, lane: "DONE" })).toEqual([]);
  });
});
