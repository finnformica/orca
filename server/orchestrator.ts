// The orchestrator: one conversation you talk to, which delegates to worker agents and is woken when
// they finish. Anthropic's orchestrator-workers pattern, kept to TWO layers — it, and the workstreams
// the board already shows.
//
// It is not a new runtime. A wake is the same headless one-shot every board action is, recorded as
// turns under a reserved (repo, branch) so the chat panel renders it unchanged. What makes it an
// orchestrator is only what it may run — the `orca` command (bin/orca → `tool` below), nothing else —
// and what wakes it: a message from you, or a worker it started going idle.
//
// The session is disposable. Everything it needs to carry on lives outside its context: its notes
// (rewritten by it, re-read on every wake), the live board, and the turn table. So the handover
// ladder applies to it like any other conversation — resume while the context is healthy, reset onto
// the portable transcript at 80% — and a reset loses nothing it was told to keep.
import { mkdirSync } from "fs";
import { join } from "path";
import * as agent from "./agent";
import * as db from "./db";
import * as primary from "./primary";
import * as lease from "./lease";
import * as procs from "./proc";
import * as attachments from "./attachments";
import * as git from "./git";
import * as gh from "./gh";
import * as verbs from "./verbs";
import * as prShots from "./prShots";
import * as preview from "./preview";
import * as mergeQueue from "./mergeQueue";
import { pushToTemplate } from "./pushTemplate";
import * as repos from "./repos";
import * as handoff from "./handoff";
import * as forms from "./forms";
import * as secrets from "./secrets";
import * as memory from "./memory";
import * as scheduledWake from "./scheduledWake";
import * as agents from "./agents";
import { selfServer } from "./servers";
import { stateDir } from "./state";
import { API_PORT } from "./ports";
import { reachable } from "./peer";
import { machineReport } from "./liveMetrics";
import { CLOUDFLARE_TOKEN_ENV, cloudflareTool, cloudflareVerb, configAccountIds } from "./cloudflare";
import { recordOwnWrite as recordCloudflareWrite } from "./integrations/adapters/cloudflare";
import { slackTool } from "./slackTool";
import { gmailTool } from "./gmailTool";
import { granolaTool } from "./granolaTool";
import * as policy from "./integrations/policy";
import { featuresOf, runLimits, runsHere, type OrcaConfig, type RepoConfig } from "./config";
import {
  MODEL_LADDER, NO_REPLY_PLACEHOLDER, ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, boardText, briefProblems, continuation, isUserMessage, isWorkerProblem, wakeFromUser, onlyCleanReports,
  handoffRef, joinMessages, ladderStep, mergedPrIsHistory, nextFailStreak, orchStatusText, orchStatusUpdate, verifiedMark, verifiedState, orchestratorPrompt, sessionHint, sweepText, turnSource, wakeExitReason, wakeProgress, wakeStoppedLine, withAttachments, workerBrief, workerEvent,
  hiddenNote, machineText, originQuote, parseHideFor, turnOrigin, type BoardRow, type FailStreak, type MachineReport, type OrchStatus, type VerifiedMark, type WakeExit,
} from "../web/src/workstream";
import { activityLines, type AgentTurn, type TurnOrigin } from "../shared/agent";
import { linkOrigins } from "./origin";
import { CHIEF, REFLECTION, REFLECTION_MARKER, provenance, reflectionPrompt, reflectionReadCounts, reflectionRefusal, reflectionTrigger, reportWorkstream, tokensOf } from "../shared/memory";
import { WRITING_STYLE } from "../shared/writingStyle";
import type { ReflectionTrigger } from "../shared/memory";
import { AGENT_REPLIED, isScheduledWake, parseScheduledWake } from "../shared/scheduledWake";
import { providerOfModel } from "../shared/models";
import {
  SET_STATES, agentListText, defaultAgentName, agentMessage, agentMessageFrom, agentState, agentVerbRefusal, authoredPost, clearsOnUserMessage, cleanReportsTo,
  type AgentDef, type AgentStateName,
} from "../shared/agents";
import { agentSide, queueCancelRefusal, queueListText, queuedSender, queuedSenderText, sameSide, type Side } from "../shared/rooms";
import { attachmentIdOf, attachmentRefusal, catchAllPostRefusal, deleteRefusal, grantAllowsRepo, grantKey, grantRefusal, outboundRefusal, postsAsUser, repoScoped, type Grant, type ReplyTo } from "../shared/integrations";
import * as integrationStore from "./integrations/store";
import * as integrationRouter from "./integrations/router";
import * as integrationRegistry from "./integrations/registry";

// ponytail: constants, not config — promote one to OrcaConfig the first time it needs tuning.
/** Wakes in a row with no message from you before it stops waking itself. The loop guard: an
 *  orchestrator and a worker can otherwise hand each other work indefinitely while you're away. */
export const MAX_WAKES = 12;
/** `--max-budget-usd` for one wake unless `orchestratorWakeBudgetUsd` says otherwise. Deciding what
 *  to delegate is cheap; a wake that isn't has gone wrong — or its session has grown (see sessionHint). */
/** `--max-budget-usd` for a wake — ONLY when `orchestratorWakeBudgetUsd` is set. There was a default
 *  (5, then 25): a long resumed session pays its cached context every turn and was cut off mid-reply
 *  several times a day. The user's call: it should work without worrying about dying. */
const budgetOf = (cfg: OrcaConfig): number | undefined => cfg.orchestratorWakeBudgetUsd;
/** How often startup recovery looks again at a wake that outlived the previous bridge. */
const RECOVER_POLL_MS = 5_000;
const NOTES_MAX = 20_000;

/** An agent's working directory, and the key its run is tracked under. Under the state dir — never a
 *  worktree — so nothing it writes can leak into a diff. The Chief of Staff keeps the orchestrator's
 *  (`~/.orca/orchestrator`), so its CLAUDE.md, .mcp.json and auto-memory stay where they were; any
 *  other agent's is `~/.orca/agents/<name>`. */
export function dir(name: string = CHIEF): string {
  const d = name === CHIEF ? join(stateDir(), "orchestrator") : join(stateDir(), "agents", name);
  mkdirSync(d, { recursive: true });
  return d;
}

/** One named agent as the runtime sees it (docs/design/named-agents-and-memory.md §7.1): its name,
 *  its workstream branch under ORCHESTRATOR_REPO, its directory and its definition. */
export type AgentRef = { name: string; branch: string; dir: string; def: AgentDef };
const refOf = (def: AgentDef): AgentRef => ({ name: def.name, branch: def.branch, dir: dir(def.name), def });
/** The agent named `name` (none = the default agent, server/agents.ts defaultAgent), with its
 *  definition read from its row on every call, so an edit in Settings applies at once. Throws for an
 *  unknown name. */
export async function agentRef(name?: string, cfg?: OrcaConfig): Promise<AgentRef> {
  const def = name ? await agents.get(name) : await agents.defaultAgent(cfg);
  if (!def) throw new Error(`no agent "${name}" (orca agent list)`);
  return refOf(def);
}
/** `name` while it is an active agent, else the default agent: for what must reach SOME agent (a
 *  worker report, an inbound message, a fired wake) after its agent was archived. */
export async function agentRefOrDefault(name?: string, cfg?: OrcaConfig): Promise<AgentRef> {
  return refOf((name && await agents.get(name)) || await agents.defaultAgent(cfg));
}
/** Every agent's ref, oldest row first. */
export async function agentRefs(): Promise<AgentRef[]> {
  return (await agents.all()).map(refOf);
}
/** The agent whose run key (its directory) is `key`, if any: Stop and lease adoption ask. */
export async function agentByDir(key: string): Promise<AgentRef | undefined> {
  return (await agentRefs()).find((a) => a.dir === key);
}

type Blob = {
  notes?: string; wakes?: number; sessionId?: string; contextPct?: number; preferredModel?: string;
  lastWakeUsd?: number; // what its last wake cost, as the CLI reported it
  /** The wake in flight and the messages it took off the queue — in the blob, not memory, so a wake
   *  that dies with the bridge can still have them re-queued. */
  handling?: { runId: string; instance: string; messages: string[]; ids?: number[] }; // ids[i]: the queued_message row of messages[i]
  died?: string[]; // messages whose wake has died once and are being retried; a second death drops them
  cutOff?: string; // why the last wake died, for the next wake's prompt
  cutOffProgress?: string; // what that wake had already done and said (wakeProgress), for the same prompt
  /** The permission grant of the wake in flight (shared/integrations.ts §3.7): set before its launch,
   *  cleared when it ends. Absent or null = your own chat, the full grant. `tool` enforces it. */
  wakeGrant?: Grant | null;
  /** Where `orca post --reply` answers in the wake in flight: the newest outside message's link and
   *  thread. Set and cleared with `wakeGrant`. */
  wakeReplyTo?: ReplyTo | null;
  /** Every message of the wake in flight is yours (no outside sender, no worker report). Only such a
   *  wake's `send` / `address` clears a workstream's `grantScope`: a worker report is model output
   *  that may carry Discord text, so it must not lift the scope. Set and cleared with `wakeGrant`. */
  wakeFromUser?: boolean | null;
  /** When the user moved the notes into memory (server/memory.ts migrateNotes). From then on the
   *  notes are read-only and leave the prompt; memory replaces them. */
  notesMigratedAt?: number;
  /** A one-time line for the next wake after the move; cleared once a wake carries it. */
  notesMoveNotice?: string | null;
  /** "reflect" while a reflection runs (server-side verb allow-list, shared/memory.ts REFLECT_VERBS). */
  wakeMode?: "reflect" | null;
  /** The agent asked for a reflection (`orca memory reflect`); the minute tick starts it when idle. */
  reflectRequested?: number | null;
};
/** The model it runs on: its pin, else Opus. Its judgement — what to delegate, how to brief, which
 *  model a task deserves — is what the workers' quality rests on, so it gets a strong model; Fable
 *  stays for the work itself where Opus has failed. Always a Claude model: its tool permissions are
 *  Claude Code's. (The user's call: Sonnet was tried first.) */
export const ORCHESTRATOR_DEFAULT_MODEL = "claude-opus-5-5";
/** The model an agent runs on: its pin (the composer's picker), else its row's, else the default
 *  (Opus) for a row with no model. Always a Claude model. */
const modelOf = (_cfg: OrcaConfig, b: Blob, ag: AgentRef): string =>
  (providerOfModel(b.preferredModel) === "claude" ? b.preferredModel! : undefined)
  ?? (providerOfModel(ag.def.model) === "claude" ? ag.def.model! : undefined)
  ?? ORCHESTRATOR_DEFAULT_MODEL;
const blob = async (ag: AgentRef): Promise<Blob> => ((await db.enrichment(ORCHESTRATOR_REPO))[ag.branch] ?? {}) as Blob;
const patch = (ag: AgentRef, fields: db.Fields) => db.patchEnrichment(ORCHESTRATOR_REPO, ag.branch, fields);
const enqueue = (ag: AgentRef, instruction: string, attachments: string[] = [], grant?: Grant | null, replyTo?: ReplyTo | null) =>
  db.queueMessage({ repo: ORCHESTRATOR_REPO, branch: ag.branch, worktreePath: ag.dir, instruction, attachments, provider: "claude", ...(grant ? { grant } : {}), ...(replyTo ? { replyTo } : {}) });

/** Each agent's own module state (§7.1): its chain, the messages waiting on it, and the foreign-wake
 *  suspect. Agents never share a chain: one agent's wake never waits on another's. */
type Lane = { chain: Promise<unknown>; messagesInChain: number; suspect?: string };
const lanes = new Map<string, Lane>();
const lane = (ag: AgentRef): Lane => {
  let l = lanes.get(ag.name);
  if (!l) lanes.set(ag.name, (l = { chain: Promise.resolve(), messagesInChain: 0 }));
  return l;
};

// Deliveries are serialised per agent: two workers finishing in the same tick would otherwise both
// see an idle agent, both launch, and the loser's message would be lost to "already running".
const serial = <T>(ag: AgentRef, fn: () => Promise<T>): Promise<T> => {
  const l = lane(ag);
  const next = l.chain.then(fn, fn);
  l.chain = next.catch(() => {});
  return next;
};

export type AgentStatus = {
  key: string; running: boolean; paused: boolean; notes: string; model: string; contextPct?: number; shell: boolean; lastWakeUsd?: number; hint?: string; startedAt?: number; queued: number;
  /** A wake held after a usage limit (agent.heldNote): the line the header shows. */
  held?: string;
  /** Which agent (§7.2): its name, display name, branch, and the state the panel shows. */
  agent: string; displayName: string; branch: string; state: AgentStateName; stateNote?: string;
};

