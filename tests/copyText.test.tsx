// copyText's fallback order (lib/dialogs): the async clipboard; else, where it is missing (plain http
// on the tailnet: no secure context) or refuses, a hidden textarea + execCommand("copy") inside the
// click; the copy dialog ONLY when both fail. The execCommand path must leave the page as it was:
// focus and selection come back, and the textarea goes into an open modal, not under it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { copyText, execCopy } from "@/lib/dialogs";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const copyField = () => document.querySelector('[data-slot="copy-text"]');

/** What execCommand("copy") saw: the focused field's selected text, where that field sat, and when. */
let execs: { text: string; parent: Element | null; inside: boolean }[] = [];
let execResult = true;
let inClick = false;
const setClipboard = (value: unknown) => Object.defineProperty(navigator, "clipboard", { configurable: true, value });

beforeEach(() => {
  execs = []; execResult = true; inClick = false;
  (document as unknown as { execCommand: (c: string) => boolean }).execCommand = (cmd: string) => {
    const f = document.activeElement as HTMLTextAreaElement;
    if (cmd === "copy") execs.push({ text: f.value.slice(f.selectionStart, f.selectionEnd), parent: f.parentElement, inside: inClick });
    return execResult;
  };
});
afterEach(async () => {
  delete (document as unknown as { execCommand?: unknown }).execCommand;
  setClipboard(undefined);
  // happy-dom's Selection does not clear itself when its range's nodes are removed by an innerHTML
  // reassignment — document/window are ONE global for the whole bun test process (tests/happydom.ts),
  // so a leftover range here read as a live text selection in every later file (notificationCentre's
  // swipe test treats a selection as "the user is selecting text, not swiping" and bailed out).
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
  await wait(0);
});

test("the async clipboard first: no execCommand, no dialog", async () => {
  const writes: string[] = [];
  setClipboard({ writeText: async (t: string) => { writes.push(t); } });
  expect(await copyText("bun run build", "snippet")).toBe(true);
  expect(writes).toEqual(["bun run build"]);
  expect(execs).toEqual([]);
  expect(copyField()).toBeNull();
});

test("no async clipboard (plain http): execCommand inside the click, focus and selection kept, no dialog", async () => {
  setClipboard(undefined);
  const button = document.createElement("button");
  const para = document.createElement("p");
  para.textContent = "some chat text";
  document.body.append(para, button);
  button.focus();
  const range = document.createRange();
  range.selectNodeContents(para);
  document.getSelection()!.addRange(range);

  // The click handler's synchronous part: execCommand must run before copyText's first await.
  inClick = true;
  const done = copyText("line 1\n  line 2", "snippet");
  inClick = false;
  expect(await done).toBe(true);

  expect(execs).toEqual([{ text: "line 1\n  line 2", parent: document.body, inside: true }]);
  expect(document.activeElement).toBe(button);
  expect(document.getSelection()!.toString()).toBe("some chat text");
  expect(document.querySelector("textarea")).toBeNull(); // the hidden field is gone
  expect(copyField()).toBeNull();
});

test("a refused async clipboard falls back to execCommand", async () => {
  setClipboard({ writeText: async () => { throw new Error("NotAllowedError"); } });
  expect(await copyText("x", "snippet")).toBe(true);
  expect(execs.map((e) => e.text)).toEqual(["x"]);
  expect(copyField()).toBeNull();
});

test("inside a modal the hidden field goes into the modal, so it can take focus", () => {
  setClipboard(undefined);
  const modal = document.createElement("div");
  modal.setAttribute("role", "dialog");
  const button = document.createElement("button");
  modal.append(button);
  document.body.append(modal);
  button.focus();
  expect(execCopy("in modal")).toBe(true);
  expect(execs[0]!.parent).toBe(modal);
  expect(document.activeElement).toBe(button);
});

test("only when both fail: the copy dialog, and copyText resolves false once it closes", async () => {
  setClipboard({ writeText: async () => { throw new Error("NotAllowedError"); } });
  execResult = false;
  let result: boolean | undefined;
  await act(async () => { void copyText("bun run build", "snippet").then((r) => { result = r; }); await wait(0); });
  for (let i = 0; i < 100 && !copyField(); i++) await act(async () => { await wait(10); });
  expect(execs.length).toBe(1);
  expect((copyField() as HTMLTextAreaElement | null)?.value).toBe("bun run build");
  const close = [...document.querySelectorAll<HTMLButtonElement>("[data-slot=dialog-footer] button")].find((b) => b.textContent === "Close")!;
  await act(async () => { close.click(); await wait(0); });
  expect(result).toBe(false);
});
