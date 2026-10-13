// The notification centre in the browser (components/Notifications.tsx + lib/notificationStore.ts):
// the bell's unread count from the catch-up fetch; a push on the tab's one stream popping a Geist
// toast bottom-left, just above the bell; the stack (branch-demo's / sonner's) collapsing past one
// over a count bar, three showing, spreading on hover (and the count bar's toggle), the auto-hide
// pausing while hovered, a swipe marking read, removed cards playing their exit; the count bar's
// Mark all as read; a finished toast hiding itself (still unread) while a needs-input one stays;
// do-not-disturb and a kind switched off in Settings; the centre's panel — Unread by default and
// remembered, All showing the read ones, grouped by day, a click marking read and opening the thing,
// the × marking read, Mark all as read. Nothing is ever cleared: there is no Clear anywhere.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import { notifyDndAtom, orchestratorOpenAtom, toastPrefsAtom } from "@/lib/atoms";
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
/** A button by its text, or an icon button (no text) by its aria-label. */
const button = (el: Element, text: string) => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent || b.getAttribute("aria-label")) === text);
const actionsOf = (el: Element) => el.querySelector<HTMLElement>('[data-slot="notification-actions"]')!;
/** The quick actions, by aria-label: icon buttons, so no text of their own. */
const actionLabels = (el: Element) => [...actionsOf(el).querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
/** A touch screen: `(pointer: coarse)` matches (and nothing else does). */
function touchScreen(): () => void {
  const was = window.matchMedia;
  window.matchMedia = ((q: string) => ({ matches: q === "(pointer: coarse)", media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  return () => { window.matchMedia = was; };
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
    getDefaultStore().set(orchestratorOpenAtom, false); // "Open orchestrator" opens it; the store outlives this file
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

  test("a push on the tab's one stream pops a Geist toast: icon, title, kind, body, time, Open; its × marks it read", async () => {
    await open("/");
    const s = await live();
    expect(s.url).toBe("/api/events"); // the same stream the chats share — not a second connection
    const asked = note({ kind: "needs_input", body: "Should I migrate the old rows?" });
    await push(s, asked);
    const toast = $("notification-toast")!;
    expect(toast.className).toContain("rounded-lg");
    expect(toast.className).toContain("shadow-menu"); // the menu shadow, the only one allowed
    expect(toast.className).not.toMatch(/border-2/);
    expect(toast.textContent).toContain("Login form");
    expect(toast.textContent).toContain("Needs input");
    expect(toast.textContent).toContain("Should I migrate the old rows?");
    expect(toast.querySelector('[data-slot="notification-time"]')!.textContent).toContain("just now");
    expect($("notifications-unread")!.textContent).toBe("1"); // the centre has it too
    expect(actionLabels(toast)).toContain("Open");
    await click(toast.querySelector('button[aria-label="Mark as read"]'));
    expect(toast.getAttribute("data-removed")).toBe("true"); // dropping out…
    await exit();
    expect($("notification-toast")).toBeNull(); // …then gone
    expect(apiFake.notificationCalls).toEqual([{ verb: "read", ids: [asked.id] }]);
    expect($("notifications-unread")).toBeNull(); // the × is "read": the bell counts unread only…
    await click($("notifications-bell"));
    expect($$("notification-row")).toHaveLength(0); // …the centre's default Unread view drops it…
    await click(button($("notification-centre")!, "All"));
    expect($$("notification-row")).toHaveLength(1); // …and All still has it, read
    expect($("notification-row")!.hasAttribute("data-unread")).toBe(false);
  });

  test("the toast and the centre row carry the repo as a muted label before the title; the orchestrator's own notifications have none", async () => {
    await open("/");
    const s = await live();
    await push(s, note({ id: 80, repo: "branch-demo", title: "Fix login" }));
    const toast = cards()[0]!;
    expect(toast.querySelector('[data-slot="notification-repo"]')!.textContent).toBe("branch-demo");
    await click($("notifications-bell"));
    await click(button($("notification-centre")!, "All"));
    const row = $$("notification-row").find((r) => r.textContent!.includes("Fix login"))!;
    expect(row.querySelector('[data-slot="notification-repo"]')!.textContent).toBe("branch-demo");
    await push(s, note({ id: 81, repo: "@orca", branch: "orchestrator", title: "Orchestrator", link: { orchestrator: true } }));
    const orchestratorToast = $$("notification-toast").find((t) => t.textContent!.includes("Orchestrator"))!;
    expect(orchestratorToast.querySelector('[data-slot="notification-repo"]')).toBeNull();
    const orchestratorRow = $$("notification-row").find((r) => r.textContent!.includes("Orchestrator"))!;
    expect(orchestratorRow.querySelector('[data-slot="notification-repo"]')).toBeNull();
  });

  test("bottom-left, its foot just above the bell; the stack collapsed past one over a count bar, three showing; hover spreads it; Mark all as read", async () => {
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
    expect(bar.textContent).not.toContain("Clear");
    await click(button(bar, "Mark all as read"));
    expect(cards()).toHaveLength(0);
    expect(apiFake.notificationCalls).toEqual([{ verb: "read", ids: [1, 2, 3, 4] }]); // the stacked ones
    await exit();
    expect($("notification-host")).toBeNull();
    expect($("notifications-unread")).toBeNull(); // read, not deleted: All still lists them
    await click($("notifications-bell"));
    await click(button($("notification-centre")!, "All"));
    expect($$("notification-row")).toHaveLength(4);
  });

  test("the stack and its count bar sit above the sidebar, which is also fixed and would otherwise paint over a toast anchored above the bell", async () => {
    await open("/");
    placeBell();
    const s = await live();
    const zOf = (el: Element) => Number([...el.className.matchAll(/\bz-\[?(\d+)\]?\b/g)].at(-1)?.[1]);
    const sidebar = $("sidebar")!;
    expect(zOf(sidebar)).toBe(50); // the fixed sidebar's own layer (Shell.tsx)
    await push(s, note({ id: 1, title: "First" }));
    expect(zOf($("notification-host")!)).toBeGreaterThan(zOf(sidebar));
    await push(s, note({ id: 2, title: "Second" }));
    expect(zOf($("notification-count")!)).toBeGreaterThan(zOf(sidebar)); // the count bar too, once it shows
  });

  test("auto-hide pauses while the stack is hovered and resumes when the pointer leaves; a swipe left marks read", async () => {
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
    // The auto-hidden one is still unread; the swiped one is read (a swipe is the ×).
    expect($("notifications-unread")!.textContent).toBe("1");
    expect(apiFake.notificationCalls).toEqual([{ verb: "read", ids: [21] }]);
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
    const failed = note({ kind: "failed" });
    await push(s, failed);
    expect($$("notification-toast")).toHaveLength(1);
    await act(async () => { centre.dismissToast(failed.id); await flush(); });
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

  test("the panel: one compact header, Unread by default (remembered), All shows the read ones; grouped by day; a click marks read and opens; Mark all as read; no Clear", async () => {
    const now = Date.now();
    apiFake.notificationsData = [
      note({ id: 1, kind: "needs_input", title: "Today's question", createdAt: now - 60_000 }),
      note({ id: 2, kind: "pr_ci_failed", title: "Yesterday's CI", createdAt: now - 26 * 3_600_000, link: { pr: 7 }, readAt: now }),
      note({ id: 3, kind: "preview_ready", title: "Older preview", createdAt: now - 5 * 86_400_000, link: { url: "http://box:4000" } }),
    ];
    await open("/");
    await click($("notifications-bell"));
    const panel = $("notification-centre")!;
    const header = panel.querySelector("header")!;
    // The header: title, Unread (its count) / All, Mark all as read — nothing else — padded evenly
    // (one p-3 on every side, not a separate py/px split) rather than pinned to a fixed height; its
    // toggle and button are already the design system's compact size (h-7 / size-7).
    expect(header.className).toContain("p-3");
    expect(header.className).not.toMatch(/\bpy-\d|\bpx-\d|\bpr-\d|\bpl-\d/);
    expect(header.className).not.toMatch(/\bh-\d|\bmin-h-/);
    const markRead = header.querySelector<HTMLElement>('[aria-label="Mark all as read"]')!;
    expect(markRead.className).toContain("size-7");
    expect(header.querySelector("h3")!.textContent).toBe("Notifications");
    const seg = header.querySelector<HTMLElement>('[role="group"]')!;
    expect(seg.className).toContain("h-7"); // the toggle's own compact size, not forced taller by the header
    expect([...seg.querySelectorAll("button")].map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([["Unread2", "true"], ["All", "false"]]);
    expect([...header.querySelectorAll("button")].map((b) => b.textContent || b.getAttribute("aria-label"))).toEqual(["Unread2", "All", "Mark all as read"]);
    // The unread count is a keycap-styled chip, the same shared Kbd component as a shortcut hint.
    const unreadCount = header.querySelector('[data-slot="notification-unread-count"]')!;
    expect(unreadCount.tagName).toBe("KBD");
    expect(unreadCount.getAttribute("data-slot")).toBe("notification-unread-count"); // not just a <Kbd>'s own default
    expect(panel.querySelector('[data-slot="notification-filter"]')).toBeNull(); // the per-kind chips are gone
    expect(panel.textContent).not.toMatch(/Clear/);
    // Unread: the read row is out of view.
    expect($$("notification-row").map((r) => r.textContent!.includes("Yesterday's CI"))).toEqual([false, false]);
    expect($$("notification-group").map((g) => g.querySelector("h4")!.textContent)).toEqual(["Today", expect.stringMatching(/\w{3} \d+ \w{3}/)]);
    // The sticky day header is opaque (bg-card) AND raised above the rows (z-10) — a row's own
    // `position: relative` (for its absolute quick-actions strip) would otherwise paint over a
    // merely-opaque sticky header once scrolled underneath it.
    const dayHeader = $$("notification-group")[0]!.querySelector("h4")!;
    expect(dayHeader.className).toContain("bg-card");
    expect(dayHeader.className).toContain("z-10");
    // All: every row, read ones dimmed, grouped by day; the choice is remembered.
    await click(button(panel, "All"));
    expect($$("notification-group").map((g) => g.querySelector("h4")!.textContent)).toEqual(["Today", "Yesterday", expect.stringMatching(/\w{3} \d+ \w{3}/)]);
    expect($$("notification-row").filter((r) => r.hasAttribute("data-unread"))).toHaveLength(2);
    expect(localStorage.getItem("orca.ui.v1.notificationFilter")).toBe('"all"');
    // A click marks the row read and opens it: the PR's Chat tab for a PR event…
    await click($$("notification-row").find((r) => r.textContent!.includes("Yesterday's CI")));
    expect(location.pathname + location.search).toBe("/r/prs/7/chat?reply=1");
    expect(apiFake.notificationCalls.at(-1)).toEqual({ verb: "read", ids: [2] });
    // …the workstream's Chat tab otherwise (no live row for it: its local page's).
    await click($$("notification-row").find((r) => r.textContent!.includes("Today's question")));
    expect(location.pathname + location.search).toBe("/r/local/feat-x/chat?reply=1");
    expect(apiFake.notificationCalls.at(-1)).toEqual({ verb: "read", ids: [1] });
    expect($$("notification-row").filter((r) => r.hasAttribute("data-unread"))).toHaveLength(1);
    expect($$("notification-row")).toHaveLength(3); // read under All, still listed
    await click(panel.querySelector('button[aria-label="Mark all as read"]'));
    expect(apiFake.notificationCalls.at(-1)).toEqual({ verb: "read", ids: "all" });
    expect($$("notification-row").filter((r) => r.hasAttribute("data-unread"))).toHaveLength(0);
    expect($$("notification-row")).toHaveLength(3);
    expect($("notifications-unread")).toBeNull();
    expect(panel.querySelector<HTMLButtonElement>('button[aria-label="Mark all as read"]')!.disabled).toBe(true);
    await click(button(panel, "Unread"));
    expect($$("notification-row")).toHaveLength(0);
    expect(panel.textContent).toContain("You're all caught up.");
  });

  test("the centre opens on Unread by default, and on the filter you last chose", async () => {
    apiFake.notificationsData = [note({ id: 70, readAt: Date.now(), title: "Seen" })];
    await open("/");
    await click($("notifications-bell"));
    expect(button($("notification-centre")!, "Unread")!.getAttribute("aria-pressed")).toBe("true");
    expect($$("notification-row")).toHaveLength(0);
    act(() => root?.unmount());
    container?.remove();
    centre.reset();
    localStorage.setItem("orca.ui.v1.notificationFilter", '"all"');
    await open("/");
    await click($("notifications-bell"));
    expect(button($("notification-centre")!, "All")!.getAttribute("aria-pressed")).toBe("true");
    expect($$("notification-row").map((r) => r.textContent!.includes("Seen"))).toEqual([true]);
  });

  test("a toast's title opens the workstream's Chat tab, composer focused (its PR's agent page, not GitHub) and marks it read; Open too", async () => {
    await open("/");
    const s = await live();
    await push(s, note({ id: 9, kind: "failed" }));
    await click($("notification-title"));
    expect(location.pathname + location.search).toBe("/r/local/feat-x/chat?reply=1");
    expect(apiFake.notificationCalls).toEqual([{ verb: "read", ids: [9] }]);
    expect(cards()).toHaveLength(0);
    // A PR's CI failing is the workstream too — its agent page, not GitHub.
    await push(s, note({ id: 10, kind: "pr_ci_failed", link: { pr: 7 } }));
    await click(cards()[0]!.querySelector('[data-slot="notification-title"]'));
    expect(location.pathname + location.search).toBe("/r/prs/7/chat?reply=1");
    navigate("/");
    await push(s, note({ id: 11, kind: "needs_input" })); // a toast that stays (a finished one auto-hides in the test's 40ms)
    await click(button(cards()[0]!, "Open"));
    expect(location.pathname + location.search).toBe("/r/local/feat-x/chat?reply=1");
    expect(apiFake.notificationCalls.at(-1)).toEqual({ verb: "read", ids: [11] });
  });

  test("a dropped stream catches up from the centre's cursor on reconnect, and what arrived meanwhile pops", async () => {
    apiFake.notificationsData = [note({ id: 50, createdAt: Date.now() - 5_000 })];
    await open("/");
    const first = await live();
    // The load, then the first `ready` catching up from its cursor (a row written between the two
    // would otherwise be missed until the next gap).
    expect(apiFake.notificationFetches).toEqual([undefined, apiFake.notificationsData[0]!.createdAt as number]);
    // The stream reconnects (a second `ready` on the same source): fetch since the newest known row.
    apiFake.notificationsData.push(note({ id: 51, kind: "failed", title: "While away" }));
    await act(async () => { emit(first, "ready", {}); await flush(); await flush(); });
    expect(apiFake.notificationFetches.at(-1)).toBe(apiFake.notificationsData[0]!.createdAt as number);
    expect(cards()[0]!.textContent).toContain("While away");
    expect($("notifications-unread")!.textContent).toBe("2");
  });

  test("quick actions: hovering a CI-failed toast shows Address PR + View PR; Address PR marks it read and clears the toast at once, the launch runs after", async () => {
    apiFake.prsData = [{ number: 7, title: "Red CI", branch: "feat-x", url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: false, ciStatus: "failing", failingChecks: ["test"], reviewStatus: "none", mergeable: "MERGEABLE", autoMergeEnabled: false }];
    await open("/");
    const s = await live();
    await push(s, note({ id: 30, kind: "pr_ci_failed", title: "Red CI", link: { pr: 7 } }));
    const toast = cards()[0]!;
    expect(actionsOf(toast).getAttribute("data-shown")).toBe("false"); // a mouse: hidden until hover
    await mouse(toast, "mousemove");
    expect(actionsOf(toast).getAttribute("data-shown")).toBe("true");
    expect(actionLabels(toast)).toEqual(["Address PR", "View PR", "Open"]);
    // Icon buttons: size-7 ghost, no text, each with its tooltip.
    for (const b of actionsOf(toast).querySelectorAll("button")) {
      expect(b.textContent).toBe("");
      expect(b.className).toContain("size-7");
      expect(b.querySelector("svg.lucide")).not.toBeNull();
    }
    expect([...actionsOf(toast).querySelectorAll('[role="tooltip"]')].map((t) => t.textContent)).toEqual(["Address PR", "View PR", "Open"]);
    // The launch is held: the click still marks it read and clears the toast immediately, before
    // the launch (the "request") resolves — optimistic, not waited on.
    apiFake.holdClaude = true;
    await click(button(toast, "Address PR"));
    // Marked read and the toast gone at once — the launch is still blocked on releaseClaude below,
    // so neither can have waited on it.
    expect(apiFake.notificationCalls).toContainEqual({ verb: "read", ids: [30] });
    expect(cards()).toHaveLength(0);
    expect(apiFake.calls.some((c) => c.startsWith("agent:"))).toBe(true); // fired in the background…
    await act(async () => { apiFake.releaseClaude!(); await flush(); await flush(); await flush(); }); // …and only now resolves
    expect(apiFake.claudePrompts.at(-1)).toContain("#7");
  });

  test("a quick action's failed launch is a failed-action card in the same stack with why, and puts the notification back as unread", async () => {
    apiFake.prsData = [{ number: 7, title: "Red CI", branch: "feat-x", url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: false, ciStatus: "failing", failingChecks: ["test"], reviewStatus: "none", mergeable: "MERGEABLE", autoMergeEnabled: false }];
    apiFake.claudeError = "worktree busy";
    await open("/");
    const s = await live();
    await push(s, note({ id: 31, kind: "pr_ci_failed", title: "Red CI", link: { pr: 7 } }));
    const toast = cards()[0]!;
    await mouse(toast, "mousemove");
    await click(button(toast, "Address PR"));
    // Closed and marked read at once, same as success…
    expect(cards().filter((c) => c.dataset.kind === "pr_ci_failed")).toHaveLength(0);
    expect(apiFake.notificationCalls).toContainEqual({ verb: "read", ids: [31] });
    await act(async () => { await flush(); await flush(); await flush(); });
    // …but the launch rejected: a failed-action card in the SAME stack names the action and why
    // (no second stack), and the notification is unread again (the centre, and the bell's count —
    // now two: it and the failure — both see it).
    expect($("toast")).toBeNull();
    const errToast = cards().find((c) => c.dataset.kind === "action_failed")!;
    expect(errToast.textContent).toContain("Address PR failed");
    expect(errToast.textContent).toContain("worktree busy");
    expect($("notifications-unread")!.textContent).toBe("2");
    expect(apiFake.notificationCalls.filter((c) => c.verb === "read")).toEqual([{ verb: "read", ids: [31] }]); // the failure is local
    await click($("notifications-bell"));
    expect($$("notification-row").some((r) => r.textContent!.includes("Red CI"))).toBe(true);
    expect($$("notification-row").some((r) => r.dataset.kind === "action_failed")).toBe(true);
  });

  test("quick actions on a touch screen show without hover; there is no Read — the × marks it read and takes the toast off the stack", async () => {
    const restore = touchScreen();
    try {
      await open("/");
      const s = await live();
      await push(s, note({ id: 40, kind: "needs_input", title: "Question" }));
      const toast = cards()[0]!;
      expect(actionsOf(toast).getAttribute("data-shown")).toBe("true");
      expect(actionLabels(toast)).toEqual(["Reply", "Open"]);
      await click(toast.querySelector('button[aria-label="Mark as read"]'));
      expect(apiFake.notificationCalls).toEqual([{ verb: "read", ids: [40] }]);
      expect(cards()).toHaveLength(0);
      expect($("notifications-unread")).toBeNull();
    } finally { restore(); }
  });

  test("Reply opens the agent page's Chat tab with its composer focused", async () => {
    await open("/");
    const s = await live();
    await push(s, note({ id: 41, kind: "needs_input", title: "Question" }));
    await click(button(cards()[0]!, "Reply"));
    expect(location.pathname + location.search).toBe("/r/local/feat-x/chat?reply=1");
  });

  test("the centre's rows carry the same quick actions on hover: a kind's verbs and, while unread, the × — which marks read, hides it from Unread, and leaves it under All", async () => {
    apiFake.notificationsData = [note({ id: 60, kind: "failed", title: "Broke" })];
    await open("/");
    await click($("notifications-bell"));
    const row = $("notification-row")!.closest("li")!;
    expect(actionsOf(row).getAttribute("data-shown")).toBe("false");
    await mouse(row, "mousemove");
    expect(actionsOf(row).getAttribute("data-shown")).toBe("true");
    expect(actionLabels(row)).toEqual(["Open chat", "Open", "Mark as read"]);
    await click(actionsOf(row).querySelector('button[aria-label="Mark as read"]'));
    expect(apiFake.notificationCalls).toEqual([{ verb: "read", ids: [60] }]);
    expect($$("notification-row")).toHaveLength(0); // out of the Unread view…
    expect($("notifications-unread")).toBeNull();
    await click(button($("notification-centre")!, "All"));
    const kept = $("notification-row")!; // …never deleted
    expect(kept.hasAttribute("data-unread")).toBe(false);
    expect(actionsOf(kept.closest("li")!).querySelector('button[aria-label="Mark as read"]')).toBeNull(); // read: nothing to ×
    expect(actionLabels(kept.closest("li")!)).toEqual(["Open chat", "Open"]); // …but Open is always there
  });

  test("every toast and row ends with Open: a preview's opens its workstream's Chat tab (the URL is Open preview); the orchestrator's opens its panel, composer focused, with the O keycap in the tooltip", async () => {
    await open("/");
    const s = await live();
    await push(s, note({ id: 70, kind: "preview_failed", title: "Preview" }));
    expect(actionLabels(cards()[0]!).at(-1)).toBe("Open");
    await click(button(cards()[0]!, "Open"));
    expect(location.pathname + location.search).toBe("/r/local/feat-x/chat?reply=1");
    expect(apiFake.notificationCalls.at(-1)).toEqual({ verb: "read", ids: [70] });
    navigate("/");
    await push(s, note({ id: 71, kind: "failed", repo: "@orca", branch: "orchestrator", title: "Orchestrator", link: { orchestrator: true } }));
    const toast = cards()[0]!;
    expect(actionLabels(toast)).toEqual(["Open"]);
    const tip = actionsOf(toast).querySelector('[role="tooltip"]')!;
    expect(tip.textContent).toContain("Open");
    expect(tip.querySelector('kbd[data-slot="kbd"]')!.textContent).toBe("O");
    // The orchestrator's own notification: Open carries its robot avatar, not the side-panel icon.
    expect(button(toast, "Open")!.querySelector("svg")!.classList.contains("lucide-bot")).toBe(true);
    await click(button(toast, "Open"));
    expect($("orchestrator-panel")!.getAttribute("data-state")).toBe("open");
    expect(document.activeElement?.tagName).toBe("TEXTAREA"); // its composer, focused
    expect($("orchestrator-panel")!.contains(document.activeElement)).toBe(true);
    expect(apiFake.notificationCalls.at(-1)).toEqual({ verb: "read", ids: [71] });
  });

  test("on a narrow screen, Open on the orchestrator's own notification routes to its page instead of the panel", async () => {
    const was = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q === "(max-width: 767px)", media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      await open("/");
      const s = await live();
      await push(s, note({ id: 72, kind: "failed", repo: "@orca", branch: "orchestrator", title: "Orchestrator", link: { orchestrator: true } }));
      await click(button(cards()[0]!, "Open"));
      expect(location.pathname).toBe("/orchestrator");
      expect($("orchestrator-panel")).toBeNull();
      expect(apiFake.notificationCalls.at(-1)).toEqual({ verb: "read", ids: [72] });
    } finally { window.matchMedia = was; }
  });
});
