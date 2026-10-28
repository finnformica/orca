// Named agents: the store. Table `agent` (server/db.ts steps 20261025-team-agents and
// 20261027-agent-definitions) is the single source of truth for every agent: name, display name,
// role text, model, tools (shell flag + verbs) and max grant. Nothing in code adds to or overrides a
// row, and no agent is special: any row may be archived but the last one. The seed
// (server/agentSeed.ts) wrote the Chief of Staff, the Assistant and Research once; the user edits,
// adds and archives agents in Settings > Agents. What names no agent goes to `defaultAgent()`.
//
// The ONE fallback: with the database down (or no row at all), `all()` answers FALLBACK_CHIEF
// (shared/agents.ts) — identity only, no shell, no verbs, no role. A wake needs the database anyway.
//
// The run state (session, the wake in flight, the wake count) stays in each agent's workstream
// blob, as the orchestrator's always did — so this module moves no runtime state.
import * as db from "./db";
import { loadConfig } from "./config";
import {
  AGENT_NAME_RE, AGENT_STATES, FALLBACK_CHIEF, STATE_NOTE_MAX, agentBranch, defaultAgentName, toolsProblem,
  type AgentDef, type AgentStateName, type AgentTools,
} from "../shared/agents";
import type { Level } from "../shared/integrations";

const user = () => db.currentUser();

type Row = {
  name: string; display_name: string; role: string; model: string | null; branch: string; tools: AgentTools | null;
  max_grant: Level; state: AgentStateName; state_note: string | null;
};

/** A row as a definition. A row whose tools are malformed gets none (no shell, no verbs): a broken
 *  row never widens what an agent may run. */
const fromRow = (r: Row): AgentDef => ({
  name: r.name, displayName: r.display_name, branch: r.branch,
  ...(r.role ? { role: r.role } : {}),
  ...(r.model ? { model: r.model } : {}),
  tools: toolsProblem(r.tools) ? { shell: false, verbs: [] } : r.tools!,
  maxGrant: r.max_grant, state: r.state, ...(r.state_note ? { stateNote: r.state_note } : {}),
});

/** Every active agent, oldest first (the seed's rows first). Read on every call (no cache): an edit
 *  in Settings applies to the next `orca` call and the next wake. */
export async function all(): Promise<AgentDef[]> {
  let rows: Row[];
  try {
    rows = await db.withRetry((sql) => sql`
      SELECT name, display_name, role, model, branch, tools, max_grant, state, state_note FROM agent
      WHERE user_id = ${user()} AND archived_at IS NULL
      ORDER BY created_at, name`) as Row[];
  } catch (e) {
    if (!db.isDbError(e)) throw e;
    return [{ ...FALLBACK_CHIEF }];
  }
  // No row at all (a database before the seed): the fallback, which may run nothing.
  return rows.length ? rows.map(fromRow) : [{ ...FALLBACK_CHIEF }];
}

/** The agent that gets what names no agent (Settings > Agents' default, else the first active one).
 *  `given`: the caller's config, so the answer agrees with the rest of its request. */
export async function defaultAgent(given?: { agents?: { default?: string } }): Promise<AgentDef> {
  const list = await all();
  const cfg = given ?? await loadConfig().catch(() => ({}));
  const name = defaultAgentName(cfg, list.map((a) => a.name));
  return list.find((a) => a.name === name) ?? list[0]!;
}

export async function get(name: string): Promise<AgentDef | undefined> {
  return (await all()).find((a) => a.name === name);
}

export async function byBranch(branch: string): Promise<AgentDef | undefined> {
  return (await all()).find((a) => a.branch === branch);
}

async function must(name: string): Promise<AgentDef> {
  const def = await get(name);
  if (!def) throw new Error(`no agent ${name}`);
  return def;
}

/** `orca agent state <state> [--note …]`: what the agent says it is doing. */
export async function setState(name: string, state: AgentStateName, note?: string, now = Date.now()): Promise<void> {
  if (!AGENT_STATES.includes(state) || state === "working") throw new Error("state: idle, waiting, blocked or done (Orca sets working itself)");
  await must(name);
  const clipped = note?.trim().slice(0, STATE_NOTE_MAX) || null;
  await db.withRetry((sql) => sql`UPDATE agent SET state = ${state}, state_note = ${state === "idle" ? null : clipped}, updated_at = ${now} WHERE user_id = ${user()} AND name = ${name}`);
}

