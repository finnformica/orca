// The two-way Slack adapter (docs/integrations/slack.md) against a fake Socket Mode socket and a
// stubbed Web API — never a real Slack, never a real token. It covers what the adapter owns: inbound
// off with no app-level token, the socket (open, ack every envelope, hello, disconnect, reconnect,
// a fatal app token), a message event as the core's envelope (a mention of you, a DM, a group DM, a
// reply in a known thread; your own and other chatter dropped), outbound to a channel, a user id (a
// DM opened first) or a group, `orca slack` (conversations, read, search, post) and its grant. The
// last block runs the adapter on the REAL core (Postgres): a DM in, the inbox's Reply out, and an
// unknown sender who gets no automatic post in your name.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../server/db";
import * as router from "../server/integrations/router";
import * as dispatcher from "../server/integrations/dispatcher";
import * as store from "../server/integrations/store";
import { context } from "../server/integrations/registry";
import { postAsUser, slackAdapter, slackInbound, socketMode, threadTs, type WebSocketLike } from "../server/integrations/adapters/slack";
import { resetSlackToolCache, slackTool } from "../server/slackTool";
import { ORCA_SECRETS } from "../server/env";
import type { AdapterContext, Connection, InboundEnvelope } from "../server/integrations/adapter";
import { fenceExternal, grantRefusal } from "../shared/integrations";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const dom = { fetch: globalThis.fetch, Response: globalThis.Response };
beforeAll(() => { Object.assign(globalThis, native); });
afterAll(() => { Object.assign(globalThis, dom); });

class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  sent: Record<string, unknown>[] = [];
  closed?: number;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code = 1000) { this.closed = code; this.onclose?.({ code }); }
  /** The server side: push a frame, or drop the connection. */
  push(p: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(p) }); }
  drop(code: number) { this.onclose?.({ code }); }
}

type Call = { method: string; auth: string; body: Record<string, unknown> };
let calls: Call[] = [];
let answer: (c: Call) => Record<string, unknown> = () => ({ ok: true });
const realWs = socketMode.WebSocket;
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5)); };

/** The Web API: JSON for writes, a form for reads, as the adapter sends them. */
const fetchStub = (async (url: unknown, init?: RequestInit) => {
  const method = String(url).replace("https://slack.com/api/", "");
  const type = (init?.headers as Record<string, string>)["content-type"] ?? "";
  const body = type.startsWith("application/json") ? JSON.parse(String(init?.body ?? "{}")) : Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
  const c = { method, auth: (init?.headers as Record<string, string>).authorization ?? "", body };
  calls.push(c);
  return Response.json(answer(c));
}) as typeof fetch;

/** The Slack the tests talk to: who you are, Socket Mode, DMs, users and messages. */
const defaultAnswer = (c: Call): Record<string, unknown> => {
  switch (c.method) {
    case "auth.test": return { ok: true, user_id: "UFINN", user: "finn", team_id: "T1" };
    case "apps.connections.open": return { ok: true, url: "wss://socket.test/link" };
    case "conversations.open": return { ok: true, channel: { id: String(c.body.users).includes(",") ? "GMP1" : "DNEW" } };
    case "users.info": return { ok: true, user: { id: c.body.user, name: "saajan", profile: { display_name: "Saajan" } } };
    case "chat.postMessage": return { ok: true, channel: c.body.channel, ts: "9.9" };
    default: return { ok: true };
  }
};

const conn = (config: Record<string, unknown> = {}): Connection =>
  ({ id: "slack", kind: "slack", name: "Work Slack", instance: "local", config, secretRef: "SLACK_TOKEN", enabled: true });

function fakeCtx(verdict: "new" | "duplicate" | "rejected" = "new") {
  const ingested: InboundEnvelope[] = [];
  const statuses: { ok: boolean; detail?: string }[] = [];
  const abort = new AbortController();
  const ctx: AdapterContext = {
    connection: conn(), secret: () => "xoxp-test", signal: abort.signal, log: () => {},
    ingest: async (e) => { ingested.push(e); return verdict; },
    cursor: { get: async () => undefined, set: async () => {} },
    status: async (s) => { statuses.push(s); },
  };
  return { ctx, ingested, statuses, abort };
}

