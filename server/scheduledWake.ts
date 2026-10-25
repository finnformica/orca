// Self-set wakes (`orca wake --at / --on`, docs/design/named-agents-and-memory.md §3.2; table:
// server/db.ts step 20261025-scheduled-wake; pure rules: shared/scheduledWake.ts).
//
// A time wake fires from the primary's minute tick (index.ts); an event wake fires when a matching
// event is published (router.onNewEvent, wired in index.ts). Either way the row is CLAIMED first
// (UPDATE … WHERE state = 'pending' RETURNING), so it fires once, and then delivered as a message to
// its agent through `deliver` — the orchestrator's report path, so MAX_WAKES and a pause apply.
import * as db from "./db";
import * as primary from "./primary";
import { CHIEF } from "../shared/memory";
import {
  WAKE_LIMITS, parseDuration, parseWakeAt, parseWakeOn, scheduledWakeMessage, wakeMatches, wakeOnText, type WakeEvent, type WakeOn,
} from "../shared/scheduledWake";

const user = () => db.currentUser();

export type ScheduledWake = {
  id: number; agent: string; fireAt?: number; on?: string; memoryId?: number; note: string;
  state: "pending" | "fired" | "cancelled" | "expired"; createdBy: string; createdRun?: string; createdAt: number; expiresAt: number;
  firedAt?: number; firedEvent?: string;
};

type Row = {
  id: string; agent: string; fire_at: string | null; on_event: string | null; memory_id: string | null; note: string; state: ScheduledWake["state"];
  created_by: string; created_run: string | null; created_at: string; expires_at: string; fired_at: string | null; fired_event: string | null;
};
const toWake = (r: Row): ScheduledWake => ({
  id: Number(r.id), agent: r.agent, ...(r.fire_at !== null ? { fireAt: Number(r.fire_at) } : {}), ...(r.on_event ? { on: r.on_event } : {}),
  ...(r.memory_id !== null ? { memoryId: Number(r.memory_id) } : {}), note: r.note, state: r.state, createdBy: r.created_by,
  ...(r.created_run ? { createdRun: r.created_run } : {}), createdAt: Number(r.created_at), expiresAt: Number(r.expires_at),
  ...(r.fired_at !== null ? { firedAt: Number(r.fired_at) } : {}), ...(r.fired_event ? { firedEvent: r.fired_event } : {}),
});

/** Hand a fired wake's message to its agent (index.ts: orchestrator.report with the agent's name). */
export type Deliver = (text: string, agent: string) => Promise<unknown>;

export async function add(input: { agent: string; at?: number; on?: WakeOn; note: string; memoryId?: number; expiresMs?: number; by: string; runId?: string }, now = Date.now()): Promise<ScheduledWake> {
  const note = input.note.trim();
  if (!note) throw new Error('--note is required: what to look at when it fires, in one line');
  if (note.length > WAKE_LIMITS.noteMax) throw new Error(`--note is limited to ${WAKE_LIMITS.noteMax} characters (got ${note.length}); put the detail in a memory and pass --memory <id>`);
  if ((input.at === undefined) === (input.on === undefined)) throw new Error("give exactly one of --at <time> and --on <event>");
  const expiresAt = input.at !== undefined ? input.at + WAKE_LIMITS.timeGraceMs : now + Math.min(input.expiresMs ?? WAKE_LIMITS.eventExpiryMs, WAKE_LIMITS.maxLeadMs);
  return db.withRetry(async (sql) => {
    let out: ScheduledWake | undefined;
    await sql.begin(async (tx: Bun.SQL) => {
      const [c] = await tx`SELECT count(*) AS n FROM scheduled_wake WHERE user_id = ${user()} AND agent = ${input.agent} AND state = 'pending'` as { n: string }[];
      if (Number(c?.n ?? 0) >= WAKE_LIMITS.pendingMax) throw new Error(`refused: ${WAKE_LIMITS.pendingMax} pending scheduled wakes is the limit. Cancel one first (orca wake list).`);
      if (input.memoryId !== undefined) {
        const [m] = await tx`SELECT id FROM memory WHERE user_id = ${user()} AND id = ${input.memoryId}` as unknown[];
        if (!m) throw new Error(`no memory m${input.memoryId}`);
      }
      const [row] = await tx`
        INSERT INTO scheduled_wake (user_id, agent, fire_at, on_event, memory_id, note, created_by, created_run, created_at, expires_at)
        VALUES (${user()}, ${input.agent}, ${input.at ?? null}, ${input.on ? wakeOnText(input.on) : null}, ${input.memoryId ?? null}, ${note},
          ${input.by}, ${input.runId ?? null}, ${now}, ${expiresAt})
        RETURNING *` as Row[];
      out = toWake(row!);
    });
    return out!;
  });
}

