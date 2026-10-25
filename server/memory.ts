// The agents' memory store (docs/design/named-agents-and-memory.md; tables: server/db.ts step
// 20261025-memory; pure rules: shared/memory.ts). Every query goes through db.withRetry.
//
// Every change is one transaction: lock the row, check, update it, append a `memory_revision`. No
// code updates or deletes a revision, so the history is complete and a revert is a new revision.
// The server, not the agent, decides a memory's source and trust (`provenance`).
import * as db from "./db";
import {
  CHIEF, MEMORY_BUDGET, REFLECTION, coreScore, similarPairs, type ReflectionInput, MEMORY_LIMITS, SHARED, changedProvenance, cleanTags, fitRecall, importanceOf, mayWrite, memoryBlock, memoryProblems, memorySection,
  normTitle, notesMovedNotice, recallScore, revisionLine, selectCore, splitNotes,
  type CoreSelection, type FiredWake, type Memory, type MemoryLink, type MemoryRevision, type MemoryState, type NotesPart, type Provenance, type Trust,
} from "../shared/memory";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO } from "../web/src/workstream";

const user = () => db.currentUser();

/** A refusal written for the model (or the page) to act on. `status` is the HTTP answer. */
export class MemoryError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Who makes a change. An agent's change carries its wake's provenance; the user's is trusted. */
export type Actor =
  | { kind: "agent"; agent: string; runId?: string; prov: Provenance; /** Changes allowed in this wake (a reflection: 40). */ maxPerWake?: number }
  | { kind: "user" }
  | { kind: "migration" };

const byOf = (a: Actor): string => (a.kind === "agent" ? `agent:${a.agent}` : a.kind);

type Row = {
  id: string | number; owner: string; title: string; body: string; tags: string[] | null; importance: number; pinned: boolean;
  source: string; trust: Trust; state: MemoryState; revision: number; created_by: string; updated_by: string;
  created_at: string | number; updated_at: string | number; recall_count: number; last_recalled_at: string | number | null;
};
const COLS = "id, owner, title, body, tags, importance, pinned, source, trust, state, revision, created_by, updated_by, created_at, updated_at, recall_count, last_recalled_at";
const toMemory = (r: Row): Memory => ({
  id: Number(r.id), owner: r.owner, title: r.title, body: r.body, tags: r.tags ?? [], importance: Number(r.importance), pinned: r.pinned,
  source: r.source, trust: r.trust, state: r.state, revision: Number(r.revision), createdBy: r.created_by, updatedBy: r.updated_by,
  createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), recallCount: Number(r.recall_count),
  ...(r.last_recalled_at !== null ? { lastRecalledAt: Number(r.last_recalled_at) } : {}),
});

type RevRow = {
  memory_id: string | number; revision: number; title: string; body: string; tags: string[] | null; importance: number; pinned: boolean;
  source: string; trust: Trust; state: MemoryState; owner: string; by: string; reason: string | null; run_id: string | null; at: string | number;
};
const toRevision = (r: RevRow): MemoryRevision => ({
  memoryId: Number(r.memory_id), revision: Number(r.revision), title: r.title, body: r.body, tags: r.tags ?? [], importance: Number(r.importance),
  pinned: r.pinned, source: r.source, trust: r.trust, state: r.state, owner: r.owner, by: r.by,
  ...(r.reason ? { reason: r.reason } : {}), ...(r.run_id ? { runId: r.run_id } : {}), at: Number(r.at),
});

async function insertRevision(tx: Bun.SQL, m: Memory, by: string, reason: string | undefined, runId: string | undefined): Promise<void> {
  await tx`
    INSERT INTO memory_revision (user_id, memory_id, revision, title, body, tags, importance, pinned, source, trust, state, owner, by, reason, run_id, at)
    VALUES (${user()}, ${m.id}, ${m.revision}, ${m.title}, ${m.body}, ${tx.array(m.tags, "TEXT")}, ${m.importance}, ${m.pinned},
      ${m.source}, ${m.trust}, ${m.state}, ${m.owner}, ${by}, ${reason ?? null}, ${runId ?? null}, ${m.updatedAt})`;
}

const cleanReason = (reason: unknown): string | undefined => {
  const r = typeof reason === "string" ? reason.trim() : "";
  if (r.length > MEMORY_LIMITS.reasonMax) throw new MemoryError(`--reason is limited to ${MEMORY_LIMITS.reasonMax} characters (got ${r.length})`);
  return r || undefined;
};

/** The rate limits of an agent (§10.2): changes in this wake, and in 24 hours. */
async function checkRate(agent: string, runId: string | undefined, now: number, perWake = MEMORY_LIMITS.perWake): Promise<void> {
  const by = `agent:${agent}`;
  const [row] = await db.withRetry((sql) => sql`
    SELECT count(*) FILTER (WHERE at > ${now - 86_400_000}) AS day,
           count(*) FILTER (WHERE run_id IS NOT NULL AND run_id = ${runId ?? null}) AS wake
    FROM memory_revision WHERE user_id = ${user()} AND by = ${by} AND at > ${now - 86_400_000}`) as { day: string; wake: string }[];
  if (runId && Number(row?.wake ?? 0) >= perWake) throw new MemoryError(`refused: ${perWake} memory changes in one wake is the limit. Keep the rest for the next wake.`, 429);
  if (Number(row?.day ?? 0) >= MEMORY_LIMITS.perDay) throw new MemoryError(`refused: ${MEMORY_LIMITS.perDay} memory changes in 24 hours is the limit. The user sees this on the Memory page.`, 429);
}

