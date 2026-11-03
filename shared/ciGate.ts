// GitHub CI as the check gate (a repo's `check: "github"`): the rules, pure. After a run that
// committed, Orca runs no check command on the box. It reads the check runs GitHub has for the
// run's head commit and turns them into the same TurnCheck the box check gives, so the card, the
// worker report and the autofix read it as before. The I/O is server/ciGate.ts.
import { GITHUB_CHECK, type TurnCheck } from "./agent";

/** One check run, as `GET /repos/{o}/{r}/commits/{sha}/check-runs` lists it (the fields we read). */
export type CheckRun = {
  id: number; name: string; status: string; conclusion?: string | null;
  html_url?: string; details_url?: string; app?: { slug?: string } | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
};

/** What GitHub says about one commit right now. `none`: no check (that gates) exists yet. */
export type CiVerdict =
  | { state: "none" }
  | { state: "pending"; running: string[] }
  | { state: "passed"; names: string[] }
  | { state: "failed"; failing: CheckRun[] };

const PASS = new Set(["success", "neutral", "skipped"]);
const FAIL = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

/** The verdict over a commit's check runs. Only the required checks decide when the base branch
 *  has some (as on the board); with none, every check does. A failed check decides at once: the
 *  worker hears about it before the slow checks end. */
export function ciVerdict(runs: CheckRun[], required: Set<string> = new Set()): CiVerdict {
  // The newest run of each name: a re-run adds a run with the same name.
  const latest = new Map<string, CheckRun>();
  for (const r of runs) if (!latest.has(r.name) || latest.get(r.name)!.id < r.id) latest.set(r.name, r);
  const gating = [...latest.values()].filter((r) => !required.size || required.has(r.name));
  if (!gating.length) return { state: "none" };
  const failing = gating.filter((r) => r.status === "completed" && FAIL.has(r.conclusion ?? ""));
  if (failing.length) return { state: "failed", failing };
  const running = gating.filter((r) => r.status !== "completed" || !PASS.has(r.conclusion ?? ""));
  if (running.length) return { state: "pending", running: running.map((r) => r.name) };
  return { state: "passed", names: gating.map((r) => r.name) };
}

/** The chars of a failing check's log kept on the turn: as much as the box check keeps. */
export const LOG_TAIL_CHARS = 4_000;

/** The end of a GitHub Actions job log: timestamps and colour codes off, empty lines out. */
export function logTail(raw: string, max = LOG_TAIL_CHARS): string {
  const text = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
    .filter(Boolean)
    .join("\n");
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/** The TurnCheck for a final verdict. `log` is the first failing check's log tail, when Orca got it. */
export function ciCheck(v: Extract<CiVerdict, { state: "passed" | "failed" }>, durationMs: number, log?: string): TurnCheck {
  if (v.state === "passed") {
    return { command: GITHUB_CHECK, via: "github", ok: true, exitCode: 0, output: `Passed: ${v.names.join(", ")}`, durationMs };
  }
  const [first] = v.failing;
  const evidence = log?.trim() || [first?.output?.title, first?.output?.summary, first?.output?.text].filter(Boolean).join("\n").trim();
  const output = [
    `Failing check${v.failing.length === 1 ? "" : "s"}: ${v.failing.map((r) => `${r.name} (${r.conclusion})`).join(", ")}`,
    ...(first?.html_url ? [first.html_url] : []),
    ...(evidence ? ["", logTail(evidence)] : []),
  ].join("\n");
  return { command: GITHUB_CHECK, via: "github", ok: false, exitCode: 1, output, durationMs };
}

/** How long the gate waits on GitHub. */
export const CI_WAIT = {
  /** The first look: a fresh push has no check runs for some seconds. */
  firstMs: 60_000,
  /** The longest gap between two looks. */
  maxGapMs: 5 * 60_000,
  /** No check run at all by then: the commit has no CI (no PR, or no workflow for it). */
  noChecksMs: 15 * 60_000,
  /** Checks still running by then: the gate stops waiting. */
  giveUpMs: 2 * 60 * 60_000,
};

/** The gap before the next look, after `polls` looks: one minute, then ×1.5 each look up to the cap.
 *  One check-runs call a look, so a 20-minute CI costs about eight calls. */
export const nextPollGap = (polls: number): number => Math.min(CI_WAIT.maxGapMs, Math.round(CI_WAIT.firstMs * 1.5 ** Math.max(0, polls - 1)));

/** A verdict that is not final yet: wait, or stop waiting with a reason (no CI, or too slow). */
export function ciWait(v: CiVerdict, sinceMs: number, now: number): { giveUp?: string } {
  const age = now - sinceMs;
  if (v.state === "none" && age >= CI_WAIT.noChecksMs) return { giveUp: `no GitHub check ran on the commit in ${Math.round(CI_WAIT.noChecksMs / 60_000)} min` };
  if (age >= CI_WAIT.giveUpMs) return { giveUp: `GitHub CI did not finish in ${Math.round(CI_WAIT.giveUpMs / 60_000)} min` };
  return {};
}

/** The report line for a gate that stopped waiting. Not "FAILED", so isWorkerProblem reads it clean. */
export const noVerdictLine = (reason: string): string => `Orca's check \`${GITHUB_CHECK}\` gave no verdict: ${reason}`;

/** Put a line second in a worker report: where workerEvent puts Orca's check, and where
 *  isWorkerProblem reads it. */
export function withSecondLine(report: string, line: string): string {
  const at = report.indexOf("\n");
  return at < 0 ? `${report}\n${line}` : `${report.slice(0, at)}\n${line}${report.slice(at)}`;
}

/** What a worker reads when its repo's gate is GitHub CI (added to the prompt at launch). */
export const CI_GATE_GUIDANCE = "This repo uses GitHub CI as its check gate. Do not run a full build, a full test suite or the repo's whole check command on this box. Run only the tests for the files you touch. Then commit and push. Orca reads the GitHub checks of your pushed commit and tells you if one fails.";
