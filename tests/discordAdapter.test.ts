// The Discord adapter against a fake Gateway socket and a stubbed REST API — never a real Discord.
// It covers what the adapter owns: the Gateway handshake (identify, heartbeat, resume), turning a
// MESSAGE_CREATE into the core's envelope (mention, thread, DM link), reply in place (the default)
// and the thread a request opens (`threads: true`), a mention of the bot's managed role, and outbound
// posts, threads (also one reply's `thread` flag), edits and the retry split. The gate itself is the core's (tests/integrations.test.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { botRoleOf, discordAdapter, gateway, INTENTS, parseChain, render, toEnvelope, type WebSocketLike } from "../server/integrations/adapters/discord";
import type { AdapterContext, Connection, InboundEnvelope } from "../server/integrations/adapter";

class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  sent: { op: number; d: any }[] = [];
  closed?: number;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code = 1000) { this.closed = code; }
  /** The server side: push a payload, or drop the connection. */
  push(p: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(p) }); }
  drop(code: number) { this.onclose?.({ code }); }
}

type Call = { method: string; path: string; body?: any };
let calls: Call[] = [];
let answer: (c: Call) => { status: number; body: unknown; headers?: Record<string, string> } = () => ({ status: 200, body: {} });
const realFetch = globalThis.fetch;
const realWs = gateway.WebSocket;
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  calls = [];
  FakeSocket.all = [];
  process.env.ORCA_SECRET_DISCORD_TEST = "tok";
  gateway.WebSocket = FakeSocket as never;
  gateway.baseBackoffMs = 5;
  globalThis.fetch = (async (url: any, init: any) => {
    const c: Call = { method: init?.method ?? "GET", path: String(url).replace("https://discord.com/api/v10", ""), body: init?.body ? JSON.parse(init.body) : undefined };
    expect(init?.headers?.authorization).toBe("Bot tok");
    calls.push(c);
    const a = answer(c);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: a.headers });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  gateway.WebSocket = realWs;
  gateway.baseBackoffMs = 1_000;
  delete process.env.ORCA_SECRET_DISCORD_TEST;
});

const conn = (config: Record<string, unknown> = {}): Connection =>
  ({ id: "dc", kind: "discord", name: "Personal Discord", instance: "orca-personal-box", config, secretRef: "ORCA_SECRET_DISCORD_TEST", enabled: true });

function fakeCtx(verdict: "new" | "duplicate" | "rejected" = "new") {
  const ingested: InboundEnvelope[] = [];
  const statuses: { ok: boolean; detail?: string }[] = [];
  const abort = new AbortController();
  const ctx: AdapterContext = {
    connection: conn(), secret: () => "tok", signal: abort.signal, log: () => {},
    ingest: async (e) => { ingested.push(e); return verdict; },
    cursor: { get: async () => undefined, set: async () => {} },
    status: async (s) => { statuses.push(s); },
  };
  return { ctx, ingested, statuses, abort };
}

/** Start an adapter and walk the socket through Hello and READY. */
async function connected(config: Record<string, unknown> = {}, verdict: "new" | "duplicate" | "rejected" = "new") {
  answer = (c) => c.path === "/gateway/bot" ? { status: 200, body: { url: "wss://gw.test" } }
    : c.path.startsWith("/channels/C1") && c.method === "GET" ? { status: 200, body: { id: "C1", type: 0 } }
    : c.path === "/channels/T9" ? { status: 200, body: { id: "T9", type: 11, parent_id: "C1" } }
    : { status: 200, body: { id: "M-new" } };
  const a = discordAdapter(conn(config));
  const f = fakeCtx(verdict);
  await a.start(f.ctx);
  const ws = FakeSocket.all[0]!;
  ws.push({ op: 10, d: { heartbeat_interval: 60_000 } });
  ws.push({ op: 0, s: 1, t: "READY", d: { session_id: "S1", resume_gateway_url: "wss://resume.test", user: { id: "BOT", username: "orca" } } });
  return { a, ws, ...f };
}

const msg = (over: Record<string, unknown> = {}) => ({
  id: "M1", channel_id: "C1", guild_id: "G1", content: "<@BOT> what is on the board?", timestamp: "2026-10-17T10:00:00Z",
  author: { id: "U-saajan", username: "saajan", global_name: "Saajan" }, mentions: [{ id: "BOT" }], ...over,
});

