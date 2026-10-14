// Chat message Copy/Quote: `quoteMarkdown` (workstream.ts) formats a message as a blockquote,
// ChatComposer's `insert` prop appends it after any existing draft and focuses the caret at the
// end, and ChatPanel wires both buttons onto every user and agent message (terminal and chat
// stylings alike). See web/src/views/Chat.tsx (MessageActions) and components/ChatComposer.tsx.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatComposer } from "@/components/ChatComposer";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";
import { quoteMarkdown } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
const type = (box: HTMLTextAreaElement, text: string) => {
  valueSetter.call(box, text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
};
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };

let root: Root | undefined;
let container: HTMLElement | undefined;
beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
});

// --- quoteMarkdown: the pure formatting helper -----------------------------------------------

test("quoteMarkdown prefixes every line with '> ' and adds a trailing blank line", () => {
  expect(quoteMarkdown("hello")).toBe("> hello\n\n");
  expect(quoteMarkdown("line one\nline two")).toBe("> line one\n> line two\n\n");
});

test("quoteMarkdown keeps an empty line in the middle, still prefixed", () => {
  expect(quoteMarkdown("a\n\nb")).toBe("> a\n> \n> b\n\n");
});

// --- ChatComposer's `insert` prop: append after the draft, focus, caret at the end -----------

function mount(ui: React.ReactElement): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => { root = createRoot(container!); root!.render(ui); });
  return container;
}

test("insert appends the quoted text after an existing draft, without losing it", () => {
  const c = mount(<ChatComposer onSubmit={async () => {}} />);
  const box = c.querySelector("textarea")!;
  act(() => type(box, "my draft"));
  act(() => { root!.render(<ChatComposer onSubmit={async () => {}} insert={{ text: quoteMarkdown("quoted text"), seq: 1 }} />); });

  expect(box.value).toBe("my draft\n> quoted text\n\n");
  // Focused, caret at the very end — so typing continues right after the quote.
  expect(document.activeElement).toBe(box);
  expect(box.selectionStart).toBe(box.value.length);
  expect(box.selectionEnd).toBe(box.value.length);
});

test("insert into an empty box is just the quoted text, with no leading blank line", () => {
  const c = mount(<ChatComposer onSubmit={async () => {}} insert={{ text: quoteMarkdown("solo"), seq: 1 }} />);
  const box = c.querySelector("textarea")!;
  expect(box.value).toBe("> solo\n\n");
});

test("a second insert (new seq) appends again, after the first", () => {
  const c = mount(<ChatComposer onSubmit={async () => {}} insert={{ text: quoteMarkdown("first"), seq: 1 }} />);
  const box = c.querySelector("textarea")!;
  act(() => { root!.render(<ChatComposer onSubmit={async () => {}} insert={{ text: quoteMarkdown("second"), seq: 2 }} />); });
  expect(box.value).toBe("> first\n\n> second\n\n");
});

test("the same seq repeated (no new click) does not insert again", () => {
  const c = mount(<ChatComposer onSubmit={async () => {}} insert={{ text: quoteMarkdown("first"), seq: 1 }} />);
  const box = c.querySelector("textarea")!;
  act(() => { root!.render(<ChatComposer onSubmit={async () => {}} insert={{ text: quoteMarkdown("first"), seq: 1 }} />); });
  expect(box.value).toBe("> first\n\n");
});

// --- End to end: the Copy/Quote buttons on a message in ChatPanel ----------------------------

const base: Row = {
  repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL",
  worktreePath: "/wt/feat", agentProvider: "claude",
};

async function mountPanel(row: Row, variant?: "terminal" | "chat") {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root!.render(<ChatPanel row={row} variant={variant} />); await flush(); await flush(); });
}

let copied: string[] = [];
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  value: { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } },
});

test("Copy puts the agent's raw response on the clipboard; Quote inserts it as a blockquote", async () => {
  copied = [];
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "add the cache", response: "## Outcome\nAdded it.", finishedAt: 2 }]);
  await mountPanel(base);

  const reply = container!.querySelector('[data-slot="turn-reply"]')!;
  await click(reply.querySelector('button[aria-label="Copy message"]')!);
  expect(copied).toEqual(["## Outcome\nAdded it."]); // the raw markdown, not the rendered sections

  await click(reply.querySelector('button[aria-label="Quote message"]')!);
  const box = container!.querySelector("textarea")!;
  expect(box.value).toBe("> ## Outcome\n> Added it.\n\n");
  expect(document.activeElement).toBe(box);
});

test("Copy and Quote also work on the user's own message", async () => {
  copied = [];
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "add the cache", response: "done", finishedAt: 2 }]);
  await mountPanel(base);

  const instruction = container!.querySelector('[data-slot="turn-instruction"]')!;
  await click(instruction.querySelector('button[aria-label="Copy message"]')!);
  expect(copied).toEqual(["add the cache"]);

  await click(instruction.querySelector('button[aria-label="Quote message"]')!);
  const box = container!.querySelector("textarea")!;
  expect(box.value).toBe("> add the cache\n\n");
});

test("quoting a second message appends after the first, keeping the draft", async () => {
  copied = [];
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "add the cache", response: "done", finishedAt: 2 }]);
  await mountPanel(base);

  const box = container!.querySelector("textarea")!;
  act(() => type(box, "re: "));
  const instruction = container!.querySelector('[data-slot="turn-instruction"]')!;
  await click(instruction.querySelector('button[aria-label="Quote message"]')!);
  expect(box.value).toBe("re: \n> add the cache\n\n");
});

test("the chat (bubble) styling carries the same Copy/Quote buttons on both sides", async () => {
  copied = [];
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "add the cache", response: "done", finishedAt: 2 }]);
  await mountPanel(base, "chat");

  const userBubble = container!.querySelector('[data-slot="chat-user"]')!;
  await click(userBubble.querySelector('button[aria-label="Quote message"]')!);
  expect(container!.querySelector("textarea")!.value).toBe("> add the cache\n\n");

  const reply = container!.querySelector('[data-slot="chat-reply"]')!;
  // Inline with the author's name: in the name line, right after "Orchestrator" (before the
  // hover-only time, whose reserved width once left them floating off on their own), centred on it.
  const head = reply.querySelector<HTMLElement>('[data-slot="chat-reply-head"]')!;
  expect(head.className).toMatch(/\bitems-center\b/);
  const actions = head.querySelector<HTMLElement>('[data-slot="message-actions"]')!;
  expect(actions.previousElementSibling!.textContent).toBe("Orchestrator");
  expect(actions.nextElementSibling!.getAttribute("data-slot")).toBe("turn-time");
  // Still hover-revealed, and always shown on a touch screen.
  expect(actions.className).toContain("group-hover:opacity-100");
  expect(actions.className).toContain("[@media(hover:none)]:opacity-100");
  await click(reply.querySelector('button[aria-label="Copy message"]')!);
  expect(copied).toEqual(["done"]);
});
