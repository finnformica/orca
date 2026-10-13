// The notification centre in the browser (components/Notifications.tsx + lib/notificationStore.ts):
// the bell's unread count from the catch-up fetch; a push on the tab's one stream popping a Geist
// toast bottom-left, just above the bell; the stack (branch-demo's / sonner's) collapsing past one
// over a count bar, three showing, spreading on hover (and the count bar's toggle), the auto-hide
// pausing while hovered, a swipe dismissing, removed cards playing their exit; Clear all; a
// finished toast hiding itself while a needs-input one stays; do-not-disturb and a kind switched off
// in Settings; the centre's panel grouped by day, a click marking read and opening the thing, Mark
// all read, Clear all.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import { notifyDndAtom, toastPrefsAtom } from "@/lib/atoms";
import * as centre from "@/lib/notificationStore";
import { COUNT_BAR_SPACE, TOAST_EXIT_MS, type Notification } from "../shared/notifications";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type FakeSource = EventTarget & { url: string };
const opened = () => (globalThis as unknown as { EventSource: { opened: FakeSource[] } }).EventSource.opened;
const emit = (s: FakeSource, name: string, data: unknown) => s.dispatchEvent(Object.assign(new Event(name), { data: JSON.stringify(data) }));

let root: Root | undefined;
let container: HTMLElement | undefined;
let nextId = 100;
const note = (over: Partial<Notification> = {}): Notification => ({
  id: nextId++, instance: "laptop", repo: "r", branch: "feat-x", kind: "finished", title: "Login form", body: "Form built.", createdAt: Date.now(), ...over,
});

async function open(path = "/") {
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
}
/** The tab's stream, told it is live (so a push can follow). */
async function live(): Promise<FakeSource> {
  const s = opened().at(-1)!;
  await act(async () => { emit(s, "ready", {}); await flush(); });
  return s;
}
const push = async (s: FakeSource, n: Notification) => act(async () => { emit(s, "notification", n); await flush(); });
const $ = (slot: string) => document.body.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
const $$ = (slot: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)];
/** The cards still on the stack (a removed one plays its exit for TOAST_EXIT_MS first). */
const cards = () => $$("notification-toast").filter((t) => t.getAttribute("data-removed") !== "true");
const exit = () => act(async () => { await wait(TOAST_EXIT_MS + 30); });
const mouse = async (el: Element, type: "mousemove" | "mouseover" | "mouseout", relatedTarget?: Element) =>
  act(async () => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: relatedTarget ?? null })); await flush(); });
const pointer = async (el: Element, type: string, x: number, y: number) =>
  act(async () => { el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 })); await flush(); });
/** Give the bell and the sidebar's foot a layout (happy-dom has none), as a 900px-high desktop. */
function placeBell(bell = { left: 180, top: window.innerHeight - 48 }) {
  const rect = (r: { left: number; top: number; width: number; height: number }) => () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} }) as DOMRect;
  $("notifications-bell")!.getBoundingClientRect = rect({ ...bell, width: 32, height: 32 });
  $("sidebar-foot")!.getBoundingClientRect = rect({ left: 0, top: bell.top - 8, width: 240, height: 48 });
}
const click = async (el: Element | null | undefined) => act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });

