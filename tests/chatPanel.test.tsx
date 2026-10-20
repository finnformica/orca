// ChatPanel (views/Chat.tsx) renders the branch's durable conversation from GET /api/turns as a
// terminal-style log — the content of the card's terminal modal. Rendered into a real DOM against
// the fake api.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";
import { groupSteps, type AgentStep } from "../shared/agent";
import { toolDetail, toolLabel } from "@/steps";
import { chatPrompt, followUpPrompt, joinMessages, promptInstruction, undeliveredQueued, withAttachments } from "@/workstream";
import { openTip } from "./tip";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady); // cfg (repo "r") populated before the first render

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;

async function mount(row: Row) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<ChatPanel row={row} />); await flush(); await flush(); });
}
const text = () => container!.textContent ?? "";

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

test("renders every turn in the branch, not just the most recent", async () => {
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", prompt: "add the cache", response: "Added it.", finishedAt: 2 },
    { id: "run-2", provider: "codex", prompt: "now add a test", response: "Test added.", finishedAt: 4 },
  ]);

  await mount(base);

  // The whole point: the earlier exchange is still on screen.
  expect(text()).toContain("add the cache");
  expect(text()).toContain("Added it.");
  expect(text()).toContain("now add a test");
  expect(text()).toContain("Test added.");
  expect(text()).toContain("Codex"); // each turn is attributed to the provider that ran it
});

test("shows a structured outcome as labelled sections", async () => {
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", prompt: "ship it", response: "## Outcome\nShipped.", finishedAt: 2,
    structured: { outcome: "Shipped.", verification: ["bun run check"], decisions: [], remaining: ["docs"], commits: ["abc123 ship"] },
  }]);

  await mount(base);

  expect(text()).toContain("Shipped.");
  expect(text()).toContain("Remaining");
  expect(text()).toContain("docs");
  expect(text()).toContain("abc123 ship");
});

test("facet items render markdown — bold, code and links, not raw asterisks and backticks", async () => {
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", prompt: "ship it", response: "## Outcome\nShipped.", finishedAt: 2,
    structured: {
      outcome: "Shipped.",
      verification: [],
      decisions: ["Used `LRU` because it's **simpler**, per [the doc](https://example.com/doc)"],
      remaining: [],
      commits: [],
    },
  }]);

  await mount(base);

  const code = container!.querySelector("code");
  expect(code?.textContent).toBe("LRU");
  const strong = container!.querySelector("strong");
  expect(strong?.textContent).toBe("simpler");
  const link = container!.querySelector("a[href='https://example.com/doc']");
  expect(link?.textContent).toBe("the doc");
  // No raw markdown syntax leaks through as literal text.
  expect(text()).not.toContain("**simpler**");
  expect(text()).not.toContain("`LRU`");
});

test("a nested sub-bullet in a facet item renders as a real nested list, and a stray sub-heading as a heading", async () => {
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", prompt: "address pr", response: "## Outcome\nAddressed it.", finishedAt: 2,
    structured: {
      outcome: "Addressed it.",
      verification: [],
      decisions: [],
      remaining: [
        "Used LRU for the cache\n  - considered LFU but rejected it",
        "## Comment dispositions",
        "Resolved: renamed the field",
      ],
      commits: [],
    },
  }]);

  await mount(base);

  // The sub-bullet is a nested <ul>, not a sibling top-level item with no indication it was nested.
  const outerItems = container!.querySelectorAll("ul.list-disc > li");
  const parentItem = Array.from(outerItems).find((li) => li.textContent?.includes("Used LRU"));
  expect(parentItem?.querySelector("ul")?.textContent).toContain("considered LFU but rejected it");

  // The stray "## Comment dispositions" line renders as a heading, not literal "##" text.
  const heading = Array.from(container!.querySelectorAll("h1,h2,h3,h4,h5,h6")).find((h) => h.textContent === "Comment dispositions");
  expect(heading).toBeTruthy();
  expect(text()).not.toContain("## Comment dispositions");
});

test("an unfinished turn shows as in-progress instead of vanishing", async () => {
  // Turns are written at LAUNCH, so a run killed by a bridge restart stays visible as an interrupted
  // exchange — the case that used to lose the conversation entirely.
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "long job", response: "" }]);

  await mount({ ...base, agentStatus: "running" });

  expect(text()).toContain("long job");
  expect(text()).toContain("working…");
});

test("a failed turn is kept and surfaced, not dropped", async () => {
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", prompt: "break it", response: "exit 1", failed: true, finishedAt: 2 },
  ]);

  await mount(base);

  expect(text()).toContain("break it");
  expect(text()).toContain("exit 1");
  expect(text()).toContain("failed");
});

test("an empty conversation says so rather than rendering a blank panel", async () => {
  await mount(base);
  expect(text()).toContain("No history yet");
});

test("while a run is in flight, 'stop & send' interrupts it and sends the message as one gesture", async () => {
  // Managed Agents pairs user.interrupt with the next user.message in one call; this is that gesture.
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "long job", response: "" }]);
  await mount({ ...base, agentStatus: "running" });

  const alt = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("stop & send"))!;
  expect(alt).toBeTruthy();
  expect(openTip(alt).textContent).toBe("Interrupt the run and send this instead. The worktree, its commits, and the session are kept.");
  const box = container!.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "no, do it the other way");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  await act(async () => { alt.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });

  expect(apiFake.stopped).toEqual(["/wt/feat"]); // the run was interrupted first…
  expect(apiFake.claudePrompts.at(-1)).toContain("no, do it the other way"); // …then the message went
  expect(box.value).toBe(""); // and the box cleared like a normal send
});

test("with nothing running there is no 'stop & send'", async () => {
  await mount(base);
  expect([...container!.querySelectorAll("button")].some((b) => b.textContent?.includes("stop & send"))).toBe(false);
});

test("the composer sends a follow-up through the normal launch path", async () => {
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "first", response: "done", finishedAt: 2 }]);
  await mount(base);

  const box = container!.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "and now this");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  const send = container!.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
  await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });

  // Same headless one-shot every board action uses — the chat view adds no second runtime.
  expect(apiFake.claudePrompts.at(-1)).toContain("and now this");
});

test("the log shows only what you typed, not the prompt scaffolding wrapped around it", async () => {
  // A chat message is sent as instruction + a block of conversation rules + the outcome contract.
  // All of that is for the agent; in the log it buried the one line you actually wrote.
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", finishedAt: 2, response: "Sure.",
    prompt: chatPrompt("what do you think of the cache?"),
  }]);
  await mount(base);

  expect(text()).toContain("what do you think of the cache?");
  expect(text()).not.toContain("You are replying in a conversation");
  expect(text()).not.toContain("Finish your final response");
});