/** One agent's status (none = the default agent: the panel's main chat, as `/api/orchestrator` answers). */
export async function status(cfg: OrcaConfig, name?: string): Promise<AgentStatus> {
  const ag = await agentRef(name, cfg);
  const b = await blob(ag);
  // A wake held for a usage limit has no process: not "running", so a deploy need not wait hours for
  // it (recover queues its messages again after a restart). A send still queues: wake() asks isRunning.
  const held = agent.heldNote(ag.dir);
  const running = agent.isRunning(ag.dir) && !held;
  const paused = (b.wakes ?? 0) >= MAX_WAKES;
  const def = ag.def; // its row: the state it set lives there too
  const visible = agentState({ running, paused, stored: def.state, ...(def.stateNote ? { note: def.stateNote } : {}) });
  return {
    key: ag.dir, running, paused, notes: b.notes ?? "",
    startedAt: running ? agent.runStartedAt(ag.dir) : undefined, // when the wake in flight began — the header's elapsed time
    queued: (await db.queuedMessages(ORCHESTRATOR_REPO, ag.branch)).length, // waiting for the next wake
    model: modelOf(cfg, b, ag),
    contextPct: b.contextPct, // how full its last run left the session; absent until one has reported
    shell: ag.def.tools.shell && cfg.orchestratorShell !== false,
    lastWakeUsd: b.lastWakeUsd,
    hint: sessionHint({ contextPct: b.contextPct, lastWakeUsd: b.lastWakeUsd, budgetUsd: budgetOf(cfg) }),
    agent: ag.name, displayName: ag.def.displayName, branch: ag.branch, state: visible.state, ...(visible.note ? { stateNote: visible.note } : {}),
    ...(held ? { held } : {}),
  };
}

/** Every agent's status, the Chief of Staff first: the panel's tabs and `orca agent list`. */
export async function statuses(cfg: OrcaConfig): Promise<AgentStatus[]> {
  return Promise.all((await agentRefs()).map((a) => status(cfg, a.name)));
}

/** Pin the model its next wake runs on. The session is kept: a resumed Claude session accepts a
 *  different --model (rung 1 of the ladder). */
export async function setModel(model: unknown, name?: string): Promise<void> {
  if (typeof model !== "string" || providerOfModel(model) !== "claude") throw new Error("the orchestrator runs on a Claude model");
  await patch(await agentRef(name), { preferredModel: model });
}

/** A message from a person clears what the agent said it waits on (§7.2). Best effort. */
async function clearWaiting(ag: AgentRef): Promise<void> {
  const def = await agents.get(ag.name).catch(() => undefined);
  if (def && clearsOnUserMessage(def.state)) await agents.setState(ag.name, "idle").catch(() => {});
}

/** Something you typed. Resets the wake count — a person is in the loop again. An outside sender's
 *  message (server/integrations/inbox.ts) carries its `grant`: it never shares a wake with a message
 *  of another grant, and that wake's `orca` verbs are checked against it. `person: false` (a webhook
 *  script, not a person) does not reset the wake count, so a script cannot keep it awake forever. */
export async function message(cfg: OrcaConfig, text: string, attachments: string[] = [], opts: { grant?: Grant; person?: boolean; replyTo?: ReplyTo; agent?: string } = {}): Promise<{ status: "running" | "queued" }> {
  const ag = await agentRef(opts.agent, cfg);
  const l = lane(ag);
  const grant = opts.grant && opts.grant.level !== "full" ? opts.grant : undefined;
  if (agent.isRunning(ag.dir) && !l.messagesInChain) {
    // A wake is in flight: the message only has to reach the queue, so it is written NOW and the
    // sender hears "queued" at once. Through the chain it waited behind whatever held it — a worker
    // report's board read, the next wake's launch — and the chat showed "sending…" for seconds.
    // The rest stays on the chain: the wake-count reset (a read-modify-write of the blob), and a
    // drain in case the wake ended between the check and the insert, after its own drain had run.
    // Only with no older message still waiting on the chain, which would then queue after this one.
    return enqueue(ag, text, attachments, grant, opts.replyTo).then(() => {
      void serial(ag, async () => {
        if (opts.person !== false) { await patch(ag, { wakes: 0 }); await clearWaiting(ag); }
        if (!agent.isRunning(ag.dir) && primary.held()) await drain(cfg, ag);
      }).catch(db.logUnlessDown("orca: orchestrator drain after a queued message failed"));
      return { status: "queued" as const };
    });
  }
  l.messagesInChain++;
  return serial(ag, async () => {
    if (opts.person !== false) { await patch(ag, { wakes: 0 }); await clearWaiting(ag); }
    if (agent.isRunning(ag.dir)) {
      await enqueue(ag, text, attachments, grant, opts.replyTo);
      return { status: "queued" as const };
    }
    try {
      await wake(cfg, ag, [withAttachments(text, attachments)], grant, opts.replyTo);
    } catch (e) {
      // The launcher's own guard caught a run this process can't see (its session is still busy
      // under a lease): wake() has put the message back on the queue, where the drain finds it.
      if (e instanceof Error && /already running/.test(e.message)) return { status: "queued" as const };
      throw e;
    }
    return { status: "running" as const };
  }).finally(() => { l.messagesInChain--; });
}

/** Compact its session (the context ring's Compact button): `/compact` on a native resume, as the
 *  card's verb does. Not a wake — no prompt, no board, no claimed messages; whatever queued while it
 *  ran is drained when it finishes, like after any run of its own. */
export async function compact(cfg: OrcaConfig, name?: string): Promise<{ runId: string }> {
  const ag = await agentRef(name, cfg);
  return serial(ag, async () => {
    const b = await blob(ag);
    if (!b.sessionId) throw new Error("the orchestrator has no session to compact yet");
    if (agent.isRunning(ag.dir)) throw new verbs.BusyError();
    const { runId } = await agent.launch(ag.dir, ag.dir, "/compact", {
      provider: "claude", resume: b.sessionId, repo: ORCHESTRATOR_REPO, branch: ag.branch,
      instruction: "/compact", action: "compact", queue: false, model: modelOf(cfg, b, ag), source: "human", // your button
      mcpAllow: "all", // its cwd's `.mcp.json` is yours (minus any browser server)
      ...runLimits(cfg),
    });
    return { runId };
  });
}

/** Stop its wake (the chat's Stop). A stopped wake never reaches the run-finished hook, so this does
 *  its part here: drop the wake's claim (Stop is not a death, so nothing is re-queued) and send what
 *  queued up meanwhile at once — the same drain a finished wake gets. */
export async function stop(cfg: OrcaConfig, name?: string): Promise<string | undefined> {
  const ag = await agentRef(name, cfg);
  const runId = await agent.interrupt(ag.dir, { queue: false });
  await serial(ag, async () => {
    const b = await blob(ag);
    if (runId && b.handling?.runId === runId) {
      await patch(ag, { handling: null, wakeGrant: null, wakeReplyTo: null, wakeFromUser: null, died: null, wakeMode: null });
      // A stopped reflection pass ends its log row (server/memory.ts finishPass); its changes stand.
      if (b.wakeMode === "reflect") await memory.finishPass(runId, "stopped", "(stopped by the user)").catch(db.logUnlessDown("orca: reflection log failed"));
    }
    // Only the primary drains (as the run-finished hook does), and a failed drain never fails Stop.
    if (primary.held()) await drain(cfg, ag).catch(db.logUnlessDown("orca: orchestrator drain after stop failed"));
  });
  return runId;
}

/** The run-finished hook (wired in index.ts). A worker the orchestrator is responsible for going
 *  idle wakes it with the outcome; its own run ending drains whatever arrived meanwhile. */
export async function onRunFinished(cfg: OrcaConfig, run: agent.RunFinished): Promise<void> {
  const { repo, branch } = run.options;
  if (!repo || !branch) return;
  if (repo === ORCHESTRATOR_REPO) {
    const ag = await agents.byBranch(branch).then((d) => d && refOf(d));
    if (!ag) return;
    const exit = run.options.action === "compact" ? undefined : wakeExit(cfg, run); // a compact is no wake
    let askers: string[] = []; // the agents whose `orca ask` this wake answered (`--on agent:<name>`)
    await serial(ag, async () => {
      const handled = (await blob(ag)).handling;
      if (handled?.runId === run.runId) askers = [...new Set(handled.messages.map(agentMessageFrom).filter((a): a is string => Boolean(a)))];
      // Inside the chain: a patch is read-modify-write, and one racing the next wake's own would
      // write back a blob without that wake's `handling` claim — and with it the retry guard.
      await patch(ag, {
        sessionId: run.sessionId,
        ...(run.meta?.contextPct === undefined ? {} : { contextPct: run.meta.contextPct }),
        ...(run.meta?.costUsd === undefined ? {} : { lastWakeUsd: run.meta.costUsd }),
      });
      if (exit) await died(ag, run.runId, exit, run.meta?.costUsd);
      // Only its own claim: a message of yours may have launched the next wake already.
      else if ((await blob(ag)).handling?.runId === run.runId) await patch(ag, { handling: null, wakeGrant: null, wakeReplyTo: null, wakeFromUser: null, died: null });
      // A reflection's end, even a failed one, so a broken one cannot re-run every minute. `at` is
      // NOW: its own changes are before it and do not make the next one due.
      // A reflection pass's end, even a failed one: its log row gets what it changed and its summary.
      // The row's end is "since" for the next pass, so its own changes do not make the next one due.
      if (run.options.action === "reflect") {
        await patch(ag, { wakeMode: null });
        await memory.finishPass(run.runId, exit ? "failed" : "done", exit ? undefined : run.result).catch(db.logUnlessDown("orca: reflection log failed"));
      }
      await drain(cfg, ag);
    });
    // `orca wake --on agent:<name>` (§3.3): another agent waits for this one's reply.
    if (run.options.action === "orchestrate" && !exit && askers.length && primary.held()) {
      void scheduledWake.onEvent({ topic: AGENT_REPLIED, agent: ag.name, askers }, (text, to) => report(cfg, text, undefined, to))
        .catch(db.logUnlessDown("orca: scheduled wake match failed"));
    }
    return;
  }
  const e = (await db.enrichment(repo))[branch] ?? {};
  if (!e.orchestrated) return;
  // Codex and Cursor reveal their session id mid-run, and no browser may be open to record it.
  if (run.sessionId && e.sessionId !== run.sessionId) await db.patchEnrichment(repo, branch, { sessionId: run.sessionId });
  if (run.options.action === "compact") return; // housekeeping you asked for, not work to report
  const step = await ladder(cfg, repo, branch, e, run); // counted even when an autofix takes over
  if (run.continued) return; // a queued follow-up (an autofix) took over — not idle yet
  const opened = await autoPr(cfg, repo, branch, run);
  // After autoPr, which pushes: what is still only on this disk (a push that died with the run).
  const unpushed = await git.unpushedHere(run.cwd);
  const text = workerEvent({
    repo, branch, title: e.title as string | undefined, runId: run.runId, status: run.status,
    outcome: run.structured, response: run.result, check: run.check, denied: run.meta?.permissionDenials, unpushed, stop: run.exit.stop,
  }) + (opened ? `\n${opened}` : "") + (step ? `\n${step}` : "");
  await report(cfg, text, run.key);
}

/** Model-ladder automation: keep the workstream's failure streak, and once it reaches the threshold
 *  on one model, suggest the next model up — or, with the repo's `modelEscalation: "apply"`, re-pin
 *  the workstream to it so the retry runs there. Returns the worker report's line, if any. Only at
 *  report time: an autofix taking over is counted, not escalated, so its own run is the retry. */
async function ladder(cfg: OrcaConfig, repoName: string, branch: string, e: db.Fields, run: agent.RunFinished): Promise<string | undefined> {
  const prev = e.failStreak as FailStreak | undefined;
  const failed = run.status === "error" || run.check?.ok === false;
  // A run you stopped, or one Orca stopped (no progress, the hard ceiling), is not a model failure.
  // A stop, Orca's own stop or a usage limit says nothing about the model.
  const streak = run.status === "stopped" || run.exit.stop || run.exit.usageLimit ? prev : nextFailStreak(prev, run.options.model ?? (e.preferredModel as string | undefined), failed);
  if (JSON.stringify(streak) !== JSON.stringify(prev)) await db.patchEnrichment(repoName, branch, { failStreak: streak ?? null });
  if (run.continued) return undefined;
  const repo = cfg.repos.find((r) => r.name === repoName);
  const step = ladderStep(streak, repo?.modelEscalation ?? "suggest", { repo: repoName, branch });
  if (step?.moveTo) {
    // The send that retries reads the pin (as `send --model` does); the streak restarts on the new model.
    await db.patchEnrichment(repoName, branch, { preferredModel: step.moveTo, preferredProvider: providerOfModel(step.moveTo) ?? "claude", failStreak: null });
  }
  return step?.line;
}

/** The repo's `mergePolicy.autoPr`: a clean finish opens the branch's PR (verbs.openWorkerPr), and
 *  a branch marked merge-when-green before it had one joins the queue. Returns the line the worker
 *  report carries, or nothing. A failure is reported, never thrown — the report still goes. */
