// E2E for action errors as notifications (lib/notificationStore `actionFailed`, kind `action_failed`):
// there is ONE toast stack. A failed action on the Agents list is a card in the notification stack —
// same card, place and style as a run's or a preview's — headed with the workstream and "Merge failed",
// the message as its body, persistent until dismissed, with Ask the orchestrator (the panel opens with
// a prefilled hand-off) and Copy (message plus repo/branch/PR/action) as its quick actions, then Open;
// it is listed in the bell's centre too. It is local: never sent to the bridge. The row itself keeps
// only a ✗ on its ⋯. A preview that crashes is ONE notification — the bridge's `preview_failed` —
// never also a failed-action one. The whole App against the fake api.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import { orchestratorOpenAtom, orchestratorPrefillAtom } from "@/lib/atoms";
import * as centre from "@/lib/notificationStore";
import { actionFailureAsk, actionFailureCopy } from "@/workstream";
import type { Notification } from "../shared/notifications";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(path: string) {
  navigate(path);
  await act(async () => { await store.refresh(); });
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });
}
beforeEach(() => { centre.reset(); centre.toastTiming.autoHideMs = 40; });
afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
  act(() => centre.reset());
  localStorage.clear();
  getDefaultStore().set(orchestratorOpenAtom, false);
  getDefaultStore().set(orchestratorPrefillAtom, null);
  navigate("/");
  await act(async () => { await store.refresh(); });
});

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
const pointerdown = async (el: Element) => { await act(async () => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await flush(); await flush(); }); };
const hover = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })); await flush(); }); };
const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll<HTMLElement>("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === label)!;
/** The cards on the stack (a removed one plays its exit first). */
const cards = (kind?: string) => $$('[data-slot="notification-toast"]').filter((t) => t.dataset.removed !== "true" && (!kind || t.dataset.kind === kind));
const actionLabels = (el: Element) => [...el.querySelector('[data-slot="notification-actions"]')!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));

const ERROR = "GraphQL: Pull request is not mergeable: the base branch policy prohibits the merge (mergePullRequest)\nmore detail on a second line";

test("T1 the text: Copy carries the context, Ask is one message the orchestrator can act on", () => {
  const f = { action: "Merge", repo: "r", branch: "feat-ok", prNumber: 9, error: "boom" };
  expect(actionFailureCopy(f)).toBe("Action: Merge\nRepo: r\nBranch: feat-ok\nPR: #9\nError:\nboom");
  expect(actionFailureAsk(f)).toBe("Action Merge on r/feat-ok (PR #9) failed: boom. Please investigate and fix.");
  expect(actionFailureAsk({ ...f, prNumber: undefined })).toBe("Action Merge on r/feat-ok failed: boom. Please investigate and fix.");
});

test("T2 a failed Merge on the Agents list: a card in the notification stack and the centre, persistent, Copy works, never sent to the bridge; the row has only the ✗", async () => {
  apiFake.prsData = [
    { number: 9, title: "Approved thing", branch: "feat-ok", url: "u", state: "OPEN", isDraft: false, ciStatus: "passing", reviewStatus: "approved", mergeable: "MERGEABLE", autoMergeEnabled: false },
  ];
  apiFake.mergeError = ERROR;
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { copied.push(t); } } });
  const confirm = window.confirm;
  window.confirm = () => true;
  try {
    await mount("/agents");
    await pointerdown(q(`[data-branch="feat-ok"]`)!.querySelector('button[aria-label="Actions"]')!);
    await click([...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "Merge")!);
    await act(async () => { await flush(); await flush(); });
    expect(apiFake.calls).toContain("merge:9");

    // There is no separate action-error stack any more: the failure is a notification card.
    expect(q('[data-slot="toaster"]')).toBeNull();
    expect(cards()).toHaveLength(1);
    const t = cards("action_failed")[0]!;
    expect(t.closest('[data-slot="notification-host"]')).not.toBeNull(); // the one stack, bottom-left
    expect(t.className).toContain("rounded-lg");
    expect(t.className).toContain("shadow-menu");
    expect(t.querySelector('[data-slot="notification-repo"]')!.textContent).toBe("r");
    expect(t.querySelector('[data-slot="notification-title"]')!.textContent).toBe("Approved thing");
    expect(t.textContent).toContain("Merge failed");
    expect(t.textContent).toContain("Pull request is not mergeable");
    expect(t.querySelector(".lucide-circle-alert")).not.toBeNull();

    // Persistent: well past the auto-hide delay it is still there.
    await act(async () => { await wait(120); });
    expect(cards("action_failed")).toHaveLength(1);

    // The row: no error text, just the ✗ on its ⋯ with the first line as the tooltip.
    const fresh = q(`[data-branch="feat-ok"]`)!;
    expect(fresh.textContent).not.toContain("not mergeable");
    const trigger = fresh.querySelector<HTMLElement>('button[aria-label="Actions"]')!;
    expect(trigger.querySelector(".lucide-x")).not.toBeNull();
    expect(trigger.title).toBe("GraphQL: Pull request is not mergeable: the base branch policy prohibits the merge (mergePullRequest)");

    // Its quick actions, the notification toasts' own: Ask the orchestrator (primary), Copy, Open.
    await hover(t);
    expect(actionLabels(t)).toEqual(["Ask the orchestrator", "Copy", "Open"]);
    for (const b of t.querySelector('[data-slot="notification-actions"]')!.querySelectorAll("button")) expect(b.className).toContain("size-7");

    // Listed in the centre, unread, with the same verbs and label.
    await click(q('[data-slot="notifications-bell"]')!);
    expect(q('[data-slot="notifications-unread"]')!.textContent).toBe("1");
    const row = q('[data-slot="notification-row"][data-kind="action_failed"]')!;
    expect(row.dataset.unread).toBe("");
    expect(row.textContent).toContain("Approved thing");
    expect(row.textContent).toContain("Merge failed");
    expect(actionLabels(row.closest("li")!)).toEqual(["Ask the orchestrator", "Copy", "Open", "Mark as read"]);

    // Copy: the message plus its context; acting marks it read, so it leaves the stack — and being
    // local, nothing is sent to the bridge about it.
    await click(button(t, "Copy"));
    expect(copied).toEqual([`Action: Merge\nRepo: r\nBranch: feat-ok\nPR: #9\nError:\n${ERROR}`]);
    expect(cards()).toHaveLength(0);
    expect(q('[data-slot="notifications-unread"]')).toBeNull();
    expect(apiFake.notificationCalls).toEqual([]);
  } finally {
    window.confirm = confirm;
  }
});