describe("the notification centre", () => {
  beforeAll(() => store.configReady);
  beforeEach(() => { apiFake.reset(); centre.reset(); centre.toastTiming.autoHideMs = 40; });
  afterEach(async () => {
    act(() => root?.unmount());
    container?.remove();
    root = container = undefined;
    centre.reset();
    apiFake.reset();
    getDefaultStore().set(notifyDndAtom, false);
    getDefaultStore().set(toastPrefsAtom, {});
    localStorage.clear();
    navigate("/");
  });

  test("the bell counts the unread rows from the catch-up fetch; loading pops no toasts", async () => {
    apiFake.notificationsData = [note({ kind: "needs_input" }), note({ kind: "failed" }), note({ readAt: Date.now() })];
    await open("/");
    expect($("notifications-unread")!.textContent).toBe("2");
    expect($("notifications-bell")!.getAttribute("aria-label")).toBe("Notifications (2 unread)");
    expect($("notification-host")).toBeNull();
    expect(apiFake.notificationFetches).toEqual([undefined]);
  });

  test("a push on the tab's one stream pops a Geist toast: icon, title, kind, body, time, Open, dismiss", async () => {
    await open("/");
    const s = await live();
    expect(s.url).toBe("/api/events"); // the same stream the chats share — not a second connection
    await push(s, note({ kind: "needs_input", body: "Should I migrate the old rows?" }));
    const toast = $("notification-toast")!;
    expect(toast.className).toContain("rounded-lg");
    expect(toast.className).toContain("shadow-menu"); // the menu shadow, the only one allowed
    expect(toast.className).not.toMatch(/border-2/);
    expect(toast.textContent).toContain("Login form");
    expect(toast.textContent).toContain("Needs input");
    expect(toast.textContent).toContain("Should I migrate the old rows?");
    expect(toast.querySelector('[data-slot="notification-time"]')!.textContent).toContain("just now");
    expect($("notifications-unread")!.textContent).toBe("1"); // the centre has it too
    expect([...toast.querySelectorAll("button")].map((b) => b.textContent)).toContain("Open workstream");
    await click(toast.querySelector('button[aria-label="Dismiss"]'));
    expect(toast.getAttribute("data-removed")).toBe("true"); // dropping out…
    await exit();
    expect($("notification-toast")).toBeNull(); // …then gone
    expect($("notifications-unread")!.textContent).toBe("1"); // dismissing the toast keeps the row
  });

  test("bottom-left, its foot just above the bell; the stack collapsed past one over a count bar, three showing; hover spreads it; Clear all", async () => {
    await open("/");
    placeBell();
    const s = await live();
    await push(s, note({ id: 1, title: "First", kind: "failed", createdAt: Date.now() - 3 }));
    const host = $("notification-host")!;
    const bellTop = $("notifications-bell")!.getBoundingClientRect().top;
    expect(host.style.left).toBe("8px"); // the sidebar foot's padding: the left-hand side, not the right
    expect(host.style.right).toBe("");
    expect(host.style.bottom).toBe(`${window.innerHeight - bellTop + 8}px`); // just above the bell
    await push(s, note({ id: 2, title: "Second", kind: "failed", createdAt: Date.now() - 2 }));
    await push(s, note({ id: 3, title: "Third", kind: "failed", createdAt: Date.now() - 1 }));
    await push(s, note({ id: 4, title: "Fourth", kind: "failed" }));
    // The count bar takes the bell's spot and the stack sits on it.
    const bar = $("notification-count")!;
    expect(bar.style.bottom).toBe(`${window.innerHeight - bellTop + 8}px`);
    expect(host.style.bottom).toBe(`${window.innerHeight - bellTop + 8 + COUNT_BAR_SPACE}px`);
    expect(bar.textContent).toContain("4 notifications");
    const stacked = cards();
    const byTitle = (t: HTMLElement) => t.querySelector(".font-medium")!.textContent;
    const front = stacked.find((t) => t.getAttribute("data-front") === "true")!;
    expect(byTitle(front)).toBe("Fourth"); // newest in front
    expect(stacked.filter((t) => t.getAttribute("data-visible") === "true").map(byTitle).sort()).toEqual(["Fourth", "Second", "Third"]); // three show
    expect(stacked.find((t) => byTitle(t) === "First")!.getAttribute("aria-hidden")).toBe("true"); // the fourth waits
    expect(stacked.every((t) => t.getAttribute("data-expanded") === "false")).toBe(true);
    expect(stacked.find((t) => t.getAttribute("data-index") === "1")!.style.getPropertyValue("--y")).toContain("scale(0.95)"); // lifted, smaller
    // Hover spreads the stack and holds every auto-hide clock; leaving collapses it again.
    await mouse(front, "mousemove");
    expect(cards().every((t) => t.getAttribute("data-expanded") === "true")).toBe(true);
    expect(centre.toastsPaused()).toBe(true);
    await mouse(front, "mouseout", document.body);
    expect(cards().every((t) => t.getAttribute("data-expanded") === "false")).toBe(true);
    expect(centre.toastsPaused()).toBe(false);
    // The count bar's toggle does the same, for a keyboard or a finger.
    await click(bar.querySelector("button[aria-expanded]"));
    expect(cards().every((t) => t.getAttribute("data-expanded") === "true")).toBe(true);
    await click([...bar.querySelectorAll("button")].find((b) => b.textContent === "Clear all")!);
    expect(cards()).toHaveLength(0);
    await exit();
    expect($("notification-host")).toBeNull();
    expect($("notifications-unread")!.textContent).toBe("4"); // Clear all is the stack, not the centre
  });

  test("auto-hide pauses while the stack is hovered and resumes when the pointer leaves; a swipe left dismisses", async () => {
    await open("/");
    const s = await live();
    await push(s, note({ id: 20, kind: "finished", title: "Quick" }));
    const card = cards()[0]!;
    await mouse(card, "mousemove");
    await act(async () => { await wait(90); }); // past the 40ms auto-hide: held
    expect(cards()).toHaveLength(1);
    await mouse(card, "mouseout", document.body);
    await act(async () => { await wait(90); });
    expect(cards()).toHaveLength(0); // the clock ran out once you looked away
    await exit();
    await push(s, note({ id: 21, kind: "failed", title: "Swipe me" }));
    const swiped = cards()[0]!;
    const body = swiped.querySelector('[data-slot="notification-time"]')!;
    await pointer(body, "pointerdown", 200, 500);
    await pointer(body, "pointermove", 150, 501);
    await pointer(body, "pointermove", 140, 501);
    await pointer(body, "pointerup", 140, 501);
    expect(swiped.getAttribute("data-swipe-out")).toBe("left");
    expect(cards()).toHaveLength(0);
    expect($("notifications-unread")!.textContent).toBe("2"); // a swipe is a dismiss: the centre keeps it
  });

  test("a finished toast hides itself; a needs-input or failed one stays until dismissed", async () => {
    await open("/");
    const s = await live();
    await push(s, note({ kind: "finished", title: "Quick" }));
    await push(s, note({ kind: "needs_input", title: "Waiting" }));
    expect(cards()).toHaveLength(2);
    await act(async () => { await wait(90); });
    expect(cards().map((t) => t.getAttribute("data-kind"))).toEqual(["needs_input"]);
    await act(async () => { await wait(90); });
    expect(cards()).toHaveLength(1); // still there
  });

  test("do-not-disturb and a kind switched off in Settings silence the toast; the centre still fills; a stale catch-up never pops", async () => {
    await open("/settings");
    const s = await live();
    const kinds = $("notification-kinds")!;
    const finished = [...kinds.querySelectorAll("label")].find((l) => l.textContent!.includes("Finished"))!.querySelector("input")!;
    await act(async () => { finished.click(); await flush(); });
    expect(getDefaultStore().get(toastPrefsAtom)).toEqual({ finished: false });
    await push(s, note({ kind: "finished" }));
    expect($("notification-host")).toBeNull();
    await push(s, note({ kind: "failed" }));
    expect($$("notification-toast")).toHaveLength(1);
    await act(async () => { centre.clearToasts(); await flush(); });
    await exit();
    await act(async () => { getDefaultStore().set(notifyDndAtom, true); await flush(); });
    await push(s, note({ kind: "needs_input" }));
    expect($("notification-host")).toBeNull();
    expect($("notifications-unread")!.textContent).toBe("3");
    await act(async () => { getDefaultStore().set(notifyDndAtom, false); await flush(); });
    await push(s, note({ kind: "needs_input", createdAt: Date.now() - 3_600_000 })); // an hour old: the centre, not the corner
    expect($("notification-host")).toBeNull();
    expect($("notifications-unread")!.textContent).toBe("4");
  });

  test("the panel: grouped by day with unread marks and a kind filter; a click marks read and opens; Mark all read; Clear all", async () => {
    const now = Date.now();
    apiFake.notificationsData = [
      note({ id: 1, kind: "needs_input", title: "Today's question", createdAt: now - 60_000 }),
      note({ id: 2, kind: "pr_ci_failed", title: "Yesterday's CI", createdAt: now - 26 * 3_600_000, link: { pr: 7 }, readAt: now }),
      note({ id: 3, kind: "preview_ready", title: "Older preview", createdAt: now - 5 * 86_400_000, link: { url: "http://box:4000" } }),
    ];
    await open("/");
    await click($("notifications-bell"));
    const panel = $("notification-centre")!;
    expect($$("notification-group").map((g) => g.querySelector("h4")!.textContent)).toEqual(["Today", "Yesterday", expect.stringMatching(/\w{3} \d+ \w{3}/)]);
    expect($$("notification-row").filter((r) => r.hasAttribute("data-unread"))).toHaveLength(2);
    expect(panel.textContent).toContain("2 unread");
    // The kind filter: only that kind, with its count on the chip.
    const chip = [...panel.querySelectorAll<HTMLButtonElement>('[data-slot="notification-filter"] button')].find((b) => b.textContent!.includes("CI failing"))!;
    expect(chip.textContent).toContain("1");
    await click(chip);
    expect($$("notification-row")).toHaveLength(1);
    await click(chip); // off again
    expect($$("notification-row")).toHaveLength(3);
    // A click marks the row read and opens it: the PR page for a PR event…
    await click($$("notification-row").find((r) => r.textContent!.includes("Yesterday's CI")));
    expect(location.pathname).toBe("/r/prs/7");
    expect(apiFake.notificationCalls.at(-1)).toEqual({ verb: "read", ids: [2] });
    // …the workstream's page otherwise (no live row for it: its local page).
    await click($$("notification-row").find((r) => r.textContent!.includes("Today's question")));
    expect(location.pathname).toBe("/r/local/feat-x");
    expect(apiFake.notificationCalls.at(-1)).toEqual({ verb: "read", ids: [1] });
    expect($$("notification-row").filter((r) => r.hasAttribute("data-unread"))).toHaveLength(1);
    await click(panel.querySelector('button[aria-label="Mark all read"]'));
    expect(apiFake.notificationCalls.at(-1)).toEqual({ verb: "read", ids: "all" });
    expect($$("notification-row").filter((r) => r.hasAttribute("data-unread"))).toHaveLength(0);
    expect($("notifications-unread")).toBeNull();
    await click([...panel.querySelectorAll("button")].find((b) => b.textContent === "Clear all"));
    expect(apiFake.notificationCalls.at(-1)).toEqual({ verb: "dismiss", ids: "all" });
    expect($$("notification-row")).toHaveLength(0);
    expect(panel.textContent).toContain("No notifications yet.");
  });

  test("a toast's Open workstream takes you to the workstream's page (its PR's agent page, not GitHub) and marks it read; the centre's DND toggle", async () => {
    await open("/");
    const s = await live();
    await push(s, note({ id: 9, kind: "failed" }));
    await click([...$("notification-toast")!.querySelectorAll("button")].find((b) => b.textContent === "Open workstream"));
    expect(location.pathname).toBe("/r/local/feat-x");
    expect(apiFake.notificationCalls).toEqual([{ verb: "read", ids: [9] }]);
    expect(cards()).toHaveLength(0);
    // A PR's CI failing is the workstream too — its agent page, worded as such, not "Open PR".
    await push(s, note({ id: 10, kind: "pr_ci_failed", link: { pr: 7 } }));
    await click([...cards()[0]!.querySelectorAll("button")].find((b) => b.textContent === "Open workstream"));
    expect(location.pathname).toBe("/r/prs/7");
    await click($("notifications-bell"));
    await click(document.body.querySelector('button[aria-label="Do not disturb"]'));
    expect(getDefaultStore().get(notifyDndAtom)).toBe(true);
    expect(document.body.querySelector('[data-slot="notification-centre"] button[aria-pressed="true"]')).not.toBeNull();
  });

  test("a dropped stream catches up from the centre's cursor on reconnect, and what arrived meanwhile pops", async () => {
    apiFake.notificationsData = [note({ id: 50, createdAt: Date.now() - 5_000 })];
    await open("/");
    const first = await live();
    expect(apiFake.notificationFetches).toEqual([undefined]);
    // The stream reconnects (a second `ready` on the same source): fetch since the newest known row.
    apiFake.notificationsData.push(note({ id: 51, kind: "failed", title: "While away" }));
    await act(async () => { emit(first, "ready", {}); await flush(); await flush(); });
    expect(apiFake.notificationFetches.at(-1)).toBe(apiFake.notificationsData[0]!.createdAt as number);
    expect(cards()[0]!.textContent).toContain("While away");
    expect($("notifications-unread")!.textContent).toBe("2");
  });
});