async function autoPr(cfg: OrcaConfig, repoName: string, branch: string, run: agent.RunFinished): Promise<string | undefined> {
  const repo = cfg.repos.find((r) => r.name === repoName);
  if (!repo?.mergePolicy?.autoPr || run.status !== "done" || run.check?.ok === false) return undefined;
  try {
    const pr = await verbs.openWorkerPr(repo, branch, run.key, { outcome: run.structured, response: run.result });
    if (!pr) return undefined;
    void mergeQueue.tick(cfg).catch(() => {}); // a branch already marked merge-when-green is picked up now
    return `Orca opened PR #${pr.number}: ${pr.url}`;
  } catch (e) {
    return `Orca could not open its PR: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Which agent a report goes to when the caller names none (§7.4): a problem to the default agent, a
 *  clean report to `agents.cleanReportsTo` while that agent is active, else the default agent. */
export async function reportTarget(cfg: OrcaConfig, text: string): Promise<string> {
  const names = (await agents.all()).map((a) => a.name);
  return isWorkerProblem(text) ? defaultAgentName(cfg, names) : cleanReportsTo(cfg, names);
}

/** Hand a report to an agent: here, or posted to the instance the agents live on (ONE process wakes
 *  each — two resuming the same session at once was the "one message behind" bug). Worker reports,
 *  the merge queue's and fired scheduled wakes all go through this. */
export async function report(cfg: OrcaConfig, text: string, key?: string, name?: string): Promise<void> {
  const to = name ?? await reportTarget(cfg, text);
  const host = cfg.orchestratorOn;
  if (host && host !== db.instanceName()) {
    const base = cfg.instances?.[host];
    if (!base) { console.error(`orca: orchestratorOn "${host}" has no address; report dropped`); return; }
    await fetch(new URL("/api/orchestrator/event", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, key, agent: to }) })
      .catch((e) => console.error("orca: could not deliver a worker report to the orchestrator's instance", e));
    return;
  }
  await deliverReport(cfg, text, key, to);
}

/** Deliver a worker's report by the management-by-exception rules, from this or another instance.
 *  `name` is the agent that takes it (none = by `reportTarget`). */
export async function deliverReport(cfg: OrcaConfig, text: string, key?: string, name?: string): Promise<void> {
  const ag = await agentRefOrDefault(name ?? await reportTarget(cfg, text), cfg);
  // Management by exception. A manager is interrupted for a problem, not for every completion: a
  // worker that failed, was stopped, or whose commit failed Orca's check wakes the orchestrator now.
  // A clean finish is queued and delivered when the batch is done — the last of its running
  // workers finishing — or when the user next speaks, whichever is first; in between, the board
  // and `orca read` are there whenever it wants to check in.
  // A scheduled wake is the agent's own alarm: it wakes at once, like a problem.
  const exception = isWorkerProblem(text) || isScheduledWake(text);
  await serial(ag, async () => {
    const wakes = (await blob(ag)).wakes ?? 0;
    const othersRunning = !exception && await workersRunning(cfg, key);
    // Held, not dropped: a paused orchestrator hears about it with your next message.
    if (agent.isRunning(ag.dir) || wakes >= MAX_WAKES || othersRunning) return void (await enqueue(ag, text));
    await patch(ag, { wakes: wakes + 1 });
    await wake(cfg, ag, [text]);
  });
}

/** Why a wake died before finishing its turn, or undefined when it ended normally (or you stopped
 *  it). The budget is the CLI's own result subtype and the timeout is our own timer firing, so both
 *  are exact; `no-reply` is a heuristic over the CLI's placeholder text. */
function wakeExit(cfg: OrcaConfig, run: agent.RunFinished): WakeExit | undefined {
  if (run.status === "stopped") return undefined;
  if (run.exit.budgetReached) return { kind: "budget", budgetUsd: run.options.maxBudgetUsd ?? budgetOf(cfg) ?? 0 };
  if (run.exit.stop) return { kind: run.exit.stop.kind === "idle" ? "idle" : "timeout", minutes: run.exit.stop.minutes };
  if (run.exit.timedOut) return { kind: "timeout", minutes: (run.options.timeoutMs ?? 0) / 60_000 };
  if (run.status === "error") return { kind: "error", code: run.exit.code, stderr: run.exit.stderr || (run.result ?? "").slice(-300) };
  if (run.result?.trim() === NO_REPLY_PLACEHOLDER) return { kind: "no-reply" };
  return undefined;
}

/** A wake died mid-turn: say why on its turn, and put what it was handling back on the queue — once.
 *  A message whose wake has now died twice is not retried again; the turn's line says so instead. */
async function died(ag: AgentRef, runId: string, exit: WakeExit, costUsd?: number): Promise<void> {
  const b = await blob(ag);
  const messages = b.handling?.runId === runId ? b.handling.messages : [];
  const before = new Set(b.died ?? []);
  const retry = messages.filter((m) => !before.has(m));
  for (const m of retry) await enqueue(ag, m, [], b.wakeGrant, b.wakeReplyTo);
  const reason = wakeExitReason(exit);
  const steps = await agent.runSteps(runId).catch(() => []);
  const toolCalls = steps.filter((s) => s.kind === "tool" && s.name !== "result").length;
  await agent.flushHistory(); // the exit handler's own finish write lands first, or it would overwrite the line
  await db.failTurn(runId, wakeStoppedLine({ reason, toolCalls, costUsd, retried: retry.length, dropped: messages.length - retry.length }));
  // What it had done is read off the steps it recorded as it went — they outlive the process — so the
  // next wake neither repeats a spawn/merge nor leaves the user without the reply it had started.
  if (b.wakeMode === "reflect") await memory.finishPass(runId, "failed", `Pass stopped: ${reason}`).catch(db.logUnlessDown("orca: reflection log failed"));
  await patch(ag, { handling: null, wakeGrant: null, wakeReplyTo: null, wakeFromUser: null, wakeMode: null, died: retry, cutOff: retry.length ? reason : null, cutOffProgress: wakeProgress(steps) || null });
}

/** Startup: a wake that was in flight when the previous bridge stopped has nobody to report its
 *  exit. If it died with the bridge (a service manager kills the whole process group) its messages
 *  are re-queued like any other death; if it outlived the bridge and finished, the queue it left is
 *  drained. `reconcile` is index.ts's turn reconciliation, re-run once the wake is really gone. */
export async function recover(cfg: OrcaConfig, reconcile: () => Promise<unknown>, opts: { runId?: string; agent?: string } = {}): Promise<void> {
  const ag = await agentRef(opts.agent, cfg);
  const { handling } = await blob(ag);
  // None, or another instance's wake — unless it is the run `evictForeignWake` just killed, whose
  // stray bridge may have stamped it with a different instance name.
  if (!handling || (opts.runId ? handling.runId !== opts.runId : handling.instance !== db.instanceName())) return;
  if (agent.isRunning(ag.dir)) {
    // Still going under its lease, and its `orca` calls reach this bridge — let it finish, look again.
    setTimeout(() => void recover(cfg, reconcile, opts).catch(db.logUnlessDown("orca: orchestrator recovery failed")), RECOVER_POLL_MS).unref();
    return;
  }
  await reconcile();
  const turn = await db.turn(handling.runId);
  // ponytail: "finished" = its recovered transcript ends on text, not a tool call. A wake killed
  // right after narrating would pass as finished; read the session file's stop_reason if that bites.
  const last = (await agent.runSteps(handling.runId).catch(() => [])).at(-1);
  // (A wake you stopped never reaches the run-finished hook, so its claim is still here: not a death.)
  const finished = Boolean(turn?.finishedAt) && !turn?.failed && (turn?.stopped || last?.kind === "text");
  await serial(ag, async () => {
    if ((await blob(ag)).handling?.runId !== handling.runId) return;
    if (finished) await patch(ag, { handling: null, wakeGrant: null, wakeReplyTo: null, wakeFromUser: null, died: null });
    else await died(ag, handling.runId, { kind: "restart" });
    await drain(cfg, ag);
  });
}

/** The main side of the one-waker rule, for bridges on code too OLD to have it (incident 2026-10-15:
 *  a branch preview's bridge from before #215 ran 19h after its worktree was deleted, launching the
 *  orchestrator's wakes with a dead bin/ on PATH, so no `orca` command). The orchestrator's lease is
 *  per host, so whoever launched the current wake is its process's nearest bridge ancestor. Only this
 *  bridge — the instance's primary — may be it: another live bridge there is stale by definition, so
 *  it and its wake (broken: wrong PATH/ORCA_URL) are SIGTERMed, and `recover` re-queues what the wake
 *  was handling for a proper one. A wake with NO bridge above it outlived its bridge (a restart) and
 *  is left to `recover` as before. A claimant is stopped only when the SAME one is seen on two checks
 *  in a row: on a restart the previous primary drains for a few seconds after letting the lock go,
 *  and its wake is legitimately parented to it until it exits (then it is adopted, no bridge above).
 *  Returns what it stopped. Primary only. */
export async function evictForeignWake(cfg: OrcaConfig, reconcile: () => Promise<unknown>, table?: procs.ProcRow[], name?: string): Promise<{ bridge: number; run: number; runId: string } | undefined> {
  if (!primary.held()) return undefined;
  const ag = await agentRef(name, cfg);
  const state = lane(ag);
  const l = lease.current(ag.dir);
  if (!l || !lease.pidAlive(l.pid)) return undefined;
  const claimant = procs.bridgeAncestor(l.pid, table ?? await procs.processTable());
  if (!claimant || claimant.pid === process.pid) { state.suspect = undefined; return undefined; }
  const seen = `${claimant.pid}:${l.pid}:${l.runId}`;
  if (state.suspect !== seen) {
    state.suspect = seen;
    console.warn(`orca: the orchestrator's wake (pid ${l.pid}) was launched by another bridge (pid ${claimant.pid}) — stopping both if it still is at the next check`);
    return undefined;
  }
  state.suspect = undefined;
  console.error(`orca: another bridge (pid ${claimant.pid}: ${claimant.command.slice(0, 120)}) launched the orchestrator's wake (pid ${l.pid}, run ${l.runId}) — only this instance's primary may; stopping both`);
  for (const pid of [claimant.pid, l.pid]) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  void recover(cfg, reconcile, { runId: l.runId, agent: ag.name }).catch(db.logUnlessDown("orca: orchestrator recovery failed"));
  return { bridge: claimant.pid, run: l.pid, runId: l.runId };
}

/** After its own run: everything that queued up meanwhile becomes ONE wake, not one each. */
/** Any of its workers still running, other than `except`? The batch is not done while one is. */
async function workersRunning(cfg: OrcaConfig, except?: string): Promise<boolean> {
  return (await board(cfg)).some((r) => r.orchestrated && r.agent === "running" && r.worktreePath !== except);
}

async function drain(cfg: OrcaConfig, ag: AgentRef): Promise<void> {
  const pending = await db.queuedMessages(ORCHESTRATOR_REPO, ag.branch);
  if (!pending.length || agent.isRunning(ag.dir)) return;
  const wakes = (await blob(ag)).wakes ?? 0;
  const human = pending.some((m) => isUserMessage(m.instruction));
  if (!human && wakes >= MAX_WAKES) return; // paused
  // The same rule as for a fresh report: clean reports that piled up while it worked wait for the
  // batch too. Without this, its own exit re-delivered them one wake at a time — every report
  // still interrupted it, just a turn later.
  if (onlyCleanReports(pending.map((m) => m.instruction)) && await workersRunning(cfg)) return;
  await patch(ag, { wakes: human ? 0 : wakes + 1 });
  await wake(cfg, ag, [], pending[0]?.grant); // the oldest message's grant group; the rest wait for the next drain
}

