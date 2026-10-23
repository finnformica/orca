// A quoted line in markdown once rendered near-white text on a near-black left bar — in the user's
// own (light-blue) bubble this was almost unreadable. Same root cause as chatMarkdownBold.test.tsx:
// Tailwind typography's own --tw-prose-quotes/--tw-prose-quote-borders vars resolve through
// --tw-prose-invert-quotes/--tw-prose-invert-quote-borders, which the .prose class sets to literal
// colours directly on the element — a declaration .log-themed's ancestor-level remap (styles.css)
// can never reach, since an element's own matching rule always beats an inherited custom property.
// The fix routes <blockquote> through Tailwind's own neutral tokens (prose-blockquote:text-neutral-400
// prose-blockquote:border-neutral-800), which .log-themed DOES correctly remap, the same way
// prose-strong/prose-headings/prose-code/prose-a already do.
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

const base: Row = {
  repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL",
  worktreePath: "/wt/feat", agentProvider: "claude",
};

async function mount(row: Row) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<ChatPanel row={row} />); await flush(); await flush(); });
}

beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  apiFake.reset();
});

test("a quote in an agent reply gets a visible colour and border class, not just the typography plugin's own default", async () => {
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", prompt: "status?", response: "Found it:\n\n> the Starcatcher org fails the same check\n\nFixed now.", finishedAt: 2 },
  ]);

  await mount(base);

  const quote = container!.querySelector("blockquote");
  expect(quote).toBeTruthy();
  expect(quote!.textContent).toContain("the Starcatcher org fails the same check");

  // The colour and border come from the ancestor .prose element's prose-blockquote: variant, not a
  // per-node class — the same pattern already used for strong/headings/code/links.
  const prose = quote!.closest(".prose")!;
  expect(prose.className).toContain("prose-blockquote:text-neutral-400");
  expect(prose.className).toContain("prose-blockquote:border-neutral-800");
});

test("a quote in the user's own bubble gets the same colour and border class", async () => {
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", instruction: "please check this:\n\n> I can't change the access level", prompt: "", response: "done", finishedAt: 2 },
  ]);

  await mount(base);

  const bubble = container!.querySelector<HTMLElement>('[data-slot="chat-user-text"]')!;
  const quote = bubble.querySelector("blockquote");
  expect(quote).toBeTruthy();
  expect(quote!.textContent).toContain("I can't change the access level");

  const prose = quote!.closest(".prose")!;
  expect(prose.className).toContain("prose-blockquote:text-neutral-400");
  expect(prose.className).toContain("prose-blockquote:border-neutral-800");
});
