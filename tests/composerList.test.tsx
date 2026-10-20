// Markdown list continuation in the chat composer, like GitHub / Notion: Enter on a list line starts
// the next item, Enter on an empty item ends the list. Pure transform first, then the real
// ChatComposer in a DOM (Enter on a list line no longer sends; ⌘/Ctrl+Enter there does).
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./apiFake";
import * as store from "@/store";
import { ChatComposer } from "@/components/ChatComposer";
import { listContinuation } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The transform with the caret at `|` in `s`. */
const enter = (s: string) => {
  const at = s.indexOf("|");
  const r = listContinuation(s.replace("|", ""), at, at);
  return r && r.text.slice(0, r.caret) + "|" + r.text.slice(r.caret);
};

describe("listContinuation", () => {
  test("bullets, numbers and task items continue with the same marker and indent", () => {
    expect(enter("- one|")).toBe("- one\n- |");
    expect(enter("* one|")).toBe("* one\n* |");
    expect(enter("+ one|")).toBe("+ one\n+ |");
    expect(enter("1. one|")).toBe("1. one\n2. |");
    expect(enter("9) nine|")).toBe("9) nine\n10) |");
    expect(enter("- [ ] task|")).toBe("- [ ] task\n- [ ] |");
    expect(enter("- [x] done|")).toBe("- [x] done\n- [ ] |");
    expect(enter("- a\n  - nested|")).toBe("- a\n  - nested\n  - |");
    expect(enter("1. a\n   3. nested|\n4. b")).toBe("1. a\n   3. nested\n   4. |\n4. b");
  });

  test("an empty item loses its marker and ends the list", () => {
    expect(enter("- a\n- |")).toBe("- a\n|");
    expect(enter("- a\n2. |")).toBe("- a\n|");
    expect(enter("- a\n- [ ] |")).toBe("- a\n|");
    expect(enter("- a\n  - |\nmore")).toBe("- a\n|\nmore");
  });

  test("the text after the caret moves to the new item", () => {
    expect(enter("- one |two")).toBe("- one \n- |two");
  });

  test("anything else is left to plain Enter", () => {
    expect(enter("plain text|")).toBeNull();
    expect(enter("-not a list|")).toBeNull();
    expect(enter("-| one")).toBeNull(); // caret inside the marker
    expect(enter("```\n- code|")).toBeNull(); // in an open fence
    expect(enter("```\nx\n```\n- after|")).toBe("```\nx\n```\n- after\n- |");
    expect(listContinuation("- one", 2, 4)).toBeNull(); // a selection
  });
});

beforeAll(() => store.configReady);
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = container = undefined; localStorage.clear(); });

async function mount(sent: string[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<ChatComposer onSubmit={async (t) => { sent.push(t); }} />);
    await flush();
  });
  return container.querySelector("textarea")!;
}
const type = async (el: HTMLTextAreaElement, text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  el.setSelectionRange(text.length, text.length);
};
const key = async (el: HTMLTextAreaElement, init: KeyboardEventInit = {}) => {
  await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init })); await flush(); });
};

describe("ChatComposer list continuation", () => {
  test("Enter on a list line continues the list; on an empty item it ends it; then Enter sends", async () => {
    const sent: string[] = [];
    const el = await mount(sent);
    await type(el, "Plan:\n1. read");
    await key(el);
    expect(el.value).toBe("Plan:\n1. read\n2. ");
    expect(el.selectionStart).toBe(el.value.length);
    expect(sent).toEqual([]);
    await key(el);
    expect(el.value).toBe("Plan:\n1. read\n");
    await key(el);
    expect(sent).toEqual(["Plan:\n1. read"]);
  });

  test("⌘/Ctrl+Enter on a list line sends; IME composition is left alone", async () => {
    const sent: string[] = [];
    const el = await mount(sent);
    await type(el, "- one");
    await key(el, { isComposing: true });
    expect(el.value).toBe("- one");
    expect(sent).toEqual([]);
    await key(el, { ctrlKey: true });
    expect(sent).toEqual(["- one"]);
  });

  test("Enter off a list line still sends", async () => {
    const sent: string[] = [];
    const el = await mount(sent);
    await type(el, "hello");
    await key(el);
    expect(sent).toEqual(["hello"]);
  });
});