async function wake(cfg: OrcaConfig, ag: AgentRef, fresh: string[], grant?: Grant, freshReplyTo?: ReplyTo): Promise<void> {
  // Only the instance's primary bridge wakes it (server/primary.ts); a secondary leaves the queue alone.
  if (!primary.held()) {
    for (const text of fresh) await enqueue(ag, text, [], grant, freshReplyTo).catch(() => {});
    throw new Error("not the primary bridge: the orchestrator is woken by the instance's primary");
  }
  // Every message a wake handles is a queued_message row, so a turn it starts can reference it by id
  // (TurnOrigin). A fresh message is written here and claimed with the rest; it is the newest row of
  // its grant, so the order is the same as before.
  for (const text of fresh) await enqueue(ag, text, [], grant, freshReplyTo);
  // One grant per wake (§3.7): claim only the queued messages of this wake's grant.
  const only = grantKey(grant);
  const claimed: db.QueuedMessage[] = [];
  for (let m = await db.claimQueuedMessage(ORCHESTRATOR_REPO, ag.branch, only); m; m = await db.claimQueuedMessage(ORCHESTRATOR_REPO, ag.branch, only)) claimed.push(m);
  const messages = claimed.map((m) => withAttachments(m.instruction, m.attachments));
  if (!messages.length) return;
  try {
    const b = await blob(ag);
    const next = continuation({
      provider: "claude", from: b.sessionId ? "claude" : undefined, sessionId: b.sessionId, contextPct: b.contextPct,
      transcript: await db.turns(ORCHESTRATOR_REPO, ag.branch),
    });
    // The full terminal toolset unless opted out — and never for an outside sender's wake: there the
    // `orca` command (checked against the grant server-side) is the only way to act. An agent whose
    // definition has no shell (the Assistant) never gets one.
    const shell = ag.def.tools.shell && cfg.orchestratorShell !== false && !grant;
    // The newest outside message is the one `orca post --reply` answers.
    const replyTo = [...claimed].reverse().find((m) => m.replyTo)?.replyTo;
    const fromUser = wakeFromUser(messages, grant);
    await patch(ag, { wakeGrant: grant ?? null, wakeReplyTo: replyTo ?? null, wakeFromUser: fromUser || null, wakeMode: null }); // before the launch: its first `orca` call is checked
    // Memory (server/memory.ts): the core, the hits for these messages. The notes ride along only
    // until the user moves them into memory.
    const fired = messages.filter(isScheduledWake).map(parseScheduledWake).filter((f) => f !== undefined);
    const memoryText = await memory.forPrompt(ag.name, messages.filter((m) => !isScheduledWake(m)), { fired, notice: b.notesMoveNotice ?? undefined });
    const prompt = orchestratorPrompt({
      fresh: !next.resume, notes: b.notes, notesMoved: Boolean(b.notesMigratedAt), memory: memoryText,
      board: boardText(await board(cfg)), messages, shell, cutOff: b.cutOff, cutOffProgress: b.cutOffProgress,
      // Its row's role and verbs (server/agents.ts), read for this wake: an edit applies at once.
      ...(ag.def.role ? { role: ag.def.role } : {}), verbs: ag.def.tools.verbs,
      ...(ag.name === CHIEF ? {} : { agent: { name: ag.name, displayName: ag.def.displayName } }),
    });
    const receipt = await agent.launch(ag.dir, ag.dir, prompt, {
      ...next, provider: "claude", repo: ORCHESTRATOR_REPO, branch: ag.branch,
      instruction: joinMessages(messages), action: "orchestrate", queue: false,
      // Anything you said makes it yours; worker reports alone are the agents' (folded in the chat).
      source: turnSource(messages),
      model: modelOf(cfg, b, ag), maxBudgetUsd: budgetOf(cfg),
      mcpAllow: "all", // its cwd's `.mcp.json` is yours (minus any browser server)
      ...runLimits(cfg),
      // Everything Claude Code has in a terminal (bypassPermissions), as the user asked: a manager
      // who can find things out, run things and fix the machine. `orchestratorShell: false` keeps
      // it to `orca`, reading, the web and read-only subagents — nothing that can change this machine.
      ...(shell ? { permissionMode: "bypass" as const } : { permissionMode: "ask" as const, allowedTools: ["Bash(orca *)", "Read", "Grep", "Glob", "Agent", "WebSearch", "WebFetch"] }),
      env: {
        // The main install's `orca` and this — the primary — bridge on loopback (always bound), never
        // a worktree's bin/ that may be deleted under it (incident 2026-10-14).
        ORCA_URL: `http://127.0.0.1:${API_PORT}`,
        PATH: `${primary.mainBin()}:${process.env.PATH ?? ""}`,
        // Who calls `orca` (bin/orca sends it): its verbs are checked against its definition, and it
        // owns the memories it writes.
        ORCA_AGENT: ag.name,
      },
    });
    await patch(ag, { sessionId: receipt.sessionId, handling: { runId: receipt.runId, instance: db.instanceName(), messages, ids: claimed.map((m) => m.id) }, cutOff: null, cutOffProgress: null, notesMoveNotice: null });
  } catch (e) {
    // The messages were claimed off the queue; a launch that never happened must not eat them.
    for (const m of claimed) await enqueue(ag, m.instruction, m.attachments, m.grant, m.replyTo).catch(() => {}); // the fresh ones too: they are rows now
    await patch(ag, { wakeGrant: null, wakeReplyTo: null, wakeFromUser: null }).catch(() => {});
    throw e;
  }
}

/** Every workstream on this instance, as the orchestrator reads it.
 *  ponytail: `last` and `check` come from the in-memory run state, so they are blank for a run that
 *  finished before a bridge restart — `orca read` still has it. Join the turn table if that bites. */
export async function board(cfg: OrcaConfig): Promise<BoardRow[]> {
  const rows: BoardRow[] = [];
  const here = db.instanceName();
  const several = Object.keys(cfg.instances ?? {}).length > 0;
  for (const repo of cfg.repos) {
    const local = verbs.repoHere(repo);
    const [worktrees, prs, merged, enrichment, inventory, queued] = await Promise.all([
      local ? git.listWorktrees(repo.repoPath, repo.worktreeRoot).catch(() => []) : Promise.resolve([]),
      local ? gh.listPrs(repo.repoPath).catch(() => []) : Promise.resolve([]), // a local-only repo has no PRs
      local ? gh.listMerged(repo.repoPath).catch(() => []) : Promise.resolve([]),
      db.enrichment(repo.name),
      db.inventory(repo.name).catch(() => []),
      db.queuedCounts(repo.name).catch(() => new Map<string, number>()),
    ]);
    const paths = new Map(worktrees.map((w) => [w.branch, w.worktreePath]));
    const heads = new Map(worktrees.map((w) => [w.branch, w.head]));
    // Other instances' worktrees, as they last published them (newest sighting per branch).
    const elsewhere = new Map<string, { instance: string; data: db.Fields }>();
    for (const r of inventory) if (r.instance !== here && !paths.has(r.branch) && !elsewhere.has(r.branch)) elsewhere.set(r.branch, { instance: r.instance, data: r.data });
    for (const branch of new Set([...paths.keys(), ...elsewhere.keys(), ...prs.map((p) => p.branch)])) {
      const worktreePath = paths.get(branch);
      const remote = elsewhere.get(branch);
      const pr = prs.find((p) => p.branch === branch);
      const run = worktreePath ? agent.status(worktreePath) : undefined;
      const e = enrichment[branch] ?? {};
      const agentState = worktreePath ? (agent.isRunning(worktreePath) ? "running" : run?.status ?? "idle") : ((remote?.data.agentStatus as string | undefined) ?? "idle");
      const head = heads.get(branch) ?? (remote?.data.head as string | undefined);
      const mergedPr = merged.find((m) => m.branch === branch);
      // The web board's derivation (mergedPrIsHistory): a merged PR stands only while nothing has
      // happened on the branch since — a reused branch reads as its live state, not "merged". A
      // worktree that is merely BEHIND the PR's last head (never fetched a push from elsewhere) is
      // not reuse; `git.isAncestor` is only possible when the worktree is on this instance.
      const headBehindPr = local && worktreePath && head && mergedPr?.headSha && head !== mergedPr.headSha
        ? await git.isAncestor(repo.repoPath, head, mergedPr.headSha, branch) : undefined;
      const activity = {
        agentStatus: agentState, queued: queued.get(branch) ?? 0, openPr: Boolean(pr),
        agentStartedAt: run?.startedAt ?? (remote?.data.agentStartedAt as number | undefined),
        head, headBehindPr,
      };
      const done = mergedPr && !mergedPrIsHistory(mergedPr, activity) ? mergedPr : undefined;
      rows.push({
        repo: repo.name, branch, title: pr?.title ?? (e.title as string | undefined), worktreePath: worktreePath ?? (remote?.data.worktreePath as string | undefined),
        agent: agentState,
        pr: pr ? { number: pr.number, isDraft: pr.isDraft, reviewStatus: pr.reviewStatus, ciStatus: pr.ciStatus, mergeable: pr.mergeable, verified: verifiedState(e.verified as VerifiedMark | undefined, pr.head, pr.number) } : done && { number: done.number, merged: true },
        check: run?.check?.ok ?? ((remote?.data.agentCheck as { ok?: boolean } | undefined)?.ok), orchestrated: Boolean(e.orchestrated),
        last: run?.structured?.outcome ?? run?.error ?? ((remote?.data.agentOutcome as { outcome?: string } | undefined)?.outcome),
        instance: several ? (remote?.instance ?? (worktreePath ? here : undefined)) : undefined,
        status: e.orchStatus as OrchStatus | undefined,
        hiddenUntil: e.hiddenUntil as number | undefined,
      });
    }
  }
  return rows;
}

/** Call one of this bridge's own verb routes on another instance (the orchestrator lives on one
 *  machine; a workstream may live on another). The body names the repo and branch, so the far
 *  instance's own placement forwarding would even bounce it on again if it had moved. */
export async function viaInstance(cfg: OrcaConfig, instance: string, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = cfg.instances?.[instance];
  if (!base) throw new Error(`"${instance}" is not a configured instance (instances: ${Object.keys(cfg.instances ?? {}).join(", ") || "none"})`);
  const res = await fetch(new URL(path, base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? `${instance} answered ${res.status}`));
  return data;
}

// ---- the `orca` command ----

const when = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "?");
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const answer = (t: AgentTurn) => t.structured?.outcome || t.response || (t.finishedAt ? "(no output)" : "(still running)");
const turnStatus = (t: AgentTurn) => (!t.finishedAt ? "running" : t.failed ? "failed" : t.stopped ? "stopped" : "done");

function repoNamed(cfg: OrcaConfig, name: unknown): RepoConfig {
  const repo = cfg.repos.find((r) => r.name === name);
  if (!repo) throw new Error(`--repo must be one of: ${cfg.repos.map((r) => r.name).join(", ")}`);
  return repo; // a repo may live on any instance; each verb finds the workstream's home (viaInstance)
}
const required = (args: ToolArgs, key: string): string => {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`--${key} is required`);
  return v.trim();
};

export type ToolArgs = Record<string, unknown> & { _?: string[] };

/** A tool result that carries an exit code (`orca secret pipe|env` gives the command's own): the
 *  route answers `{ text, exitCode }` and bin/orca prints the text and exits with the code. */
export class ToolExit extends Error {
  constructor(readonly text: string, readonly exitCode: number) { super(text); }
}

/** `--attach` (repeatable) as stored references, ready for `withAttachments` — they ride the brief or
 *  message to the worker's instance, which materialises them at launch like any other attachment. */
async function attachArgs(args: ToolArgs): Promise<string[]> {
  const raw = args.attach === undefined ? [] : Array.isArray(args.attach) ? args.attach : [args.attach];
  const refs: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !v.trim()) throw new Error("--attach needs a value: an attachment id from ## Attachments, or a file path");
    refs.push(await attachments.forward(v));
  }
  return refs;
}

/** A link's integration and its adapter's caps: of the adapter running here, else of its kind (it
 *  may run on another instance). No caps for an unknown kind: the dispatcher refuses it. */
async function linkCaps(integrationId: string) {
  const conn = await integrationStore.integration(integrationId);
  const caps = integrationRegistry.adapterFor(integrationId)?.caps ?? integrationRegistry.kinds().find((k) => k.kind === conn?.kind)?.caps;
  return { conn, caps };
}

/** How long `orca post` waits for its delivery to be sent before it says "queued" (a test sets 0). */
export const postWait = { ms: 15_000, everyMs: 250 };

/** The delivery's outcome once it is sent or dead, else undefined when `postWait.ms` runs out. The
 *  dispatcher may run on another instance, so this reads the row, not this process's state. */
async function settledDelivery(id: number) {
  const end = Date.now() + postWait.ms;
  for (;;) {
    const r = await integrationStore.deliveryResult(id);
    if (r && (r.state === "sent" || r.state === "dead")) return r;
    if (Date.now() >= end) return undefined;
    await Bun.sleep(postWait.everyMs);
  }
}

/** `orca post --attach`: refuse before anything is queued when the link's adapter cannot send these
 *  files (no file support, too many, one too large), with the reason the model can act on. The
 *  caps of the adapter running here, else of its kind (it may run on another instance). */
async function refuseAttachments(integrationId: string, refs: string[]): Promise<void> {
  const { conn, caps } = await linkCaps(integrationId);
  const files = await Promise.all(refs.map(async (ref) => {
    const id = attachmentIdOf(ref);
    const row = id ? await db.attachment(id) : undefined;
    return { name: row?.filename ?? ref, bytes: row?.bytes.byteLength ?? 0, text: row ? handoff.asText(row.bytes) : undefined };
  }));
  const refusal = caps && attachmentRefusal(conn?.kind ?? "this", caps, files); // an unknown kind: the dispatcher refuses
  if (refusal) throw new Error(refusal);
  // The handoff's secret scan: a file with an obvious credential never leaves (the line, never the value).
  const secrets = files.flatMap((f) => (f.text === undefined ? [] : handoff.scanSecrets(f.text, f.name)));
  if (secrets.length) throw new Error(`--attach refused: ${secrets.map((x) => `${x.where} line ${x.line} looks like a ${x.kind}`).join("; ")}`);
}

/** `orca channels`: every link (where Orca can post or listen), the subscriptions and the pairing
 *  codes waiting for the user. Read-only. */
async function channelsText(): Promise<string> {
  const [links, conns, subs, pairings] = await Promise.all([integrationStore.links(), integrationStore.integrations(), integrationStore.subscriptions(), integrationStore.pendingPairings()]);
  const byId = new Map(conns.map((c) => [c.id, c]));
  // Each account's policy first (docs/integrations/POLICY.md): what Orca may do, and what its events do.
  const accounts = conns.map((c) => `account ${c.id} · ${c.kind} ${c.name} · access ${c.access ?? "read-write"}${c.access === "read" ? " (no post, send or delete)" : ""} · events ${c.events ?? "trigger"}${c.events === "record" ? " (inbox only, never wakes an agent)" : c.events === "off" ? " (nothing is recorded)" : ""}`);
  const lines = links.length ? links.map((l) => {
    const c = byId.get(l.integrationId);
    return `link ${l.id} · ${c?.kind ?? "?"} ${c?.name ?? l.integrationId} on ${c ? (c.instance === "*" ? "automatic" : c.instance) : "?"} · ${l.externalId}${l.label ? ` (${l.label})` : ""} · ${l.level}${repoScoped(l.level) ? ` on ${l.repos.join(", ") || "no repos"}` : ""}${l.requireMention ? " · mention required" : ""}${l.notifyMe === false ? " · notify me off" : ""}${l.notifyAgent === false ? " · notify agent off: it never wakes you" : ""}${l.externalId === "*" ? " · catch-all: post with --channel <id> [--thread <id>]" : ""}`;
  }) : ["no channel links"];
  const subLines = subs.map((s) => `sub ${s.id} · ${s.topicPattern}${Object.keys(s.filter).length ? ` ${JSON.stringify(s.filter)}` : ""} → ${s.targetKind}${s.targetId ? ` ${s.targetId}` : ""}${s.digestSeconds ? ` · digest ${s.digestSeconds}s` : ""}`);
  const pairLines = pairings.map((p) => `pairing ${p.code} · ${p.adapter}:${p.externalId}${p.name ? ` (${p.name})` : ""} waits for the user's approval`);
  return [...accounts, ...lines, ...subLines, ...pairLines].join("\n");
}

