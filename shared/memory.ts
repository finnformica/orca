// The agents' memory: the pure rules (docs/design/named-agents-and-memory.md). The store is
// server/memory.ts; this file has no I/O, so the server, the Memory page and the tests share it.
//
// A memory is generic: a title, a body in the agent's own words, tags and an importance. There is no
// kind. A decision, a fact, a task or a lesson is one only by its words and tags.

export const SHARED = "shared";
/** The current orchestrator's name as a memory owner. PR B makes it the Chief of Staff's agent name. */
export const CHIEF = "chief";

export type MemoryState = "active" | "archived" | "forgotten";
export type Trust = "trusted" | "untrusted";
export const MEMORY_STATES: readonly MemoryState[] = ["active", "archived", "forgotten"];

export type Memory = {
  id: number;
  owner: string;
  title: string;
  body: string;
  tags: string[];
  importance: number;
  pinned: boolean;
  source: string;
  trust: Trust;
  state: MemoryState;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
  recallCount: number;
  lastRecalledAt?: number;
};

export type MemoryRevision = {
  memoryId: number;
  revision: number;
  title: string;
  body: string;
  tags: string[];
  importance: number;
  pinned: boolean;
  source: string;
  trust: Trust;
  state: MemoryState;
  owner: string;
  by: string;
  reason?: string;
  runId?: string;
  at: number;
};

export type MemoryLink = { fromId: number; toId: number; relation: string; by: string; at: number };

/** Sizes and rates. Constants, not config: one becomes config the first time it needs tuning. The
 *  object is mutable only so a test can lower a rate limit. */
export const MEMORY_LIMITS = {
  titleMax: 120,
  bodyMax: 4000,
  tagsMax: 12,
  tagMax: 40,
  reasonMax: 200,
  relationMax: 40,
  /** Memory changes by one agent in one wake. */
  perWake: 20,
  /** Memory changes by one agent in 24 hours. */
  perDay: 200,
  /** Active memories one owner may hold. */
  activeMax: 2000,
};

/** The owners an agent may change: its own memories and the shared ones. */
export const mayWrite = (agent: string, owner: string): boolean => owner === agent || owner === SHARED;

/** A title as the duplicate check compares it: lower case, letters and digits only, one space. */
export const normTitle = (t: string): string =>
  t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

