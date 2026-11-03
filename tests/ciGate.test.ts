// GitHub CI as the check gate (a repo's `check: "github"`, server/ciGate.ts): the pure rules over
// check runs, then the whole path end to end — a worker commits, Orca runs no check on the box,
// opens the PR, reads the head's check runs from the fake GitHub, and records the verdict on the turn
// and in the worker report (pass, fail with the log tail, pending). A `local` repo is unchanged.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as git from "../server/git";
import * as orchestrator from "../server/orchestrator";
import * as ciGate from "../server/ciGate";
import * as verbs from "../server/verbs";
import { run } from "../server/run";
import { parseConfigDocument, type OrcaConfig, type RepoConfig } from "../server/config";
import { AUTOFIX_MARKER, GITHUB_CHECK, autofixInstruction, type AgentTurn } from "../shared/agent";
import { CI_GATE_GUIDANCE, CI_WAIT, ciCheck, ciVerdict, ciWait, logTail, nextPollGap, noVerdictLine, withSecondLine, type CheckRun } from "../shared/ciGate";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, WORKER_EVENT_MARKER, checkLine, isWorkerProblem } from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, setPrListFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

// ---- the pure rules ----

const cr = (id: number, name: string, status: string, conclusion?: string, extra: Partial<CheckRun> = {}): CheckRun => ({ id, name, status, conclusion: conclusion ?? null, ...extra });

test("CI1: the verdict over check runs — pass, fail, pending, none, required only, newest run per name", () => {
  expect(ciVerdict([])).toEqual({ state: "none" });
  expect(ciVerdict([cr(1, "check", "completed", "success"), cr(2, "lint", "completed", "skipped")])).toEqual({ state: "passed", names: ["check", "lint"] });
  expect(ciVerdict([cr(1, "check", "in_progress"), cr(2, "lint", "completed", "success")])).toEqual({ state: "pending", running: ["check"] });
  // A failure decides at once, while a slow check still runs.
  const failed = ciVerdict([cr(1, "check", "completed", "failure"), cr(2, "e2e", "queued")]);
  expect(failed.state).toBe("failed");
  expect(failed.state === "failed" && failed.failing.map((r) => r.name)).toEqual(["check"]);
  // Only the base's required checks decide when it has some; an advisory bot is ignored.
  expect(ciVerdict([cr(1, "check", "completed", "success"), cr(2, "bot", "completed", "failure")], new Set(["check"])).state).toBe("passed");
  expect(ciVerdict([cr(2, "bot", "completed", "success")], new Set(["check"]))).toEqual({ state: "none" });
  // A re-run is a newer run of the same name: the newest wins.
  expect(ciVerdict([cr(1, "check", "completed", "failure"), cr(5, "check", "completed", "success")]).state).toBe("passed");
});

test("CI2: the TurnCheck keeps the box check's shape; a failure names the check and carries the log tail", () => {
  const pass = ciCheck({ state: "passed", names: ["check"] }, 1000);
  expect(pass).toEqual({ command: GITHUB_CHECK, via: "github", ok: true, exitCode: 0, output: "Passed: check", durationMs: 1000 });
  const raw = `2026-11-03T10:00:00.1234567Z \x1b[31mstarting\x1b[0m\n\n2026-11-03T10:00:01.0Z error: expected 2, got 3\n`;
  expect(logTail(raw)).toBe("starting\nerror: expected 2, got 3");
  const fail = ciCheck({ state: "failed", failing: [cr(9, "check", "completed", "failure", { html_url: "https://github.com/acme/app/runs/9" })] }, 500, raw);
  expect(fail).toMatchObject({ command: GITHUB_CHECK, via: "github", ok: false, exitCode: 1 });
  expect(fail.output).toBe("Failing check: check (failure)\nhttps://github.com/acme/app/runs/9\n\nstarting\nerror: expected 2, got 3");
  // No log: the check run's own output is the evidence.
  expect(ciCheck({ state: "failed", failing: [cr(9, "lint", "completed", "failure", { output: { title: "2 errors", summary: "x.ts:1 no-unused" } })] }, 0).output).toContain("2 errors\nx.ts:1 no-unused");
  expect(logTail("x".repeat(5000)).length).toBe(4001);
  // The report line and the autofix read the same as for a box check; the fix is told to push.
  expect(checkLine(fail)).toStartWith("Orca's check `GitHub CI` FAILED (exit 1):\nFailing check: check");
  expect(autofixInstruction(fail)).toStartWith(AUTOFIX_MARKER);
  expect(autofixInstruction(fail)).toContain("commit and push: GitHub CI checks the push again.");
});