export type WriteInput = { owner: string; title: string; body: string; tags?: string[]; importance?: number; reason?: string };

/** A new active memory. An agent writes its own or a shared one; a duplicate title of the same owner
 *  is refused with that memory's id. */
export async function write(input: WriteInput, actor: Actor, now = Date.now()): Promise<Memory> {
  const tags = cleanTags(input.tags);
  const problems = memoryProblems({ title: input.title, body: input.body, tags, importance: input.importance }, { needAll: true });
  if (problems.length) throw new MemoryError(`invalid memory: ${problems.join("; ")}`);
  const reason = cleanReason(input.reason);
  const owner = input.owner.trim() || SHARED;
  if (actor.kind === "agent") {
    if (!mayWrite(actor.agent, owner)) throw new MemoryError(`refused: an agent writes only its own memories ("${actor.agent}") and shared ones, not "${owner}"`, 403);
    await checkRate(actor.agent, actor.runId, now, actor.maxPerWake);
  }
  const norm = normTitle(input.title);
  const same = await db.withRetry((sql) => sql`
    SELECT id, title FROM memory WHERE user_id = ${user()} AND owner = ${owner} AND state = 'active'`) as { id: string; title: string }[];
  const dup = same.find((r) => normTitle(r.title) === norm);
  if (dup) throw new MemoryError(`refused: m${dup.id} "${dup.title}" already has this title. Revise it (orca memory revise ${dup.id} --base <revision> …) instead of writing a copy.`, 409);
  if (same.length >= MEMORY_LIMITS.activeMax) throw new MemoryError(`refused: "${owner}" holds ${same.length} active memories, the limit. Archive or merge some first.`, 429);
  const prov: Provenance = actor.kind === "agent" ? actor.prov : { source: actor.kind === "user" ? "user" : "migration:notes", trust: "trusted" };
  const by = byOf(actor);
  const runId = actor.kind === "agent" ? actor.runId : undefined;
  return db.withRetry(async (sql) => {
    let out: Memory | undefined;
    await sql.begin(async (tx: Bun.SQL) => {
      const [row] = await tx`
        INSERT INTO memory (user_id, owner, title, body, tags, tags_text, importance, source, trust, created_by, updated_by, created_at, updated_at)
        VALUES (${user()}, ${owner}, ${input.title.trim()}, ${input.body.trim()}, ${tx.array(tags, "TEXT")}, ${tags.join(" ")},
          ${input.importance ?? 5}, ${prov.source}, ${prov.trust}, ${by}, ${by}, ${now}, ${now})
        RETURNING ${tx.unsafe(COLS)}` as Row[];
      out = toMemory(row!);
      await insertRevision(tx, out, by, reason, runId);
    });
    return out!;
  });
}

export async function get(id: number): Promise<Memory | undefined> {
  const [row] = await db.withRetry((sql) => sql`SELECT ${sql.unsafe(COLS)} FROM memory WHERE user_id = ${user()} AND id = ${id}`) as Row[];
  return row && toMemory(row);
}

type Next = Partial<Pick<Memory, "title" | "body" | "tags" | "importance" | "pinned" | "state" | "trust" | "source" | "owner">>;

/** The one path every change takes. `mutate` returns the fields to set; the checks run on the locked
 *  row, so two writers cannot pass them at once. An agent needs the revision it read (`base`). */
