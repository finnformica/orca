// Launches Claude, Codex, or Cursor headlessly and tracks status + provider-native
// session id, so the UI can show done/error and "Copy CLI" can resume the exact conversation.
// Keyed by an arbitrary string: worktree path for
// feature/fix runs, `slack:…` for repo-level. The subprocess handle is kept so we can kill it.
import { retryTitle } from "./title";
import { autofixInstruction, handoffPrompt, isAutofix, parseAgentOutcome, type AgentOutcome, type AgentProvider, type AgentStep, type AgentTurn, type StopReason, type TurnCheck, type TurnSource } from "../shared/agent";
import { runCheck } from "./check";
import { run, runCmd } from "./run";
import { agentEnv, githubEnv } from "./env";
import * as procs from "./proc";
import * as lease from "./lease";
import * as ledger from "./ledger";
import * as db from "./db";
import * as primary from "./primary";
import * as transcript from "./transcript";
import * as outbox from "./outbox";
import * as bus from "./bus";
import { resolvePrompt } from "./attachments";
import * as cgroup from "./cgroup";
import { noteOomKill } from "./health";
import { existsSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { stateDir } from "./state";
import { mcpArgs, mcpLockdown, type McpAllow } from "./mcp";
type McpLockdown = ReturnType<typeof mcpLockdown>;

/** Persist a turn, but never let the history write break the run that produced it. Repo-level runs
 *  (Slack, keyed `slack:…`) carry no branch and so belong to no workstream — they're skipped.
 *
 *  Fire-and-forget on purpose: the database is async (Postgres) but `launch()` returns its receipt
 *  synchronously, and a history write must never be something the run waits on. The write is still
 *  ordered per run, because `startTurn` is awaited inside the same chain the exit handler joins.
 *
 *  Every write goes through the outbox (server/outbox.ts): with the database unreachable the turn is
 *  journaled to the state dir and replayed when it is back, so a run never depends on Postgres. */
function recordTurn(options: LaunchOptions, write: () => Promise<unknown>): Promise<void> {
  if (!options.repo || !options.branch) return Promise.resolve();
  const pending = write().then(() => {}).catch((e) => console.error("orca: chat history write failed", e));
  historyWrites.add(pending);
  void pending.finally(() => historyWrites.delete(pending));
  return pending;
}

// In-flight history writes. Fire-and-forget is right for the RUN (it must never wait on the DB), but
// shutdown and tests need a point at which they are known to have landed — otherwise the pool closes
// underneath a write and the turn is lost for the very reason the DB exists.
const historyWrites = new Set<Promise<unknown>>();

/** Wait for every outstanding history write. Call before closing the pool (shutdown, teardown). */
// A finished run is marked done (runs.set) BEFORE its after-run path — the queued send and the
// onRunFinished hook (the orchestrator's wake / death handling, which may rewrite the turn) — has
// run. Track that window, so a caller can tell "finished" from "finished and fully handled".
const afterRuns = new Set<Promise<void>>();
function afterRunStarted(): () => void {
  let done!: () => void;
  const p = new Promise<void>((r) => { done = r; });
  afterRuns.add(p);
  void p.finally(() => afterRuns.delete(p));
  return done;
}

/** Resolves once every finished run's after-run path (queued send + onRunFinished hook) is done. */
export async function afterRunsSettled(): Promise<void> {
  while (afterRuns.size) await Promise.all([...afterRuns]);
}

export async function flushHistory(): Promise<void> {
  while (historyWrites.size) await Promise.all([...historyWrites]);
}

// Per-run metadata pulled from the `claude -p` JSON: which model ran, how full its context got, its
// cost, turns, and wall-clock. Surfaced on the card so a session shows what ran. (contextPct is the
// FINAL turn's prompt over the model's window — NOT the top-level `usage`, which sums every turn and
// so overshoots 100%.)
export type RunMeta = {
  model?: string; // friendly, e.g. "Opus 4.8"
  contextPct?: number; // % of the model's context window the last turn's prompt filled
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** The tool calls the CLI refused (its `permission_denials`), as `Tool: target` lines — what a
   *  scoped run (`permissionMode: "scoped"`) was not allowed to do. */
  permissionDenials?: string[];
};
export type RunState = {
  status: "idle" | "running" | "done" | "error";
  error?: string;
  provider?: AgentProvider;
  runId?: string;
  prompt?: string;
  sessionId?: string;
  result?: string;
  structured?: AgentOutcome;
  meta?: RunMeta;
  check?: TurnCheck; // Orca's verification of this run's commit, once it has run
  startedAt?: number;
  finishedAt?: number;
};
type Run = RunState & { proc?: Bun.Subprocess; options?: LaunchOptions };
export type LaunchReceipt = { status: "running"; provider: AgentProvider; runId: string; sessionId?: string };

export type LaunchOptions = {
  provider?: AgentProvider;
  resume?: string;
  history?: AgentTurn[];
  handoffFrom?: AgentProvider;
  timeoutMs?: number;
  repo?: string; // with `branch`, identifies the workstream this run's turn is recorded against
  branch?: string; // recorded on the lease so restart recovery can match by branch
  model?: string; // the CLI's --model; unset means its own default
  /** The repo's `agentPermissionMode` (`ask`, the default, is NOT bypass), or `scoped` for a
   *  workstream an outside sender's "work" grant started or steered (`scopedRules`). */
  permissionMode?: PermissionMode;
  /** `scoped` only: what the rules need from the repo. */
  scope?: { baseBranch?: string; checkCommand?: string };
  action?: string; // ledger label: launch | followup | conflict | ci | review | rerun | agent
  evidenceChars?: number; // size of CI/review evidence sent with this run (ledger)
  instruction?: string; // what the user typed (or the action's label) — recorded on the turn, shown in the chat
  source?: TurnSource; // the orchestrator's turns: who it answers (you, or worker reports) — the chat's two channels
  maxBudgetUsd?: number; // claude only: the repo's per-run cost cap (`--max-budget-usd`)
  /** The repo's `checkCommand`, run in the worktree after a run that committed (server/check.ts).
   *  `autofix`: queue a follow-up with the failure as evidence — once; a fix attempt that fails
   *  again stops there (isAutofix). */
  check?: { command: string; autofix: boolean };
  /** claude only: `--allowedTools`, for a run that must act without `bypassPermissions` (the
   *  orchestrator, which may run the `orca` command and nothing else). */
  allowedTools?: string[];
  /** claude only: the project MCP servers this run may start (server/mcp.ts). Unset: none. A
   *  browser server never starts. */
  mcpAllow?: McpAllow;
  /** Extra environment for the process, over agentEnv(). */
  env?: Record<string, string>;
  /** `false`: this run's queue is drained by whoever launched it, not by the exit handler (the
   *  orchestrator batches every pending wake into one run). */
  queue?: false;
  /** The repo's `agentMemoryMaxGb` (server/cgroup.ts); unset means the default (4GB). Every launch
   *  is capped — there is no "uncapped" option, only a bigger number. */
  memoryMaxGb?: number;
  /** The app's `agentCpuWeight`; unset means the default (50, systemd's own neutral weight). */
  cpuWeight?: number;
};

/** What a finished run looked like — handed to the onRunFinished hook. */
export type RunFinished = {
  key: string; cwd: string; runId: string; options: LaunchOptions;
  status: db.TurnStatus; sessionId?: string; result?: string; structured?: AgentOutcome;
  check?: TurnCheck; meta?: RunMeta;
  /** How the process ended, uncollapsed: the orchestrator turns this into the reason a wake died. */
  exit: { code: number; timedOut: boolean; budgetReached: boolean; stderr: string };
  /** A queued follow-up (an autofix, a typed instruction) launched straight after: not idle yet. */
  continued: boolean;
};

// Orca's own secrets never reach the agent's process (server/env.ts); re-exported for callers.
export { agentEnv, WORKER_BIN } from "./env";

/** How this run reuses prior context — derived from what the launch options carry, so the ledger's
 *  resume/reset/handoff breakdown matches the store's actual continuation decision. Pure. */
export function runMode(options: LaunchOptions): ledger.RunMode {
  if (options.resume) return "resume";
  if (options.handoffFrom) return options.handoffFrom === (options.provider ?? "claude") ? "reset" : "handoff";
  if (options.history?.length) return "handoff";
  return "fresh";
}

import { prettyModel } from "../shared/models";
export { prettyModel };

/** Pull model + context/cost/turn metadata out of a `claude -p --output-format json` object. Pure. */
export function parseRunMeta(j: any, compactedTokens?: number): RunMeta {
  const mu = (j?.modelUsage && typeof j.modelUsage === "object") ? j.modelUsage as Record<string, any> : {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  // A single `claude -p` run reports usage for EVERY model it touched: Claude Code fires an
  // auxiliary Haiku alongside the main model, and Haiku is usually listed FIRST. Pick the PRIMARY
  // model — the one that generated the most output — not modelUsage's first key. Otherwise an Opus
  // run gets mislabelled "Haiku" AND its last-turn prompt is divided by Haiku's 200k window instead
  // of Opus's, pushing contextPct past 100%.
  const modelId = Object.keys(mu).sort((a, b) => (num(mu[b]?.outputTokens) ?? 0) - (num(mu[a]?.outputTokens) ?? 0))[0];
  // Context occupancy = the LAST turn's prompt (read side: fresh input + cache read + cache
  // creation), NOT the top-level `usage` (which sums every turn and would overshoot the window).
  const iters = Array.isArray(j?.usage?.iterations) ? j.usage.iterations : [];
  const lastTurn = iters.length ? iters[iters.length - 1] : j?.usage;
  // A `/compact` run makes no model turn; what is left in context is the CLI's post-compaction count.
  const ctxTokens = compactedTokens ?? (lastTurn
    ? (num(lastTurn.input_tokens) ?? 0) + (num(lastTurn.cache_read_input_tokens) ?? 0) + (num(lastTurn.cache_creation_input_tokens) ?? 0)
    : 0);
  const window = modelId ? num(mu[modelId]?.contextWindow) : undefined;
  return {
    model: modelId ? prettyModel(modelId) : undefined,
    contextPct: window && window > 0 && ctxTokens > 0 ? Math.round((ctxTokens / window) * 100) : undefined,
    costUsd: num(j?.total_cost_usd),
    numTurns: num(j?.num_turns),
    durationMs: num(j?.duration_ms),
    inputTokens: num(j?.usage?.input_tokens),
    outputTokens: num(j?.usage?.output_tokens),
    cacheReadTokens: num(j?.usage?.cache_read_input_tokens),
    cacheCreationTokens: num(j?.usage?.cache_creation_input_tokens),
    ...(denials(j).length ? { permissionDenials: denials(j) } : {}),
  };
}

/** The result event's `permission_denials` as `Tool: target` lines (the command, else the path).
 *  Pure. */
export function denials(j: any): string[] {
  const list = Array.isArray(j?.permission_denials) ? j.permission_denials : [];
  return list.map((d: any) => {
    const i = d?.tool_input ?? {};
    const target = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url;
    return `${String(d?.tool_name ?? "?")}: ${typeof target === "string" ? target.slice(0, 200) : JSON.stringify(i).slice(0, 200)}`;
  });
}

export type PermissionMode = "bypass" | "ask" | "scoped";
export type ScopedRules = { allow: string[]; deny: string[]; addDirs: string[] };

/** The tool rules of a scoped run: `claude -p --permission-mode dontAsk`, which denies every call
 *  that would prompt (there is nobody to approve), plus these allow and deny rules. Deny wins over
 *  allow. Not `bypassPermissions`: it approves everything, so an allow list under it restricts
 *  nothing. The guard against Discord text (untrusted) is this list, not an approval prompt.
 *  - Files: Read, Edit, Write in the worktree only (and reads of this instance's attachments);
 *    `blockReadsOutsideWorkingDirectories` refuses every other path, other repos included.
 *  - Bash: git, the toolchain, the repo's check command and orca-shot. No --no-verify, no
 *    `git -c` / `git config` (a hooks path), no push to the base branch.
 *  - Secrets: explicit Read and Edit denies, which also cover `cat` / redirects in Bash.
 *  A Bash rule matches the command text, not the program: `node -e` can still open a file. The
 *  agent's environment holds no secret (agentEnv); the OS sandbox is the next step. Pure. */
export function scopedRules(cwd: string, o: { baseBranch?: string; checkCommand?: string; home?: string; stateDir?: string; orcaRoots?: string[] } = {}): ScopedRules {
  const abs = (p: string) => `/${resolve(p)}`; // `//path` is absolute in a rule; a lone `/` is relative
  const wt = abs(cwd);
  const home = o.home ?? homedir();
  const state = o.stateDir ?? join(home, ".orca");
  const base = o.baseBranch ?? "main";
  const tool = ["git", "bun", "bunx", "pnpm", "npm", "npx", "node", "orca-shot"];
  const check = o.checkCommand?.trim() && !o.checkCommand.includes(",") ? [`Bash(${o.checkCommand.trim()})`, `Bash(${o.checkCommand.trim()} *)`] : [];
  const secrets = [
    ...(o.orcaRoots ?? []).map((r) => `${abs(r)}/.env`), "//opt/orca/.env",
    "~/.ssh/**", "~/.config/gh/**", "~/.hydra/**", "~/.claude/**", "~/.claude.json", "~/.aws/**", "~/.netrc", "~/.git-credentials",
    `${abs(state)}/secrets/**`, `${abs(state)}/outbox/**`, `${abs(state)}/config.cache.json`,
  ];
  return {
    allow: [`Read(${wt}/**)`, `Edit(${wt}/**)`, `Write(${wt}/**)`, "Glob", "Grep", ...tool.map((t) => `Bash(${t} *)`), ...check],
    deny: [
      "Bash(git *--no-verify*)",
      // Each git rule in both spellings: a model often writes `git -C <worktree> push …`, which a
      // `git push` rule does not match (seen in the headless check).
      ...["git", "git -C *"].flatMap((g) => [
        `Bash(${g} commit -n*)`, `Bash(${g} commit * -n)`, `Bash(${g} commit * -n *)`, `Bash(${g} -c *)`, `Bash(${g} config *)`,
        `Bash(${g} push * ${base})`, `Bash(${g} push * ${base} *)`, `Bash(${g} push *:${base})`, `Bash(${g} push *:${base} *)`,
        `Bash(${g} push *:refs/heads/${base}*)`, `Bash(${g} push * +${base}*)`,
      ]),
      ...[...new Set(secrets)].flatMap((p) => [`Read(${p})`, `Edit(${p})`]),
    ],
    addDirs: [join(state, "attachments")],
  };
}

/** The scoped rules for a run in `cwd`, from this host's paths. */
const scopedRulesHere = (cwd: string, scope: LaunchOptions["scope"]): ScopedRules =>
  scopedRules(cwd, { ...scope, stateDir: stateDir(), orcaRoots: [resolve(import.meta.dir, "..")] });

const runs = new Map<string, Run>();

// How long to let stdout/stderr drain after the process exits before finalizing the turn anyway.
// Generous for a normal exit (the pipe closes immediately), bounded for the pathological one.
const DRAIN_GRACE_MS = 2_000;

/** Does the exit parse (parseClaudeStreamOutput / parseCodexOutput / parseCursorOutput) need this
 *  stdout event? A run's stdout used to be kept WHOLE until exit — every reply delta and tool
 *  result, tens of MB for a long run — and the bridge grew by about that much per run (2026-10-18:
 *  3 GB plus 2.7 GB swap in 9 hours). The steps are already in the transcript; only the session id,
 *  the result and the compact markers are read at exit. Pure. */
export function keepForOutcome(provider: AgentProvider, event: unknown): boolean {
  const e = event as { type?: string; subtype?: string; compact_result?: unknown; item?: { type?: string } } | null;
  if (!e || typeof e !== "object") return false;
  if (provider === "codex") {
    return e.type === "thread.started" || e.type === "turn.completed" || e.type === "turn.failed" || e.type === "error"
      || (e.type === "item.completed" && e.item?.type === "agent_message");
  }
  if (e.type === "result") return true;
  if (provider === "cursor") return e.type === "system" && e.subtype === "init";
  return (e.type === "system" && (e.subtype === "init" || e.subtype === "compact_boundary")) || e.compact_result !== undefined;
}

/** How much of a run's non-JSON stdout (and its stderr) is kept: the newest part only. */
export const OUTPUT_TAIL_CHARS = 256 << 10;

/** The part of a run's stdout the exit parse reads: the events `keepForOutcome` names, then a bounded
 *  tail of the lines that were not JSON (a crash's message, an old single-body answer). */
export function outcomeLines(provider: AgentProvider) {
  let kept = "";
  let tail = "";
  return {
    add(line: string, event: unknown): void {
      if (event === undefined) tail = (tail + line + "\n").slice(-OUTPUT_TAIL_CHARS);
      else if (keepForOutcome(provider, event)) kept += line + "\n";
    },
    text: (pending = ""): string => kept + tail + pending.slice(-OUTPUT_TAIL_CHARS),
  };
}

/** A stream's newest `max` characters — stderr is read only for its tail. */
async function tailText(stream: ReadableStream<Uint8Array>, max = OUTPUT_TAIL_CHARS): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  for (let r = await reader.read(); !r.done; r = await reader.read()) tail = (tail + decoder.decode(r.value, { stream: true })).slice(-max);
  return tail + decoder.decode();
}

const parseLine = (line: string): unknown => { try { return JSON.parse(line); } catch { return undefined; } };

function codexSessionId(line: string): string | undefined {
  try {
    const event = JSON.parse(line);
    return event.type === "thread.started" && typeof event.thread_id === "string" ? event.thread_id : undefined;
  } catch {
    return undefined;
  }
}

/** Read Codex JSONL without waiting for the process to finish. Codex chooses its own thread UUID
 *  (there is no Claude-style `--session-id` flag), but emits it first. Publishing it into `runs`
 *  immediately lets the next `/api/agents` poll persist and copy the exact resumable thread id. */
async function readCodexOutput(key: string, proc: Bun.Subprocess<"ignore", "pipe", "pipe">, holder: { raw: string }, runId?: string, owner?: { repo?: string; branch?: string }): Promise<string> {
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const out = outcomeLines("codex");
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += value;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = parseLine(line);
      out.add(line, event);
      holder.raw = out.text();
      const sessionId = codexSessionId(line);
      const current = runs.get(key);
      if (sessionId && current?.proc === proc && current.sessionId !== sessionId) {
        runs.set(key, { ...current, sessionId });
      }
      if (!runId || event === undefined) continue;
      const written = await transcript.append(runId, codexSteps(event));
      if (written.length && owner?.repo && owner.branch) {
        bus.publish({ kind: "step", runId, repo: owner.repo, branch: owner.branch, steps: written });
      }
    }
  }
  return (holder.raw = out.text(pending));
}

