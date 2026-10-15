// ↑/↓ message history in the chat composer, like a terminal / Slack / Claude Code: ↑ on the first line
// recalls the previous message you sent in THIS chat, ↓ on the last line walks forward and finally
// gives the in-progress draft back exactly. Sourced from the chat's transcript + queue + outbox
// (`composerHistory`), so the orchestrator's chat — whose sends go through the outbox, never
// `row.followUps` — has one too. Pure helpers first, then the real ChatComposer in a DOM.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./apiFake";
import * as store from "@/store";
import { ChatComposer } from "@/components/ChatComposer";
import { MESSAGE_BREAK, NO_WALK, WORKER_EVENT_MARKER, composerHistory, historyKey, historyStep, type HistoryWalk } from "@/workstream";
import { AUTOFIX_MARKER } from "../shared/agent";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (value: string, caret = value.length, end = caret) => ({ value, selectionStart: caret, selectionEnd: end });

describe("composerHistory", () => {
  test("every message you sent, newest first, deduplicated, with the queue and the outbox on top", () => {
    const turns = [
      { instruction: "first" },
      { instruction: `second${MESSAGE_BREAK}${WORKER_EVENT_MARKER} feat — done`},
      { instruction: "first" }, // sent again: moves to its newer position, listed once
      { instruction: `${WORKER_EVENT_MARKER} a — done` }, // a worker report is not yours
      { instruction: `${AUTOFIX_MARKER}\n\noutput` }, // nor Orca's autofix
      { instruction: "with files\n\nAttached files (Read these for extra context):\n- orca-attachment://1/a.png" },
    ];
    expect(composerHistory(turns, [{ instruction: "queued" }], [{ text: "sending" }]))
      .toEqual(["sending", "queued", "with files", "first", "second"]);
    expect(composerHistory(null)).toEqual([]);
  });
});

describe("historyKey", () => {
  test("single line: ↑ and ↓ both belong to history wherever the caret is", () => {
    expect(historyKey({ key: "ArrowUp" }, at(""))).toBe("up");
    expect(historyKey({ key: "ArrowUp" }, at("hello", 2))).toBe("up");
    expect(historyKey({ key: "ArrowDown" }, at("hello", 0))).toBe("down");
    expect(historyKey({ key: "Enter" }, at(""))).toBeNull();
  });
  test("multi-line: ↑ only on the first line, ↓ only on the last — else the caret moves", () => {
    const text = "one\ntwo\nthree";
    expect(historyKey({ key: "ArrowUp" }, at(text, 2))).toBe("up"); // in "one"
    expect(historyKey({ key: "ArrowUp" }, at(text, 3))).toBe("up"); // end of "one"
    expect(historyKey({ key: "ArrowUp" }, at(text, 5))).toBeNull(); // in "two"
    expect(historyKey({ key: "ArrowUp" }, at(text))).toBeNull(); // end: a recalled message climbs its lines first
    expect(historyKey({ key: "ArrowDown" }, at(text, 9))).toBe("down"); // in "three"
    expect(historyKey({ key: "ArrowDown" }, at(text, 5))).toBeNull();
    expect(historyKey({ key: "ArrowDown" }, at(text, 0))).toBeNull();
  });
  test("a soft-wrapped single line: no literal newline, but the real layout says the caret isn't on the first/last visual row", () => {
    // No "\n" anywhere, so the old string-only check would always say "up"/"down" belong to history —
    // the bug: a long single-line draft whose caret sits on its second or third WRAPPED row still got
    // replaced by the previous sent message. firstVisualRow/lastVisualRow carry what the textarea's
    // own layout says (computed by the caller, which has the real DOM); historyKey must defer to them.
    const wrapped = "a very long line that visually wraps onto several rows in the box";
    expect(historyKey({ key: "ArrowUp" }, { ...at(wrapped), firstVisualRow: false })).toBeNull();
    expect(historyKey({ key: "ArrowUp" }, { ...at(wrapped), firstVisualRow: true })).toBe("up");
    expect(historyKey({ key: "ArrowDown" }, { ...at(wrapped, 0), lastVisualRow: false })).toBeNull();
    expect(historyKey({ key: "ArrowDown" }, { ...at(wrapped, 0), lastVisualRow: true })).toBe("down");
    // No measurement available (undefined) falls back to the "\n"-only answer, unchanged.
    expect(historyKey({ key: "ArrowUp" }, at(wrapped))).toBe("up");
    expect(historyKey({ key: "ArrowDown" }, at(wrapped, 0))).toBe("down");
    // A real "\n" before/after the caret already decides it — the visual flags are never consulted.
    const text = "one\ntwo";
    expect(historyKey({ key: "ArrowUp" }, { ...at(text, 5), firstVisualRow: true })).toBeNull();
    expect(historyKey({ key: "ArrowDown" }, { ...at(text, 2), lastVisualRow: true })).toBeNull();
  });
  test("never with a selection, an open menu, mid-IME, or a modifier", () => {
    expect(historyKey({ key: "ArrowUp" }, at("hello", 0, 3))).toBeNull();
    expect(historyKey({ key: "ArrowUp" }, { ...at(""), menuOpen: true })).toBeNull();
    expect(historyKey({ key: "ArrowUp", isComposing: true }, at(""))).toBeNull();
    for (const mod of ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const) {
      expect(historyKey({ key: "ArrowUp", [mod]: true }, at(""))).toBeNull();
      expect(historyKey({ key: "ArrowDown", [mod]: true }, at(""))).toBeNull();
    }
  });
});

