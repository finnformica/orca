// A Claude run that hits its login's usage limit is started again, as the SAME turn, with --resume on
// the same session: hydra's shim sends it to the next login with headroom (2026-10-29: Finn's session
// limit ended a turn although a second login was enabled). Covered:
//   1. detection over the CLI's own output (Claude Code 2.1.302: the text, result and rate_limit_event
//      shapes are read from its bundle), and what is NOT a limit (a transient 429, another error);
//   2. the decision: one retry per login switch, a hold until the earliest reset, the hold cap;
//   3. end to end, a worker: limit on login a, retry on b, ONE turn, ONE worker report, no ladder count;
//   4. end to end, the orchestrator's own wake: limit on a, retry on b, limit on b, hold until the
//      reset (the header line), then the same turn runs again — one wake turn, no "Wake stopped";
//   5. Stop during a hold ends the turn as stopped and starts nothing.
// Real git scratch repo, a fake `claude` (playing hydra's shim) and a fake `hydra` on PATH, real Postgres.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as git from "../server/git";
import * as transcript from "../server/transcript";
import * as orchestrator from "../server/orchestrator";
import { limitLogins } from "../server/usage";
import { run } from "../server/run";
import type { OrcaConfig } from "../server/config";
import {
  LIMIT_CONTINUE_PROMPT, LIMIT_MAX_HOLDS, hydraLogin, limitHeldLine, limitPlan, limitRetryLine, usageLimitHit, withoutHydraLines,
  type AgentTurn,
} from "../shared/agent";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, WORKER_EVENT_MARKER, orchestratorStatus } from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, setPrListFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

const LIMIT_TEXT = "You've hit your session limit · resets 5:40pm (UTC)";
// One `claude -p --output-format stream-json --verbose` run that hits the 5-hour window, as the CLI
// writes it: the rate-limit event (`_os`), the API-error assistant message (`Os({…error:"rate_limit",
// apiError:"usage_limit_reached"})`) and the `-p` result (`subtype:"success"`, `is_error:true`).
const limitStream = (resetsAtS: number) => [
  { type: "system", subtype: "init", cwd: "/wt", model: "claude-opus-5-5" },
  { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: resetsAtS, rateLimitType: "five_hour", utilization: 1, isUsingOverage: false }, uuid: "u1" },
  { type: "assistant", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: LIMIT_TEXT }], stop_reason: "stop_sequence" }, error: "rate_limit", is_api_error_message: true, api_error_status: 429 },
  { type: "result", subtype: "success", is_error: true, api_error_status: 429, duration_ms: 812, num_turns: 1, result: LIMIT_TEXT, stop_reason: "stop_sequence", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } },
].map((e) => JSON.stringify(e)).join("\n");

describe("usageLimitHit", () => {
  test("the CLI's limit output: the message and the reset of the rejected window", () => {
    expect(usageLimitHit(limitStream(1793296799))).toEqual({ message: LIMIT_TEXT, resetsAt: 1793296799_000, window: "five_hour" });
  });

  test("every window label the CLI has, with or without a reset", () => {
    const result = (text: string) => JSON.stringify({ type: "result", subtype: "success", is_error: true, result: text });
    for (const text of ["You've hit your weekly limit · resets Nov 3, 12am (UTC)", "You've hit your Opus limit", "You've hit your Fable limit · resets 9am (UTC) · progress saved", "You've hit your usage limit", "You've hit your limit · resets 5pm (UTC)"]) {
      expect(usageLimitHit(result(text))?.message).toBe(text);
    }
  });

  test("not a limit: a transient 429, a spend limit, another error, or a reply that quotes the text", () => {
    const result = (text: string, is_error = true) => JSON.stringify({ type: "result", subtype: "success", is_error, result: text });
    expect(usageLimitHit(result("API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"))).toBeUndefined();
    expect(usageLimitHit(result("You've hit your monthly spend limit · resets Dec 1"))).toBeUndefined();
    expect(usageLimitHit(result("Not logged in · Please run /login"))).toBeUndefined();
    expect(usageLimitHit(result(LIMIT_TEXT, false))).toBeUndefined(); // a model reply, not the CLI's error
    expect(usageLimitHit("")).toBeUndefined();
  });

  test("hydra's routing line on stderr names the login and is kept out of the error", () => {
    const stderr = "hydra → work   5h 100%   week 40%   (opus: Fable window ignored)\nError: boom";
    expect(hydraLogin(stderr)).toBe("work");
    expect(withoutHydraLines(stderr)).toBe("Error: boom");
    expect(hydraLogin("Error: boom")).toBeUndefined();
  });
});