async function change(id: number, actor: Actor, opts: { reason?: string; base?: number; agentMayTouchPinned?: boolean }, mutate: (m: Memory) => Next, now = Date.now()): Promise<Memory> {
  const reason = cleanReason(opts.reason);
  if (actor.kind === "agent") {
    if (!reason) throw new MemoryError("--reason is required: say why, in one line");
    await checkRate(actor.agent, actor.runId, now, actor.maxPerWake);
  }
  const by = byOf(actor);
  return db.withRetry(async (sql) => {
    let out: Memory | undefined;
    await sql.begin(async (tx: Bun.SQL) => {
      const [row] = await tx`SELECT ${tx.unsafe(COLS)} FROM memory WHERE user_id = ${user()} AND id = ${id} FOR UPDATE` as Row[];
      if (!row) throw new MemoryError(`no memory m${id}`, 404);
      const m = toMemory(row);
      if (actor.kind === "agent") {
        if (m.pinned && !opts.agentMayTouchPinned) throw new MemoryError(`refused: m${id} is pinned by the user, so it is read-only to agents. Write a new memory and link it instead.`, 403);
        if (!mayWrite(actor.agent, m.owner)) throw new MemoryError(`refused: m${id} belongs to "${m.owner}". An agent changes only its own memories and shared ones. Link to it instead.`, 403);
        if (opts.base === undefined || !Number.isInteger(opts.base)) throw new MemoryError(`--base <revision> is required: the revision you read (m${id} is at r${m.revision})`);
        if (opts.base !== m.revision) throw new MemoryError(`refused: m${id} changed since r${opts.base}. It is now:\n${memoryBlock(m)}\nRead it, then revise with --base ${m.revision}.`, 409);
      }
      const next: Memory = { ...m, ...mutate(m) };
      const changed = (["title", "body", "importance", "pinned", "state", "trust", "source", "owner"] as const).some((k) => next[k] !== m[k]) || next.tags.join("\n") !== m.tags.join("\n");
      if (!changed) { out = m; return; }
      if (actor.kind === "agent") Object.assign(next, changedProvenance({ source: next.source, trust: next.trust }, actor.prov));
      next.revision = m.revision + 1;
      next.updatedBy = by;
      next.updatedAt = now;
      await tx`
        UPDATE memory SET owner = ${next.owner}, title = ${next.title}, body = ${next.body}, tags = ${tx.array(next.tags, "TEXT")}, tags_text = ${next.tags.join(" ")},
          importance = ${next.importance}, pinned = ${next.pinned}, source = ${next.source}, trust = ${next.trust}, state = ${next.state},
          revision = ${next.revision}, updated_by = ${next.updatedBy}, updated_at = ${next.updatedAt}
        WHERE user_id = ${user()} AND id = ${id}`;
      await insertRevision(tx, next, by, reason, actor.kind === "agent" ? actor.runId : undefined);
      out = next;
    });
    return out!;
  });
}

export type RevisePatch = { title?: string; body?: string; tags?: string[]; addTags?: string[]; removeTags?: string[]; importance?: number };

export async function revise(id: number, patch: RevisePatch, actor: Actor, opts: { base?: number; reason?: string } = {}, now = Date.now()): Promise<Memory> {
  const tags = patch.tags === undefined ? undefined : cleanTags(patch.tags);
  const problems = memoryProblems({ title: patch.title, body: patch.body, tags, importance: patch.importance });
  if (problems.length) throw new MemoryError(`invalid revise: ${problems.join("; ")}`);
  return change(id, actor, opts, (m) => {
    let next = tags ?? m.tags;
    for (const t of cleanTags(patch.addTags)) if (!next.includes(t)) next = [...next, t];
    const drop = new Set(cleanTags(patch.removeTags));
    next = next.filter((t) => !drop.has(t));
    const tagProblems = memoryProblems({ tags: next });
    if (tagProblems.length) throw new MemoryError(`invalid revise: ${tagProblems.join("; ")}`);
    return {
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.body !== undefined ? { body: patch.body.trim() } : {}),
      ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
      tags: next,
    };
  }, now);
}

/** forget / archive / restore (active). Nothing is deleted: a forgotten memory is in no prompt and no
 *  search, and the user can restore it. */
export function setState(id: number, state: MemoryState, actor: Actor, opts: { base?: number; reason?: string } = {}, now = Date.now()): Promise<Memory> {
  return change(id, actor, opts, () => ({ state }), now);
}

// ── The user's own operations (the Memory page; no `orca` verb reaches them) ──────────────────────

const USER: Actor = { kind: "user" };

/** Pin or unpin. A pinned memory is read-only to every agent and leads the core. */
export const pin = (id: number, on: boolean, reason?: string, now = Date.now()) => change(id, USER, { reason: reason ?? (on ? "pinned" : "unpinned") }, () => ({ pinned: on }), now);

/** Mark an untrusted memory trusted: the user has checked it. Only the user can. */
export const markTrusted = (id: number, reason?: string, now = Date.now()) => change(id, USER, { reason: reason ?? "marked trusted" }, () => ({ trust: "trusted" }), now);

/** The user's edit of any field, or any state. */
export function userEdit(id: number, patch: RevisePatch & { state?: MemoryState; owner?: string }, reason?: string, now = Date.now()): Promise<Memory> {
  const tags = patch.tags === undefined ? undefined : cleanTags(patch.tags);
  const problems = memoryProblems({ title: patch.title, body: patch.body, tags, importance: patch.importance });
  if (problems.length) throw new MemoryError(`invalid edit: ${problems.join("; ")}`);
  return change(id, USER, { reason: reason ?? "edited by the user" }, () => ({
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.body !== undefined ? { body: patch.body.trim() } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
    ...(patch.state !== undefined ? { state: patch.state } : {}),
    ...(patch.owner !== undefined && patch.owner.trim() ? { owner: patch.owner.trim() } : {}),
  }), now);
}

/** Revert to an old revision: a NEW revision that copies it. History never moves back. */
export async function revert(id: number, revision: number, now = Date.now()): Promise<Memory> {
  const [row] = await db.withRetry((sql) => sql`
    SELECT * FROM memory_revision WHERE user_id = ${user()} AND memory_id = ${id} AND revision = ${revision}`) as RevRow[];
  if (!row) throw new MemoryError(`m${id} has no revision r${revision}`, 404);
  const r = toRevision(row);
  return change(id, USER, { reason: `revert to r${revision}` }, () => ({
    title: r.title, body: r.body, tags: r.tags, importance: r.importance, pinned: r.pinned, state: r.state, trust: r.trust, source: r.source, owner: r.owner,
  }), now);
}