const ev = (over: Record<string, unknown> = {}) => ({
  type: "message", user: "USAAJAN", text: "<@UFINN> can you look at #12?", ts: "1700000000.000100", channel: "C1", channel_type: "channel", ...over,
});
const envelope = (id: string, event: Record<string, unknown>) => ({ type: "events_api", envelope_id: id, payload: { team_id: "T1", event } });
const me = { team: "T1", userId: "UFINN", name: "finn", integrationId: "slack" };

describe("slackInbound: what reaches Orca", () => {
  test("a mention of you in a channel: your name in the text, a thread on the message, no content in raw", () => {
    const e = slackInbound(ev(), me)!;
    expect(e).toMatchObject({
      key: "slack:T1:C1:1700000000.000100", topic: "ext.slack.message", mentioned: true, text: "@finn can you look at #12?",
      source: { adapter: "slack", integrationId: "slack", channel: "C1" },
      actor: { external: { adapter: "slack", id: "USAAJAN" } },
      thread: { adapter: "slack", externalId: "C1:1700000000.000100", messageId: "1700000000.000100" },
    });
    expect(e.source.parents).toBeUndefined();
    expect(JSON.stringify(e.raw)).not.toContain("look at");
  });

  test("other chatter, your own messages, bots, edits and empty text never leave the adapter", () => {
    expect(slackInbound(ev({ text: "lunch?" }), me)).toBeUndefined();
    expect(slackInbound(ev({ user: "UFINN" }), me)).toBeUndefined(); // a post Orca made as you does not loop back
    expect(slackInbound(ev({ bot_id: "B1" }), me)).toBeUndefined();
    expect(slackInbound(ev({ subtype: "message_changed" }), me)).toBeUndefined();
    expect(slackInbound(ev({ subtype: "channel_join" }), me)).toBeUndefined();
    expect(slackInbound(ev({ type: "reaction_added" }), me)).toBeUndefined();
    expect(slackInbound(ev({ text: "<@UFINN>" }), { ...me, name: "" })).toBeUndefined();
  });

  test("a DM and a group DM: every message counts, under the place im / mpim, answered in the conversation", () => {
    const dm = slackInbound(ev({ channel: "D1", channel_type: "im", text: "are you free &amp; around?" }), me)!;
    expect(dm).toMatchObject({ source: { channel: "D1", parents: ["im"] }, thread: { externalId: "D1" }, text: "are you free & around?" });
    const group = slackInbound(ev({ channel: "G7", channel_type: "mpim", text: "standup notes" }), me)!;
    expect(group).toMatchObject({ source: { channel: "G7", parents: ["mpim"] }, thread: { externalId: "G7" } });
    const inThread = slackInbound(ev({ channel: "D1", channel_type: "im", text: "more", thread_ts: "1.5" }), me)!;
    expect(inThread.thread!.externalId).toBe("D1:1.5");
  });

  test("a reply with no mention counts only in a thread Orca already talks in", () => {
    const reply = ev({ text: "thanks, and the tests?", thread_ts: "1.1" });
    expect(slackInbound(reply, me)).toBeUndefined();
    expect(slackInbound(reply, me, { known: (k) => k === "C1:1.1" })).toMatchObject({ thread: { externalId: "C1:1.1" }, text: "thanks, and the tests?" });
  });

  test("threadTs: a key's ts, a bare ts, never a bare channel id", () => {
    expect(threadTs("C1:1.1")).toBe("1.1");
    expect(threadTs("1.1")).toBe("1.1");
    expect(threadTs("D1")).toBeUndefined();
    expect(threadTs(undefined)).toBeUndefined();
  });
});

