// A notification's quick actions (workstream.ts `notificationActions`): every kind Orca emits gets
// its one or two verbs then Open, always last — the first primary — and no Read (taking any of them marks it read, and the
// card's × is "read and out of view"); an action whose prerequisite is missing is left out, never
// shown broken; an unknown kind gets none; the orchestrator's own wake is
// answered in its window. The DOM side (hover, touch, wiring to store.addressPr) is
// tests/notificationCentre.test.tsx.
import { describe, expect, test } from "bun:test";
import { notificationActions, type NotificationActionContext } from "@/workstream";
import { NOTIFICATION_KINDS } from "../shared/notifications";

const all: NotificationActionContext = { row: true, prUrl: true, failedCheck: true, previewKey: true };
const ids = (kind: string, ctx: NotificationActionContext = all, link?: { url?: string; orchestrator?: boolean }) => notificationActions({ kind, link }, ctx).map((a) => a.id);

describe("notification quick actions", () => {
  test("each kind: its specific actions, and no Read", () => {
    const url = { url: "http://orca-box:4000" };
    expect(ids("pr_ci_failed")).toEqual(["address", "viewPr", "open"]);
    expect(ids("pr_conflicts")).toEqual(["address", "viewPr", "open"]);
    expect(ids("check_failed")).toEqual(["fix", "viewOutput", "open"]);
    expect(ids("finished")).toEqual(["reply", "open"]);
    expect(ids("needs_input")).toEqual(["reply", "open"]);
    expect(ids("failed")).toEqual(["retry", "openChat", "open"]);
    expect(ids("stopped")).toEqual(["retry", "openChat", "open"]);
    expect(ids("preview_ready", all, url)).toEqual(["openPreview", "stopPreview", "open"]);
    expect(ids("preview_failed")).toEqual(["retryPreview", "viewLog", "open"]);
  });

  test("a failed action: Ask the orchestrator (primary) and Copy, each only with its text, then Open", () => {
    const failed = { kind: "action_failed", ask: "Action Merge … failed", copy: "Action: Merge…" };
    expect(notificationActions(failed, {})).toEqual([
      { id: "ask", label: "Ask Orca", primary: true }, { id: "copy", label: "Copy" }, { id: "open", label: "Open" },
    ]);
    expect(notificationActions({ ...failed, ask: undefined }, all).map((a) => a.id)).toEqual(["copy", "open"]);
    expect(ids("action_failed")).toEqual(["open"]);
  });

  test("every emitted kind: at most two of its own, then Open — always, always last; never a Read", () => {
    for (const kind of NOTIFICATION_KINDS) {
      for (const ctx of [all, {}]) {
        const actions = notificationActions({ kind, link: { url: "http://x" } }, ctx);
        expect(actions.map((a) => a.label)).not.toContain("Read");
        expect(actions.at(-1)).toMatchObject({ id: "open", label: "Open" });
        expect(actions.filter((a) => a.id === "open")).toHaveLength(1);
        expect(actions.length).toBeLessThanOrEqual(3);
      }
      const actions = notificationActions({ kind, link: { url: "http://x" } }, all);
      expect(actions.filter((a) => a.primary)).toEqual([actions[0]!]); // exactly one primary, first
    }
  });

  test("the labels: the agent verbs by their board names; needs input leads with Reply", () => {
    const labels = (kind: string) => notificationActions({ kind }, all).map((a) => a.label);
    expect(labels("pr_ci_failed")).toEqual(["Address PR", "View PR", "Open"]);
    expect(labels("check_failed")).toEqual(["Fix", "View output", "Open"]);
    expect(labels("needs_input")).toEqual(["Reply", "Open"]);
    expect(labels("failed")).toEqual(["Retry", "Open chat", "Open"]);
    expect(labels("preview_failed")).toEqual(["Retry test", "View log", "Open"]);
  });

  test("an action whose prerequisite is missing is left out, not shown broken", () => {
    expect(ids("pr_ci_failed", {})).toEqual(["open"]); // no live row, no PR URL: Open alone
    expect(ids("pr_ci_failed", { row: true })).toEqual(["address", "open"]);
    expect(ids("check_failed", { row: true })).toEqual(["viewOutput", "open"]); // no failed check to hand over
    expect(ids("failed", {})).toEqual(["openChat", "open"]);
    expect(ids("preview_ready", all)).toEqual(["stopPreview", "open"]); // no URL: no Open preview
    expect(notificationActions({ kind: "failed" }, {})[0]!.primary).toBe(true); // the first remaining is primary
  });

  test("an unknown kind gets only Open; the orchestrator's wake gets only Open, into its window", () => {
    expect(notificationActions({ kind: "review_requested" }, all)).toEqual([{ id: "open", label: "Open", primary: true }]);
    expect(notificationActions({ kind: "failed", link: { orchestrator: true } }, all)).toEqual([{ id: "openOrchestrator", label: "Open", primary: true }]);
  });
});
