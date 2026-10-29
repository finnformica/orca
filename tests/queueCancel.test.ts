// Cancel and replace a queued message (server/orchestrator.ts `queue`, `send --replace`): an agent
// lists a workstream's undispatched messages, cancels one of its own, or replaces its newest one with
// the whole corrected text. A dispatched message and another sender's message are never touched.
// Same harness as orchestrator.test.ts: a real git scratch repo, a fake `claude` on PATH, real Postgres.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as git from "../server/git";
import * as orchestrator from "../server/orchestrator";
import * as verbs from "../server/verbs";
import type { OrcaConfig } from "../server/config";
import { AUTOFIX_MARKER, type AgentTurn } from "../shared/agent";
import { grantRefusal } from "../shared/integrations";
import { PERSON, agentSide, orcaSide, queueListText, queuedSender } from "../shared/rooms";
import { commandsFor, orchestratorPrompt } from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, setPrListFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

let state: string, shim: string, repo: string, worktrees: string, hold: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};

const cfg = (): OrcaConfig => ({
  repos: [{ name: "r", repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"] }],
  portRange: [30000, 40000], staleHours: 24,
});
const brief = { repo: "r", title: "Add cache", model: "claude-sonnet-5", objective: "Add a response cache", output: "One commit", boundaries: "Only touch src/cache" };

beforeEach(async () => {
  prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_FAKE_HOLD"].map((k) => [k, process.env[k]]));
  [state, shim, worktrees] = await Promise.all(["state", "claude", "wt"].map(async (n) => realpathSync(await mkdtemp(join(tmpdir(), `orca-queue-${n}-`))))) as [string, string, string];
  repo = await makeScratchRepo();
  hold = join(state, "hold");
  process.env.ORCA_STATE_DIR = state;
  process.env.ORCA_FAKE_HOLD = hold;
  process.env.PATH = `${shim}:${prev.PATH}`;
  await installFakeGh();
  await setPrListFixture([]);
  // A fake claude: waits while the hold file exists, then answers.
  await writeFile(join(shim, "claude"), `#!/bin/sh
while [ -f "$ORCA_FAKE_HOLD" ]; do sleep 0.02; done
printf '{"type":"result","subtype":"success","result":"## Outcome\\\\nDone.","is_error":false}'
`);
  await chmod(join(shim, "claude"), 0o755);
  // What server/index.ts installs: a run's end sends the next queued message.
  agent.onQueuedMessage(async (m) => { await verbs.launchQueued(cfg(), cfg().repos[0]!, m); });
  pg = await freshSchema("queuecancel");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await rm(hold, { force: true });
  // Drain: a run's end launches the next queued message, so "nothing running" alone can be a gap.
  for (let i = 0; i < 400; i++) {
    await agent.afterRunsSettled();
    if (!(await anyRunning()) && !(await db.queuedCounts("r")).size) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  agent.onQueuedMessage(undefined as never); // back to no launcher, as before this file
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, repo, worktrees]) await rm(d, { recursive: true, force: true });
});

const anyRunning = async () => existsSync(repo) && (await git.listWorktrees(repo, worktrees)).some((w) => agent.isRunning(w.worktreePath));
async function settled(read: () => Promise<AgentTurn[]>, n: number): Promise<AgentTurn[]> {
  for (let i = 0; i < 400; i++) {
    await agent.afterRunsSettled();
    const turns = await read();
    if (turns.length >= n && turns.every((t) => t.finishedAt) && !(await anyRunning())) return turns;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never settled at ${n} turn(s)`);
}

/** A spawned workstream whose next run is held in flight, so a send queues behind it. */
async function busyWorkstream(): Promise<{ branch: string; worktreePath: string }> {
  await orchestrator.tool(cfg(), "spawn", brief);
  const branch = Object.keys(await db.enrichment("r"))[0]!;
  await settled(() => db.turns("r", branch), 1);
  const worktreePath = (await git.listWorktrees(repo, worktrees)).find((w) => w.branch === branch)!.worktreePath;
  await writeFile(hold, "");
  expect(await orchestrator.tool(cfg(), "send", { repo: "r", branch, _: ["keep", "going"] })).toContain(`Sent to r/${branch}`);
  expect(agent.isRunning(worktreePath)).toBe(true);
  return { branch, worktreePath };
}
const queued = (branch: string) => db.queuedMessages("r", branch);

test("Q1: a queued send prints its id, and orca queue lists id, time, sender and first line", async () => {
  const { branch } = await busyWorkstream();
  const out = await orchestrator.tool(cfg(), "send", { repo: "r", branch, _: ["Add the TTL\nand the tests"] });
  const [mine] = await queued(branch);
  expect(out).toBe(`Queued as message #${mine!.id} behind the run in flight; it is sent when that finishes. To correct it before then: orca send --replace.`);
  // The sender is recorded on the row, so it is the agent's even with no wake origin.
  expect(mine!.sender).toEqual(agentSide("chief"));
  await db.queueMessage({ repo: "r", branch, worktreePath: mine!.worktreePath, instruction: "the user's own words", attachments: [] });

  const list = await orchestrator.tool(cfg(), "queue", { repo: "r", branch });
  const lines = list.split("\n");
  expect(lines[0]).toBe(`Queued for r/${branch}, oldest first (each is sent in turn when the run in flight ends):`);
  expect(lines[1]).toMatch(new RegExp(`^  #${mine!.id}  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC  agent chief \\(you\\)  Add the TTL$`));
  expect(lines[2]).toMatch(/UTC {2}the user {2}the user's own words$/);
  await rm(hold, { force: true });
});

test("Q2: queue cancel deletes the agent's own undispatched message and refuses a dispatched one", async () => {
  const { branch } = await busyWorkstream();
  await orchestrator.tool(cfg(), "send", { repo: "r", branch, _: ["first", "fix"] });
  await orchestrator.tool(cfg(), "send", { repo: "r", branch, _: ["second", "fix"] });
  const [a, b] = await queued(branch);
  expect(await orchestrator.tool(cfg(), "queue", { _: ["cancel", String(a!.id)] })).toBe(`Cancelled queued message #${a!.id} on r/${branch}. Nothing else changed.`);
  expect((await queued(branch)).map((m) => m.id)).toEqual([b!.id]);
  // Only undispatched rows: the run in flight is untouched.
  expect((await git.listWorktrees(repo, worktrees)).some((w) => agent.isRunning(w.worktreePath))).toBe(true);

  // The run ends and dispatches the other one: it can no longer be cancelled, and the row stays.
  await rm(hold, { force: true });
  await settled(() => db.turns("r", branch), 3);
  await expect(orchestrator.tool(cfg(), "queue", { _: ["cancel", String(b!.id)] })).rejects.toThrow(`refused: message #${b!.id} on r/${branch} was already dispatched`);
  expect((await db.queuedMessageById(b!.id))?.dispatchedAt).toBeNumber();
  await expect(orchestrator.tool(cfg(), "queue", { _: ["cancel", "999999"] })).rejects.toThrow("No queued message #999999.");
  await expect(orchestrator.tool(cfg(), "queue", { _: ["cancel"] })).rejects.toThrow("usage: orca queue cancel <id>");
  expect(await orchestrator.tool(cfg(), "queue", { repo: "r", branch })).toBe(`Nothing is queued for r/${branch}.`);
}, 30_000);

test("Q3: queue cancel never touches another sender's message", async () => {
  const { branch, worktreePath } = await busyWorkstream();
  const base = { repo: "r", branch, worktreePath, attachments: [] };
  const user = await db.queueMessage({ ...base, instruction: "typed in the chat" });
  const other = await db.queueMessage({ ...base, instruction: "from the assistant", sender: agentSide("assistant") });
  const autofix = await db.queueMessage({ ...base, instruction: `${AUTOFIX_MARKER} fix the check` });
  await expect(orchestrator.tool(cfg(), "queue", { _: ["cancel", String(user.id)] })).rejects.toThrow("was queued by the user; you cancel only your own");
  await expect(orchestrator.tool(cfg(), "queue", { _: ["cancel", String(other.id)] })).rejects.toThrow("was queued by agent assistant; you cancel only your own");
  await expect(orchestrator.tool(cfg(), "queue", { _: ["cancel", String(autofix.id)] })).rejects.toThrow("was queued by Orca (autofix)");
  expect((await queued(branch)).map((m) => m.id)).toEqual([user.id, other.id, autofix.id]);
  await rm(hold, { force: true });
});

test("Q4: send --replace swaps the sender's newest queued message and leaves the others", async () => {
  const { branch, worktreePath } = await busyWorkstream();
  await orchestrator.tool(cfg(), "send", { repo: "r", branch, _: ["older", "note"] });
  const user = await db.queueMessage({ repo: "r", branch, worktreePath, attachments: [], instruction: "typed in the chat" });
  await orchestrator.tool(cfg(), "send", { repo: "r", branch, _: ["Add the TTL"] });
  const other = await db.queueMessage({ repo: "r", branch, worktreePath, attachments: [], instruction: "from the assistant", sender: agentSide("assistant") });
  const [older, , wrong] = await queued(branch);

  // bin/orca reads the text after --replace as the flag's value.
  const out = await orchestrator.tool(cfg(), "send", { repo: "r", branch, replace: "Add the TTL and its tests", _: [] });
  const after = await queued(branch);
  const fixed = after.at(-1)!;
  expect(out).toBe(`Cancelled your queued message #${wrong!.id}. Queued as message #${fixed.id} behind the run in flight; it is sent when that finishes. To correct it before then: orca send --replace.`);
  expect(after.map((m) => m.id)).toEqual([older!.id, user.id, other.id, fixed.id]);
  expect(fixed.instruction).toBe("Add the TTL and its tests");
  // A bare --replace with the text as words works the same.
  const again = await orchestrator.tool(cfg(), "send", { repo: "r", branch, replace: "", _: ["Add", "the", "TTL,", "tests", "and", "docs"] });
  expect(again).toStartWith(`Cancelled your queued message #${fixed.id}.`);
  expect((await queued(branch)).map((m) => m.instruction)).toEqual(["older note", "typed in the chat", "from the assistant", "Add the TTL, tests and docs"]);
  await rm(hold, { force: true });
});

test("Q5: send --replace with nothing of the sender's queued sends a normal message and says so", async () => {
  // Busy, but only another sender's message is queued: it stays, and the new text queues behind it.
  const { branch, worktreePath } = await busyWorkstream();
  const user = await db.queueMessage({ repo: "r", branch, worktreePath, attachments: [], instruction: "typed in the chat" });
  const out = await orchestrator.tool(cfg(), "send", { repo: "r", branch, replace: "", _: ["the", "whole", "message"] });
  const [, mine] = await queued(branch);
  expect(out).toBe(`Nothing of yours was still queued on r/${branch} (it was sent already, or there was none), so this went as a normal message. Queued as message #${mine!.id} behind the run in flight; it is sent when that finishes. To correct it before then: orca send --replace.`);
  expect((await queued(branch)).map((m) => m.id)).toEqual([user.id, mine!.id]);

  // Idle, with nothing queued (both were dispatched): it is sent at once.
  await rm(hold, { force: true });
  await settled(() => db.turns("r", branch), 4);
  const idle = await orchestrator.tool(cfg(), "send", { repo: "r", branch, replace: "", _: ["one", "more"] });
  expect(idle).toBe(`Nothing of yours was still queued on r/${branch} (it was sent already, or there was none), so this went as a normal message. Sent to r/${branch}. End your turn; you are woken when it finishes.`);
  await settled(() => db.turns("r", branch), 5);
}, 30_000);

test("Q6: the sender rule, the list text, the grant check and the prompt", () => {
  const m = { repo: "r", branch: "b", instruction: "x" };
  expect(queuedSender(m)).toEqual(PERSON);
  expect(queuedSender({ ...m, origin: { wakeRunId: "w", messageIds: [], otherCount: 0 } })).toEqual(agentSide("chief"));
  expect(queuedSender({ ...m, instruction: `${AUTOFIX_MARKER} x` })).toEqual(orcaSide("autofix"));
  expect(queuedSender({ ...m, sender: agentSide("assistant") })).toEqual(agentSide("assistant"));
  expect(queueListText("r/b", [])).toBe("Nothing is queued for r/b.");
  expect(queueListText("r/b", [{ ...m, id: 7, createdAt: Date.UTC(2026, 9, 29, 14, 3), instruction: `${"a".repeat(120)}\nmore` }], agentSide("chief")).split("\n")[1])
    .toBe(`  #7  2026-10-29 14:03 UTC  the user  ${"a".repeat(99)}…`);

  const g = (level: "ask" | "work") => ({ level, repos: ["r"] });
  expect(grantRefusal(g("ask"), "queue", { repo: "r" })).toBeUndefined();
  expect(grantRefusal(g("ask"), "queue", { _: ["cancel", "1"] })).toContain('"queue cancel" needs "work"');
  expect(grantRefusal(g("work"), "queue", { _: ["cancel", "1"] })).toBeUndefined();

  const prompt = orchestratorPrompt({ fresh: false, board: "", messages: ["hi"] });
  expect(prompt).toContain("use orca send --replace (or orca queue cancel + a new send)");
  expect(prompt).toContain("with the whole corrected message. Do not queue extra follow-ups that patch it.");
  expect(prompt).toContain("  orca queue cancel <id>");
  // An agent with limited verbs gets the guidance with send, and the queue verbs only when it has them.
  expect(commandsFor(["send"])).toContain("--replace cancels your newest message");
  expect(commandsFor(["send"])).not.toContain("  orca queue --repo");
  expect(commandsFor(["send", "queue"])).toContain("orca queue --repo <repo> --branch <branch>");
});
