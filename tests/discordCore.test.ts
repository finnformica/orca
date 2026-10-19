// The Discord adapter on the REAL integrations core: Postgres (a fresh schema), the router's gate and
// pairing, the dispatcher and the orchestrator's `orca post`. Discord itself is a fake: a Gateway
// socket the test drives and a REST stub that keeps channels like Discord does — a thread opened on
// a message is a new channel with that message's id, and a post to an unknown channel is a 404.
// It runs twice: `threads: true` (a thread per request) and the default, reply in place. Reply in
// place also covers `orca post --reply --thread` (a thread for one answer) and the catch-all link.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../server/db";
import * as orchestrator from "../server/orchestrator";
import * as router from "../server/integrations/router";
import * as dispatcher from "../server/integrations/dispatcher";
import * as store from "../server/integrations/store";
import { context } from "../server/integrations/registry";
import { discordAdapter, gateway, type WebSocketLike } from "../server/integrations/adapters/discord";
import type { Connection } from "../server/integrations/adapter";
import { CATCH_ALL_SEND_ERROR, pairingReply, replyToOf } from "../shared/integrations";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO } from "../web/src/workstream";
import type { OrcaConfig } from "../server/config";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const dom = { fetch: globalThis.fetch, Response: globalThis.Response };
beforeAll(() => { Object.assign(globalThis, native); });
afterAll(() => { Object.assign(globalThis, dom); });

class FakeSocket implements WebSocketLike {
  static last?: FakeSocket;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  constructor(public url: string) { FakeSocket.last = this; }
  send() {}
  close() {}
  push(p: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(p) }); }
}

/** A small Discord: channels, the messages posted in each, and threads opened on messages. */
function fakeDiscord() {
  const channels = new Map<string, { parent?: string; posts: string[]; replyTo: (string | undefined)[] }>([["C1", { posts: [], replyTo: [] }]]);
  const calls: string[] = [];
  let next = 100;
  const fetchStub = (async (url: unknown, init?: RequestInit) => {
    const path = String(url).replace("https://discord.com/api/v10", "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    if (path === "/gateway/bot") return reply(200, { url: "wss://gw.test" });
    let m = path.match(/^\/channels\/([^/]+)\/messages\/([^/]+)\/threads$/);
    if (m && method === "POST") {
      if (channels.has(m[2]!)) return reply(400, { code: 160004, message: "A thread has already been created for this message" });
      channels.set(m[2]!, { parent: m[1]!, posts: [], replyTo: [] });
      return reply(201, { id: m[2], type: 11, parent_id: m[1], name: body.name });
    }
    m = path.match(/^\/channels\/([^/]+)\/messages$/);
    if (m && method === "POST") {
      const ch = channels.get(m[1]!);
      if (!ch) return reply(404, { code: 10003, message: "Unknown Channel" });
      ch.posts.push(body.content ?? body.embeds?.[0]?.description ?? "");
      ch.replyTo.push(body.message_reference?.message_id);
      return reply(200, { id: String(next++), channel_id: m[1] });
    }
    m = path.match(/^\/channels\/([^/]+)$/);
    if (m) {
      const ch = channels.get(m[1]!);
      return ch ? reply(200, { id: m[1], type: ch.parent ? 11 : 0, ...(ch.parent ? { parent_id: ch.parent } : {}) }) : reply(404, { code: 10003, message: "Unknown Channel" });
    }
    return reply(404, { message: "not faked" });
  }) as typeof fetch;
  return { channels, calls, fetchStub };
}

const msg = (id: string, author: string, content: string, channel = "C1", replyTo?: string) => ({
  op: 0, s: Number(id.replace(/\D/g, "")) || 1, t: "MESSAGE_CREATE",
  d: {
    id, channel_id: channel, guild_id: "G1", content, author: { id: author, username: author.toLowerCase(), global_name: "Saajan" }, mentions: [{ id: "BOT" }],
    ...(replyTo ? { message_reference: { type: 0, message_id: replyTo, channel_id: channel } } : {}),
  },
});
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)); };