export async function revisions(id: number): Promise<MemoryRevision[]> {
  const rows = await db.withRetry((sql) => sql`
    SELECT * FROM memory_revision WHERE user_id = ${user()} AND memory_id = ${id} ORDER BY revision DESC`) as RevRow[];
  return rows.map(toRevision);
}

// ── Merge ──────────────────────────────────────────────────────────────────────────────────

/** Merge memories into one: write the new memory, link each source to it as "merged into", archive
 *  the sources — one transaction. The new one is untrusted when any source is (or the wake is): a
 *  merge cannot wash outside text into a trusted memory. Sources must be the agent's to change. */
export async function merge(ids: number[], input: Omit<WriteInput, "owner"> & { owner?: string }, actor: Actor, now = Date.now()): Promise<Memory> {
  const unique = [...new Set(ids)];
  if (unique.length < 2) throw new MemoryError("merge needs at least two memory ids");
  const tags = cleanTags(input.tags);
  const problems = memoryProblems({ title: input.title, body: input.body, tags, importance: input.importance }, { needAll: true });
  if (problems.length) throw new MemoryError(`invalid merge: ${problems.join("; ")}`);
  const reason = cleanReason(input.reason);
  if (actor.kind === "agent") {
    if (!reason) throw new MemoryError("--reason is required: say why, in one line");
    await checkRate(actor.agent, actor.runId, now, actor.maxPerWake);
  }
  const by = byOf(actor);
  const runId = actor.kind === "agent" ? actor.runId : undefined;
  return db.withRetry(async (sql) => {
    let out: Memory | undefined;
    await sql.begin(async (tx: Bun.SQL) => {
      const rows = await tx`SELECT ${tx.unsafe(COLS)} FROM memory WHERE user_id = ${user()} AND id = ANY(${tx.array(unique, "INT8")}) FOR UPDATE` as Row[];
      const sources = rows.map(toMemory);
      const missing = unique.filter((id) => !sources.some((m) => m.id === id));
      if (missing.length) throw new MemoryError(`no memory ${missing.map((id) => `m${id}`).join(", ")}`, 404);
      if (actor.kind === "agent") {
        const pinned = sources.find((m) => m.pinned);
        if (pinned) throw new MemoryError(`refused: m${pinned.id} is pinned by the user, so it is read-only to agents`, 403);
        const foreign = sources.find((m) => !mayWrite(actor.agent, m.owner));
        if (foreign) throw new MemoryError(`refused: m${foreign.id} belongs to "${foreign.owner}"`, 403);
      }
      const owner = input.owner?.trim() || (actor.kind === "agent" ? (sources.every((m) => m.owner === SHARED) ? SHARED : actor.agent) : sources[0]!.owner);
      const outside = sources.find((m) => m.trust === "untrusted");
      const base: Provenance = actor.kind === "agent" ? actor.prov : { source: "user", trust: "trusted" };
      const prov = changedProvenance(base, outside ? { source: outside.source, trust: "untrusted" } : base);
      const [row] = await tx`
        INSERT INTO memory (user_id, owner, title, body, tags, tags_text, importance, source, trust, created_by, updated_by, created_at, updated_at)
        VALUES (${user()}, ${owner}, ${input.title.trim()}, ${input.body.trim()}, ${tx.array(tags, "TEXT")}, ${tags.join(" ")},
          ${input.importance ?? Math.max(...sources.map((m) => m.importance))}, ${prov.source}, ${prov.trust}, ${by}, ${by}, ${now}, ${now})
        RETURNING ${tx.unsafe(COLS)}` as Row[];
      out = toMemory(row!);
      await insertRevision(tx, out, by, reason ?? `merged ${unique.map((id) => `m${id}`).join(", ")}`, runId);
      for (const m of sources) {
        await tx`INSERT INTO memory_link (user_id, from_id, to_id, relation, by, at) VALUES (${user()}, ${m.id}, ${out.id}, 'merged into', ${by}, ${now})
          ON CONFLICT (user_id, from_id, to_id, relation) DO UPDATE SET removed_at = NULL`;
        if (m.state === "active") {
          const next: Memory = { ...m, state: "archived", revision: m.revision + 1, updatedBy: by, updatedAt: now };
          await tx`UPDATE memory SET state = 'archived', revision = ${next.revision}, updated_by = ${by}, updated_at = ${now} WHERE user_id = ${user()} AND id = ${m.id}`;
          await insertRevision(tx, next, by, `merged into m${out.id}`, runId);
        }
      }
    });
    return out!;
  });
}

// ── Links ──────────────────────────────────────────────────────────────────────────────────────

