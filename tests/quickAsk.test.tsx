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
import { joinMessages, unlandedSends } from "@/workstream";

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
    expect($('[data-slot="quick-ask"]')!.className).toContain("absolute inset-x-0 bottom-5"); // bottom centre (of the page card, Q7)
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
  expect($('[data-slot="quick-ask-box"] [data-slot="chat-composer-error"]')!.textContent).toContain("bridge offline");
  expect(input().value).toBe("another line");
  // Esc closes the box (the panel, untouched, stays closed).
  await act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await flush(); });
  expect($('[data-slot="quick-ask-box"]')).toBeNull();
  expect(panelOpen()).toBe(false);
});

test("Q4: one surface morphs pill ↔ box (width, height, radius; none under reduced motion), one fill on hover, no ✕, no footer", async () => {
  await mount("/");
  const closed = surface();
  expect(closed.dataset.state).toBe("closed");
  const cls = () => surface().className.split(/\s+/);
  expect(cls()).toEqual(expect.arrayContaining(["transition-[width,height,border-radius,border-color]", "motion-reduce:transition-none", "h-8", "rounded-[16px]", "bg-card"]));
  // Finn: the closed pill must show the open box's fill. A hover fill changed it under the pointer, so
  // hover shows on the hairline and the icon instead — never as a fill, on the pill or the surface.
  expect($('[data-slot="quick-ask-pill"]')!.className).not.toMatch(/hover:bg-/);
  expect(surface().className).not.toMatch(/hover:bg-/);
  expect(cls()).toContain("has-[[data-slot=quick-ask-pill]:hover]:border-border-dark");
  expect(cls()).toContain("[interpolate-size:allow-keywords]"); // height can animate to auto
  // ONE surface look open and closed (docs/design/surfaces.md): only size and radius change.
  const look = (c: string) => c.split(/\s+/).filter((x) => /^(bg-|text-|border|shadow-)/.test(x)).sort();
  const closedLook = look(surface().className);
  expect(closedLook).toEqual(["bg-card", "border", "shadow-modal", "text-foreground"]);
  expect(closed.hasAttribute("data-chrome")).toBe(false); // an overlay, not the themed frame
  await click($('[data-slot="quick-ask-pill"]')!);
  expect(look(surface().className)).toEqual(closedLook);
  expect(surface().hasAttribute("data-chrome")).toBe(false);
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
  const actions = box.querySelector('[data-slot="chat-composer-toolbar"]')!;
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
  expect($('[data-slot="quick-ask-pill"]')!.className).not.toMatch(/hover:bg-/);
  expect(look(surface().className)).toEqual(closedLook); // back to the same look
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
  expect($('[data-slot="chat-composer-error"]')).toBeNull();
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

test("Q8: a pointerdown outside the open box closes it like Esc; inside the box it stays open", async () => {
  await mount("/");
  await click($('[data-slot="quick-ask-pill"]')!);
  expect(surface().dataset.state).toBe("open");
  // Inside the box (the textarea itself): no close.
  await act(async () => { input().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await flush(); });
  expect(surface().dataset.state).toBe("open");
  expect($('[data-slot="quick-ask-box"]')).not.toBeNull();
  // Outside, on the page body: closes with the same collapse the pill↔box morph uses.
  await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await flush(); });
  expect(surface().dataset.state).toBe("closed");
  expect($('[data-slot="quick-ask-box"]')).toBeNull();
});

