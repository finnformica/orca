// A user message that quotes a reply with a fenced code block (the Quote button, QUOTE_PILL in
// views/Chat.tsx) holds an unbreakable long line. The bubble (`[data-slot="chat-user-text"]`) must
// cap at its column's width so prose wraps and the code block scrolls inside itself (Snippet.tsx),
// instead of the bubble growing past the chat column — see UserBubble in views/Chat.tsx.
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
const row: Row = { repo: "r", hasRemote: false, branch: "quoted", title: "Quoted", prompt: "", lane: "LOCAL", worktreePath: "/wt/quoted", agentProvider: "claude" };

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<ChatPanel row={row} />); await flush(); await flush(); });
}
beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(async () => { await act(async () => { root?.unmount(); }); container?.remove(); apiFake.reset(); });

test("a quoted reply with a long code line keeps the bubble capped to its column", async () => {
  const longLine = "aws ssm send-command --region eu-west-2 --instance-ids i-07de815c13bc95313 --document-name AWS-RunShellScript";
  const instruction = [
    "> Set `ROUTER_MAX_REDIRECTS=12` before you deploy, or the edge workers loop.",
    ">",
    "> ```bash",
    `> ${longLine}`,
    "> ```",
    "",
  ].join("\n");
  apiFake.turnsData.set("r::quoted", [
    { id: "run-1", provider: "claude", instruction, prompt: "", response: "done", startedAt: 1000, finishedAt: 1001 },
  ]);
  await mount();
  const bubble = container!.querySelector<HTMLElement>('[data-slot="chat-user-text"]')!;
  expect(bubble).not.toBeNull();
  // The cap that lets the code block's own overflow-x-auto (Snippet.tsx) take over instead of the
  // bubble growing past the chat column (the bug: the bubble's left side ran under whatever sits
  // beside it).
  expect(bubble.className.split(/\s+/)).toContain("max-w-full");
  // The quote and its code block still render as markdown, unaffected by the layout fix.
  expect(bubble.querySelector("blockquote")).not.toBeNull();
  expect(bubble.textContent).toContain(longLine);
});
