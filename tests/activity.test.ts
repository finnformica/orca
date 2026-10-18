// The live activity block's pure decisions (web/src/steps.ts): how steps group, count and label.
import { expect, test } from "bun:test";
import type { AgentStep } from "../shared/agent";
import { activityCounts, closeOpenMarkdown, currentActivity, plainText, runLabel, stepInFlight, stepRuns, workedLabel, workSteps } from "@/steps";

const tool = (name: string, input: Record<string, unknown> = {}, done = true): AgentStep => ({ at: 0, kind: "tool", name, input, done });
const text = (t: string): AgentStep => ({ at: 0, kind: "text", text: t });

test("consecutive same-kind calls group into one run; messages never merge", () => {
  const runs = stepRuns([tool("Read", { file_path: "/a.ts" }), tool("Read", { file_path: "/b.ts" }), tool("Read"), text("one"), text("two"), tool("Bash", { command: "ls" }), tool("Read", { file_path: "/c.ts" })]);
  expect(runs.map(runLabel)).toEqual(["Read 3 files", "one", "two", "Running: ls", "Reading c.ts"]);
  expect(runLabel({ kind: "command", steps: [tool("Bash"), tool("shell")] })).toBe("Ran 2 commands");
  expect(runLabel({ kind: "search", steps: [tool("Grep"), tool("Glob")] })).toBe("Searched 2 times");
  // Two different unknown tools stay apart.
  expect(stepRuns([tool("mcp_a"), tool("mcp_b")])).toHaveLength(2);
});

test("the count line covers tool calls only, in a fixed order", () => {
  const steps = [tool("Grep"), tool("Read"), text("hi"), tool("Bash"), tool("Bash"), tool("Read"), tool("Grep"), tool("Edit"), tool("custom")];
  expect(activityCounts(steps)).toBe("2 commands, 2 files read, 1 edit, 2 searches, 1 other tool");
  expect(activityCounts([text("only talk")])).toBe("");
});

test("the live verb is the call in flight, else Thinking; the step count skips thinking", () => {
  expect(currentActivity([tool("Bash", { command: "orca board" }, false)])).toBe("Running: orca board");
  expect(currentActivity([tool("Bash", { command: "orca board" })])).toBe("Thinking");
  expect(currentActivity([])).toBe("Thinking");
  expect(workSteps([tool("Read"), { at: 0, kind: "thinking", text: "hm" }, text("ok")])).toBe(2);
});

test("the live verb is the NEWEST call with no result, even when later steps landed after it", () => {
  const run = (c: string) => ({ ...tool("Bash", { command: c }, false), id: c });
  // A parallel call returned, then the model thought: the header still names the call that runs.
  expect(currentActivity([tool("Bash", { command: "orca board" }), run("git -C /opt/orca log"), tool("Read", { file_path: "/n.md" }), { at: 0, kind: "thinking", text: "hm" }])).toBe("Running: git -C /opt/orca log");
  // Two calls in progress: the newer one.
  expect(stepInFlight([run("first"), run("second")])?.id).toBe("second");
  expect(stepInFlight([tool("Bash")])).toBeUndefined();
});

test("the summary chip shows a step count only when there is one", () => {
  expect(workedLabel(10_000, 0)).toBe("Worked for 10s");     // unknown (not loaded) or none: no steps part
  expect(workedLabel(10_000, 1)).toBe("Worked for 10s · 1 step");
  expect(workedLabel(72_000, 9)).toBe("Worked for 1m 12s · 9 steps");
  expect(workedLabel(undefined, 0)).toBe("Worked");
  expect(workedLabel(undefined, 2)).toBe("Worked · 2 steps");
});

test("closeOpenMarkdown closes what a stream left open, and drops an opener with no text yet", () => {
  expect(closeOpenMarkdown("I **fix")).toBe("I **fix**");
  expect(closeOpenMarkdown("I **fix** it")).toBe("I **fix** it");
  expect(closeOpenMarkdown("a **")).toBe("a ");
  expect(closeOpenMarkdown("Run `bun te")).toBe("Run `bun te`");
  expect(closeOpenMarkdown("Run `")).toBe("Run ");
  expect(closeOpenMarkdown("x `**` y")).toBe("x `**` y"); // ** inside code is not bold
  expect(closeOpenMarkdown("```ts\nconst x")).toBe("```ts\nconst x\n```");
  expect(closeOpenMarkdown("```\nx\n```\nthen **b")).toBe("```\nx\n```\nthen **b**");
});

test("plainText strips markdown to one line for a faded row", () => {
  expect(plainText("## Plan\n- **Read** `notes.md`\n- see [docs](http://x)\n1. _then_ go")).toBe("Plan Read notes.md see docs then go");
  expect(plainText("```sh\nls\n```\nDone *now*")).toBe("ls Done now");
  expect(runLabel({ kind: "text", steps: [{ at: 0, kind: "text", text: "I **fixed** `a.ts`" }] })).toBe("I fixed a.ts");
});