export async function link(fromId: number, toId: number, relation: string, actor: Actor, now = Date.now()): Promise<MemoryLink> {
  const rel = relation.trim().toLowerCase();
  if (!rel) throw new MemoryError('--as "<relation>" is required, for example --as "about" or --as "replaces"');
  if (rel.length > MEMORY_LIMITS.relationMax) throw new MemoryError(`--as is limited to ${MEMORY_LIMITS.relationMax} characters`);
  if (fromId === toId) throw new MemoryError("a memory cannot link to itself");
  for (const id of [fromId, toId]) if (!(await get(id))) throw new MemoryError(`no memory m${id}`, 404);
  const by = byOf(actor);
  await db.withRetry((sql) => sql`
    INSERT INTO memory_link (user_id, from_id, to_id, relation, by, at) VALUES (${user()}, ${fromId}, ${toId}, ${rel}, ${by}, ${now})
    ON CONFLICT (user_id, from_id, to_id, relation) DO UPDATE SET removed_at = NULL, by = EXCLUDED.by, at = EXCLUDED.at`);
  return { fromId, toId, relation: rel, by, at: now };
}

export async function unlink(fromId: number, toId: number, relation: string, now = Date.now()): Promise<boolean> {
  const rows = await db.withRetry((sql) => sql`
    UPDATE memory_link SET removed_at = ${now}
    WHERE user_id = ${user()} AND from_id = ${fromId} AND to_id = ${toId} AND relation = ${relation.trim().toLowerCase()} AND removed_at IS NULL
    RETURNING from_id`) as unknown[];
  return rows.length > 0;
}

export type LinkedMemory = { relation: string; direction: "out" | "in"; id: number; title: string; state: MemoryState };

export async function links(id: number): Promise<LinkedMemory[]> {
  const rows = await db.withRetry((sql) => sql`
    SELECT l.relation, l.from_id, l.to_id, m.id, m.title, m.state FROM memory_link l
    JOIN memory m ON m.id = CASE WHEN l.from_id = ${id} THEN l.to_id ELSE l.from_id END
    WHERE l.user_id = ${user()} AND l.removed_at IS NULL AND (l.from_id = ${id} OR l.to_id = ${id})
    ORDER BY l.at`) as { relation: string; from_id: string; to_id: string; id: string; title: string; state: MemoryState }[];
  return rows.map((r) => ({ relation: r.relation, direction: Number(r.from_id) === id ? "out" : "in", id: Number(r.id), title: r.title, state: r.state }));
}

// ── Recall ─────────────────────────────────────────────────────────────────────────────────────

export type RecallOptions = { owners?: string[]; tags?: string[]; states?: MemoryState[]; limit?: number; exclude?: number[]; count?: boolean };
export type RecallHit = { memory: Memory; score: number };

/** Full-text search, ranked by relevance, importance and recency (recallScore). `query` is a web
 *  search string (`websearch_to_tsquery`); `anyOf` ORs every word of a longer text instead (the
 *  wake's messages). Each hit counts as a recall unless `count` is false. */
export async function recall(query: { text?: string; anyOf?: string }, o: RecallOptions = {}, now = Date.now()): Promise<RecallHit[]> {
  const states = o.states ?? ["active"];
  const limit = Math.max(1, Math.min(50, o.limit ?? 10));
  const tags = cleanTags(o.tags);
  const rows = await db.withRetry(async (sql) => {
    const owners = o.owners?.length ? sql`AND owner = ANY(${sql.array(o.owners, "TEXT")})` : sql``;
    const tagged = tags.length ? sql`AND tags @> ${sql.array(tags, "TEXT")}` : sql``;
    const excluded = o.exclude?.length ? sql`AND NOT (id = ANY(${sql.array(o.exclude, "INT8")}))` : sql``;
    const base = sql`user_id = ${user()} AND state = ANY(${sql.array(states, "TEXT")}) ${owners} ${tagged} ${excluded}`;
    if (query.anyOf?.trim()) {
      // Every lexeme of the text, each quoted, ORed: a match on any word of the wake counts.
      return sql`
        WITH q AS (
          SELECT string_agg(quote_literal(lexeme), ' | ')::tsquery AS q
          FROM (SELECT lexeme FROM unnest(tsvector_to_array(to_tsvector('english', ${query.anyOf}))) AS lexeme LIMIT 40) l)
        SELECT ${sql.unsafe(COLS)}, ts_rank_cd(search, q.q) AS rank FROM memory, q
        WHERE q.q IS NOT NULL AND search @@ q.q AND ${base} ORDER BY rank DESC LIMIT 60`;
    }
    if (query.text?.trim()) {
      return sql`
        SELECT ${sql.unsafe(COLS)}, ts_rank_cd(search, websearch_to_tsquery('english', ${query.text})) AS rank FROM memory
        WHERE search @@ websearch_to_tsquery('english', ${query.text}) AND ${base} ORDER BY rank DESC LIMIT 60`;
    }
    return sql`SELECT ${sql.unsafe(COLS)}, 0 AS rank FROM memory WHERE ${base} ORDER BY updated_at DESC LIMIT 60`;
  }) as (Row & { rank: number })[];
  const hits = rows.map((r) => { const memory = toMemory(r); return { memory, score: recallScore(Number(r.rank), memory, now) }; })
    .sort((a, b) => b.score - a.score).slice(0, limit);
  if (o.count !== false) await countRecalls(hits.map((h) => h.memory.id), now);
  return hits;
}