/** Read Cursor's stream-json without waiting for exit, recording each step as it lands. Returns the
 *  part of the stream parseCursorOutput reads at exit (outcomeLines), never the whole of it. */
async function readCursorOutput(proc: Bun.Subprocess<"ignore", "pipe", "pipe">, holder: { raw: string }, runId?: string, owner?: { repo?: string; branch?: string }): Promise<string> {
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const state = { thinking: "" };
  const out = outcomeLines("cursor");
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += value;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = parseLine(line);
      out.add(line, event);
      holder.raw = out.text();
      if (!runId || event === undefined) continue;
      const written = await transcript.append(runId, cursorSteps(event, state));
      if (written.length && owner?.repo && owner.branch) {
        bus.publish({ kind: "step", runId, repo: owner.repo, branch: owner.branch, steps: written });
      }
    }
  }
  return (holder.raw = out.text(pending));
}

/** A run's recorded steps — the agent's thought process — oldest first, `tail` limiting to the last
 *  N. Read from the transcript file rather than memory, so it works for a FINISHED run and survives a
 *  bridge restart (that's the whole point: the chat's history used to die with the process). */
export function runSteps(runId: string, tail?: number): Promise<AgentStep[]> {
  return transcript.read(runId, tail);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The step(s) one claude stream-json event contributes. Assistant events carry the model's text,
 *  its thinking, and the tools it invokes; `user` events carry the tool RESULTS that come back.
 *  A call is stored as the content part it came in as — id, name, and the whole input — and a result
 *  with the id of the call it answers; what the chat shows for either is decided at render time.
 *  Everything else (init, result) adds no step. Pure, so a test pins the event→step mapping without
 *  a running CLI. */
export function claudeSteps(event: unknown): AgentStep[] {
  const e = event as { type?: string; message?: { content?: unknown } };
  if (!Array.isArray(e?.message?.content)) return [];
  const at = Date.now();
  const steps: AgentStep[] = [];
  for (const block of e.message.content as Array<Record<string, unknown>>) {
    if (e.type === "assistant" && block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      steps.push({ at, kind: "text", text: block.text.trim() });
    } else if (e.type === "assistant" && block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
      steps.push({ at, kind: "thinking", text: block.thinking.trim() });
    } else if (e.type === "assistant" && block?.type === "tool_use" && typeof block.name === "string") {
      steps.push({ at, kind: "tool", id: str(block.id), name: block.name, input: block.input });
    } else if (e.type === "user" && block?.type === "tool_result") {
      // Recorded even when empty: the result is what marks the call finished.
      steps.push({ at, kind: "result", id: str(block.tool_use_id), output: toolResultText(block.content), isError: block.is_error === true });
    }
  }
  return steps;
}

/** The step(s) one Codex `exec --json` event contributes. Codex reports work as items with a
 *  lifecycle: `item.started` announces a tool call, `item.completed` carries its result (and, for
 *  `agent_message`, the model's prose). Shapes taken from a real run rather than guessed —
 *  `command_execution` carries `command` / `aggregated_output` / `exit_code`.
 *
 *  Unknown item types still produce a step: a new Codex tool should show up as "Using <type>" rather
 *  than silently vanishing from the conversation. Pure. */
export function codexSteps(event: unknown): AgentStep[] {
  const e = event as { type?: string; item?: Record<string, unknown> };
  const item = e?.item;
  if (!item || typeof item !== "object") return [];
  const at = Date.now();
  const kind = typeof item.type === "string" ? item.type : "";

  if (kind === "agent_message") {
    const text = typeof item.text === "string" ? item.text.trim() : "";
    // Only on completion: the started event carries no text yet.
    return e.type === "item.completed" && text ? [{ at, kind: "text", text }] : [];
  }
  if (kind === "reasoning") {
    const text = typeof item.text === "string" ? item.text.trim() : "";
    return e.type === "item.completed" && text ? [{ at, kind: "thinking", text }] : [];
  }

  // The item IS the call's input (command, path, query, tool, changes…); its lifecycle fields aren't.
  const { id, type: _type, status: _status, aggregated_output, output: out, exit_code, ...input } = item;
  if (e.type === "item.started") return [{ at, kind: "tool", id: str(id), name: kind, input }];
  if (e.type !== "item.completed") return [];
  const output = typeof aggregated_output === "string" ? aggregated_output.trim() : typeof out === "string" ? out.trim() : "";
  const failed = typeof exit_code === "number" ? exit_code !== 0 : item.status === "failed";
  return [{ at, kind: "result", id: str(id), output: output || (failed ? `exited ${String(exit_code ?? item.status)}` : undefined), isError: failed }];
}

/** The step(s) one Cursor `stream-json` event contributes. Shapes taken from a real run:
 *  `assistant` carries the model's prose, `thinking` arrives as DELTAS with the text (and a
 *  `completed` event that carries none), and `tool_call` wraps a named tool object whose `args` and
 *  `result` shapes vary per tool — `shellToolCall` has command/stdout/exitCode.
 *
 *  Cursor is the one provider that exposes real reasoning text, so the deltas are accumulated in
 *  `state` and emitted as a single thinking step rather than a stutter of fragments. */
export function cursorSteps(event: unknown, state: { thinking: string }): AgentStep[] {
  const e = event as Record<string, any>;
  const at = Date.now();
  if (e?.type === "thinking") {
    if (e.subtype === "delta" && typeof e.text === "string") { state.thinking += e.text; return []; }
    if (e.subtype === "completed") {
      const text = state.thinking.trim();
      state.thinking = "";
      return text ? [{ at, kind: "thinking", text }] : [];
    }
    return [];
  }
  if (e?.type === "assistant" && Array.isArray(e.message?.content)) {
    const text = e.message.content
      .map((b: Record<string, unknown>) => (b?.type === "text" ? String(b.text ?? "") : ""))
      .join("").trim();
    return text ? [{ at, kind: "text", text }] : [];
  }
  if (e?.type !== "tool_call" || !e.tool_call || typeof e.tool_call !== "object") return [];
  // One wrapper key names the tool, e.g. { shellToolCall: { args, result } }.
  const [name, body] = Object.entries(e.tool_call as Record<string, any>)
    .find(([, v]) => v && typeof v === "object" && !Array.isArray(v)) ?? [];
  if (!name || !body) return [];
  const label = name.replace(/ToolCall$/, "");
  const id = str(e.call_id ?? e.tool_call_id ?? e.id);
  if (e.subtype === "started") return [{ at, kind: "tool", id, name: label, input: body.args ?? {} }];
  if (e.subtype !== "completed") return [];
  const success = (body.result ?? {}) as Record<string, any>;
  const ok = success.success ?? success;
  const output = [ok?.stdout, ok?.stderr, typeof ok === "string" ? ok : undefined]
    .filter((v) => typeof v === "string" && v.trim()).join("\n").trim();
  const failed = typeof ok?.exitCode === "number" ? ok.exitCode !== 0 : Boolean(success.error);
  return [{ at, kind: "result", id, output: output || (failed ? "failed" : undefined), isError: failed }];
}

/** A tool_result's content is either a plain string or an array of typed blocks. */
function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((b) => (b && typeof b === "object" && (b as Record<string, unknown>).type === "text" ? String((b as Record<string, unknown>).text ?? "") : ""))
    .filter(Boolean).join("\n").trim();
  return text || undefined;
}

