// E2E for action errors as toasts (lib/toast, components/Toaster): a failed action on the Agents list
// shows a toast — the action + workstream as its title, the message as its body, Copy (message plus
// repo/branch/PR/action) and Ask the orchestrator (the window opens with a prefilled hand-off) —
// while the row itself keeps only a ✗ on its ⋯, never the message as text. The whole App against
// the fake api, as tests/shortcuts.test.tsx drives it.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import { orchestratorOpenAtom, orchestratorPrefillAtom } from "@/lib/atoms";
import { INFO_TOAST_MS, resetToasts, toast } from "@/lib/toast";
import { actionFailureAsk, actionFailureCopy } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(path: string) {
  navigate(path);
  await act(async () => { await store.refresh(); });
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });
}
afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
  act(() => resetToasts());
  localStorage.clear();
  getDefaultStore().set(orchestratorOpenAtom, false);
  getDefaultStore().set(orchestratorPrefillAtom, null);
  navigate("/");
  await act(async () => { await store.refresh(); });
});

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
const pointerdown = async (el: Element) => { await act(async () => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await flush(); await flush(); }); };
const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLElement>("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === text)!;

const ERROR = "GraphQL: Pull request is not mergeable: the base branch policy prohibits the merge (mergePullRequest)\nmore detail on a second line";

test("T1 the text: Copy carries the context, Ask is one message the orchestrator can act on", () => {
  const f = { action: "Merge", repo: "r", branch: "feat-ok", prNumber: 9, error: "boom" };
  expect(actionFailureCopy(f)).toBe("Action: Merge\nRepo: r\nBranch: feat-ok\nPR: #9\nError:\nboom");
  expect(actionFailureAsk(f)).toBe("Action Merge on r/feat-ok (PR #9) failed: boom. Please investigate and fix.");
  expect(actionFailureAsk({ ...f, prNumber: undefined })).toBe("Action Merge on r/feat-ok failed: boom. Please investigate and fix.");
});

test("T2 a failed Merge on the Agents list: a toast with Copy + Ask; the row has only the ✗; Ask prefills the orchestrator", async () => {
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
    const row = q(`[data-branch="feat-ok"]`)!;
    await pointerdown(row.querySelector('button[aria-label="Actions"]')!);
    const merge = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "Merge")!;
    await click(merge);
    await act(async () => { await flush(); await flush(); });
    expect(apiFake.calls).toContain("merge:9");

    // The toast: title, the message (monospace, wrapped, scrollable), Copy and Ask.
    const t = q('[data-slot="toaster"] [data-slot="toast"]')!;
    expect(t).not.toBeNull();
    expect(t.dataset.kind).toBe("error");
    expect(t.textContent).toContain("Merge failed · Approved thing");
    const body = t.querySelector<HTMLElement>('[data-slot="toast-body"]')!;
    expect(body.textContent).toBe(ERROR);
    for (const c of ["font-mono", "whitespace-pre-wrap", "overflow-auto"]) expect(body.className).toContain(c);

    // The row: no error text, just the ✗ on its ⋯ with the first line as the tooltip.
    const fresh = q(`[data-branch="feat-ok"]`)!;
    expect(fresh.textContent).not.toContain("not mergeable");
    const trigger = fresh.querySelector<HTMLElement>('button[aria-label="Actions"]')!;
    expect(trigger.querySelector(".lucide-x")).not.toBeNull();
    expect(trigger.title).toBe("GraphQL: Pull request is not mergeable: the base branch policy prohibits the merge (mergePullRequest)");

    // Copy and Ask are size-7 ghost icon buttons, each labelled and with its tooltip — the same
    // style as the notification toasts' quick actions.
    const acts = t.querySelector('[data-slot="toast-actions"]')!;
    expect([...acts.querySelectorAll("button")].map((b) => [b.getAttribute("aria-label"), b.textContent, b.className.includes("size-7")])).toEqual([["Copy", "", true], ["Ask the orchestrator", "", true]]);
    expect([...acts.querySelectorAll('[role="tooltip"]')].map((x) => x.textContent)).toEqual(["Copy", "Ask the orchestrator"]);
    // Copy: the message plus its context.
    await click(button(t, "Copy"));
    expect(copied).toEqual([`Action: Merge\nRepo: r\nBranch: feat-ok\nPR: #9\nError:\n${ERROR}`]);

    // Ask: the orchestrator's window opens, its composer prefilled (not sent), and the toast goes.
    await click(button(t, "Ask the orchestrator"));
    const box = q('[data-slot="orchestrator-panel"]')!.querySelector("textarea")!;
    expect(box.value).toBe(`Action Merge on r/feat-ok (PR #9) failed: ${ERROR}. Please investigate and fix.`);
    expect(apiFake.orchestratorMessages).toEqual([]);
    expect(q('[data-slot="toast"]')).toBeNull();
  } finally {
    window.confirm = confirm;
  }
});

test("T3 errors stay until dismissed; info toasts go by themselves; one toast isn't stacked twice", async () => {
  await mount("/");
  act(() => { toast({ kind: "error", title: "Preview failed", body: "port taken" }); toast({ kind: "error", title: "Preview failed", body: "port taken" }); });
  await act(async () => { await flush(); });
  expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(1);
  await click(q('[data-slot="toast"] button[aria-label="Dismiss"]')!);
  expect(q('[data-slot="toast"]')).toBeNull();
  expect(INFO_TOAST_MS).toBe(8000);
});