test("Q9: the box is the shared composer — @ opens the PR picker (# does not); a click in the portaled picker is not outside", async () => {
  apiFake.prsData = [{ branch: "auth", number: 6101, title: "Fix auth flow", url: "u", isDraft: false }];
  await act(async () => { await store.refresh(); });
  await mount("/");
  await click($('[data-slot="quick-ask-pill"]')!);
  const listbox = () => $('[role="listbox"][aria-label="Pull requests and workstreams"]');
  const typeAt = async (v: string) => act(async () => {
    const el = input();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, v);
    el.setSelectionRange(v.length, v.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  expect(input().getAttribute("role")).toBe("combobox"); // ChatComposer's textarea, not a fork
  expect($('[data-slot="quick-ask-box"] [data-slot="composer-attach"]')).not.toBeNull(); // attachments too
  await typeAt("look at #");
  expect(listbox()).toBeNull();
  await typeAt("look at @fix");
  const option = listbox()!.querySelector('[role="option"]')!;
  expect(option.textContent).toContain("6101");
  // The picker is portaled out of the surface's overflow-hidden, yet a pointerdown on it keeps the box…
  expect($('[data-slot="quick-ask-box"]')!.contains(option)).toBe(false);
  await act(async () => { option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await flush(); });
  expect(surface().dataset.state).toBe("open");
  // …and the click picks it.
  await act(async () => { option.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(input().value).toBe("look at #6101 ");
  expect(listbox()).toBeNull();
  // Escape with the picker open closes only the picker.
  await typeAt("look at #6101 @fi");
  expect(listbox()).not.toBeNull();
  await act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await flush(); });
  expect(listbox()).toBeNull();
  expect(surface().dataset.state).toBe("open");
  // Enter sends it, as anywhere.
  await enter(input());
  expect(apiFake.orchestratorMessages).toEqual([{ text: "look at #6101 @fi", attachments: [] }]);
});

test("Q7: the pill is centred on the page card — its strip spans the card, collapsed or expanded nav, so it moves with the card's edges", async () => {
  const s = getDefaultStore();
  await mount("/");
  const stripEl = () => $('[data-slot="quick-ask"]')!;
  const strip = () => stripEl().className.split(/\s+/);
  const sidebar = () => $('[data-slot="sidebar"]')!.className.split(/\s+/);
  // Expanded: the strip is the card's full width, its content centred in it.
  expect(sidebar()).toContain("md:w-60");
  expect(stripEl().parentElement!.dataset.slot).toBe("shell-card");
  expect(strip()).toEqual(expect.arrayContaining(["absolute", "inset-x-0", "justify-center"]));
  expect(strip()).not.toContain("fixed");
  // Collapsed: the card grows to the rail, and the strip with it — nothing of its own changes.
  const before = stripEl().className;
  await act(async () => { s.set(sidebarCollapsedAtom, true); await flush(); });
  expect(sidebar()).toContain("md:w-14");
  expect(stripEl().className).toBe(before);
  // Below md there is no pill — the phone's bottom bar carries the orchestrator.
  expect(strip()).toContain("max-md:hidden");
  // The open box is sized to the strip, not the viewport.
  await click($('[data-slot="quick-ask-pill"]')!);
  expect($('[data-slot="quick-ask-surface"]')!.className).toContain("w-[min(560px,calc(100%-2rem))]");
  s.set(sidebarCollapsedAtom, false);
});

test("Q8: the box carries every composer's toolbar — the orchestrator's model picker and context ring, attach, Send — and a model change sets the orchestrator's model as the panel does", async () => {
  apiFake.orchestratorState = { ...apiFake.orchestratorState, model: "claude-opus-5-5", contextPct: 42 };
  await mount("/");
  await click($('[data-slot="quick-ask-pill"]')!);
  const toolbar = $('[data-slot="quick-ask-box"] [data-slot="chat-composer-toolbar"]')!;
  const picker = toolbar.querySelector<HTMLElement>('[data-slot="chat-composer-leading"] [aria-label="Model"]')!;
  expect(picker.textContent).toBe("Claude · Opus 5.5"); // the orchestrator's own setting, not a card's
  const ring = toolbar.querySelector<HTMLButtonElement>('[data-slot="chat-composer-leading"] button[data-slot="context-ring"]')!;
  expect(ring.getAttribute("aria-label")).toBe("Context 42% full");
  expect(toolbar.querySelector('[data-slot="composer-attach"]')).not.toBeNull();
  expect(toolbar.querySelector('button[aria-label="Send"]')!.textContent).toContain("Send");
  // The ring's Compact compacts the orchestrator's session, as in the panel.
  await act(async () => { ring.click(); await flush(); }); // the card opens on a click only
  await act(async () => { document.body.querySelector<HTMLButtonElement>('button[data-slot="context-compact"]')!.click(); await flush(); await flush(); });
  expect(apiFake.calls).toContain("compact:@orca:orchestrator");
  await act(async () => { ring.click(); await flush(); }); // a second click closes it
  // Pick another model: the orchestrator's setting changes (api.orchestratorModel), the box stays open.
  await act(async () => {
    picker.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await flush(); await flush();
  });
  const sonnet = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes("Sonnet"))!;
  expect(sonnet).toBeDefined();
  await act(async () => {
    sonnet.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    sonnet.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }));
    sonnet.click();
    await flush(); await flush();
  });
  expect(apiFake.orchestratorState.model).toContain("sonnet");
  expect(surface().dataset.state).toBe("open");
  expect($('[data-slot="quick-ask-box"] [aria-label="Model"]')!.textContent).toContain("Sonnet");
});