test("T3 Ask the orchestrator on a failed action: the panel opens with the hand-off prefilled (not sent) and the card goes", async () => {
  await mount("/");
  act(() => { centre.actionFailed({ action: "Merge", title: "Approved thing", repo: "r", branch: "feat-ok", prNumber: 9 }, new Error("boom")); });
  await act(async () => { await flush(); });
  const t = cards("action_failed")[0]!;
  await hover(t);
  await click(button(t, "Ask the orchestrator"));
  const box = q('[data-slot="orchestrator-panel"]')!.querySelector("textarea")!;
  expect(box.value).toBe("Action Merge on r/feat-ok (PR #9) failed: boom. Please investigate and fix.");
  expect(apiFake.orchestratorMessages).toEqual([]);
  await act(async () => { await wait(250); }); // its exit
  expect(cards()).toHaveLength(0);
});

test("T4 the same failure isn't stacked twice; a preview crash is ONE notification — the bridge's preview_failed, no failed-action card beside it", async () => {
  apiFake.agentsData = [{ branch: "feat-p", worktreePath: "/wt/feat-p", agentStatus: "done" }];
  await mount("/agents");
  act(() => {
    centre.actionFailed({ action: "Preview", title: "P", repo: "r", branch: "feat-p" }, "port taken");
    centre.actionFailed({ action: "Preview", title: "P", repo: "r", branch: "feat-p" }, "port taken");
  });
  await act(async () => { await flush(); });
  expect(cards("action_failed")).toHaveLength(1);
  await click(cards("action_failed")[0]!.querySelector('button[aria-label="Mark as read"]')!);
  await act(async () => { await wait(250); });
  expect(cards()).toHaveLength(0);

  // Start a preview on the row; its service crashes. The cell reaps it, and raises no toast…
  apiFake.previewSvcs = [{ name: "frontend", port: 9001, url: "http://orca-box:9001", open: true, running: false, ready: false, startedAt: Date.now(), error: "boom" }];
  const cell = q('[data-branch="feat-p"] [data-slot="preview-cell"]')!;
  await click(cell.querySelector("button")!);
  await act(async () => { await flush(); await flush(); });
  expect(q('[data-branch="feat-p"] [data-slot="preview-cell"]')!.dataset.state).toBe("failed");
  expect(cards()).toHaveLength(0);
  // …because the bridge's watcher reports it, on the tab's one stream: that is the one card.
  const s = (globalThis as unknown as { EventSource: { opened: (EventTarget & { url: string })[] } }).EventSource.opened.at(-1)!;
  const emit = (name: string, data: unknown) => s.dispatchEvent(Object.assign(new Event(name), { data: JSON.stringify(data) }));
  const crash: Notification = { id: 500, instance: "laptop", repo: "r", branch: "feat-p", kind: "preview_failed", title: "P", body: "boom", createdAt: Date.now() };
  await act(async () => { emit("ready", {}); emit("notification", crash); await flush(); });
  expect(cards().map((c) => c.dataset.kind)).toEqual(["preview_failed"]);
});