describe("Discord Gateway", () => {
  test("identifies with the four intents and the token, on the URL /gateway/bot gives", async () => {
    const { a, ws, statuses } = await connected();
    expect(ws.url).toBe("wss://gw.test/?v=10&encoding=json");
    const id = ws.sent.find((p) => p.op === 2)!;
    expect(id.d.token).toBe("tok");
    expect(id.d.intents).toBe(INTENTS);
    expect(INTENTS & (1 << 15)).toBeTruthy(); // MESSAGE_CONTENT
    expect(statuses.at(-1)).toMatchObject({ ok: true, detail: "connected as orca" });
    await a.stop();
  });

  test("a bad token fails the start; a missing one too", async () => {
    answer = () => ({ status: 401, body: { message: "401: Unauthorized" } });
    await expect(discordAdapter(conn()).start(fakeCtx().ctx)).rejects.toThrow(/refused the bot token/);
    delete process.env.ORCA_SECRET_DISCORD_TEST;
    await expect(discordAdapter(conn()).start(fakeCtx().ctx)).rejects.toThrow(/ORCA_SECRET_DISCORD_TEST is not set/);
  });

  test("a dropped socket reconnects and resumes the session; a fatal close does not reconnect", async () => {
    const { a, ws, statuses } = await connected();
    ws.drop(1006);
    expect(statuses.at(-1)).toMatchObject({ ok: false });
    await new Promise((r) => setTimeout(r, 30));
    const next = FakeSocket.all[1]!;
    expect(next.url).toBe("wss://resume.test/?v=10&encoding=json");
    next.push({ op: 10, d: { heartbeat_interval: 60_000 } });
    expect(next.sent[0]).toEqual({ op: 6, d: { token: "tok", session_id: "S1", seq: 1 } });
    next.drop(4014); // disallowed intent: Message Content is off in the portal
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeSocket.all.length).toBe(2);
    expect(statuses.at(-1)?.detail).toMatch(/4014.*Message Content/);
    await a.stop();
  });
});

