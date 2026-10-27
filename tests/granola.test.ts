// The Granola adapter (server/integrations/adapters/granola.ts, docs/integrations/granola.md): a pasted
// API key in the secret store, the card's Test, the poll from a cursor (one ext.granola.note event per
// new finished meeting, no replay after a restart, Granola's page cursor kept at the page cap), a bad
// key, and `orca granola search|read`. Real Postgres, the real registry, router and secret store;
// Granola is a fake REST API on loopback (Bun.serve, the `apiUrl` override). No real Granola call.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as secrets from "../server/secrets";
import * as router from "../server/integrations/router";
import * as dispatcher from "../server/integrations/dispatcher";
import * as registry from "../server/integrations/registry";
import * as store from "../server/integrations/store";
import * as admin from "../server/integrations/admin";
import * as secretRefs from "../server/integrations/secretRefs";
import {
  GRANOLA_CAPS, GRANOLA_POLL_MIN_S, MAX_EVENTS_PER_POLL, GRANOLA_VERBS, MAX_PAGES, OLD_NOTE_MS, PAGE_SIZE, granolaConfig, granolaError, nextCursor, noteDecision, noteEnvelope, notePlace, readCursor,
  type GranolaCursor, type GranolaNote,
} from "../server/integrations/adapters/granola";
import { granolaTool, matches, sinceIso, transcriptText, OUTSIDE_NOTE } from "../server/granolaTool";
import * as orchestrator from "../server/orchestrator";
import { invalidateConfig } from "../server/config";
import { apiKeyProblem, apiKeySecret, fenceExternal, grantRefusal, integrationAccessRefusal } from "../shared/integrations";
import { provenance } from "../shared/memory";
import { orchestratorPrompt } from "../web/src/workstream";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const dom = { fetch: globalThis.fetch, Response: globalThis.Response };
beforeAll(() => { Object.assign(globalThis, native); });
afterAll(() => { Object.assign(globalThis, dom); });

const until = async <T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 5_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

const KEY = "grn_good_key_123";
let seq = 0;
const noteId = () => `not_${String(++seq).padStart(14, "0")}`;
const iso = (ms: number) => new Date(ms).toISOString();

function note({ at: when, ...o }: Partial<GranolaNote> & { title: string; at?: number }): GranolaNote {
  const at = when ?? Date.now();
  return {
    id: noteId(), object: "note", owner: { name: "Finn", email: "finn@example.com" },
    created_at: o.created_at ?? iso(at), updated_at: o.updated_at ?? iso(at + 60_000), deleted_at: null,
    web_url: "https://notes.granola.ai/d/x", calendar_event: { event_title: o.title, invitees: [], organiser: null, scheduled_start_time: iso(at), scheduled_end_time: iso(at + 900_000) },
    attendees: [{ name: "Ana Lee", email: "ana@example.com" }, { name: null, email: "sam@example.com" }],
    folder_membership: [], summary_text: "Plain summary", summary_markdown: "## Standup\n- Ana: ship the login fix", private_notes_markdown: null, private_notes_text: null,
    transcript: null, ...o,
  };
}

/** A fake Granola: List Notes (filters, page_size at most 30, an opaque cursor), Get Note (with
 *  include=transcript and a 413 for a large one) and Get Transcript (paged). Only GETs exist. */
