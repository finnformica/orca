// The quick-ask launcher (components/QuickAsk): a pill at the bottom centre of every page that morphs
// into a box for firing messages at the orchestrator WITHOUT its history — optimistically, in order,
// queued behind a busy orchestrator — confirms each was sent with a way to the full panel, and shows
// whether the orchestrator is working or has replied unseen.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { getDefaultStore } from "jotai";
import { App } from "@/App";
import { orchestratorActivityAtom, orchestratorOpenAtom, quickAskOpenAtom, sidebarCollapsedAtom } from "@/lib/atoms";
import { navigate } from "@/lib/route";
import { MORPH_MS, SENT_FLASH_MS } from "@/components/QuickAsk";

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

const enter = (el: Element, init: KeyboardEventInit = {}) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init })); await flush(); await flush(); });
const input = () => $<HTMLTextAreaElement>('[data-slot="quick-ask-box"] textarea')!;
const surface = () => $('[data-slot="quick-ask-surface"]')!;

test("Q1: the pill is on every page; it opens a box that sends on Enter without loading history, confirms, and opens the chat on request", async () => {
  apiFake.turnsData.set("@orca::orchestrator", [{ id: "run-1", provider: "claude", instruction: "old", prompt: "p", response: "older reply", finishedAt: 2 }]);
  for (const path of ["/", "/agents", "/settings"]) {
    await mount(path);
    const pill = $<HTMLButtonElement>('[data-slot="quick-ask-pill"]')!;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toContain("Ask");
    expect(pill.textContent).toContain("A"); // the shortcut hint
    expect($('[data-slot="quick-ask"]')!.className).toContain("fixed right-0 bottom-5"); // bottom centre (of the main column, Q7)
    await act(async () => { root?.unmount(); }); container?.remove();
  }
  await mount("/");
  await click($('[data-slot="quick-ask-pill"]')!);
  const box = $('[data-slot="quick-ask-box"]')!;
  expect(box.getAttribute("role")).toBe("dialog");
  expect(document.activeElement).toBe(input());
  expect(box.textContent).not.toContain("older reply"); // no history here
  expect(apiFake.turnPageCalls).toEqual([]); // and none fetched
  expect(panelOpen()).toBe(false);
  await type(input(), "rebase everything that is behind");
  await enter(input());
  expect(apiFake.orchestratorMessages).toEqual([{ text: "rebase everything that is behind", attachments: [] }]);
  const sent = $('[data-slot="quick-ask-sent"]')!;
  expect(sent.textContent).toContain("Sent");
  expect(sent.getAttribute("role")).toBe("status");
  // "Open chat" opens the full panel; the box goes.
  await click([...sent.querySelectorAll("button")].find((b) => b.textContent === "Open chat")!);
  expect(panelOpen()).toBe(true);
  expect($('[data-slot="quick-ask-box"]')).toBeNull();
  expect($('[data-slot="orchestrator-panel"]')!.textContent).toContain("older reply"); // the history is in the panel
});

test("Q2: the confirmation fades on its own and the box stays open; Esc closes; a failed send gives the text back", async () => {
  await mount("/");
  act(() => { getDefaultStore().set(quickAskOpenAtom, true); });
  await act(async () => { await flush(); await flush(); });
  await type(input(), "a line");
  await enter(input());
  expect($('[data-slot="quick-ask-sent"]')!.textContent).toContain("Sent");
  await act(async () => { await new Promise((r) => setTimeout(r, SENT_FLASH_MS + 50)); });
  expect($('[data-slot="quick-ask-sent"]')!.textContent).toBe(""); // the receipt went…
  expect($('[data-slot="quick-ask-box"]')).not.toBeNull(); // …the box did not
  // The bridge is down: the error shows and the text comes back into the (empty) box.
  apiFake.orchestratorMessageError = "bridge offline";
  await type(input(), "another line");
  await enter(input());
  await act(async () => { await flush(); await flush(); });
  expect($('[data-slot="quick-ask-error"]')!.textContent).toContain("bridge offline");
  expect(input().value).toBe("another line");
  // Esc closes the box (the panel, untouched, stays closed).
  await act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await flush(); });
  expect($('[data-slot="quick-ask-box"]')).toBeNull();
  expect(panelOpen()).toBe(false);
});