test("CI3: the waits — a growing gap, no checks after 15 min, give up after 2 h; the second line of a report", () => {
  expect([1, 2, 3, 6, 20].map(nextPollGap)).toEqual([60_000, 90_000, 135_000, 300_000, 300_000]);
  expect(ciWait({ state: "none" }, 0, CI_WAIT.noChecksMs - 1)).toEqual({});
  expect(ciWait({ state: "none" }, 0, CI_WAIT.noChecksMs).giveUp).toContain("no GitHub check ran");
  expect(ciWait({ state: "pending", running: ["check"] }, 0, CI_WAIT.noChecksMs)).toEqual({});
  expect(ciWait({ state: "pending", running: ["check"] }, 0, CI_WAIT.giveUpMs).giveUp).toContain("did not finish");
  const report = `${WORKER_EVENT_MARKER} r/b — done\nOutcome: x`;
  expect(withSecondLine(report, "L")).toBe(`${WORKER_EVENT_MARKER} r/b — done\nL\nOutcome: x`);
  expect(isWorkerProblem(withSecondLine(report, noVerdictLine("no checks")))).toBe(false);
  expect(isWorkerProblem(withSecondLine(report, checkLine(ciCheck({ state: "failed", failing: [cr(1, "c", "completed", "failure")] }, 0))))).toBe(true);
});

test("CI4: `check` parses as local | github and nothing else", () => {
  const doc = (check: unknown) => parseConfigDocument({ repos: [{ name: "r", repoPath: "/x", worktreeRoot: "/x/.wt", baseBranch: "main", previewServices: [], check }], portRange: [30000, 40000], staleHours: 24 });
  expect(doc("github").config?.repos[0]?.check).toBe("github");
  expect(doc("local").config?.repos[0]?.check).toBe("local");
  expect(doc("cloud").errors.join()).toContain('check must be "local" or "github"');
});

// ---- end to end ----

let state: string, shim: string, repo: string, origin: string, worktrees: string, log: string, fx: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};
const KEYS = ["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_FAKE_LOG", "ORCA_GH_CHECK_RUNS_FIXTURE", "ORCA_GH_RUN_LOG_FIXTURE", "ORCA_GH_ARGS_LOG"];

const repoCfg = (over: Partial<RepoConfig> = {}): RepoConfig => ({ name: "r", repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"], check: "github", ...over });
const cfgOf = (over: Partial<RepoConfig> = {}): OrcaConfig => ({ repos: [repoCfg(over)], portRange: [30000, 40000], staleHours: 24 });

/** The run-finished wiring of server/index.ts. */
function wire(c: OrcaConfig): void {
  agent.onRunFinished(async (r) => {
    let held: string | undefined;
    try { held = await orchestrator.onRunFinished(c, r); } finally { if (r.ciPending) await ciGate.begin(c, r, held); }
  });
  ciGate.onSettled((s) => orchestrator.onCiSettled(c, s));
  agent.onQueuedMessage((m) => verbs.launchQueued(c, c.repos[0]!, m).then(() => {}));
}

beforeEach(async () => {
  prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  [state, shim, worktrees, log, fx] = await Promise.all(["state", "claude", "wt", "log", "fx"].map(async (n) => realpathSync(await mkdtemp(join(tmpdir(), `orca-ci-${n}-`))))) as [string, string, string, string, string];
  repo = await makeScratchRepo();
  origin = await makeScratchRepo();
  await run(["git", "-C", repo, "remote", "add", "origin", origin]);
  await run(["git", "-C", repo, "fetch", "-q", "origin"]);
  process.env.ORCA_STATE_DIR = state;
  process.env.ORCA_FAKE_LOG = log;
  process.env.PATH = `${shim}:${prev.PATH}`;
  process.env.ORCA_GH_ARGS_LOG = join(fx, "gh.log");
  process.env.ORCA_GH_CHECK_RUNS_FIXTURE = join(fx, "runs.json");
  process.env.ORCA_GH_RUN_LOG_FIXTURE = join(fx, "job.log");
  await installFakeGh();
  await setPrListFixture([]);
  // A worker commits; the orchestrator just answers.
  await writeFile(join(shim, "claude"), `#!/bin/sh
printf '%s' "$*" > "$ORCA_FAKE_LOG/$(date +%s%N)-$$"
case "$PWD" in */orchestrator) ;; *) echo "$$" >> cache.ts && git add cache.ts && git -c user.email=t@t -c user.name=t commit -qm "Add the cache" ;; esac
printf '{"type":"result","subtype":"success","result":"## Outcome\\\\nDone.","is_error":false}'
`);
  await chmod(join(shim, "claude"), 0o755);
  pg = await freshSchema("cigate");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  for (let i = 0; i < 200 && (await anyRunning()); i++) await Bun.sleep(25);
  agent.onRunFinished(undefined);
  ciGate.onSettled(undefined);
  agent.onQueuedMessage(async () => {});
  await agent.afterRunsSettled();
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, repo, origin, worktrees, log, fx]) await rm(d, { recursive: true, force: true });
});