/** The reply text one `--include-partial-messages` event adds, if any — a `text_delta` of the
 *  message being generated. Pure. */
export function claudeDelta(event: unknown): string | undefined {
  const e = event as { type?: string; event?: { type?: string; delta?: { type?: string; text?: unknown } } };
  if (e?.type !== "stream_event" || e.event?.type !== "content_block_delta" || e.event.delta?.type !== "text_delta") return undefined;
  return typeof e.event.delta.text === "string" && e.event.delta.text ? e.event.delta.text : undefined;
}

/** How often a run's streamed text is pushed: tokens arrive tens of times a second, and each push is
 *  an SSE frame to every tab (and relayed between instances). */
const DELTA_FLUSH_MS = 100;

/** Read claude's `--output-format stream-json` JSONL without waiting for exit, persisting each step
 *  to the run's transcript so `/api/turns` can show it live AND after the fact. Returns the part of
 *  the stream parseClaudeStreamOutput reads at exit (outcomeLines), never the whole of it. */
async function readClaudeStream(runId: string, proc: Bun.Subprocess<"ignore", "pipe", "pipe">, holder: { raw: string }, owner?: { repo?: string; branch?: string }): Promise<string> {
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const out = outcomeLines("claude");
  let pending = "";
  // Streamed reply text, coalesced and pushed live; never written anywhere (see claudeDelta).
  let delta = "";
  let flushAt: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    flushAt = undefined;
    if (delta && owner?.repo && owner.branch) bus.publish({ kind: "delta", runId, repo: owner.repo, branch: owner.branch, text: delta });
    delta = "";
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += value;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = parseLine(line);
      out.add(line, event);
      if (event === undefined || keepForOutcome("claude", event)) holder.raw = out.text();
      if (event === undefined) continue;
      const text = claudeDelta(event);
      if (text) {
        delta += text;
        flushAt ??= setTimeout(flush, DELTA_FLUSH_MS);
        continue;
      }
      // A whole message landed: what streamed before it goes first, so the step supersedes it.
      if (flushAt) { clearTimeout(flushAt); flush(); }
      const written = await transcript.append(runId, claudeSteps(event));
      // Push to any chat stream open on THIS instance — which is the only place a stream for this
      // run can be served, since a request for a repo owned elsewhere is proxied to its owner.
      if (written.length && owner?.repo && owner.branch) {
        bus.publish({ kind: "step", runId, repo: owner.repo, branch: owner.branch, steps: written });
      }
    }
  }
  if (flushAt) { clearTimeout(flushAt); flush(); }
  transcript.forget(runId);
  return (holder.raw = out.text(pending));
}