test("Q4: one surface morphs pill ↔ box (width, height, radius; none under reduced motion), solid on hover, no ✕, no footer", async () => {
  await mount("/");
  const closed = surface();
  expect(closed.dataset.state).toBe("closed");
  const cls = () => surface().className.split(/\s+/);
  expect(cls()).toEqual(expect.arrayContaining(["transition-[width,height,border-radius,box-shadow,background-color]", "motion-reduce:transition-none", "h-8", "rounded-[16px]", "bg-card", "hover:bg-accent"]));
  expect(surface().className).not.toMatch(/hover:bg-[\w-]+\/\d+/); // no translucent hover: the page never shows through
  expect(cls()).toContain("[interpolate-size:allow-keywords]"); // height can animate to auto
  await click($('[data-slot="quick-ask-pill"]')!);
  expect(surface()).toBe(closed); // the SAME element, so its box animates rather than being swapped
  expect(surface().dataset.state).toBe("open");
  expect(cls()).toEqual(expect.arrayContaining(["h-auto", "rounded-xl", "w-[min(560px,calc(100%-2rem))]"]));
  const box = $('[data-slot="quick-ask-box"]')!;
  expect(input().placeholder).toBe("Ask the orchestrator...");
  expect(box.querySelector('[aria-label="Close quick ask"]')).toBeNull(); // no ✕
  expect(box.textContent).not.toContain("Open full chat"); // no footer
  expect(box.textContent).not.toContain("One message, no history");
  // A multi-line box that grows with its content, up to a cap.
  expect(input().tagName).toBe("TEXTAREA");
  // Multi-line from the moment it opens: three rows tall, not a single line.
  expect(input().getAttribute("rows")).toBe("3");
  expect(input().className.split(/\s+/)).toEqual(expect.arrayContaining(["field-sizing-content", "min-h-[4.5rem]", "max-h-40", "overflow-y-auto"]));
  // The agent at the top left beside the text; the row below holds only the actions — Send, carrying
  // the send key as the shared keycap.
  expect(box.firstElementChild!.contains(input())).toBe(true);
  expect(box.firstElementChild!.querySelector("svg.lucide-bot")).not.toBeNull();
  const actions = box.querySelector('[data-slot="quick-ask-actions"]')!;
  expect(actions.contains(input())).toBe(false);
  const sendBtn = actions.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
  expect(sendBtn.textContent).toContain("Send");
  expect([...sendBtn.querySelectorAll('[data-shortcut="send"] [data-slot="kbd"]')].map((k) => k.textContent)).toEqual(["Enter"]);
  // Shift+Enter is a newline (left to the textarea), not a send.
  await type(input(), "line one");
  await enter(input(), { shiftKey: true });
  expect(apiFake.orchestratorMessages).toEqual([]);
  // ⌘+Enter (Ctrl+Enter elsewhere) breaks the line too — put in at the caret, never a send.
  await enter(input(), { metaKey: true });
  await enter(input(), { ctrlKey: true });
  expect(apiFake.orchestratorMessages).toEqual([]);
  expect(input().value).toBe("line one\n\n");
  // Closing morphs back on the same element. The box's contents stay through the collapse — faded,
  // inert, pinned — and only then does the pill fade in (swapping at once was the jank).
  await act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await flush(); });
  expect(surface()).toBe(closed);
  expect(surface().dataset.state).toBe("closed");
  expect($('[data-slot="quick-ask-box"]')).toBeNull(); // no longer the box to anything looking for it…
  const leaving = $('[data-slot="quick-ask-leaving"]')!;
  expect(leaving.className).toContain("opacity-0"); // …but still there, fading
  expect(leaving.hasAttribute("inert")).toBe(true);
  expect($('[data-slot="quick-ask-pill"]')).toBeNull();
  await act(async () => { await new Promise((r) => setTimeout(r, MORPH_MS + 20)); });
  expect($('[data-slot="quick-ask-leaving"]')).toBeNull();
  expect($('[data-slot="quick-ask-pill"]')!.className).toContain("fade-in-0");
  expect(cls()).toContain("hover:bg-accent");
});