describe("Discord inbound", () => {
  test("threads on: a mention in a linked channel becomes an envelope, and its thread opens on the message", async () => {
    const { a, ws, ingested } = await connected({ threads: true });
    ws.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: msg() });
    await tick();
    expect(ingested).toHaveLength(1);
    const e = ingested[0]!;
    expect(e).toMatchObject({
      key: "discord:M1", topic: "ext.discord.message", text: "what is on the board?", mentioned: true,
      source: { adapter: "discord", integrationId: "dc", channel: "C1" },
      actor: { external: { adapter: "discord", id: "U-saajan", name: "Saajan" } },
      thread: { adapter: "discord", externalId: "M1" },
    });
    expect(JSON.stringify(e.raw)).not.toContain("tok");
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/channels/C1/messages/M1/threads", body: { name: "what is on the board?" } });
    await a.stop();
  });

  test("threads on: a rejected or duplicate event opens no thread", async () => {
    for (const verdict of ["rejected", "duplicate"] as const) {
      calls = [];
      const { a, ws } = await connected({ threads: true }, verdict);
      ws.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: msg() });
      await tick();
      expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      await a.stop();
      FakeSocket.all = [];
    }
  });

  test("reply in place (the default): a top-level mention is keyed by its reply chain and opens no thread", async () => {
    const { a, ws, ingested } = await connected();
    ws.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: msg() });
    await tick();
    expect(ingested[0]).toMatchObject({ source: { channel: "C1" }, thread: { adapter: "discord", externalId: "C1:M1", messageId: "M1" } });
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    // The answer is a Discord reply to the mention, in the channel.
    expect(await a.send({ externalId: "C1", threadId: "C1:M1" }, { text: "Two PRs are open." }, "d1")).toEqual({ ok: true, externalMsgId: "M-new", threadId: "C1:M1" });
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/channels/C1/messages", body: { content: "Two PRs are open.", allowed_mentions: { parse: [] }, message_reference: { message_id: "M1", fail_if_not_exists: false } } });
    await a.stop();
  });

  test("reply in place: a reply to Orca's answer joins its chain, and the next answer replies to the newest message", async () => {
    const { a, ws, ingested } = await connected();
    ws.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: msg() });
    await tick();
    await a.send({ externalId: "C1", threadId: "C1:M1" }, { text: "Which repo?" }, "d1"); // Orca's answer is M-new
    ws.push({ op: 0, s: 3, t: "MESSAGE_CREATE", d: msg({ id: "M5", content: "<@BOT> site-templates", message_reference: { type: 0, message_id: "M-new", channel_id: "C1" } }) });
    await tick();
    expect(ingested[1]).toMatchObject({ thread: { externalId: "C1:M1", messageId: "M5" } });
    await a.send({ externalId: "C1", threadId: "C1:M1" }, { text: "On it." }, "d2");
    expect(calls.at(-1)!.body.message_reference).toEqual({ message_id: "M5", fail_if_not_exists: false });
    // A second mention with no reply is a second conversation in the same channel.
    ws.push({ op: 0, s: 4, t: "MESSAGE_CREATE", d: msg({ id: "M6", content: "<@BOT> and the footer?" }) });
    await tick();
    expect(ingested[2]).toMatchObject({ thread: { externalId: "C1:M6" } });
    await a.stop();
  });

  test("reply in place: after a restart the chain's root is read up by REST", async () => {
    const { a, ws, ingested } = await connected();
    const base = answer;
    answer = (c) => c.path === "/channels/C1/messages/B1" ? { status: 200, body: { id: "B1", message_reference: { type: 0, message_id: "M1", channel_id: "C1" } } }
      : c.path === "/channels/C1/messages/M1" ? { status: 200, body: { id: "M1" } } : base(c);
    ws.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: msg({ id: "M8", message_reference: { message_id: "B2" }, referenced_message: { id: "B2", message_reference: { message_id: "B1" } } }) });
    await tick();
    expect(ingested[0]).toMatchObject({ thread: { externalId: "C1:M1", messageId: "M8" } });
    expect(calls.filter((c) => c.method === "GET" && c.path.includes("/messages/")).map((c) => c.path)).toEqual(["/channels/C1/messages/B1", "/channels/C1/messages/M1"]);
    // A reply that does not mention Orca reads nothing by REST.
    calls = [];
    ws.push({ op: 0, s: 3, t: "MESSAGE_CREATE", d: msg({ id: "M9", content: "lunch?", mentions: [], message_reference: { message_id: "X2" } }) });
    await tick();
    expect(calls.filter((c) => c.path.includes("/messages/"))).toEqual([]);
    await a.stop();
  });

  test("threads on from Settings: the text \"true\" opens a thread too", async () => {
    const { a, ws, ingested } = await connected({ threads: "true" });
    ws.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: msg() });
    await tick();
    expect(ingested[0]).toMatchObject({ thread: { externalId: "M1" } });
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/channels/C1/messages/M1/threads" });
    await a.stop();
  });

  test("a mention of the bot's managed role counts as a mention, and the role is cut from the text", async () => {
    const { a, ws, ingested } = await connected();
    // GUILD_CREATE names the role whose tags.bot_id is the bot.
    ws.push({ op: 0, s: 2, t: "GUILD_CREATE", d: { id: "G1", threads: [], roles: [{ id: "R-mod" }, { id: "R-orca", tags: { bot_id: "BOT" } }] } });
    ws.push({ op: 0, s: 3, t: "MESSAGE_CREATE", d: msg({ content: "<@&R-orca> what is on the board?", mentions: [], mention_roles: ["R-orca"] }) });
    await tick();
    expect(ingested[0]).toMatchObject({ mentioned: true, text: "what is on the board?" });
    expect(calls.some((c) => c.path.includes("/roles"))).toBe(false);
    // Another role is not a mention of Orca.
    ws.push({ op: 0, s: 4, t: "MESSAGE_CREATE", d: msg({ id: "M2", content: "<@&R-mod> lunch?", mentions: [], mention_roles: ["R-mod"] }) });
    await tick();
    expect(ingested[1]).toMatchObject({ mentioned: false, text: "<@&R-mod> lunch?" });
    await a.stop();
  });

  test("a role mention in a guild with no GUILD_CREATE reads the roles once by REST", async () => {
    const { a, ws, ingested } = await connected();
    const base = answer;
    answer = (c) => c.path === "/guilds/G1/roles" ? { status: 200, body: [{ id: "R-orca", tags: { bot_id: "BOT" } }] } : base(c);
    ws.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: msg({ content: "<@&R-orca> hi", mentions: [], mention_roles: ["R-orca"] }) });
    await tick();
    ws.push({ op: 0, s: 3, t: "MESSAGE_CREATE", d: msg({ id: "M2", content: "<@&R-orca> again", mentions: [], mention_roles: ["R-orca"] }) });
    await tick();
    expect(ingested.map((e) => [e.mentioned, e.text])).toEqual([[true, "hi"], [true, "again"]]);
    expect(calls.filter((c) => c.path === "/guilds/G1/roles")).toHaveLength(1);
    expect(botRoleOf([{ id: "R1", tags: { bot_id: "OTHER" } }], "BOT")).toBeUndefined();
    await a.stop();
  });

  test("parseChain: a chain key splits; a thread or DM channel id does not", () => {
    expect(parseChain("C1:M1")).toEqual({ channel: "C1", root: "M1" });
    expect(parseChain("T9")).toBeUndefined();
    expect(parseChain(undefined)).toBeUndefined();
  });

  test("a message in a thread is linked by its parent channel and carries the thread", async () => {
    const { a, ws, ingested } = await connected();
    ws.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: msg({ id: "M2", channel_id: "T9", content: "<@BOT> also fix the footer" }) });
    await tick();
    expect(ingested[0]).toMatchObject({ source: { channel: "C1" }, thread: { externalId: "T9" }, text: "also fix the footer" });
    expect(calls.filter((c) => c.method === "POST")).toEqual([]); // already in a thread
    await a.stop();
  });

  test("no mention is passed on as mentioned: false; a bot's message is ignored", async () => {
    const { a, ws, ingested } = await connected();
    ws.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: msg({ id: "M3", content: "lunch?", mentions: [] }) });
    ws.push({ op: 0, s: 3, t: "MESSAGE_CREATE", d: msg({ id: "M4", author: { id: "OTHER", bot: true } }) });
    await tick();
    expect(ingested.map((e) => [e.key, e.mentioned])).toEqual([["discord:M3", false]]);
    await a.stop();
  });

  test("a DM goes to the configured DM link, else to the core's catch-all link by its channel", () => {
    const dm = msg({ guild_id: undefined, channel_id: "D1", content: "hi", mentions: [] }) as never;
    expect(toEnvelope(dm, { integrationId: "dc", botId: "BOT" })!.envelope).toMatchObject({ source: { channel: "D1" }, mentioned: true, thread: { externalId: "D1" } });
    const made = toEnvelope(dm, { integrationId: "dc", botId: "BOT", dmLink: "dm-finn" })!;
    expect(made.envelope).toMatchObject({ source: { linkId: "dm-finn" }, mentioned: true, thread: { externalId: "D1" } });
    expect(made.opensThread).toBe(false);
  });
});