/** Extract claude's final outcome from the stream. The last `type:"result"` event is the same object
 *  the old `--output-format json` emitted (result text, is_error, usage/cost/modelUsage), so
 *  parseRunMeta is unchanged; a missing result event (crash) falls back to a bare parse. Pure. */
export function parseClaudeStreamOutput(raw: string): { sessionId?: string; result?: string; isError: boolean; meta?: RunMeta; subtype?: string } {
  let resultEvent: Record<string, unknown> | undefined;
  let sessionId: string | undefined;
  // A `/compact` run (the context ring's Compact button) makes no model turn: its result carries no
  // usage and is_error false even when compaction failed. The CLI reports it in its own events.
  let compactFailed = false;
  let compacted: { pre?: number; post?: number } | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Record<string, any>;
      if (typeof e.session_id === "string") sessionId = e.session_id;
      if (e.type === "result") resultEvent = e;
      if (e.compact_result === "failed") compactFailed = true;
      if (e.subtype === "compact_boundary") compacted = { pre: e.compact_metadata?.pre_tokens, post: e.compact_metadata?.post_tokens };
    } catch { /* tolerate non-JSON diagnostic lines */ }
  }
  if (!resultEvent) {
    try {
      const j = JSON.parse(raw.trim());
      return { sessionId, result: j.result, isError: Boolean(j.is_error), meta: parseRunMeta(j), subtype: typeof j.subtype === "string" ? j.subtype : undefined };
    } catch { return { sessionId, isError: false }; }
  }
  const done = compactFailed ? undefined : compacted;
  const meta = parseRunMeta(resultEvent, typeof done?.post === "number" ? done.post : undefined);
  let result = resultEvent.result as string | undefined;
  if (done && !result?.trim()) result = `Compacted${typeof done.pre === "number" && typeof done.post === "number" ? `: ${done.pre} → ${done.post} tokens` : ""}.`;
  return { sessionId, result, isError: Boolean(resultEvent.is_error) || compactFailed, meta, subtype: typeof resultEvent.subtype === "string" ? resultEvent.subtype : undefined };
}

/** Parse Codex's `exec --json` JSONL stream into the session id, final response, and card metadata. */
export function parseCodexOutput(raw: string): { sessionId?: string; result?: string; isError: boolean; meta: RunMeta } {
  let sessionId: string | undefined;
  let result: string | undefined;
  let isError = false;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      sessionId = codexSessionId(line) ?? sessionId;
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") result = event.item.text;
      if (event.type === "turn.completed") {
        turns++;
        inputTokens += Number(event.usage?.input_tokens) || 0;
        outputTokens += Number(event.usage?.output_tokens) || 0;
        cachedInputTokens += Number(event.usage?.cached_input_tokens) || 0;
      }
      if (event.type === "turn.failed" || event.type === "error") isError = true;
    } catch { /* tolerate non-JSON diagnostic lines */ }
  }
  return { sessionId, result, isError, meta: {
    model: "Codex", numTurns: turns || undefined,
    inputTokens: inputTokens || undefined, outputTokens: outputTokens || undefined,
    cacheReadTokens: cachedInputTokens || undefined,
  } };
}

/** Cursor's `--print --output-format json` emits a single result object carrying the response, the
 *  chosen chat id (`session_id`, resumable with `cursor-agent --resume <id>`), and token usage.
 *  Cursor doesn't report which model ran, so the card just labels it "Cursor". Pure. */
export function parseCursorOutput(raw: string): { sessionId?: string; result?: string; isError: boolean; meta: RunMeta } {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  try {
    // stream-json: the outcome is the last `result` event. A single JSON body (the older buffered
    // form, and what a crash may leave) still parses, so both shapes are handled.
    const lines = raw.split("\n").filter((l) => l.trim());
    const resultLine = [...lines].reverse().find((l) => {
      try { return (JSON.parse(l) as { type?: string }).type === "result"; } catch { return false; }
    });
    const j = JSON.parse((resultLine ?? raw).trim());
    return {
      sessionId: typeof j.session_id === "string" ? j.session_id : undefined,
      result: typeof j.result === "string" ? j.result : undefined,
      isError: Boolean(j.is_error),
      meta: {
        model: "Cursor", numTurns: 1, durationMs: num(j.duration_ms),
        inputTokens: num(j.usage?.inputTokens), outputTokens: num(j.usage?.outputTokens),
        cacheReadTokens: num(j.usage?.cacheReadTokens), cacheCreationTokens: num(j.usage?.cacheWriteTokens),
      },
    };
  } catch {
    return { isError: false, meta: { model: "Cursor" } }; // non-JSON (crash) — let the exit code decide
  }
}