function fakeGranola() {
  const st = {
    notes: [] as GranolaNote[],
    transcripts: new Map<string, { items: GranolaNote["transcript"]; tooLarge?: boolean }>(),
    log: [] as string[],
  };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      const u = new URL(req.url);
      st.log.push(`${req.method} ${u.pathname}${u.search}`);
      if (req.headers.get("authorization") !== `Bearer ${KEY}`) return Response.json({ message: "Invalid API key" }, { status: 401 });
      if (req.method !== "GET") return Response.json({ message: "method" }, { status: 405 });
      if (u.pathname === "/v1/notes") {
        const q = u.searchParams;
        const size = Math.min(30, Number(q.get("page_size") ?? 10));
        const ca = q.get("created_after"), ua = q.get("updated_after");
        const all = st.notes.filter((n) => (!ca || n.created_at > ca) && (!ua || n.updated_at > ua)).sort((a, b) => b.created_at.localeCompare(a.created_at));
        const from = q.get("cursor") ? Number(atob(q.get("cursor")!)) : 0;
        const page = all.slice(from, from + size);
        const more = from + size < all.length;
        return Response.json({ notes: page.map(({ id, object, title, owner, created_at, updated_at, deleted_at }) => ({ id, object, title, owner, created_at, updated_at, deleted_at })), hasMore: more, cursor: more ? btoa(String(from + size)) : null });
      }
      const m = u.pathname.match(/^\/v1\/notes\/([^/]+)(\/transcript)?$/);
      const n = m && st.notes.find((x) => x.id === m[1]);
      if (!n) return Response.json({ message: "Note not found" }, { status: 404 });
      const t = st.transcripts.get(n.id);
      if (m![2]) {
        const items = t?.items ?? [];
        const from = u.searchParams.get("cursor") ? Number(u.searchParams.get("cursor")) : 0;
        const size = Number(u.searchParams.get("page_size") ?? 50);
        const more = from + size < items.length;
        return Response.json({ transcript: items.slice(from, from + size), hasMore: more, cursor: more ? String(from + size) : null });
      }
      if (u.searchParams.get("include") === "transcript") {
        if (t?.tooLarge) return Response.json({ code: "TRANSCRIPT_TOO_LARGE", message: "Transcript is too large" }, { status: 413 });
        return Response.json({ ...n, transcript: t?.items ?? [] });
      }
      return Response.json({ ...n, transcript: null });
    },
  });
  return { st, base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe("decisions (pure)", () => {
  test("the config: poll every 5 minutes, never below 1 minute; only the tests' fake polls faster", () => {
    expect(granolaConfig({})).toEqual({ pollSeconds: 300, apiUrl: "https://public-api.granola.ai" });
    expect(granolaConfig({ pollSeconds: "5" }).pollSeconds).toBe(GRANOLA_POLL_MIN_S);
    expect(granolaConfig({ pollSeconds: "600" }).pollSeconds).toBe(600);
    expect(granolaConfig({ pollSeconds: "0.05", apiUrl: "http://127.0.0.1:1" }).pollSeconds).toBe(0.05);
  });

  test("a pasted key: grn_ prefix, no space; it is stored under integrations/granola.<id>.api_key", () => {
    const meta = registry.meta("granola");
    expect(meta?.apiKey?.prefix).toBe("grn_");
    expect(apiKeyProblem(meta, "")).toBe("paste the API key");
    expect(apiKeyProblem(meta, "sk-123")).toBe("a Granola API key starts with grn_");
    expect(apiKeyProblem(meta, "grn_a b")).toBe("the API key has a space in it");
    expect(apiKeyProblem(meta, " grn_abc ")).toBeUndefined();
    expect(apiKeyProblem(registry.meta("slack"), "grn_abc")).toContain("takes no pasted API key");
    expect(apiKeySecret("granola", "work")).toEqual({ scope: "integrations", name: "granola.work.api_key", ref: "secret:integrations/granola.work.api_key" });
  });

  test("read only: no outbound, both verbs are reads, a read account still searches and reads", () => {
    expect(GRANOLA_CAPS.outbound).toBe(false);
    expect(GRANOLA_VERBS).toEqual({ search: "read", read: "read" });
    const acct = { id: "g", name: "g", kind: "granola", access: "read" as const, events: "off" as const };
    expect(integrationAccessRefusal(acct, "read", GRANOLA_VERBS)).toBeUndefined();
    expect(integrationAccessRefusal(acct, "search", GRANOLA_VERBS)).toBeUndefined();
    expect(integrationAccessRefusal(acct, "send", GRANOLA_VERBS)).toContain("read");
  });

  test("orca granola is the owner's own chat, as orca gmail: an outside grant gets the same answer", () => {
    for (const level of ["notify", "ask", "work"] as const) {
      const g = { level, repos: ["r"] };
      expect(grantRefusal(g, "granola", { _: ["read", "not_1"] })).toBe(grantRefusal(g, "gmail", { _: ["read", "m1"] })?.replace(/gmail/g, "granola"));
      expect(grantRefusal(g, "granola", { _: ["read", "not_1"] })).toBeDefined();
    }
  });

  test("meeting text is outside data: a memory written after orca granola read is untrusted", () => {
    const w = { messages: ["what did we agree?"], steps: [{ name: "Bash", command: "orca granola read not_00000000000001" }], scopedWorkstreams: new Set<string>() };
    expect(provenance(w as never).trust).toBe("untrusted");
    // The verbs ride every wake's command list, beside orca gmail.
    const prompt = orchestratorPrompt({ fresh: false, board: "", messages: [] });
    expect(prompt).toContain("orca granola search");
    expect(prompt).toContain("orca granola read <note id> [--transcript]");
    expect(prompt.indexOf("orca granola search")).toBeGreaterThan(prompt.indexOf("orca gmail read"));
  });

  test("a note is new once: seen ids skip, a deleted note and an edit of an old note are no event", () => {
    const from = "2026-10-27T09:00:00.000Z";
    const cur = { from, seen: ["not_a"] };
    const n = (id: string, created: string, deleted?: string) => ({ id, object: "note" as const, title: "t", owner: { name: null, email: "x@y" }, created_at: created, updated_at: created, deleted_at: deleted ?? null });
    expect(noteDecision(n("not_a", from), cur)).toBe("seen");
    expect(noteDecision(n("not_b", from, from), cur)).toBe("deleted");
    expect(noteDecision(n("not_c", iso(Date.parse(from) - OLD_NOTE_MS - 1)), cur)).toBe("old");
    // A meeting that began before the first poll and finished after it is new.
    expect(noteDecision(n("not_d", iso(Date.parse(from) - 30 * 60_000)), cur)).toBe("take");
  });

  test("the cursor: since moves to the newest updated_at; at the page cap the page cursor is kept and since stays", () => {
    const cur: GranolaCursor = { v: 1, from: "2026-10-27T09:00:00.000Z", since: "2026-10-27T09:00:00.000Z", seen: ["old"] };
    const ns = [{ updated_at: "2026-10-27T10:00:00.000Z" }, { updated_at: "2026-10-27T09:30:00.000Z" }] as never;
    expect(nextCursor(cur, ns, ["n1", "n2"], { hasMore: false, cursor: null })).toEqual({ v: 1, from: cur.from, since: "2026-10-27T10:00:00.000Z", seen: ["old", "n1", "n2"] });
    expect(nextCursor(cur, ns, ["n1"], { hasMore: true, cursor: "abc" })).toEqual({ ...cur, page: "abc", seen: ["old", "n1"] });
    expect(readCursor("nonsense")).toBeUndefined();
    expect(readCursor(JSON.stringify(cur))).toEqual(cur);
  });

  test("the place: the direct folder with its parents, else notes", () => {
    expect(notePlace({ folder_membership: [] })).toEqual({ channel: "notes", parents: [] });
    expect(notePlace({ folder_membership: [
      { id: "fol_top", name: "Team", parent_folder_id: null },
      { id: "fol_mid", name: "Eng", parent_folder_id: "fol_top" },
      { id: "fol_leaf", name: "Standup", parent_folder_id: "fol_mid" },
    ] })).toEqual({ channel: "folder:fol_leaf", parents: ["folder:fol_mid", "folder:fol_top"] });
  });

  test("the event: title and id, time, attendees, the summary, and how to read the rest", () => {
    const n = note({ id: "not_AAAAAAAAAAAAAA", title: "Daily standup", at: Date.parse("2026-10-27T09:30:00Z") });
    const e = noteEnvelope("gr", n);
    expect(e).toMatchObject({ key: "granola:gr:not_AAAAAAAAAAAAAA", topic: "ext.granola.note", title: "Daily standup", source: { adapter: "granola", integrationId: "gr", channel: "notes" }, thread: { adapter: "granola", externalId: "not_AAAAAAAAAAAAAA" }, link: { url: "https://notes.granola.ai/d/x" } });
    expect(e.actor).toBeUndefined(); // a machine sender: the link's level is the grant
    // What the orchestrator reads: fenced outside data, with no sender to answer.
    const fenced = fenceExternal({ ...e, source: { ...e.source, linkId: "gr-notes" }, grant: { level: "ask", repos: [] } });
    expect(fenced).toContain("[external message] via granola link gr-notes thread not_AAAAAAAAAAAAAA · from the granola integration (a machine event) · grant: ask");
    expect(fenced).toContain("~~~external\nMeeting notes ready: Daily standup");
    expect(fenced).toContain("granola takes no posts");
    expect(e.text.split("\n")).toEqual([
      "Meeting notes ready: Daily standup",
      "When: 2026-10-27 09:30 UTC · Attendees: Ana Lee <ana@example.com>, sam@example.com",
      "", "## Standup", "- Ana: ship the login fix", "",
      "Granola note not_AAAAAAAAAAAAAA. Read the full note with: orca granola read not_AAAAAAAAAAAAAA [--transcript]",
    ]);
  });

  test("errors: 401 is a bad key with what to do; 429 and 5xx retry; no error holds the key", () => {
    const bad = granolaError(401, { message: "Invalid API key" });
    expect(bad.badKey).toBe(true);
    expect(bad.retryable).toBe(false);
    expect(bad.message).toContain("Settings > Connectors > API keys");
    expect(granolaError(429, {}, "7")).toMatchObject({ retryable: true, retryAfterMs: 7000 });
    expect(granolaError(503, {}).retryable).toBe(true);
    expect(granolaError(403, {}).message).toContain("access scope");
  });

  test("search words and --since; the transcript as timed lines by speaker", () => {
    const now = Date.parse("2026-10-27T12:00:00Z");
    expect(sinceIso(undefined, now)).toBe("2026-10-20T12:00:00.000Z");
    expect(sinceIso("24h", now)).toBe("2026-10-26T12:00:00.000Z");
    expect(sinceIso("2w", now)).toBe("2026-10-13T12:00:00.000Z");
    expect(sinceIso("2026-10-01", now)).toBe("2026-10-01T00:00:00.000Z");
    expect(() => sinceIso("soon", now)).toThrow("--since");
    const s = { id: "not_x", object: "note" as const, title: "Daily Standup — Eng", owner: { name: "Finn", email: "f@x" }, created_at: "", updated_at: "" };
    expect(matches(s, ["standup", "eng"])).toBe(true);
    expect(matches(s, ["standup", "sales"])).toBe(false);
    expect(matches(s, [])).toBe(true);
    expect(transcriptText([
      { speaker: { source: "microphone", attribution: "me" }, text: "Morning.", start_time: "2026-10-27T09:30:05Z", end_time: "" },
      { speaker: { source: "speaker", name: "Ana Lee" }, text: "I ship the fix today.", start_time: "2026-10-27T09:31:00Z", end_time: "" },
    ])).toBe("[09:30] Me: Morning.\n[09:31] Ana Lee: I ship the fix today.");
  });
});

describe("against a fake Granola", () => {
  let pg: TestDb;
  let g: ReturnType<typeof fakeGranola>;
  let stateDir: string;
  let prev: Record<string, string | undefined>;
  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE, ORCA_STATE_DIR: process.env.ORCA_STATE_DIR, ORCA_SECRETS_KEY: process.env.ORCA_SECRETS_KEY };
    process.env.ORCA_INSTANCE = "local";
    delete process.env.ORCA_SECRETS_KEY;
    stateDir = await mkdtemp(join(tmpdir(), "orca-granola-"));
    process.env.ORCA_STATE_DIR = stateDir;
    pg = await freshSchema("granola");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    router.resetPace();
    dispatcher.resetPace();
    secretRefs.clear();
    invalidateConfig();
    g = fakeGranola();
  });
  afterEach(async () => {
    await registry.stopAll();
    g.stop();
    invalidateConfig();
    await db.close();
    await pg.drop();
    await rm(stateDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  /** Connect the way the Integrations page does: a pasted key on the save. */
  const connect = async (extra: Record<string, unknown> = {}, key = KEY) => {
    await admin.saveIntegration({ id: "gr", kind: "granola", name: "Granola", instance: "local", apiKey: key, config: { apiUrl: g.base, pollSeconds: "0.05" }, ...extra });
    return (await store.integration("gr"))!;
  };
  const cursor = async () => readCursor(await store.cursor("gr"));
  /** The core's inbound pace (20 a link in 10 minutes) off for a bulk test: it tests pages, not the pace. */
  let paceTimer: ReturnType<typeof setInterval> | undefined;
  const unpaced = () => { paceTimer = setInterval(() => router.resetPace(), 5); };
  afterEach(() => { if (paceTimer) clearInterval(paceTimer); paceTimer = undefined; });
  const events = async () => (await Promise.all(g.st.notes.map((n) => store.event(`granola:gr:${n.id}`)))).filter(Boolean);

  test("Connect: the pasted key goes to the secret store and nowhere else; read + events off, a Viewer * link; Test checks the key", async () => {
    const c = await connect();
    expect(c).toMatchObject({ kind: "granola", secretRef: "secret:integrations/granola.gr.api_key", access: "read", events: "off" });
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect((await secrets.list()).map((s) => `${s.scope}/${s.name}`)).toEqual(["integrations/granola.gr.api_key"]);
    expect(await secrets.valueOf("integrations/granola.gr.api_key")).toBe(KEY);
    expect((await store.links()).filter((l) => l.integrationId === "gr")).toMatchObject([{ externalId: "*", level: "ask", requireMention: false }]);
    // A bad paste stores nothing and saves nothing.
    await expect(admin.saveIntegration({ id: "gr2", kind: "granola", name: "Other", instance: "local", apiKey: "sk-nope" })).rejects.toThrow("starts with grn_");
    expect(await store.integration("gr2")).toBeUndefined();

    expect(await registry.startOne(c)).toBe(true);
    // Events off: no Granola call from the loop.
    await Bun.sleep(200);
    expect(g.st.log).toEqual([]);
    const t = await admin.testIntegration("gr");
    expect(t).toMatchObject({ ok: true, detail: expect.stringContaining("the API key works · no notes yet") });
    expect(g.st.log).toEqual(["GET /v1/notes?page_size=1"]);

    // Remove deletes the stored key the row owns.
    await admin.removeIntegration("gr");
    expect(await secrets.list()).toEqual([]);
  });

  test("a bad key: Test and the card say so with what to do, the poll waits, and orca granola refuses", async () => {
    const c = await connect({ events: "trigger" }, "grn_revoked");
    expect(await registry.startOne(c)).toBe(true);
    const h = await until(async () => { const x = (await registry.health()).gr; return x && !x.ok && x.detail ? x : undefined; });
    expect(h.detail).toContain("Granola refused the API key (401)");
    expect(await admin.testIntegration("gr")).toMatchObject({ ok: false, detail: expect.stringContaining("Settings > Connectors > API keys") });
    // Not retried in a loop: a non-retryable error waits one poll interval, and no cursor is made.
    expect(await store.cursor("gr")).toBeUndefined();
    await expect(granolaTool({ _: ["search", "standup"] })).rejects.toThrow("refused the API key");
  });

  test("the poll: starts at now, one event per new finished meeting, pages past 30, no event for an old note's edit", async () => {
    unpaced();
    const old = note({ title: "Last week's planning", at: Date.now() - 7 * 86_400_000 });
    g.st.notes.push(old);
    const c = await connect({ events: "trigger" });
    expect(await registry.startOne(c)).toBe(true);
    const first = await until(cursor);
    expect(first.seen).toEqual([]);
    // Notes appear only once finished: 35 new meetings, more than one page.
    for (let i = 0; i < 35; i++) g.st.notes.push(note({ title: i === 0 ? "Daily standup" : `Meeting ${i}`, at: Date.now() + i * 1000 }));
    // The old note is edited now: it shows in updated_after, but it is no new meeting.
    old.updated_at = iso(Date.now() + 120_000);
    await until(async () => (await cursor())?.seen.length === 36);
    const evs = await events();
    expect(evs).toHaveLength(35);
    expect(await store.event(`granola:gr:${old.id}`)).toBeUndefined();
    const standup = g.st.notes.find((n) => n.title === "Daily standup")!;
    expect(await store.event(`granola:gr:${standup.id}`)).toMatchObject({ topic: "ext.granola.note", title: "Daily standup", source: { channel: "notes", linkId: "gr-notes" }, grant: { level: "ask" } });
    expect(g.st.log.some((l) => l.includes("/v1/notes?") && l.includes("cursor="))).toBe(true); // the second page
    expect(g.st.log.every((l) => l.startsWith("GET "))).toBe(true);
    // The first poll checks the key (page_size=1); every later list asks for full pages since the cursor.
    expect(g.st.log[0]).toBe("GET /v1/notes?page_size=1");
    expect(g.st.log.slice(1).filter((l) => l.startsWith("GET /v1/notes?")).every((l) => l.includes(`page_size=${PAGE_SIZE}`) && l.includes("updated_after="))).toBe(true);
    // A quiet tick reads only the list.
    const before = g.st.log.length;
    await Bun.sleep(200);
    expect(new Set(g.st.log.slice(before).map((l) => l.split("?")[0]))).toEqual(new Set(["GET /v1/notes"]));
    expect((await registry.health()).gr).toMatchObject({ ok: true, detail: expect.stringContaining("watching new meeting notes") });
  });

  test("no replay after a restart: the cursor survives, old meetings stay quiet, only the next new one is an event", async () => {
    const c = await connect({ events: "trigger" });
    expect(await registry.startOne(c)).toBe(true);
    await until(cursor);
    const a = note({ title: "Standup Monday" });
    g.st.notes.push(a);
    await until(() => store.event(`granola:gr:${a.id}`));
    await until(async () => (await cursor())?.seen.includes(a.id));
    await registry.stopAll();
    const saved = await cursor();

    // The bridge restarts: a fresh adapter on the same row and cursor.
    const b = note({ title: "Standup Tuesday", at: Date.now() + 5_000 });
    g.st.notes.push(b);
    expect(await registry.startOne(c)).toBe(true);
    await until(() => store.event(`granola:gr:${b.id}`));
    expect((await cursor())?.from).toBe(saved!.from); // the same watch, not a new "from now"
    // The first meeting was not handed in again (seen in the cursor, before the core's key dedupe).
    expect(g.st.log.filter((l) => l === `GET /v1/notes/${a.id}`)).toHaveLength(1);
    expect((await cursor())?.seen).toEqual([a.id, b.id]);
  });

  test("one poll takes at most MAX_EVENTS_PER_POLL new meetings (under the core's pace); the next poll takes the rest", async () => {
    const c = await connect({ events: "trigger", config: { apiUrl: g.base, pollSeconds: "0.3" } });
    expect(await registry.startOne(c)).toBe(true);
    const start = await until(cursor);
    for (let i = 0; i < MAX_EVENTS_PER_POLL + 3; i++) g.st.notes.push(note({ title: `Meeting ${i}`, at: Date.now() + i }));
    const first = await until(async () => { const k = await cursor(); return k && k.seen.length ? k : undefined; });
    expect(first.seen).toHaveLength(MAX_EVENTS_PER_POLL);
    expect(first.since).toBe(start.since); // capped: the same window again next poll
    await until(async () => (await cursor())?.seen.length === MAX_EVENTS_PER_POLL + 3);
    expect(await events()).toHaveLength(MAX_EVENTS_PER_POLL + 3); // none dropped by the pace
  });

  test("the page cap: a poll reads at most MAX_PAGES pages, keeps Granola's cursor, and the next poll reads the rest", async () => {
    const c = await connect({ events: "trigger" });
    expect(await registry.startOne(c)).toBe(true);
    await until(cursor);
    unpaced();
    const total = MAX_PAGES * PAGE_SIZE + 7;
    for (let i = 0; i < total; i++) g.st.notes.push(note({ title: `Bulk ${i}`, at: Date.now() + i }));
    await until(async () => (await cursor())?.page, 10_000);
    await until(async () => { const k = await cursor(); return k && !k.page && k.seen.length === total ? k : undefined; }, 15_000);
    expect(await events()).toHaveLength(total);
  });

  test("orca granola search and read: meetings with attendees, pages of the list, the summary, notes and transcript", async () => {
    await connect();
    const standup = note({ id: "not_STANDUP0000001", title: "Daily standup", at: Date.now() - 3_600_000, private_notes_markdown: "- ask Ana about the fix", folder_membership: [{ id: "fol_aaaaaaaaaaaaaa", name: "Eng", parent_folder_id: null }] });
    const older = note({ id: "not_STANDUP0000000", title: "Daily standup", at: Date.now() - 2 * 86_400_000 });
    g.st.notes.push(standup, older, note({ title: "Ancient standup", at: Date.now() - 30 * 86_400_000 }));
    for (let i = 0; i < 40; i++) g.st.notes.push(note({ title: `Customer call ${i}`, at: Date.now() - 4 * 3_600_000 - i * 1000 }));
    const found = await granolaTool({ _: ["search", "standup"], since: "7d", limit: "5" });
    const lines = found.split("\n");
    expect(lines[0]).toBe("Granola account Granola (gr)");
    expect(lines[1]).toBe(OUTSIDE_NOTE);
    expect(lines[2]).toMatch(/^2 meetings for "standup" since /);
    expect(lines[3]).toContain("not_STANDUP0000001 · ");
    expect(lines[3]).toContain("Daily standup");
    expect(lines[4]).toBe("  attendees: Ana Lee <ana@example.com>, sam@example.com");
    expect(lines[5]).toContain("not_STANDUP0000000"); // newest first
    expect(found).not.toContain("Ancient standup"); // outside --since
    // 42 notes in the window: the search read past the first page of 30.
    expect(g.st.log.filter((l) => l.startsWith("GET /v1/notes?") && l.includes("created_after="))).toHaveLength(2);
    expect(await granolaTool({ _: ["search"], limit: "2" })).toMatch(/2 meetings for every meeting since .*\(40 more: raise --limit/);
    expect(await granolaTool({ _: ["search", "retro"] })).toContain('No meeting notes for "retro"');

    const one = await granolaTool({ _: ["read", standup.id] });
    expect(one).toContain(`Note ${standup.id}: Daily standup`);
    expect(one).toContain("Attendees: Ana Lee <ana@example.com>, sam@example.com");
    expect(one).toContain("Folders: Eng");
    expect(one).toContain("## Summary\n## Standup\n- Ana: ship the login fix");
    expect(one).toContain("## The user's own notes\n- ask Ana about the fix");
    expect(one).not.toContain("## Transcript");

    // --transcript: inline, else (413 TRANSCRIPT_TOO_LARGE) page by page.
    const items = Array.from({ length: 130 }, (_, i) => ({ speaker: { source: i % 2 ? "speaker" : "microphone", ...(i % 2 ? { name: "Ana Lee" } : { attribution: "me" as const }) }, text: `line ${i}`, start_time: "2026-10-27T09:30:00Z", end_time: "2026-10-27T09:30:05Z" }));
    g.st.transcripts.set(standup.id, { items: items.slice(0, 2) });
    const small = await granolaTool({ _: ["read", standup.id], transcript: "" });
    expect(small).toContain("## Transcript\n[09:30] Me: line 0\n[09:30] Ana Lee: line 1");
    g.st.transcripts.set(standup.id, { items, tooLarge: true });
    const big = await granolaTool({ _: ["read"], transcript: standup.id }); // `--transcript <id>`: the flag took the id
    expect(big).toContain("[09:30] Me: line 128\n[09:30] Ana Lee: line 129");
    expect(g.st.log.filter((l) => l.startsWith(`GET /v1/notes/${standup.id}/transcript`))).toHaveLength(2);

    await expect(granolaTool({ _: ["read", "not_missing0000000"] })).rejects.toThrow("not found");
    await expect(granolaTool({ _: ["read", "12"] })).rejects.toThrow("note id like not_");
    await expect(granolaTool({ _: ["delete", standup.id] })).rejects.toThrow("read only");
    expect(g.st.log.every((l) => l.startsWith("GET "))).toBe(true);

    // A second account: --account picks one; none named is an error, never a guess.
    await admin.saveIntegration({ id: "team", kind: "granola", name: "Team", instance: "local", apiKey: KEY, config: { apiUrl: g.base } });
    await expect(granolaTool({ _: ["read", standup.id] })).rejects.toThrow("2 granola accounts are connected");
    expect((await granolaTool({ _: ["read", standup.id], account: "team" })).split("\n")[0]).toBe("Granola account Team (team)");
    // Through the orchestrator's tool route, from your own chat.
    const cfg = { repos: [], portRange: [0, 0], staleHours: 1 } as never;
    expect(await orchestrator.tool(cfg, "granola", { _: ["read", standup.id], account: "gr" })).toContain("Daily standup");
  });
});