test("the composer clears as soon as you send, while the launch is still in flight", async () => {
  apiFake.turnsData.set("r::feat", []);
  apiFake.holdClaude = true; // launching an agent takes seconds — the box must not wait for it
  await mount(base);

  const box = container!.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "and now this");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  const send = container!.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
  await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });

  expect(box.value).toBe(""); // cleared although the launch hasn't resolved
  // The box is never busy: a second message goes while the first launch is still in flight, and
  // both show as "sending…" in the log until the bridge has them. (It used to ignore Enter until
  // the launch returned — seconds, longer over the tailnet.)
  expect(send.disabled).toBe(true); // only because the box is empty
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "and then this");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  expect(send.disabled).toBe(false);
  await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(box.value).toBe("");
  expect(container!.querySelectorAll('[data-slot="chat-sending"]').length).toBe(2);
  await act(async () => { apiFake.releaseClaude?.(); await flush(); await flush(); });
  expect(apiFake.claudePrompts.some((p) => p.includes("and now this"))).toBe(true);
  expect(apiFake.claudePrompts.some((p) => p.includes("and then this"))).toBe(true);
  expect(container!.querySelectorAll('[data-slot="chat-sending"]').length).toBe(0); // both answered
});

test("a send that fails while you're already typing the next message keeps both texts", async () => {
  apiFake.turnsData.set("r::feat", []);
  apiFake.holdClaude = true;
  await mount(base);
  const box = container!.querySelector("textarea")!;
  const type = async (s: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, s);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  const send = container!.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
  await type("first");
  await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  await type("second, in progress");
  // The held launch now fails: the box holds new text, so the lost one goes to the error line.
  apiFake.claudeError = "launch exploded";
  await act(async () => { apiFake.releaseClaude?.(); await flush(); await flush(); });
  expect(box.value).toBe("second, in progress");
  expect(text()).toContain("not sent: “first”");
});

test("a failed send puts the text back in the box", async () => {
  apiFake.turnsData.set("r::feat", []);
  apiFake.claudeError = "launch exploded";
  await mount(base);

  const box = container!.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "retry me");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  const send = container!.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
  await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });

  expect(box.value).toBe("retry me");
  expect(text()).toContain("launch exploded");
});

test("promptInstruction keeps a plain prompt whole", () => {
  expect(promptInstruction("just this")).toBe("just this");
  expect(promptInstruction(followUpPrompt("fix the flake"))).toBe("fix the flake");
});