/** Provider-specific argv. Kept pure so tests pin the native resume contracts. */
// The prompt is passed as a positional AFTER a `--` end-of-options marker in every form. Follow-up
// and launch prompts are user-authored and often start with `-` (a Markdown bullet). Without `--`,
// all three CLIs' arg parsers read that leading dash as an unknown option and the run dies before the
// agent ever sees the prompt — e.g. claude `error: unknown option '- gather children…'`. Reproduced
// and each `--` form verified against the real CLIs (see multiAgent.test's leading-dash case).
export function agentCommand(provider: AgentProvider, cwd: string, prompt: string, resume?: string, sessionId?: string, model?: string, permissionMode: PermissionMode = "ask", maxBudgetUsd?: number, allowedTools?: string[], scoped?: ScopedRules, mcp?: McpLockdown): string[] {
  // `model` is the card's pinned model (shared/models.ts) or the config default; unset → each CLI's own.
  const m = model ? ["--model", model] : [];
  if (provider === "codex") {
    return resume
      ? ["codex", "exec", "resume", "--json", "--dangerously-bypass-approvals-and-sandbox", ...m, resume, "--", prompt]
      : ["codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", ...m, "-C", cwd, "--", prompt];
  }
  if (provider === "cursor") {
    // stream-json (not json) so the run's steps arrive AS THEY HAPPEN, the same reason claude uses
    // it. The final `result` event is the same object the buffered form emitted, so
    // parseCursorOutput still extracts the outcome.
    return ["cursor-agent", "-p", ...m, ...(resume ? ["--resume", resume] : []), "--output-format", "stream-json", "--force", "--trust", "--", prompt];
  }
  // stream-json (not json) so the run's steps arrive AS THEY HAPPEN — read incrementally in
  // readClaudeStream to feed the chat modal's live activity trail. --verbose is mandatory with
  // stream-json under -p. The final `result` event is the same object the old `json` form emitted,
  // so parseClaudeStreamOutput extracts the identical outcome/meta at exit.
  // --include-partial-messages adds `stream_event` lines carrying the reply's text as it is generated
  // (claudeDelta): the chat types it out live. They are never stored — the whole message still
  // arrives as its `assistant` event, which is the step.
  // The permission
  // mode is the repo's: `bypassPermissions` was unconditional, which is fine for your own repo and
  // much less so for a client's, so a repo now opts into it.
  // `maxBudgetUsd` is the repo's cost ceiling per run: the CLI stops issuing model requests once
  // the run's spend reaches it and reports a budget result, which the turn records as
  // `budget_reached` — the same stop reason Managed Agents uses for a session budget.
  // `scoped` (a "work" grant): dontAsk + the rules of scopedRules, never bypassPermissions.
  // `mcp` (server/mcp.ts): only Orca's MCP config, never the repo's `.mcp.json`, and the browser
  // servers' tools denied — a deny rule holds under bypassPermissions too.
  const deny = [...(permissionMode === "scoped" ? scoped?.deny ?? [] : []), ...(mcp?.deny ?? [])];
  const perms = permissionMode === "scoped"
    ? ["--permission-mode", "dontAsk", "--settings", JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true } }),
      ...(scoped?.addDirs.length ? ["--add-dir", ...scoped.addDirs] : []),
      "--allowedTools", [...(scoped?.allow ?? []), ...(allowedTools ?? [])].join(",")]
    : ["--permission-mode", permissionMode === "bypass" ? "bypassPermissions" : "default", ...(allowedTools?.length ? ["--allowedTools", allowedTools.join(",")] : [])];
  return ["claude", "-p", ...perms, ...(deny.length ? ["--disallowedTools", deny.join(",")] : []), ...(mcp ? mcpArgs(mcp) : []), ...m, ...(maxBudgetUsd ? ["--max-budget-usd", String(maxBudgetUsd)] : []), ...(resume ? ["--resume", resume] : ["--session-id", sessionId ?? crypto.randomUUID()]), "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--", prompt];
}

// Launches between their call and their return, by key: a Stop pressed while a run is still
// starting (its prompt resolving, its turn being written) waits here, then stops the run it started.
const starting = new Map<string, Promise<void>>();

export async function launch(key: string, cwd: string, prompt: string, options: LaunchOptions = {}): Promise<LaunchReceipt> {
  let done!: () => void;
  const p = new Promise<void>((r) => { done = r; });
  starting.set(key, p);
  try {
    return await launchRun(key, cwd, prompt, options);
  } finally {
    if (starting.get(key) === p) starting.delete(key);
    done();
  }
}

