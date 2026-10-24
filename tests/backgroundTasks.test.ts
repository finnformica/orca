// A run must not end mid background task (2026-10-23: six runs on four workstreams). `claude -p`
// waits for its own `run_in_background` task and starts its next turn on the task's notification;
// Orca's agent timeout counted that wait and killed the CLI, and the push died with it. Covered:
//   1. the tracker over the CLI's real event shapes (CLI 2.1.302), the SIGTERM sequence included;
//   2. a fake agent that starts a background task and ends its turn: the timeout does not kill it,
//      and the CLI's own next turn ("pushed") is the run's result;
//   3. the wait cap: Orca stops the run and resumes the SAME session with the task's output tail;
//   4. the loop guard: a resumed run that ends the same way is a failure, not a third run;
//   5. the "N commits not pushed" line of the worker report.
// Real git scratch repo, a fake `claude` (a bun script) on PATH, real Postgres, the real verbs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as verbs from "../server/verbs";
import * as git from "../server/git";
import * as heavy from "../server/heavy";
import { run } from "../server/run";
import type { OrcaConfig } from "../server/config";
import { BACKGROUND_MARKER, backgroundResumeInstruction, isBackgroundResume } from "../shared/agent";
import { isWorkerProblem, workerEvent } from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, setPrListFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

const OUT = "/tmp/claude-1/-wt/s/tasks/b1.output";
// The CLI's events for one backgrounded Bash call, then the end of the turn (shapes as recorded).
const started = [
  { type: "system", subtype: "init", session_id: "s" },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "git push -u origin HEAD", run_in_background: true } }] } },
  { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", task_type: "local_bash", description: "Push the branch" }] },
  { type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "tu1", description: "Push the branch", is_backgrounded: true },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: `Command running in background with ID: b1. Output is being written to: ${OUT}. You will be notified when it completes.` }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "Waiting for the push to finish." }] } },
  { type: "result", subtype: "success", result: "Waiting for the push to finish.", is_error: false },
];

describe("trackBackground", () => {
  test("the turn ended with a task running: waiting, until its notification and the next turn", () => {
    const s = agent.backgroundState();
    for (const e of started) agent.trackBackground(s, e);
    expect(agent.backgroundWaiting(s)).toBe(true);
    expect(s.commands.get("tu1")).toBe("git push -u origin HEAD");
    expect(s.outputs.get("tu1")).toBe(OUT);
    agent.trackBackground(s, { type: "system", subtype: "task_notification", task_id: "b1", tool_use_id: "tu1", status: "completed" });
    agent.trackBackground(s, { type: "system", subtype: "background_tasks_changed", tasks: [] });
    expect(agent.backgroundWaiting(s)).toBe(false);
    expect(s.stopped.size).toBe(0); // finished, not left behind
    agent.trackBackground(s, { type: "system", subtype: "init", session_id: "s" });
    expect(s.turnEnded).toBe(false);
  });

  test("a SIGTERM while waiting: the CLI reports the task `stopped` — it is left behind", () => {
    const s = agent.backgroundState();
    for (const e of started) agent.trackBackground(s, e);
    agent.trackBackground(s, { type: "system", subtype: "task_notification", task_id: "b1", tool_use_id: "tu1", status: "stopped", output_file: "" });
    agent.trackBackground(s, { type: "system", subtype: "background_tasks_changed", tasks: [] });
    expect(agent.backgroundWaiting(s)).toBe(false);
    expect([...s.stopped.keys()]).toEqual(["b1"]);
  });

  test("a task the agent stops itself mid-turn is not left behind", () => {
    const s = agent.backgroundState();
    for (const e of started.slice(0, 5)) agent.trackBackground(s, e);
    agent.trackBackground(s, { type: "system", subtype: "task_notification", task_id: "b1", status: "killed" });
    expect(s.stopped.size).toBe(0);
    expect(agent.backgroundWaiting(s)).toBe(false);
  });
});

test("the resume message: its marker, each task's command and output tail", () => {
  const text = backgroundResumeInstruction([{ id: "b1", command: "git push", outputTail: "remote: ok" }], "cap", 30);
  expect(text.startsWith(BACKGROUND_MARKER)).toBe(true);
  expect(isBackgroundResume(text)).toBe(true);
  expect(text).toContain("Orca waited 30 minutes");
  expect(text).toContain("`git push` (task b1): no exit code");
  expect(text).toContain("remote: ok");
  expect(isBackgroundResume("push it")).toBe(false);
});