test("a tool's output stays inside its own accordion instead of spilling into the log", async () => {
  // The bug: results were recorded as their own steps, so the collapsed call held only the command
  // while its (much longer) output rendered unconditionally underneath — "all collapsed, but the
  // majority of the text is just there". groupSteps folds the result into the call it belongs to.
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", prompt: "run the tests", response: "Done.", finishedAt: 2,
    steps: [
      { at: 1, kind: "text", text: "Running the suite now." },
      { at: 2, kind: "tool", id: "tu_1", name: "Bash", input: { command: "bun test" } },
      { at: 3, kind: "result", id: "tu_1", output: "SECRET_TOOL_OUTPUT 289 pass" },
    ],
  }]);

  await mount(base);

  // A finished turn folds its whole trail behind one line; the answer is what's on screen.
  expect(container!.querySelector('[data-slot="activity-chip"]')?.textContent).toBe("Worked · 2 steps");
  expect(text()).not.toContain("Running the suite now.");
  const fold = [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes("2 steps"));
  await act(async () => { fold!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

  expect(text()).toContain("Running the suite now."); // narration is the readable thread — visible
  expect(container!.querySelector('[data-slot="step-call"]')?.textContent).toBe("bun test"); // the real command, derived from its input — visible
  expect(text()).not.toContain("SECRET_TOOL_OUTPUT"); // its output — behind the toggle
  expect(text()).not.toContain("Tool result");        // and NOT a second row of its own

  // Opening that one call reveals the command AND its output together.
  const toggle = container!.querySelector('[data-slot="step-call"]')!.closest("button");
  await act(async () => { toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  expect(text()).toContain("SECRET_TOOL_OUTPUT 289 pass");
});

test("a live turn shows ONE compact activity block, and on finish it folds into a summary chip above the answer", async () => {
  // Finn: a wall of blue commands filled the chat while it worked, then vanished at once when the
  // answer came. Now: one block (the call in flight, a timer, counts, the last few runs faded), and
  // the block folds in place into `Worked for … · N steps` — nothing disappears.
  const now = Date.now();
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", prompt: "run the tests", response: "", startedAt: now - 72_000,
    steps: [
      { at: 1, kind: "tool", id: "r1", name: "Read", input: { file_path: "/a/one.ts" } },
      { at: 2, kind: "result", id: "r1", output: "SECRET_FILE_BODY" },
      { at: 3, kind: "tool", id: "r2", name: "Read", input: { file_path: "/a/two.ts" } },
      { at: 4, kind: "result", id: "r2", output: "x" },
      { at: 5, kind: "tool", id: "r3", name: "Read", input: { file_path: "/a/three.ts" } },
      { at: 6, kind: "result", id: "r3", output: "x" },
      { at: 7, kind: "text", text: "Now the **suite**." },
      { at: 8, kind: "tool", id: "tu_1", name: "Bash", input: { command: "bun test" } },
    ],
  }]);
  await mount({ ...base, agentStatus: "running" });
  const slot = (name: string) => container!.querySelector(`[data-slot="${name}"]`);
  // The header: the call in flight and the elapsed time.
  expect(slot("activity-current")?.textContent).toBe("Running: bun test…");
  expect(slot("activity-elapsed")?.textContent).toBe("1m 12s");
  expect(slot("activity-counts")?.textContent).toBe("1 command, 3 files read");
  // The trail: consecutive reads grouped, the interim message as one line of text.
  expect([...slot("activity-trail")!.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Read 3 files", "Now the suite."]); // markdown stripped on a faded line
  // The reserved height matches these two rows, not a fixed three-row box that would leave a
  // gap under a shorter trail (the bug: it always reserved room for three).
  expect((slot("activity-trail") as HTMLElement).style.minHeight).toBe("34px");
  // Nothing opens by itself: no command input, no output, no code block.
  expect(container!.querySelector("pre")).toBeNull();
  expect(text()).not.toContain("SECRET_FILE_BODY");
  // The header opens the full list: every REAL call on its own row — never the trail's summary
  // again — each with its status, and the interim text as prose, not code.
  await act(async () => { (slot("activity-head") as HTMLButtonElement).click(); });
  const rows = [...container!.querySelectorAll('[data-slot="activity-list"] [data-slot="step-tool"]')];
  expect(rows.map((r) => r.querySelector('[data-slot="step-call"]')?.textContent)).toEqual(["one.ts", "two.ts", "three.ts", "bun test"]);
  expect(rows.map((r) => r.getAttribute("data-status"))).toEqual(["done", "done", "done", "running"]);
  expect(rows[0]!.querySelector('[data-slot="step-duration"]')).toBeNull(); // result 1ms later: under 100ms, no `0.0s`
  expect(rows[3]!.querySelector('[data-slot="step-call"]')?.className).toContain("font-mono");
  expect(slot("activity-steps")?.textContent).not.toContain("Read 3 files");
  expect(slot("step-text")?.querySelector("strong")?.textContent).toBe("suite");
  await act(async () => { (slot("activity-head") as HTMLButtonElement).click(); });

  // The answer lands: the block is still there, folded to its chip, with the answer below it.
  apiFake.turnsData.set("r::feat", [{ ...apiFake.turnsData.get("r::feat")![0]!, response: "All green.", finishedAt: now }]);
  const stream = (globalThis as unknown as { EventSource: { opened: EventTarget[] } }).EventSource.opened.at(-1)!;
  await act(async () => {
    stream.dispatchEvent(Object.assign(new Event("turn"), { data: JSON.stringify({ repo: "r", branch: "feat", runId: "run-1" }) }));
    await flush(); await flush();
  });
  expect(text()).toContain("All green.");
  expect(slot("activity-live")?.hasAttribute("data-open")).toBe(false); // folding (height + opacity)
  expect(slot("activity-summary")?.hasAttribute("data-open")).toBe(true);
  expect(slot("activity-chip")?.textContent).toBe("Worked for 1m 12s · 5 steps");
  // The chip sits above the answer, in the place the block was.
  const order = slot("turn-activity")!.compareDocumentPosition([...container!.querySelectorAll("p")].find((p) => p.textContent === "All green.")!);
  expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Once the fold has played, the live block's content leaves the DOM.
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  expect(slot("activity-current")).toBeNull();
});

test("the live header's label swaps in two layers — the old line fades out as the new one fades in, never overlapping", async () => {
  // Finn: the old and new lines clashed mid-swap. Both now run together in one fixed-height,
  // clipped box; the old one carries `-out`, the new one the plain slot, so neither is ever the
  // only thing on screen at once and the box never grows a second line.
  const now = Date.now();
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", prompt: "run the tests", response: "", startedAt: now,
    steps: [{ at: 1, kind: "tool", id: "a", name: "Bash", input: { command: "bun test" } }],
  }]);
  await mount({ ...base, agentStatus: "running" });
  const slot = (name: string) => container!.querySelector(`[data-slot="${name}"]`);
  expect(slot("activity-current")?.textContent).toBe("Running: bun test…");
  expect(slot("activity-current-out")).toBeNull(); // nothing to fade from yet

  // Past the hold window, switch to a second in-flight call.
  await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
  apiFake.turnsData.set("r::feat", [{
    ...apiFake.turnsData.get("r::feat")![0]!,
    steps: [
      { at: 1, kind: "tool", id: "a", name: "Bash", input: { command: "bun test" } },
      { at: 2, kind: "result", id: "a", output: "x" },
      { at: 3, kind: "tool", id: "b", name: "Bash", input: { command: "bun run check" } },
    ],
  }]);
  const stream = (globalThis as unknown as { EventSource: { opened: EventTarget[] } }).EventSource.opened.at(-1)!;
  await act(async () => {
    stream.dispatchEvent(Object.assign(new Event("turn"), { data: JSON.stringify({ repo: "r", branch: "feat", runId: "run-1" }) }));
    await flush(); await flush();
  });

  // Both layers sit together: the old line fading out, the new one fading in — same box.
  const out = slot("activity-current-out");
  const incoming = slot("activity-current");
  expect(out?.textContent).toBe("Running: bun test…");
  expect(out?.className).toContain("label-out");
  expect(incoming?.textContent).toBe("Running: bun run check…");
  expect(incoming?.className).toContain("label-in");
  // One fixed-height, clipped box holds both — never a second line, never spilling out.
  expect(out?.closest("[class*='overflow-hidden']")).toBe(incoming?.closest("[class*='overflow-hidden']"));
  // The box takes 1.2em of layout, but its row (and so each line's own truncate clip) is 2.2em and
  // runs into padding, split evenly above and below, that a negative margin cancels: a descender
  // such as the g of `Thinking` is never cut off (the bug: the row shrank to 1.2em under a 1.625em
  // line), no space is added. `content-center` centres the oversized row on the 1.2em box's own
  // centre (a grid row bigger than its container anchors at the container's START by default, not
  // its centre), and `items-center` then centres the real line within that row — together putting
  // the line's own centre exactly on the box's centre (the bug: a bottom-only pad, and no content
  // alignment, hung the line off the box's top edge, so a flex sibling like the header's spinner —
  // centred on its own box — read as higher than the label).
  const clip = incoming!.closest("[class*='overflow-hidden']")!.classList;
  expect(["box-content", "content-center", "h-[1.2em]", "grid-rows-[2.2em]", "items-center", "py-[0.5em]", "-my-[0.5em]"].every((c) => clip.contains(c))).toBe(true);

  // Once the fade has played, only the new line is left.
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  expect(slot("activity-current-out")).toBeNull();
  expect(slot("activity-current")?.textContent).toBe("Running: bun run check…");
});

test("the live header names the newest call with no result, not the last step; the trail leaves it out", async () => {
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", prompt: "why the restart", response: "", startedAt: Date.now(),
    steps: [
      { at: 1, kind: "tool", id: "a", name: "Bash", input: { command: "orca board" } },
      { at: 2, kind: "result", id: "a", output: "x" },
      { at: 3, kind: "tool", id: "b", name: "Bash", input: { command: "git -C /opt/orca log" } }, // still running
      { at: 4, kind: "tool", id: "c", name: "Read", input: { file_path: "/a/notes.md" } },        // parallel, returned
      { at: 5, kind: "result", id: "c", output: "x" },
      { at: 6, kind: "thinking", text: "hm" },
    ],
  }]);
  await mount({ ...base, agentStatus: "running" });
  expect(container!.querySelector('[data-slot="activity-current"]')?.textContent).toBe("Running: git -C /opt/orca log…");
  const trail = [...container!.querySelectorAll('[data-slot="activity-trail"] li')].map((li) => li.textContent);
  expect(trail).toEqual(["Running: orca board", "Reading notes.md"]);
});

test("a finished turn does not repeat its final message as the last step", async () => {
  // The model's last text IS the response Output renders; showing it in the steps too doubled it.
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", prompt: "run the tests", response: "All 289 tests pass.", finishedAt: 2,
    steps: [{ at: 1, kind: "text", text: "Running the suite now." }, { at: 2, kind: "text", text: "All 289 tests pass." }],
  }]);
  await mount(base);
  const fold = [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes("1 step"));
  await act(async () => { fold!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  expect(text().split("All 289 tests pass.")).toHaveLength(2); // exactly once, even with the trail open
  expect(text()).toContain("Running the suite now.");
});

