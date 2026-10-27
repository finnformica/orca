// Named agents (docs/design/named-agents-and-memory.md §7): the pure rules. The store is
// server/agents.ts; the runtime is server/orchestrator.ts, made general over an AgentRef.
//
// An agent is a workstream under the reserved `@orca` repo: its conversation, session and queue are
// that branch's. The Chief of Staff keeps today's orchestrator branch, so its history, session and
// queue are where they were.
import { CHIEF } from "./memory";
import { AGENTS_REPO, ASSISTANT, CHIEF_BRANCH, agentOfBranch, cloudflareWriteName, inboundAgent, type Level } from "./integrations";

// The routing helpers live in shared/integrations.ts (it imports nothing); they are re-exported here.
export { AGENTS_REPO, ASSISTANT, CHIEF, CHIEF_BRANCH, agentOfBranch, inboundAgent };

export const AGENT_STATES = ["idle", "working", "waiting", "blocked", "done"] as const;
export type AgentStateName = (typeof AGENT_STATES)[number];
/** The states an agent sets itself (`orca agent state`); the server derives the other two. */
export const SET_STATES = ["waiting", "blocked", "done", "idle"] as const;
export const STATE_NOTE_MAX = 200;

/** What an agent may run: a shell or not, and its `orca` verbs ("all", or a list). */
export type AgentTools = { shell: boolean; verbs: "all" | string[] };

/** One named agent, as its `agent` row holds it (server/agents.ts). The row is the single source of
 *  truth: nothing in code adds to or overrides it. */
export type AgentDef = {
  name: string;
  displayName: string;
  /** The role text sent when a session starts. */
  role?: string;
  /** Pinned model; absent = the runtime default (server/orchestrator.ts ORCHESTRATOR_DEFAULT_MODEL). */
  model?: string;
  branch: string;
  tools: AgentTools;
  /** The highest grant its own wakes get ("full" = the user's). */
  maxGrant: Level;
  /** The state the agent set (`orca agent state`), and its note. */
  state: AgentStateName;
  stateNote?: string;
  /** A seeded agent (the Chief of Staff, the Assistant): it cannot be archived. Nothing else. */
  builtin: boolean;
};

/** Every `orca` verb the tool route knows (server/orchestrator.ts `tool`): the checklist of Settings >
 *  Agents and the check of an edited verb list. A vocabulary, not a permission: what each agent may
 *  run is its row's `tools`. tests/agentDefs.test.ts keeps it equal to the tool route's verbs. */
export const AGENT_VERBS = [
  "address", "agent", "archive", "ask", "ask-form", "ask-user", "board", "channels", "chats", "cloudflare",
  "gmail", "granola", "handoff", "machine", "memory", "merge", "move", "notes", "post", "pr-shots", "preview",
  "read", "repo", "secret", "send", "slack", "spawn", "status", "stop", "sweep", "thread", "wake",
] as const;

/** The ONLY definition in code, and only for when the database is down: the Chief of Staff's identity
 *  (its name, display name and branch, so its chat and queue still resolve) with no shell, no verbs
 *  and no role. A wake needs the database anyway, so this never widens what any agent may run. */
export const FALLBACK_CHIEF: AgentDef = {
  name: CHIEF, displayName: "Chief of Staff", branch: CHIEF_BRANCH, tools: { shell: false, verbs: [] }, maxGrant: "full", state: "idle", builtin: true,
};

/** Why `tools` is not a valid tools value, or undefined: a shell flag and "all" or known verbs. */
export function toolsProblem(tools: unknown): string | undefined {
  if (!tools || typeof tools !== "object") return "tools: { shell, verbs }";
  const t = tools as Record<string, unknown>;
  if (typeof t.shell !== "boolean") return "tools.shell: true or false";
  if (t.verbs === "all") return undefined;
  if (!Array.isArray(t.verbs)) return 'tools.verbs: "all" or a list of verbs';
  const unknown = t.verbs.filter((v) => !(AGENT_VERBS as readonly unknown[]).includes(v));
  return unknown.length ? `tools.verbs: unknown verb ${unknown.map(String).join(", ")}` : undefined;
}

/** A slug: lower case, a letter first, 2 to 31 characters. Also the branch of a non-chief agent. */
export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
export const agentBranch = (name: string): string => (name === CHIEF ? CHIEF_BRANCH : name);

