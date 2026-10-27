// The Granola adapter (setup: docs/integrations/granola.md). Granola is the user's meeting notes app.
// Orca reads its public REST API (https://public-api.granola.ai/v1, docs.granola.ai) with a personal
// API key (`Authorization: Bearer grn_…`, made in the Granola desktop app). The key is a stored
// secret (`secret:integrations/granola.<id>.api_key`, pasted on the Connect form) or an
// `ORCA_SECRET_*` variable. The hosted MCP server needs a browser OAuth per user, which a headless
// box cannot do, so Orca uses the REST API only.
//
// READ ONLY: the API has no write for notes, and Orca makes no POST, PUT, PATCH or DELETE call.
// `caps.outbound` is false and `send` refuses.
//
// Events: the core's account policy (docs/integrations/POLICY.md). Granola has webhooks only for
// Business and Enterprise plans, and the bridge has no public address, so the adapter polls. With
// events `off` the loop makes no Granola call (it rereads the row each tick). With `trigger` or
// `record`, every `pollSeconds` (300, at least 60) it lists the notes updated since its cursor.
// Granola lists a note only when its AI summary and transcript are done, so the FIRST time a note id
// shows up, the meeting is finished: that is ONE event, `ext.granola.note`, with the title, the time,
// the attendees and the summary. The cursor (`{ v, from, since, page?, seen }` in integration_cursor)
// starts at the first poll (no old meeting is replayed), keeps the ids it handled and Granola's page
// cursor when a poll stops at the page cap, so a restart neither replays nor skips a note.
//
// Meeting text is OUTSIDE data, like mail: the event has no actor (a poller is a machine sender, so
// the link's level is the grant), and the core fences it as an external message. The place is the
// note's folder (`folder:<fol_id>`, with its parent folders), else `notes`; the first Connect makes
// a Viewer `*` link (ensureDefaults).
import type { Adapter, AdapterContext, Connection } from "../adapter";
import { secretValue } from "../secretRefs";
import { CATCH_ALL, clip, type Capabilities, type InboundEnvelope, type SendResult } from "../../../shared/integrations";
import * as store from "../store";

export const GRANOLA_API = "https://public-api.granola.ai";
/** The poll interval with events on: 5 minutes unless set, never below 1 minute. Only the tests'
 *  fake Granola (the `apiUrl` override) may poll faster. Granola allows 5 requests a second. */
export const GRANOLA_POLL_DEFAULT_S = 300;
export const GRANOLA_POLL_MIN_S = 60;
/** Granola's largest List Notes page. */
export const PAGE_SIZE = 30;
/** Pages one poll reads; the rest waits for the next poll (the page cursor is kept). */
export const MAX_PAGES = 5;
/** `updated_after` starts this far before the cursor, for notes that land a little late. */
export const OVERLAP_MS = 5 * 60_000;
/** A note created this long before the first poll is old: an edit of it is not a new meeting. */
export const OLD_NOTE_MS = 12 * 60 * 60_000;
/** New events one poll hands in; the rest waits for the next poll. The core takes 20 a link in 10
 *  minutes (INBOUND_LIMIT) and drops the rest, so 8 a poll every 5 minutes stays under it. */
export const MAX_EVENTS_PER_POLL = 8;
/** Note ids the cursor keeps (newest last). The core's event key dedupes past this too. */
export const SEEN_MAX = 500;
export const SUMMARY_MAX = 6_000;
/** The card's live key check is kept this long: the Integrations page asks on every load. */
export const HEALTH_CACHE_MS = 30_000;

/** Read only: no outbound side. */
export const GRANOLA_CAPS: Capabilities = {
  inbound: "poll", outbound: false, threads: false, edits: false, reactions: false, attachments: false, maxTextLength: 100_000,
};

/** The class of each `orca granola` verb (the account policy's VerbClasses). Both are reads;
 *  Granola has no write verb. */
export const GRANOLA_VERBS = { search: "read", read: "read" } as const;
/** A new row: read access, events off until the user sets them on the card (as Gmail). */
export const GRANOLA_POLICY_DEFAULTS = { access: "read", events: "off" } as const;

// ── The API ──────────────────────────────────────────────────────────────────────────────────────