describe("Discord outbound", () => {
  test("threads on: a first post for a workstream opens its thread and returns the thread id", async () => {
    answer = (c) => ({ status: 200, body: { id: c.path.endsWith("/threads") ? "M-new" : "M-new" } });
    const r = await discordAdapter(conn({ threads: true })).send({ externalId: "C1" }, { text: "Opened PR #12", title: "Fix footer", url: "https://github.com/o/r/pull/12", topic: "orca.pr.opened" as never }, "d1");
    expect(r).toEqual({ ok: true, externalMsgId: "M-new", threadId: "M-new" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/channels/C1/messages" });
    expect(calls[0]!.body.embeds[0]).toMatchObject({ title: "Fix footer", url: "https://github.com/o/r/pull/12", description: "Opened PR #12" });
    expect(calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(calls[1]).toMatchObject({ method: "POST", path: "/channels/C1/messages/M-new/threads", body: { name: "Fix footer" } });
  });

  test("reply in place: a first post for a workstream starts its reply chain; the next post replies to it; an edit patches it", async () => {
    answer = () => ({ status: 200, body: { id: "M-new" } });
    const a = discordAdapter(conn());
    expect(await a.send({ externalId: "C1" }, { text: "Opened PR #12", title: "Fix footer", topic: "orca.pr.opened" as never }, "d1")).toEqual({ ok: true, externalMsgId: "M-new", threadId: "C1:M-new" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /channels/C1/messages"]); // no thread
    answer = () => ({ status: 200, body: { id: "M9" } });
    await a.send({ externalId: "C1", threadId: "C1:M-new" }, { text: "CI is red", title: "Fix footer" }, "d2");
    expect(calls[1]).toMatchObject({ path: "/channels/C1/messages", body: { message_reference: { message_id: "M-new", fail_if_not_exists: false } } });
    await a.send({ externalId: "C1", threadId: "C1:M-new", messageId: "M9" }, { text: "CI is green", edit: true }, "d3");
    expect(calls[2]).toMatchObject({ method: "PATCH", path: "/channels/C1/messages/M9" });
  });

  test("reply in place: a bare message id that is no channel gets a reply in the link's channel, not a thread", async () => {
    answer = (c) => c.path === "/channels/M30/messages" ? { status: 404, body: { message: "Unknown Channel" } } : { status: 200, body: { id: "M31" } };
    expect(await discordAdapter(conn()).send({ externalId: "C1", threadId: "M30" }, { text: "Late answer." }, "d")).toEqual({ ok: true, externalMsgId: "M31", threadId: "M30" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /channels/M30/messages", "POST /channels/C1/messages"]);
    expect(calls[1]!.body.message_reference).toEqual({ message_id: "M30", fail_if_not_exists: false });
  });

  test("thread flag: a reply in a chain opens a thread on the mention and answers in it", async () => {
    answer = (c) => ({ status: 200, body: { id: c.path.endsWith("/threads") ? "M1" : "M-new" } });
    const a = discordAdapter(conn());
    expect(await a.send({ externalId: "C1", threadId: "C1:M1" }, { text: "A long answer.", thread: true, replyToExternalMsgId: "M1" }, "d1")).toEqual({ ok: true, externalMsgId: "M-new", threadId: "M1" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /channels/C1/messages/M1/threads", "POST /channels/M1/messages"]);
    expect(calls[0]!.body).toMatchObject({ name: "A long answer." });
    // Discord refuses the thread (no permission): the answer stays in place.
    calls = [];
    answer = (c) => c.path.endsWith("/threads") ? { status: 403, body: { message: "Missing Permissions" } } : { status: 200, body: { id: "M-new" } };
    expect(await a.send({ externalId: "C1", threadId: "C1:M1" }, { text: "Short.", thread: true, replyToExternalMsgId: "M1" }, "d2")).toEqual({ ok: true, externalMsgId: "M-new", threadId: "C1:M1" });
    expect(calls[1]).toMatchObject({ path: "/channels/C1/messages", body: { message_reference: { message_id: "M1" } } });
  });

  test("thread flag: a first post opens a thread on itself; in a thread the flag changes nothing", async () => {
    answer = () => ({ status: 200, body: { id: "M-new" } });
    const a = discordAdapter(conn());
    expect(await a.send({ externalId: "C1" }, { text: "Plan for PR #12", thread: true }, "d1")).toEqual({ ok: true, externalMsgId: "M-new", threadId: "M-new" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /channels/C1/messages", "POST /channels/C1/messages/M-new/threads"]);
    calls = [];
    expect(await a.send({ externalId: "C1", threadId: "T9" }, { text: "Step 2 done.", thread: true }, "d2")).toEqual({ ok: true, externalMsgId: "M-new", threadId: "T9" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /channels/T9/messages"]);
  });

  test("a reply posts into the thread; an edit patches the message", async () => {
    answer = () => ({ status: 200, body: { id: "M7" } });
    const a = discordAdapter(conn());
    expect(await a.send({ externalId: "C1", threadId: "T9" }, { text: "Done." }, "d2")).toEqual({ ok: true, externalMsgId: "M7", threadId: "T9" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/channels/T9/messages", body: { content: "Done." } });
    await a.send({ externalId: "C1", threadId: "T9", messageId: "M7" }, { text: "Done, merged.", edit: true }, "d3");
    expect(calls[1]).toMatchObject({ method: "PATCH", path: "/channels/T9/messages/M7", body: { content: "Done, merged." } });
  });

  test("a 429 retries after Discord's retry_after; a missing channel or bad auth does not retry", async () => {
    answer = () => ({ status: 429, body: { message: "You are being rate limited.", retry_after: 1.5 } });
    expect(await discordAdapter(conn()).send({ externalId: "C1", threadId: "T9" }, { text: "x" }, "d")).toMatchObject({ ok: false, retryable: true, retryAfterMs: 1500 });
    answer = () => ({ status: 404, body: { message: "Unknown Channel" } });
    expect(await discordAdapter(conn()).send({ externalId: "C1" }, { text: "x" }, "d")).toMatchObject({ ok: false, retryable: false, error: "404 Unknown Channel" });
    answer = () => ({ status: 503, body: {} });
    expect(await discordAdapter(conn()).send({ externalId: "C1" }, { text: "x" }, "d")).toMatchObject({ ok: false, retryable: true });
    delete process.env.ORCA_SECRET_DISCORD_TEST;
    expect(await discordAdapter(conn()).send({ externalId: "C1" }, { text: "x" }, "d")).toMatchObject({ ok: false, retryable: false });
  });

  test("render: plain content for a reply, never pinging anyone", () => {
    expect(render({ text: "hi @everyone" })).toEqual({ content: "hi @everyone", allowed_mentions: { parse: [] } });
  });
});