test("Q5: a send is optimistic — cleared, still open and focused at once; quick successive sends all arrive, in order", async () => {
  await mount("/");
  await click($('[data-slot="quick-ask-pill"]')!);
  // The first request is slow and the later ones fast: in parallel they would land out of order.
  apiFake.orchestratorMessageDelays = [60, 5, 0];
  for (const line of ["first task", "second task", "third task"]) {
    await type(input(), line);
    await enter(input());
    // Cleared and ready for the next one at once — before the bridge has answered.
    expect(input().value).toBe("");
    expect(document.activeElement).toBe(input());
    expect($('[data-slot="quick-ask-sent"]')!.textContent).toContain("Sent");
  }
  expect(apiFake.orchestratorMessages.length).toBeLessThan(3); // still in flight: nothing waited on it
  await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
  expect(apiFake.orchestratorMessages.map((m) => m.text)).toEqual(["first task", "second task", "third task"]);
});

test("Q6: a busy orchestrator queues the message — no error, nothing blocked", async () => {
  apiFake.orchestratorState = { ...apiFake.orchestratorState, running: true };
  await mount("/");
  await click($('[data-slot="quick-ask-pill"]')!);
  await type(input(), "when you're done, rebase");
  await enter(input());
  await type(input(), "and then ship it");
  await enter(input());
  await act(async () => { await flush(); await flush(); });
  expect(apiFake.orchestratorMessages.map((m) => m.text)).toEqual(["when you're done, rebase", "and then ship it"]);
  expect($('[data-slot="quick-ask-error"]')).toBeNull();
  expect(input().value).toBe("");
});

test("Q3: the indicator pulses on the orchestrator button (never the Ask pill) while it works and lights when it has replied unseen; opening the panel clears it", async () => {
  await mount("/");
  const dot = () => $('[data-slot="ask-orchestrator"] [data-slot="orchestrator-activity"]');
  const pillDot = () => $('[data-slot="quick-ask-pill"] [data-slot="orchestrator-activity"]');
  expect(dot()).toBeNull(); // idle, nothing new
  // A wake starts (a `turn` event on the orchestrator's branch; the status now says running).
  apiFake.orchestratorState = { ...apiFake.orchestratorState, running: true };
  await act(async () => { emit(opened().at(-1)!, "turn", { repo: "@orca", branch: "orchestrator", runId: "w-1" }); await flush(); await flush(); });
  expect(dot()!.dataset.state).toBe("running");
  expect(dot()!.className).toContain("animate-pulse");
  expect(pillDot()).toBeNull(); // the Ask pill never carries it
  // It finishes while the panel is closed: a reply you haven't seen.
  apiFake.orchestratorState = { ...apiFake.orchestratorState, running: false };
  await act(async () => { emit(opened().at(-1)!, "turn", { repo: "@orca", branch: "orchestrator", runId: "w-1" }); await flush(); await flush(); });
  expect(dot()!.dataset.state).toBe("unread");
  expect(pillDot()).toBeNull();
  // Opening the panel is "seen".
  act(() => { getDefaultStore().set(orchestratorOpenAtom, true); });
  await act(async () => { await flush(); await flush(); });
  expect(dot()).toBeNull();
});

test("Q7: the pill is centred on the main column — its strip starts where the sidebar ends, collapsed or expanded", async () => {
  const s = getDefaultStore();
  await mount("/");
  const strip = () => $('[data-slot="quick-ask"]')!.className.split(/\s+/);
  const sidebar = () => $('[data-slot="sidebar"]')!.className.split(/\s+/);
  // Expanded: a 15rem sidebar, a strip from 15rem to the right edge, its content centred in it.
  expect(sidebar()).toContain("md:w-60");
  expect(strip()).toEqual(expect.arrayContaining(["fixed", "left-60", "right-0", "justify-center"]));
  expect(strip()).not.toContain("inset-x-0");
  // Collapsed: the icon column is 3.5rem, and the strip follows it.
  await act(async () => { s.set(sidebarCollapsedAtom, true); await flush(); });
  expect(sidebar()).toContain("md:w-14");
  expect(strip()).toEqual(expect.arrayContaining(["left-14", "right-0", "justify-center"]));
  expect(strip()).not.toContain("left-60");
  // Below md there is no pill — the phone's bottom bar carries the orchestrator.
  expect(strip()).toContain("max-md:hidden");
  // The open box is sized to the strip, not the viewport.
  await click($('[data-slot="quick-ask-pill"]')!);
  expect($('[data-slot="quick-ask-surface"]')!.className).toContain("w-[min(560px,calc(100%-2rem))]");
  s.set(sidebarCollapsedAtom, false);
});