test("the log shows the recorded instruction when the turn has one, whatever the prompt looks like", async () => {
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", finishedAt: 2, response: "On it.",
    instruction: "Fix the failing CI checks", prompt: "Some prompt shape the marker list has never seen.\n\nFinish your final response with these concise sections:",
  }]);
  await mount(base);
  expect(text()).toContain("Fix the failing CI checks");
  expect(text()).not.toContain("Some prompt shape");
});

test("groupSteps pairs results with calls by id, by order when there is none, and keeps an orphan visible", () => {
  // Parallel calls can come back in any order; the id says which is which.
  const grouped = groupSteps([
    { at: 1, kind: "tool", id: "a", name: "Read", input: { file_path: "a.ts" } },
    { at: 1, kind: "tool", id: "b", name: "Read", input: { file_path: "b.ts" } },
    { at: 2, kind: "result", id: "b", output: "contents of b", isError: true },
    { at: 2, kind: "result", id: "a", output: "contents of a" },
  ]);
  expect(grouped).toHaveLength(2); // two calls, no free-floating result rows
  expect(grouped[0]).toMatchObject({ id: "a", output: "contents of a", done: true });
  expect(grouped[1]).toMatchObject({ id: "b", output: "contents of b", isError: true, done: true });

  // Rows written before ids (and before `kind: "result"`) still pair positionally.
  const legacy = groupSteps([
    { at: 1, kind: "tool", name: "Read", text: "Reading a.ts" },
    { at: 2, kind: "tool", name: "result", output: "contents of a" },
  ]);
  expect(legacy).toMatchObject([{ text: "Reading a.ts", output: "contents of a", done: true }]);

  // A result with no call to match (a transcript read mid-run) is kept, with a label so it is still
  // collapsible rather than rendering bare.
  expect(groupSteps([{ at: 1, kind: "result", id: "zzz", output: "orphan" }]))
    .toMatchObject([{ text: "Tool result", output: "orphan" }]);

  // Pure: the caller's steps are not mutated (the panel re-groups on every render).
  const input: AgentStep[] = [{ at: 1, kind: "tool", id: "x", name: "Bash", input: {} }, { at: 2, kind: "result", id: "x", output: "out" }];
  groupSteps(input);
  expect(input[0]!.output).toBeUndefined();
  expect(input[0]!.done).toBeUndefined();
});

test("a tool's label and detail come from its stored input, not from the row", () => {
  expect(toolLabel({ at: 1, kind: "tool", name: "Bash", input: { command: "bun   test" } })).toBe("Running: bun test");
  expect(toolLabel({ at: 1, kind: "tool", name: "Edit", input: { file_path: "/wt/x/src/foo.ts", old_string: "a", new_string: "b" } })).toBe("Editing foo.ts");
  expect(toolLabel({ at: 1, kind: "tool", name: "command_execution", input: { command: "ls" } })).toBe("Running: ls"); // codex
  expect(toolLabel({ at: 1, kind: "tool", name: "shell", input: { command: "ls" } })).toBe("Running: ls"); // cursor
  expect(toolLabel({ at: 1, kind: "tool", name: "mcp__slack__post", input: { channel: "#eng" } })).toBe("Using mcp__slack__post");
  expect(toolLabel({ at: 1, kind: "tool", name: "Bash", text: "Running: old row" })).toBe("Running: old row"); // legacy
  // Detail: a lone command reads bare; a richer input shows everything the row kept.
  expect(toolDetail({ at: 1, kind: "tool", name: "Bash", input: { command: "bun test" } })).toBe("bun test");
  expect(toolDetail({ at: 1, kind: "tool", name: "Edit", input: { file_path: "f", old_string: "a", new_string: "b" } })).toContain('"new_string": "b"');
  expect(toolDetail({ at: 1, kind: "tool", name: "Bash", detail: "old detail" })).toBe("old detail"); // legacy
});

test("the log follows new output, but not while the reader has scrolled up", async () => {
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "go", startedAt: 1 }]);
  await mount(base);

  const log = container!.querySelector("div.overflow-y-auto") as HTMLElement;
  // happy-dom doesn't lay out, so drive the geometry the scroll handler reads.
  Object.defineProperty(log, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(log, "clientHeight", { value: 200, configurable: true });
  const scrolled: number[] = [];
  log.scrollTo = ((opts: { top: number }) => scrolled.push(opts.top)) as unknown as typeof log.scrollTo;

  // A step pushed down the live stream is what appends output to the log.
  const stream = (globalThis as unknown as { EventSource: { opened: EventTarget[] } }).EventSource.opened.at(-1)!;
  const push = async (text: string) => {
    await act(async () => {
      stream.dispatchEvent(Object.assign(new Event("step"), {
        data: JSON.stringify({ repo: "r", branch: "feat", runId: "run-1", steps: [{ at: 1, kind: "text", text }] }),
      }));
      await flush();
    });
  };

  // Reader scrolls up to read something → following stops, so incoming steps don't yank them away.
  log.scrollTop = 200;
  await act(async () => { log.dispatchEvent(new Event("scroll")); });
  await push("while scrolled up");
  expect(text()).toContain("while scrolled up"); // still rendered — just not scrolled to
  expect(scrolled).toHaveLength(0);

  // Back at the bottom → following resumes and the next arrival scrolls again.
  log.scrollTop = 800; // 1000 - 200: pinned to the bottom
  await act(async () => { log.dispatchEvent(new Event("scroll")); });
  await push("back at the bottom");
  expect(scrolled).toEqual([1000]);
});

test("an instruction held mid-run shows as queued, and can be cancelled", async () => {
  // Before this, the composer invited "queue the next instruction" and the bridge answered 409 — the
  // message just vanished. It's now visibly waiting, and revocable while it still is.
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "big refactor", startedAt: 1 }]);
  apiFake.queuedData.set("feat", [
    { id: 7, repo: "r", branch: "feat", instruction: "also update the docs", attachments: [], createdAt: 2 },
  ]);

  await mount({ ...base, agentStatus: "running" });

  expect(text()).toContain("also update the docs");
  expect(text()).toContain("sends when the current run finishes"); // not silently pending

  const cancel = [...container!.querySelectorAll("button")].find((b) => b.textContent === "cancel");
  await act(async () => { cancel!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(text()).not.toContain("also update the docs");
});