test("Q10: an Ask shows in the orchestrator's panel AT ONCE — as sending, then queued behind a busy wake — and once only", async () => {
  // The bug: the panel (mounted once, kept mounted while closed) knew nothing of a quick-ask send,
  // and a message queued behind a busy wake publishes no event — so it appeared only when the wake ended.
  apiFake.orchestratorState = { ...apiFake.orchestratorState, running: true };
  apiFake.turnsData.set("@orca::orchestrator", [{ id: "run-1", provider: "claude", instruction: "old", prompt: "p", response: "older reply", finishedAt: 2 }]);
  await mount("/");
  const s = getDefaultStore();
  await act(async () => { s.set(orchestratorOpenAtom, true); await flush(); await flush(); });
  await act(async () => { s.set(orchestratorOpenAtom, false); await flush(); });
  await click($('[data-slot="quick-ask-pill"]')!);
  apiFake.orchestratorMessageDelays = [80]; // the bridge takes its time answering
  const text = "rebase the stack when you're free";
  await type(input(), text);
  await enter(input());
  await act(async () => { s.set(orchestratorOpenAtom, true); await flush(); await flush(); });
  const panel = () => $('[data-slot="orchestrator-panel"]')!;
  const occurrences = () => panel().textContent!.split(text).length - 1;
  // Before the bridge has answered: drawn as sending.
  expect(panel().querySelector('[data-slot="chat-sending"]')!.textContent).toContain(text);
  expect(occurrences()).toBe(1);
  // The bridge queues it (the orchestrator is mid-wake) — no event is published for that.
  apiFake.queuedData.set("orchestrator", [{ id: 7, repo: "@orca", branch: "orchestrator", instruction: text, attachments: [], createdAt: 3 }]);
  await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
  expect(panel().querySelector('[data-slot="chat-sending"]')).toBeNull();
  expect(panel().textContent).toContain("queued — sends when the current run finishes");
  expect(occurrences()).toBe(1); // reconciled, not duplicated
});

test("Q11: the panel's own sends go through the same outbox — sending at once, then the running turn, never both", async () => {
  apiFake.turnsData.set("@orca::orchestrator", []);
  await mount("/");
  await act(async () => { getDefaultStore().set(orchestratorOpenAtom, true); await flush(); await flush(); });
  const panel = $('[data-slot="orchestrator-panel"]')!;
  const box = panel.querySelector<HTMLTextAreaElement>("textarea")!;
  apiFake.orchestratorMessageDelays = [60];
  await type(box, "check the board");
  await enter(box);
  expect(panel.querySelector('[data-slot="chat-sending"]')!.textContent).toContain("check the board");
  // The wake launched: its turn is recorded, running.
  apiFake.turnsData.set("@orca::orchestrator", [{ id: "run-2", provider: "claude", instruction: "check the board", prompt: "p", response: "" }]);
  await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
  expect(panel.querySelector('[data-slot="chat-sending"]')).toBeNull();
  expect(panel.textContent!.split("check the board").length - 1).toBe(1);
  expect(apiFake.orchestratorMessages.map((m) => m.text)).toEqual(["check the board"]);
});

test("Q12: unlandedSends — a send is drawn until a RUNNING turn carries it (any of a wake's messages) or it is queued", () => {
  const a = { id: 1, text: "first" }, b = { id: 2, text: "second" }, c = { id: 3, text: "third" };
  expect(unlandedSends([a, b, c], null, [])).toEqual([a, b, c]);
  // A wake carrying several messages: each is matched, not only the first.
  expect(unlandedSends([a, b, c], [{ instruction: joinMessages(["first", "second"]) }], [])).toEqual([c]);
  // Queued, with attachments appended to the stored text.
  expect(unlandedSends([a, c], [], [{ instruction: "third\n\nAttached: x.png" }])).toEqual([a]);
  // A FINISHED turn with the same text is an earlier send of it: the new one still shows.
  expect(unlandedSends([a], [{ instruction: "first", finishedAt: 5 }], [])).toEqual([a]);
});
