// The live activity block's pure decisions (web/src/steps.ts): how steps group, count and label.
import { expect, test } from "bun:test";
import type { AgentStep } from "../shared/agent";
import { activityCounts, closeOpenMarkdown, createHold, currentActivity, holdNext, plainText, runLabel, stepDuration, stepInFlight, stepRow, stepRuns, workedLabel, workSteps, type HoldClock } from "@/steps";
import { groupSteps } from "../shared/agent";

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

test("an expanded row is the real call: the command text, or a read / edit by file name, with status and duration", () => {
  // Finn: expanded, the block repeated `Ran 3 commands` instead of listing the commands.
  const steps = groupSteps([
    { at: 1000, kind: "tool", id: "a", name: "Bash", input: { command: "bun test   tests/activity.test.ts" } },
    { at: 1300, kind: "result", id: "a", output: "ok" },
    { at: 1400, kind: "tool", id: "b", name: "Bash", input: { command: "git push" } },
    { at: 4000, kind: "result", id: "b", output: "denied", isError: true },
    { at: 4100, kind: "tool", id: "c", name: "Read", input: { file_path: "/a/notes.md" } },
    { at: 4200, kind: "result", id: "c", output: "x" },
    { at: 4300, kind: "tool", id: "d", name: "Edit", input: { file_path: "/a/steps.ts" } },
    { at: 4400, kind: "tool", id: "e", name: "Grep", input: { pattern: "holdNext" } },
  ]);
  expect(steps.map((s) => stepRow(s, true))).toEqual([
    { text: "bun test tests/activity.test.ts", mono: true, status: "done", ms: 300 },
    { text: "git push", mono: true, status: "failed", ms: 2600 },
    { verb: "Read", text: "notes.md", mono: true, status: "done", ms: 100 },
    { verb: "Edit", text: "steps.ts", mono: true, status: "running", ms: undefined },
    { text: "Searching for holdNext", mono: false, status: "running", ms: undefined },
  ]);
  // Once the turn is over, a call with no result is no longer "running".
  expect(stepRow(steps[3]!, false).status).toBe("done");
  // Under 100ms no duration shows (it read `0.0s`); 100ms itself shows.
  const quick = (ms: number) => stepRow({ at: 0, kind: "tool", name: "Bash", input: { command: "ls" }, done: true, doneAt: ms }, false).ms;
  expect([quick(0), quick(99), quick(100)]).toEqual([undefined, undefined, 100]);
  expect([stepDuration(300), stepDuration(2600), stepDuration(72_000)]).toEqual(["0.3s", "3s", "1m 12s"]);
});

test("holdNext keeps the shown value for the minimum time, then switches to the newest wanted one", () => {
  const s0 = { shown: "Running: ls", since: 0 };
  expect(holdNext(s0, "Running: ls", 50, 400)).toEqual({ state: s0 });             // no change
  expect(holdNext(s0, "Thinking", 100, 400)).toEqual({ state: s0, wakeIn: 300 });   // too soon: hold, ask again
  expect(holdNext(s0, "Thinking", 400, 400)).toEqual({ state: { shown: "Thinking", since: 400 } });
});

test("createHold with fake timers: fast commands never flash Thinking, a long gap does", () => {
  // A fake clock: `set` queues a timer, `tick` advances time and runs what is due.
  let now = 0;
  let timers: { at: number; f: () => void; id: number }[] = [];
  let id = 0;
  const clock: HoldClock = {
    now: () => now,
    set: (f, ms) => { timers.push({ at: now + ms, f, id: ++id }); return id; },
    clear: (t) => { timers = timers.filter((x) => x.id !== t); },
  };
  const tick = (ms: number) => {
    const end = now + ms;
    for (let due = timers.sort((a, b) => a.at - b.at)[0]; due && due.at <= end; due = timers.sort((a, b) => a.at - b.at)[0]) {
      timers = timers.filter((x) => x !== due);
      now = due.at; due.f();
    }
    now = end;
  };
  const shown: string[] = [];
  const hold = createHold("ls", (v) => shown.push(v), 400, clock);

  tick(100); hold.want("");        // ls finished after 100ms: Thinking is wanted…
  tick(50); hold.want("pwd");      // …but the next command starts 50ms later
  tick(100); hold.want("");
  tick(50); hold.want("git log");  // 300ms in: still `ls` on screen
  expect(hold.shown).toBe("ls");
  expect(shown).toEqual([]);
  tick(100);                       // 400ms: the hold ends on the NEWEST call — Thinking never showed
  expect(shown).toEqual(["git log"]);
  hold.want("");                   // git log ends at once: held until 800ms
  tick(399);
  expect(hold.shown).toBe("git log");
  tick(1);
  expect(shown).toEqual(["git log", ""]); // a real gap: now Thinking shows
  hold.want("bun test");           // the next call waits out Thinking's own hold (400ms), then shows
  tick(399);
  expect(hold.shown).toBe("");
  tick(1);
  expect(shown).toEqual(["git log", "", "bun test"]);
  hold.stop();
  expect(timers).toEqual([]);
});
