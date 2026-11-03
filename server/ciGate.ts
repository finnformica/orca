// GitHub CI as the check gate (a repo's `check: "github"`). The box ran each change's full check up
// to three times (the worker, the pre-push hook, Orca's checkCommand), and builds waited in the heavy
// queue behind each other. For such a repo Orca runs nothing after a run that committed: it pushes
// (and, for an orchestrated workstream, opens the PR: orchestrator.autoPr), then reads the check runs
// GitHub has for the head commit, one REST call a look with a growing gap. The verdict lands on the
// turn as a TurnCheck (`via: "github"`), in the same shape as the box check, so the card, the
// notification, the autofix and the held worker report work as before. Rules: shared/ciGate.ts.
//
// The gate is enrichment `ciGate` on the branch (shared and restart-proof, like the merge queue's
// mark); the instance that ran the agent looks at it, because the autofix it may queue runs there.
//
// Not gh.listPrs (#494's shared, cached PR read): that is GraphQL, per PR, and may answer a stale
// row from before the push. The gate needs THIS commit's check runs and their ids (a job's log), so
// it reads REST, which #494 rate-limits apart from GraphQL.
import * as agent from "./agent";
import * as db from "./db";
import * as gh from "./gh";
import * as git from "./git";
import * as github from "./github";
import * as notify from "./notify";
import * as outbox from "./outbox";
import * as primary from "./primary";
import { repoHere } from "./verbs";
import type { OrcaConfig, RepoConfig } from "./config";
import { GITHUB_CHECK, autofixInstruction, isAutofix, type AgentProvider, type TurnCheck } from "../shared/agent";
import { checkNotification } from "../shared/notifications";
import { ciCheck, ciVerdict, ciWait, nextPollGap, CI_WAIT, type CheckRun } from "../shared/ciGate";

/** A run's pending GitHub verdict, on its branch's enrichment. */
export type CiGate = {
  runId: string; sha: string; instance: string; worktreePath: string; provider: AgentProvider;
  /** Queue the fix follow-up on a failure (the repo's follow automation, never for a fix attempt). */
  autofix: boolean;
  /** The run's model, for the model ladder at verdict time. */
  model?: string;
  since: number; polls: number; nextAt: number;
  /** The orchestrator's worker report, held until the verdict: the check line goes second. */
  report?: string;
};
const KEY = "ciGate";
export const gateOf = (e: db.Fields | undefined): CiGate | undefined => {
  const g = e?.[KEY] as CiGate | undefined;
  return g && typeof g.runId === "string" && typeof g.sha === "string" ? g : undefined;
};

/** What a settled gate hands on: the verdict (or the reason there is none) and whether a queued
 *  autofix takes the branch over. */
export type CiSettled = { repo: string; branch: string; gate: CiGate; check?: TurnCheck; noVerdict?: string; continued: boolean };
let settled: ((s: CiSettled) => Promise<void>) | undefined;
/** The orchestrator's part (ladder + held report), wired in index.ts like mergeQueue.onReport. */
export function onSettled(fn: typeof settled): void { settled = fn; }

/** A run committed in a GitHub-gated repo (`run.ciPending`): push the head and start waiting.
 *  `report` is the orchestrator's held worker report, when the workstream is its. A gate already
 *  waiting on the branch is replaced: its report goes out now, with no verdict. */
export async function begin(cfg: OrcaConfig, run: agent.RunFinished, report?: string): Promise<void> {
  const { repo: repoName, branch } = run.options;
  if (!run.ciPending || !repoName || !branch) return;
  const repo = cfg.repos.find((r) => r.name === repoName);
  if (!repo) return;
  const old = gateOf((await db.enrichment(repoName))[branch]);
  const now = Date.now();
  const gate: CiGate = {
    runId: run.runId, sha: run.ciPending.sha, instance: db.instanceName(), worktreePath: run.cwd, provider: run.options.provider ?? "claude",
    autofix: Boolean(run.options.check?.autofix) && !isAutofix(run.options.instruction),
    ...(run.options.model ? { model: run.options.model } : {}),
    since: now, polls: 0, nextAt: now + CI_WAIT.firstMs,
    ...(report ? { report } : {}),
  };
  await db.patchEnrichment(repoName, branch, { [KEY]: gate });
  if (old && old.runId !== gate.runId && settled) {
    await settled({ repo: repoName, branch, gate: old, noVerdict: "a newer run replaced this commit", continued: false }).catch(db.logUnlessDown("orca: CI gate report failed"));
  }
  // GitHub checks only what it has. The worker pushes as a rule; a push that did not happen fails here.
  if (await git.hasRemote(repo.repoPath)) {
    try {
      await git.pushBranch(run.cwd, branch);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await settle(repo, branch, gate, {
        check: { command: GITHUB_CHECK, via: "github", ok: false, exitCode: 1, durationMs: 0, output: `Orca could not push the commit, so GitHub CI cannot check it:\n${message.slice(-1500)}` },
      });
    }
  } else {
    await settle(repo, branch, gate, { noVerdict: "the repo has no remote" });
  }
}