/** Who an outside grant came from, for the card: the paired person's name and the link's adapter
 *  (discord, slack, …). Best effort: a lookup that fails leaves them out. */
async function grantOrigin(g: Grant): Promise<{ by?: string; via?: string }> {
  try {
    const [p, l] = await Promise.all([g.principalId ? integrationStore.principal(g.principalId) : undefined, g.linkId ? integrationStore.link(g.linkId) : undefined]);
    const c = l ? await integrationStore.integration(l.integrationId) : undefined;
    return { ...(p ? { by: p.name } : {}), ...(c ? { via: c.kind } : {}) };
  } catch { return {}; }
}

/** The wake in flight as the origin of a turn it starts (spawn / send / address): its run id and the
 *  ids of the person's messages it handled — references, never the text. Undefined outside a wake. */
async function wakeOrigin(b: Blob, agent: string): Promise<TurnOrigin | undefined> {
  const h = b.handling;
  if (!h || h.instance !== db.instanceName()) return undefined;
  return turnOrigin({ runId: h.runId, messages: h.messages, ids: h.ids ?? [], agent });
}

/** What `orca send` / `orca address` print when their message replaced the agent's own queued one. */
const replacedText = (id: number): string =>
  `Replaced #${id}: your earlier queued message is retired, and this one takes its place in the queue.`;