/** Why `def` may not run `verb`, or undefined. Server-side, beside the grant check, and over the
 *  agent's ROW (`def.tools`), so an agent's limits do not depend on its prompt. `agent add` is the
 *  user's alone (`fromUser`: the Chief of Staff's wake with only the user's messages); no agent
 *  edits or archives an agent: that is Settings > Agents only. A limited agent (a verb list, not
 *  "all") gets only the read part of preview, slack, cloudflare, status and wake. */
export function agentVerbRefusal(def: Pick<AgentDef, "name" | "displayName" | "tools">, verb: string, words: string[], args: Record<string, unknown>, ctx: { fromUser?: boolean } = {}): string | undefined {
  const sub = words[0] ?? "";
  if (verb === "agent" && sub !== "list" && sub !== "state") {
    if (sub !== "add") return `refused: "agent ${sub}" is the user's alone: Settings > Agents`;
    if (def.name !== CHIEF || !ctx.fromUser) return `refused: "agent ${sub || "add"}" is the user's alone (Settings, or their own chat with the Chief of Staff)`;
    return undefined;
  }
  if (def.tools.verbs === "all") return undefined;
  const no = `refused: the ${def.displayName} may not run "${verb}${sub ? ` ${sub}` : ""}"`;
  if (!def.tools.verbs.includes(verb)) return `${no}. Ask the Chief of Staff: orca ask chief "<what and why>"`;
  // Inside an allowed verb, the reads only.
  if (verb === "preview" && args.status === undefined) return `${no}: only preview --status`;
  if (verb === "slack" && sub === "post") return `${no}: it posts as the user. Ask the Chief of Staff, or answer with orca post --reply`;
  if (verb === "cloudflare" && cloudflareWriteName(words)) return `${no}: a Cloudflare write is the Chief of Staff's, on the user's word`;
  if (verb === "status" && args["clear-grant"] !== undefined) return `${no}: status --clear-grant`;
  if (verb === "wake" && typeof args.agent === "string" && args.agent && args.agent !== def.name) return `${no}: only the Chief of Staff sets a wake for another agent`;
  return undefined;
}

/** A message one agent sends another (`orca ask`): `[from <agent>]` and the text. It is not the
 *  user's input, so it does not reset the wake count and does not clear an outside grant. */
export const agentMessage = (from: string, text: string): string => `[from ${from}] ${text}`;
const FROM = /^\[from ([a-z][a-z0-9-]*)\] /;
export const isAgentMessage = (text: string): boolean => FROM.test(text);
export const agentMessageFrom = (text: string): string | undefined => text.match(FROM)?.[1];

/** The state the panel shows (§7.2): working while a wake runs; blocked while paused (MAX_WAKES);
 *  else what the agent set, idle by default. */
export function agentState(input: { running: boolean; paused: boolean; stored?: AgentStateName; note?: string }): { state: AgentStateName; note?: string } {
  if (input.running) return { state: "working" };
  if (input.paused) return { state: "blocked", note: "paused: reply to resume" };
  const state = input.stored && input.stored !== "working" ? input.stored : "idle";
  return { state, ...(state !== "idle" && input.note ? { note: input.note } : {}) };
}

/** A user message clears what waited on the user (§7.2). */
export const clearsOnUserMessage = (s: AgentStateName): boolean => s === "waiting" || s === "blocked";

/** A post from an agent other than the Chief of Staff names it (§7.7): one bot account posts for
 *  every agent. The Chief of Staff's posts stay as they were (it was the only voice before). */
export const authoredPost = (agent: Pick<AgentDef, "name" | "displayName">, text: string): string =>
  agent.name === CHIEF ? text : `**${agent.displayName}**: ${text}`;

/** `orca agent list`, one line each. */
export function agentListText(rows: { def: AgentDef; state: AgentStateName; note?: string; queued: number }[]): string {
  return rows.map(({ def, state, note, queued }) =>
    `${def.name} · ${def.displayName} · ${state}${note ? ` (${note})` : ""}${queued ? ` · ${queued} queued` : ""}${def.tools.verbs === "all" ? "" : " · limited verbs"}`).join("\n");
}

/** Where clean worker reports go (§7.4, `agents.cleanReportsTo`): the Chief of Staff unless the user
 *  chose the Assistant. A problem report always goes to the Chief of Staff. */
export const cleanReportsTo = (cfg: { agents?: { cleanReportsTo?: string } }): string => cfg.agents?.cleanReportsTo || CHIEF;