describe("limitPlan", () => {
  const now = 1_000_000_000_000;
  const login = (name: string, pct: number, resetsAt: number | null, enabled = true) => ({ name, enabled, windows: [{ pct, resetsAt }] });

  test("hydra picks another login: retry on it", () => {
    expect(limitPlan({ tried: [{ name: "a" }], pick: "b", logins: [login("a", 100, now + 9e6), login("b", 20, null)], holds: 0, now })).toEqual({ kind: "retry", login: "b" });
  });

  test("hydra picks the same login again: no loop, hold until the earliest reset", () => {
    const logins = [login("a", 100, now + 3_600_000), login("b", 100, now + 1_800_000), login("c", 100, now + 600_000, false)];
    expect(limitPlan({ tried: [{ name: "a" }], pick: "a", logins, holds: 0, now })).toEqual({ kind: "hold", until: now + 1_800_000 });
  });

  test("one retry per login: after a and b both hit the limit, hold", () => {
    const logins = [login("a", 100, now + 3_600_000), login("b", 99, null)];
    // b has no window at 100% yet (a stale reading) but hit the limit: its CLI reset counts.
    expect(limitPlan({ tried: [{ name: "a" }, { name: "b", resetsAt: now + 2_400_000 }], pick: "b", logins, holds: 0, now })).toEqual({ kind: "hold", until: now + 2_400_000 });
  });

  test("no hydra: hold until the reset the CLI reported, else a fixed wait", () => {
    expect(limitPlan({ tried: [{ name: "claude", resetsAt: now + 900_000 }], logins: [], holds: 0, now })).toEqual({ kind: "hold", until: now + 900_000 });
    expect(limitPlan({ tried: [{ name: "claude" }], logins: [], holds: 0, now })).toEqual({ kind: "hold", until: now + 30 * 60_000 });
  });

  test("a reset already past is held at least the minimum; the hold cap fails the turn", () => {
    expect(limitPlan({ tried: [{ name: "a", resetsAt: now - 5 }], pick: "a", logins: [login("a", 100, now - 5)], holds: 0, now })).toEqual({ kind: "hold", until: now + 60_000 });
    expect(limitPlan({ tried: [{ name: "a" }], pick: "a", logins: [login("a", 100, now + 5)], holds: LIMIT_MAX_HOLDS, now })).toEqual({ kind: "fail" });
  });

  test("the lines: held (UTC, a date when not today) and retried", () => {
    const at = Date.UTC(2026, 9, 29, 17, 40);
    expect(limitHeldLine(at, Date.UTC(2026, 9, 29, 15, 0))).toBe("All Claude logins at their limit; resumes at 17:40 UTC");
    expect(limitHeldLine(at, Date.UTC(2026, 9, 28, 23, 0))).toBe("All Claude logins at their limit; resumes at 17:40 UTC on 2026-10-29");
    expect(limitRetryLine("a", "b")).toBe("Usage limit on a; Orca starts this turn again on b");
    expect(orchestratorStatus({ running: false, workers: 0, held: "All Claude logins at their limit; resumes at 17:40 UTC" }).text).toBe("All Claude logins at their limit; resumes at 17:40 UTC");
  });

  test("hydra status --json → logins: disabled and signed-out logins are not enabled", () => {
    const logins = limitLogins({ profiles: [
      { name: "a", signed_in: true, disabled: false, session: { pct: 100, resets: 1793296799 }, weekly: { pct: 67, resets: 1793555999 }, fable: null },
      { name: "b", signed_in: true, disabled: true, session: { pct: 5, resets: 1793107200 } },
    ] });
    expect(logins).toEqual([
      { name: "a", enabled: true, windows: [{ pct: 100, resetsAt: 1793296799_000 }, { pct: 67, resetsAt: 1793555999_000 }] },
      { name: "b", enabled: false, windows: [{ pct: 5, resetsAt: 1793107200_000 }] },
    ]);
  });
});

