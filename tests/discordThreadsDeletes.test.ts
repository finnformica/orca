// `orca post --new-thread "<name>"` and `orca post --delete <message id>` on the REAL integrations
// core: Postgres (a fresh schema), the `orca` verb, the router, the stored delivery, the dispatcher
// and the Discord adapter. Discord is a fake REST stub that keeps each message with its author and
// opens a thread on a message as a channel with that message's id. The connection keeps
// `config.threads` off (the default, reply in place): a thread opens only when the post asks.
// `orca post` waits for its delivery, so each test runs the dispatcher beside the waiting verb.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../server/db";
import * as orchestrator from "../server/orchestrator";
import * as router from "../server/integrations/router";
import * as dispatcher from "../server/integrations/dispatcher";
import * as store from "../server/integrations/store";
import { discordAdapter } from "../server/integrations/adapters/discord";
import { SLACK_CAPS } from "../server/integrations/adapters/slack";
import type { Adapter, Connection } from "../server/integrations/adapter";
import { deleteRefusal } from "../shared/integrations";
import type { OrcaConfig } from "../server/config";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const dom = { fetch: globalThis.fetch, Response: globalThis.Response };
const wait = { ...orchestrator.postWait };
beforeAll(() => { Object.assign(globalThis, native); });
afterAll(() => { Object.assign(globalThis, dom); Object.assign(orchestrator.postWait, wait); });

const cfg = { repos: [] } as unknown as OrcaConfig;

/** A small Discord: messages by id (channel, author), threads opened on messages, every call. */
function fakeDiscord() {
  const messages = new Map<string, { channel: string; author: { id: string; username: string; global_name?: string } }>([
    ["P1", { channel: "C1", author: { id: "U1", username: "saajan", global_name: "Saajan" } }],
  ]);
  const threads = new Map<string, { parent: string; name: string }>();
  const calls: string[] = [];
  let next = 100;
  const fetchStub = (async (url: unknown, init?: RequestInit) => {
    const path = String(url).replace("https://discord.com/api/v10", "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const reply = (status: number, data?: unknown) => new Response(data === undefined ? null : JSON.stringify(data), { status });
    if (path === "/users/@me") return reply(200, { id: "BOT", username: "orca" });
    let m = path.match(/^\/channels\/([^/]+)\/messages\/([^/]+)\/threads$/);
    if (m && method === "POST") {
      if (threads.has(m[2]!)) return reply(400, { code: 160004, message: "A thread has already been created for this message" });
      threads.set(m[2]!, { parent: m[1]!, name: body.name });
      return reply(201, { id: m[2], type: 11, parent_id: m[1], name: body.name });
    }
    m = path.match(/^\/channels\/([^/]+)\/messages$/);
    if (m && method === "POST") {
      const id = String(next++);
      messages.set(id, { channel: m[1]!, author: { id: "BOT", username: "orca" } });
      return reply(200, { id, channel_id: m[1] });
    }
    m = path.match(/^\/channels\/([^/]+)\/messages\/([^/]+)$/);
    if (m) {
      const found = messages.get(m[2]!);
      if (!found || found.channel !== m[1]) return reply(404, { code: 10008, message: "Unknown Message" });
      if (method === "DELETE") { messages.delete(m[2]!); return reply(204); }
      return reply(200, { id: m[2], channel_id: m[1], author: found.author });
    }
    return reply(404, { message: "not faked" });
  }) as typeof fetch;
  return { messages, threads, calls, fetchStub };
}

/** Run the dispatcher until `p` (an `orca post` that waits for its delivery) resolves or throws. */
async function dispatched<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; !done && i < 200; i++) {
    await dispatcher.dispatchOnce();
    await new Promise((r) => setTimeout(r, 10));
  }
  return p;
}

