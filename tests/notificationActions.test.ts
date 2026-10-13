// A notification's quick actions (workstream.ts `notificationActions`): every kind Orca emits gets
// its one or two verbs — the first primary — and Read; an action whose prerequisite is missing is
// left out, never shown broken; an unknown kind gets Read only; the orchestrator's own wake is
// answered in its window. The DOM side (hover, touch, wiring to store.addressPr) is
// tests/notificationCentre.test.tsx.
import { describe, expect, test } from "bun:test";
import { notificationActions, type NotificationActionContext } from "@/workstream";
import { NOTIFICATION_KINDS } from "../shared/notifications";

const all: NotificationActionContext = { row: true, prUrl: true, failedCheck: true, previewKey: true };
const ids = (kind: string, ctx: NotificationActionContext = all, link?: { url?: string; orchestrator?: boolean }) => notificationActions({ kind, link }, ctx).map((a) => a.id);

describe("notification quick actions", () => {
  test("each kind: its specific actions, then Read", () => {
    const url = { url: "http://orca-box:4000" };
    expect(ids("pr_ci_failed")).toEqual(["address", "viewPr", "read"]);
    expect(ids("pr_conflicts")).toEqual(["address", "viewPr", "read"]);
    expect(ids("check_failed")).toEqual(["fix", "viewOutput", "read"]);
    expect(ids("finished")).toEqual(["open", "reply", "read"]);
    expect(ids("needs_input")).toEqual(["reply", "open", "read"]);
    expect(ids("failed")).toEqual(["retry", "openChat", "read"]);
    expect(ids("stopped")).toEqual(["retry", "openChat", "read"]);
    expect(ids("preview_ready", all, url)).toEqual(["openPreview", "stopPreview", "read"]);
    expect(ids("preview_failed")).toEqual(["retryPreview", "viewLog", "read"]);
  });

  test("every emitted kind has at least one specific action, at most two, and always ends with Read", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const actions = notificationActions({ kind, link: { url: "http://x" } }, all);
      expect(actions.at(-1)).toEqual({ id: "read", label: "Read" });
      expect(actions.length).toBeGreaterThanOrEqual(2);
      expect(actions.length).toBeLessThanOrEqual(3);
      expect(actions.filter((a) => a.primary)).toEqual([actions[0]!]); // exactly one primary, first
    }
  });

  test("the labels: the agent verbs by their board names; needs input leads with Reply", () => {
    const labels = (kind: string) => notificationActions({ kind }, all).map((a) => a.label);
    expect(labels("pr_ci_failed")).toEqual(["Address PR", "View PR", "Read"]);
    expect(labels("check_failed")).toEqual(["Fix", "View output", "Read"]);
    expect(labels("needs_input")).toEqual(["Reply", "Open workstream", "Read"]);
    expect(labels("failed")).toEqual(["Retry", "Open chat", "Read"]);
    expect(labels("preview_failed")).toEqual(["Retry test", "View log", "Read"]);
  });

  test("an action whose prerequisite is missing is left out, not shown broken", () => {
    expect(ids("pr_ci_failed", {})).toEqual(["read"]); // no live row, no PR URL
    expect(ids("pr_ci_failed", { row: true })).toEqual(["address", "read"]);
    expect(ids("check_failed", { row: true })).toEqual(["viewOutput", "read"]); // no failed check to hand over
    expect(ids("failed", {})).toEqual(["openChat", "read"]);
    expect(ids("preview_ready", all)).toEqual(["stopPreview", "read"]); // no URL: nothing to open
    expect(notificationActions({ kind: "failed" }, {})[0]!.primary).toBe(true); // the first remaining is primary
  });

  test("an unknown kind gets Read only; the orchestrator's wake is answered in its window", () => {
    expect(notificationActions({ kind: "review_requested" }, all)).toEqual([{ id: "read", label: "Read" }]);
    expect(ids("failed", all, { orchestrator: true })).toEqual(["openOrchestrator", "read"]);
  });
});
