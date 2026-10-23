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
import { parseCursor, pickConversations, placeLabel, postAsUser, pruneThreads, searchEvent, slackAdapter, slackInbound, slackPermalink, socketMode, threadTs, tsOf, type WebSocketLike } from "../server/integrations/adapters/slack";
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
  const a = answer(c);
  // `__status` / `__retryAfter` fake an HTTP error: a 429 with Slack's Retry-After header.
  if (a.__status) return new Response(JSON.stringify({ ok: false, error: a.error }), { status: Number(a.__status), headers: { "retry-after": String(a.__retryAfter ?? "") } });
  return Response.json(a);
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

  test("the place a person reads and a link to the message: DM, Group DM or #channel; the permalink names a reply's thread", () => {
    const at = { ...me, url: "https://acme.slack.com/" };
    expect(slackInbound(ev({ channel: "D1", channel_type: "im" }), at)).toMatchObject({ display: { place: "DM" }, link: { url: "https://acme.slack.com/archives/D1/p1700000000000100" } });
    expect(slackInbound(ev({ channel: "G7", channel_type: "mpim" }), at)!.display).toEqual({ place: "Group DM" });
    expect(slackInbound(ev(), at, { channelName: "eng" })!.display).toEqual({ place: "#eng" });
    // A channel with no known name, and no workspace URL: neither field, never a guess.
    const bare = slackInbound(ev(), me)!;
    expect(bare.display).toBeUndefined();
    expect(bare.link).toBeUndefined();
    expect(slackPermalink("https://acme.slack.com", { channel: "C1", ts: "2.5", thread_ts: "1.1" })).toBe("https://acme.slack.com/archives/C1/p25?thread_ts=1.1&cid=C1");
    expect(slackPermalink("https://acme.slack.com", { channel: "C1", ts: "1.1", thread_ts: "1.1" })).toBe("https://acme.slack.com/archives/C1/p11");
    expect(placeLabel("channel")).toBeUndefined();
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

  test("config inbound: off — no socket, no poll, no error; posts still work", async () => {
    const a = slackAdapter(conn({ inbound: "off" }));
    await a.start(fakeCtx().ctx);
    expect(FakeSocket.all).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(await a.health()).toEqual({ ok: true, detail: "signed in as finn; inbound off" });
    expect(await a.send({ externalId: "C1" }, { text: "hi" }, "1")).toMatchObject({ ok: true });
  });

  test("no SLACK_APP_TOKEN: inbound polls with SLACK_TOKEN alone, no socket; inbound: poll forces it", async () => {
    delete process.env.SLACK_APP_TOKEN;
    const a = slackAdapter(conn());
    await a.start(fakeCtx().ctx);
    await a.poll();
    expect(FakeSocket.all).toHaveLength(0);
    expect(calls.some((c) => c.method === "apps.connections.open")).toBe(false);
    expect(calls.every((c) => c.auth === "Bearer xoxp-test")).toBe(true);
    expect(calls.map((c) => c.method)).toContain("search.messages");
    await a.stop();
    process.env.SLACK_APP_TOKEN = "xapp-test";
    const forced = slackAdapter(conn({ inbound: "poll" }));
    await forced.start(fakeCtx().ctx);
    await forced.poll();
    expect(FakeSocket.all).toHaveLength(0);
    await forced.stop();
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

describe("the poller: inbound with SLACK_TOKEN alone", () => {
  const base = Math.floor(Date.now() / 1000);
  const at = (s: number, n = 0) => `${base + s}.${String(n).padStart(6, "0")}`;
  /** A small Slack: DMs, group DMs, search matches and thread replies, answered like the Web API. */
  let slack: {
    dms: { id: string; is_mpim?: boolean }[];
    history: Record<string, Record<string, unknown>[]>;
    matches: Record<string, unknown>[];
    replies: Record<string, Record<string, unknown>[]>;
    limit?: string; // a method that answers 429 once
  };
  const slackAnswer = (c: Call): Record<string, unknown> => {
    if (slack.limit === c.method) { slack.limit = undefined; return { __status: 429, __retryAfter: 30, error: "ratelimited" }; }
    const after = (ms: Record<string, unknown>[], oldest: unknown) => ms.filter((m) => Number(m.ts) > Number(oldest ?? 0));
    switch (c.method) {
      case "conversations.list": return { ok: true, channels: slack.dms, response_metadata: { next_cursor: "" } };
      case "conversations.history": return { ok: true, has_more: false, messages: after(slack.history[String(c.body.channel)] ?? [], c.body.oldest).sort((a, b) => Number(b.ts) - Number(a.ts)) };
      case "search.messages": return { ok: true, messages: { matches: [...slack.matches].sort((a, b) => Number(b.ts) - Number(a.ts)), paging: { pages: 1 } } };
      case "conversations.replies": {
        const all = slack.replies[`${c.body.channel}:${c.body.ts}`] ?? [];
        return { ok: true, messages: [{ ts: c.body.ts, user: "USAAJAN", text: "parent" }, ...after(all, c.body.oldest)] };
      }
      default: return defaultAnswer(c);
    }
  };
  /** A context like the core's: the cursor kept in `store`, ingest deduped by key. */
  function pollCtx(store: { cursor?: string }) {
    const f = fakeCtx();
    const keys = new Set<string>();
    f.ctx.cursor = { get: async () => store.cursor, set: async (v) => { store.cursor = v; } };
    f.ctx.ingest = async (e) => { if (keys.has(e.key)) return "duplicate"; keys.add(e.key); f.ingested.push(e); return "new"; };
    return f;
  }

  beforeEach(() => {
    calls = [];
    FakeSocket.all = [];
    slack = { dms: [{ id: "D1" }, { id: "G7", is_mpim: true }], history: {}, matches: [], replies: {} };
    answer = slackAnswer;
    process.env.SLACK_TOKEN = "xoxp-test";
    delete process.env.SLACK_APP_TOKEN;
    globalThis.fetch = fetchStub;
  });
  afterEach(() => {
    globalThis.fetch = native.fetch;
    delete process.env.SLACK_TOKEN;
  });

  test("a first start reads no history: the cursor starts now, older DMs and mentions stay out", async () => {
    slack.history.D1 = [{ ts: at(-100), user: "USAAJAN", text: "old DM" }];
    slack.matches = [{ ts: at(-100), user: "USAAJAN", text: "<@UFINN> old", channel: { id: "C1" } }];
    const store: { cursor?: string } = {};
    const f = pollCtx(store);
    const a = slackAdapter(conn());
    await a.start(f.ctx);
    await a.poll();
    expect(f.ingested).toEqual([]);
    const cur = JSON.parse(store.cursor!);
    expect(Number(cur.start)).toBeGreaterThanOrEqual(base);
    expect(calls.find((c) => c.method === "conversations.history")!.body.oldest).toBe(cur.start);
    expect(calls.find((c) => c.method === "search.messages")!.body).toMatchObject({ query: "<@UFINN>", sort: "timestamp", sort_dir: "desc" });
    await a.stop();
  });

  test("DMs and group DMs: other people's messages in, your own out, each read once", async () => {
    const store: { cursor?: string } = {};
    const f = pollCtx(store);
    const a = slackAdapter(conn());
    await a.start(f.ctx);
    slack.history.D1 = [{ ts: at(10), user: "USAAJAN", text: "is #12 merged?" }, { ts: at(11), user: "UFINN", text: "checking" }];
    slack.history.G7 = [{ ts: at(12), user: "UANA", text: "standup at 10" }];
    await a.poll();
    expect(f.ingested.map((e) => [e.source.channel, e.source.parents, e.text, e.actor?.external.name])).toEqual([
      ["D1", ["im"], "is #12 merged?", "Saajan"],
      ["G7", ["mpim"], "standup at 10", "Saajan"],
    ]);
    expect(JSON.parse(store.cursor!).dms).toEqual({ D1: at(11), G7: at(12) }); // past your own message too
    const before = calls.length;
    await a.poll();
    expect(f.ingested).toHaveLength(2);
    expect(calls.slice(before).find((c) => c.method === "conversations.history" && c.body.channel === "D1")!.body.oldest).toBe(at(11));
    await a.stop();
  });

  test("a mention in a channel comes by search; a reply in its thread then comes with no mention", async () => {
    const store: { cursor?: string } = {};
    const f = pollCtx(store);
    const a = slackAdapter(conn());
    await a.start(f.ctx);
    slack.matches = [
      { ts: at(20), user: "USAAJAN", text: "<@UFINN> can you look at #12?", channel: { id: "C1" }, permalink: "https://x.slack.com/archives/C1/p1" },
      { ts: at(21), user: "USAAJAN", text: "<@UFINN> in a thread", channel: { id: "C2", is_private: true }, permalink: `https://x.slack.com/archives/C2/p2?thread_ts=${at(5)}&cid=C2` },
      { ts: at(22), user: "USAAJAN", text: "<@UFINN> in a DM", channel: { id: "D1", is_im: true } }, // the DM poll's job
    ];
    await a.poll();
    expect(f.ingested.map((e) => [e.text, e.thread?.externalId])).toEqual([
      ["@finn can you look at #12?", `C1:${at(20)}`],
      ["@finn in a thread", `C2:${at(5)}`],
    ]);
    expect(JSON.parse(store.cursor!).threads).toMatchObject({ [`C1:${at(20)}`]: at(20) });
    slack.replies[`C1:${at(20)}`] = [{ ts: at(30), user: "USAAJAN", text: "and the tests?" }, { ts: at(31), user: "UFINN", text: "mine" }];
    await a.poll();
    expect(f.ingested.at(-1)).toMatchObject({ text: "and the tests?", thread: { externalId: `C1:${at(20)}` } });
    expect(f.ingested).toHaveLength(3);
    expect(JSON.parse(store.cursor!).threads[`C1:${at(20)}`]).toBe(at(31));
    await a.stop();
  });

  test("a post in a thread: the replies there are polled, and the thread is in the cursor at once", async () => {
    const store: { cursor?: string } = {};
    const f = pollCtx(store);
    const a = slackAdapter(conn());
    await a.start(f.ctx);
    answer = (c) => (c.method === "chat.postMessage" ? { ok: true, channel: "C1", ts: at(40) } : slackAnswer(c));
    expect(await a.send({ externalId: "C1" }, { text: "I will look" }, "1")).toMatchObject({ threadId: `C1:${at(40)}` });
    expect(JSON.parse(store.cursor!).threads[`C1:${at(40)}`]).toBe(at(40));
    slack.replies[`C1:${at(40)}`] = [{ ts: at(41), user: "USAAJAN", text: "thanks" }];
    await a.poll();
    expect(f.ingested.map((e) => e.text)).toEqual(["thanks"]);
    await a.stop();
  });

  test("a restart replays nothing and misses nothing", async () => {
    const store: { cursor?: string } = {};
    const first = slackAdapter(conn());
    const f1 = pollCtx(store);
    await first.start(f1.ctx);
    slack.history.D1 = [{ ts: at(10), user: "USAAJAN", text: "one" }];
    slack.matches = [{ ts: at(11), user: "USAAJAN", text: "<@UFINN> two", channel: { id: "C1" } }];
    await first.poll();
    expect(f1.ingested).toHaveLength(2);
    await first.stop();
    // While it is down: one more DM and one more mention.
    slack.history.D1.push({ ts: at(50), user: "USAAJAN", text: "three" });
    slack.matches.push({ ts: at(51), user: "USAAJAN", text: "<@UFINN> four", channel: { id: "C1" } });
    const second = slackAdapter(conn());
    const f2 = pollCtx(store); // a new process: an empty dedupe set, the stored cursor
    await second.start(f2.ctx);
    await second.poll();
    // The mention search reads back 5 minutes (search indexes late), so "two" comes again: the core's key dedupes it.
    expect(f2.ingested.map((e) => e.text).filter((t) => t !== "@finn two")).toEqual(["three", "@finn four"]);
    expect(f2.ingested.filter((e) => e.text === "one")).toEqual([]);
    expect(f2.ingested.map((e) => e.key)).toContain(f1.ingested[1]!.key); // same key as before: the core says duplicate
    await second.stop();
  });

  test("a 429 ends the poll at once with Slack's Retry-After; the cursor stays, and the next poll reads it", async () => {
    const store: { cursor?: string } = {};
    const f = pollCtx(store);
    const a = slackAdapter(conn());
    await a.start(f.ctx);
    await a.poll(); // the first poll, which start began, is done
    slack.history.D1 = [{ ts: at(10), user: "USAAJAN", text: "hello" }];
    slack.limit = "conversations.history";
    const before = calls.length;
    const r = await a.poll();
    expect(r.retryAfterMs).toBe(30_000);
    expect(calls.slice(before).map((c) => c.method)).toEqual(["conversations.history"]); // the list is cached; nothing after the 429
    expect(f.ingested).toEqual([]);
    expect(JSON.parse(store.cursor!).dms.D1).toBeUndefined();
    await a.poll();
    expect(f.ingested.map((e) => e.text)).toEqual(["hello"]);
    await a.stop();
  });

  test("pickConversations: every hot DM, then the quiet ones in turns, within the budget", () => {
    const now = Date.now();
    const recent = tsOf(now - 60_000), old = tsOf(now - 3 * 86_400_000);
    const dms = { H1: recent, H2: recent, Q1: old };
    const ids = ["H1", "Q1", "Q2", "H2", "Q3"];
    const first = pickConversations(ids, dms, now, 3, 0);
    expect(first.pick.slice(0, 2).sort()).toEqual(["H1", "H2"]);
    expect(first.pick[2]).toBe("Q1");
    const second = pickConversations(ids, dms, now, 3, first.next);
    expect(second.pick[2]).toBe("Q2");
    const third = pickConversations(ids, dms, now, 3, second.next);
    expect(third.pick[2]).toBe("Q3");
    expect(pickConversations(ids, dms, now, 1, 0).pick).toHaveLength(1);
  });

  test("parseCursor, pruneThreads and searchEvent", () => {
    const now = Date.now();
    expect(parseCursor("not json", now)).toMatchObject({ v: 1, start: tsOf(now), dms: {}, threads: {} });
    expect(pruneThreads({ "C1:1.0": tsOf(now - 8 * 86_400_000), "C1:2.0": tsOf(now) }, now)).toEqual({ "C1:2.0": tsOf(now) });
    expect(searchEvent({ ts: "5.0", user: "U1", text: "x", channel: { id: "C9", is_mpim: true } })).toBeUndefined();
    expect(searchEvent({ ts: "5.0", user: "U1", text: "x", channel: { id: "C9" }, permalink: "https://x/p?thread_ts=4.0" })).toMatchObject({ channel: "C9", thread_ts: "4.0" });
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

  test("polling (SLACK_TOKEN alone): a DM reaches the core, the cursor is in integration_cursor, a restart replays nothing", async () => {
    await store.addPrincipal({ id: "saajan", name: "Saajan", maxLevel: "work" }, [{ adapter: "slack", externalId: "USAAJAN" }]);
    const msgs: Record<string, unknown>[] = [];
    answer = (x) => x.method === "conversations.list" ? { ok: true, channels: [{ id: "D1" }] }
      : x.method === "conversations.history" ? { ok: true, messages: msgs.filter((m) => Number(m.ts) > Number(x.body.oldest)).reverse() }
      : x.method === "search.messages" ? { ok: true, messages: { matches: [], paging: { pages: 1 } } }
      : defaultAnswer(x);
    const pollConn = conn({ inbound: "poll" });
    const run = async () => {
      const a = slackAdapter(pollConn);
      const stop = new AbortController();
      await a.start(context(pollConn, stop));
      await a.poll();
      stop.abort();
      await a.stop();
    };
    await store.setCursor("slack", ""); // the socket's start wrote one; begin as a first start would
    await run();
    const start = JSON.parse((await store.cursor("slack"))!).start as string;
    msgs.push({ ts: `${Number(start) + 5}.000100`, user: "USAAJAN", text: "is #12 merged?" });
    await run();
    const key = `slack:T1:D1:${Number(start) + 5}.000100`;
    expect(await store.event(key)).toMatchObject({ source: { linkId: "dm", channel: "D1" }, grant: { level: "ask", principalId: "saajan" } });
    expect(JSON.parse((await store.cursor("slack"))!).dms.D1).toBe(`${Number(start) + 5}.000100`);
    const deliveries = (await store.deliveries()).length;
    await run(); // a restart: the stored cursor, nothing again
    expect((await store.deliveries()).length).toBe(deliveries);
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
