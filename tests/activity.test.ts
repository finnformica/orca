// The live activity block's pure decisions (web/src/steps.ts): how steps group, count and label.
import { expect, test } from "bun:test";
import type { AgentStep } from "../shared/agent";
import { activityCounts, currentActivity, runLabel, stepRuns, workSteps } from "@/steps";

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