/** The repos whose gates this instance may have: GitHub-gated and checked out here. */
const gateRepos = (cfg: OrcaConfig): RepoConfig[] => cfg.repos.filter((r) => r.check === "github" && repoHere(r));

let ticking = false;
/** One pass over every gate this instance owns whose next look is due (the minute timer in index.ts). */
export async function tick(cfg: OrcaConfig, now = Date.now()): Promise<void> {
  if (!primary.held() || ticking) return;
  ticking = true;
  try {
    const here = db.instanceName();
    for (const repo of gateRepos(cfg)) {
      for (const [branch, e] of Object.entries(await db.enrichment(repo.name))) {
        const gate = gateOf(e);
        if (!gate || gate.instance !== here || gate.nextAt > now) continue;
        await look(repo, branch, gate, now).catch(db.logUnlessDown(`orca: CI gate ${repo.name}/${branch} failed`));
      }
    }
  } finally {
    ticking = false;
  }
}

/** One look at a gate's commit: ONE check-runs call (plus one log call on a failure). */
export async function look(repo: RepoConfig, branch: string, gate: CiGate, now = Date.now()): Promise<void> {
  let runs: CheckRun[];
  let c: Awaited<ReturnType<typeof github.forRepo>>;
  try {
    c = await github.forRepo(repo.repoPath);
    runs = (await c.rest<{ check_runs?: CheckRun[] }>(`{repo}/commits/${gate.sha}/check-runs?per_page=100`))?.check_runs ?? [];
  } catch (e) {
    // Out of quota: look again when the window resets. Anything else: the normal gap.
    const nextAt = e instanceof github.GitHubRateLimitError ? Math.max(e.resetAt, now + CI_WAIT.firstMs) : now + nextPollGap(gate.polls + 1);
    await db.patchEnrichment(repo.name, branch, { [KEY]: { ...gate, polls: gate.polls + 1, nextAt } });
    if (!(e instanceof github.GitHubRateLimitError)) throw e;
    return;
  }
  const required = await gh.requiredChecks(repo.repoPath, repo.baseBranch); // cached per base
  const v = ciVerdict(runs, required);
  if (v.state === "passed") return settle(repo, branch, gate, { check: ciCheck(v, now - gate.since) });
  if (v.state === "failed") {
    const first = v.failing[0]!;
    // A GitHub Actions check run's id is its job's id: the log is one more call.
    const log = first.app?.slug === "github-actions"
      ? await c.rest<string>(`{repo}/actions/jobs/${first.id}/logs`, { accept: "application/vnd.github.v3.raw", redirectWithoutAuth: true }).then(String).catch(() => undefined)
      : undefined;
    return settle(repo, branch, gate, { check: ciCheck(v, now - gate.since, log) });
  }
  const { giveUp } = ciWait(v, gate.since, now);
  if (giveUp) return settle(repo, branch, gate, { noVerdict: giveUp });
  await db.patchEnrichment(repo.name, branch, { [KEY]: { ...gate, polls: gate.polls + 1, nextAt: now + nextPollGap(gate.polls + 1) } });
}

/** The gate is over: record the verdict where the box check goes, queue the fix, hand on the rest. */
async function settle(repo: RepoConfig, branch: string, gate: CiGate, out: { check?: TurnCheck; noVerdict?: string }): Promise<void> {
  const e = (await db.enrichment(repo.name))[branch];
  if (gateOf(e)?.runId === gate.runId) await db.patchEnrichment(repo.name, branch, { [KEY]: null });
  const { check } = out;
  let continued = false;
  if (check) {
    await outbox.setCheck(gate.runId, check, { repo: repo.name, branch });
    agent.setRunCheck(gate.worktreePath, gate.runId, check);
    const title = typeof e?.title === "string" && e.title.trim() ? e.title.trim() : branch;
    const n = checkNotification({ repo: repo.name, branch, runId: gate.runId, title, check });
    if (n) await notify.emit(n);
    if (!check.ok && gate.autofix) {
      // The same queued follow-up the box check queues: one Orca nudge in the queue (`replace`).
      await db.queueMessage({ repo: repo.name, branch, worktreePath: gate.worktreePath, provider: gate.provider, instruction: autofixInstruction(check), attachments: [] }, { replace: true });
      // A run in flight sends it when it ends; either way the fix attempt reports, not this gate.
      await agent.drainQueue(gate.worktreePath, repo.name, branch);
      continued = true;
    }
  }
  await settled?.({ repo: repo.name, branch, gate, ...out, continued });
}