/** Run one `orca <verb>` and return what it prints. Throws with a message the model can act on. */
export async function tool(cfg: OrcaConfig, verb: string, args: ToolArgs = {}): Promise<string> {
  // Who calls (bin/orca sends the run's ORCA_AGENT; none = the Chief of Staff): its own wake's blob
  // holds the grant and reply target, and its definition limits its verbs (§7.1 step 5).
  const ag = await agentRef(typeof args._agent === "string" && args._agent ? args._agent : undefined, cfg);
  // The grant check (§3.7): a wake an outside sender caused may only use the verbs its grant allows.
  // Server-side, so no prompt can talk its way past it.
  const b = await blob(ag);
  const wakeGrant = b.wakeGrant ?? undefined;
  // `orca post --reply` answers the event that woke it: its link, place and thread — resolved
  // BEFORE the grant check, so the check sees the real link.
  const reply = verb === "post" && args.reply !== undefined ? b.wakeReplyTo ?? undefined : undefined;
  if (verb === "post" && args.reply !== undefined) {
    if (!reply) throw new Error("--reply: this wake has no outside message to answer (it came from the user's chat or a worker report). Name a link with --link <id>.");
    args = { ...args, link: reply.linkId };
  }
  const refusal = grantRefusal(wakeGrant, verb, args);
  if (refusal) throw new Error(refusal);
  // The agent's own verbs (shared/agents.ts): the Assistant has no spawn, send, merge or Slack post.
  const limit = agentVerbRefusal(ag.def, verb, args._ ?? [], args, { fromUser: !wakeGrant && Boolean(b.wakeFromUser) });
  if (limit) throw new Error(limit);
  // A reflection may only read and tidy memory and wakes: no spawn, send, merge, post or ask-user.
  if (b.wakeMode === "reflect") { const r = reflectionRefusal(verb, args._ ?? []); if (r) throw new Error(r); }
  // A workstream an outside sender's wake starts or steers runs in scoped mode (verbs.permissionFor,
  // agent.scopedRules), whatever its repo says — sticky on its enrichment, with who started it for
  // the card. Your own chat steering it (every message yours) clears it again.
  const restricted: db.Fields = wakeGrant ? { grantScope: { ...wakeGrant, ...(await grantOrigin(wakeGrant)) } } : {};
  const steer: db.Fields = wakeGrant ? restricted : b.wakeFromUser ? { grantScope: null } : {};
  const words = args._ ?? [];
  switch (verb) {
    case "board": return boardText(await board(cfg));
    case "channels": return channelsText();
    case "machine": {
      // `orca machine [--on <instance>] [--json]`: what the machine card shows, from the same 15 s ring
      // (liveMetrics.machineReport) — here, or from another instance's /api/machine.
      const on = typeof args.on === "string" && args.on ? args.on : db.instanceName();
      let report: MachineReport;
      if (on === db.instanceName()) report = machineReport(on);
      else {
        const base = cfg.instances?.[on];
        if (!base) throw new Error(`"${on}" is not a configured instance (instances: ${Object.keys(cfg.instances ?? {}).join(", ") || "none"})`);
        if (!(await reachable(base))) throw new Error(`${on} is unreachable (no connection to ${new URL(base).host})`);
        const res = await Bun.fetch(new URL("/api/machine", base)); // Bun.fetch: the test DOM shim swaps the global
        if (!res.ok) throw new Error(`${on} answered ${res.status} (a bridge older than \`orca machine\` has no /api/machine)`);
        report = await res.json() as MachineReport;
      }
      return args.json !== undefined ? JSON.stringify(report, null, 2) : machineText(report);
    }
    case "post": {
      // `orca post --link <id> [--channel <id>] [--thread <id> | --repo r --branch b] [--thread | --new-thread "<name>"] [--attach <id|path>]… "<text>"`,
      // or `orca post --link <id> [--channel <id>] [--thread <id>] --delete <message id>`: a durable delivery
      // through the link's adapter, retried if it fails. With --repo/--branch it continues that
      // workstream's thread on the link, or starts it.
      // `--reply "<text>"` arrives as the flag's value (bin/orca takes the next word), so read it there too.
      // `--thread` opens a thread for the post (Discord: on the mention it answers). With `--reply`, or
      // with no value, it is a switch, and `--reply --thread "<text>"` gives it the text.
      // `--attach` (repeatable) stores each file like `orca send --attach` and sends it as a file. The
      // delivery carries only the refs, so a retry reads the bytes again from the attachment table.
      // `--new-thread "<name>"` posts, then opens a thread with that name on the post (even when the
      // adapter's default is to reply in place). `--delete <message id>` removes one message the bot
      // posted, with no text. Every post waits for its delivery (`postWait`) and prints the platform's
      // message and thread ids; when the wait runs out it says the delivery is queued.
      const openThread = typeof args.thread === "string" && (reply !== undefined || !args.thread);
      const newThreadName = typeof args["new-thread"] === "string" ? args["new-thread"].trim() : "";
      if (args["new-thread"] !== undefined && !newThreadName) throw new Error('--new-thread needs the thread name: orca post --link <id> --new-thread "<name>" "<text>"');
      const deleteId = typeof args.delete === "string" ? args.delete.trim() : "";
      if (args.delete !== undefined && !deleteId) throw new Error("--delete needs the message id: orca post --link <id> --delete <message id>");
      if (newThreadName && args.thread !== undefined) throw new Error("--new-thread opens a thread on a new post: leave out --thread");
      if (deleteId && (newThreadName || args.attach !== undefined || words.length || typeof args.reply === "string" && args.reply.trim() || openThread)) {
        throw new Error("--delete takes only the place (--link, --channel, --thread or --reply) and the message id: no text, --attach or --new-thread");
      }
      const text = deleteId ? `Delete message ${deleteId}` : (words.join(" ").trim() || (typeof args.reply === "string" ? args.reply.trim() : "") || (openThread && typeof args.thread === "string" ? args.thread.trim() : ""));
      const link = typeof args.link === "string" && args.link ? await integrationStore.link(args.link) : undefined;
      if (!link) throw new Error(`--link must name a channel link (orca channels lists them)${args.link ? `: no link "${args.link}"` : ""}`);
      if (!text) throw new Error('the message is required: orca post --link <id> "<text>"');
      // A catch-all link posts to any channel or thread the bot can see: `--channel <id> [--thread <id>]`.
      const channel = typeof args.channel === "string" && args.channel.trim() ? args.channel.trim() : undefined;
      const placeRefusal = catchAllPostRefusal(link, { ...(channel ? { channel } : {}), reply: !!reply, grant: wakeGrant, wakeReplyTo: b.wakeReplyTo ?? null });
      if (placeRefusal) throw new Error(placeRefusal);
      const { conn, caps } = await linkCaps(link.integrationId);
      const kind = conn?.kind ?? "this";
      if (caps) { const refusal = outboundRefusal(kind, caps); if (refusal) throw new Error(refusal); }
      // On an adapter that posts as the user (Slack), only an agent whose row has every verb may
      // post: a limited agent never writes in the user's name (§7.3).
      if (ag.def.tools.verbs !== "all" && postsAsUser(kind)) throw new Error(`refused: on ${kind} a post is in the user's name, and the ${ag.def.displayName} may not post as the user. Ask the Chief of Staff: orca ask chief "<what and why>"`);
      if (deleteId && caps) { const refusal = deleteRefusal(kind, caps); if (refusal) throw new Error(refusal); }
      if (newThreadName && caps && !caps.threads) throw new Error(`--new-thread: the ${kind} adapter has no threads`);
      // A wake an outside sender caused attaches stored ids only: a path would let a message ask Orca
      // to post any file on this machine to the outside.
      if (wakeGrant && (Array.isArray(args.attach) ? args.attach : args.attach === undefined ? [] : [args.attach]).some((v) => typeof v === "string" && !attachmentIdOf(v))) {
        throw new Error("--attach: a wake from an outside message may attach only an attachment id (from ## Attachments), not a file path");
      }
      const files = await attachArgs(args);
      if (files.length) await refuseAttachments(link.integrationId, files);
      const repo = typeof args.repo === "string" && args.repo ? args.repo : undefined;
      const branch = typeof args.branch === "string" && args.branch ? args.branch : undefined;
      const threadId = !openThread && typeof args.thread === "string" && args.thread ? args.thread
        : repo && branch ? (await integrationStore.threadsForWorkstream(repo, branch)).get(link.id) : undefined;
      // A post with no workstream is the agent's own: its scope is the agent's branch, so a thread it
      // opens is linked to the agent and a reply there comes back to it (§7.7). The Chief of Staff's
      // text is as before; another agent's names it (one bot account posts for every agent).
      const own = { repo: ORCHESTRATOR_REPO, branch: ag.branch };
      const r = await integrationRouter.post(link, deleteId ? text : authoredPost(ag.def, text), {
        ...(reply ? { reply } : threadId ? { threadId } : {}), scope: repo ? { repo, ...(branch ? { branch } : {}) } : own,
        ...(openThread ? { openThread } : {}), ...(files.length ? { attachments: files } : {}), ...(channel ? { channel } : {}),
        ...(newThreadName ? { newThread: { name: newThreadName } } : {}), ...(deleteId ? { deleteMessage: deleteId } : {}),
      });
      const where = `${link.label ?? link.id}${r.externalId !== link.externalId ? ` ${r.externalId}` : ""}`;
      const done = r.delivery !== undefined ? await settledDelivery(r.delivery) : undefined;
      if (done?.state === "dead") throw new Error(`${deleteId ? `could not delete message ${deleteId}` : "the post failed"} (delivery ${r.delivery}): ${done.lastError ?? "no reason recorded"}`);
      if (done && deleteId) return `Deleted ${kind} message ${deleteId} in ${where} (delivery ${r.delivery}).`;
      if (done) {
        const opened = newThreadName && done.threadId && done.threadId !== r.threadId;
        return `Sent to ${where}: ${kind} message ${done.externalMsgId ?? "?"}${done.threadId ? `, ${opened ? `new thread "${newThreadName}"` : "thread"} ${done.threadId}` : ""}${newThreadName && !opened ? `. No thread was opened (the ${kind} adapter refused or has none): the post stands where it went` : ""} (delivery ${r.delivery}).`;
      }
      if (deleteId) return `Queued the delete of message ${deleteId} in ${where} as delivery ${r.delivery ?? "?"}; Orca retries it if the call fails.`;
      return `Queued for ${where}${r.threadId ? ` (thread ${r.threadId})` : ""}${openThread || newThreadName ? " in a new thread" : ""}${files.length ? ` with ${files.length} attachment${files.length === 1 ? "" : "s"}` : ""} as delivery ${r.delivery ?? "?"}; Orca retries it if the send fails.`;
    }
    case "thread": {
      // `orca thread link <adapter> <thread-id> --repo r --branch b [--link <id>]`: replies in that
      // external thread now go to the workstream (a "work" grant on its repo is still required).
      if (words[0] !== "link" || !words[1] || !words[2]) throw new Error("usage: orca thread link <adapter> <thread-id> --repo <repo> --branch <branch> [--link <id>]");
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      await integrationStore.setThreadLink({ adapter: words[1], externalThreadId: words[2], repo: repo.name, branch, ...(typeof args.link === "string" && args.link ? { linkId: args.link } : {}) });
      return `Linked ${words[1]} thread ${words[2]} to ${repo.name}/${branch}. Replies there now reach that workstream.`;
    }
    case "ask-user": {
      // `orca ask-user "<question>"`: topic orca.question — the bell (needs input) and every
      // channel subscribed to it. The answer comes back as a message.
      const question = words.join(" ").trim();
      if (!question) throw new Error('the question is required: orca ask-user "<question>"');
      await integrationRouter.publish({
        key: `question:${crypto.randomUUID()}`, topic: "orca.question", at: Date.now(), source: { adapter: "orca" },
        title: "The orchestrator asks", text: question, link: { orchestrator: true },
      }, Date.now(), [{ subscriptionId: null, target: { kind: "web" } }]);
      return "Asked. The user sees it in Orca and on every channel subscribed to orca.question. End your turn; the answer comes as a message.";
    }
    case "ask-form": {
      // `orca ask-form --title "…" [--intro "…"] [--scope s] --fields <json|@file>`: a form card in the
      // Orca chat (server/forms.ts). Returns at once; the submit wakes it with the answers as JSON.
      const f = await forms.ask(cfg, await forms.specFromArgs(args));
      return forms.askedText(f);
    }
    case "secret": {
      // `orca secret list | pipe <name> -- <cmd…> | env <name>[=VAR] -- <cmd…> | delete <name>`
      // (server/secrets.ts). Names only: a value goes from the store into the one command, and the
      // output comes back scrubbed. Owner only (grantRefusal: not a read or work verb).
      const sub = words[0] ?? "";
      const cmd = Array.isArray(args["--"]) ? (args["--"] as unknown[]).map(String) : [];
      if (sub === "list") return secrets.listText(await secrets.list());
      if (sub === "delete") {
        if (!words[1]) throw new Error("usage: orca secret delete <name>");
        return `Deleted secret ${await secrets.remove(words[1], "orchestrator")}.`;
      }
      if (sub === "pipe" || sub === "env") {
        if (!words[1]) throw new Error(`usage: orca secret ${sub} <name>${sub === "env" ? "[=VAR]" : ""} -- <command…>`);
        if (!cmd.length) throw new Error(`the command is required after --: orca secret ${sub} ${words[1]} -- <command…>`);
        const { ref, variable } = sub === "env" ? secrets.envVarFor(words[1]) : { ref: words[1], variable: undefined };
        const r = await secrets.run({ ref, mode: sub, variable, cmd, cwd: typeof args._cwd === "string" ? args._cwd : undefined, who: "orchestrator" });
        throw new ToolExit(r.output, r.exitCode);
      }
      throw new Error("usage: orca secret list | pipe <name> -- <cmd…> | env <name>[=VAR] -- <cmd…> | delete <name>");
    }
    case "spawn": {
      const repo = repoNamed(cfg, args.repo);
      const brief = { objective: args.objective, output: args.output, boundaries: args.boundaries, context: args.context } as Record<string, string | undefined>;
      const problems = briefProblems(brief);
      if (problems.length) throw new Error(`${problems.join("; ")}. A worker knows only its brief.`);
      // Required, not defaulted: left out, every worker got the config default — the biggest model.
      if (typeof args.model !== "string" || !providerOfModel(args.model)) {
        throw new Error(`--model is required (${args.model ? `"${args.model}" is not a model` : "choose from the ladder"}): ${MODEL_LADDER.map((m) => m.id).join(", ")}`);
      }
      const on = typeof args.on === "string" && args.on ? args.on : (repo.runsOn ?? db.instanceName());
      const title = typeof args.title === "string" ? args.title : undefined;
      const prompt = withAttachments(workerBrief(brief), await attachArgs(args));
      if (on !== db.instanceName()) {
        const ws = await viaInstance(cfg, on, "/api/workstreams/spawn", { repo: repo.name, prompt, title, model: args.model, ...restricted, origin: await wakeOrigin(b, ag.name) });
        return `Spawned ${repo.name}/${ws.branch} "${ws.title}" on ${on}. End your turn; you are woken when it finishes.`;
      }
      const ws = await verbs.createWorkstream(cfg, repo, { prompt, title, model: String(args.model), fields: { orchestrated: true, ...restricted }, origin: await wakeOrigin(b, ag.name) });
      return `Spawned ${repo.name}/${ws.branch} "${ws.title}"${cfg.instances ? ` on ${on}` : ""}. End your turn; you are woken when it finishes.`;
    }
    case "send": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      // `--replace "<text>"`: bin/orca reads the text as the flag's value, so it is the message's start.
      const replace = "replace" in args;
      const typed = [typeof args.replace === "string" ? args.replace : "", ...words].join(" ").trim();
      if (!typed) throw new Error('the message is required: orca send --repo <repo> --branch <branch> [--replace] "<message>"');
      const text = withAttachments(typed, await attachArgs(args));
      // A new pin is read by followUp, so the move happens on this message (the ladder decides
      // resume vs handoff from the pinned provider as it does for the card's own picker).
      if (typeof args.model === "string") {
        const provider = providerOfModel(args.model);
        if (!provider) throw new Error(`unknown model "${args.model}"`);
        await db.patchEnrichment(repo.name, branch, { preferredModel: args.model, preferredProvider: provider });
      }
      if (Object.keys(steer).length) await db.patchEnrichment(repo.name, branch, steer);
      // Same lookup as board() (~line 634): only when the repo is checked out here, and never let a
      // GitHub failure (no token, bad auth) stop the send — it just means no PR-sync instruction.
      // Never cached on the workstream: a stale PR number could point at one already closed.
      const prNumber = verbs.repoHere(repo)
        ? (await gh.listPrs(repo.repoPath).catch(() => [])).find((p) => p.branch === branch)?.number
        : undefined;
      // A send that queues replaces this agent's own still-queued message on the branch, in its place
      // (db.queueMessage `replace`, one transaction on the worktree's instance): one message per agent
      // in a queue. --replace says the same thing explicitly. A message a run took, the user's and
      // another sender's are never touched.
      const me = agentSide(ag.name);
      const home = await verbs.placement(repo, { branch });
      const { status, queuedId, replacedId } = home !== db.instanceName()
        ? (await viaInstance(cfg, home, "/api/workstreams/followup", { repo: repo.name, branch, instruction: text, origin: await wakeOrigin(b, ag.name), prNumber, sender: me }) as { status: string; queuedId?: number; replacedId?: number })
        : await verbs.followUp(cfg, repo, branch, { instruction: text, origin: await wakeOrigin(b, ag.name), prNumber, sender: me });
      await db.patchEnrichment(repo.name, branch, { orchestrated: true }); // now yours to hear back from
      const sent = status === "queued"
        ? `Queued as message #${queuedId ?? "?"} behind the run in flight; it is sent when that finishes. To correct it before then: send again with the whole message.`
        : `Sent to ${repo.name}/${branch}. End your turn; you are woken when it finishes.`;
      if (replacedId) return `${replacedText(replacedId)} ${sent}`;
      if (!replace) return sent;
      return `Nothing of yours was still queued on ${repo.name}/${branch} (it was sent already, or there was none), so this went as a normal message. ${sent}`;
    }
    case "queue": {
      // `orca queue --repo r --branch b`: the workstream's undispatched messages. `orca queue cancel
      // <id>`: delete one this agent queued, while it is still undispatched (db.cancelQueuedMessage).
      if (words[0] === "cancel") {
        const id = Number(words[1]);
        if (!words[1] || !Number.isSafeInteger(id) || id <= 0) throw new Error("usage: orca queue cancel <id> (the id from orca queue)");
        const m = await db.queuedMessageById(id);
        if (!m) throw new Error(`No queued message #${id}.`);
        if (wakeGrant && !grantAllowsRepo(wakeGrant, m.repo, "work")) throw new Error(`refused: message #${id} is on ${m.repo}, outside this wake's grant`);
        const at = `${m.repo}/${m.branch}`;
        if (m.replacedBy !== undefined) throw new Error(`refused: message #${id} on ${at} was replaced by message #${m.replacedBy}; cancel that one instead.`);
        if (m.dispatchedAt !== undefined) throw new Error(`refused: message #${id} on ${at} was already dispatched (${new Date(m.dispatchedAt).toISOString()}); a run took it, so it can't be cancelled. Send a correction with orca send.`);
        const from = queuedSender(m);
        const refusal = queueCancelRefusal(from, agentSide(ag.name), ag.def.tools.verbs === "all");
        if (refusal) throw new Error(`refused: message #${id} on ${at} ${refusal}`);
        if (!(await db.cancelQueuedMessage(id))) throw new Error(`refused: message #${id} on ${at} was dispatched just now; a run took it, so it can't be cancelled. Send a correction with orca send.`);
        return `Cancelled queued message #${id} on ${at}${sameSide(from, agentSide(ag.name)) ? "" : ` (queued by ${queuedSenderText(from)})`}. Nothing else changed.`;
      }
      if (words[0]) throw new Error("usage: orca queue --repo <repo> --branch <branch> | orca queue cancel <id>");
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      return queueListText(`${repo.name}/${branch}`, await db.queuedMessages(repo.name, branch), agentSide(ag.name));
    }
    case "address": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      if (Object.keys(steer).length) await db.patchEnrichment(repo.name, branch, steer);
      const home = await verbs.placement(repo, { branch });
      const me = agentSide(ag.name);
      const { status, pr, replacedId } = home !== db.instanceName()
        ? (await viaInstance(cfg, home, "/api/workstreams/address", { repo: repo.name, branch, origin: await wakeOrigin(b, ag.name), sender: me }) as { status: string; pr: number; replacedId?: number })
        : await verbs.addressPr(cfg, repo, branch, { origin: await wakeOrigin(b, ag.name), sender: me });
      await db.patchEnrichment(repo.name, branch, { orchestrated: true });
      if (status === "resolved") return `#${pr}'s only conflict was in its changelog: Orca merged the base, kept both sides' entries and pushed. Nothing else needed an agent, so none was started.`;
      return `${replacedId ? `${replacedText(replacedId)} ` : ""}${status === "queued" ? "Queued" : "Started"} Address PR for #${pr}. End your turn; you are woken when it finishes.`;
    }
    case "pr-shots": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      const body = { repo: repo.name, branch, ...(args.pr ? { pr: Number(args.pr) } : {}) };
      const home = await verbs.placement(repo, { branch });
      const r = (home !== db.instanceName()
        ? await viaInstance(cfg, home, "/api/prs/shots", body)
        : await prShots.attachPrShots(repo, branch, { pr: body.pr })) as prShots.PrShotsResult;
      if (!r.shots) return `No screenshots on ${repo.name}/${branch} to show (${r.why ?? "none reported"}).`;
      return r.updated ? `PR #${r.pr}'s Screenshots section now shows the ${r.shots} newest (hosted on ${r.ref}).` : `PR #${r.pr}'s Screenshots section is ${r.why ?? "unchanged"}.`;
    }
    case "move": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      const to = required(args, "to");
      const home = await verbs.placement(repo, { branch });
      const r = home !== db.instanceName()
        ? (await viaInstance(cfg, home, "/api/workstreams/move", { repo: repo.name, branch, to }) as { instance: string })
        : await verbs.moveWorkstream(cfg, repo, branch, to);
      return `Moved ${repo.name}/${branch} to ${r.instance}. Its next run starts a new session there from the portable transcript.`;
    }
    case "archive": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      const e = (await db.enrichment(repo.name))[branch];
      if (!e?.orchestrated) throw new Error(`${repo.name}/${branch} is not an orchestrated workstream; this command only archives ones this orchestrator spawned or sent to`);
      // The worktree is removed where it lives: a laptop's worktree by the laptop.
      const home = await verbs.placement(repo, { branch });
      if (home !== db.instanceName()) await viaInstance(cfg, home, "/api/workstreams/archive", { repo: repo.name, branch });
      else await verbs.archiveWorkstream(repo, branch);
      return `Archived ${repo.name}/${branch}. Its branch, commits and transcript stay readable with \`orca chats\` / \`orca read\`.`;
    }
    case "hide":
    case "unhide": {
      // Only the card's place in the user's view: the database row, on any instance.
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      if (verb === "unhide") { await db.setHidden(repo.name, branch, null); return `${repo.name}/${branch} shows on the user's board again.`; }
      const until = parseHideFor(required(args, "for"));
      await db.setHidden(repo.name, branch, until);
      const note = hiddenNote(until);
      return `${repo.name}/${branch} is ${note}. The agent, branch, PR and queue do not change; \`orca board\` still lists it.`;
    }
    case "stop": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      const e = (await db.enrichment(repo.name))[branch];
      if (!e?.orchestrated) throw new Error(`${repo.name}/${branch} is not an orchestrated workstream; this command only stops ones this orchestrator spawned or sent to`);
      const dropQueue = "drop-queue" in args;
      const home = await verbs.placement(repo, { branch });
      const r = home !== db.instanceName()
        ? (await viaInstance(cfg, home, "/api/workstreams/stop", { repo: repo.name, branch, dropQueue }) as { runId?: string })
        : await verbs.stopWorkstream(repo, branch, { dropQueue });
      if (!r.runId) return `Nothing running on ${repo.name}/${branch}.`;
      return `Stopped ${repo.name}/${branch} (run ${r.runId}).${dropQueue ? " Its queued messages were dropped." : " Its worktree, commits, queue and session stay; `orca send` resumes it."}`;
    }
    case "sweep": {
      // Finished worktrees, dead previews and orphan branches on every instance. Dry run unless --confirm.
      return sweepText(await verbs.sweepAll(cfg, { confirm: "confirm" in args }));
    }
    case "preview": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      if (!featuresOf(repo).previews || !repo.previewServices.length) throw new Error(`Previews are not enabled for ${repo.name}; the user turns them on in the repo's config`);
      const at = `--repo ${repo.name} --branch ${branch}`;
      if ("push-to-template" in args) {
        // Read-only lookup, like --status: pushing needs an existing preview, never a new checkout.
        const key = (await git.listWorktrees(repo.repoPath, repo.worktreeRoot)).find((w) => w.branch === branch)?.worktreePath;
        if (!key) throw new Error(`No worktree for ${repo.name}/${branch}, so no preview to push`);
        const envFile = repo.copyToWorktree?.find((f) => /(^|\/)\.env$/.test(f));
        if (!envFile) throw new Error(`${repo.name} copies no .env file into its worktrees (copyToWorktree), so there is no source env to push to`);
        return pushToTemplate({ worktree: key, repoPath: repo.repoPath, envFile, confirm: "confirm" in args, backupDir: join(stateDir(), "env-backups") });
      }
      if ("status" in args) {
        // Read-only: look the worktree up rather than `ensureWorktree`, which would check one out.
        const key = (await git.listWorktrees(repo.repoPath, repo.worktreeRoot)).find((w) => w.branch === branch)?.worktreePath;
        const svcs = key ? await preview.status(key) : [];
        if (!key || !svcs.length) return `No preview for ${repo.name}/${branch}. Start one: orca preview ${at}`;
        const state = (s: preview.SvcStatus) => (!s.running ? "failed" : s.ready ? `running ${s.url}` : "starting");
        const overall = svcs.some((s) => !s.running) ? "failed" : svcs.every((s) => s.ready) ? "running" : "starting";
        return [
          `Preview ${repo.name}/${branch}: ${overall}`,
          ...svcs.map((s) => `  ${s.name}: ${state(s)}`),
          ...(await preview.logs(key)).flatMap((l) => ["", `--- ${l.name} log (tail) ---`, l.log || "(empty)"]),
        ].join("\n");
      }
      const key = await verbs.ensureWorktree(repo, branch);
      const svcs = await verbs.startPreview(cfg, repo, key, key, branch);
      return `Starting the preview for ${repo.name}/${branch}: ${svcs.map((s) => `${s.name} ${s.url}`).join(", ")}. It takes a minute or more to boot and nothing wakes you when it is up: check with \`orca preview ${at} --status\`.`;
    }
    case "chats": {
      const query = words.join(" ").trim();
      if (!query) {
        const all = (await db.conversations()).filter((c) => c.repo !== ORCHESTRATOR_REPO);
        return all.map((c) => `#${c.id} ${c.repo}/${c.branch}${c.title ? ` "${c.title}"` : ""}${c.archived ? " [archived]" : ""} — ${c.turns} turn${c.turns === 1 ? "" : "s"}, last ${when(c.lastAt)}`).join("\n") || "(no conversations yet)";
      }
      const hits = (await db.searchTurns(query)).filter((h) => h.repo !== ORCHESTRATOR_REPO);
      return hits.map((h) => [
        `#${h.id} ${h.repo}/${h.branch}${h.archived ? " [archived]" : ""} — run ${h.runId} (${when(h.turn.startedAt)})`,
        `  ❯ ${clip(h.turn.instruction ?? "", 200)}`,
        `  → ${clip(answer(h.turn).replace(/\s+/g, " "), 300)}`,
      ].join("\n")).join("\n") || `No past turn matches "${query}".`;
    }
    case "read": {
      if (typeof args.run === "string") {
        const t = await db.turn(args.run);
        if (!t) throw new Error(`no turn with run id ${args.run}`);
        await linkOrigins([t]);
        const activity = activityLines(await agent.runSteps(t.id).catch(() => []));
        return [
          `run ${t.id} — ${turnStatus(t)} (${when(t.startedAt)})`,
          ...(t.origin ? [originQuote(t.origin, t.originMessages ?? [])] : []),
          `❯ ${t.instruction ?? clip(t.prompt, 2000)}`,
          ...(activity.length ? ["", "Activity:", ...activity.map((a) => `- ${a}`)] : []),
          "", clip(t.response || "(no output)", 12_000),
          ...(t.check ? ["", `Orca's check \`${t.check.command}\` ${t.check.ok ? "passed" : `FAILED (exit ${t.check.exitCode}):\n${clip(t.check.output, 2000)}`}`] : []),
        ].join("\n");
      }
      const id = Number(args.chat);
      if (!id) throw new Error("read needs --chat <id> (from `orca chats`) or --run <runId>");
      const turns = await db.conversationTurns(id);
      await linkOrigins(turns);
      return turns.map((t) => `run ${t.id} — ${turnStatus(t)} (${when(t.startedAt)})\n${t.origin ? `${originQuote(t.origin, t.originMessages ?? [])}\n` : ""}❯ ${clip(t.instruction ?? "", 500)}\n→ ${clip(answer(t), 1200)}`).join("\n\n") || `No conversation #${id}.`;
    }
    case "merge": return mergeVerb(cfg, args);
    case "status": {
      // Enrichment is in the shared database, so any instance can write it — no forwarding.
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      // `--clear-grant`: back to the repo's own permission mode (grantRefusal keeps it to your chat).
      if ("clear-grant" in args) {
        await db.patchEnrichment(repo.name, branch, { grantScope: null });
        return `Cleared the outside grant of ${repo.name}/${branch}: its next run uses the repo's permission mode.`;
      }
      if ("verified" in args || "unverified" in args) return verifiedVerb(repo, branch, "verified" in args);
      const prev = (await db.enrichment(repo.name))[branch]?.orchStatus as OrchStatus | undefined;
      const next = orchStatusUpdate(prev, args, new Date().toISOString());
      if (next === undefined) return orchStatusText(prev) || `(no status for ${repo.name}/${branch})`;
      await db.patchEnrichment(repo.name, branch, { orchStatus: next });
      return next ? `Status of ${repo.name}/${branch}: ${orchStatusText(next)}` : `Cleared the status of ${repo.name}/${branch}.`;
    }
    case "repo": {
      const [sub, target] = words;
      if (sub === "list") {
        const user = typeof args.user === "string" && args.user ? args.user : undefined;
        const have = await Promise.all(cfg.repos.map((r) => git.remoteNameWithOwner(r.repoPath).catch(() => "")));
        return repos.listText(cfg, await repos.list(cfg, user), have.filter(Boolean));
      }
      if (sub === "add") {
        if (!target) throw new Error("orca repo add <owner/name> [--on <instance>] [--name <slug>]");
        const on = typeof args.on === "string" && args.on ? args.on : db.instanceName();
        const name = typeof args.name === "string" && args.name ? args.name : undefined;
        const repo = on !== db.instanceName()
          ? (await viaInstance(cfg, on, "/api/repos/add", { nameWithOwner: target, name })) as unknown as RepoConfig
          : await repos.add(cfg, target, { name });
        return `Added ${target} to Orca as "${repo.name}" on ${on}: ${repo.repoPath}, base ${repo.baseBranch}${repo.githubUser ? `, gh account ${repo.githubUser}` : ""}. No previews or check command yet — the user sets those in Settings. It is on the board now; spawn on it with --repo ${repo.name}.`;
      }
      throw new Error("orca repo list [--user <login>] | orca repo add <owner/name> [--on <instance>] [--name <slug>]");
    }
    case "handoff": return handoffVerb(cfg, words, args);
    // `orca cloudflare …` (server/cloudflare.ts): reads, and the writes behind --confirm. The grant
    // check above keeps the writes to the user's own chat; the write log names who woke it.
    // `--account` picks one Cloudflare connection, and its access is checked (policy.useAccount). The
    // token is the connection's secret_ref (a variable, or a stored secret that useAccount loaded).
    // Its config names the Cloudflare accounts it covers (none = every account the token can see);
    // `--cf-account` picks one of them inside the connection (server/cloudflare.ts Scope).
    // Each confirmed write is recorded, so the account watcher leaves Orca's own change out.
    case "cloudflare": {
      const by = wakeGrant ? `outside sender (${wakeGrant.level} grant)` : "orchestrator (your chat)";
      if (!words.length || words[0] === "help") return cloudflareTool(args, { by });
      const c = await policy.useAccount("cloudflare", cloudflareVerb(words), args.account);
      return cloudflareTool(args, { by, env: policy.accountEnv(c, CLOUDFLARE_TOKEN_ENV), accounts: configAccountIds(c?.config), onWrite: recordCloudflareWrite });
    }
    // `orca slack …` (server/slackTool.ts): read, search and post as the user. The grant check above
    // keeps it to the user's own chat (an unknown verb is the owner's); the post log names who.
    // `--account` picks one Slack account, and its access is checked (policy.useAccount).
    case "slack": {
      const by = wakeGrant ? `outside sender (${wakeGrant.level} grant)` : "orchestrator (your chat)";
      const sub = String(words[0] ?? "");
      if (!sub || sub === "help") return slackTool(args, { by });
      const c = await policy.useAccount("slack", sub, args.account);
      return slackTool(args, { by, env: policy.accountEnv(c, "SLACK_TOKEN") });
    }
    // `orca gmail search|read` (server/gmailTool.ts): both READ verbs (GMAIL_VERBS); `--account` picks
    // the account through the access policy (policy.useAccount), your own chat only (the grant check).
    case "gmail": return gmailTool(args);
    // `orca granola search|read` (server/granolaTool.ts): both READ verbs (GRANOLA_VERBS), as gmail.
    case "granola": return granolaTool(args);
    case "notes": {
      // After the move into memory the notes are read-only: printed, never set (server/memory.ts migrateNotes).
      if (words[0] !== "set") return b.notesMigratedAt
        ? `(read-only: moved into memory on ${new Date(b.notesMigratedAt).toISOString().slice(0, 10)}; use orca memory)\n${b.notes || "(empty)"}`
        : b.notes || "(empty)";
      if (b.notesMigratedAt) throw new Error("your notes moved into memory and are read-only now. Use orca memory write (or revise) instead.");
      const text = words.slice(1).join(" ").trim();
      if (text.length > NOTES_MAX) throw new Error(`notes are limited to ${NOTES_MAX} characters (got ${text.length}); condense them`);
      await patch(ag, { notes: text });
      return "Notes saved.";
    }
    case "wake": return scheduledWake.wakeTool(ag.name, words, args, b.handling?.runId, Date.now(), (await agents.all()).map((a) => a.name), ag.def.tools.verbs === "all");
    case "memory": {
      if (words[0] === "reflect") return requestReflection(ag, b);
      return memory.memoryTool(ag.name, words, args, () => memoryActor(ag.name, b));
    }
    case "ask": return askVerb(cfg, ag, b, words, args);
    case "agent": return agentVerb(cfg, ag, words, args);
    default: throw new Error(`unknown command "${verb}". Commands: board, machine, spawn, send [--replace], queue [cancel <id>], address, archive, stop [--drop-queue], sweep [--confirm], merge --when-green, preview [--status | --push-to-template [--confirm]], status, chats, read, notes, memory, wake, ask, agent, handoff, cloudflare, slack, gmail, granola`);
  }
}