/** A memory reached a prompt or a recall answer: its stats, not its content (no revision). */
export async function countRecalls(ids: number[], now = Date.now()): Promise<void> {
  if (!ids.length) return;
  await db.withRetry((sql) => sql`
    UPDATE memory SET recall_count = recall_count + 1, last_recalled_at = ${now}
    WHERE user_id = ${user()} AND id = ANY(${sql.array(ids, "INT8")})`);
}

// ── `orca memory` ──────────────────────────────────────────────────────────────────────────────

const id = (v: unknown, what = "id"): number => {
  const n = Number(String(v ?? "").replace(/^m/, ""));
  if (!Number.isInteger(n) || n <= 0) throw new MemoryError(`a memory ${what} is required (a number, as in m12 → 12)`);
  return n;
};
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : Array.isArray(v) ? v.map(String).join("\n") : undefined);
const list = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const flag = (v: unknown): boolean => v !== undefined && v !== false;

export const MEMORY_USAGE = [
  'orca memory recall "<query>" [--owner me|shared|<agent>|all] [--tag t]… [--all] [--limit 10]',
  "orca memory show <id> [--history]",
  'orca memory write --title "<title>" --body "<body>" [--tag t]… [--importance 1-10] [--shared] [--untrusted] [--reason "<why>"]',
  'orca memory revise <id> --base <revision> [--title …] [--body …] [--tag t]… [--untag t]… [--importance n] --reason "<why>"',
  'orca memory forget <id> --base <revision> --reason "<why>"',
  'orca memory archive <id> --base <revision> --reason "<why>"',
  'orca memory link <from> <to> --as "<relation>"',
  'orca memory unlink <from> <to> --as "<relation>"',
  'orca memory merge <id> <id>… --title "<title>" --body "<body>" [--tag t]… --reason "<why>"',
  "orca memory reflect   (ask for a reflection: at most one each 6 hours)",
].join("\n");

/** `orca memory <sub> …` for an agent. `actor` is built lazily: only a change needs the wake read. */
export async function memoryTool(agent: string, words: string[], args: Record<string, unknown>, actor: () => Promise<Actor & { kind: "agent" }>): Promise<string> {
  const [sub = "", ...rest] = words;
  switch (sub) {
    case "recall": {
      const q = rest.join(" ").trim();
      const tags = list(args.tag);
      const ownerArg = typeof args.owner === "string" && args.owner ? args.owner : "all";
      if (!q && !tags.length && ownerArg === "all") throw new MemoryError(`recall needs a query, a --tag or an --owner:\n${MEMORY_USAGE}`);
      const owners = ownerArg === "all" ? undefined : [ownerArg === "me" ? agent : ownerArg];
      const hits = await recall({ text: q }, { owners, tags, states: flag(args.all) ? ["active", "archived"] : ["active"], limit: Number(args.limit) || 10 });
      return hits.map((h) => memoryBlock(h.memory, { bodyChars: 300, cutNote: true })).join("\n\n") || `No memory matches${q ? ` "${q}"` : ""}.`;
    }
    case "show": {
      const m = await get(id(rest[0]));
      if (!m) throw new MemoryError(`no memory m${rest[0]}`, 404);
      const linked = await links(m.id);
      const history = flag(args.history) ? await revisions(m.id) : [];
      return [
        memoryBlock(m),
        ...(linked.length ? ["  links:", ...linked.map((l) => `    ${l.direction === "out" ? "→" : "←"} ${l.relation} m${l.id} "${l.title}"${l.state !== "active" ? ` (${l.state})` : ""}`)] : []),
        ...(history.length ? ["  history:", ...history.map((r) => `    ${revisionLine(r)}`)] : []),
      ].join("\n");
    }
    case "write": {
      const a = await actor();
      const untrusted = flag(args.untrusted) && a.prov.trust === "trusted" ? { source: `outside:agent:${agent}`, trust: "untrusted" as const } : a.prov;
      const m = await write({
        owner: flag(args.shared) ? SHARED : agent, title: text(args.title) ?? "", body: text(args.body) ?? "",
        tags: list(args.tag), importance: importanceOf(args.importance), reason: text(args.reason),
      }, { ...a, prov: untrusted });
      return `Wrote m${m.id} r${m.revision} (${m.owner}${m.trust === "untrusted" ? ", untrusted" : ""}).`;
    }
    case "revise": {
      const m = await revise(id(rest[0]), {
        title: text(args.title), body: text(args.body), importance: importanceOf(args.importance),
        addTags: list(args.tag), removeTags: list(args.untag),
      }, await actor(), { base: args.base === undefined ? undefined : Number(args.base), reason: text(args.reason) });
      return `Revised m${m.id}: now r${m.revision}${m.trust === "untrusted" ? " (untrusted)" : ""}.`;
    }
    case "forget":
    case "archive": {
      const m = await setState(id(rest[0]), sub === "forget" ? "forgotten" : "archived", await actor(), { base: args.base === undefined ? undefined : Number(args.base), reason: text(args.reason) });
      return `${sub === "forget" ? "Forgot" : "Archived"} m${m.id} (r${m.revision}). The user can restore it on the Memory page.`;
    }
    case "link": {
      const rel = text(args.as) ?? "";
      const l = await link(id(rest[0], "from id"), id(rest[1], "to id"), rel, await actor());
      return `Linked m${l.fromId} → m${l.toId} as "${l.relation}".`;
    }
    case "merge": {
      const ids = rest.map((w) => id(w));
      const m = await merge(ids, { title: text(args.title) ?? "", body: text(args.body) ?? "", tags: list(args.tag), importance: importanceOf(args.importance), reason: text(args.reason) }, await actor());
      return `Merged ${ids.map((i) => `m${i}`).join(", ")} into m${m.id}${m.trust === "untrusted" ? " (untrusted: a source was)" : ""}. The old ones are archived and linked to it.`;
    }
    case "unlink": {
      const ok = await unlink(id(rest[0], "from id"), id(rest[1], "to id"), text(args.as) ?? "");
      return ok ? "Unlinked." : "No such link.";
    }
    default:
      throw new MemoryError(`unknown memory command "${sub}". Commands:\n${MEMORY_USAGE}`);
  }
}