export type GranolaUser = { name: string | null; email: string };
export type GranolaNoteSummary = {
  id: string; object: "note"; title: string | null; owner: GranolaUser;
  created_at: string; updated_at: string; deleted_at?: string | null;
};
export type GranolaFolder = { id: string; name: string; parent_folder_id: string | null };
export type GranolaSpeaker = { source: string; attribution?: "me" | "them"; diarization_label?: string; name?: string };
export type GranolaTranscriptItem = { speaker: GranolaSpeaker; text: string; start_time: string; end_time: string };
export type GranolaNote = GranolaNoteSummary & {
  web_url?: string;
  calendar_event?: { event_title: string | null; invitees?: { email: string }[]; organiser?: string | null; scheduled_start_time?: string | null; scheduled_end_time?: string | null } | null;
  attendees?: GranolaUser[];
  folder_membership?: GranolaFolder[];
  summary_text?: string;
  summary_markdown?: string | null;
  private_notes_markdown?: string | null;
  private_notes_text?: string | null;
  transcript?: GranolaTranscriptItem[] | null;
};
export type NotesPage = { notes: GranolaNoteSummary[]; hasMore: boolean; cursor: string | null };
export type TranscriptPage = { transcript: GranolaTranscriptItem[]; hasMore: boolean; cursor: string | null };

export class GranolaError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean, readonly retryAfterMs?: number, readonly code?: string) { super(message); }
  /** The key itself is refused: no retry helps until the user pastes a new one. */
  get badKey(): boolean { return this.status === 401; }
}

const KEY_HELP = "make a new key in the Granola desktop app (Settings > Connectors > API keys) and paste it on the Integrations card";

/** The error for one failed answer. Pure. The text never holds the key. */
export function granolaError(status: number, body: unknown, retryAfter?: string | null): GranolaError {
  const b = (body ?? {}) as { message?: unknown; error?: unknown; code?: unknown };
  const code = typeof b.code === "string" ? b.code : typeof b.error === "string" && /^[A-Z_]+$/.test(b.error) ? b.error : undefined;
  const said = [b.message, b.error].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  const wait = Number(retryAfter);
  if (status === 401) return new GranolaError(`Granola refused the API key (401): ${KEY_HELP}`, status, false);
  if (status === 403) return new GranolaError(`Granola refused the request (403): the key lacks the access scope${said ? ` (${said})` : ""}; give it Personal notes in the Granola app`, status, false);
  if (status === 404) return new GranolaError("not found (Granola shows a note only when its summary and transcript are done)", status, false);
  if (status === 429) return new GranolaError("Granola rate limit (429)", status, true, wait > 0 ? wait * 1000 : 60_000);
  if (status >= 500) return new GranolaError(`Granola http ${status}`, status, true, wait > 0 ? wait * 1000 : undefined);
  return new GranolaError(`Granola http ${status}${said ? `: ${said}` : ""}`, status, false, undefined, code);
}

export type Granola = {
  listNotes(q: { created_after?: string; updated_after?: string; cursor?: string; page_size?: number }): Promise<NotesPage>;
  note(id: string, opts?: { transcript?: boolean }): Promise<GranolaNote>;
  transcript(id: string, cursor?: string): Promise<TranscriptPage>;
};