const HANDOFF_USAGE = "orca handoff create --to <server> --title <title> [--message <text>] [--file <path|attachment id>]… [--chat <chat id>]…  |  orca handoff list";
const many = (v: unknown): string[] => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map(String).filter((x) => x.trim()));

/** `orca handoff`: a pack of context for another Orca server (server/handoff.ts). It only PREPARES:
 *  the user sends it from the Handoffs page with a click; nothing here sends anything. */
/** Who writes a memory from this wake, and with what trust (shared/memory.ts `provenance`): read off
 *  the wake in flight — its grant, the messages it handles, the tool calls it made so far, and the
 *  workstreams an outside sender steered. The server decides it; the agent cannot claim trust. */
async function memoryActor(name: string, b: Blob): Promise<memory.Actor & { kind: "agent" }> {
  const runId = b.handling?.runId;
  const messages = b.handling?.messages ?? [];
  const steps = runId ? await agent.runSteps(runId).catch(() => []) : [];
  const scoped = new Set<string>();
  for (const m of messages) {
    const ws = reportWorkstream(m);
    if (ws && ((await db.enrichment(ws.repo))[ws.branch] ?? {}).grantScope) scoped.add(`${ws.repo}::${ws.branch}`);
  }
  const prov = provenance({
    agent: name, runId, grantLevel: b.wakeGrant?.level, messages, scopedWorkstreams: scoped,
    steps: steps.filter((s) => s.kind === "tool").map((s) => ({ name: s.name, command: typeof (s.input as { command?: unknown } | undefined)?.command === "string" ? (s.input as { command: string }).command : undefined })),
  });
  return { kind: "agent", agent: name, runId, prov, ...(b.wakeMode === "reflect" ? { maxPerWake: REFLECTION.maxChanges } : {}) };
}

