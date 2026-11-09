// Quote-aware paste in the chat composer: pasting a multi-line block onto a line that already opens
// as a markdown quote ("> " or a bare ">", the prefix the composer's own Quote action leaves) keeps
// the whole block one blockquote, instead of only its first line. Pure transform first
// (quotePaste), then the real ChatComposer in a DOM, with document.execCommand("insertText", …)
// stood in (happy-dom has none) so the native-undo path is exercised, not just the fallback.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./apiFake";
import * as store from "@/store";
import { ChatComposer } from "@/components/ChatComposer";
import { quotePaste } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("quotePaste", () => {
  test("a multi-line paste onto a '> ' line prefixes every later line", () => {
    expect(quotePaste("> ", 2, "Hello\nWorld")).toBe("Hello\n> World");
  });

  test("a bare '>' line (nothing typed after it yet) is a quote line too", () => {
    expect(quotePaste(">", 1, "Hello\nWorld")).toBe("Hello\n> World");
  });

  test("a blank line inside the paste becomes a bare '>' so the quote does not break", () => {
    expect(quotePaste("> ", 2, "Hello\n\nWorld")).toBe("Hello\n>\n> World");
  });

  test("CRLF line endings are normalized before prefixing", () => {
    expect(quotePaste("> ", 2, "Hello\r\nWorld\r\n\r\nDone")).toBe("Hello\n> World\n>\n> Done");
  });

  test("pasting mid-text on the quote line still quotes only the lines the paste adds", () => {
    expect(quotePaste("> already here", 14, "\nmore\nlines")).toBe("\n> more\n> lines");
  });

  test("a caret line with no quote prefix keeps today's behaviour (null)", () => {
    expect(quotePaste("plain text", 5, "Hello\nWorld")).toBeNull();
  });

  test("a single-line paste keeps today's behaviour, even on a quote line", () => {
    expect(quotePaste("> ", 2, "just one line")).toBeNull();
  });

  test("an earlier line's '> ' does not count — only the caret's own line matters", () => {
    expect(quotePaste("> quoted\nplain", 14, "Hello\nWorld")).toBeNull();
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
beforeAll(() => store.configReady);
beforeEach(() => { localStorage.clear(); });
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
async function setValue(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  el.setSelectionRange(value.length, value.length);
}
/** Dispatches a real "paste" event with plain text, the way the browser does. */
async function paste(el: HTMLTextAreaElement, text: string) {
  await act(async () => {
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { items: [], files: [], getData: (t: string) => (t === "text/plain" ? text : "") } });
    el.dispatchEvent(ev);
    await flush();
  });
}
/** Stands in for the browser's native `execCommand("insertText", …)`, which happy-dom has none of:
 *  replaces the focused field's selection and fires "input", like a real paste the browser handled
 *  itself — the path that keeps one Undo over the whole paste. Returns the calls it saw. */
function mockInsertText(): { cmds: string[] } {
  const calls: string[] = [];
  (document as unknown as { execCommand: (cmd: string, show?: boolean, value?: string) => boolean }).execCommand = (cmd, _show, value) => {
    calls.push(cmd);
    if (cmd !== "insertText") return false;
    const el = document.activeElement as HTMLTextAreaElement;
    const { selectionStart, selectionEnd } = el;
    el.setRangeText(value ?? "", selectionStart, selectionEnd, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  };
  return { cmds: calls };
}

describe("ChatComposer quote-aware paste", () => {
  test("a multi-line paste onto a Quoted line inserts as one blockquote, via a native insertText edit", async () => {
    const sent: string[] = [];
    const el = await mount(sent);
    const { cmds } = mockInsertText();
    try {
      await setValue(el, "> ");
      el.focus();
      await paste(el, "Hello\n\nWorld");
      expect(el.value).toBe("> Hello\n>\n> World");
      expect(cmds).toEqual(["insertText"]); // the native edit, not the manual setRangeText fallback
      expect(el.selectionStart).toBe(el.value.length);
    } finally {
      delete (document as unknown as { execCommand?: unknown }).execCommand;
    }
  });

  test("a single-line paste, and a multi-line paste off a quote line, are left to the browser's own paste", async () => {
    const sent: string[] = [];
    const el = await mount(sent);
    const { cmds } = mockInsertText();
    try {
      await setValue(el, "> ");
      el.focus();
      await paste(el, "just one line");
      expect(cmds).toEqual([]); // not transformed: the (mocked) browser's own default paste applies

      await setValue(el, "plain text");
      el.focus();
      await paste(el, "Hello\nWorld");
      expect(cmds).toEqual([]);
    } finally {
      delete (document as unknown as { execCommand?: unknown }).execCommand;
    }
  });
});
