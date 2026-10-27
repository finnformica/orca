// The account policy (docs/integrations/POLICY.md): each connected account (an `integration` row) has
// `access` (read | read-write: what Orca may do with it) and `events` (trigger | record | off: what
// its inbound events do). ONE check, `integrationAccessRefusal`, at every door: publish, the
// dispatcher, a link's Test and every `orca <kind>` CLI verb. Events narrow the link switches,
// never widen them. Several accounts of one kind are addressed with `--account`. Real Postgres (a
// fresh schema), the real router, dispatcher, admin route and orchestrator tool.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../server/db";
import * as orchestrator from "../server/orchestrator";
import * as router from "../server/integrations/router";
import * as dispatcher from "../server/integrations/dispatcher";
import * as store from "../server/integrations/store";
import * as admin from "../server/integrations/admin";
import * as policy from "../server/integrations/policy";
import * as registry from "../server/integrations/registry";
import type { Adapter } from "../server/integrations/adapter";
import { CLOUDFLARE_VERBS, cloudflareVerb } from "../server/cloudflare";
import { SLACK_VERBS } from "../server/slackTool";
import {
  CORE_VERBS, effectiveNotify, inboundEnvelope, integrationAccessRefusal, pickAccount, verbClass,
  type Access, type EventsMode,
} from "../shared/integrations";
import type { OrcaConfig } from "../server/config";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const dom = { fetch: globalThis.fetch, Response: globalThis.Response };
beforeAll(() => { Object.assign(globalThis, native); orchestrator.postWait.ms = 0; });
afterAll(() => { Object.assign(globalThis, dom); });

describe("the policy (pure)", () => {
  test("verb classes: the kind's declaration, else the core's, else write (fail closed)", () => {
    expect(CORE_VERBS).toEqual({ send: "write", delete: "write", health: "read" });
    expect(verbClass("send")).toBe("write");
    expect(verbClass("health")).toBe("read");
    expect(verbClass("search", SLACK_VERBS)).toBe("read");
    expect(verbClass("post", SLACK_VERBS)).toBe("write");
    expect(verbClass("provision", {})).toBe("write"); // nobody declared it
    expect(verbClass("toString", {})).toBe("write"); // no prototype key counts as a declaration
    expect(cloudflareVerb(["workers"])).toBe("workers");
    expect(cloudflareVerb(["route", "list"])).toBe("route");
    expect(cloudflareVerb(["route", "add"])).toBe("route add");
    expect(cloudflareVerb(["delete", "w"])).toBe("delete");
    expect(verbClass(cloudflareVerb(["route", "list"]), CLOUDFLARE_VERBS)).toBe("read");
    expect(verbClass(cloudflareVerb(["route", "remove"]), CLOUDFLARE_VERBS)).toBe("write");
  });

  test("the one check: a read account refuses every write verb and allows every read verb", () => {
    const ro = { id: "gmail-personal", name: "Personal Gmail", kind: "gmail", access: "read" as const };
    expect(integrationAccessRefusal(ro, "search", { search: "read" })).toBeUndefined();
    expect(integrationAccessRefusal(ro, "send")).toContain('the gmail account "Personal Gmail" (gmail-personal) has read access, and "send" writes');
    expect(integrationAccessRefusal(ro, "send")).toContain('"Read and write" in Settings > Integrations');
    expect(integrationAccessRefusal({ ...ro, access: "read-write" }, "send")).toBeUndefined();
    expect(integrationAccessRefusal({ id: "old", kind: "discord" }, "send")).toBeUndefined(); // no policy = read-write
  });

  test("events narrow a link's switches, never widen them", () => {
    const on = { me: true, agent: true };
    expect(effectiveNotify(on)).toEqual(on); // the default: trigger
    expect(effectiveNotify(on, "trigger")).toEqual(on);
    expect(effectiveNotify(on, "record")).toEqual({ me: true, agent: false });
    expect(effectiveNotify(on, "off")).toEqual({ me: false, agent: false });
    expect(effectiveNotify({ me: false, agent: false }, "trigger")).toEqual({ me: false, agent: false }); // never wider
    expect(effectiveNotify({ me: true, agent: false }, "trigger")).toEqual({ me: true, agent: false });
  });

  test("account choice: by id or name; the one row by default; several without --account is an error", () => {
    const rows = [
      { id: "gmail-personal", name: "Personal", kind: "gmail" },
      { id: "gmail-smf", name: "smfstudio.io", kind: "gmail" },
      { id: "slack-work", name: "Work", kind: "slack" },
    ];
    expect(pickAccount(rows, "slack").account?.id).toBe("slack-work");
    expect(pickAccount(rows, "slack", "WORK").account?.id).toBe("slack-work"); // the name, any case
    expect(pickAccount(rows, "gmail", "gmail-smf").account?.id).toBe("gmail-smf");
    expect(pickAccount(rows, "gmail", "personal").account?.id).toBe("gmail-personal");
    expect(pickAccount(rows, "gmail").error).toBe("2 gmail accounts are connected (gmail-personal (Personal), gmail-smf (smfstudio.io)): name one with --account <id>");
    expect(pickAccount(rows, "gmail", "home").error).toContain('no gmail account "home" (accounts: gmail-personal');
    expect(pickAccount(rows, "cloudflare")).toEqual({}); // none: the verb keeps its env-token path
    expect(pickAccount(rows, "cloudflare", "x").error).toContain("no cloudflare account is connected");
  });

  test("Finn's five accounts: what Orca may do, and what an event does", () => {
    const finn: { kind: string; access: Access; events: EventsMode; read: string; write: string; me: boolean; agent: boolean; writes: boolean }[] = [
      { kind: "slack", access: "read-write", events: "off", read: "search", write: "post", me: false, agent: false, writes: true },
      { kind: "gmail", access: "read", events: "off", read: "search", write: "send", me: false, agent: false, writes: false },
      { kind: "gmail", access: "read", events: "trigger", read: "read", write: "reply", me: true, agent: true, writes: false },
      { kind: "discord", access: "read-write", events: "trigger", read: "health", write: "send", me: true, agent: true, writes: true },
      { kind: "cloudflare", access: "read-write", events: "trigger", read: "workers", write: "rollback", me: true, agent: true, writes: true },
    ];
    const classes: Record<string, Record<string, "read" | "write">> = { slack: SLACK_VERBS, cloudflare: CLOUDFLARE_VERBS, gmail: { search: "read", read: "read", reply: "write" }, discord: {} };
    for (const a of finn) {
      const acct = { id: a.kind, kind: a.kind, access: a.access };
      expect(integrationAccessRefusal(acct, a.read, classes[a.kind])).toBeUndefined();
      expect(integrationAccessRefusal(acct, a.write, classes[a.kind]) === undefined).toBe(a.writes);
      expect(effectiveNotify({ me: true, agent: true }, a.events)).toEqual({ me: a.me, agent: a.agent });
    }
  });
});

