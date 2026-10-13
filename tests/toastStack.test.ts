// The notification toast stack's behaviour, pure (shared/notifications.ts), modelled on branch-demo's
// inbox-toast-state.test.ts — branch-demo's stack is sonner's bottom-left one, and Orca copies its
// numbers with CSS transitions: three visible; collapsed, a 14px lift and 5% shrink per card behind,
// clipped to the front card; hovered, spread by real heights plus a 14px gap; slide in from below,
// drop out on removal; a 45px swipe (or a flick) left/down dismisses; the auto-hide clock pauses
// while you look and resumes with what was left. Also where it anchors (just above the bell, left)
// and the action's wording (workstream-centric). The DOM side is tests/notificationCentre.test.tsx.
import { describe, expect, test } from "bun:test";
import {
  clockPause, clockResume, clockStart, notificationAction, STACK_GAP, STACK_VISIBLE, stackAnchor, stackLayout, swipeAmount, swipeOut,
  TOAST_WIDTH, toastMotion, toastStack, type Notification,
} from "../shared/notifications";

const n = (id: number, createdAt: number): Pick<Notification, "id" | "createdAt"> => ({ id, createdAt });

describe("the toast stack", () => {
  test("newest in front, at most three showing; the rest wait their turn", () => {
    const stack = toastStack([n(1, 10), n(2, 20), n(3, 30), n(4, 40), n(5, 40)]);
    expect(stack.ordered.map((t) => t.id)).toEqual([5, 4, 3, 2, 1]); // a tie goes to the later id
    expect(stack.visible).toHaveLength(STACK_VISIBLE);
    expect(stack.hidden).toBe(2);
    // Dismissing the front one brings the next waiting one into view.
    expect(toastStack(stack.ordered.slice(1)).visible.map((t) => t.id)).toEqual([4, 3, 2]);
    expect(toastStack([]).visible).toEqual([]);
  });

  test("collapsed: the front card in place, each behind lifted 14px and 5% smaller, clipped to the front's height", () => {
    const [front, second, third, fourth] = stackLayout([80, 120, 60, 90], false);
    expect(front).toMatchObject({ front: true, visible: true, transform: "translateY(0px)" });
    expect(front!.height).toBeUndefined(); // its own height
    expect(second).toMatchObject({ front: false, visible: true, height: 80, transform: "translateY(-14px) scale(0.95)" });
    expect(third).toMatchObject({ visible: true, height: 80, transform: "translateY(-28px) scale(0.9)" });
    expect(fourth!.visible).toBe(false); // past three: rendered, invisible, untouchable
  });

  test("expanded on hover: each card above the ones before it by their real heights plus the gap", () => {
    const places = stackLayout([80, 120, 60], true);
    expect(places.map((p) => p.offset)).toEqual([0, 80 + STACK_GAP, 80 + 120 + 2 * STACK_GAP]);
    expect(places.map((p) => p.transform)).toEqual(["translateY(0px)", "translateY(-94px)", "translateY(-228px)"]);
    expect(places.map((p) => p.height)).toEqual([80, 120, 60]); // unclipped
  });

  test("enter and exit: slide up from below; the front drops out, an expanded one drops from its spot, a collapsed one sinks", () => {
    const [front, behind] = stackLayout([80, 120], false);
    const [, spread] = stackLayout([80, 120], true);
    expect(toastMotion(front!, { mounted: false, removed: false, expanded: false })).toEqual({ transform: "translateY(100%)", opacity: 0 });
    expect(toastMotion(front!, { mounted: true, removed: false, expanded: false })).toEqual({ transform: "translateY(0px)", opacity: 1 });
    expect(toastMotion(front!, { mounted: true, removed: true, expanded: false })).toEqual({ transform: "translateY(100%)", opacity: 0 });
    expect(toastMotion(spread!, { mounted: true, removed: true, expanded: true })).toEqual({ transform: "translateY(calc(-94px + 100%))", opacity: 0 });
    expect(toastMotion(behind!, { mounted: true, removed: true, expanded: false })).toEqual({ transform: "translateY(40%)", opacity: 0, slow: true });
    const hidden = stackLayout([1, 1, 1, 1], false)[3]!;
    expect(toastMotion(hidden, { mounted: true, removed: false, expanded: false }).opacity).toBe(0);
  });

  test("dismiss by swipe: free toward the stack's edges (left, down), dampened the other way; 45px or a flick", () => {
    expect(swipeAmount("x", -30)).toBe(-30);
    expect(swipeAmount("y", 30)).toBe(30);
    expect(Math.abs(swipeAmount("x", 30))).toBeLessThan(30); // right is resisted
    expect(Math.abs(swipeAmount("y", -30))).toBeLessThan(30); // up is resisted
    expect(swipeOut("x", -45, 1_000)).toBe("left");
    expect(swipeOut("y", 50, 1_000)).toBe("down");
    expect(swipeOut("x", -20, 1_000)).toBeUndefined(); // springs back
    expect(swipeOut("x", -20, 100)).toBe("left"); // a flick: 0.2px/ms
  });

  test("pause on hover: the auto-hide clock holds what is left and resumes with only that", () => {
    let c = clockStart(6_000, 1_000);
    c = clockPause(c, 3_000); // hovered after 2s
    expect(c).toEqual({ remaining: 4_000 });
    expect(clockPause(c, 9_000)).toEqual({ remaining: 4_000 }); // paused stays paused
    c = clockResume(c, 20_000); // left 17s later: still 4s to go
    expect(c).toEqual({ remaining: 4_000, since: 20_000 });
    expect(clockResume(c, 21_000)).toBe(c);
    expect(clockStart(6_000, 0, true)).toEqual({ remaining: 6_000 }); // arrives while hovered: waits
    expect(clockPause(clockStart(1_000, 0), 5_000).remaining).toBe(0);
  });

  test("anchored bottom-left, its foot just above the bell; full width above the bottom bar on a phone", () => {
    const viewport = { width: 1440, height: 900 };
    const bell = { left: 180, top: 852, width: 32 };
    expect(stackAnchor(bell, { left: 0 }, viewport, false)).toEqual({ left: 8, bottom: 900 - 852 + 8 });
    // The sidebar collapsed: the bell moves up the column; the stack follows it.
    expect(stackAnchor({ left: 12, top: 812, width: 32 }, { left: 0 }, viewport, false)).toEqual({ left: 8, bottom: 96 });
    // Never off the right edge of a small window.
    expect(stackAnchor(bell, { left: 400 }, { width: 500, height: 900 }, false).left).toBe(500 - TOAST_WIDTH - 8);
    expect(stackAnchor(bell, { left: 0 }, viewport, true)).toEqual({ left: 16, right: 16, bottom: 64 + 16 });
    expect(stackAnchor(undefined, undefined, viewport, false, 70)).toEqual({ left: 16, right: 16, bottom: 86 }); // no bell on screen
  });

  test("the action is named for where it goes: the workstream, a GitHub PR, a preview, the orchestrator", () => {
    expect(notificationAction({})).toBe("Open workstream");
    expect(notificationAction({ link: { pr: 7 } })).toBe("Open workstream"); // the agent page of its PR, not GitHub
    expect(notificationAction({ link: { url: "https://github.com/acme/app/pull/7" } })).toBe("View PR");
    expect(notificationAction({ link: { url: "http://orca-box:4000" } })).toBe("Open preview");
    expect(notificationAction({ link: { orchestrator: true } })).toBe("Open orchestrator");
  });
});