/** Pin the model an agent runs on (the composer's model picker). */
export async function setModel(name: string, model: string, now = Date.now()): Promise<void> {
  await must(name);
  await db.withRetry((sql) => sql`UPDATE agent SET model = ${model}, updated_at = ${now} WHERE user_id = ${user()} AND name = ${name}`);
}

/** Add an agent (the user's alone: Settings > Agents, or `orca agent add` on the user's own word).
 *  With no `tools` it gets what every seeded agent got: a shell and every verb (Finn: every named
 *  agent has the same power). The user narrows it in Settings. */
export async function add(input: { name: string; displayName: string; role: string; model?: string; tools?: AgentTools }, now = Date.now()): Promise<AgentDef> {
  const name = input.name.trim();
  if (!AGENT_NAME_RE.test(name)) throw new Error("the name is a slug: lower case, a letter first, 2 to 31 characters (a-z, 0-9, -)");
  if (name === "orchestrator") throw new Error('"orchestrator" is the Chief of Staff\'s branch: choose another name');
  if (await get(name)) throw new Error(`an agent named ${name} exists`);
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error("--display is required: the name people see");
  if (!input.role.trim()) throw new Error("--role is required: the role text (--role @file reads a file)");
  const tools: AgentTools = input.tools ?? { shell: true, verbs: "all" };
  const problem = toolsProblem(tools);
  if (problem) throw new Error(problem);
  await db.withRetry((sql) => sql`
    INSERT INTO agent (user_id, name, display_name, role, model, branch, tools, max_grant, state, created_at, updated_at)
    VALUES (${user()}, ${name}, ${displayName}, ${input.role.trim()}, ${input.model || null}, ${agentBranch(name)}, ${tools}, 'full', 'idle', ${now}, ${now})
    ON CONFLICT (user_id, name) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role, model = EXCLUDED.model,
      tools = EXCLUDED.tools, state = 'idle', state_note = NULL, archived_at = NULL, updated_at = EXCLUDED.updated_at`);
  return must(name);
}

/** The fields Settings > Agents edits. An absent field stays; `model: null` clears the pin. */
export type AgentEdit = { displayName?: string; role?: string; model?: string | null; tools?: AgentTools };

/** Edit an agent's row (Settings > Agents only: no `orca` verb reaches this, so no agent widens its
 *  own or another agent's tools). It applies at once: the next `orca` call is checked against it, and
 *  the next session start sends the new role. */
export async function edit(name: string, patch: AgentEdit, now = Date.now()): Promise<AgentDef> {
  const def = await must(name);
  const displayName = patch.displayName === undefined ? def.displayName : patch.displayName.trim();
  if (!displayName) throw new Error("the display name is required");
  const role = patch.role === undefined ? def.role ?? "" : patch.role.trim();
  if (!role) throw new Error("the role text is required");
  const model = patch.model === undefined ? def.model ?? null : patch.model || null;
  const tools = patch.tools ?? def.tools;
  const problem = toolsProblem(tools);
  if (problem) throw new Error(problem);
  await db.withRetry((sql) => sql`
    UPDATE agent SET display_name = ${displayName}, role = ${role}, model = ${model}, tools = ${tools}, updated_at = ${now}
    WHERE user_id = ${user()} AND name = ${name}`);
  return must(name);
}

/** Archive an agent. Its turns, memories and queue stay. Any agent may go, the Chief of Staff
 *  included, but not the last active one: something must take what names no agent. */
export async function remove(name: string, now = Date.now()): Promise<void> {
  await must(name);
  const archived = await db.withRetry((sql) => sql`
    UPDATE agent SET archived_at = ${now}, updated_at = ${now}
    WHERE user_id = ${user()} AND name = ${name} AND archived_at IS NULL
      AND (SELECT count(*) FROM agent WHERE user_id = ${user()} AND archived_at IS NULL) > 1
    RETURNING name`) as unknown[];
  if (!archived.length) throw new Error(`${name} is the last agent: add another before you archive it`);
}
