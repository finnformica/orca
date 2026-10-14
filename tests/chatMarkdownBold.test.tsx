// Bold text in a markdown reply once rendered invisible: ChatMarkdown's <strong> colour came from
// Tailwind typography's own --tw-prose-bold/--tw-prose-invert-bold indirection, which the .prose
// class sets to a literal white directly on the element — a declaration .log-themed's ancestor-level
// remap can never reach (an element's own matching rule always beats an inherited custom property).
// In light theme that rendered strong text white-on-white. The fix routes <strong> through Tailwind's
// own neutral-200 token (prose-strong:text-neutral-200), which .log-themed DOES correctly remap, the
// same way prose-headings/prose-code/prose-a already do.
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

async function mount(row: Row) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<ChatPanel row={row} />); await flush(); await flush(); });
}

const base: Row = {
  repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL",
  worktreePath: "/wt/feat", agentProvider: "claude",
};

beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  apiFake.reset();
});

test("bold markdown gets a visible colour class, not just the typography plugin's own default", async () => {
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", prompt: "status?", response: "**Desktop:** works. **On phones:** also works.", finishedAt: 2 },
  ]);

  await mount(base);

  const strong = container!.querySelector("strong");
  expect(strong).toBeTruthy();
  expect(strong!.textContent).toBe("Desktop:");

  // The colour comes from the ancestor .prose element's prose-strong: variant, not a per-node class —
  // the same pattern already used for headings/code/links, which correctly dodges this bug.
  const prose = strong!.closest(".prose")!;
  expect(prose.className).toContain("prose-strong:text-neutral-200");
});
