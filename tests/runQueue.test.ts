// The concurrency cap (server/agent.ts `concurrencyLimit`, CLAUDE.md "Box crash safety"): at the
// cap a run is not refused — it waits as "Queued: run limit", and the SAME run (its id and turn,
// written at once) starts when a slot frees. Driven through the real `agent.launch()` with a fake
// `claude` on PATH that holds its slot until the test frees it, and a real Postgres (the harness of
// tests/oom.test.ts).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import { freshSchema, type TestDb } from "./pg";

let dir: string;
let shim: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};
const prevPoll = agent.queuePoll.ms;

beforeEach(async () => {
  prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_MAX_CONCURRENT_RUNS"].map((k) => [k, process.env[k]]));
  dir = await mkdtemp(join(tmpdir(), "orca-queue-"));
  shim = await mkdtemp(join(tmpdir(), "orca-queue-shim-"));
  // Each run holds its slot until the test writes `go-<branch>` (the branch is the cwd's name).
  await writeFile(join(shim, "claude"), `#!/bin/sh\nwhile [ ! -e "${dir}/go-$(basename "$PWD")" ]; do sleep 0.05; done\nprintf '{"type":"result","subtype":"success","result":"done","is_error":false}'\n`);
  await chmod(join(shim, "claude"), 0o755);
  process.env.ORCA_STATE_DIR = dir;
  process.env.PATH = `${shim}:${prev.PATH}`;
  process.env.ORCA_MAX_CONCURRENT_RUNS = "1";
  agent.queuePoll.ms = 50;
  pg = await freshSchema("runqueue");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  for (const w of agent.runQueue()) agent.stop(w.key); // a failed test must not leave its waiter for the next
  for (const b of ["first", "second", "third", "stopped", "orchestrator"]) await writeFile(join(dir, `go-${b}`), "").catch(() => {});
  agent.queuePoll.ms = prevPoll;
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(dir, { recursive: true, force: true });
  await rm(shim, { recursive: true, force: true });
});

async function until(ok: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await ok()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`timed out: ${what}`);
}
async function run(branch: string, repo = "r") {
  const wt = join(dir, branch);
  await mkdir(wt, { recursive: true });
  return { wt, receipt: await agent.runAgent(wt, "go", { repo, branch, provider: "claude", instruction: "go" }) };
}
const go = (branch: string) => writeFile(join(dir, `go-${branch}`), "");
const done = async (branch: string, repo = "r") => Boolean((await db.turns(repo, branch))[0]?.finishedAt);

test("at the cap a run waits as the SAME run and turn, then starts when a slot frees", async () => {
  const first = await run("first");
  expect(first.receipt.queued).toBeUndefined();
  const second = await run("second");
  expect(second.receipt.queued).toBe(true);
  // Waiting: "running" to every caller (a follow-up queues behind it), the turn already written,
  // and no process started.
  const waiting = agent.status(second.wt);
  expect(waiting.status).toBe("running");
  expect(waiting.runWait).toMatchObject({ running: 1, limit: 1 });
  expect(agent.isRunning(second.wt)).toBe(true);
  expect(agent.runQueue()).toEqual([{ key: second.wt, runId: second.receipt.runId }]);
  const turn = (await db.turns("r", "second"))[0]!;
  expect(turn.id).toBe(second.receipt.runId);
  expect(turn.finishedAt).toBeUndefined();
  await expect(agent.runAgent(second.wt, "again", { repo: "r", branch: "second" })).rejects.toThrow("already running");

  await go("first");
  await until(() => agent.runQueue().length === 0, "the waiter to start once the first run ended");
  expect(agent.status(second.wt).runWait).toBeUndefined();
  await go("second");
  await until(() => done("second"), "the second run to finish");
  const finished = (await db.turns("r", "second"))[0]!;
  expect(finished.id).toBe(second.receipt.runId); // the SAME run and turn, not a second one
  expect(finished.response).toBe("done");
});

test("Stop on a waiting run drops it and ends its turn as stopped; it never starts", async () => {
  await run("first");
  const waiting = await run("stopped");
  expect(agent.stop(waiting.wt)).toBe(waiting.receipt.runId);
  expect(agent.isRunning(waiting.wt)).toBe(false);
  expect(agent.runQueue()).toEqual([]);
  await agent.flushHistory();
  const turn = (await db.turns("r", "stopped"))[0]!;
  expect(turn.stopped).toBe(true);
  expect(turn.response).toContain("waiting for a free slot");
  await go("first");
  await until(() => done("first"), "the first run to finish");
  await new Promise((r) => setTimeout(r, 200));
  expect((await db.turns("r", "stopped"))[0]!.response).toContain("waiting for a free slot");
});

test("waiting runs start one at a time, oldest first", async () => {
  await run("first");
  const second = await run("second");
  const third = await run("third");
  expect(agent.runQueue().map((w) => w.runId)).toEqual([second.receipt.runId, third.receipt.runId]);
  await go("first");
  await until(() => agent.runQueue().length === 1, "the oldest waiter to start");
  expect(agent.runQueue()[0]!.runId).toBe(third.receipt.runId);
  await go("second");
  await until(() => agent.runQueue().length === 0, "the next waiter to start");
  await go("third");
  await until(() => done("third"), "the third run to finish");
});

test("the orchestrator's own wake neither waits nor counts", async () => {
  await run("first");
  const orchestrator = await run("orchestrator", "@orca");
  expect(orchestrator.receipt.queued).toBeUndefined();
  await go("first");
  await until(() => done("first"), "the first run to finish");
  // With the orchestrator still running, a worker gets the one slot.
  const second = await run("second");
  expect(second.receipt.queued).toBeUndefined();
  await go("orchestrator");
  await go("second");
  await until(async () => (await done("orchestrator", "@orca")) && (await done("second")), "both runs to finish");
});