/** A Granola client with one key. Every call is a GET. `base` is Granola's, or the tests' fake. */
export function granolaClient(key: string, base = GRANOLA_API): Granola {
  const root = base.replace(/\/+$/, "");
  async function get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const u = new URL(`${root}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
    let res: Response;
    try { res = await fetch(u, { headers: { authorization: `Bearer ${key}`, accept: "application/json" } }); }
    catch (e) { throw new GranolaError(`Granola unreachable: ${e instanceof Error ? e.message : String(e)}`, 0, true); }
    const body = await res.json().catch(() => undefined);
    if (!res.ok) throw granolaError(res.status, body, res.headers.get("retry-after"));
    return body as T;
  }
  return {
    listNotes: (q) => get<NotesPage>("/v1/notes", { page_size: PAGE_SIZE, ...q }),
    note: (id, opts = {}) => get<GranolaNote>(`/v1/notes/${encodeURIComponent(id)}`, opts.transcript ? { include: "transcript" } : {}),
    transcript: (id, cursor) => get<TranscriptPage>(`/v1/notes/${encodeURIComponent(id)}/transcript`, { page_size: 100, cursor }),
  };
}

/** A note with its transcript: inline when Granola allows, else page by page (413 TRANSCRIPT_TOO_LARGE). */
export async function noteWithTranscript(g: Granola, id: string, maxPages = 50): Promise<GranolaNote> {
  try { return await g.note(id, { transcript: true }); }
  catch (e) {
    if (!(e instanceof GranolaError && e.status === 413)) throw e;
    const note = await g.note(id);
    const items: GranolaTranscriptItem[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < maxPages; n++) {
      const p = await g.transcript(id, cursor);
      items.push(...p.transcript);
      if (!p.hasMore || !p.cursor) break;
      cursor = p.cursor;
    }
    return { ...note, transcript: items };
  }
}

// ── Config and cursor (pure) ─────────────────────────────────────────────────────────────────────

export type GranolaConfig = { pollSeconds: number; apiUrl: string };
const num = (v: unknown, d: number) => (typeof v === "number" ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : d);

/** The config with defaults (values may be strings, as the form saves them). Pure. */
export function granolaConfig(raw: Record<string, unknown>): GranolaConfig {
  const test = typeof raw.apiUrl === "string" && raw.apiUrl ? raw.apiUrl : undefined;
  return { pollSeconds: Math.max(test ? 0.05 : GRANOLA_POLL_MIN_S, num(raw.pollSeconds, GRANOLA_POLL_DEFAULT_S)), apiUrl: test ?? GRANOLA_API };
}

/** `from`: the first poll (no meeting before it is new). `since`: the newest `updated_at` handled.
 *  `page`: Granola's cursor when a poll stopped at the page cap. `seen`: note ids handled, newest last. */
export type GranolaCursor = { v: 1; from: string; since: string; page?: string; seen: string[] };

export function readCursor(raw: string | undefined): GranolaCursor | undefined {
  try {
    const c = JSON.parse(raw ?? "") as GranolaCursor;
    return c?.v === 1 && typeof c.from === "string" && typeof c.since === "string" && Array.isArray(c.seen) ? c : undefined;
  } catch { return undefined; }
}

/** What a poll does with one listed note: take it (a new finished meeting), or skip it and why. Pure. */
export function noteDecision(n: GranolaNoteSummary, cur: Pick<GranolaCursor, "from" | "seen">): "take" | "seen" | "deleted" | "old" {
  if (cur.seen.includes(n.id)) return "seen";
  if (n.deleted_at) return "deleted";
  if (Date.parse(n.created_at) < Date.parse(cur.from) - OLD_NOTE_MS) return "old";
  return "take";
}

const later = (a: string, b: string) => (Date.parse(b) > Date.parse(a) ? b : a);

/** The cursor after a poll read `notes` (all of them handled) and Granola said `more`. Pure. */
export function nextCursor(cur: GranolaCursor, notes: GranolaNoteSummary[], handled: string[], more: { hasMore: boolean; cursor: string | null }): GranolaCursor {
  const seen = [...cur.seen.filter((id) => !handled.includes(id)), ...handled].slice(-SEEN_MAX);
  // Stopped at the page cap: keep `since` and go on from Granola's page cursor next time.
  if (more.hasMore && more.cursor) return { ...cur, page: more.cursor, seen };
  const since = notes.reduce((s, n) => later(s, n.updated_at), cur.since);
  return { v: 1, from: cur.from, since, seen };
}

/** The place of a note, for the link: its direct folder (`folder:<id>`) with the folders above it,
 *  else `notes`. Granola lists ancestors with direct folders; a direct one is no other's parent. Pure. */
export function notePlace(n: Pick<GranolaNote, "folder_membership">): { channel: string; parents: string[] } {
  const fs = n.folder_membership ?? [];
  const parentIds = new Set(fs.map((f) => f.parent_folder_id).filter(Boolean));
  const direct = fs.find((f) => !parentIds.has(f.id));
  if (!direct) return { channel: "notes", parents: [] };
  const byId = new Map(fs.map((f) => [f.id, f]));
  const parents: string[] = [];
  for (let p = direct.parent_folder_id; p && byId.has(p) && parents.length < 10; p = byId.get(p)!.parent_folder_id) parents.push(`folder:${p}`);
  return { channel: `folder:${direct.id}`, parents };
}

const who = (u: GranolaUser) => (u.name?.trim() ? `${u.name.trim()} <${u.email}>` : u.email);
export const noteTitle = (n: Pick<GranolaNoteSummary, "title">): string => n.title?.trim() || "(untitled meeting)";
/** "2026-10-27 09:30 UTC". Pure. */
export const utc = (iso: string | null | undefined): string => (iso && Date.parse(iso) ? `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC` : "?");
/** The meeting's start: the calendar event's, else the note's creation. */
export const meetingTime = (n: GranolaNote): string => n.calendar_event?.scheduled_start_time ?? n.created_at;
export const attendeeLine = (n: GranolaNote): string => (n.attendees ?? []).map(who).join(", ") || "none listed";

/** The event for one new finished meeting note. Pure. */
export function noteEnvelope(connectionId: string, n: GranolaNote): InboundEnvelope {
  const place = notePlace(n);
  const summary = (n.summary_markdown ?? n.summary_text ?? "").trim();
  const title = noteTitle(n);
  return {
    key: `granola:${connectionId}:${n.id}`,
    topic: "ext.granola.note",
    at: Date.parse(n.updated_at) || Date.now(),
    source: { adapter: "granola", integrationId: connectionId, channel: place.channel, ...(place.parents.length ? { parents: place.parents } : {}) },
    thread: { adapter: "granola", externalId: n.id },
    // The user's own meeting: as direct as a mention.
    mentioned: true,
    display: { sender: n.owner?.name?.trim() || n.owner?.email || "Granola", place: clip(title, 80) },
    title,
    text: [
      // The first line is the activity row's preview.
      `Meeting notes ready: ${title}`,
      `When: ${utc(meetingTime(n))} · Attendees: ${attendeeLine(n)}`,
      ...(summary ? ["", clip(summary, SUMMARY_MAX)] : []),
      "",
      `Granola note ${n.id}. Read the full note with: orca granola read ${n.id} [--transcript]`,
    ].join("\n"),
    ...(n.web_url ? { link: { url: n.web_url } } : {}),
    raw: { note: n.id, folders: (n.folder_membership ?? []).map((f) => f.id) },
  };
}

/** The first Connect: a Viewer `*` link, so a new note reaches the orchestrator with read verbs only. */
export async function ensureDefaults(c: Pick<Connection, "id">): Promise<void> {
  const links = (await store.links()).filter((l) => l.integrationId === c.id);
  if (!links.length) await store.addLink({ id: `${c.id}-notes`.slice(0, 63), integrationId: c.id, externalId: CATCH_ALL, label: "All meeting notes", level: "ask", repos: [], requireMention: false });
}

// ── The adapter ──────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((r) => {
  if (signal.aborted) return r();
  const t = setTimeout(r, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
});
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function granolaAdapter(connection: Connection): Adapter {
  const cfg = granolaConfig(connection.config);
  const local = new AbortController();
  let ctx: AdapterContext | undefined;
  let lastEventAt: number | undefined, lastPollAt: number | undefined;
  let state: { ok: boolean; detail: string } = { ok: false, detail: "not started" };
  let checked: { at: number; ok: boolean; detail: string } | undefined;
  const key = () => ctx?.secret() ?? secretValue(connection.secretRef) ?? "";
  const client = (): Granola => {
    const k = key();
    if (!k) throw new GranolaError(`no API key: ${connection.secretRef ? `${connection.secretRef} is not set` : "paste one on the Integrations card"}`, 401, false);
    return granolaClient(k, cfg.apiUrl);
  };

  const report = async (ok: boolean, detail: string) => {
    state = { ok, detail };
    await ctx?.status({ ok, detail, ...(lastEventAt ? { lastEventAt } : {}), ...(lastPollAt ? { lastPollAt } : {}) }).catch(() => {});
  };

  /** One poll: the notes updated since the cursor, each new finished one in, the cursor on. */
  async function poll(): Promise<string> {
    const g = client();
    const cur = readCursor(await ctx!.cursor.get());
    if (!cur) {
      // A first poll: check the key, then begin at now, never replay the meetings from before.
      await g.listNotes({ page_size: 1 });
      const now = new Date().toISOString();
      await ctx!.cursor.set(JSON.stringify({ v: 1, from: now, since: now, seen: [] } satisfies GranolaCursor));
      return "watching new meeting notes from now";
    }
    const after = new Date(Date.parse(cur.since) - OVERLAP_MS).toISOString();
    const notes: GranolaNoteSummary[] = [];
    let page = cur.page;
    let more: NotesPage = { notes: [], hasMore: false, cursor: null };
    for (let n = 0; n < MAX_PAGES && !local.signal.aborted; n++) {
      more = await g.listNotes({ updated_after: after, ...(page ? { cursor: page } : {}) });
      notes.push(...more.notes);
      if (!more.hasMore || !more.cursor) break;
      page = more.cursor;
    }
    notes.sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
    const handled: string[] = [];
    let taken = 0, failed = 0, capped = false;
    for (const s of notes) {
      if (local.signal.aborted) return "stopped";
      const d = noteDecision(s, cur);
      if (d === "seen") continue;
      if (d === "take" && taken >= MAX_EVENTS_PER_POLL) { capped = true; break; }
      if (d !== "take") { handled.push(s.id); continue; }
      try {
        const outcome = await ctx!.ingest(noteEnvelope(connection.id, await g.note(s.id)));
        if (outcome === "new" || outcome === "noted") { taken++; lastEventAt = Date.now(); }
        handled.push(s.id);
        ctx!.log(`note ${s.id}: ${outcome}`);
      } catch (e) {
        // A bad key stops the poll; any other failure leaves the note for the next poll.
        if (e instanceof GranolaError && (e.badKey || e.status === 429)) throw e;
        failed++;
        ctx!.log(`note ${s.id}: failed: ${errText(e)}`);
      }
    }
    // A failed note, or more new notes than one poll takes: keep `since` and the page where they were,
    // so the next poll lists the same notes again (seen skips the handled ones).
    const next = failed || capped ? { ...nextCursor(cur, [], handled, { hasMore: false, cursor: null }), since: cur.since, ...(cur.page ? { page: cur.page } : {}) } : nextCursor(cur, notes, handled, more);
    await ctx!.cursor.set(JSON.stringify(next));
    return `watching new meeting notes${taken ? ` · ${taken} new` : ""}${capped ? " · more next poll" : ""}${failed ? ` · ${failed} to retry` : ""}`;
  }

  async function loop(): Promise<void> {
    let backoff = 5_000;
    while (!local.signal.aborted) {
      let wait = cfg.pollSeconds * 1000;
      try {
        // Events off: no Granola call at all. Read per tick, so a change on the card applies at once.
        const events = (await store.integration(connection.id).catch(() => undefined))?.events ?? connection.events;
        if (events === "off") { await report(true, "events off: no poll (orca granola search and read still work)"); await sleep(wait, local.signal); continue; }
        const detail = await poll();
        lastPollAt = Date.now();
        await report(true, `${detail} · polling every ${cfg.pollSeconds}s`);
        backoff = 5_000;
      } catch (e) {
        if (local.signal.aborted) break;
        if (e instanceof GranolaError && !e.retryable) await report(false, e.message); // a bad key: wait for a new one
        else {
          const ms = Math.max(backoff, e instanceof GranolaError ? e.retryAfterMs ?? 0 : 0);
          await report(false, `${errText(e)}; retry in ${Math.round(ms / 1000)}s`);
          wait = ms; backoff = Math.min(backoff * 2, 15 * 60_000);
        }
      }
      await sleep(wait, local.signal);
    }
  }

  return {
    kind: "granola",
    caps: GRANOLA_CAPS,
    async start(c) {
      ctx = c;
      c.signal.addEventListener("abort", () => local.abort(), { once: true });
      void loop();
    },
    async stop() { local.abort(); },
    async send(): Promise<SendResult> {
      return { ok: false, retryable: false, error: "Granola is read only: Orca posts nothing there" };
    },
    /** The card's Test: one List Notes call with the key (kept HEALTH_CACHE_MS), then the loop's state. */
    async health() {
      const polled = { ...(lastEventAt ? { lastEventAt } : {}), ...(lastPollAt ? { lastPollAt } : {}) };
      if (!checked || Date.now() - checked.at > HEALTH_CACHE_MS) {
        try {
          const r = await client().listNotes({ page_size: 1 });
          const latest = r.notes[0];
          checked = { at: Date.now(), ok: true, detail: `the API key works${latest ? ` · newest note ${utc(latest.created_at)}` : " · no notes yet"}` };
        } catch (e) {
          checked = { at: Date.now(), ok: false, detail: errText(e) };
        }
      }
      return checked.ok ? { ok: state.ok || state.detail === "not started", detail: `${checked.detail} · ${state.detail}`, ...polled } : { ok: false, detail: checked.detail, ...polled };
    },
  };
}
