// The notification centre in the browser (components/Notifications.tsx + lib/notificationStore.ts):
// the bell's unread count from the catch-up fetch; a push on the tab's one stream popping a Geist
// toast; the stack collapsing past one with a count bar and expanding on click; Clear all; a
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
import type { Notification } from "../shared/notifications";

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
    expect($("toast-host")).toBeNull();
    expect(apiFake.notificationFetches).toEqual([undefined]);
  });

  test("a push on the tab's one stream pops a Geist toast: icon, title, kind, body, time, Open, dismiss", async () => {
    await open("/");
    const s = await live();
    expect(s.url).toBe("/api/events"); // the same stream the chats share — not a second connection
    await push(s, note({ kind: "needs_input", body: "Should I migrate the old rows?" }));
    const toast = $("toast")!;
    expect(toast.className).toContain("rounded-lg");
    expect(toast.className).toContain("shadow-menu"); // the menu shadow, the only one allowed
    expect(toast.className).not.toMatch(/border-2/);
    expect(toast.textContent).toContain("Login form");
    expect(toast.textContent).toContain("Needs input");
    expect(toast.textContent).toContain("Should I migrate the old rows?");
    expect(toast.querySelector('[data-slot="toast-time"]')!.textContent).toContain("just now");
    expect($("notifications-unread")!.textContent).toBe("1"); // the centre has it too
    await click(toast.querySelector('button[aria-label="Dismiss"]'));
    expect($("toast")).toBeNull();
    expect($("notifications-unread")!.textContent).toBe("1"); // dismissing the toast keeps the row
  });

  test("the stack: newest on top, collapsed past one with a count bar, expanded on click, Clear all", async () => {
    await open("/");
    const s = await live();
    await push(s, note({ id: 1, title: "First", kind: "failed", createdAt: Date.now() - 3 }));
    await push(s, note({ id: 2, title: "Second", kind: "failed", createdAt: Date.now() - 2 }));
    await push(s, note({ id: 3, title: "Third", kind: "failed", createdAt: Date.now() - 1 }));
    await push(s, note({ id: 4, title: "Fourth", kind: "failed" }));
    expect($$("toast")).toHaveLength(1); // the top one in full…
    expect($("toast")!.textContent).toContain("Fourth");
    expect($$("toast-peek")).toHaveLength(2); // …two peeking under it
    expect($("toast-count")!.textContent).toContain("4 notifications · 1 more");
    await click($("toast-count")!.querySelector("button[aria-expanded]"));
    expect($$("toast").map((t) => t.querySelector(".font-medium")!.textContent)).toEqual(["Fourth", "Third", "Second", "First"]);
    expect($$("toast-peek")).toHaveLength(0);
    await click([...$("toast-count")!.querySelectorAll("button")].find((b) => b.textContent === "Clear all")!);
    expect($("toast-host")).toBeNull();
    expect($("notifications-unread")!.textContent).toBe("4"); // Clear all is the stack, not the centre
  });

  test("a finished toast hides itself; a needs-input or failed one stays until dismissed", async () => {
    await open("/");
    const s = await live();
    await push(s, note({ kind: "finished", title: "Quick" }));
    await push(s, note({ kind: "needs_input", title: "Waiting" }));
    expect($$("toast").length + $$("toast-peek").length).toBe(2);
    await act(async () => { await wait(90); });
    expect($$("toast").map((t) => t.getAttribute("data-kind"))).toEqual(["needs_input"]);
    await act(async () => { await wait(90); });
    expect($$("toast")).toHaveLength(1); // still there
  });

  test("do-not-disturb and a kind switched off in Settings silence the toast; the centre still fills; a stale catch-up never pops", async () => {
    await open("/settings");
    const s = await live();
    const kinds = $("toast-kinds")!;
    const finished = [...kinds.querySelectorAll("label")].find((l) => l.textContent!.includes("Finished"))!.querySelector("input")!;
    await act(async () => { finished.click(); await flush(); });
    expect(getDefaultStore().get(toastPrefsAtom)).toEqual({ finished: false });
    await push(s, note({ kind: "finished" }));
    expect($("toast-host")).toBeNull();
    await push(s, note({ kind: "failed" }));
    expect($$("toast")).toHaveLength(1);
    centre.clearToasts();
    await act(async () => { getDefaultStore().set(notifyDndAtom, true); await flush(); });
    await push(s, note({ kind: "needs_input" }));
    expect($("toast-host")).toBeNull();
    expect($("notifications-unread")!.textContent).toBe("3");
    await act(async () => { getDefaultStore().set(notifyDndAtom, false); await flush(); });
    await push(s, note({ kind: "needs_input", createdAt: Date.now() - 3_600_000 })); // an hour old: the centre, not the corner
    expect($("toast-host")).toBeNull();
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

  test("a toast's Open takes you to the workstream (or the preview URL) and marks it read; the centre's DND toggle", async () => {
    await open("/");
    const s = await live();
    await push(s, note({ id: 9, kind: "failed" }));
    await click([...$("toast")!.querySelectorAll("button")].find((b) => b.textContent === "Open"));
    expect(location.pathname).toBe("/r/local/feat-x");
    expect(apiFake.notificationCalls).toEqual([{ verb: "read", ids: [9] }]);
    expect($("toast")).toBeNull();
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
    expect($("toast")!.textContent).toContain("While away");
    expect($("notifications-unread")!.textContent).toBe("2");
  });
});