async function launchRun(key: string, cwd: string, prompt: string, options: LaunchOptions): Promise<LaunchReceipt> {
  // A branch preview's bridge launches NOTHING — the last line of defence under every route and loop
  // guard: the 2026-10-15 stray (a preview bridge on a branch's stale code) launched the
  // orchestrator's wakes with a deleted bin/ on PATH.
  if (db.previewBridge()) throw new Error("this is a branch preview's bridge: it launches no agent runs");
  // Reject an overlap whether we remember the run in-process OR a durable lease from before a restart
  // says one is still live in this worktree.
  if (runs.get(key)?.status === "running" || lease.leased(key)) throw new Error("an agent is already running for this worktree");
  // The same guard for the SESSION: a resume while another live run is on that session would have
  // two processes appending to one transcript, and both end with the same reply.
  if (options.resume && lease.sessionBusy(options.resume)) throw new Error("an agent is already running on this session");
  const provider = options.provider ?? "claude";
  // Only Claude Code has the rules a scoped run needs; codex / cursor run with approvals bypassed.
  if (options.permissionMode === "scoped" && provider !== "claude") throw new Error(`a scoped run (an outside sender's "work" grant) needs a Claude model; ${provider} has no tool rules`);
  const sessionId = options.resume ?? (provider === "claude" ? crypto.randomUUID() : undefined);
  // Attachment references become files on THIS instance (server/attachments.ts): the message may
  // have been uploaded on another machine.
  const effectivePrompt = await resolvePrompt(!options.resume && (options.handoffFrom || options.history?.length)
    ? handoffPrompt(options.history ?? [], prompt, options.handoffFrom, provider)
    : prompt);
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  // HEAD before the run, so "did it commit?" is a comparison, not a guess from the outcome text.
  const headBefore = options.check ? await headOf(cwd) : undefined;
  // Every run gets its own memory/CPU-limited scope when one is available (server/cgroup.ts) — so
  // THIS worker's runaway build or browser gets killed by the kernel alone, not the box. No-op on
  // darwin or an unprovisioned Linux box (no systemd-run, or no reachable user bus).
  const scopeUnit = `orca-run-${runId}`;
  const memoryMaxGb = options.memoryMaxGb ?? cgroup.DEFAULT_MEMORY_MAX_GB;
  const cpuWeight = options.cpuWeight ?? cgroup.DEFAULT_CPU_WEIGHT;
  const linux = cgroup.linux();
  let scoped = cgroup.available();
  const scopedEnv = cgroup.runtimeEnv();
  // A user manager that SHOULD be there (lingering is on) but does not answer: report it and start
  // unscoped, never fail every run silently (the 2026-10-18 incident).
  if (linux && (scoped || cgroup.lingering())) {
    const manager = await cgroup.userManagerCheck({ ...process.env, ...scopedEnv });
    cgroup.noteUserManager(manager, { repo: options.repo, branch: options.branch });
    if (!manager.ok) scoped = false;
  }
  // Set on every launch: a user-manager restart drops the runtime property.
  const sliceMaxGb = cgroup.agentsSliceMaxGb();
  if (scoped && !(await cgroup.limitAgentsSlice(sliceMaxGb, { ...process.env, ...scopedEnv }))) {
    console.error(`orca: could not set ${cgroup.AGENTS_SLICE} MemoryMax=${sliceMaxGb}G`);
  }
  // The slices' `oom` counters before the run, so its exit can name the limit that killed it.
  const oomBefore = scoped ? cgroup.oomCounters() : {};
  const proc = Bun.spawn(
    cgroup.scopedCommand(
      agentCommand(provider, cwd, effectivePrompt, options.resume, sessionId, options.model, options.permissionMode, options.maxBudgetUsd, options.allowedTools,
        options.permissionMode === "scoped" ? scopedRulesHere(cwd, options.scope) : undefined, mcpLockdown(cwd, options.mcpAllow)),
      // A positive OOM score scoped or not: the bridge's -500 must not pass to its agents.
      { available: scoped, memoryMaxGb, cpuWeight, unit: scopeUnit, slice: cgroup.AGENTS_SLICE, oomScoreAdj: linux ? cgroup.oomScoreAdj() : undefined },
    ),
    { cwd, env: { ...agentEnv(githubEnv(cwd)), ...(scoped ? scopedEnv : {}), ...options.env }, stdout: "pipe", stderr: "pipe" },
  );
  let timedOut = false;
  const timeout = options.timeoutMs ? setTimeout(() => { timedOut = true; proc.kill(); }, options.timeoutMs) : undefined;
  runs.set(key, { status: "running", provider, runId, prompt, sessionId, proc, startedAt, options });
  lease.acquire({ key, worktreePath: cwd, branch: options.branch, provider, runId, sessionId, pid: proc.pid, startedAt, timeoutMs: options.timeoutMs });
  // Record the turn NOW, not at exit: a run whose bridge dies then survives as an interrupted turn
  // instead of vanishing. Keyed by runId, so a fast follow-up can't clobber the previous turn.
  // Awaited, not fire-and-forget: "the turn exists before the run can produce output" is the whole
  // reason it is written at launch, and an async database must not quietly weaken it.
  const started = recordTurn(options, () => outbox.startTurn({
    repo: options.repo!, branch: options.branch!, runId, provider, instruction: options.instruction, prompt, sessionId, startedAt, source: options.source,
  }));
  await started;
  void (async () => {
    // Read stdout/stderr, but NEVER let the pipe decide when the turn is finalized. Killing the CLI
    // does not necessarily close its stdout — a grandchild (a shell's `sleep`, a spawned build) can
    // hold the write end open indefinitely, and waiting on EOF would leave the turn stuck `running`
    // forever with its work unrecorded. So: wait for the process to exit, then give the readers a
    // short grace to drain, then proceed with whatever landed (the holders expose partial output).
    const outHolder = { raw: "" };
    const errHolder = { raw: "" };
    const reads = Promise.all([
      provider === "codex" ? readCodexOutput(key, proc, outHolder, runId, { repo: options.repo, branch: options.branch })
        : provider === "claude" ? readClaudeStream(runId, proc, outHolder, { repo: options.repo, branch: options.branch })
        : readCursorOutput(proc, outHolder, runId, { repo: options.repo, branch: options.branch }),
      tailText(proc.stderr).then((t) => (errHolder.raw = t)),
    ]);
    const code = await proc.exited;
    await Promise.race([reads, new Promise((r) => setTimeout(r, DRAIN_GRACE_MS))]);
    const out = outHolder.raw;
    const err = errHolder.raw;
    if (timeout) clearTimeout(timeout);
    // A superseded (re-run) or stopped run must not clobber the live `runs` entry — but its output is
    // still real work that happened, so it's parsed and its turn is still completed in the DB. This
    // is exactly the history the old in-memory map lost when a fast follow-up overwrote its key.
    const superseded = runs.get(key)?.proc !== proc;
    let result: string | undefined, isError = false, meta: RunMeta | undefined, resolvedSessionId = sessionId;
    let budgetReached = false;
    if (provider === "codex") {
      const parsed = parseCodexOutput(out);
      result = parsed.result;
      isError = parsed.isError;
      meta = parsed.meta;
      resolvedSessionId = parsed.sessionId ?? resolvedSessionId;
    } else if (provider === "cursor") {
      const parsed = parseCursorOutput(out);
      result = parsed.result;
      isError = parsed.isError;
      meta = parsed.meta;
      resolvedSessionId = parsed.sessionId ?? resolvedSessionId;
    } else {
      const parsed = parseClaudeStreamOutput(out);
      result = parsed.result;
      isError = parsed.isError;
      meta = parsed.meta;
      resolvedSessionId = parsed.sessionId ?? resolvedSessionId;
      budgetReached = /budget/i.test(parsed.subtype ?? ""); // the CLI's result subtype for --max-budget-usd
    }
    transcript.forget(runId); // run finished — the transcript file stays; it IS the history now
    const finishedAt = Date.now();
    if (meta) meta.durationMs ??= finishedAt - startedAt;
    const structured = result ? parseAgentOutcome(result) : undefined;
    const ok = code === 0 && !isError;
    const wasStopped = stoppedRuns.delete(runId);
    // 137 is plain SIGKILL from anything; ask the scope itself (its Result, read while it still has
    // one — see cgroup.wasOomKilled) and the slices' `oom` counters (cgroup.oomCause) rather than
    // assume, so a run you stopped or that died some other way at 137 isn't mislabelled.
    const scopeOom = scoped && !wasStopped && await cgroup.wasOomKilled(scopeUnit, { ...process.env, ...scopedEnv });
    const oomCause = scoped && !wasStopped
      ? cgroup.oomCause({ scopeOom, before: oomBefore, after: cgroup.oomCounters(), memoryMaxGb, agentsSliceMaxGb: sliceMaxGb })
      : undefined;
    const oomKilled = !ok && !wasStopped && code === 137 && oomCause !== undefined;
    if (oomKilled || (scopeOom && oomCause)) noteOomKill(); // the instance card's Memory chart marks it at the next sample
    // The agent is gone, but a dev server or build it left in the background keeps its scope alive
    // (17:55 on 2026-10-19: a finished worker's nest, vite and backend held 1.7 GB for 14 minutes).
    // After the OOM read above, which needs the scope: stop it, and every process in it.
    if (scoped) await stopRunScope(runId, { ...process.env, ...scopedEnv });
    const rawError = (err.trim() || result || `exit ${code}`).slice(0, 300);
    // A process of THIS run was OOM-killed (its scope says so) but the agent went on, or failed some
    // other way: a build, or a git push hook. Name it, so a push that never happened is not silent.
    const error = ok ? undefined : oomKilled ? oomCause : scopeOom && oomCause ? `${oomCause}: ${rawError}`.slice(0, 300) : rawError;
    if (ok && scopeOom && oomCause) {
      result = `${result ?? ""}\n\n> Orca: a process of this run was killed — ${oomCause}. A build or a git push hook may not have finished; check that the push happened.`;
    }
    const common = { provider, runId, prompt, sessionId: resolvedSessionId, result, structured, meta, startedAt, finishedAt };
    const stopReason: StopReason = wasStopped ? "interrupted" : budgetReached ? "budget_reached" : ok ? "end_turn" : "error";
    await started; // finish can never overtake start, however fast the run was
    recordTurn(options, () => outbox.finishTurn(runId, {
      // A run you stopped is not a failure: whatever it completed stands, and the session id below
      // keeps it resumable, so a follow-up redirects it rather than starting over.
      status: wasStopped ? "stopped" : ok ? "done" : "error",
      stopReason,
      // A failed run still has something worth keeping — the error is the turn's outcome.
      response: wasStopped ? (result ?? "Stopped. The work so far stands; reply to redirect.") : (result ?? error),
      structured, sessionId: resolvedSessionId, finishedAt,
      // Everything needed to write the turn from scratch if its start write was lost.
      identity: { repo: options.repo!, branch: options.branch!, provider, instruction: options.instruction, prompt, startedAt, source: options.source },
    }));
    if (superseded) return;
    lease.release(key, runId); // this run is done — free the worktree (no-op if a re-run already took the lease)
    ledger.record({
      kind: "run", provider, action: options.action, mode: runMode(options),
      status: ok ? "done" : "error", durationMs: meta?.durationMs ?? finishedAt - startedAt,
      inputTokens: meta?.inputTokens, outputTokens: meta?.outputTokens,
      cacheReadTokens: meta?.cacheReadTokens, cacheCreationTokens: meta?.cacheCreationTokens,
      evidenceChars: options.evidenceChars, costUsd: meta?.costUsd,
      errorKind: ok ? undefined : oomKilled ? "oom" : budgetReached ? "budget" : timedOut ? "timeout" : code !== 0 ? "nonzero-exit" : "agent-error",
      repo: options.repo,
    });
    // The verification gate: a run that committed gets the repo's check command run over it, and
    // the result lands on the turn as evidence. Only a successful run is checked — a failed one has
    // its own error, and a stopped one is mid-work by definition.
    let check: TurnCheck | undefined;
    if (ok && options.check && headBefore !== undefined && (await headOf(cwd)) !== headBefore) {
      check = await runCheck(cwd, options.check.command);
      // Awaited (the run is over; this only delays the status flip by one round trip), so a run that
      // reads as finished has its verdict on the turn — a reader that polls "finished, then fetch"
      // otherwise sees the check missing when the pool is busy (the notification writes below).
      await recordTurn(options, () => outbox.setCheck(runId, check!, options));
      if (!check.ok && options.check.autofix && primary.held() && options.repo && options.branch && !isAutofix(options.instruction)) {
        // Queued rather than launched: the same path a typed follow-up takes, so it inherits the
        // session, profile routing, and the run lease. dispatchQueued below sends it.
        await db.queueMessage({
          repo: options.repo, branch: options.branch, worktreePath: cwd, provider,
          instruction: autofixInstruction(check), attachments: [],
        }).catch(db.logUnlessDown("orca: autofix queue failed"));
      }
    }
    const handled = afterRunStarted();
    runs.set(key, ok
      ? { status: "done", ...common, check }
      : { status: "error", ...common, error });
    // An instruction typed while this run was in flight goes now. Fire-and-forget and after the run
    // is marked finished, so the queued launch sees a free worktree.
    // Awaited now (it was fire-and-forget) only so the hook below can say whether the branch went
    // straight into another run; nothing else waits on this function.
    const continued = options.repo && options.branch && options.queue !== false
      ? await dispatchQueued(options.repo, options.branch, options) : false;
    try {
      await runFinished?.({
        key, cwd, runId, options, status: wasStopped ? "stopped" : ok ? "done" : "error",
        sessionId: resolvedSessionId, result: result ?? error, structured, check, meta, continued,
        exit: { code, timedOut, budgetReached, stderr: err.trim().slice(-300) },
      });
    } catch (e) {
      db.logUnlessDown("orca: run-finished hook failed")(e); // a listener must never break the run it heard about
    }
    handled();
  })();
  return { status: "running", provider, runId, sessionId };
}