// ── The wake prompt (§4) ───────────────────────────────────────────────────────────────────────

/** The active memories that may be in `agent`'s core: its own, the shared ones, and every pinned one. */
export async function coreCandidates(agent: string): Promise<Memory[]> {
  const rows = await db.withRetry((sql) => sql`
    SELECT ${sql.unsafe(COLS)} FROM memory
    WHERE user_id = ${user()} AND state = 'active' AND (pinned OR owner = ${agent} OR owner = ${SHARED})
    ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 400`) as Row[];
  return rows.map(toMemory);
}

export async function core(agent: string, now = Date.now()): Promise<CoreSelection> {
  return selectCore(await coreCandidates(agent), agent, now);
}

/** The memory part of a wake prompt: the core, the hits for the wake's messages (over every owner,
 *  not already in the core), the scheduled wakes that fired. Only the hits count as a recall: the
 *  core is there every wake, and counting it would keep it fresh for ever. With the database down the
 *  wake runs, with a line that says memory is unavailable. */
export async function forPrompt(agent: string, messages: string[], o: { fired?: FiredWake[]; notice?: string } = {}, now = Date.now()): Promise<string> {
  try {
    const c = await core(agent, now);
    const text = messages.join("\n").slice(0, 20_000);
    const hits = text.trim()
      ? await recall({ anyOf: text }, { exclude: c.items.map((i) => i.memory.id), limit: MEMORY_BUDGET.recallHits, count: false }, now)
      : [];
    const recalled = fitRecall(hits.map((h) => h.memory));
    await countRecalls(recalled.map((m) => m.id), now);
    return memorySection({ core: c, recalled, fired: o.fired, notice: o.notice });
  } catch (e) {
    if (db.isDbError(e)) return memorySection({ core: { items: [], leftOut: 0, tokens: 0, pinnedTokens: 0 }, recalled: [], unavailable: true });
    throw e;
  }
}

// ── The move from the notes blob (§8) ─────────────────────────────────────────────────────────

export type NotesMove = { parts: NotesPart[]; written: { id: number; title: string }[]; skipped: { title: string; why: string }[]; already?: number; dryRun: boolean };

/** Move the orchestrator's notes into memory as `chief`'s, once. A dry run unless `confirm`. The
 *  notes blob is not changed: `orca notes` still prints it, read-only. Run by the user (scripts/
 *  memory-move-notes.ts) after the merge, never at boot. */
export async function migrateNotes(o: { confirm?: boolean } = {}, now = Date.now()): Promise<NotesMove> {
  const blob = ((await db.enrichment(ORCHESTRATOR_REPO))[ORCHESTRATOR_BRANCH] ?? {}) as { notes?: string; notesMigratedAt?: number };
  const parts = splitNotes(blob.notes ?? "");
  if (blob.notesMigratedAt) return { parts, written: [], skipped: [], already: blob.notesMigratedAt, dryRun: !o.confirm };
  if (!o.confirm) return { parts, written: [], skipped: [], dryRun: true };
  const written: NotesMove["written"] = [], skipped: NotesMove["skipped"] = [];
  const actor: Actor = { kind: "migration" };
  for (const p of parts) {
    const input = { owner: CHIEF, title: p.title, body: p.body, tags: p.tags, importance: 6, reason: "moved from the notes" };
    try {
      written.push(await write(input, actor, now));
    } catch (e) {
      // A title that memory already has: keep both, the note's under its own name.
      if (e instanceof MemoryError && e.status === 409) {
        try { written.push(await write({ ...input, title: `${p.title.slice(0, MEMORY_LIMITS.titleMax - 14)} (from notes)` }, actor, now)); continue; } catch (again) { e = again; }
      }
      skipped.push({ title: p.title, why: e instanceof Error ? e.message : String(e) });
    }
  }
  await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { notesMigratedAt: now, notesMoveNotice: notesMovedNotice(written.length) });
  return { parts, written: written.map((m) => ({ id: m.id, title: m.title })), skipped, dryRun: false };
}