describe("the Slack adapter: Socket Mode and posts", () => {
  beforeEach(() => {
    calls = [];
    FakeSocket.all = [];
    answer = defaultAnswer;
    process.env.SLACK_TOKEN = "xoxp-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    socketMode.WebSocket = FakeSocket as never;
    socketMode.baseBackoffMs = 5;
    globalThis.fetch = fetchStub;
  });
  afterEach(() => {
    globalThis.fetch = native.fetch;
    socketMode.WebSocket = realWs;
    socketMode.baseBackoffMs = 1_000;
    delete process.env.SLACK_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
  });

  async function connected() {
    const a = slackAdapter(conn());
    const f = fakeCtx();
    await a.start(f.ctx);
    const ws = FakeSocket.all[0]!;
    ws.push({ type: "hello", num_connections: 1 });
    return { a, ws, ...f };
  }

  test("no SLACK_APP_TOKEN: inbound stays off cleanly — no error, no socket, posts still work", async () => {
    delete process.env.SLACK_APP_TOKEN;
    const a = slackAdapter(conn());
    await a.start(fakeCtx().ctx);
    expect(FakeSocket.all).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(await a.health()).toEqual({ ok: true, detail: "signed in as finn; inbound off: SLACK_APP_TOKEN is not set" });
    expect(await a.send({ externalId: "C1" }, { text: "hi" }, "1")).toMatchObject({ ok: true });
    // config socket: false turns it off with the app token set, too.
    process.env.SLACK_APP_TOKEN = "xapp-test";
    await slackAdapter(conn({ socket: "false" })).start(fakeCtx().ctx);
    expect(FakeSocket.all).toHaveLength(0);
  });

  test("the app-level token is an Orca secret: agents never get it, and the row may not name another variable", async () => {
    expect(ORCA_SECRETS).toContain("SLACK_APP_TOKEN");
    process.env.SOME_APP = "xapp-test";
    await expect(slackAdapter(conn({ appTokenRef: "SOME_APP" })).start(fakeCtx().ctx)).rejects.toThrow(/must start with ORCA_SECRET_/);
    delete process.env.SOME_APP;
  });

  test("start: auth.test with the user token, apps.connections.open with the app token, the socket on Slack's URL", async () => {
    const { a, ws, statuses } = await connected();
    expect(calls.map((c) => [c.method, c.auth])).toEqual([["auth.test", "Bearer xoxp-test"], ["apps.connections.open", "Bearer xapp-test"]]);
    expect(ws.url).toBe("wss://socket.test/link");
    expect(statuses.at(-1)).toMatchObject({ ok: true, detail: "Socket Mode connected as finn" });
    expect(await a.health()).toMatchObject({ ok: true });
    await a.stop();
  });

  test("a bad user token fails the start; a bad app token stops without a reconnect loop", async () => {
    answer = (c) => (c.method === "auth.test" ? { ok: false, error: "invalid_auth" } : defaultAnswer(c));
    await expect(slackAdapter(conn()).start(fakeCtx().ctx)).rejects.toThrow("Slack refused the user token (auth.test: invalid_auth)");
    answer = (c) => (c.method === "apps.connections.open" ? { ok: false, error: "invalid_auth" } : defaultAnswer(c));
    const f = fakeCtx();
    await slackAdapter(conn()).start(f.ctx);
    await settle();
    expect(FakeSocket.all).toHaveLength(0);
    expect(calls.filter((c) => c.method === "apps.connections.open")).toHaveLength(1);
    expect(f.statuses.at(-1)!.detail).toContain("Slack refused the app-level token (invalid_auth)");
  });

  test("every envelope is acked, also one Orca ignores; a mention is ingested with the sender's name", async () => {
    const { a, ws, ingested } = await connected();
    ws.push(envelope("E1", ev({ text: "lunch?" })));
    ws.push(envelope("E2", ev()));
    ws.push({ type: "slash_commands", envelope_id: "E3", payload: {} });
    await settle();
    expect(ws.sent).toEqual([{ envelope_id: "E1" }, { envelope_id: "E2" }, { envelope_id: "E3" }]);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({ text: "@finn can you look at #12?", actor: { external: { id: "USAAJAN", name: "Saajan" } } });
    await a.stop();
  });

  test("disconnect opens a new connection; a dropped socket reconnects with backoff; stop ends it", async () => {
    const { a, ws } = await connected();
    ws.push({ type: "disconnect", reason: "refresh_requested" });
    await settle();
    expect(FakeSocket.all).toHaveLength(2);
    expect(calls.filter((c) => c.method === "apps.connections.open")).toHaveLength(2);
    FakeSocket.all[1]!.push({ type: "hello" });
    FakeSocket.all[1]!.drop(1006);
    await settle();
    expect(FakeSocket.all).toHaveLength(3);
    // A failed open retries too (a network error, a 5xx), with Slack's Retry-After when it gives one.
    answer = (c) => (c.method === "apps.connections.open" ? { ok: false, error: "internal_error" } : defaultAnswer(c));
    FakeSocket.all[2]!.drop(1006);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.filter((c) => c.method === "apps.connections.open").length).toBeGreaterThan(4);
    await a.stop();
    const after = calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.length).toBe(after);
  });

  test("a thread Orca posted in: a reply there with no mention reaches Orca", async () => {
    const { a, ws, ingested } = await connected();
    expect(await a.send({ externalId: "C1" }, { text: "I will look" }, "1")).toEqual({ ok: true, externalMsgId: "9.9", threadId: "C1:9.9" });
    ws.push(envelope("E1", ev({ text: "great, thanks", thread_ts: "9.9" })));
    ws.push(envelope("E2", ev({ text: "unrelated", thread_ts: "4.4" })));
    await settle();
    expect(ingested.map((e) => e.text)).toEqual(["great, thanks"]);
    await a.stop();
  });

  test("outbound: a user id opens the DM first, a list opens a group DM, a DM conversation gets no thread", async () => {
    const a = slackAdapter(conn());
    expect(await a.send({ externalId: "UANA" }, { text: "hello" }, "1")).toMatchObject({ ok: true, threadId: "DNEW:9.9" });
    expect(calls.slice(-2).map((c) => [c.method, c.body])).toEqual([["conversations.open", { users: "UANA" }], ["chat.postMessage", { channel: "DNEW", text: "hello" }]]);
    await a.send({ externalId: "UANA,UBEN" }, { text: "hi both" }, "2");
    expect(calls.slice(-2).map((c) => [c.method, c.body])).toEqual([["conversations.open", { users: "UANA,UBEN" }], ["chat.postMessage", { channel: "GMP1", text: "hi both" }]]);
    // The answer to a top-level DM: in the DM, not in a thread; `--thread` puts it in a thread on the message.
    expect(await a.send({ externalId: "D1", threadId: "D1" }, { text: "yes" }, "3")).toEqual({ ok: true, externalMsgId: "9.9", threadId: "D1" });
    expect(calls.at(-1)!.body).toEqual({ channel: "D1", text: "yes" });
    expect(await a.send({ externalId: "D1", threadId: "D1" }, { text: "long answer", thread: true, replyToExternalMsgId: "5.5" }, "4")).toMatchObject({ threadId: "D1:5.5" });
    expect(calls.at(-1)!.body).toEqual({ channel: "D1", text: "long answer", thread_ts: "5.5" });
    // A channel thread key, as before.
    await a.send({ externalId: "C1", threadId: "C1:1.1" }, { text: "done" }, "5");
    expect(calls.at(-1)!.body).toEqual({ channel: "C1", text: "done", thread_ts: "1.1" });
    answer = (c) => (c.method === "conversations.open" ? { ok: false, error: "user_not_found" } : defaultAnswer(c));
    expect(await a.send({ externalId: "UNOPE" }, { text: "x" }, "6")).toEqual({ ok: false, retryable: false, error: "user_not_found" });
  });

  test("/api/slack's post (postAsUser) is unchanged: the channel goes to chat.postMessage as given", async () => {
    expect(await postAsUser("UANA", "<https://gh/7|#7 Add X>")).toEqual({ ok: true });
    expect(calls.map((c) => [c.method, c.body])).toEqual([["chat.postMessage", { channel: "UANA", text: "<https://gh/7|#7 Add X>" }]]);
  });

  test("an outside Slack sender's fence says the answer posts as the user", () => {
    const fenced = fenceExternal({ text: "hi", source: { adapter: "slack", linkId: "L1" }, grant: { level: "ask", repos: [], linkId: "L1" } });
    expect(fenced).toContain("posts as the user, in their name");
    expect(fenceExternal({ text: "hi", source: { adapter: "discord", linkId: "L1" } })).not.toContain("posts as the user");
  });
});

