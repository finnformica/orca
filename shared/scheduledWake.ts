// Self-set wakes (`orca wake`, docs/design/named-agents-and-memory.md §3.2): the pure rules. The
// store and the firing are server/scheduledWake.ts. "A wake" is one run of an agent; "a scheduled
// wake" is a row that starts one later — at a time, or on an event.
import { topicMatches } from "./integrations";

export const SCHEDULED_WAKE_MARKER = "[scheduled wake]";
export const isScheduledWake = (text: string): boolean => text.startsWith(SCHEDULED_WAKE_MARKER);

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const WAKE_LIMITS = {
  pendingMax: 50,
  noteMax: 300,
  minLeadMs: 5 * MIN,
  maxLeadMs: 90 * DAY,
  /** An event wake expires after this unless --expires says otherwise (at most maxLeadMs). */
  eventExpiryMs: 14 * DAY,
  /** A time wake not fired this long after its time (the bridge was down) expires. */
  timeGraceMs: DAY,
};

export type WakeOn =
  | { kind: "pr"; repo: string; pr: number; event?: string }
  | { kind: "worker"; repo: string; branch: string }
  | { kind: "topic"; pattern: string; repo?: string }
  /** Another agent's next reply (`orca ask` then wait for it, PR B): its next finished wake. */
  | { kind: "agent"; agent: string };

/** A length of time: `90m`, `2h`, `3d`, `1w` (also `+2h`). Undefined when it is not one. */
export function parseDuration(text: string): number | undefined {
  const m = text.trim().match(/^\+?(\d+)\s*(m|min|h|d|w)$/i);
  if (!m) return undefined;
  const n = Number(m[1]), unit = m[2]!.toLowerCase();
  return n * (unit === "w" ? 7 * DAY : unit === "d" ? DAY : unit === "h" ? HOUR : MIN);
}

/** `--at`: a length from now (`2h`), `today 17:00` / `tomorrow 09:00` (the server's local time), or
 *  an ISO time (`2026-10-27T09:00`, local unless it has an offset or `Z`). Between 5 minutes and 90
 *  days from now. */
export function parseWakeAt(text: string, now: number): number {
  const t = text.trim();
  let at: number | undefined;
  const lead = parseDuration(t);
  if (lead !== undefined) at = now + lead;
  const day = t.match(/^(today|tomorrow)\s+(\d{1,2}):(\d{2})$/i);
  if (day) {
    const d = new Date(now);
    d.setHours(Number(day[2]), Number(day[3]), 0, 0);
    if (day[1]!.toLowerCase() === "tomorrow") d.setDate(d.getDate() + 1);
    at = d.getTime();
  }
  if (at === undefined && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?(Z|[+-]\d{2}:?\d{2})?$/.test(t)) {
    const parsed = Date.parse(t.replace(" ", "T"));
    if (!Number.isNaN(parsed)) at = parsed;
  }
  if (at === undefined) throw new Error(`--at "${t}" is not a time: use 2h, 3d, "tomorrow 09:00" or an ISO time like 2026-10-27T09:00`);
  if (at < now + WAKE_LIMITS.minLeadMs) throw new Error(`--at must be at least 5 minutes from now (got ${new Date(at).toISOString()})`);
  if (at > now + WAKE_LIMITS.maxLeadMs) throw new Error("--at must be at most 90 days from now");
  return at;
}

const PR_EVENTS = ["merged", "ci_failed", "conflicts", "merge_refused"];

/** `--on`: `pr:<repo>#<n>[:merged|ci_failed|conflicts|merge_refused]`, `worker:<repo>/<branch>` (its
 *  next run result: finished, failed, stopped, needs input, check failed), or
 *  `topic:<topic pattern>[ repo=<repo>]` (any event, as a subscription matches it). */