test("a slow attachment save can't resurrect the message you already sent", async () => {
  // Attachments persist as data URLs via FileReader, so a save started when the file was attached
  // can still be in flight when you hit send. It used to land AFTER the clear, rewriting the draft —
  // so reopening the modal put the sent message (and its file) back in the box.
  apiFake.turnsData.set("r::feat", []);
  await mount(base);

  const box = container!.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "here is the spec");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files: [new File(["PK"], "spec.docx", { type: "application/octet-stream" })] } });
  await act(async () => { container!.querySelector("textarea")!.parentElement!.dispatchEvent(drop); });

  // Send WITHOUT waiting for the attachment's save to settle — the race.
  const send = container!.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
  await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await flush(); await flush(); await flush(); });

  expect(box.value).toBe("");
  expect(localStorage.getItem("orca.chat.r::feat")).toBeNull(); // nothing left to reopen with
});

test("a turn Orca verified shows the check's verdict apart from the agent's own claims", async () => {
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", prompt: "ship it", response: "## Outcome\nShipped.", finishedAt: 2,
      check: { command: "bun run check", ok: false, exitCode: 1, output: "1 fail\n(fail) W3 promote", durationMs: 900 } },
    { id: "run-2", provider: "claude", prompt: "fix it", response: "Fixed.", finishedAt: 4,
      check: { command: "bun run check", ok: true, exitCode: 0, output: "353 pass", durationMs: 800 } },
  ]);
  await mount(base);
  const checks = [...container!.querySelectorAll('[data-slot="turn-check"]')];
  expect(checks).toHaveLength(2);
  expect(checks[0]?.textContent).toContain("✗ bun run check failed (exit 1)");
  expect(checks[0]?.textContent).toContain("(fail) W3 promote"); // the evidence, foldable
  expect(checks[1]?.textContent).toContain("✓ bun run check passed");
});

test("the composer carries the card's model picker and context ring — the same controls the orchestrator's has", async () => {
  await mount({ ...base, preferredModel: "gpt-5.5", agentMeta: { model: "GPT-5.5", contextPct: 61 } });

  // The model the next message runs on, changeable where you type (every installed provider's models).
  const picker = container!.querySelector<HTMLElement>('[data-slot="chat-composer-leading"] [aria-label="Model"]')!;
  expect(picker.textContent).toBe("Codex · GPT-5.5");
  // The label is passed as raw children, not a <SelectValue> — the shared trigger still left-aligns
  // it and pins the chevron right (ml-auto on the icon, not a justify-between that centres a label
  // with no flex-grow of its own between it and the chevron).
  expect(picker.className).not.toContain("justify-between");
  expect(picker.className).toContain("[&_svg]:ml-auto");
  // And how full the session is, from the card's last run.
  const ring = container!.querySelector<HTMLButtonElement>('[data-slot="chat-composer-leading"] button[data-slot="context-ring"]')!;
  expect(ring.getAttribute("aria-label")).toBe("Context 61% full");
  const card = () => document.body.querySelector('[data-slot="context-ring-card"]');
  // Finn: a card that opened on hover was annoying. Neither hover nor focus opens it…
  await act(async () => {
    ring.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    ring.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    ring.focus();
    await new Promise((r) => setTimeout(r, 250));
  });
  expect(card()).toBeNull();
  // …only a click does (Enter or Space on the focused button is a click).
  await act(async () => { ring.click(); await flush(); });
  expect(card()!.textContent).toBe("Context 61% fullA fresh session starts at 80%.Compact");
  expect(ring.getAttribute("aria-expanded")).toBe("true");
  // Leaving with the pointer keeps it open; Esc closes it.
  await act(async () => { ring.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" })); await new Promise((r) => setTimeout(r, 250)); });
  expect(card()).not.toBeNull();
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(); });
  expect(card()).toBeNull();
  // A click outside closes it too.
  await act(async () => { ring.click(); await new Promise((r) => setTimeout(r, 20)); }); // Radix listens for an outside press a tick after it opens
  expect(card()).not.toBeNull();
  // A whole click on the page: this Radix version arms on the pointerdown and dismisses on the click.
  await act(async () => {
    const o = { bubbles: true, button: 0 };
    document.body.dispatchEvent(new PointerEvent("pointerdown", { ...o, pointerType: "mouse" }));
    document.body.dispatchEvent(new PointerEvent("pointerup", { ...o, pointerType: "mouse" }));
    for (const t of ["mousedown", "mouseup", "click"]) document.body.dispatchEvent(new MouseEvent(t, o));
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(card()).toBeNull();
});

test("a card whose runs never report context (Codex, Cursor, or nothing run yet) says so", async () => {
  await mount(base);
  const ring = container!.querySelector<HTMLButtonElement>('button[data-slot="context-ring"]')!;
  expect(ring.getAttribute("aria-label")).toBe("Context: not measured yet");
});

/** Click the context ring open and return its card. */
async function ringCard() {
  const ring = container!.querySelector<HTMLButtonElement>('button[data-slot="context-ring"]')!;
  await act(async () => { ring.click(); await flush(); });
  return document.body.querySelector<HTMLElement>('[data-slot="context-ring-card"]')!;
}
const compactButton = () => document.body.querySelector<HTMLButtonElement>('button[data-slot="context-compact"]');

test("the ring's Compact button compacts the session: pending until its turn finishes, then the ring is re-read", async () => {
  await mount({ ...base, sessionId: "claude-abc", agentMeta: { model: "Opus 5.5", contextPct: 72 } });
  await ringCard();
  expect(compactButton()!.textContent).toBe("Compact");
  await act(async () => { compactButton()!.click(); await flush(); await flush(); });
  expect(apiFake.calls).toContain("compact:r:feat"); // the conversation's own session, by repo + branch
  expect(compactButton()!.textContent).toBe("Compacting…");
  expect(compactButton()!.disabled).toBe(true);

  // The compact run's turn lands finished over the stream → no longer pending.
  apiFake.turnsData.set("r::feat", [{ id: "run-compact", provider: "claude", instruction: "/compact", prompt: "/compact", response: "Compacted: 144000 → 9000 tokens.", startedAt: 1, finishedAt: 2 }]);
  const stream = (globalThis as unknown as { EventSource: { opened: EventTarget[] } }).EventSource.opened.at(-1)!;
  await act(async () => { stream.dispatchEvent(Object.assign(new Event("turn"), { data: JSON.stringify({ repo: "r", branch: "feat", runId: "run-compact" }) })); await flush(); await flush(); });
  expect(compactButton()!.textContent).toBe("Compact");
  expect(document.body.querySelector('[data-slot="context-compact-error"]')).toBeNull();
});

test("a session mid-turn can't be compacted: the button is disabled and says why", async () => {
  await mount({ ...base, sessionId: "claude-abc", agentStatus: "running", agentMeta: { contextPct: 40 } });
  await ringCard();
  expect(compactButton()!.disabled).toBe(true);
  expect(openTip(compactButton()!).textContent).toBe("The agent is mid-turn — compact once it finishes.");
});

test("a refused compact (the bridge saw the session busy) shows its error in the card", async () => {
  apiFake.compactError = "the agent is mid-turn — compact once it finishes";
  await mount({ ...base, sessionId: "claude-abc", agentMeta: { contextPct: 40 } });
  await ringCard();
  await act(async () => { compactButton()!.click(); await flush(); await flush(); });
  expect(document.body.querySelector('[data-slot="context-compact-error"]')!.textContent).toBe("the agent is mid-turn — compact once it finishes");
  expect(compactButton()!.disabled).toBe(false); // nothing is running on our account: try again later
});

test("no Compact where the session never reports context (Codex, Cursor, nothing run yet)", async () => {
  await mount(base);
  await ringCard();
  expect(compactButton()).toBeNull();
});

/** Type into the panel's composer and send with Enter. */
async function sendText(value: string) {
  const textarea = container!.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush(); await flush();
  });
}
const sendingText = () => [...container!.querySelectorAll('[data-slot="chat-sending"]')].map((e) => e.textContent);

