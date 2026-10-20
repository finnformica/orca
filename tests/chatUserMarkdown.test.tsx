// The user's own chat bubble once showed plain text (whitespace-pre-wrap over the raw string).
// It now renders through the same ChatMarkdown renderer the agent's reply uses — bold, italic,
// inline code, lists, links and code blocks — styled for the bubble (`tone="text-foreground"`,
// matching the bubble's existing text colour on its accent background). A single newline, as
// typed, stays a visible line break (`breaks`): CommonMark alone would join it into the next
// line as one paragraph, which is wrong for a message that was never meant as prose.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;

async function mount(instruction: string) {
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", instruction, prompt: "", response: "done", finishedAt: 2 }]);
  const row: Row = { repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat", agentProvider: "claude" };
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<ChatPanel row={row} />); await flush(); await flush(); });
  return container!.querySelector<HTMLElement>('[data-slot="chat-user-text"]')!;
}

beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  apiFake.reset();
});

test("bold markdown in the user's own message renders as <strong>", async () => {
  const bubble = await mount("please **ship it** today");
  const strong = bubble.querySelector("strong")!;
  expect(strong).toBeTruthy();
  expect(strong.textContent).toBe("ship it");
});

test("italic markdown in the user's own message renders as <em>", async () => {
  const bubble = await mount("that was _quick_");
  const em = bubble.querySelector("em")!;
  expect(em).toBeTruthy();
  expect(em.textContent).toBe("quick");
});

test("inline code with backticks renders as <code>", async () => {
  const bubble = await mount("run `bun test` first");
  const code = bubble.querySelector("code")!;
  expect(code).toBeTruthy();
  expect(code.textContent).toBe("bun test");
});

test("a typed list renders as a real list", async () => {
  const bubble = await mount("todo:\n- one\n- two");
  const items = [...bubble.querySelectorAll("li")];
  expect(items.map((li) => li.textContent)).toEqual(["one", "two"]);
});

test("a single newline, as typed, stays a visible line break", async () => {
  const bubble = await mount("line one\nline two");
  // One paragraph (no blank line was typed), with a real <br> keeping the two lines apart —
  // CommonMark alone would join a single newline into the next line as one run of text.
  expect(bubble.querySelectorAll("p")).toHaveLength(1);
  expect(bubble.querySelector("br")).toBeTruthy();
  expect(bubble.textContent).toBe("line one\nline two");
});

test("plain text with no markdown renders unchanged", async () => {
  const bubble = await mount("just a normal message, nothing fancy here");
  expect(bubble.textContent).toBe("just a normal message, nothing fancy here");
  expect(bubble.querySelector("strong, em, code, ul, ol")).toBeNull();
});