for (const threads of [true, false]) describe(`Discord on the integrations core (Postgres), threads ${threads ? "on" : "off"}`, () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  let discord: ReturnType<typeof fakeDiscord>;
  const realWs = gateway.WebSocket;
  const conn: Connection = { id: "discord", kind: "discord", name: "Discord", instance: "local", config: threads ? { threads: true } : {}, secretRef: "ORCA_SECRET_DISCORD_TEST", enabled: true };
  const adapter = () => discordAdapter(conn);
  let running: ReturnType<typeof discordAdapter> | undefined;
  let abort: AbortController;

  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE };
    process.env.ORCA_INSTANCE = "local";
    process.env.ORCA_SECRET_DISCORD_TEST = "tok";
    pg = await freshSchema("discordcore");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    router.resetPace();
    dispatcher.resetPace();
    discord = fakeDiscord();
    globalThis.fetch = discord.fetchStub;
    gateway.WebSocket = FakeSocket as never;
    await store.addIntegration(conn);
    await store.addLink({ id: "L1", integrationId: "discord", externalId: "C1", label: "#site-templates", level: "work", repos: ["r"], requireMention: true });
    // The real adapter is both the inbound socket and the dispatcher's sink.
    running = adapter();
    abort = new AbortController();
    dispatcher.configure({ adapter: (id) => (id === "discord" ? running : undefined), web: async () => ({ ok: true }) });
    dispatcher.setRunning(() => ["discord"]);
    await running.start(context(conn, abort));
    FakeSocket.last!.push({ op: 10, d: { heartbeat_interval: 60_000 } });
    FakeSocket.last!.push({ op: 0, s: 1, t: "READY", d: { session_id: "S", resume_gateway_url: "wss://r.test", user: { id: "BOT", username: "orca" } } });
  });
  afterEach(async () => {
    abort.abort();
    await running?.stop();
    gateway.WebSocket = realWs;
    globalThis.fetch = native.fetch;
    dispatcher.configure({ adapter: () => undefined });
    dispatcher.setRunning(() => []);
    await db.close();
    await pg.drop();
    delete process.env.ORCA_SECRET_DISCORD_TEST;
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const onTest = threads ? test : test.skip;
  const offTest = threads ? test.skip : test;

  onTest("an unknown sender's mention gets the pairing code in the thread of that message", async () => {
    FakeSocket.last!.push(msg("M10", "U-new", "<@BOT> can you fix the footer?"));
    await settle();
    const [pairing] = await store.pendingPairings();
    expect(pairing).toMatchObject({ adapter: "discord", externalId: "U-new", linkId: "L1" });
    // The gate rejected the message, so ingest opened no thread; the reply's send opens it.
    expect(discord.channels.has("M10")).toBe(false);
    await dispatcher.dispatchOnce();
    expect(discord.channels.get("M10")).toMatchObject({ parent: "C1", posts: [pairingReply(pairing!.code)] });
    expect(discord.channels.get("C1")!.posts).toEqual([]); // nothing in the channel itself
  });

  onTest("a paired person's mention opens its thread, and orca post with that thread id lands in it", async () => {
    await store.addPrincipal({ id: "saajan", name: "Saajan", maxLevel: "work" }, [{ adapter: "discord", externalId: "U-saajan" }]);
    FakeSocket.last!.push(msg("M20", "U-saajan", "<@BOT> what is on the board?"));
    await settle();
    const e = await store.event("discord:M20");
    expect(e).toMatchObject({ thread: { adapter: "discord", externalId: "M20" }, source: { linkId: "L1" }, text: "what is on the board?" });
    expect(discord.channels.get("M20")).toMatchObject({ parent: "C1" }); // opened at ingest
    const cfg = { repos: [{ name: "r", repoPath: "/nope", worktreeRoot: "/nope", baseBranch: "main", previewServices: [] }] } as unknown as OrcaConfig;
    expect(await orchestrator.tool(cfg, "post", { link: "L1", thread: e!.thread!.externalId, _: ["Two", "PRs", "are", "open."] })).toContain("(thread M20)");
    await dispatcher.dispatchOnce();
    expect(discord.channels.get("M20")!.posts).toEqual(["Two PRs are open."]);
    expect(discord.channels.get("C1")!.posts).toEqual([]);
  });

  onTest("orca post into a thread whose open failed at ingest opens it, then posts", async () => {
    const cfg = { repos: [] } as unknown as OrcaConfig;
    await orchestrator.tool(cfg, "post", { link: "L1", thread: "M30", _: ["Late", "answer."] });
    await dispatcher.dispatchOnce();
    expect(discord.channels.get("M30")).toMatchObject({ parent: "C1", posts: ["Late answer."] });
    expect(discord.calls.filter((c) => c.startsWith("POST")).slice(-3)).toEqual([
      "POST /channels/M30/messages", "POST /channels/C1/messages/M30/threads", "POST /channels/M30/messages",
    ]);
  });

  offTest("an unknown sender's mention gets the pairing code as a reply to that message, in the channel", async () => {
    FakeSocket.last!.push(msg("M10", "U-new", "<@BOT> can you fix the footer?"));
    await settle();
    const [pairing] = await store.pendingPairings();
    await dispatcher.dispatchOnce();
    expect(discord.channels.get("C1")).toMatchObject({ posts: [pairingReply(pairing!.code)], replyTo: ["M10"] });
    expect(discord.channels.has("M10")).toBe(false);
    expect(discord.calls.some((c) => c.endsWith("/threads"))).toBe(false);
  });

  offTest("a paired person's mention is answered in place by orca post --reply's thread key", async () => {
    await store.addPrincipal({ id: "saajan", name: "Saajan", maxLevel: "work" }, [{ adapter: "discord", externalId: "U-saajan" }]);
    FakeSocket.last!.push(msg("M20", "U-saajan", "<@BOT> what is on the board?"));
    await settle();
    const e = await store.event("discord:M20");
    expect(e).toMatchObject({ thread: { adapter: "discord", externalId: "C1:M20" }, source: { linkId: "L1" } });
    const cfg = { repos: [] } as unknown as OrcaConfig;
    expect(await orchestrator.tool(cfg, "post", { link: "L1", thread: e!.thread!.externalId, _: ["Two", "PRs", "are", "open."] })).toContain("(thread C1:M20)");
    await dispatcher.dispatchOnce();
    expect(discord.channels.get("C1")).toMatchObject({ posts: ["Two PRs are open."], replyTo: ["M20"] });
    expect([...discord.channels.keys()]).toEqual(["C1"]);
  });

  offTest("a workstream's first post starts its reply chain; a reply to it reaches the workstream", async () => {
    const toWorkstream: string[] = [];
    dispatcher.configure({ adapter: (id) => (id === "discord" ? running : undefined), web: async () => ({ ok: true }), workstream: async (repo, branch, e) => { toWorkstream.push(`${repo}/${branch}: ${e.text}`); return { ok: true }; } });
    await store.addPrincipal({ id: "saajan", name: "Saajan", maxLevel: "work" }, [{ adapter: "discord", externalId: "U-saajan" }]);
    await store.addSubscription({ topicPattern: "orca.pr.*", filter: {}, targetKind: "link", targetId: "L1" });
    await router.publish({ key: "pr:r#7", topic: "orca.pr.opened", at: 1, source: { adapter: "orca" }, scope: { repo: "r", branch: "b" }, title: "Fix footer", text: "Opened PR #7" });
    await dispatcher.dispatchOnce();
    const post = String(100); // the fake's first message id
    expect(await store.threadLink("discord", `C1:${post}`)).toMatchObject({ repo: "r", branch: "b", linkId: "L1" });
    // The next post about the workstream replies to the first one.
    await router.publish({ key: "pr:r#7:ci", topic: "orca.pr.ci_failed", at: 2, source: { adapter: "orca" }, scope: { repo: "r", branch: "b" }, title: "Fix footer", text: "CI is red" });
    await dispatcher.dispatchOnce();
    expect(discord.channels.get("C1")!.replyTo).toEqual([undefined, post]);
    // A person's reply to the post is in the same chain, so it reaches the workstream.
    FakeSocket.last!.push(msg("M40", "U-saajan", "<@BOT> please also fix the header", "C1", post));
    await settle();
    expect(await store.event("discord:M40")).toMatchObject({ thread: { externalId: `C1:${post}` } });
    await dispatcher.dispatchOnce();
    expect(toWorkstream).toEqual(["r/b: please also fix the header"]);
    expect(discord.calls.some((c) => c.endsWith("/threads"))).toBe(false);
  });

  offTest("orca post --reply --thread opens a thread on the mention, answers in it and moves the workstream there", async () => {
    const toWorkstream: string[] = [];
    dispatcher.configure({ adapter: (id) => (id === "discord" ? running : undefined), web: async () => ({ ok: true }), workstream: async (repo, branch, e) => { toWorkstream.push(`${repo}/${branch}: ${e.text}`); return { ok: true }; } });
    await store.addPrincipal({ id: "saajan", name: "Saajan", maxLevel: "work" }, [{ adapter: "discord", externalId: "U-saajan" }]);
    FakeSocket.last!.push(msg("M20", "U-saajan", "<@BOT> fix the footer on r"));
    await settle();
    const e = await store.event("discord:M20");
    const replyTo = replyToOf(e!)!;
    expect(replyTo).toMatchObject({ linkId: "L1", threadId: "C1:M20", messageId: "M20" });
    await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakeGrant: { level: "work", repos: ["r"], linkId: "L1" } as never, wakeReplyTo: replyTo as never });
    const cfg = { repos: [] } as unknown as OrcaConfig;
    // bin/orca gives `--reply --thread "<text>"` the text as --thread's value.
    expect(await orchestrator.tool(cfg, "post", { reply: "", thread: "Started a workstream for it.", repo: "r", branch: "b" })).toContain("in a new thread");
    await dispatcher.dispatchOnce();
    expect(discord.channels.get("M20")).toMatchObject({ parent: "C1", posts: ["Started a workstream for it."] });
    expect(discord.channels.get("C1")!.posts).toEqual([]); // nothing in place
    // The thread is the workstream's conversation on the link now: a message in it reaches the workstream.
    expect(await store.threadLink("discord", "M20")).toMatchObject({ repo: "r", branch: "b", linkId: "L1" });
    expect((await store.threadsForWorkstream("r", "b")).get("L1")).toBe("M20");
    FakeSocket.last!.push(msg("M41", "U-saajan", "<@BOT> also the header", "M20"));
    await settle();
    await dispatcher.dispatchOnce();
    expect(toWorkstream).toEqual(["r/b: also the header"]);
    // Without --thread the next answer stays in place.
    FakeSocket.last!.push(msg("M50", "U-saajan", "<@BOT> what is on the board?"));
    await settle();
    await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakeReplyTo: replyToOf((await store.event("discord:M50"))!) as never });
    await orchestrator.tool(cfg, "post", { reply: "Two PRs." });
    await dispatcher.dispatchOnce(Date.now() + 6_000);
    expect(discord.channels.get("C1")).toMatchObject({ posts: ["Two PRs."], replyTo: ["M50"] });
    expect(discord.channels.has("M50")).toBe(false);
  });

  offTest("nothing posts to a catch-all link: orca post and a subscription refuse it, an old row never reaches Discord", async () => {
    await store.addLink({ id: "Lstar", integrationId: "discord", externalId: "*", label: "All channels and DMs", level: "ask", repos: [], requireMention: true });
    const cfg = { repos: [] } as unknown as OrcaConfig;
    await expect(orchestrator.tool(cfg, "post", { link: "Lstar", _: ["hi"] })).rejects.toThrow(CATCH_ALL_SEND_ERROR);
    // A subscription to it (made before the form refused one) plans no delivery.
    await store.addSubscription({ topicPattern: "orca.pr.*", filter: {}, targetKind: "link", targetId: "Lstar" });
    expect((await router.publish({ key: "pr:r#8", topic: "orca.pr.opened", at: 1, source: { adapter: "orca" }, text: "Opened PR #8" })).deliveries).toEqual([]);
    // A row planned before the refusal: the dispatcher ends it with a clear error, with no Discord call.
    const before = discord.calls.length;
    const r = await store.recordEvent({ id: router.newEventId(), key: "old", topic: "orca.message", at: 1, source: { adapter: "orca" }, text: "x" },
      [{ subscriptionId: null, target: { kind: "link", integrationId: "discord", adapter: "discord", linkId: "Lstar", externalId: "*" } }], Date.now());
    await dispatcher.dispatchOnce();
    expect(discord.calls.length).toBe(before);
    expect(await store.deliveries({ state: "dead" })).toEqual([expect.objectContaining({ id: r.deliveries[0], lastError: CATCH_ALL_SEND_ERROR, attempts: 1 })]);
  });
});