/** Tags as stored: trimmed, lower case, spaces as dashes, no duplicates, in the order given. */
export function cleanTags(tags: unknown): string[] {
  const list = (Array.isArray(tags) ? tags : tags === undefined || tags === "" ? [] : [tags]).flatMap((t) => String(t).split(","));
  const out: string[] = [];
  for (const t of list) {
    const tag = t.trim().toLowerCase().replace(/\s+/g, "-");
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export type MemoryFields = { title?: string; body?: string; tags?: string[]; importance?: number };

/** Every problem with the fields of a write or a revise, in one list, for the model to fix at once. */
export function memoryProblems(f: MemoryFields, opts: { needAll?: boolean } = {}): string[] {
  const p: string[] = [];
  if (opts.needAll || f.title !== undefined) {
    if (!f.title?.trim()) p.push("--title is required");
    else if (f.title.length > MEMORY_LIMITS.titleMax) p.push(`--title is limited to ${MEMORY_LIMITS.titleMax} characters (got ${f.title.length})`);
  }
  if (opts.needAll || f.body !== undefined) {
    if (!f.body?.trim()) p.push("--body is required");
    else if (f.body.length > MEMORY_LIMITS.bodyMax) p.push(`--body is limited to ${MEMORY_LIMITS.bodyMax} characters (got ${f.body.length}); split it into linked memories`);
  }
  if (f.tags) {
    if (f.tags.length > MEMORY_LIMITS.tagsMax) p.push(`at most ${MEMORY_LIMITS.tagsMax} tags (got ${f.tags.length})`);
    const long = f.tags.find((t) => t.length > MEMORY_LIMITS.tagMax);
    if (long) p.push(`a tag is limited to ${MEMORY_LIMITS.tagMax} characters ("${long.slice(0, 20)}…")`);
  }
  if (f.importance !== undefined && !(Number.isInteger(f.importance) && f.importance >= 1 && f.importance <= 10)) p.push("--importance must be a whole number from 1 to 10");
  return p;
}

/** The importance a flag gives, or undefined when the flag is absent. A bad value stays a number,
 *  so memoryProblems names it. */
export const importanceOf = (v: unknown): number | undefined => (v === undefined || v === "" ? undefined : Number(v));

// ── Trust: set by the server from the wake, never by the agent (§6) ─────────────────────────────────

/** What the server knows about the wake that writes. */
export type WakeContext = {
  agent: string;
  /** The wake in flight: its run id, for the per-wake limit and the revision's `run_id`. */
  runId?: string;
  /** The wake's grant level when an outside sender caused it (`wakeGrant`); absent = the user's own. */
  grantLevel?: string;
  /** The messages the wake is handling. */
  messages: string[];
  /** Tool calls the wake has made so far (name and command), for an outside read. */
  steps: { name?: string; command?: string }[];
  /** Workstreams an outside sender started or steered (`grantScope` on their enrichment). */
  scopedWorkstreams: Set<string>;
  /** The agent passed `--untrusted`. */
  untrusted?: boolean;
};

export type Provenance = { source: string; trust: Trust };

const EXTERNAL_LINE = /^\[external message\] via (\S+)(?: link (\S+))?/m;
const WORKER_LINE = /^\[worker finished\] ([^/\s]+)\/(\S+)/;
/** `orca` reads of outside text, and the web: what such a call returns is not the user's word. */
const OUTSIDE_READ = /\borca\s+(slack\s+(read|search|conversations)|gmail\s+(read|search)|cloudflare\s+audit)\b/;
const OUTSIDE_TOOLS = new Set(["WebFetch", "WebSearch"]);

/** The repo/branch a worker report is about, or undefined. */
export function reportWorkstream(message: string): { repo: string; branch: string } | undefined {
  const m = message.match(WORKER_LINE);
  return m ? { repo: m[1]!, branch: m[2]! } : undefined;
}

/** Where a memory written in this wake comes from, and whether it can be trusted. Outside text in the
 *  wake makes it untrusted: an outside sender's message, a worker that an outside sender steered, an
 *  outside read by the agent, or `--untrusted`. Otherwise it is the agent's own: trusted. */
export function provenance(w: WakeContext): Provenance {
  const external = w.messages.map((m) => m.match(EXTERNAL_LINE)).find(Boolean);
  if (external) return { source: `outside:${external[1]}${external[2] ? `:${external[2]}` : ""}`, trust: "untrusted" };
  if (w.grantLevel) return { source: "outside:grant", trust: "untrusted" };
  for (const m of w.messages) {
    const ws = reportWorkstream(m);
    if (ws && w.scopedWorkstreams.has(`${ws.repo}::${ws.branch}`)) return { source: `outside:worker:${ws.repo}/${ws.branch}`, trust: "untrusted" };
  }
  for (const s of w.steps) {
    if (s.name && OUTSIDE_TOOLS.has(s.name)) return { source: `outside:${s.name.toLowerCase()}`, trust: "untrusted" };
    const read = s.command?.match(OUTSIDE_READ);
    if (read) return { source: `outside:${read[1]!.split(/\s+/)[0]}`, trust: "untrusted" };
  }
  if (w.untrusted) return { source: `outside:agent:${w.agent}`, trust: "untrusted" };
  return { source: `agent:${w.agent}`, trust: "trusted" };
}

/** A change keeps the lower trust: an untrusted wake that edits a trusted memory makes it untrusted;
 *  a trusted wake never makes an untrusted one trusted (only the user does, on the Memory page). */
export function changedProvenance(current: Provenance, wake: Provenance): Provenance {
  return wake.trust === "untrusted" ? wake : current;
}

// ── Ranking (Generative Agents: relevance, importance, recency) ────────────────────────────────────

const DAY = 86_400_000;
export const RECENCY_HALF_LIFE_MS = 14 * DAY;

/** 1 when just touched, 0.5 after 14 days, from the newer of an update and a recall. */
export function recency(m: Pick<Memory, "updatedAt" | "lastRecalledAt">, now: number): number {
  const at = Math.max(m.updatedAt, m.lastRecalledAt ?? 0);
  return Math.pow(0.5, Math.max(0, now - at) / RECENCY_HALF_LIFE_MS);
}

/** What keeps a memory in the core: importance first, then recency, then how often it was recalled. */
export function coreScore(m: Pick<Memory, "importance" | "updatedAt" | "lastRecalledAt" | "recallCount">, now: number): number {
  return m.importance / 10 + 0.5 * recency(m, now) + 0.2 * Math.min(1, m.recallCount / 20);
}

/** A search hit's rank: mostly the full-text match (`ts_rank_cd`, normalised to 0..1), then
 *  importance and recency. */
export function recallScore(rank: number, m: Pick<Memory, "importance" | "updatedAt" | "lastRecalledAt">, now: number): number {
  const r = rank / (1 + rank);
  return 0.6 * r + 0.25 * (m.importance / 10) + 0.15 * recency(m, now);
}

// ── Text the `orca memory` verbs print ─────────────────────────────────────────────────────────────

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/** One memory as a block: its id and revision first, so a revise needs no second read. */
export function memoryBlock(m: Memory, opts: { bodyChars?: number; cutNote?: boolean } = {}): string {
  const cut = opts.bodyChars !== undefined && m.body.length > opts.bodyChars;
  const body = cut ? `${m.body.slice(0, opts.bodyChars).trimEnd()}…${opts.cutNote ? ` (cut: orca memory show ${m.id})` : ""}` : m.body;
  const flags = [m.owner, `importance ${m.importance}`, ...(m.pinned ? ["pinned"] : []), ...(m.trust === "untrusted" ? ["UNTRUSTED"] : []), ...(m.state !== "active" ? [m.state] : [])];
  return [
    `[m${m.id} r${m.revision}] ${m.title} (${flags.join(", ")})`,
    `  ${m.tags.length ? `tags: ${m.tags.join(", ")}  ·  ` : ""}updated ${day(m.updatedAt)} by ${m.updatedBy}  ·  source ${m.source}`,
    ...body.split("\n").map((l) => `  ${l}`),
  ].join("\n");
}

export function revisionLine(r: MemoryRevision): string {
  return `r${r.revision} ${new Date(r.at).toISOString().slice(0, 16).replace("T", " ")} by ${r.by}${r.runId ? ` (run ${r.runId})` : ""} — ${r.state}${r.pinned ? ", pinned" : ""}${r.trust === "untrusted" ? ", untrusted" : ""}: ${r.reason ?? "(no reason)"}`;
}