describe("orca post --new-thread and --delete on the integrations core (Postgres), threads off", () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  let discord: ReturnType<typeof fakeDiscord>;
  const conn: Connection = { id: "discord", kind: "discord", name: "Discord", instance: "local", config: {}, secretRef: "ORCA_SECRET_DISCORD_TEST", enabled: true };
  const slackConn: Connection = { id: "slack", kind: "slack", name: "Slack", instance: "local", config: {}, secretRef: "ORCA_SECRET_SLACK_TEST", enabled: true };
  const bareConn: Connection = { id: "bare", kind: "bare", name: "Bare", instance: "local", config: {}, enabled: true };

  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE };
    process.env.ORCA_INSTANCE = "local";
    process.env.ORCA_SECRET_DISCORD_TEST = "tok";
    pg = await freshSchema("discordthreaddelete");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    router.resetPace();
    dispatcher.resetPace();
    Object.assign(orchestrator.postWait, { ms: 5_000, everyMs: 10 });
    discord = fakeDiscord();
    globalThis.fetch = discord.fetchStub;
    for (const c of [conn, slackConn, bareConn]) await store.addIntegration(c);
    await store.addLink({ id: "L1", integrationId: "discord", externalId: "C1", label: "#site", level: "work", repos: ["r"], requireMention: true });
    await store.addLink({ id: "S1", integrationId: "slack", externalId: "CS", label: "#slack", level: "work", repos: ["r"], requireMention: true });
    await store.addLink({ id: "B1", integrationId: "bare", externalId: "X1", label: "#bare", level: "work", repos: ["r"], requireMention: false });
    // Not started: no Gateway, so the bot's id comes from GET /users/@me at the first delete.
    const adapter = discordAdapter(conn);
    // Adapters with no `delete`: Slack's real caps, and a kind the registry does not know.
    const plain = (kind: string, caps: Adapter["caps"]): Adapter => ({ kind, caps, start: async () => {}, stop: async () => {}, health: async () => ({ ok: true }), send: async () => ({ ok: true }) });
    const slack = plain("slack", SLACK_CAPS);
    const bare = plain("bare", { ...SLACK_CAPS, deletes: true }); // the flag alone is not enough: no method
    dispatcher.configure({ adapter: (id) => ({ discord: adapter, slack, bare } as Record<string, Adapter>)[id] });
    dispatcher.setRunning(() => ["discord", "slack", "bare"]);
  });
  afterEach(async () => {
    globalThis.fetch = native.fetch;
    dispatcher.configure({ adapter: () => undefined });
    dispatcher.setRunning(() => []);
    await db.close();
    await pg.drop();
    delete process.env.ORCA_SECRET_DISCORD_TEST;
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test("--new-thread posts, then opens a thread with that name on the post, with threads off; it prints both ids", async () => {
    const name = `Release notes ${"x".repeat(120)}`;
    const out = await dispatched(orchestrator.tool(cfg, "post", { link: "L1", "new-thread": name, _: ["The", "long", "answer."] }));
    // The post went to the channel, then the thread opened on it: its id is the post's id.
    expect(discord.calls).toContain("POST /channels/C1/messages");
    expect(discord.calls).toContain("POST /channels/C1/messages/100/threads");
    expect(discord.threads.get("100")).toEqual({ parent: "C1", name: `${name.slice(0, 89)}…` });
    expect(discord.threads.get("100")!.name).toHaveLength(90);
    expect(out).toStartWith('Sent to #site: discord message 100, new thread "Release notes');
    expect(out).toContain(" 100 (delivery ");
    // The delivery row keeps the thread id, so any instance can read it.
    const [d] = await store.deliveries();
    expect(await store.deliveryResult(d!.id)).toMatchObject({ state: "sent", externalMsgId: "100", threadId: "100" });
    expect(await orchestrator.tool(cfg, "post", { link: "L1", "new-thread": "", _: ["x"] }).catch((e: Error) => e.message)).toContain("--new-thread needs the thread name");
    expect(await orchestrator.tool(cfg, "post", { link: "L1", "new-thread": "n", thread: "T9", _: ["x"] }).catch((e: Error) => e.message)).toContain("leave out --thread");
  });

  test("a plain post prints the Discord message id once sent, and the delivery id when the wait runs out", async () => {
    const out = await dispatched(orchestrator.tool(cfg, "post", { link: "L1", _: ["Merged", "#12."] }));
    // Threads off: no thread opened; the post starts its own reply chain.
    expect(out).toMatch(/^Sent to #site: discord message 100, thread C1:100 \(delivery \d+\)\.$/);
    expect(discord.threads.size).toBe(0);
    orchestrator.postWait.ms = 0; // nobody dispatches now: the verb says queued
    expect(await orchestrator.tool(cfg, "post", { link: "L1", _: ["Later."] })).toMatch(/^Queued for #site as delivery \d+; Orca retries it if the send fails\.$/);
  });

  test("--delete removes a message the bot posted", async () => {
    await dispatched(orchestrator.tool(cfg, "post", { link: "L1", _: ["Wrong", "channel."] }));
    expect(discord.messages.has("100")).toBe(true);
    const out = await dispatched(orchestrator.tool(cfg, "post", { link: "L1", delete: "100" }));
    expect(out).toMatch(/^Deleted discord message 100 in #site \(delivery \d+\)\.$/);
    expect(discord.messages.has("100")).toBe(false);
    // Read first (with the bot's own id), then delete.
    expect(discord.calls.slice(-3)).toEqual(["GET /channels/C1/messages/100", "GET /users/@me", "DELETE /channels/C1/messages/100"]);
    // --delete takes no text, and needs an id.
    expect(await orchestrator.tool(cfg, "post", { link: "L1", delete: "100", _: ["x"] }).catch((e: Error) => e.message)).toContain("--delete takes only the place");
    expect(await orchestrator.tool(cfg, "post", { link: "L1", delete: "" }).catch((e: Error) => e.message)).toContain("--delete needs the message id");
  });

  test("--delete refuses a person's message with a clear error and deletes nothing", async () => {
    const err = await dispatched(orchestrator.tool(cfg, "post", { link: "L1", delete: "P1" })).catch((e: Error) => e.message);
    expect(err).toContain("could not delete message P1");
    expect(err).toContain("refused: message P1 was written by Saajan, not by Orca's bot. Orca deletes only its own messages.");
    expect(discord.messages.has("P1")).toBe(true);
    expect(discord.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    // Final, not retried: the delivery is dead after one attempt.
    const [d] = await store.deliveries();
    expect(d).toMatchObject({ state: "dead", attempts: 1 });
  });

  test("an adapter with no delete support refuses: before it queues (caps), and at send (no method)", async () => {
    expect(deleteRefusal("slack", SLACK_CAPS)).toBe("delete not supported: the slack adapter cannot delete messages");
    // Slack's kind is known: the verb refuses before anything is queued.
    await expect(orchestrator.tool(cfg, "post", { link: "S1", delete: "1.2" })).rejects.toThrow("delete not supported: the slack adapter cannot delete messages");
    expect(await store.deliveries()).toHaveLength(0);
    // An unknown kind has no caps here, so it queues; the dispatcher ends it: the adapter has no `delete`.
    const err = await dispatched(orchestrator.tool(cfg, "post", { link: "B1", delete: "m1" })).catch((e: Error) => e.message);
    expect(err).toContain("delete not supported: the bare adapter cannot delete messages");
    expect((await store.deliveries())[0]).toMatchObject({ state: "dead", attempts: 1 });
  });
});