describe("orca slack: conversations, read, search, post", () => {
  const log: string[] = [];
  const run = (words: string[], flags: Record<string, unknown> = {}) => slackTool({ ...flags, _: words }, { env: { SLACK_TOKEN: "xoxp-test" }, log: (l) => log.push(l), by: "orchestrator (your chat)" });
  beforeEach(() => {
    calls = [];
    log.length = 0;
    resetSlackToolCache();
    globalThis.fetch = fetchStub;
    answer = (c) => {
      switch (c.method) {
        case "users.list": return { ok: true, members: [{ id: "UANA", name: "ana", profile: { display_name: "Ana" } }, { id: "UOLD", name: "old", deleted: true }], response_metadata: { next_cursor: "" } };
        case "users.conversations": return { ok: true, channels: [{ id: "C1", name: "eng" }, { id: "G2", name: "secret", is_private: true }, { id: "D3", is_im: true, user: "UANA" }, { id: "G4", name: "mpdm-ana--finn-1", is_mpim: true }] };
        case "conversations.history": return { ok: true, messages: [{ ts: "1700000200.0", user: "UANA", text: "second &amp; last", reply_count: 2 }, { ts: "1700000100.0", user: "UANA", text: "first" }, { ts: "1700000150.0", subtype: "channel_join", user: "UX" }] };
        case "conversations.replies": return { ok: true, messages: [{ ts: "1.0", user: "UANA", text: "root" }, { ts: "1.1", user: "UANA", text: "reply" }] };
        case "search.messages": return { ok: true, messages: { total: 1, matches: [{ ts: "1700000000.0", text: "deploy is red", username: "ana", permalink: "https://x.slack.com/p1", channel: { id: "C1", name: "eng" } }] } };
        default: return defaultAnswer(c);
      }
    };
  });
  afterEach(() => { globalThis.fetch = native.fetch; });

  test("no token, no subcommand, a bad one", async () => {
    expect(await slackTool({ _: [] })).toContain("orca slack post <target>");
    await expect(slackTool({ _: ["read", "C1"] }, { env: {} })).rejects.toThrow("SLACK_TOKEN is not set");
    await expect(run(["nope"])).rejects.toThrow('unknown subcommand "nope"');
  });

  test("conversations: channels, private channels, DMs by name and group DMs", async () => {
    const out = await run(["conversations"]);
    expect(out.split("\n")).toEqual(["C1 · public · #eng", "G2 · private · #secret", "D3 · DM · @Saajan", "G4 · group DM · mpdm-ana--finn-1"]);
    expect(calls[0]!.body).toMatchObject({ types: "public_channel,private_channel,im,mpim", exclude_archived: "true" });
    await run(["conversations"], { types: "im,mpim" });
    expect(calls.find((c, i) => i > 0 && c.method === "users.conversations")!.body.types).toBe("im,mpim");
  });

  test("read: #name resolves, history prints oldest first without joins, --thread reads the replies", async () => {
    const out = await run(["read", "#eng"], { limit: "5" });
    expect(calls.find((c) => c.method === "conversations.history")!.body).toEqual({ channel: "C1", limit: "5" });
    const lines = out.split("\n");
    expect(lines[0]).toBe("C1 · 2 messages, oldest first");
    expect(lines[1]).toContain("Saajan (UANA) · ts 1700000100.0");
    expect(lines[2]).toBe("    first");
    expect(lines[3]).toContain("thread: 2 replies (--thread 1700000200.0)");
    expect(lines[4]).toBe("    second & last");
    const thread = await run(["read", "C1"], { thread: "C1:1.0" });
    expect(calls.find((c) => c.method === "conversations.replies")!.body).toEqual({ channel: "C1", ts: "1.0", limit: "20" });
    expect(thread).toContain("C1 thread 1.0 · 2 messages");
    await expect(run(["read", "#nope"])).rejects.toThrow("no channel #nope that you are in");
  });

  test("search: newest first with place, sender and permalink; a missing scope names it", async () => {
    const out = await run(["search", "deploy", "in:#eng"]);
    expect(calls[0]).toMatchObject({ method: "search.messages", body: { query: "deploy in:#eng", count: "20", sort: "timestamp" } });
    expect(out).toContain("1 of 1 match for \"deploy in:#eng\"");
    expect(out).toContain("#eng C1 · ana · ts 1700000000.0 · https://x.slack.com/p1");
    answer = () => ({ ok: false, error: "missing_scope", needed: "search:read" });
    await expect(run(["search", "x"])).rejects.toThrow("search.messages: missing_scope (the user token needs the scope search:read");
  });

  test("post: @name opens the DM, a group, a thread; the log line has the place, never the text", async () => {
    const out = await run(["post", "@ana", "the", "PR", "is", "merged"], { thread: "1.5" });
    expect(calls.map((c) => [c.method, c.body])).toEqual([
      ["users.list", { limit: "200" }],
      ["conversations.open", { users: "UANA" }],
      ["chat.postMessage", { channel: "DNEW", text: "the PR is merged", thread_ts: "1.5" }],
    ]);
    expect(calls.at(-1)!.auth).toBe("Bearer xoxp-test");
    expect(out).toContain("Posted to DNEW as the user in thread 1.5");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^\[slack\] .* orchestrator \(your chat\): post to DNEW thread 1\.5 → ts 9\.9$/);
    expect(log.join("")).not.toContain("merged");
    await run(["post", "@ana,UBEN", "hi"]);
    expect(calls.at(-2)!.body).toEqual({ users: "UANA,UBEN" });
    await run(["post", "C1", "hi"]);
    expect(calls.at(-1)!.body).toEqual({ channel: "C1", text: "hi" });
    await expect(run(["post", "@old", "hi"])).rejects.toThrow('no Slack user "@old"'); // a deleted user
    await expect(run(["post", "C1"])).rejects.toThrow("usage: orca slack post");
  });

  test("every orca slack verb is the user's own chat: an outside sender's wake is refused, even read", () => {
    for (const level of ["ask", "work", "admin"] as const) {
      for (const sub of ["read", "search", "conversations", "post"]) {
        expect(grantRefusal({ level, repos: ["r"], linkId: "L1" }, "slack", { _: [sub, "C1"] })).toContain('"slack" needs your own chat');
      }
    }
    expect(grantRefusal({ level: "full", repos: [] }, "slack", { _: ["post"] })).toBeUndefined();
  });
});

