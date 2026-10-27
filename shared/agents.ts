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

export type AgentDef = {
  name: string;
  displayName: string;
  /** The role text sent when a session starts. Absent = the built-in role (web/src/workstream.ts). */
  role?: string;
  /** Pinned model; absent = the runtime default for that agent. */
  model?: string;
  branch: string;
  tools: AgentTools;
  /** The highest grant its own wakes get ("full" = the user's). */
  maxGrant: Level;
  /** The state the agent set (`orca agent state`), and its note. */
  state: AgentStateName;
  stateNote?: string;
  builtin: boolean;
};

/** The Assistant's verbs (§7.3): reads, posts on links, questions, memory, wakes, escalation. No
 *  spawn, send, address, merge, move, sweep, archive, stop, repo, secret, handoff or notes. */
export const ASSISTANT_VERBS = [
  "board", "channels", "machine", "chats", "read", "post", "thread", "ask-user", "ask-form",
  "memory", "wake", "ask", "agent", "status", "preview", "slack", "gmail", "cloudflare",
] as const;

/** The Assistant runs on Sonnet unless the user pins another (§7.3). */
export const ASSISTANT_DEFAULT_MODEL = "claude-sonnet-5-5";

export const BUILTIN_AGENTS: readonly AgentDef[] = [
  { name: CHIEF, displayName: "Chief of Staff", branch: CHIEF_BRANCH, tools: { shell: true, verbs: "all" }, maxGrant: "full", state: "idle", builtin: true },
  { name: ASSISTANT, displayName: "Assistant", branch: ASSISTANT, model: ASSISTANT_DEFAULT_MODEL, tools: { shell: false, verbs: [...ASSISTANT_VERBS] }, maxGrant: "full", state: "idle", builtin: true },
];

/** A slug: lower case, a letter first, 2 to 31 characters. Also the branch of a non-chief agent. */
export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
export const agentBranch = (name: string): string => (name === CHIEF ? CHIEF_BRANCH : name);

/** Why `def` may not run `verb`, or undefined. Server-side, beside the grant check: the Assistant's
 *  limits do not depend on its prompt. `agent add` is the user's alone (`fromUser`: the Chief of
 *  Staff's wake with only the user's messages). */
export function agentVerbRefusal(def: Pick<AgentDef, "name" | "displayName" | "tools">, verb: string, words: string[], args: Record<string, unknown>, ctx: { fromUser?: boolean } = {}): string | undefined {
  const sub = words[0] ?? "";
  if (verb === "agent" && sub !== "list" && sub !== "state") {
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