test("the worker report says how many commits are not pushed, after the check line", () => {
  const base = { repo: "r", branch: "feat", runId: "x", status: "done" };
  const failed = workerEvent({ ...base, unpushed: 2, check: { command: "bun run check", ok: false, exitCode: 1, output: "1 fail", durationMs: 5 } });
  expect(failed).toContain("\n2 commits not pushed\n");
  expect(isWorkerProblem(failed)).toBe(true); // the failed check is still read on line two
  const clean = workerEvent({ ...base, unpushed: 1 });
  expect(clean.split("\n")[1]).toBe("1 commit not pushed");
  expect(isWorkerProblem(clean)).toBe(false);
  expect(workerEvent({ ...base, unpushed: 0 })).not.toContain("not pushed");
});

test("git.unpushedHere: commits on no remote; nothing to say without a remote", async () => {
  const origin = realpathSync(await mkdtemp(join(tmpdir(), "orca-bg-origin-")));
  const local = await makeScratchRepo();
  try {
    expect(await git.unpushedHere(local)).toBeUndefined(); // a local-only repo
    await run(["git", "init", "--bare", "-b", "main", origin]);
    await run(["git", "-C", local, "remote", "add", "origin", origin]);
    await run(["git", "-C", local, "push", "-q", "origin", "main"]);
    expect(await git.unpushedHere(local)).toBe(0);
    for (const n of ["a", "b"]) {
      await writeFile(join(local, n), n);
      await run(["git", "-C", local, "add", n]);
      await run(["git", "-C", local, "commit", "-qm", n]);
    }
    expect(await git.unpushedHere(local)).toBe(2);
    expect(await git.unpushedHere(join(local, "gone"))).toBeUndefined();
  } finally {
    await rm(origin, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  }
});

// ---- end to end: the real launch, a fake claude ----

let state: string, shim: string, repo: string, worktrees: string, log: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};
const saved = { ...agent.backgroundWait };
let timeoutMinutes: number | undefined;
let idleMinutes: number | undefined;
const savedWatch = { ...agent.idleWatch };