test("a sent message shows in the log at once, and gives way to the real turn when the bridge answers", async () => {
  apiFake.holdClaude = true; // the launch is still in flight
  await mount(base);
  await sendText("add a retry");

  expect(sendingText()).toEqual(["add a retry▋ sending…"]); // a bubble, like the message it becomes
  expect(container!.querySelector("textarea")!.value).toBe(""); // the box is already clear

  apiFake.turnsData.set("r::feat", [{ id: "run-9", provider: "claude", instruction: "add a retry", prompt: "p", response: "" }]);
  await act(async () => { apiFake.releaseClaude!(); await flush(); await flush(); await flush(); });
  expect(sendingText()).toEqual([]);
  expect(text()).toContain("add a retry"); // now the recorded turn, working
  expect(text()).toContain("▋ working…");
});

test("if the turn lands over the stream first, the message is not shown twice", async () => {
  apiFake.holdClaude = true;
  apiFake.turnsData.set("r::feat", [{ id: "run-9", provider: "claude", instruction: "add a retry", prompt: "p", response: "" }]);
  await mount(base);
  await sendText("add a retry");
  expect(sendingText()).toEqual([]);
  expect(text().split("add a retry")).toHaveLength(2); // exactly once
  await act(async () => { apiFake.releaseClaude!(); await flush(); await flush(); });
});

test("a message that fails to send is withdrawn from the log and handed back to the composer", async () => {
  apiFake.claudeError = "bridge down";
  await mount(base);
  await sendText("add a retry");
  expect(sendingText()).toEqual([]);
  expect(container!.querySelector("textarea")!.value).toBe("add a retry");
  expect(text()).toContain("bridge down");
});

test("the log never scrolls sideways: prose wraps unbreakable tokens, code blocks scroll inside themselves", async () => {
  // Measured in a real browser at the orchestrator window's width: an inline `branch/name-with-hash`
  // wider than the line pushed the whole log 3px past its box. happy-dom has no layout, so this
  // pins the rules that fixed it.
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "p", response: "See `orca/surface-branch-review-checks-to-activity-27f26a`.", finishedAt: 2 }]);
  await mount(base);
  const log = container!.querySelector<HTMLElement>('[data-slot="chat-log"]')!;
  expect(log.className).toContain("overflow-x-hidden");
  const prose = log.querySelector<HTMLElement>(".prose")!;
  expect(prose.className).toContain("wrap-anywhere");
  expect(prose.className).toContain("prose-pre:wrap-normal");
});

test("your newest message and the newest answer are never clamped or folded; older ones keep their clamp", async () => {
  // Finn: the latest message from the user and from the orchestrator should never be hidden.
  const long = (tag: string) => `${tag}\n${Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n")}`;
  const report = '[worker finished] r/a "A" — done\nOutcome: Added it.';
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", instruction: long("OLD_ASK"), prompt: "p", response: long("OLD_REPLY"), finishedAt: 1 },
    ...[2, 3, 4].map((n) => ({ id: `run-${n}`, provider: "claude", instruction: `q${n}`, prompt: "p", response: `a${n}`, finishedAt: n })),
    { id: "run-5", provider: "claude", instruction: long("NEW_ASK"), prompt: "p", response: "short", finishedAt: 5 },
    // The newest answer came from a wake of worker reports alone — it must not fold into the ⚙ block.
    { id: "run-6", provider: "claude", instruction: report, prompt: "p", response: long("NEW_REPLY"), finishedAt: 6 },
  ]);
  await mount(base);
  const clamped = () => [...container!.querySelectorAll('[data-slot="turn-clamp"]')].map((c) => c.textContent!.match(/OLD_ASK|OLD_REPLY|NEW_ASK|NEW_REPLY/)?.[0]);
  // Only the old ask and the old reply are clamped.
  expect(clamped()).toEqual(["OLD_ASK", "OLD_REPLY"]);
  expect(text()).toContain("NEW_ASK");
  expect(text()).toContain("NEW_REPLY");
  expect(container!.querySelector('[data-slot="agents-marker"]')).toBeNull();
  expect(container!.querySelector('[data-slot="turn-reports"]')).not.toBeNull(); // its reports still fold

  // A newer message arrives: the previous newest stays in full while it is on screen (no shrink).
  apiFake.turnsData.set("r::feat", [...apiFake.turnsData.get("r::feat")!, { id: "run-7", provider: "claude", instruction: "thanks", prompt: "p", response: "ok", finishedAt: 7 }]);
  const stream = (globalThis as unknown as { EventSource: { opened: EventTarget[] } }).EventSource.opened.at(-1)!;
  await act(async () => {
    stream.dispatchEvent(Object.assign(new Event("turn"), { data: JSON.stringify({ repo: "r", branch: "feat", runId: "run-7" }) }));
    await flush(); await flush();
  });
  expect(text()).toContain("thanks");
  expect(clamped()).toEqual(["OLD_ASK", "OLD_REPLY"]);
});

