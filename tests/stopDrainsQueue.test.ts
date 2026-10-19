// Stop drains the queue (agent.interrupt, the /api/agent/stop route's worker path): pressing Stop on
// a run with messages queued behind it starts the next one at once, as a finished run does. Before,
// a stopped run's exit read as superseded and returned before the queue was sent, so the chat sat
// idle until the next typed message. Real git scratch repo, a fake `claude`, real Postgres — the
// same harness as verifyGate.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import { makeScratchRepo } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

let state: string, shim: string, repo: string, hold: string, holdLate: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};
let launches: string[] = [];

beforeEach(async () => {
  prev = { ORCA_STATE_DIR: process.env.ORCA_STATE_DIR, ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, PATH: process.env.PATH };
  state = await mkdtemp(join(tmpdir(), "orca-stopq-"));
  shim = await mkdtemp(join(tmpdir(), "orca-stopq-claude-"));
  repo = await makeScratchRepo();
  hold = join(state, "hold");
  holdLate = join(state, "hold-late");
  process.env.ORCA_STATE_DIR = state;
  process.env.PATH = `${shim}:${prev.PATH}`;
  // A fake claude that ignores SIGTERM (so a stopped run can exit LATE, after the next one started),
  // waits while the hold file exists — and, for the first run only, while `hold-late` exists too.
  await writeFile(join(shim, "claude"), `#!/bin/sh
trap '' TERM
while [ -f "${hold}" ]; do sleep 0.02; done
case "$*" in *"first thing"*) while [ -f "${holdLate}" ]; do sleep 0.02; done ;; esac
printf '{"type":"result","subtype":"success","result":"## Outcome\\\\nDone.","is_error":false}'
`);
  await chmod(join(shim, "claude"), 0o755);
  pg = await freshSchema("stopdrains");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  launches = [];
  // This fake ignores SIGTERM: Stop's wait for the stopped process to exit is cut short here.
  agent.stopGrace.ms = 100;
  // The same relay index.ts installs: a queued message becomes the next run.
  agent.onQueuedMessage(async (m) => {
    launches.push(m.instruction);
    await agent.runAgent(m.worktreePath, m.instruction, { repo: "r", branch: "feat", provider: "claude", instruction: m.instruction });
  });
});
afterEach(async () => {
  await rm(hold, { force: true });
  await rm(holdLate, { force: true });
  for (let i = 0; i < 400 && agent.isRunning(repo); i++) await new Promise((r) => setTimeout(r, 25));
  await agent.afterRunsSettled();
  agent.onQueuedMessage(async () => {});
  agent.stopGrace.ms = 5_000;
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, repo]) await rm(d, { recursive: true, force: true });
});

const queue = (instruction: string) => db.queueMessage({ repo: "r", branch: "feat", worktreePath: repo, instruction, attachments: [] });
const queued = async () => (await db.queuedMessages("r", "feat")).map((m) => m.instruction);
const first = () => agent.runAgent(repo, "do the first thing", { repo: "r", branch: "feat", provider: "claude", instruction: "do the first thing" });
async function settled(n: number) {
  for (let i = 0; i < 400; i++) {
    await agent.afterRunsSettled();
    const turns = await db.turns("r", "feat");
    if (turns.length >= n && turns.every((t) => t.finishedAt) && !agent.isRunning(repo)) return turns;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never settled at ${n} turn(s)`);
}

test("Stop with one queued message starts it at once", async () => {
  await writeFile(hold, "");
  const a = await first();
  await queue("then the second");
  expect(await agent.interrupt(repo)).toBe(a.runId);
  // Started before Stop returned: the queue is empty and the new run is live on the worktree.
  expect(launches).toEqual(["then the second"]);
  expect(await queued()).toEqual([]);
  expect(agent.status(repo)).toMatchObject({ status: "running", prompt: "then the second" });
  expect((await db.turns("r", "feat")).map((t) => t.instruction)).toEqual(["do the first thing", "then the second"]);
  await rm(hold, { force: true });
  const turns = await settled(2);
  expect(turns[0]).toMatchObject({ stopped: true, stopReason: "interrupted" });
  expect(turns[1]).toMatchObject({ instruction: "then the second", response: "## Outcome\nDone." });
});

test("Stop with two queued messages starts only the first; the second waits for that run", async () => {
  await writeFile(hold, "");
  await first();
  await queue("second");
  await queue("third");
  await agent.interrupt(repo);
  expect(launches).toEqual(["second"]);
  expect(await queued()).toEqual(["third"]);
  await rm(hold, { force: true }); // "second" finishes normally and sends "third"
  const turns = await settled(3);
  expect(turns.map((t) => t.instruction)).toEqual(["do the first thing", "second", "third"]);
  expect(launches).toEqual(["second", "third"]);
});

test("a stopped run's late exit starts nothing twice and leaves the new run alone", async () => {
  await writeFile(hold, "");
  await writeFile(holdLate, ""); // the stopped run (it ignores SIGTERM) outlives the next one's start
  const a = await first();
  await queue("second");
  await agent.interrupt(repo);
  const b = agent.status(repo);
  expect(b).toMatchObject({ status: "running", prompt: "second" });
  await queue("third"); // typed while "second" runs: it must wait for "second", not ride A's exit
  await rm(hold, { force: true });
  // Wait for "second" to finish and send "third"; the stopped run is still alive behind holdLate.
  for (let i = 0; i < 400 && launches.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
  expect(launches).toEqual(["second", "third"]);
  await rm(holdLate, { force: true }); // now the stopped run exits, late
  const turns = await settled(3);
  expect(launches).toEqual(["second", "third"]); // its exit sent nothing
  expect(turns.find((t) => t.id === a.runId)).toMatchObject({ stopped: true });
  expect(turns.find((t) => t.id === b.runId)).toMatchObject({ response: "## Outcome\nDone." });
  expect(turns.filter((t) => t.instruction === "third")).toHaveLength(1);
});

test("a Stop that arrives while the run is still starting stops it, then starts the queue", async () => {
  await writeFile(hold, "");
  await queue("second");
  const launching = first(); // not awaited: Stop lands before launch() returns
  const runId = await agent.interrupt(repo);
  const a = await launching;
  expect(runId).toBe(a.runId);
  expect(launches).toEqual(["second"]);
  await rm(hold, { force: true });
  const turns = await settled(2);
  expect(turns.find((t) => t.id === a.runId)).toMatchObject({ stopped: true });
  expect(turns.map((t) => t.instruction)).toEqual(["do the first thing", "second"]);
});

test("plain stop (Discard's path) sends nothing", async () => {
  await writeFile(hold, "");
  await first();
  await queue("second");
  agent.stop(repo);
  await rm(hold, { force: true });
  await settled(1);
  expect(launches).toEqual([]);
  expect(await queued()).toEqual(["second"]);
});