describe("Slack on the integrations core (Postgres)", () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  let running: ReturnType<typeof slackAdapter>;
  let abort: AbortController;
  const c = conn();

  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE };
    process.env.ORCA_INSTANCE = "local";
    process.env.SLACK_TOKEN = "xoxp-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    pg = await freshSchema("slackcore");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    router.resetPace();
    dispatcher.resetPace();
    calls = [];
    FakeSocket.all = [];
    answer = defaultAnswer;
    globalThis.fetch = fetchStub;
    socketMode.WebSocket = FakeSocket as never;
    await store.addIntegration(c);
    await store.addLink({ id: "dm", integrationId: "slack", externalId: "im", label: "DMs", level: "ask", repos: [], requireMention: false });
    await store.addLink({ id: "eng", integrationId: "slack", externalId: "C1", label: "#eng", level: "ask", repos: [], requireMention: true });
    running = slackAdapter(c);
    abort = new AbortController();
    dispatcher.configure({ adapter: (id) => (id === "slack" ? running : undefined), web: async () => ({ ok: true }) });
    dispatcher.setRunning(() => ["slack"]);
    await running.start(context(c, abort));
    FakeSocket.all[0]!.push({ type: "hello" });
  });
  afterEach(async () => {
    abort.abort();
    await running.stop();
    socketMode.WebSocket = realWs;
    globalThis.fetch = native.fetch;
    dispatcher.configure({ adapter: () => undefined });
    dispatcher.setRunning(() => []);
    await db.close();
    await pg.drop();
    delete process.env.SLACK_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test("a DM from a paired person wakes the orchestrator; the Reply goes back into that DM as you", async () => {
    await store.addPrincipal({ id: "saajan", name: "Saajan", maxLevel: "work" }, [{ adapter: "slack", externalId: "USAAJAN" }]);
    FakeSocket.all[0]!.push(envelope("E1", ev({ channel: "D1", channel_type: "im", text: "is #12 merged?" })));
    await settle();
    const e = await store.event("slack:T1:D1:1700000000.000100");
    expect(e).toMatchObject({ source: { linkId: "dm", channel: "D1" }, thread: { externalId: "D1" }, grant: { level: "ask", linkId: "dm", principalId: "saajan" } });
    expect((await store.deliveries()).filter((d) => d.envelope.key === e!.key).map((d) => d.target)).toEqual([{ kind: "orchestrator" }]);
    await router.replyToEvent(e!.id, "Yes, it merged an hour ago.");
    await dispatcher.dispatchOnce();
    const post = calls.filter((x) => x.method === "chat.postMessage");
    expect(post.map((x) => [x.auth, x.body])).toEqual([["Bearer xoxp-test", { channel: "D1", text: "Yes, it merged an hour ago." }]]);
  });

  test("a mention in a channel is answered in its thread; a later reply there needs no mention", async () => {
    await store.addPrincipal({ id: "saajan", name: "Saajan", maxLevel: "work" }, [{ adapter: "slack", externalId: "USAAJAN" }]);
    FakeSocket.all[0]!.push(envelope("E1", ev()));
    await settle();
    const e = (await store.event("slack:T1:C1:1700000000.000100"))!;
    expect(e).toMatchObject({ source: { linkId: "eng" }, text: "@finn can you look at #12?", thread: { externalId: "C1:1700000000.000100" } });
    await router.replyToEvent(e.id, "Looking now.");
    await dispatcher.dispatchOnce();
    expect(calls.filter((x) => x.method === "chat.postMessage").at(-1)!.body).toEqual({ channel: "C1", text: "Looking now.", thread_ts: "1700000000.000100" });
    FakeSocket.all[0]!.push(envelope("E2", ev({ text: "thanks!", ts: "1700000000.000200", thread_ts: "1700000000.000100" })));
    await settle();
    expect(await store.event("slack:T1:C1:1700000000.000200")).toMatchObject({ text: "thanks!" });
  });

  test("an unknown sender gets a bell row and NO automatic post in your name", async () => {
    FakeSocket.all[0]!.push(envelope("E1", ev({ channel: "D9", channel_type: "im", user: "USTRANGER", text: "hey" })));
    await settle();
    const [pairing] = await store.pendingPairings();
    expect(pairing).toMatchObject({ adapter: "slack", externalId: "USTRANGER", linkId: "dm" });
    await dispatcher.dispatchOnce();
    expect(calls.filter((x) => x.method === "chat.postMessage")).toEqual([]);
    expect((await store.event(`pairing:${pairing!.code}`))?.text).toContain("did not send them the code");
  });
});