test("a worker-woken reply is always open; only the reports that woke it fold into one ⚙ block", async () => {
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", instruction: '[worker finished] r/a "A" — done\nOutcome: Added it.\nFull turn: orca read --run x\n\n[worker finished] r/b "B" — error\nResponse: boom', prompt: "p", response: "A is done; B failed, I've resent it.", finishedAt: 2 },
    { id: "run-2", provider: "claude", instruction: "what now?", prompt: "p", response: "Waiting on C.", finishedAt: 4 },
  ]);
  await mount(base);
  // run-1 has a real reply, so it is its own turn, not folded into a run of agent turns.
  expect(container!.querySelector('[data-slot="agents-marker"]')).toBeNull();
  expect(text()).toContain("A is done; B failed, I've resent it.");
  // Only the reports that woke it fold, in their own block on that turn.
  const reports = container!.querySelector('[data-slot="turn-reports"]')!;
  expect(reports.querySelector('[data-slot="worker-block-label"]')!.textContent).toBe("2 worker reports");
  expect(reports.querySelector('[data-slot="worker-reports"]')).toBeNull(); // collapsed by default
  await act(async () => { reports.querySelector("button")!.click(); await flush(); });
  const open = container!.querySelector('[data-slot="worker-reports"]')!;
  expect([...open.querySelectorAll("summary")].map((s) => s.textContent)).toEqual(['⚙ r/a "A" — done', '⚙ r/b "B" — error']);
  expect(open.textContent).toContain("Outcome: Added it."); // the full report is behind the toggle
  // A message you typed is still your bubble, outside the block.
  expect([...container!.querySelectorAll('[data-slot="chat-user-text"]')].map((u) => u.textContent)).toEqual(["what now?"]);
  expect(reports.contains(container!.querySelector('[data-slot="chat-user"]'))).toBe(false);
});

test("a worker-woken reply stays visible after a newer worker-woken reply arrives; a wake with nothing to say still folds", async () => {
  const report = (name: string) => `[worker finished] r/${name} "Feature ${name}" — done\nOutcome: Shipped it.`;
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", instruction: report("a"), prompt: "p", response: "Reply A: shipped and verified.", finishedAt: 2 },
    { id: "run-2", provider: "claude", instruction: report("b"), prompt: "p", response: "Reply B: shipped and verified too.", finishedAt: 4 },
    // A wake with nothing to say for itself — no text, no structured outcome — still folds.
    { id: "run-3", provider: "claude", instruction: report("c"), prompt: "p", response: "", finishedAt: 6 },
    { id: "run-4", provider: "claude", instruction: "thanks", prompt: "p", response: "You're welcome.", finishedAt: 8 },
  ]);
  await mount(base);
  // Both real replies stay in the open, each its own turn — run-2 finishing later does not fold run-1
  // away.
  expect(text()).toContain("Reply A: shipped and verified.");
  expect(text()).toContain("Reply B: shipped and verified too.");
  expect(container!.querySelectorAll('[data-slot="turn-reports"]').length).toBe(2);
  // run-3 has no reply worth keeping open: it folds into its own run.
  const marker = container!.querySelector('[data-slot="agents-marker"]')!;
  expect(marker).not.toBeNull();
  expect(marker.querySelector('[data-slot="worker-block-label"]')!.textContent).toMatch(/^1 worker report · 1 reply/);
  expect(text()).toContain("You're welcome.");
});

test("a worker report waiting in the queue is a muted system line too, not a queued prompt", async () => {
  apiFake.queuedData.set("feat", [
    { id: 1, repo: "r", branch: "feat", instruction: '[worker finished] r/a "A" — done\nOutcome: Added it.', attachments: [], createdAt: 1 },
    { id: 2, repo: "r", branch: "feat", instruction: "and then deploy it", attachments: [], createdAt: 2 },
  ]);
  await mount(base);
  const held = container!.querySelector('[data-slot="worker-report-held"]')!;
  expect(held.textContent).toBe('⚙ r/a "A" — doneheld for the batch');
  expect(container!.querySelector('[data-slot="chat-queued"]')!.textContent).toContain("and then deploy it"); // a message of yours still shows as queued
  expect(text()).toContain("queued — sends when the current run finishes");
});

test("a delivered queued message leaves the queue at once: on a stream reconnect, and despite a stale queue read", async () => {
  // Queued behind a running turn: drawn as queued.
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", instruction: "first", prompt: "p", response: "done 1", startedAt: 1, finishedAt: 5 }]);
  apiFake.queuedData.set("feat", [{ id: 7, repo: "r", branch: "feat", instruction: "and then deploy it", attachments: [], createdAt: 3 }]);
  await mount(base);
  expect(container!.querySelector('[data-slot="chat-queued"]')!.textContent).toContain("and then deploy it");
  // The stream dropped (a phone tab in the background) while the bridge sent the message and the agent
  // answered. The reconnect's `ready` must re-read the queue, not only the turns.
  apiFake.queuedData.set("feat", []);
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", instruction: "first", prompt: "p", response: "done 1", startedAt: 1, finishedAt: 5 },
    { id: "run-2", provider: "claude", instruction: "and then deploy it", prompt: "p", response: "Deployed.", startedAt: 6, finishedAt: 9 },
  ]);
  const stream = (globalThis as unknown as { EventSource: { opened: EventTarget[] } }).EventSource.opened.at(-1)!;
  await act(async () => { stream.dispatchEvent(new Event("ready")); await flush(); await flush(); });
  expect(text()).toContain("Deployed.");
  expect(container!.querySelector('[data-slot="chat-queued"]')).toBeNull();

  // A queue read that still lists the entry (out of order, or from before the dispatch) does not
  // bring it back: the turns show it delivered.
  apiFake.queuedData.set("feat", [{ id: 7, repo: "r", branch: "feat", instruction: "and then deploy it", attachments: [], createdAt: 3 }]);
  await act(async () => { stream.dispatchEvent(Object.assign(new Event("turn"), { data: JSON.stringify({ repo: "r", branch: "feat", runId: "run-2" }) })); await flush(); await flush(); });
  expect(container!.querySelector('[data-slot="chat-queued"]')).toBeNull();
});

