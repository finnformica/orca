// Opening the orchestrator focuses its composer on EVERY path — the top-bar button, the O key, the
// quick-ask box's Open chat, a notification's Open (openOrchestrator outside React), a reopen of the
// already-mounted panel, and the routed page on a phone — and typing straight after opening never
// scrambles: keys that arrive before focus are held and forwarded in order, and a box the user is
// already typing in keeps its caret ("Sometimes" once came out "ometimesS").
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { getDefaultStore } from "jotai";
import { App } from "@/App";
import { orchestratorActivityAtom, orchestratorOpenAtom, orchestratorPrefillAtom, quickAskOpenAtom } from "@/lib/atoms";
import { endTypeahead, openOrchestrator } from "@/lib/orchestratorOpen";
import { NARROW_QUERY } from "@/lib/viewport";
import { navigate } from "@/lib/route";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
const realMatchMedia = window.matchMedia;
async function mount(path = "/", phone = false) {
  window.matchMedia = ((q: string) => ({ matches: phone && q === NARROW_QUERY, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });
}
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  window.matchMedia = realMatchMedia;
  endTypeahead();
  apiFake.reset();
  localStorage.clear();
  const s = getDefaultStore();
  s.set(orchestratorOpenAtom, false); s.set(orchestratorPrefillAtom, null); s.set(quickAskOpenAtom, false);
  s.set(orchestratorActivityAtom, { running: false, unread: false });
  navigate("/");
});
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const composer = () => $<HTMLTextAreaElement>('[data-slot="orchestrator-panel"] textarea, [data-slot="orchestrator-page"] textarea');
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); await flush(); await flush(); }); };
const key = (k: string, target: EventTarget = document.activeElement ?? document.body) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
/** What a browser does with a printable key in a focused textarea: insert it AT THE CARET. */
const typeAtCaret = (el: HTMLTextAreaElement, text: string) => act(async () => {
  for (const ch of text) {
    if (!key(ch, el)) continue; // cancelled: not inserted
    const at = el.selectionStart, v = el.value;
    setValue.call(el, v.slice(0, at) + ch + v.slice(el.selectionEnd)); // the prototype setter, as the browser does
    el.setSelectionRange(at + 1, at + 1);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await flush();
});
const closePanel = async () => { await act(async () => { getDefaultStore().set(orchestratorOpenAtom, false); await flush(); }); };

test("F1: every desktop open path leaves the composer focused", async () => {
  await mount("/");
  // The top bar's button.
  await click($('[data-slot="ask-orchestrator"]')!);
  expect(document.activeElement).toBe(composer());
  await closePanel();
  // The O key, from the page (the panel is already mounted, slid out: a reopen must focus too).
  await act(async () => { key("o", document.body); await flush(); await flush(); });
  expect($('[data-slot="orchestrator-panel"]')!.dataset.state).toBe("open");
  expect(document.activeElement).toBe(composer());
  await closePanel();
  // A notification's Open (or a browser notification's click): openOrchestrator outside React.
  await act(async () => { openOrchestrator(); await flush(); await flush(); });
  expect(document.activeElement).toBe(composer());
  await closePanel();
  // The quick-ask box's Open chat (offered with the "Sent" receipt).
  await click($('[data-slot="quick-ask-pill"]')!);
  const quick = $<HTMLTextAreaElement>('[data-slot="quick-ask-box"] textarea')!;
  await typeAtCaret(quick, "hi");
  await act(async () => { key("Enter", quick); await flush(); await flush(); });
  await click([...$('[data-slot="quick-ask-sent"]')!.querySelectorAll("button")].find((b) => b.textContent === "Open chat")!);
  expect(document.activeElement).toBe(composer());
});

test("F2: on a phone, opening routes to the page but never auto-focuses its composer (no keyboard pop); a prefilled message still lands, and a direct tap still focuses", async () => {
  await mount("/", true);
  await act(async () => { openOrchestrator("draft from a notification"); await flush(); await flush(); });
  expect(location.pathname).toBe("/orchestrator");
  expect(document.activeElement).not.toBe(composer());
  expect(composer()!.value).toBe("draft from a notification"); // the text still arrives, just unfocused
  // A direct tap on the box is a real user gesture: it still focuses, on any device.
  await act(async () => { composer()!.focus(); await flush(); });
  expect(document.activeElement).toBe(composer());
});

test("F3: typing straight after opening — keys before focus are forwarded in order, the caret is never reset", async () => {
  await mount("/");
  // The first letter arrives BEFORE React has committed the open (no act flush in between): it is
  // held by the typeahead, not lost and not shuffled.
  await act(async () => {
    openOrchestrator();
    key("S", document.body);
    await flush(); await flush();
  });
  const box = composer()!;
  expect(document.activeElement).toBe(box);
  expect(box.value).toBe("S");
  expect(box.selectionStart).toBe(1); // the caret after it, not at the start
  await typeAtCaret(box, "ometimes");
  expect(box.value).toBe("Sometimes");
  // Opening again while typing (O from the palette, an ask with no text) leaves the caret alone.
  box.setSelectionRange(4, 4); // the user moved the caret mid-word
  await act(async () => { openOrchestrator(); await flush(); await flush(); });
  expect(box.value).toBe("Sometimes");
  expect(box.selectionStart).toBe(4);
  await typeAtCaret(box, "X");
  expect(box.value).toBe("SomeXtimes");
});

test("F4: the typeahead only holds keys while nothing has focus, and lets go after its window", async () => {
  await mount("/");
  const field = document.createElement("input");
  document.body.appendChild(field);
  field.focus();
  await act(async () => {
    openOrchestrator();
    expect(key("q", field)).toBe(true); // a field has focus: the key is its own, not held
    await flush(); await flush();
  });
  expect(composer()!.value).toBe("");
  field.remove();
  // Nothing claims it: it ends on its own and the page gets its keys back.
  endTypeahead();
  expect(key("z", document.body)).toBe(true);
});