export async function list(o: { agent?: string; all?: boolean; memoryId?: number } = {}): Promise<ScheduledWake[]> {
  const rows = await db.withRetry((sql) => sql`
    SELECT * FROM scheduled_wake WHERE user_id = ${user()}
      ${o.agent ? sql`AND agent = ${o.agent}` : sql``}
      ${o.all ? sql`` : sql`AND state = 'pending'`}
      ${o.memoryId !== undefined ? sql`AND memory_id = ${o.memoryId}` : sql``}
    ORDER BY (state = 'pending') DESC, coalesce(fire_at, expires_at), id LIMIT 200`) as Row[];
  return rows.map(toWake);
}

export async function cancel(id: number, agent?: string): Promise<ScheduledWake | undefined> {
  const [row] = await db.withRetry((sql) => sql`
    UPDATE scheduled_wake SET state = 'cancelled' WHERE user_id = ${user()} AND id = ${id} AND state = 'pending'
      ${agent ? sql`AND agent = ${agent}` : sql``}
    RETURNING *`) as Row[];
  return row && toWake(row);
}

/** Expire what can no longer fire: an event wake past its expiry, a time wake a day late. */
export async function expire(now = Date.now()): Promise<number> {
  const rows = await db.withRetry((sql) => sql`
    UPDATE scheduled_wake SET state = 'expired' WHERE user_id = ${user()} AND state = 'pending' AND expires_at < ${now} RETURNING id`) as unknown[];
  return rows.length;
}

/** Claim every time wake that is due. Each row is claimed once, whoever asks. */
export async function claimDue(now = Date.now()): Promise<ScheduledWake[]> {
  const rows = await db.withRetry((sql) => sql`
    UPDATE scheduled_wake SET state = 'fired', fired_at = ${now}
    WHERE user_id = ${user()} AND state = 'pending' AND fire_at IS NOT NULL AND fire_at <= ${now} AND expires_at >= ${now}
    RETURNING *`) as Row[];
  return rows.map(toWake).sort((a, b) => (a.fireAt ?? 0) - (b.fireAt ?? 0) || a.id - b.id);
}

/** Claim every event wake that `e` matches. */
export async function claimMatching(e: WakeEvent & { key?: string }, now = Date.now()): Promise<ScheduledWake[]> {
  const pending = await db.withRetry((sql) => sql`
    SELECT * FROM scheduled_wake WHERE user_id = ${user()} AND state = 'pending' AND on_event IS NOT NULL AND expires_at >= ${now}`) as Row[];
  // `agent:<name>` waits for the reply to ITS OWN ask: the finished wake must have carried one from it.
  const hits = pending.map(toWake).filter((w) => {
    try {
      const on = parseWakeOn(w.on!);
      return wakeMatches(on, e) && (on.kind !== "agent" || (e.askers ?? []).includes(w.agent));
    } catch { return false; }
  });
  const claimed: ScheduledWake[] = [];
  for (const w of hits) {
    const [row] = await db.withRetry((sql) => sql`
      UPDATE scheduled_wake SET state = 'fired', fired_at = ${now}, fired_event = ${e.key ?? e.topic}
      WHERE user_id = ${user()} AND id = ${w.id} AND state = 'pending' RETURNING *`) as Row[];
    if (row) claimed.push(toWake(row));
  }
  return claimed;
}

/** The message a fired wake queues for its agent. */
export const messageOf = (w: ScheduledWake, event?: string): string =>
  scheduledWakeMessage({ id: w.id, note: w.note, ...(w.memoryId ? { memoryId: w.memoryId } : {}), ...(w.on ? { on: w.on, ...(event ? { event } : {}) } : { at: w.fireAt }) });

/** Deliver claimed wakes, each to its own agent. A failure is logged, never thrown: the row stays
 *  fired, so a broken delivery cannot loop. */
async function deliverAll(wakes: ScheduledWake[], deliver: Deliver, event?: string): Promise<void> {
  for (const w of wakes) {
    await deliver(messageOf(w, event), w.agent).catch(db.logUnlessDown(`orca: scheduled wake w${w.id} could not be delivered`));
  }
}

