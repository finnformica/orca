// Named agents: the store (table `agent`, server/db.ts step 20261025-team-agents) over the built-in
// definitions (shared/agents.ts BUILTIN_AGENTS). The two built-in agents need no row: a row is
// written the first time one changes (its state, a pinned model) and overrides those fields only.
// A user-added agent (`orca agent add`, POST /api/orchestrator/agents) is a row with its own role.
//
// The run state (session, the wake in flight, the wake count) stays in each agent's workstream
// blob, as the orchestrator's always did — so this module moves no runtime state.
import * as db from "./db";
import {
  AGENT_NAME_RE, AGENT_STATES, ASSISTANT_VERBS, BUILTIN_AGENTS, STATE_NOTE_MAX, agentBranch,
  type AgentDef, type AgentStateName, type AgentTools,
} from "../shared/agents";
import type { Level } from "../shared/integrations";

const user = () => db.currentUser();

type Row = {
  name: string; display_name: string; role: string; model: string | null; branch: string; tools: AgentTools | null;
  max_grant: Level; state: AgentStateName; state_note: string | null; archived_at: string | null;
};

const fromRow = (r: Row, base?: AgentDef): AgentDef => ({
  name: r.name, displayName: base?.displayName ?? r.display_name, branch: base?.branch ?? r.branch,
  // A built-in agent keeps its code's role and tools: a row only carries what changed.
  ...(base ? (base.role ? { role: base.role } : {}) : r.role ? { role: r.role } : {}),
  ...(r.model ? { model: r.model } : base?.model ? { model: base.model } : {}),
  tools: base?.tools ?? (r.tools && "verbs" in r.tools ? r.tools : { shell: false, verbs: [...ASSISTANT_VERBS] }),
  maxGrant: base?.maxGrant ?? r.max_grant, state: r.state, ...(r.state_note ? { stateNote: r.state_note } : {}),
  builtin: Boolean(base),
});

/** Every active agent, the Chief of Staff first. With the database down: the built-in two. */
export async function all(): Promise<AgentDef[]> {
  let rows: Row[] = [];
  try {
    rows = await db.withRetry((sql) => sql`SELECT name, display_name, role, model, branch, tools, max_grant, state, state_note, archived_at FROM agent WHERE user_id = ${user()}`) as Row[];
  } catch (e) {
    if (!db.isDbError(e)) throw e;
  }
  const byName = new Map(rows.map((r) => [r.name, r]));
  const out: AgentDef[] = BUILTIN_AGENTS.map((b) => { const r = byName.get(b.name); return r ? fromRow(r, b) : { ...b }; });
  for (const r of rows) if (!BUILTIN_AGENTS.some((b) => b.name === r.name) && r.archived_at === null) out.push(fromRow(r));
  return out;
}

export async function get(name: string): Promise<AgentDef | undefined> {
  return (await all()).find((a) => a.name === name);
}

export async function byBranch(branch: string): Promise<AgentDef | undefined> {
  return (await all()).find((a) => a.branch === branch);
}

/** Write a built-in agent's row the first time one of its fields changes. */
async function ensureRow(def: AgentDef, now: number): Promise<void> {
  await db.withRetry((sql) => sql`
    INSERT INTO agent (user_id, name, display_name, role, model, branch, tools, max_grant, state, created_at, updated_at)
    VALUES (${user()}, ${def.name}, ${def.displayName}, ${def.role ?? ""}, ${def.model ?? null}, ${def.branch}, ${def.tools}, ${def.maxGrant}, 'idle', ${now}, ${now})
    ON CONFLICT (user_id, name) DO NOTHING`);
}

/** `orca agent state <state> [--note …]`: what the agent says it is doing. */
export async function setState(name: string, state: AgentStateName, note?: string, now = Date.now()): Promise<void> {
  if (!AGENT_STATES.includes(state) || state === "working") throw new Error("state: idle, waiting, blocked or done (Orca sets working itself)");
  const def = await get(name);
  if (!def) throw new Error(`no agent ${name}`);
  const clipped = note?.trim().slice(0, STATE_NOTE_MAX) || null;
  await ensureRow(def, now);
  await db.withRetry((sql) => sql`UPDATE agent SET state = ${state}, state_note = ${state === "idle" ? null : clipped}, updated_at = ${now} WHERE user_id = ${user()} AND name = ${name}`);
}

/** Pin the model an agent runs on (the composer's model picker). */
export async function setModel(name: string, model: string, now = Date.now()): Promise<void> {
  const def = await get(name);
  if (!def) throw new Error(`no agent ${name}`);
  await ensureRow(def, now);
  await db.withRetry((sql) => sql`UPDATE agent SET model = ${model}, updated_at = ${now} WHERE user_id = ${user()} AND name = ${name}`);
}

/** `orca agent add` (the user's alone): a new agent with the Assistant's verbs and no shell. */
export async function add(input: { name: string; displayName: string; role: string; model?: string }, now = Date.now()): Promise<AgentDef> {
  const name = input.name.trim();
  if (!AGENT_NAME_RE.test(name)) throw new Error("the name is a slug: lower case, a letter first, 2 to 31 characters (a-z, 0-9, -)");
  if (name === "orchestrator") throw new Error('"orchestrator" is the Chief of Staff\'s branch: choose another name');
  if (await get(name)) throw new Error(`an agent named ${name} exists`);
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error("--display is required: the name people see");
  if (!input.role.trim()) throw new Error("--role is required: the role text (--role @file reads a file)");
  const tools: AgentTools = { shell: false, verbs: [...ASSISTANT_VERBS] };
  await db.withRetry((sql) => sql`
    INSERT INTO agent (user_id, name, display_name, role, model, branch, tools, max_grant, state, created_at, updated_at)
    VALUES (${user()}, ${name}, ${displayName}, ${input.role.trim()}, ${input.model ?? null}, ${agentBranch(name)}, ${tools}, 'full', 'idle', ${now}, ${now})
    ON CONFLICT (user_id, name) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role, model = EXCLUDED.model,
      tools = EXCLUDED.tools, archived_at = NULL, updated_at = EXCLUDED.updated_at`);
  return (await get(name))!;
}

/** Archive a user-added agent. Its turns, memories and queue stay; a built-in agent stays. */
export async function remove(name: string, now = Date.now()): Promise<void> {
  if (BUILTIN_AGENTS.some((b) => b.name === name)) throw new Error(`${name} is built in and stays`);
  await db.withRetry((sql) => sql`UPDATE agent SET archived_at = ${now}, updated_at = ${now} WHERE user_id = ${user()} AND name = ${name}`);
}