// ── Reflection (§5) ────────────────────────────────────────────────────────────────────────────

/** Memory changes by `agent` since `since` (every revision it made). */
export async function changesSince(agent: string, since: number): Promise<number> {
  const [row] = await db.withRetry((sql) => sql`
    SELECT count(*) AS n FROM memory_revision WHERE user_id = ${user()} AND by = ${`agent:${agent}`} AND at > ${since}`) as { n: string }[];
  return Number(row?.n ?? 0);
}

/** What a reflection reads: memories changed since the last one, the least used of its own, and
 *  pairs whose words overlap most. */
export async function reflectionInput(agent: string, since: number, lastSummary: string | undefined, now = Date.now()): Promise<ReflectionInput> {
  const changed = await db.withRetry((sql) => sql`
    SELECT ${sql.unsafe(COLS)} FROM memory WHERE user_id = ${user()} AND updated_at > ${since} AND state <> 'forgotten'
      AND (owner = ${agent} OR owner = ${SHARED}) ORDER BY updated_at DESC LIMIT 60`) as Row[];
  const mine = await db.withRetry((sql) => sql`
    SELECT ${sql.unsafe(COLS)}, tsvector_to_array(search) AS lexemes FROM memory
    WHERE user_id = ${user()} AND state = 'active' AND (owner = ${agent} OR owner = ${SHARED}) ORDER BY updated_at DESC LIMIT 300`) as (Row & { lexemes: string[] })[];
  const all = mine.map((r) => ({ memory: toMemory(r), lexemes: r.lexemes ?? [] }));
  const byId = new Map(all.map((x) => [x.memory.id, x.memory]));
  const lowest = all.map((x) => x.memory).filter((m) => !m.pinned && m.owner === agent)
    .sort((a, b) => coreScore(a, now) - coreScore(b, now)).slice(0, REFLECTION.lowest);
  const pairs = similarPairs(all.filter((x) => !x.memory.pinned).map((x) => ({ id: x.memory.id, lexemes: x.lexemes })))
    .map(([a, b, overlap]) => ({ a: byId.get(a)!, b: byId.get(b)!, overlap }));
  return { agent, changed: changed.map(toMemory), lowest, pairs, ...(lastSummary ? { lastSummary } : {}) };
}

// ── The Memory page (§9) ───────────────────────────────────────────────────────────────────────

/** Memories for the page: the text search (if any) and the states in SQL, the rest in the pure
 *  filter (shared/memory.ts filterMemories). At most 1000. */
export async function listForPage(q: { text?: string; states: MemoryState[] }): Promise<Memory[]> {
  const rows = await db.withRetry((sql) => q.text?.trim()
    ? sql`SELECT ${sql.unsafe(COLS)} FROM memory WHERE user_id = ${user()} AND state = ANY(${sql.array(q.states, "TEXT")})
        AND search @@ websearch_to_tsquery('english', ${q.text}) ORDER BY updated_at DESC LIMIT 1000`
    : sql`SELECT ${sql.unsafe(COLS)} FROM memory WHERE user_id = ${user()} AND state = ANY(${sql.array(q.states, "TEXT")})
        ORDER BY updated_at DESC LIMIT 1000`) as Row[];
  return rows.map(toMemory);
}

export type ActivityRow = MemoryRevision & { title: string; current: number };

/** The newest revisions over every memory: how the agents' memory changes, in order. */
export async function activity(limit = 200): Promise<ActivityRow[]> {
  const rows = await db.withRetry((sql) => sql`
    SELECT r.*, m.title AS current_title, m.revision AS current FROM memory_revision r JOIN memory m ON m.id = r.memory_id
    WHERE r.user_id = ${user()} ORDER BY r.at DESC, r.id DESC LIMIT ${Math.min(500, Math.max(1, limit))}`) as (RevRow & { current_title: string; current: number })[];
  return rows.map((r) => ({ ...toRevision(r), title: r.current_title, current: Number(r.current) }));
}

/** Memory changes per agent in the last 24 hours, for the page's rate warning. */
export async function changesToday(now = Date.now()): Promise<Record<string, number>> {
  const rows = await db.withRetry((sql) => sql`
    SELECT by, count(*) AS n FROM memory_revision WHERE user_id = ${user()} AND at > ${now - 86_400_000} AND by LIKE 'agent:%' GROUP BY by`) as { by: string; n: string }[];
  return Object.fromEntries(rows.map((r) => [r.by.slice("agent:".length), Number(r.n)]));
}

/** Every owner that holds a memory, for the page's owner filter. */
export async function owners(): Promise<string[]> {
  const rows = await db.withRetry((sql) => sql`SELECT DISTINCT owner FROM memory WHERE user_id = ${user()} ORDER BY owner`) as { owner: string }[];
  return [...new Set([CHIEF, SHARED, ...rows.map((r) => r.owner)])];
}