describe("the policy in the core", () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  const sent: string[] = [];
  const fake: Adapter = {
    kind: "slack", caps: { inbound: "none", outbound: true, threads: false, edits: false, reactions: false, attachments: false, maxTextLength: 4000 },
    start: async () => {}, stop: async () => {}, health: async () => ({ ok: true }),
    send: async (t, msg) => { sent.push(`${t.externalId}:${msg.text}`); return { ok: true, externalMsgId: "m1" }; },
  };
  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE, SLACK_TOKEN: process.env.SLACK_TOKEN, ORCA_SECRET_SLACK_HOME: process.env.ORCA_SECRET_SLACK_HOME };
    process.env.ORCA_INSTANCE = "local";
    pg = await freshSchema("integration_policy");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    router.resetPace();
    dispatcher.resetPace();
    sent.length = 0;
    dispatcher.configure({ adapter: () => fake });
    dispatcher.setRunning(() => ["slack-work", "discord"]);
    await store.addIntegration({ id: "slack-work", kind: "slack", name: "Work", instance: "local", config: {}, secretRef: "SLACK_TOKEN", enabled: true });
    await store.addIntegration({ id: "discord", kind: "discord", name: "Discord", instance: "*", config: {}, secretRef: "ORCA_SECRET_DISCORD_BOT", enabled: true });
    await store.addLink({ id: "eng", integrationId: "slack-work", externalId: "C1", level: "ask", repos: [], requireMention: false });
    await store.addLink({ id: "all", integrationId: "slack-work", externalId: "*", level: "ask", repos: [], requireMention: false });
    await store.addPrincipal({ id: "ana", name: "Ana", maxLevel: "ask" }, [{ adapter: "slack", externalId: "U1" }]);
  });
  afterEach(async () => {
    dispatcher.setRunning(() => []);
    await db.close();
    await pg.drop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const msg = (eventId: string) => inboundEnvelope({ adapter: "slack", channel: "C1", eventId, at: 5_000, from: { adapter: "slack", id: "U1", name: "ana" }, text: "status?", mentioned: true });
  const targets = async (key: string) => {
    const e = await store.event(key);
    return e ? (await store.deliveries()).filter((d) => d.eventId === e.id).map((d) => d.target.kind).sort() : undefined;
  };

  test("old rows keep the behaviour before the policy: read-write, trigger (Discord unchanged)", async () => {
    expect(await store.integration("discord")).toMatchObject({ access: "read-write", events: "trigger" });
    // A save that does not name the policy keeps the stored one.
    await store.setPolicy("slack-work", { access: "read", events: "off" });
    await admin.saveIntegration({ id: "slack-work", kind: "slack", name: "Work Slack", instance: "local", secretRef: "SLACK_TOKEN" });
    expect(await store.integration("slack-work")).toMatchObject({ name: "Work Slack", access: "read", events: "off" });
    await admin.setEnabled("slack-work", false);
    expect(await store.integration("slack-work")).toMatchObject({ enabled: false, access: "read", events: "off" });
    // The Settings route sets one or both, and refuses a bad value.
    await admin.route("/api/integrations/policy", { id: "slack-work", events: "record" });
    expect(await store.integration("slack-work")).toMatchObject({ access: "read", events: "record" });
    await expect(admin.route("/api/integrations/policy", { id: "slack-work", access: "write" })).rejects.toThrow("access: read or read-write");
    await expect(admin.route("/api/integrations/policy", { id: "nope", events: "off" })).rejects.toThrow("no integration nope");
    const card = (await admin.overview()).integrations.find((c) => c.id === "slack-work");
    expect(card).toMatchObject({ access: "read", events: "record" });
  });

  test("events: trigger wakes as before; record is an Inbox row and no wake; off records nothing", async () => {
    expect(await router.ingest("slack-work", msg("t1"))).toBe("new");
    expect(await targets("slack:t1")).toEqual(["agent", "web"]); // the link's agent: the Assistant by default

    await store.setPolicy("slack-work", { events: "record" });
    expect(await router.ingest("slack-work", msg("r1"))).toBe("noted"); // no agent answers: open no thread
    expect((await store.event("slack:r1"))?.notify).toEqual({ me: true, agent: false });
    expect(await targets("slack:r1")).toEqual(["web"]);
    // A link with Notify me off stays off: the account never widens it.
    await store.addLink({ id: "eng", integrationId: "slack-work", externalId: "C1", level: "ask", repos: [], requireMention: false, notifyMe: false });
    expect(await router.ingest("slack-work", msg("r2"))).toBe("rejected");

    await store.addLink({ id: "eng", integrationId: "slack-work", externalId: "C1", level: "ask", repos: [], requireMention: false });
    await store.setPolicy("slack-work", { events: "off" });
    expect(await router.ingest("slack-work", msg("o1"))).toBe("rejected");
    expect(await store.event("slack:o1")).toBeUndefined();
  });

  test("access read: orca post and a link's Test are refused; a subscription plans nothing; the dispatcher ends an old row", async () => {
    const cfg = { repos: [] } as unknown as OrcaConfig;
    await store.addSubscription({ topicPattern: "orca.pr.*", filter: {}, targetKind: "link", targetId: "eng" });
    // Read-write: as before.
    expect(await orchestrator.tool(cfg, "post", { link: "eng", _: ["hello"] })).toContain("Queued for eng");
    const { deliveries: before } = await router.publish({ key: "pr:1", topic: "orca.pr.merged", at: 0, source: { adapter: "orca" }, text: "merged" }, 0);
    expect(before).toHaveLength(1);

    await store.setPolicy("slack-work", { access: "read" });
    await expect(orchestrator.tool(cfg, "post", { link: "eng", _: ["hello"] })).rejects.toThrow('has read access, and "send" writes');
    await expect(admin.testLink("eng", { waitMs: 0 })).rejects.toThrow('"send" writes');
    // A subscription to a read account: no delivery, so no dead row and no failure notice.
    const { deliveries: after } = await router.publish({ key: "pr:2", topic: "orca.pr.merged", at: 0, source: { adapter: "orca" }, text: "merged" }, 0);
    expect(after).toEqual([]);
    // The rows planned while it was read-write end at the dispatcher, never at the adapter.
    await dispatcher.dispatchOnce();
    expect(sent).toEqual([]);
    const dead = await store.deliveries({ state: "dead" });
    expect(dead).toHaveLength(2);
    expect(dead.every((d) => d.lastError?.includes("has read access"))).toBe(true);
    // Discord, another account, is not touched.
    await store.addLink({ id: "dc", integrationId: "discord", externalId: "D1", level: "ask", repos: [], requireMention: false });
    expect(await orchestrator.tool(cfg, "post", { link: "dc", _: ["hi"] })).toContain("Queued for dc");
    await dispatcher.dispatchOnce();
    expect(sent).toEqual(["D1:hi"]);
    // `orca post --delete` is a write too.
    await store.setPolicy("discord", { access: "read" });
    await expect(orchestrator.tool(cfg, "post", { link: "dc", delete: "123" })).rejects.toThrow('the discord account "Discord" (discord) has read access, and "delete" writes');
  });

  test("orca slack: one account by default; --account with several; a read account refuses post before any call", async () => {
    const cfg = { repos: [] } as unknown as OrcaConfig;
    const calls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      calls.push(`${new URL(url).pathname} ${auth}`);
      return Response.json({ ok: true, messages: { matches: [], total: 0 }, ts: "1.2", channel: "C1" });
    }) as typeof fetch;
    try {
      process.env.SLACK_TOKEN = "xoxp-work";
      process.env.ORCA_SECRET_SLACK_HOME = "xoxp-home";
      expect(await orchestrator.tool(cfg, "slack", { _: ["search", "deploy"] })).toContain('no messages match "deploy"');
      expect(calls.pop()).toBe("/api/search.messages Bearer xoxp-work");
      expect(registry.verbsFor("slack")).toBe(SLACK_VERBS);

      // A second Slack account: now a verb must name one, and its own token is used.
      await store.addIntegration({ id: "slack-home", kind: "slack", name: "Home", instance: "local", config: {}, secretRef: "ORCA_SECRET_SLACK_HOME", enabled: true });
      await expect(orchestrator.tool(cfg, "slack", { _: ["search", "deploy"] })).rejects.toThrow("2 slack accounts are connected (slack-home (Home), slack-work (Work)): name one with --account <id>");
      expect(await orchestrator.tool(cfg, "slack", { _: ["search", "deploy"], account: "home" })).toContain("no messages match");
      expect(calls.pop()).toBe("/api/search.messages Bearer xoxp-home");
      expect(await orchestrator.tool(cfg, "slack", { _: ["help"] })).toContain("--account <id or name>"); // help needs no account

      await store.setPolicy("slack-home", { access: "read" });
      expect(await orchestrator.tool(cfg, "slack", { _: ["search", "x"], account: "slack-home" })).toContain("no messages match");
      calls.length = 0;
      await expect(orchestrator.tool(cfg, "slack", { _: ["post", "C1", "hi"], account: "slack-home" })).rejects.toThrow('the slack account "Home" (slack-home) has read access, and "post" writes');
      expect(calls).toEqual([]); // refused before any call to Slack
      expect(await orchestrator.tool(cfg, "slack", { _: ["post", "C1", "hi"], account: "work" })).toContain("Posted to C1");
      expect(calls.pop()).toBe("/api/chat.postMessage Bearer xoxp-work");
      // orca channels shows each account's policy.
      expect(await orchestrator.tool(cfg, "channels")).toContain("account slack-home · slack Home · access read (no post, send or delete) · events trigger");
    } finally { globalThis.fetch = orig; }
  });

  test("orca cloudflare: no account row keeps the old path; a read row refuses the writes, even a dry run", async () => {
    const cfg = { repos: [] } as unknown as OrcaConfig;
    expect(await policy.useAccount("cloudflare", "rollback")).toBeUndefined(); // no row: as before
    await db.withRetry(async (sql) => {
      await sql`INSERT INTO integration (id, user_id, kind, name, instance, config, secret_ref, enabled, created_at, access)
        VALUES ('cf', ${db.currentUser()}, 'cloudflare', 'Cloudflare', '*', ${{ accountId: "acc1" }}, 'ORCA_SECRET_CLOUDFLARE', true, 0, 'read')`;
    });
    const c = await policy.useAccount("cloudflare", "workers");
    expect(c?.id).toBe("cf");
    expect(policy.accountEnv(c, "ORCA_SECRET_CLOUDFLARE", { ORCA_CLOUDFLARE_ACCOUNT_ID: "acc1" }, { ORCA_SECRET_CLOUDFLARE: "tok" })).toMatchObject({ ORCA_SECRET_CLOUDFLARE: "tok", ORCA_CLOUDFLARE_ACCOUNT_ID: "acc1" });
    await expect(orchestrator.tool(cfg, "cloudflare", { _: ["rollback", "w"], version: "v1" })).rejects.toThrow('the cloudflare account "Cloudflare" (cf) has read access, and "rollback" writes');
    await expect(orchestrator.tool(cfg, "cloudflare", { _: ["route", "add"] })).rejects.toThrow('"route add" writes');
    await expect(orchestrator.tool(cfg, "cloudflare", { _: ["workers"], account: "" })).rejects.toThrow("--account needs an account id or name");
  });
});