test("a queued message is the sent bubble with the same markdown, faded; once sent it looks the same without the fade", async () => {
  const msg = "**ship** it with `bun run build`\n\n- one\n- two";
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", instruction: "first", prompt: "p", response: "done 1", startedAt: 1, finishedAt: 5 }]);
  apiFake.queuedData.set("feat", [{ id: 7, repo: "r", branch: "feat", instruction: msg, attachments: [], createdAt: 3 }]);
  await mount(base);
  const queued = container!.querySelector<HTMLElement>('[data-slot="chat-queued"]')!;
  const queuedText = queued.querySelector<HTMLElement>('[data-slot="chat-queued-text"]')!;
  // Markdown, like a sent message — never the raw `**` and `-`.
  expect(queuedText.querySelector("strong")!.textContent).toBe("ship");
  expect(queuedText.querySelector("code")!.textContent).toBe("bun run build");
  expect([...queuedText.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["one", "two"]);
  expect(queuedText.textContent).not.toContain("**");
  // Pending: the message fades, the label says why, and it can still be cancelled.
  expect(queued.dataset.pending).toBe("true");
  expect(queuedText.className).toContain("opacity-60");
  expect(queued.querySelector('[data-slot="queued-label"]')!.textContent).toBe("queued — sends when the current run finishescancel");
  const queuedHtml = queuedText.innerHTML, queuedClass = queuedText.className.replace(" opacity-60", ""), shellClass = queued.className;

  // It sends: the same bubble in its turn, the same markup, minus the fade.
  apiFake.queuedData.set("feat", []);
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", instruction: "first", prompt: "p", response: "done 1", startedAt: 1, finishedAt: 5 },
    { id: "run-2", provider: "claude", instruction: msg, prompt: "p", response: "Shipped.", startedAt: 6, finishedAt: 9 },
  ]);
  const stream = (globalThis as unknown as { EventSource: { opened: EventTarget[] } }).EventSource.opened.at(-1)!;
  await act(async () => { stream.dispatchEvent(new Event("ready")); await flush(); await flush(); });
  expect(container!.querySelector('[data-slot="chat-queued"]')).toBeNull();
  const sent = [...container!.querySelectorAll<HTMLElement>('[data-slot="chat-user"]')].at(-1)!;
  const sentText = sent.querySelector<HTMLElement>('[data-slot="chat-user-text"]')!;
  expect(sentText.innerHTML).toBe(queuedHtml);
  expect(sentText.className).toBe(queuedClass);
  expect(sent.className).toBe(shellClass.replace("mb-4", "mb-2")); // the turn's spacing, nothing else
  expect(sent.dataset.pending).toBeUndefined();
  expect(sentText.className).not.toContain("opacity-60");
});

test("undeliveredQueued: a turn delivers a queued entry only if it started after it and carries its text", () => {
  const q = [{ instruction: "deploy", createdAt: 10 }, { instruction: "and test", createdAt: 10 }];
  // The same text sent BEFORE the entry was queued does not deliver it.
  expect(undeliveredQueued(q, [{ instruction: "deploy", startedAt: 5 }])).toEqual(q);
  // An orchestrator wake carries several messages; each one it carries is delivered.
  expect(undeliveredQueued(q, [{ instruction: joinMessages(["deploy", "other"]), startedAt: 11 }])).toEqual([q[1]!]);
  expect(undeliveredQueued(q, null)).toEqual(q);
});

test("Enter sends; Shift+Enter and ⌘+Enter break the line instead", async () => {
  await mount(base);
  const textarea = container!.querySelector("textarea")!;
  const type = async (v: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, v); textarea.dispatchEvent(new Event("input", { bubbles: true })); await flush(); });
  await type("line one");
  // ⌘+Enter: a newline goes in at the caret, nothing is sent.
  await act(async () => { textarea.setSelectionRange(8, 8); textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })); await flush(); });
  expect(textarea.value).toBe("line one\n");
  expect(apiFake.agentLaunches).toEqual([]);
  // Shift+Enter: the textarea's own newline (not prevented), nothing is sent.
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })); await flush(); });
  expect(apiFake.agentLaunches).toEqual([]);
  // Enter alone sends what is there.
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await flush(); await flush(); });
  expect(apiFake.agentLaunches.map((l) => l.prompt.includes("line one"))).toEqual([true]);
  expect(textarea.value).toBe("");
});

test("an older turn that arrived without its steps loads them on unfold", async () => {
  apiFake.turnsData.set("r::feat", [{ id: "run-old", provider: "claude", prompt: "p", instruction: "old work", response: "Did it.", finishedAt: 2 }]); // no `steps`
  apiFake.turnStepsData.set("run-old", [{ seq: 0, step: { kind: "tool", name: "Bash", input: { command: "bun test" }, at: 1 } }, { seq: 1, step: { kind: "result", output: "ok", at: 2 } }]);
  await mount(base);
  const unfold = container!.querySelector<HTMLButtonElement>('[data-slot="activity-chip"]')!;
  expect(unfold.textContent).toBe("Worked"); // the count is unknown until the steps load: no bare "steps"
  expect(unfold).toBeTruthy();
  await act(async () => { unfold.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });
  expect(text()).toContain("1 step"); // fetched from /api/turns/steps from seq 0, then folded like any finished turn
});

test("a sent message shows its attachments — a thumbnail for an image, a named chip otherwise, each served from the bridge", async () => {
  const img = "55555555-5555-5555-5555-555555555555", doc = "66666666-6666-6666-6666-666666666666";
  // An agent chat: the bridge decorates the turn with the files its prompt carried.
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", instruction: "what's wrong here?", prompt: "", response: "A typo.", finishedAt: 2,
    attachments: [{ id: img, name: "Screen-Shot.png" }, { id: doc, name: "notes.txt" }],
  }]);
  await mount(base);
  const thumb = container!.querySelector<HTMLImageElement>('[data-slot="expandable-image"] img');
  expect(thumb?.getAttribute("src")).toBe(`/api/attachments/${img}`);
  const chip = container!.querySelector<HTMLAnchorElement>('[data-slot="attachment-file"]');
  expect(chip?.textContent).toBe("notes.txt");
  expect(chip?.getAttribute("href")).toBe(`/api/attachments/${doc}`);
  await act(async () => { root?.unmount(); });
  container?.remove();

  // The orchestrator's composer: its turn's instruction carries the list; the chat shows chips instead.
  apiFake.turnsData.set("r::feat", [{
    id: "run-2", provider: "claude", prompt: "", response: "Looking.", finishedAt: 4,
    instruction: withAttachments("look at this", [`orca-attachment://${img}/bug.png`]),
    attachments: [{ id: img, name: "bug.png" }],
  }]);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<ChatPanel row={base} />); await flush(); await flush(); });
  expect(container.querySelector('[data-slot="chat-user"]')?.textContent).toContain("look at this");
  expect(text()).not.toContain("orca-attachment://");
  expect(text()).not.toContain("Attached files");
  expect(container.querySelector<HTMLImageElement>('[data-slot="chat-user"] [data-slot="expandable-image"] img')?.getAttribute("src")).toBe(`/api/attachments/${img}`);
});

test("↑ in the composer recalls what you sent from the chat's transcript, not row.followUps", async () => {
  // No followUps on the row (the orchestrator never has any; nor does a message sent from quick-ask
  // or the palette) — the history is the conversation itself.
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", prompt: "", instruction: "older ask", response: "ok", finishedAt: 2 },
    { id: "run-2", provider: "claude", prompt: "", instruction: "newer ask", response: "ok", finishedAt: 3 },
  ]);
  await mount(base);
  const box = container!.querySelector("textarea")!;
  const up = async (k = "ArrowUp") => act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); await flush(); });
  await up();
  expect(box.value).toBe("newer ask");
  await up();
  expect(box.value).toBe("older ask");
  await up("ArrowDown"); await up("ArrowDown");
  expect(box.value).toBe("");
});