export function parseWakeOn(text: string): WakeOn {
  const t = text.trim();
  const pr = t.match(/^pr:([^#\s]+)#(\d+)(?::([a-z_]+))?$/);
  if (pr) {
    if (pr[3] && !PR_EVENTS.includes(pr[3])) throw new Error(`--on pr:…:${pr[3]} is not a PR event (${PR_EVENTS.join(", ")})`);
    return { kind: "pr", repo: pr[1]!, pr: Number(pr[2]), ...(pr[3] ? { event: pr[3] } : {}) };
  }
  const worker = t.match(/^worker:([^/\s]+)\/(\S+)$/);
  if (worker) return { kind: "worker", repo: worker[1]!, branch: worker[2]! };
  const topic = t.match(/^topic:(\S+)(?:\s+repo=(\S+))?$/);
  if (topic) return { kind: "topic", pattern: topic[1]!, ...(topic[2] ? { repo: topic[2] } : {}) };
  const agent = t.match(/^agent:([a-z][a-z0-9-]*)$/);
  if (agent) return { kind: "agent", agent: agent[1]! };
  throw new Error(`--on "${t}" is not an event: use pr:<repo>#<n>[:merged], worker:<repo>/<branch>, agent:<name> or topic:<pattern>[ repo=<repo>]`);
}

export function wakeOnText(on: WakeOn): string {
  if (on.kind === "pr") return `pr:${on.repo}#${on.pr}${on.event ? `:${on.event}` : ""}`;
  if (on.kind === "worker") return `worker:${on.repo}/${on.branch}`;
  if (on.kind === "agent") return `agent:${on.agent}`;
  return `topic:${on.pattern}${on.repo ? ` repo=${on.repo}` : ""}`;
}

/** The part of an event the match reads (an integrations Envelope fits). */
export type WakeEvent = { topic: string; scope?: { repo?: string; branch?: string }; link?: { pr?: number }; /** The agent whose wake ended (`orca.agent.replied`), and the agents whose `orca ask` it answered. */ agent?: string; askers?: string[] };
/** The event an agent's finished wake raises for `--on agent:<name>` (server/orchestrator.ts). */
export const AGENT_REPLIED = "orca.agent.replied";

export function wakeMatches(on: WakeOn, e: WakeEvent): boolean {
  if (on.kind === "pr") {
    return e.topic.startsWith("orca.pr.") && e.scope?.repo === on.repo && e.link?.pr === on.pr && (!on.event || e.topic === `orca.pr.${on.event}`);
  }
  if (on.kind === "worker") return e.topic.startsWith("orca.run.") && e.scope?.repo === on.repo && e.scope?.branch === on.branch;
  if (on.kind === "agent") return e.topic === AGENT_REPLIED && e.agent === on.agent;
  return topicMatches(on.pattern, e.topic) && (!on.repo || e.scope?.repo === on.repo);
}

/** A fired scheduled wake as the message it queues: the marker line, then the agent's own note. */
export type FiredWakeMessage = { id: number; note: string; memoryId?: number; on?: string; at?: number; event?: string };

export function scheduledWakeMessage(w: FiredWakeMessage): string {
  const when = w.on ? `on ${w.on}${w.event ? ` (${w.event})` : ""}` : `at ${new Date(w.at ?? 0).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `${SCHEDULED_WAKE_MARKER} w${w.id} · ${when}${w.memoryId ? ` · memory m${w.memoryId}` : ""}\n${w.note}`;
}

export function parseScheduledWake(message: string): FiredWakeMessage | undefined {
  const m = message.match(/^\[scheduled wake\] w(\d+) · (?:on ([^·(\n]+?)(?: \(([^)]*)\))?|at ([^·\n]+?))(?: · memory m(\d+))?\n([\s\S]*)$/);
  if (!m) return undefined;
  return {
    id: Number(m[1]), note: m[6]!.trim(),
    ...(m[2] ? { on: m[2] } : {}), ...(m[3] ? { event: m[3] } : {}),
    ...(m[4] ? { at: Date.parse(`${m[4].replace(/\s*UTC\s*$/, "").trim().replace(" ", "T")}Z`) } : {}),
    ...(m[5] ? { memoryId: Number(m[5]) } : {}),
  };
}
