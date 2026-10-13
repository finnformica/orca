// Pure mapping for the PR status pill (web/src/workstream.ts `prPill`), shown on an agents-list
// row, a board card and the agent page's Details card: armed auto-merge — GitHub's own
// autoMergeRequest, or Orca's merge-when-green queue mark (#169) — reads as one purple "Auto-merge"
// state instead of "In review" / "Mergeable", but Merged/Local/Draft and a known-red PR still win.
import { expect, test } from "bun:test";
import { prPill } from "@/workstream";

test("In review with no auto-merge signal reads as In review", () => {
  expect(prPill({ lane: "IN_REVIEW" })).toEqual({ label: "In review", tone: "default" });
});

test("Mergeable (approved) with no auto-merge signal reads as Mergeable, blue", () => {
  expect(prPill({ lane: "MERGEABLE" })).toEqual({ label: "Mergeable", tone: "blue" });
});

test("GitHub auto-merge armed on an in-review PR replaces the pill with purple Auto-merge, method in the tooltip", () => {
  expect(prPill({ lane: "IN_REVIEW", autoMergeEnabled: true, autoMergeMethod: "squash" }))
    .toEqual({ label: "Auto-merge", tone: "purple", tooltip: "GitHub auto-merge is enabled (squash)" });
});

test("GitHub auto-merge armed on an approved (mergeable) PR also replaces the pill", () => {
  const pill = prPill({ lane: "MERGEABLE", autoMergeEnabled: true });
  expect(pill.label).toBe("Auto-merge");
  expect(pill.tone).toBe("purple");
});

test("Orca's merge-when-green mark alone (no GitHub auto-merge) also reads as Auto-merge", () => {
  expect(prPill({ lane: "IN_REVIEW", mergeWhenGreen: { by: "orchestrator" } }))
    .toEqual({ label: "Auto-merge", tone: "purple", tooltip: "Orca's merge queue will merge it when green (queued by orchestrator)" });
});

test("a bare merge-when-green mark (no `by`) still shows Auto-merge, with a tooltip that doesn't name anyone", () => {
  expect(prPill({ lane: "MERGEABLE", mergeWhenGreen: {} }))
    .toEqual({ label: "Auto-merge", tone: "purple", tooltip: "Orca's merge queue will merge it when green" });
});

test("failing CI wins over auto-merge — a known-red PR isn't about to merge itself", () => {
  expect(prPill({ lane: "IN_REVIEW", ciStatus: "failing", autoMergeEnabled: true }))
    .toEqual({ label: "In review", tone: "default" });
  expect(prPill({ lane: "MERGEABLE", ciStatus: "failing", mergeWhenGreen: { by: "user" } }))
    .toEqual({ label: "Mergeable", tone: "blue" });
});

test("pending/no CI does not block auto-merge — it would still merge once checks pass", () => {
  expect(prPill({ lane: "IN_REVIEW", ciStatus: "pending", autoMergeEnabled: true }).label).toBe("Auto-merge");
  expect(prPill({ lane: "IN_REVIEW", ciStatus: "none", mergeWhenGreen: { by: "user" } }).label).toBe("Auto-merge");
});

test("auto-merge never shows on Local, Draft or a merged (Done) row — only In review/Mergeable are replaced", () => {
  expect(prPill({ lane: "LOCAL", autoMergeEnabled: true })).toEqual({ label: "Local", tone: "default" });
  expect(prPill({ lane: "DRAFT", autoMergeEnabled: true, mergeWhenGreen: { by: "user" } })).toEqual({ label: "Draft", tone: "default" });
  expect(prPill({ lane: "DONE", autoMergeEnabled: true })).toEqual({ label: "Merged", tone: "green" });
});