// ---- end to end ----

let state: string, shim: string, repo: string, worktrees: string, log: string, fake: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};
const savedWait = { ...agent.limitWait };

const cfg = (): OrcaConfig => ({
  repos: [{ name: "r", repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"] }],
  portRange: [30000, 40000], staleHours: 24,
});

// The fake claude plays hydra's shim + the CLI: it takes the next login from `logins` (the last one
// stays), names it on stderr as hydra does with HYDRA_QUIET=0, and hits the limit when the login is
// listed in `maxed`. The fake hydra answers `pick` with the login the next launch takes.
const CLAUDE = `#!/bin/sh
D="$ORCA_FAKE_DIR"
printf '%s' "$*" > "$ORCA_FAKE_LOG/$(date +%s%N)-$$"
login=$(head -n1 "$D/logins")
[ "$(wc -l < "$D/logins")" -gt 1 ] && sed -i '1d' "$D/logins"
[ "$HYDRA_QUIET" = "0" ] && echo "hydra → $login   5h 99%   week 40%" >&2
if grep -qx "$login" "$D/maxed" 2>/dev/null; then cat "$D/limit.jsonl"; exit 1; fi
printf '{"type":"result","subtype":"success","result":"## Outcome\\\\nDone on %s.","is_error":false}' "$login"
`;
const HYDRA = `#!/bin/sh
D="$ORCA_FAKE_DIR"
case "$1" in
  status) cat "$D/status.json" ;;
  pick) printf '{"name":"%s"}' "$(head -n1 "$D/logins")" ;;
  refresh) echo "$3" >> "$D/refreshed" ;;
esac
`;

beforeEach(async () => {
  prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_FAKE_LOG", "ORCA_FAKE_DIR"].map((k) => [k, process.env[k]]));
  [state, shim, worktrees, log, fake] = await Promise.all(["state", "bin", "wt", "log", "fake"].map(async (n) => realpathSync(await mkdtemp(join(tmpdir(), `orca-limit-${n}-`))))) as [string, string, string, string, string];
  repo = await makeScratchRepo();
  process.env.ORCA_STATE_DIR = state;
  process.env.ORCA_FAKE_LOG = log;
  process.env.ORCA_FAKE_DIR = fake;
  process.env.PATH = `${shim}:${prev.PATH}`;
  await installFakeGh();
  await setPrListFixture([]);
  await writeFile(join(shim, "claude"), CLAUDE);
  await writeFile(join(shim, "hydra"), HYDRA);
  await chmod(join(shim, "claude"), 0o755);
  await chmod(join(shim, "hydra"), 0o755);
  await writeFile(join(fake, "limit.jsonl"), limitStream(Math.ceil(Date.now() / 1000) + 3600) + "\n");
  pg = await freshSchema("usagelimit");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  agent.limitWait.minMs = 0;
});

afterEach(async () => {
  for (let i = 0; i < 200 && (await anyRunning()); i++) await new Promise((r) => setTimeout(r, 25));
  Object.assign(agent.limitWait, savedWait);
  agent.onRunFinished(undefined);
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, repo, worktrees, log, fake]) await rm(d, { recursive: true, force: true });
});