/** The worktree's HEAD, or undefined when it isn't a git checkout. */
async function headOf(cwd: string): Promise<string | undefined> {
  try { return (await run(["git", "rev-parse", "HEAD"], cwd)).trim(); } catch { return undefined; }
}

/** Feature/fix run inside a worktree — keyed by the worktree path. */
export const runAgent = (worktreePath: string, prompt: string, options?: LaunchOptions): Promise<LaunchReceipt> => launch(worktreePath, worktreePath, prompt, options);

export const isRunning = (key: string): boolean => runs.get(key)?.status === "running" || lease.leased(key);
/** When the run on this key started: its in-memory run, else an adopted lease's. Undefined when idle. */
export const runStartedAt = (key: string): number | undefined => {
  const run = runs.get(key);
  if (run?.status === "running") return run.startedAt;
  return lease.leased(key) ? lease.current(key)?.startedAt : undefined;
};

/** A provider-isolated one-shot: never falls through to a different provider. */
export function oneShotCommand(provider: AgentProvider, cwd: string, prompt: string, purpose: "title" | "description"): string[] {
  if (provider === "claude") {
    return ["claude", "-p", prompt, "--model", purpose === "title" ? "haiku" : "sonnet", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json"];
  }
  if (provider === "codex") return ["codex", "exec", "--json", "--ephemeral", "--ignore-rules", "--sandbox", "read-only", "-C", cwd, prompt];
  return ["cursor-agent", "-p", prompt, "--output-format", "json", "--mode", "ask", "--trust"];
}

/** Read-only argv for asking the implementation agent's native session to author its PR body. */
export function prDescriptionCommand(provider: AgentProvider, cwd: string, prompt: string, resume: string): string[] {
  if (provider === "claude") {
    // Pin sonnet like the one-shot fallback: resuming otherwise inherits the implementation model
    // (opus), and writing a PR body from an already-loaded session doesn't need it — it's ~half the
    // wall clock of a Promote.
    return ["claude", "-p", prompt, "--resume", resume, "--model", "sonnet", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--output-format", "json"];
  }
  if (provider === "codex") {
    return ["codex", "exec", "resume", "--json", "-c", 'sandbox_mode="read-only"', resume, prompt];
  }
  return ["cursor-agent", "-p", prompt, "--resume", resume, "--output-format", "json", "--mode", "ask", "--trust"];
}

async function commandOutput(provider: AgentProvider, args: string[], cwd: string, purpose: "title" | "description"): Promise<string> {
  // A resumed session can run shell: the agent's env, never Orca's secrets.
  const { stdout: out, stderr: err, code } = await runCmd(args, { cwd, env: { PATH: agentEnv().PATH }, timeoutMs: 2 * 60_000, allowFail: true });
  if (code !== 0) throw new Error(err.trim() || `${provider} ${purpose} failed`);
  if (provider === "claude") return String(JSON.parse(out.trim()).result ?? "");
  if (provider === "codex") {
    const parsed = parseCodexOutput(out);
    if (parsed.isError) throw new Error(`${provider} ${purpose} failed`);
    return parsed.result ?? "";
  }
  const parsed = parseCursorOutput(out);
  if (parsed.isError) throw new Error(`${provider} ${purpose} failed`);
  return parsed.result ?? "";
}

async function oneShot(provider: AgentProvider, prompt: string, purpose: "title" | "description"): Promise<string> {
  // The prompt is self-contained. Running outside the repo avoids loading project instructions and
  // prevents the helper conversation from replacing the worktree's resumable session.
  const cwd = tmpdir();
  const args = oneShotCommand(provider, cwd, prompt, purpose);
  return commandOutput(provider, args, cwd, purpose);
}

/** Quick selected-provider summary of a prompt into a 2–5 word title. Asks for JSON, validates it, and
 *  refetches once if the reply doesn't parse to a valid title; null after that (caller falls back
 *  to titleFromPrompt). */
export function summarize(provider: AgentProvider, prompt: string): Promise<string | null> {
  const ask = () => oneShot(provider, `Respond with ONLY minified JSON: {"title":"<a 2-5 word Title Case name for this task>"}. No other text.\n\n${prompt}`, "title");
  return retryTitle(ask, 2); // validate + refetch once on a bad reply
}

/** Ask the implementation agent's native session for the PR body. Without a resumable session,
 *  use an isolated same-provider call with the self-contained prompt. */
export async function describePr(provider: AgentProvider, prompt: string, options?: { cwd?: string; resume?: string }): Promise<string | null> {
  try {
    const body = (options?.resume
      ? await commandOutput(provider, prDescriptionCommand(provider, options.cwd ?? tmpdir(), prompt, options.resume), options.cwd ?? tmpdir(), "description")
      : await oneShot(provider, prompt, "description")).trim();
    return body || null;
  } catch {
    return null;
  }
}

// Runs you stopped deliberately. The exit handler reads this so an interrupted run is recorded as
// `stopped` rather than `error` — the work it already did stands, and its session stays resumable.
const stoppedRuns = new Set<string>();

// Set by index.ts, which owns the config a queued launch needs (model, permission mode, timeout).
// A module-level hook rather than an import, so agent.ts keeps knowing nothing about config or HTTP.
let queuedLauncher: ((message: db.QueuedMessage) => Promise<void>) | undefined;
export function onQueuedMessage(fn: (message: db.QueuedMessage) => Promise<void>): void {
  queuedLauncher = fn;
}

// Set by index.ts: the orchestrator's wake loop listens here. A hook for the same reason as the
// queued launcher — agent.ts knows nothing about who cares that a run ended.
let runFinished: ((run: RunFinished) => Promise<void>) | undefined;
export function onRunFinished(fn: ((run: RunFinished) => Promise<void>) | undefined): void {
  runFinished = fn;
}

/** Send the next instruction queued for a branch, if any. Claimed in one statement, so a restart
 *  racing itself — or a second instance — cannot dispatch the same message twice. Resolves true
 *  when it launched one. */
async function dispatchQueued(repo: string, branch: string, options: LaunchOptions): Promise<boolean> {
  if (!queuedLauncher) return false;
  let next: db.QueuedMessage | undefined;
  try {
    next = await db.claimQueuedMessage(repo, branch);
    if (!next) return false;
    await queuedLauncher(next);
    return true;
  } catch (e) {
    // Never let a queued send break the run that just finished. A message whose launch failed goes
    // back on the queue: it stayed claimed once, and the message was lost (the next send went
    // without it). Nothing retries it in a loop; the next run's end or send picks it up.
    if (next) await db.releaseQueuedMessage(next.id).catch(db.logUnlessDown("orca: queued message release failed"));
    db.logUnlessDown("orca: queued message dispatch failed")(e);
    return false;
  }
}

/** Send what is queued for an IDLE branch, oldest first. A direct send onto a worktree with older
 *  messages still queued calls this after it queues its own, so the older ones go first. */
export async function drainQueue(key: string, repo: string, branch: string): Promise<boolean> {
  if (isRunning(key)) return false; // the run in flight sends the queue when it ends
  return dispatchQueued(repo, branch, {});
}

// How long Stop waits for the stopped process to exit before it sends the queue: the next run
// resumes the SAME session, and two processes on one session both write to its transcript.
export const stopGrace = { ms: 5_000 }; // mutable so a test needn't wait five seconds

// How often an adopted run's lease is checked for its process having exited.
export const adoptPoll = { ms: 5_000 }; // mutable so a test needn't wait five seconds

/** Runs that outlived the previous bridge. Their processes are fine — only the bridge's view of them
 *  died: the stdout reader, and the exit handler that records the result, wakes the orchestrator and
 *  sends what was queued. So a restart used to turn a finishing run into a card stuck on "running"
 *  and an orchestrator never told. Adopt each live lease instead: show it running, and when its
 *  process exits, finish its turn from the provider's own session file (`recover`) and run the same
 *  after-run path a watched run gets — minus the check gate, which needs the HEAD it started from.
 *  `skip` keeps the orchestrator's own wake out of this; orchestrator.recover handles that one. */
export function adoptLeases(
  recover: (runId: string, sessionId?: string, worktreePath?: string) => Promise<{ response?: string; structured?: AgentOutcome } | undefined>,
  skip?: string,
): number {
  if (!primary.held()) return 0; // only the instance's primary finishes another bridge's runs
  const adopted = lease.live().filter((l) => l.key !== skip && !runs.has(l.key));
  for (const l of adopted) {
    runs.set(l.key, { status: "running", provider: l.provider, runId: l.runId, sessionId: l.sessionId, startedAt: l.startedAt });
    const poll = setInterval(() => {
      if (lease.leased(l.key) && lease.current(l.key)?.runId === l.runId) return; // still going
      clearInterval(poll);
      void finishAdopted(l, recover).catch(db.logUnlessDown("orca: adopted run could not be finished"));
    }, adoptPoll.ms);
    poll.unref();
  }
  return adopted.length;
}

/** Stop a finished run's scope (`orca-run-<runId>.scope`): every process still in it is killed. A
 *  scope that is already gone is fine. Bounded, and never throws: the run is recorded either way. */
export async function stopRunScope(runId: string, env: Record<string, string | undefined>): Promise<void> {
  await runCmd(["systemctl", "--user", "stop", `orca-run-${runId}.scope`], { env, allowFail: true, timeoutMs: 10_000 }).catch(() => undefined);
}

async function finishAdopted(l: lease.Lease, recover: Parameters<typeof adoptLeases>[0]): Promise<void> {
  if (runs.get(l.key)?.runId !== l.runId) return; // a new run took the key meanwhile
  // The journal knows the owner when the turn never reached the database (it was down at launch).
  const owner = await db.turnOwner(l.runId).catch(() => undefined) ?? outbox.owner(l.runId);
  const found = await recover(l.runId, l.sessionId, l.worktreePath).catch(() => undefined);
  const finishedAt = Date.now();
  const ok = Boolean(found?.response);
  const result = found?.response ?? "The bridge restarted during this run, and its result could not be recovered from the provider's session.";
  const status: db.TurnStatus = ok ? "done" : "error";
  if (owner) {
    const pending = outbox.finishTurn(l.runId, { status, response: result, structured: found?.structured, stopReason: ok ? "end_turn" : "error", sessionId: l.sessionId, finishedAt })
      .catch((e) => console.error("orca: chat history write failed", e));
    historyWrites.add(pending);
    void pending.finally(() => historyWrites.delete(pending));
    await pending;
  }
  lease.release(l.key, l.runId);
  if (cgroup.available()) await stopRunScope(l.runId, { ...process.env, ...cgroup.runtimeEnv() }); // what it left behind
  const handled = afterRunStarted();
  try {
    runs.set(l.key, { status, provider: l.provider, runId: l.runId, sessionId: l.sessionId, result, structured: found?.structured, startedAt: l.startedAt, finishedAt, error: ok ? undefined : result });
    if (!owner) return;
    const options: LaunchOptions = { repo: owner.repo, branch: owner.branch, provider: l.provider };
    const continued = await dispatchQueued(owner.repo, owner.branch, options);
    try {
      await runFinished?.({
        key: l.key, cwd: l.worktreePath, runId: l.runId, options, status, sessionId: l.sessionId, result, structured: found?.structured, continued,
        exit: { code: ok ? 0 : 1, timedOut: false, budgetReached: false, stderr: "" },
      });
    } catch (e) {
      db.logUnlessDown("orca: run-finished hook failed")(e);
    }
  } finally {
    handled();
  }
}

/** Forget finished runs whose worktree is gone. A finished entry is kept per worktree (the board
 *  reads its status, result and prompt), but a reaped worktree's entry was never removed, so the map
 *  grew with every worktree the bridge ever ran in. Hourly, from the reaper in index.ts. */
export function pruneRuns(exists: (path: string) => boolean = existsSync): number {
  let n = 0;
  for (const [key, r] of runs) {
    if (r.status !== "running" && !starting.has(key) && !exists(key)) { runs.delete(key); n++; }
  }
  return n;
}

/** How many runs the bridge holds in memory (/api/health's bridge memory). */
export const runCount = (): number => runs.size;

/** Kill and forget a run (e.g. on discard, or Stop from the chat). Returns the runId it stopped, if
 *  any, so a caller can report what it interrupted. */
export function stop(key: string): string | undefined {
  const r = runs.get(key);
  if (r?.runId && r.status === "running") stoppedRuns.add(r.runId);
  try { r?.proc?.kill(); } catch { /* already gone */ }
  // A run adopted after a restart has no handle: its lease names the process. Without this, Stop
  // left it running and the next run resumed a session it was still writing to.
  const held = !r?.proc ? lease.current(key) : undefined;
  if (held && (!r?.runId || held.runId === r.runId) && lease.leased(key)) {
    try { process.kill(held.pid); } catch { /* already gone */ }
  }
  runs.delete(key);
  lease.release(key); // discard/stop frees the worktree even if the run was recovered from a lease
  return r?.runId;
}

/** Stop from the chat: stop the run, then send the next queued message at once, as a finished run
 *  does. A stopped run's own exit never sends the queue (it reads as superseded), so without this
 *  the queue waited for the next message you typed. A Stop pressed while the run is still starting
 *  waits for it to exist, then stops it. `queue: false` is for a caller with its own queue (the
 *  orchestrator). Discard uses `stop`, which sends nothing. */
export async function interrupt(key: string, opts: { queue?: boolean } = {}): Promise<string | undefined> {
  await starting.get(key);
  const r = runs.get(key);
  const runId = stop(key);
  if (!runId || opts.queue === false || r?.options?.queue === false) return runId;
  if (r?.proc) await Promise.race([r.proc.exited, new Promise((res) => setTimeout(res, stopGrace.ms))]);
  // A run adopted from a lease after a restart has no options; its turn names the branch.
  const owner = r?.options?.repo && r.options.branch ? { repo: r.options.repo, branch: r.options.branch }
    : await db.turnOwner(runId).catch(() => undefined);
  if (owner) await dispatchQueued(owner.repo, owner.branch, r?.options ?? { provider: r?.provider });
  return runId;
}

export { cwdInWorktree, isHeadlessAgentProcess, processCwd } from "./proc";

/** Kill the headless agents running IN a worktree — works even after a restart lost the handle.
 *  Matched by the process's cwd, never by its argv: a prompt is passed in argv, and the
 *  orchestrator's carries the whole board, so "argv mentions the branch" matched the orchestrator's
 *  own wake whenever a PR it had just merged was reaped — a SIGTERM (exit 143) mid-reply. A process
 *  whose cwd can't be read is left alone. */
export async function killInWorktree(worktreePath: string): Promise<void> {
  for (const p of await procs.headlessAgents()) {
    if (procs.cwdInWorktree(p.cwd, worktreePath)) { try { process.kill(p.pid); } catch { /* already gone */ } }
  }
}

/** Branches that currently have a live headless agent process (recovers status lost on restart).
 *  Matched by cwd, never argv (the orchestrator's argv names every branch on the board): exactly,
 *  when the caller passes each branch's worktree path; else a cwd ending in `/<branch>` (worktrees
 *  live at `<worktreeRoot>/<branch>`). */
export async function detectRunning(branches: string[], worktreeOf: Record<string, string> = {}): Promise<Set<string>> {
  const found = new Set<string>();
  const agents = await procs.headlessAgents();
  for (const b of branches) {
    if (!b) continue;
    const path = worktreeOf[b];
    if (agents.some((a) => path ? procs.cwdInWorktree(a.cwd, path) : Boolean(a.cwd && (a.cwd.endsWith(`/${b}`) || a.cwd.includes(`/${b}/`))))) found.add(b);
  }
  // Union in leased branches: the lease records the branch explicitly.
  for (const b of lease.liveBranches(branches)) found.add(b);
  return found;
}

export const status = (key: string): RunState => {
  const r = runs.get(key);
  return r ? {
    status: r.status, error: r.error, provider: r.provider, runId: r.runId, prompt: r.prompt,
    sessionId: r.sessionId, result: r.result, structured: r.structured, meta: r.meta, check: r.check, startedAt: r.startedAt, finishedAt: r.finishedAt,
  } : { status: "idle" };
};