/** `orca memory reflect`: ask for a pass. It starts when the agent is idle, at most one an hour. */
async function requestReflection(ag: AgentRef, b: Blob, now = Date.now()): Promise<string> {
  const last = (await memory.lastPass(ag.name))?.at;
  if (last !== undefined && now - last < REFLECTION.minGapMs) {
    return `Not now: the last reflection pass ended ${Math.round((now - last) / 60_000)} minutes ago, and passes are at least an hour apart.`;
  }
  await patch(ag, { reflectRequested: now });
  return "Asked. Orca starts a reflection pass when you are idle (after this wake, with no worker running), within a minute.";
}

/** The minute tick (index.ts): start a reflection pass in idle time (shared/memory.ts
 *  reflectionTrigger): no wake running, nothing queued, no worker of it running, not paused; then on
 *  request, when the core is over budget, or 6 hours after the last pass with something new to read.
 *  Only where the orchestrator lives, only on the primary. Returns the run id, if it started one. */
export async function maybeReflect(cfg: OrcaConfig, now = Date.now(), name?: string): Promise<string | undefined> {
  if (!primary.held()) return undefined;
  if (cfg.orchestratorOn && cfg.orchestratorOn !== db.instanceName()) return undefined;
  const ag = await agentRef(name, cfg);
  return serial(ag, async () => {
    const b = await blob(ag);
    const idle = !agent.isRunning(ag.dir);
    if (!idle) return undefined;
    const queued = (await db.queuedMessages(ORCHESTRATOR_REPO, ag.branch)).length;
    if (queued) return undefined;
    const last = await memory.lastPass(ag.name);
    const [workers, activity, core] = await Promise.all([workersRunning(cfg), memory.activitySince(ag.name, last?.at ?? 0), memory.core(ag.name, now)]);
    const trigger = reflectionTrigger({
      idle, queued, workersRunning: workers, paused: (b.wakes ?? 0) >= MAX_WAKES, lastAt: last?.at,
      requested: Boolean(b.reflectRequested), coreOver: core.leftOut > 0, activity,
    }, now);
    if (!trigger) return undefined;
    return reflect(cfg, ag, b, trigger, last, now);
  });
}

/** Launch a reflection pass: a run of the same session with the reflection prompt, logged in
 *  `reflection_pass` with what it read. It does not count as a wake for MAX_WAKES, nor reset the
 *  count; its reply is its summary. It writes memory only. */
async function reflect(cfg: OrcaConfig, ag: AgentRef, b: Blob, trigger: ReflectionTrigger, last: Awaited<ReturnType<typeof memory.lastPass>>, now: number): Promise<string> {
  const input = await memory.reflectionInput(ag.name, { trigger, ...(last ? { since: last.at } : {}), ...(last?.summary ? { lastSummary: last.summary } : {}) }, now);
  const prompt = reflectionPrompt(input, WRITING_STYLE);
  const read = { ...reflectionReadCounts(input), tokens: tokensOf(prompt) };
  const next = continuation({
    provider: "claude", from: b.sessionId ? "claude" : undefined, sessionId: b.sessionId, contextPct: b.contextPct,
    transcript: await db.turns(ORCHESTRATOR_REPO, ag.branch),
  });
  await patch(ag, { wakeMode: "reflect", wakeGrant: null, wakeReplyTo: null, wakeFromUser: null, reflectRequested: null });
  try {
    const receipt = await agent.launch(ag.dir, ag.dir, prompt, {
      ...next, provider: "claude", repo: ORCHESTRATOR_REPO, branch: ag.branch,
      instruction: `${REFLECTION_MARKER} ${trigger}: ${read.turns} turns, ${read.reports} worker reports, ${read.checks} checks, ${read.corrections} corrections, ${read.contradictions} possible contradictions`,
      action: "reflect", queue: false, source: "agents",
      model: modelOf(cfg, b, ag), maxBudgetUsd: budgetOf(cfg), ...runLimits(cfg),
      // No shell: the `orca` command (checked server-side against REFLECT_VERBS) and reading.
      permissionMode: "ask" as const, allowedTools: ["Bash(orca *)", "Read", "Grep", "Glob"],
      env: { ORCA_URL: `http://127.0.0.1:${API_PORT}`, PATH: `${primary.mainBin()}:${process.env.PATH ?? ""}`, ORCA_AGENT: ag.name },
    });
    await patch(ag, { sessionId: receipt.sessionId, handling: { runId: receipt.runId, instance: db.instanceName(), messages: [] } });
    await memory.startPass({ agent: ag.name, runId: receipt.runId, trigger, ...(last ? { since: last.at } : {}), read, startedAt: now });
    return receipt.runId;
  } catch (e) {
    await patch(ag, { wakeMode: null }).catch(() => {});
    throw e;
  }
}

/** `orca ask <agent> "<message>" [--memory <id>]…` (§3.3, §7.5): queue a message on another agent's
 *  queue, tagged `[from <caller>]`. It is not the user's input (no wake-count reset). An outside
 *  sender's grant rides the hop, so the other agent's wake keeps the sender's limits. The reply does
 *  not come back by itself: `orca wake --on agent:<name>` waits for it. */
async function askVerb(cfg: OrcaConfig, from: AgentRef, b: Blob, words: string[], args: ToolArgs): Promise<string> {
  const [to = "", ...rest] = words;
  const text = rest.join(" ").trim();
  if (!to || !text) throw new Error('usage: orca ask <agent> "<message>" [--memory <id>]…  (orca agent list names the agents)');
  if (to === from.name) throw new Error("orca ask sends to another agent, not to yourself");
  const target = await agentRef(to);
  const memories = many(args.memory).map((m) => `m${m.replace(/^m/, "")}`);
  const body = memories.length ? `${text}\nMemories: ${memories.join(", ")} (orca memory show <id>)` : text;
  const grant = b.wakeGrant ?? undefined;
  const { status } = await message(cfg, agentMessage(from.name, body), [], {
    agent: target.name, person: false, ...(grant ? { grant } : {}), ...(b.wakeReplyTo ? { replyTo: b.wakeReplyTo } : {}),
  });
  return `Asked the ${target.def.displayName} (${status === "queued" ? "queued behind its wake in flight" : "it is awake now"}). Its reply stays in its chat. To hear back, set: orca wake --on agent:${target.name} --note "<what to check>"`;
}

/** `orca agent list | state <state> [--note …] | add <name> --display "…" --role @file [--model m]`. */
async function agentVerb(cfg: OrcaConfig, ag: AgentRef, words: string[], args: ToolArgs): Promise<string> {
  const [sub = "list", state] = words;
  if (sub === "list") {
    const all = await statuses(cfg);
    const defs = new Map((await agents.all()).map((d) => [d.name, d]));
    return agentListText(all.map((s) => ({ def: defs.get(s.agent)!, state: s.state, ...(s.stateNote ? { note: s.stateNote } : {}), queued: s.queued })));
  }
  if (sub === "state") {
    if (!state || !(SET_STATES as readonly string[]).includes(state)) throw new Error(`usage: orca agent state <${SET_STATES.join("|")}> [--note "<…>"]`);
    await agents.setState(ag.name, state as AgentStateName, typeof args.note === "string" ? args.note : undefined);
    return `State: ${state}${typeof args.note === "string" && args.note.trim() && state !== "idle" ? ` (${args.note.trim().slice(0, 200)})` : ""}. A message from the user clears waiting and blocked.`;
  }
  if (sub === "add") {
    const name = words[1] ?? "";
    const role = typeof args.role === "string" ? args.role : "";
    const def = await agents.add({ name, displayName: typeof args.display === "string" ? args.display : "", role, ...(typeof args.model === "string" ? { model: args.model } : {}) });
    return `Added the agent ${def.name} (${def.displayName}): a shell and every verb, like every agent. The user narrows it in Settings > Agents. Its tab is in the side panel.`;
  }
  throw new Error('usage: orca agent list | orca agent state <state> [--note "<…>"] | orca agent add <name> --display "<name>" --role "<role text>" [--model <id>]. Edit and archive an agent in Settings > Agents.');
}

async function handoffVerb(cfg: OrcaConfig, words: string[], args: ToolArgs): Promise<string> {
  const sub = words[0];
  if (sub === "list") {
    const packs = await handoff.list();
    return packs.filter((p) => p.direction === "out").map((p) => `${p.id.slice(0, 8)} → ${p.target} "${p.title}" — ${p.files.length} file${p.files.length === 1 ? "" : "s"}, ${p.sentAt ? `sent ${when(p.sentAt)}` : p.problems.length ? `BLOCKED: ${p.problems[0]}` : "ready, waiting for the user's click"}`).join("\n") || "(no handoff packs)";
  }
  if (sub !== "create") throw new Error(HANDOFF_USAGE);
  const chats = many(args.chat).map((c) => Number(c.replace(/^#/, "")));
  if (chats.some((c) => !(c > 0))) throw new Error("--chat takes a chat id from `orca chats` (a number)");
  const { pack, problems } = await handoff.createPack({
    to: typeof args.to === "string" ? args.to : "", title: typeof args.title === "string" ? args.title : "",
    message: typeof args.message === "string" ? args.message : words.slice(1).join(" "),
    files: many(args.file), chats, cwd: typeof args._cwd === "string" ? args._cwd : undefined,
    source: (await selfServer(cfg.serverSwitcher ?? {})).name,
  }).catch((e) => { throw new Error(e instanceof Error ? e.message : String(e)); });
  const files = pack.files.map((f) => `  - ${f.name} (${f.kind}, ${f.size} bytes)`);
  return [
    `Pack ${pack.id.slice(0, 8)} "${pack.title}" for ${pack.target}: ${pack.files.length} file${pack.files.length === 1 ? "" : "s"}.`,
    ...files,
    // The chat links this turn to the pack by this line (workstream.ts handoffRefs): keep it verbatim.
    `Pack id: ${handoffRef(pack.id)}`,
    problems.length
      ? `Send is BLOCKED until this is fixed (make a new pack): ${problems.join("; ")}`
      : "It is NOT sent. The user sees it under your reply in the chat, and on the Handoffs page; only their click on Send sends it.",
  ].join("\n");
}

/** `orca merge --repo r (--pr N | --branch b) --when-green [--small]` (or `--cancel`): the merge
 *  queue, never a direct merge — Orca merges on green under the repo's mergePolicy. Runs where the
 *  repo is checked out (its `runsOn` when that is not here). */
async function mergeVerb(cfg: OrcaConfig, args: ToolArgs): Promise<string> {
  const repo = repoNamed(cfg, args.repo);
  const pr = args.pr === undefined ? undefined : Number(args.pr);
  if (pr !== undefined && !(pr > 0)) throw new Error("--pr must be a PR number");
  const branch = typeof args.branch === "string" && args.branch.trim() ? args.branch.trim() : undefined;
  if (!pr && !branch) throw new Error("merge needs --pr <number> or --branch <branch>");
  const cancel = "cancel" in args;
  if (!cancel && !("when-green" in args)) throw new Error("orca merge only queues: add --when-green (Orca squash-merges once checks pass and it merges clean), or --cancel");
  const body = { repo: repo.name, pr, branch, small: "small" in args, by: "orchestrator", cancel };
  if (!verbs.repoHere(repo) && repo.runsOn && repo.runsOn !== db.instanceName()) {
    return String((await viaInstance(cfg, repo.runsOn, "/api/prs/merge-when-green", body)).text ?? "");
  }
  return mergeWhenGreen(cfg, repo, body);
}

/** The body of `orca merge` and of the PR menu's route (index.ts). */
/** `orca status --verified | --unverified`: the user's hand-set Verified marker, on the user's word
 *  ("verified #267"). Only enrichment: it merges nothing and posts nothing to GitHub. The mark
 *  names the PR's head now, so a later push reads as "changed since you verified". */
async function verifiedVerb(repo: RepoConfig, branch: string, on: boolean): Promise<string> {
  if (!on) {
    await db.patchEnrichment(repo.name, branch, { verified: null });
    return `Cleared the Verified marker of ${repo.name}/${branch}.`;
  }
  const pr = verbs.repoHere(repo) ? (await gh.listPrs(repo.repoPath)).find((p) => p.branch === branch) : undefined;
  if (verbs.repoHere(repo) && !pr) throw new Error(`${repo.name}/${branch} has no open PR to mark verified`);
  await db.patchEnrichment(repo.name, branch, { verified: verifiedMark("orchestrator", pr?.head, pr?.number, new Date().toISOString()) });
  return pr
    ? `Marked PR #${pr.number} (${repo.name}/${branch}) verified at ${pr.head?.slice(0, 7) ?? "its current head"}. A new commit shows it as changed since verified.`
    : `Marked ${repo.name}/${branch} verified. The repo is not on this instance, so the head commit is not recorded: a later push is not detected.`;
}

export async function mergeWhenGreen(cfg: OrcaConfig, repo: RepoConfig, body: { pr?: number; branch?: string; small?: boolean; by?: string; cancel?: boolean }): Promise<string> {
  const by = body.by === "orchestrator" ? "orchestrator" as const : "user" as const;
  if (body.cancel) {
    const branch = body.branch ?? (body.pr ? (await gh.prMergeGate(repo.repoPath, body.pr)).branch : undefined);
    if (!branch) throw new Error("cancel needs --pr or --branch");
    await mergeQueue.cancel(repo, branch);
    return `Unmarked ${repo.name}/${branch}: it is no longer merged on green.`;
  }
  return mergeQueue.request(cfg, repo, { pr: body.pr, branch: body.branch }, { small: body.small, by });
}