const anyRunning = async () => agent.isRunning(orchestrator.dir())
  || (await git.listWorktrees(repo, worktrees).catch(() => [])).some((w) => agent.isRunning(w.worktreePath));
const launches = async () => Promise.all((await readdir(log)).sort().map((f) => readFile(join(log, f), "utf8")));
const orchTurns = () => db.turns(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH);
const ghCalls = async () => (await readFile(join(fx, "gh.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
const setRuns = (runs: CheckRun[]) => writeFile(join(fx, "runs.json"), JSON.stringify({ total_count: runs.length, check_runs: runs }));
const brief = { repo: "r", title: "Add cache", model: "claude-sonnet-5", objective: "Add a response cache", output: "One commit", boundaries: "Only touch src/cache" };

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    await agent.afterRunsSettled();
    const v = await read();
    if (ok(v) && !(await anyRunning())) return v;
    await Bun.sleep(25);
  }
  throw new Error(`never: ${what}`);
}
const finished = (turns: AgentTurn[], n: number) => turns.length >= n && turns.every((t) => t.finishedAt);

/** Spawn one orchestrated worker and wait until its gate is waiting on GitHub. */
async function spawnAndWait(c: OrcaConfig): Promise<{ branch: string; gate: ciGate.CiGate }> {
  wire(c);
  await orchestrator.tool(c, "spawn", brief);
  const branch = Object.keys(await db.enrichment("r"))[0]!;
  const e = await until(async () => (await db.enrichment("r"))[branch], (e) => Boolean(ciGate.gateOf(e)), "a CI gate");
  return { branch, gate: ciGate.gateOf(e)! };
}

test("CI5: no PR yet — Orca runs no check on the box, opens the PR, waits; a pass sends the held report", async () => {
  const c = cfgOf({ checkCommand: "exit 7" }); // would fail if it ran on the box
  const { branch, gate } = await spawnAndWait(c);
  // The worker was told CI is the gate; no box check ran, and the report waits.
  expect((await launches())[0]).toContain(CI_GATE_GUIDANCE);
  const [turn] = await db.turns("r", branch);
  expect(turn!.check).toBeUndefined();
  expect(await orchTurns()).toHaveLength(0);
  // The PR is opened first (a pull_request workflow runs only on a PR), and the head is on origin.
  expect((await ghCalls()).some((l) => l.startsWith("POST /repos/acme/app/pulls"))).toBe(true);
  expect(gate.sha).toBe((await run(["git", "-C", origin, "rev-parse", branch])).trim());
  expect(gate.report).toContain("Orca opened PR #123");

  // GitHub says green: the verdict lands on the turn, and the report goes with the check line second.
  await setRuns([{ id: 11, name: "check", status: "completed", conclusion: "success", app: { slug: "github-actions" } }]);
  await ciGate.tick(c, Date.now() + CI_WAIT.firstMs);
  expect(ciGate.gateOf((await db.enrichment("r"))[branch])).toBeUndefined();
  expect((await db.turns("r", branch))[0]!.check).toMatchObject({ command: GITHUB_CHECK, via: "github", ok: true });
  const [wake] = await until(orchTurns, (t) => finished(t, 1), "the orchestrator's wake");
  expect(wake!.instruction).toStartWith(`${WORKER_EVENT_MARKER} r/${branch} "Add cache" — done\nOrca's check \`GitHub CI\` passed\n`);
  // ONE check-runs call for the look.
  expect((await ghCalls()).filter((l) => l.includes(`/commits/${gate.sha}/check-runs`))).toHaveLength(1);
});

test("CI6: a failed check gives the check's name and log tail on the turn, the report and the autofix", async () => {
  const c = cfgOf({ features: { followAutomation: true } });
  const { branch, gate } = await spawnAndWait(c);
  await setRuns([{ id: 42, name: "check", status: "completed", conclusion: "failure", html_url: "https://github.com/acme/app/runs/42", app: { slug: "github-actions" } }]);
  await writeFile(join(fx, "job.log"), "2026-11-03T10:00:00.0Z bun test\n2026-11-03T10:00:09.0Z error: expect(received).toBe(expected) at cache.test.ts:12\n");
  await ciGate.tick(c, Date.now() + CI_WAIT.firstMs);
  const check = (await db.turns("r", branch))[0]!.check!;
  expect(check).toMatchObject({ command: GITHUB_CHECK, via: "github", ok: false, exitCode: 1 });
  expect(check.output).toContain("Failing check: check (failure)");
  expect(check.output).toContain("error: expect(received).toBe(expected) at cache.test.ts:12");
  // The log came from the job's log route (a check run's id is its job's id).
  expect((await ghCalls()).some((l) => l.includes("/actions/jobs/42/logs"))).toBe(true);
  // The fix follow-up runs with the log tail; the fix attempt's own verdict waits on GitHub again.
  const turns = await until(() => db.turns("r", branch), (t) => finished(t, 2), "the autofix run");
  expect(turns[1]!.instruction).toStartWith(AUTOFIX_MARKER);
  expect(turns[1]!.instruction).toContain("cache.test.ts:12");
  const next = await until(async () => (await db.enrichment("r"))[branch], (e) => ciGate.gateOf(e)?.runId === turns[1]!.id, "the fix's gate");
  expect(ciGate.gateOf(next)!.sha).not.toBe(gate.sha);
  // A fix attempt that fails again is not fixed a third time, and its report is a problem.
  await ciGate.tick(c, Date.now() + CI_WAIT.firstMs);
  const [wake] = await until(orchTurns, (t) => finished(t, 1), "the orchestrator's wake");
  expect(wake!.instruction).toContain("Orca's check `GitHub CI` FAILED (exit 1):\nFailing check: check (failure)");
  expect(isWorkerProblem(wake!.instruction!)).toBe(true);
  expect(await db.turns("r", branch)).toHaveLength(2);
}, 20_000);

test("CI7: pending keeps waiting with a longer gap, no call before it is due, and no report", async () => {
  const c = cfgOf();
  const { branch, gate } = await spawnAndWait(c);
  await setRuns([{ id: 1, name: "check", status: "in_progress", conclusion: null }]);
  const now = Date.now() + CI_WAIT.firstMs;
  await ciGate.tick(c, now);
  const after = ciGate.gateOf((await db.enrichment("r"))[branch])!;
  expect(after).toMatchObject({ runId: gate.runId, polls: 1, nextAt: now + nextPollGap(1) });
  // Not due yet: no call.
  const calls = (await ghCalls()).length;
  await ciGate.tick(c, now + 1000);
  expect((await ghCalls()).length).toBe(calls);
  expect((await db.turns("r", branch))[0]!.check).toBeUndefined();
  expect(await orchTurns()).toHaveLength(0);
});

test("CI8: a local repo is unchanged — the check command runs on the box, no gate, no CI guidance", async () => {
  const c = cfgOf({ check: undefined, checkCommand: "echo box-check" });
  wire(c);
  await orchestrator.tool(c, "spawn", brief);
  const branch = Object.keys(await db.enrichment("r"))[0]!;
  await until(orchTurns, (t) => finished(t, 1), "the orchestrator's wake");
  expect((await db.turns("r", branch))[0]!.check).toMatchObject({ command: "echo box-check", ok: true, output: "box-check" });
  expect(ciGate.gateOf((await db.enrichment("r"))[branch])).toBeUndefined();
  expect((await launches())[0]).not.toContain(CI_GATE_GUIDANCE);
  expect((await orchTurns())[0]!.instruction).toContain("Orca's check `echo box-check` passed");
  expect((await ghCalls()).some((l) => l.includes("check-runs"))).toBe(false);
});