const cfg = (): OrcaConfig => ({
  repos: [{ name: "r", repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"] }],
  portRange: [30000, 40000], staleHours: 24, agentTimeoutMinutes: timeoutMinutes, agentIdleMinutes: idleMinutes,
});
const repoCfg = () => cfg().repos[0]!;

// The fake CLI. ORCA_FAKE_MODE: `finish` (the task ends after ORCA_FAKE_TASK_MS, the CLI starts its
// next turn), `hang` (the task never ends; a SIGTERM stops it as the CLI does), `busy` (an active
// turn that outlasts the timeout), `quiet` (writes its ORCA_RUN_ID, then sends nothing for
// ORCA_FAKE_TASK_MS and answers). A resume message (Orca's marker) answers at once, or hangs too
// with ORCA_FAKE_RESUME=hang.
const FAKE = `#!/usr/bin/env bun
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? "";
await Bun.write(process.env.ORCA_FAKE_LOG + "/" + Date.now() + "-" + process.pid, JSON.stringify(argv));
const sid = argv[argv.indexOf("--resume") + 1] && argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : argv[argv.indexOf("--session-id") + 1];
const say = (e) => process.stdout.write(JSON.stringify({ session_id: sid, ...e }) + "\\n");
const resume = prompt.includes(${JSON.stringify(BACKGROUND_MARKER)});
const mode = resume ? (process.env.ORCA_FAKE_RESUME ?? "ok") : process.env.ORCA_FAKE_MODE;
say({ type: "system", subtype: "init" });
if (mode === "ok") { say({ type: "result", subtype: "success", result: "Pushed the branch.", is_error: false }); process.exit(0); }
if (mode === "quiet") {
  await Bun.write(process.env.ORCA_FAKE_LOG + "/runid", process.env.ORCA_RUN_ID ?? "");
  await Bun.sleep(Number(process.env.ORCA_FAKE_TASK_MS ?? 1000));
  say({ type: "result", subtype: "success", result: "Done after a quiet wait.", is_error: false });
  process.exit(0);
}
if (mode === "busy") { await Bun.sleep(5000); say({ type: "result", subtype: "success", result: "late", is_error: false }); process.exit(0); }
const out = process.env.ORCA_FAKE_LOG + "/task-" + process.pid + ".output";
await Bun.write(out, "Enumerating objects: 5, done.\\nrunning the pre-push gate\\n");
say({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "git push -u origin HEAD", run_in_background: true } }] } });
say({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", description: "Push the branch" }] });
say({ type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "tu1", description: "Push the branch" });
say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "Command running in background with ID: b1. Output is being written to: " + out + ". You will be notified when it completes." }] } });
say({ type: "result", subtype: "success", result: "Waiting for the push to finish.", is_error: false });
process.on("SIGTERM", () => {
  say({ type: "system", subtype: "task_notification", task_id: "b1", tool_use_id: "tu1", status: "stopped", output_file: "" });
  say({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  process.exit(143);
});
if (mode === "hang") { setInterval(() => {}, 1000); }
else {
  await Bun.sleep(Number(process.env.ORCA_FAKE_TASK_MS ?? 1000));
  say({ type: "system", subtype: "task_notification", task_id: "b1", tool_use_id: "tu1", status: "completed" });
  say({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  say({ type: "system", subtype: "init" });
  say({ type: "assistant", message: { content: [{ type: "text", text: "Pushed. The PR is next." }] } });
  say({ type: "result", subtype: "success", result: "Pushed. The PR is next.", is_error: false });
  process.exit(0);
}
`;

describe("a run with a background task", () => {
  beforeEach(async () => {
    prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_FAKE_LOG", "ORCA_FAKE_MODE", "ORCA_FAKE_RESUME", "ORCA_FAKE_TASK_MS"].map((k) => [k, process.env[k]]));
    [state, shim, worktrees, log] = await Promise.all(["state", "claude", "wt", "log"].map(async (n) => realpathSync(await mkdtemp(join(tmpdir(), `orca-bg-${n}-`))))) as [string, string, string, string];
    repo = await makeScratchRepo();
    await run(["git", "-C", repo, "branch", "feat"]);
    process.env.ORCA_STATE_DIR = state;
    process.env.ORCA_FAKE_LOG = log;
    process.env.PATH = `${shim}:${prev.PATH}`;
    await installFakeGh();
    await setPrListFixture([]);
    await writeFile(join(shim, "claude"), FAKE);
    await chmod(join(shim, "claude"), 0o755);
    pg = await freshSchema("backgroundtasks");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    timeoutMinutes = undefined;
    idleMinutes = undefined;
    agent.onQueuedMessage(async (m) => { await verbs.launchQueued(cfg(), repoCfg(), m); });
  });

  afterEach(async () => {
    Object.assign(agent.backgroundWait, saved);
    Object.assign(agent.idleWatch, savedWatch);
    for (let i = 0; i < 400 && wt && agent.isRunning(wt); i++) await new Promise((r) => setTimeout(r, 25));
    await agent.afterRunsSettled();
    agent.onQueuedMessage(async () => {});
    await agent.flushHistory();
    await db.close();
    await pg.drop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const d of [state, shim, repo, worktrees, log]) await rm(d, { recursive: true, force: true });
  });

  let wt = "";
  const launches = async () => {
    const files = (await readdir(log)).filter((f) => !f.startsWith("task-") && f !== "runid").sort();
    return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(log, f), "utf8")) as string[]));
  };
  async function settled(n: number) {
    for (let i = 0; i < 600; i++) {
      await agent.afterRunsSettled();
      const turns = await db.turns("r", "feat");
      if (turns.length >= n && turns.every((t) => t.finishedAt) && !agent.isRunning(wt)) return turns;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`never settled at ${n} turn(s)`);
  }
  async function start(instruction = "commit and push") {
    wt = await verbs.ensureWorktree(repoCfg(), "feat");
    expect((await verbs.followUp(cfg(), repoCfg(), "feat", { instruction })).status).toBe("running");
  }

  test("the agent timeout does not count the wait: the task finishes and the CLI's next turn is the result", async () => {
    timeoutMinutes = 0.01; // 600 ms — the background task takes 1.5 s
    agent.backgroundWait.floorMs = 3_000;
    process.env.ORCA_FAKE_MODE = "finish";
    process.env.ORCA_FAKE_TASK_MS = "1500";
    await start();
    const [turn] = await settled(1);
    expect(turn!.failed).toBeFalsy();
    expect(turn!.stopReason).toBe("end_turn");
    expect(turn!.response).toBe("Pushed. The PR is next.");
    expect(await launches()).toHaveLength(1); // nothing to resume
  });

  test("an active turn still times out", async () => {
    timeoutMinutes = 0.01;
    process.env.ORCA_FAKE_MODE = "busy";
    await start();
    const [turn] = await settled(1);
    expect(turn!.failed).toBe(true);
    expect(await launches()).toHaveLength(1);
  });

  test("no progress: Orca stops a silent run and labels it, never a bare exit 143", async () => {
    idleMinutes = 0.01; // 600 ms
    agent.idleWatch.everyMs = 50;
    process.env.ORCA_FAKE_MODE = "quiet";
    process.env.ORCA_FAKE_TASK_MS = "5000";
    await start();
    const [turn] = await settled(1);
    expect(turn!.failed).toBe(true);
    expect(turn!.response).toStartWith("stopped: no progress for 0.01 min (exit ");
    expect(turn!.response).toContain("The work so far stands in the worktree.");
  });

  test("a heavy-queue job of the run is progress: the silent run is not stopped while it holds a slot", async () => {
    idleMinutes = 0.01;
    agent.idleWatch.everyMs = 50;
    process.env.ORCA_FAKE_MODE = "quiet";
    process.env.ORCA_FAKE_TASK_MS = "2500";
    await start();
    let runId = "";
    for (let i = 0; i < 200 && !runId; i++) {
      runId = await readFile(join(log, "runid"), "utf8").catch(() => "");
      if (!runId) await new Promise((r) => setTimeout(r, 10));
    }
    expect(runId).not.toBe("");
    const grant = await heavy.slots().acquire({ kind: "test", command: "bun test", runId });
    try {
      const [turn] = await settled(1);
      expect(turn!.failed).toBeFalsy();
      expect(turn!.stopReason).toBe("end_turn");
      expect(turn!.response).toBe("Done after a quiet wait.");
    } finally {
      heavy.slots().release(grant.id);
    }
  });

  test("the wait cap: Orca stops the run and resumes the SAME session with the task's output tail", async () => {
    agent.backgroundWait.ms = 500;
    process.env.ORCA_FAKE_MODE = "hang";
    await start();
    const turns = await settled(2);
    expect(turns[0]!.failed).toBeFalsy(); // the agent did nothing wrong: its turn had ended
    expect(turns[0]!.response).toContain("Waiting for the push to finish.");
    expect(turns[0]!.response).toContain("> Orca: background task `git push -u origin HEAD` still ran");
    expect(turns[0]!.response).toContain("Orca resumes the session");
    expect(isBackgroundResume(turns[1]!.instruction)).toBe(true);
    expect(turns[1]!.instruction).toContain("running the pre-push gate"); // the output tail
    expect(turns[1]!.response).toBe("Pushed the branch.");
    const argv = await launches();
    expect(argv).toHaveLength(2);
    const session = argv[0]![argv[0]!.indexOf("--session-id") + 1];
    expect(argv[1]![argv[1]!.indexOf("--resume") + 1]).toBe(session!);
  });

  test("the loop guard: a resumed run that ends the same way fails, and is not resumed again", async () => {
    agent.backgroundWait.ms = 500;
    process.env.ORCA_FAKE_MODE = "hang";
    process.env.ORCA_FAKE_RESUME = "hang";
    await start();
    const turns = await settled(2);
    await new Promise((r) => setTimeout(r, 300));
    await agent.afterRunsSettled();
    expect(await launches()).toHaveLength(2);
    expect(turns[1]!.failed).toBe(true);
    expect(turns[1]!.response).toContain("Run it again in the foreground.");
    expect((await db.turns("r", "feat")).length).toBe(2);
  });
});
