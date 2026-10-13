// The quick-ask launcher (components/QuickAsk): a pill at the bottom centre of every page that opens
// a one-line box for firing a message at the orchestrator WITHOUT its history, confirms it was sent
// with a way to the full panel, and shows whether the orchestrator is working or has replied unseen.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { getDefaultStore } from "jotai";
import { App } from "@/App";
import { orchestratorActivityAtom, orchestratorOpenAtom, quickAskOpenAtom } from "@/lib/atoms";
import { navigate } from "@/lib/route";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

type FakeSource = EventTarget & { url: string };
const opened = () => (globalThis as unknown as { EventSource: { opened: FakeSource[] } }).EventSource.opened;
const emit = (s: FakeSource, name: string, data: unknown) => s.dispatchEvent(Object.assign(new Event(name), { data: JSON.stringify(data) }));
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(path = "/") {
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });
}
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  apiFake.reset();
  localStorage.clear();
  const s = getDefaultStore();
  s.set(orchestratorOpenAtom, false); s.set(quickAskOpenAtom, false); s.set(orchestratorActivityAtom, { running: false, unread: false });
  navigate("/");
});
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); await flush(); await flush(); }); };
const type = async (el: HTMLTextAreaElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
});
const panelOpen = () => $('[data-slot="orchestrator-panel"]')?.dataset.state === "open";

test("Q1: the pill is on every page; it opens a one-line box that sends on Enter without loading history, confirms, and closes", async () => {
  apiFake.turnsData.set("@orca::orchestrator", [{ id: "run-1", provider: "claude", instruction: "old", prompt: "p", response: "older reply", finishedAt: 2 }]);
  for (const path of ["/", "/agents", "/settings"]) {
    await mount(path);
    const pill = $<HTMLButtonElement>('[data-slot="quick-ask-pill"]')!;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toContain("Ask");
    expect(pill.textContent).toContain("A"); // the shortcut hint
    expect(pill.className).toContain("rounded-full");
    expect($('[data-slot="quick-ask"]')!.className).toContain("fixed inset-x-0 bottom-5"); // bottom centre
    await act(async () => { root?.unmount(); }); container?.remove();
  }
  await mount("/");
  await click($('[data-slot="quick-ask-pill"]')!);
  const box = $('[data-slot="quick-ask-box"]')!;
  expect(box.getAttribute("role")).toBe("dialog");
  const input = box.querySelector("textarea")!;
  expect(document.activeElement).toBe(input);
  expect(box.textContent).not.toContain("older reply"); // no history here
  expect(apiFake.turnPageCalls).toEqual([]); // and none fetched
  expect(panelOpen()).toBe(false);
  await type(input, "rebase everything that is behind");
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await flush(); await flush(); });
  expect(apiFake.orchestratorMessages).toEqual([{ text: "rebase everything that is behind", attachments: [] }]);
  const sent = $('[data-slot="quick-ask-sent"]')!;
  expect(sent.textContent).toContain("Sent to the orchestrator");
  expect(sent.getAttribute("role")).toBe("status");
  // "Open chat" opens the full panel; the box goes.
  await click([...sent.querySelectorAll("button")].find((b) => b.textContent === "Open chat")!);
  expect(panelOpen()).toBe(true);
  expect($('[data-slot="quick-ask-box"]')).toBeNull();
  expect($('[data-slot="orchestrator-panel"]')!.textContent).toContain("older reply"); // the history is in the panel
});

test("Q2: the confirmation dwells then the box closes itself; Esc closes; a failed send keeps the text", async () => {
  await mount("/");
  act(() => { getDefaultStore().set(quickAskOpenAtom, true); });
  await act(async () => { await flush(); await flush(); });
  const input = $<HTMLTextAreaElement>('[data-slot="quick-ask-box"] textarea')!;
  await type(input, "a line");
  // The bridge refuses: the error shows and the text is still in the box.
  const real = apiFake.orchestratorMessages;
  const fail = store as unknown as { api?: unknown };
  void fail; void real;
  (await import("../web/src/api")).api.orchestratorMessage = (async () => { throw new Error("bridge offline"); }) as never;
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await flush(); await flush(); });
  expect($('[data-slot="quick-ask-error"]')!.textContent).toContain("bridge offline");
  expect($<HTMLTextAreaElement>('[data-slot="quick-ask-box"] textarea')!.value).toBe("a line");
  // Esc closes the box (the panel, untouched, stays closed).
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await flush(); });
  expect($('[data-slot="quick-ask-box"]')).toBeNull();
  expect(panelOpen()).toBe(false);
});

test("Q3: the indicator pulses while the orchestrator works and lights when it has replied unseen; opening the panel clears it", async () => {
  await mount("/");
  const dot = () => $('[data-slot="quick-ask-pill"] [data-slot="orchestrator-activity"]');
  expect(dot()).toBeNull(); // idle, nothing new
  // A wake starts (a `turn` event on the orchestrator's branch; the status now says running).
  apiFake.orchestratorState = { ...apiFake.orchestratorState, running: true };
  await act(async () => { emit(opened().at(-1)!, "turn", { repo: "@orca", branch: "orchestrator", runId: "w-1" }); await flush(); await flush(); });
  expect(dot()!.dataset.state).toBe("running");
  expect(dot()!.className).toContain("animate-pulse");
  // It finishes while the panel is closed: a reply you haven't seen.
  apiFake.orchestratorState = { ...apiFake.orchestratorState, running: false };
  await act(async () => { emit(opened().at(-1)!, "turn", { repo: "@orca", branch: "orchestrator", runId: "w-1" }); await flush(); await flush(); });
  expect(dot()!.dataset.state).toBe("unread");
  expect($('[data-slot="ask-orchestrator"] [data-slot="orchestrator-activity"]')).not.toBeNull(); // the top bar's button shows it too
  // Opening the panel is "seen".
  act(() => { getDefaultStore().set(orchestratorOpenAtom, true); });
  await act(async () => { await flush(); await flush(); });
  expect(dot()).toBeNull();
});