const setLogins = (queue: string[], maxed: string[]) => Promise.all([
  writeFile(join(fake, "logins"), queue.join("\n") + "\n"),
  writeFile(join(fake, "maxed"), maxed.join("\n") + "\n"),
]);
const setStatus = (profiles: { name: string; pct: number; resets: number }[]) => writeFile(join(fake, "status.json"), JSON.stringify({
  profiles: profiles.map((p) => ({ name: p.name, signed_in: true, disabled: false, session: { pct: p.pct, resets: p.resets }, weekly: { pct: 10, resets: p.resets + 86400 } })),
}));
const anyRunning = async () => agent.isRunning(orchestrator.dir())
  || (existsSync(repo) ? (await git.listWorktrees(repo, worktrees)).some((w) => agent.isRunning(w.worktreePath)) : false);
const launches = async () => Promise.all((await readdir(log)).sort().map((f) => readFile(join(log, f), "utf8")));
const orchTurns = () => db.turns(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH);
async function settled(read: () => Promise<AgentTurn[]>, n: number): Promise<AgentTurn[]> {
  for (let i = 0; i < 400; i++) {
    await agent.afterRunsSettled();
    const turns = await read();
    if (turns.length >= n && turns.every((t) => t.finishedAt) && !(await anyRunning())) return turns;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never settled at ${n} turn(s)`);
}
async function until(what: string, check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`timed out waiting for ${what}`);
}
const stepTexts = async (runId: string) => (await transcript.read(runId)).map((s) => s.text ?? "");
const brief = { repo: "r", title: "Add cache", model: "claude-opus-5-5", objective: "Add a response cache", output: "One commit", boundaries: "Only touch src/cache" };

test("a worker hits the limit on login a: the same turn runs again on b — one turn, one report, no ladder count", async () => {
  await setLogins(["a", "b"], ["a"]);
  await setStatus([{ name: "a", pct: 100, resets: Math.ceil(Date.now() / 1000) + 3600 }, { name: "b", pct: 20, resets: Math.ceil(Date.now() / 1000) + 9000 }]);
  const finished: agent.RunFinished[] = [];
  agent.onRunFinished(async (run) => { finished.push(run); await orchestrator.onRunFinished(cfg(), run); });
  await orchestrator.tool(cfg(), "spawn", brief);
  const branch = Object.keys(await db.enrichment("r"))[0]!;

  const [report] = await settled(orchTurns, 1);
  const [turn, ...more] = await db.turns("r", branch);
  expect(more).toEqual([]); // ONE turn: the retry continued it
  expect(turn).toMatchObject({ stopReason: "end_turn", response: "## Outcome\nDone on b." });
  // Two worker launches: the second resumes the first's session with the CLI's own continue prompt.
  const worker = (await launches()).filter((a) => !a.includes("Orca's orchestrator") && !a.includes("## Board"));
  expect(worker).toHaveLength(2);
  const sid = /--session-id (\S+)/.exec(worker[0]!)?.[1];
  expect(sid).toBeTruthy();
  expect(worker[1]).toContain(`--resume ${sid}`);
  expect(worker[1]).toContain(LIMIT_CONTINUE_PROMPT);
  expect(await stepTexts(turn!.id)).toContain("> Orca: Usage limit on a; Orca starts this turn again on b.");
  expect((await readFile(join(fake, "refreshed"), "utf8")).trim()).toBe("a"); // hydra re-read the failed login
  // ONE run-finished for the worker, clean; ONE report, clean; the ladder saw no failure.
  const workerRuns = finished.filter((r) => r.options.repo === "r");
  expect(workerRuns.map((r) => [r.runId, r.status])).toEqual([[turn!.id, "done"]]);
  expect(report!.instruction).toStartWith(`${WORKER_EVENT_MARKER} r/${branch} "Add cache" — done`);
  expect((await orchTurns()).filter((t) => t.instruction?.includes(`r/${branch}`))).toHaveLength(1);
  expect((await db.enrichment("r"))[branch]).not.toHaveProperty("failStreak");
}, 30_000);

test("the orchestrator's wake: retry once per login, then hold until the earliest reset, then the same wake runs again", async () => {
  const reset = Math.ceil(Date.now() / 1000) + 3;
  await setLogins(["a", "b"], ["a", "b"]);
  await setStatus([{ name: "a", pct: 100, resets: reset + 3600 }, { name: "b", pct: 100, resets: reset }]);
  await writeFile(join(fake, "limit.jsonl"), limitStream(reset) + "\n"); // the CLI agrees with hydra on b's reset
  agent.onRunFinished((run) => orchestrator.onRunFinished(cfg(), run));
  await orchestrator.message(cfg(), "what is on the board?");

  // a hit the limit, b hit the limit: two launches, then a hold — no third launch on b.
  await until("the hold", async () => Boolean((await orchestrator.status(cfg())).held));
  const status = await orchestrator.status(cfg());
  expect(status.held).toStartWith("All Claude logins at their limit; resumes at ");
  expect(status.running).toBe(false); // a held wake has no process: a deploy need not wait for it
  expect(agent.isRunning(orchestrator.dir())).toBe(true); // a send still queues behind it
  expect(await launches()).toHaveLength(2);
  const [held] = await orchTurns();
  expect(held!.finishedAt).toBeFalsy();
  expect(await stepTexts(held!.id)).toEqual(expect.arrayContaining([
    "> Orca: Usage limit on a; Orca starts this turn again on b.",
    expect.stringMatching(/^> Orca: All Claude logins at their limit; resumes at \d\d:\d\d UTC\.$/),
  ]));

  // b's window resets: the timer starts the SAME wake again, on the same session.
  await setLogins(["b"], []);
  const [wake, ...more] = await settled(orchTurns, 1);
  expect(more).toEqual([]); // ONE wake turn, no "Wake stopped", no second wake
  expect(wake).toMatchObject({ id: held!.id, stopReason: "end_turn", response: "## Outcome\nDone on b." });
  const all = await launches();
  expect(all).toHaveLength(3);
  expect(all[2]).toContain(`--resume ${/--session-id (\S+)/.exec(all[0]!)?.[1]}`);
  expect((await orchestrator.status(cfg())).held).toBeUndefined();
  expect(await db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH)).toEqual([]);
}, 30_000);

test("Stop during a hold ends the turn as stopped and starts nothing more", async () => {
  await setLogins(["a"], ["a"]);
  await setStatus([{ name: "a", pct: 100, resets: Math.ceil(Date.now() / 1000) + 3600 }]);
  const finished: agent.RunFinished[] = [];
  agent.onRunFinished(async (run) => { finished.push(run); });
  const wt = join(worktrees, "x");
  await run(["git", "-C", repo, "worktree", "add", "-q", "-b", "x", wt]);
  const { runId } = await agent.launch(wt, wt, "do it", { provider: "claude", repo: "r", branch: "x", instruction: "do it" });
  await until("the hold", () => Boolean(agent.status(wt).note));
  expect(agent.status(wt)).toMatchObject({ status: "running", runId, note: expect.stringMatching(/^All Claude logins at their limit; resumes at /) });
  expect(await launches()).toHaveLength(1); // hydra picked a again: no retry on the same login

  expect(await agent.interrupt(wt)).toBe(runId);
  await until("the stopped turn", async () => Boolean((await db.turns("r", "x"))[0]?.stopped));
  expect((await db.turns("r", "x"))[0]).toMatchObject({ id: runId, stopReason: "interrupted" });
  expect(agent.isRunning(wt)).toBe(false);
  await new Promise((r) => setTimeout(r, 100));
  expect(await launches()).toHaveLength(1);
  expect(finished).toEqual([]); // a stop is not news, as for any stopped run
}, 30_000);