/** The primary's minute tick: expire, then fire what is due. */
export async function tick(deliver: Deliver, now = Date.now()): Promise<ScheduledWake[]> {
  if (!primary.held()) return [];
  await expire(now);
  const due = await claimDue(now);
  await deliverAll(due, deliver);
  return due;
}

/** A new event was published: fire the event wakes it matches. Not in a preview bridge. */
export async function onEvent(e: WakeEvent & { key?: string }, deliver: Deliver, now = Date.now()): Promise<ScheduledWake[]> {
  if (!primary.held()) return [];
  const hits = await claimMatching(e, now);
  await deliverAll(hits, deliver, e.topic);
  return hits;
}

// ── `orca wake` ────────────────────────────────────────────────────────────────────────────────

const when = (w: ScheduledWake) => w.on ? `on ${w.on} (expires ${new Date(w.expiresAt).toISOString().slice(0, 10)})` : `at ${new Date(w.fireAt ?? 0).toISOString().slice(0, 16).replace("T", " ")} UTC`;
export const wakeLine = (w: ScheduledWake): string =>
  `w${w.id} ${w.state === "pending" ? "" : `[${w.state}] `}${when(w)}${w.agent !== CHIEF ? ` for ${w.agent}` : ""}${w.memoryId ? ` · memory m${w.memoryId}` : ""} — ${w.note}`;

export const WAKE_USAGE = [
  'orca wake --at "<time>" --note "<what to look at>" [--memory <id>]',
  'orca wake --on "<event>" --note "<…>" [--memory <id>] [--expires 14d]   (pr:… | worker:… | agent:<name> | topic:…)',
  "orca wake list [--all]",
  "orca wake cancel <id>",
].join("\n");

/** `orca wake …` for an agent. Another agent's queue only for the Chief of Staff. `known` are the
 *  agents that exist (server/agents.ts); none given = the Chief of Staff alone. */
export async function wakeTool(agent: string, words: string[], args: Record<string, unknown>, runId?: string, now = Date.now(), known: string[] = [CHIEF]): Promise<string> {
  const [sub = ""] = words;
  if (sub === "list") {
    const rows = await list({ ...(agent === CHIEF ? {} : { agent }), all: args.all !== undefined });
    return rows.map(wakeLine).join("\n") || "No pending scheduled wakes.";
  }
  if (sub === "cancel") {
    const id = Number(String(words[1] ?? "").replace(/^w/, ""));
    if (!Number.isInteger(id) || id <= 0) throw new Error("orca wake cancel <id> (the w-number from orca wake list)");
    const w = await cancel(id, agent === CHIEF ? undefined : agent);
    return w ? `Cancelled w${w.id}.` : `No pending scheduled wake w${id}.`;
  }
  if (sub) throw new Error(`unknown wake command "${sub}". Commands:\n${WAKE_USAGE}`);
  const target = typeof args.agent === "string" && args.agent ? args.agent : agent;
  if (target !== agent && agent !== CHIEF) throw new Error("only the Chief of Staff sets a wake for another agent");
  if (!known.includes(target)) throw new Error(`there is no agent "${target}" (agents: ${known.join(", ")})`);
  const at = typeof args.at === "string" && args.at ? parseWakeAt(args.at, now) : undefined;
  const on = typeof args.on === "string" && args.on ? parseWakeOn(args.on) : undefined;
  const expiresMs = typeof args.expires === "string" ? parseDuration(args.expires) : undefined;
  if (args.expires !== undefined && expiresMs === undefined) throw new Error("--expires takes a length: 3d, 2w, 12h");
  const memoryId = args.memory === undefined ? undefined : Number(String(args.memory).replace(/^m/, ""));
  if (memoryId !== undefined && !(Number.isInteger(memoryId) && memoryId > 0)) throw new Error("--memory takes a memory id (m12 or 12)");
  const w = await add({ agent: target, ...(at !== undefined ? { at } : {}), ...(on ? { on } : {}), note: typeof args.note === "string" ? args.note : "", ...(memoryId ? { memoryId } : {}), ...(expiresMs ? { expiresMs } : {}), by: `agent:${agent}`, runId }, now);
  return `Set ${wakeLine(w)}. It wakes you with the note; nothing else does.`;
}