describe("historyStep", () => {
  const history = ["newest", "middle", "oldest"];
  test("↑ walks back to the oldest and stops; ↓ walks forward and restores the draft exactly", () => {
    let walk: HistoryWalk = NO_WALK;
    const texts: string[] = [];
    const go = (dir: "up" | "down", value: string) => {
      const s = historyStep(walk, dir, history, value);
      if (s) { walk = s.walk; texts.push(s.text); }
      return s;
    };
    expect(go("down", "my draft")).toBeNull(); // not walking: ↓ is the textarea's
    go("up", "my draft"); go("up", "newest"); go("up", "middle");
    expect(go("up", "oldest")).toBeNull(); // nothing older: the key is the textarea's
    go("down", "oldest edited"); // an edit to a recalled message is dropped on stepping away...
    go("down", "middle"); go("down", "newest");
    expect(texts).toEqual(["newest", "middle", "oldest", "middle", "newest", "my draft"]); // ...the draft never is
    expect(walk).toEqual(NO_WALK);
  });
  test("no history → nothing to recall", () => {
    expect(historyStep(NO_WALK, "up", [], "")).toBeNull();
  });
});

// --- the real composer ---
beforeAll(() => store.configReady);
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = container = undefined; localStorage.clear(); });

async function mount(history: string[], sent: string[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<ChatComposer history={history} onSubmit={async (t) => { sent.push(t); }} />);
    await flush();
  });
  return container.querySelector("textarea")!;
}
const type = async (el: HTMLTextAreaElement, text: string, caret = text.length) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  el.setSelectionRange(caret, caret);
};
const key = async (el: HTMLTextAreaElement, k: string, init: KeyboardEventInit = {}) => {
  let ev!: KeyboardEvent;
  await act(async () => { ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }); el.dispatchEvent(ev); await flush(); });
  return ev.defaultPrevented;
};

describe("ChatComposer ↑/↓", () => {
  test("recalls whole messages with the caret at the end, climbs a multi-line one first, and gives the draft back", async () => {
    const sent: string[] = [];
    const el = await mount(["line one\nline two", "older"], sent);
    await type(el, "half-typed\ndraft", 3); // caret on the first line of a two-line draft
    expect(await key(el, "ArrowUp")).toBe(true);
    expect(el.value).toBe("line one\nline two");
    expect(el.selectionStart).toBe(el.value.length); // caret at the END (on its last line)
    expect(await key(el, "ArrowUp")).toBe(false); // not the first line: the caret moves, no recall
    expect(el.value).toBe("line one\nline two");
    el.setSelectionRange(2, 2); // now on its first line
    expect(await key(el, "ArrowUp")).toBe(true);
    expect(el.value).toBe("older");
    expect(await key(el, "ArrowDown")).toBe(true);
    expect(await key(el, "ArrowDown")).toBe(true);
    expect(el.value).toBe("half-typed\ndraft"); // the draft, exactly
    expect(await key(el, "ArrowDown")).toBe(false); // not walking: the textarea's
  });

  test("an edited recall sends the edit; modifiers, a selection and IME are left alone", async () => {
    const sent: string[] = [];
    const el = await mount(["previous"], sent);
    expect(await key(el, "ArrowUp", { shiftKey: true })).toBe(false);
    expect(await key(el, "ArrowUp", { isComposing: true })).toBe(false);
    await type(el, "abc", 0);
    el.setSelectionRange(0, 2);
    expect(await key(el, "ArrowUp")).toBe(false);
    expect(el.value).toBe("abc");
    el.setSelectionRange(0, 0);
    await key(el, "ArrowUp");
    await type(el, "previous, edited");
    await key(el, "Enter");
    expect(sent).toEqual(["previous, edited"]);
    expect(el.value).toBe("");
  });
});
