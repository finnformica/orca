// The actions bar's state-aware quick actions (workstream.quickActions): one pure mapping from a
// workstream's state to EVERY toolbar verb that applies — they combine. Every state the bar distinguishes.
import { describe, expect, test } from "bun:test";
import { quickActions, type QuickActionContext, type QuickActionRow } from "@/workstream";

const ctx: QuickActionContext = { hasWork: true, slackChannel: true, mergePolicy: { whenGreen: "any" } };
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

  test("a draft PR → Ready for review; Address review beside it when something is outstanding; nothing else", () => {
    const draft = { ...openPr, lane: "DRAFT" as const, isDraft: true };
    expect(ids(draft)).toEqual(["markReady"]);
    expect(quickActions(draft, ctx)[0]!.label).toBe("Ready for review");
    expect(ids({ ...draft, mergeable: "CONFLICTING" })).toEqual(["markReady", "addressPr"]);
    expect(ids({ ...draft, ciStatus: "failing" })).toEqual(["markReady", "addressPr"]);
  });

  test("conflicts, failing CI, unresolved threads or changes requested → Address review, beside Merge when green", () => {
    for (const row of [{ ...openPr, mergeable: "CONFLICTING" as const }, { ...openPr, mergeClean: "conflict" as const }, { ...openPr, ciStatus: "failing" as const }, { ...openPr, reviewStatus: "changes_requested" as const }]) {
      expect(ids(row)).toEqual(["addressPr", "mergeWhenGreen"]);
    }
    expect(ids(openPr, { unresolved: 2 })).toEqual(["addressPr", "mergeWhenGreen"]);
    // Review data not loaded (an Agents row): what IS known still decides.
    expect(ids({ ...openPr, ciStatus: "failing" }, { unresolved: undefined })).toEqual(["addressPr", "mergeWhenGreen"]);
    expect(ids(openPr, { unresolved: undefined })).toEqual(["slack", "mergeWhenGreen"]);
    expect(ids({ ...openPr, lane: "MERGEABLE", reviewStatus: "approved", ciStatus: "failing" })).toEqual(["addressPr", "mergeWhenGreen"]);
    expect(quickActions({ ...openPr, ciStatus: "failing", agentStatus: "running" }, ctx)[0]!.disabled).toMatch(/running/);
    expect(quickActions({ ...openPr, ciStatus: "failing" }, ctx)[0]!.label).toBe("Address review");
  });

  test("a ready PR with nothing outstanding → Send to Slack, then Bump on Slack as soon as it's posted", () => {
    expect(quickActions(openPr, ctx)[0]).toEqual({ id: "slack", label: "Send to Slack", slackKind: "notify" });
    const sent = { ...openPr, slackNotifiedAt: "2026-10-14T10:00:00Z" };
    expect(quickActions(sent, ctx)[0]).toEqual({ id: "slack", label: "Bump on Slack", slackKind: "bump" }); // not hidden until stale
    expect(ids(openPr, { slackChannel: false })).toEqual(["mergeWhenGreen"]); // no channel: nowhere to post
    expect(ids({ ...openPr, ciStatus: "pending" })).toEqual(["slack", "mergeWhenGreen"]); // running CI isn't outstanding
  });

  test("an approved clean PR → Send to Slack and Merge when green", () => {
    const approved = { ...openPr, lane: "MERGEABLE" as const, reviewStatus: "approved" as const };
    expect(quickActions(approved, ctx)).toEqual([
      { id: "slack", label: "Send to Slack", slackKind: "notify" },
      { id: "mergeWhenGreen", label: "Merge when green", disabled: undefined },
    ]);
  });

  test("Merge when green shows on every open non-draft PR, disabled with the reason when queued or refused", () => {
    const mwg = (row: QuickActionRow, c: Partial<QuickActionContext> = {}) => quickActions(row, { ...ctx, ...c }).find((a) => a.id === "mergeWhenGreen");
    expect(mwg(openPr, { mergePolicy: undefined })!.disabled).toBe("Not queued: this repo's mergePolicy.whenGreen is \"never\": merging is the user's");
    expect(mwg(openPr, { mergePolicy: { whenGreen: "small" } })!.disabled).toMatch(/marked small/);
    expect(mwg({ ...openPr, mergeWhenGreen: { small: true } }, { mergePolicy: { whenGreen: "small" } })!.disabled).toMatch(/Already queued/);
    expect(mwg({ ...openPr, autoMergeEnabled: true })!.disabled).toMatch(/Already queued/);
    expect(mwg({ ...openPr, lane: "DRAFT", isDraft: true })).toBeUndefined();
  });

  test("a merged workstream has none", () => {
    expect(ids({ ...openPr, lane: "DONE" })).toEqual([]);
  });
});
