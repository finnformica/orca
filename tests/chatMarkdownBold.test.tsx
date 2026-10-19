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
import { outcomeLead, parseAgentOutcome } from "../shared/agent";

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

// A fenced block is a snippet card: a header (title, else language) and Copy, which writes the raw
// source exactly. ```plan / ```md render the markdown inside the card but copy the source.
import { snippetCopyText, snippetInfo } from "@/workstream";

test("snippetInfo reads the language and an optional title off the fence", () => {
  expect(snippetInfo("language-bash", "title=Deploy")).toEqual({ lang: "bash", title: "Deploy", markdown: false });
  expect(snippetInfo("language-plan", "title=Rollout steps")).toEqual({ lang: "plan", title: "Rollout steps", markdown: true });
  expect(snippetInfo("language-md", 'title="PR description" x=1')).toEqual({ lang: "md", title: "PR description", markdown: true });
  expect(snippetInfo("language-Markdown", null)).toEqual({ lang: "markdown", title: null, markdown: true });
  expect(snippetInfo("language-ts", "title=")).toEqual({ lang: "ts", title: null, markdown: false });
  expect(snippetInfo(undefined, undefined)).toEqual({ lang: "", title: null, markdown: false });
});

test("snippetCopyText drops only the newline the renderer adds", () => {
  expect(snippetCopyText("a\n  b\n")).toBe("a\n  b");
  expect(snippetCopyText("a\n\n")).toBe("a\n");
  expect(snippetCopyText("")).toBe("");
});

test("fenced blocks render as snippet cards whose Copy writes the raw source", async () => {
  const plan = "1. **Ship** it\n2. Watch `ci`";
  const code = "  bun run build\nbun run server";
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", prompt: "p", response: `Here:\n\n\`\`\`plan title=Rollout steps\n${plan}\n\`\`\`\n\n\`\`\`bash\n${code}\n\`\`\``, finishedAt: 2 },
  ]);
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { writes.push(t); } } });

  await mount(base);

  const cards = [...container!.querySelectorAll("[data-slot=snippet]")];
  expect(cards.length).toBe(2);
  expect(cards[0]!.querySelector("[data-slot=snippet-header]")!.textContent).toContain("Rollout steps");
  // The plan renders: bold text is a <strong>, not literal asterisks.
  expect(cards[0]!.querySelector("[data-slot=snippet-body] strong")!.textContent).toBe("Ship");
  expect(cards[1]!.querySelector("[data-slot=snippet-header]")!.textContent).toContain("bash");
  expect([...cards[1]!.querySelector("[data-slot=snippet-code] > code")!.children].map((l) => l.textContent)).toEqual(code.split("\n"));

  for (const card of cards) {
    await act(async () => { (card.querySelector("button[aria-label='Copy snippet']") as HTMLButtonElement).click(); await flush(); });
  }
  expect(writes).toEqual([plan, code]);
  expect(cards[1]!.querySelector("button[aria-label='Copy snippet'] .lucide-check")).toBeTruthy();
});

// The snippet that vanished after Copy: a worker put its PR text in a ```md snippet BEFORE its
// `## Outcome`, and the PR text has its own `## Outcome`. A finished turn showed only the parsed
// sections, so the snippet showed while the turn ran and went away when it finished. Now the text
// before the sections (outcomeLead) shows above them, a heading inside a fence is not a section, and
// Copy over plain http (no navigator.clipboard) copies in place: a check, no dialog, the same card.
test("a snippet before ## Outcome stays in the finished turn, and Copy over plain http keeps it", async () => {
  const pr = "## Outcome\nFixed the leak.\n\n## Verification\n- 0/20 failed";
  const response = `The PR text is below.\n\n\`\`\`md title=PR text\n${pr}\n\`\`\`\n\n## Outcome\nThe cause is a leak.\n\n## Verification\n- tsc: clean\n\n## Remaining\n- None`;
  const structured = parseAgentOutcome(response)!;
  expect(structured.outcome).toBe("The cause is a leak.");
  expect(structured.verification).toEqual(["tsc: clean"]);
  expect(outcomeLead(response)).toBe(`The PR text is below.\n\n\`\`\`md title=PR text\n${pr}\n\`\`\``);
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "p", response, structured, finishedAt: 2 }]);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const copies: string[] = [];
  (document as unknown as { execCommand: (c: string) => boolean }).execCommand = (cmd) => {
    const f = document.activeElement as HTMLTextAreaElement;
    if (cmd === "copy") copies.push(f.value);
    return true;
  };

  try {
    await mount(base);
    const card = container!.querySelector("[data-slot=turn-lead] [data-slot=snippet]")!;
    expect(card.querySelector("[data-slot=snippet-header]")!.textContent).toContain("PR text");
    expect(container!.textContent).toContain("The cause is a leak.");

    const button = card.querySelector<HTMLButtonElement>("button[aria-label='Copy snippet']")!;
    act(() => button.focus());
    await act(async () => { button.click(); await flush(); await flush(); });

    expect(copies).toEqual([pr]);
    expect(document.querySelector("[data-slot=copy-text]")).toBeNull(); // no copy dialog
    expect(button.querySelector(".lucide-check")).toBeTruthy(); // the check, in place
    expect(card.isConnected).toBe(true); // the same card, not a remount
    expect(container!.querySelectorAll("[data-slot=snippet]").length).toBe(1);
    expect(document.activeElement).toBe(button);
  } finally {
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  }
});
