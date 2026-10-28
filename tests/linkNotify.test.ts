// A link's two switches (`channel_link.notify_me` / `notify_agent`, named step
// 20261023-link-switches; both on by default, old links too). Notify me shows the message to
// you: one web delivery (the bell), an Inbox row, and a chat notice when no agent took it. Notify
// agent lets it wake an agent. A known person keeps their grant; an unknown sender gets a READ-ONLY
// `notify` grant — the orchestrator may read and tell you, never act on it or reply. Ingest makes no
// pairing code. Real Postgres (a fresh schema), the real router, store and admin route.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../server/db";
import * as router from "../server/integrations/router";
import * as store from "../server/integrations/store";
import * as admin from "../server/integrations/admin";
import { agentMay, fenceExternal, grantRefusal, inboundEnvelope } from "../shared/integrations";
import { inboxRows, noticeOf } from "../shared/inbox";
import { freshSchema, type TestDb } from "./pg";

describe("link switches: Notify me and Notify agent", () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE };
    process.env.ORCA_INSTANCE = "local";
    pg = await freshSchema("link_notify");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    router.resetPace();
    await store.addIntegration({ id: "slack", kind: "slack", name: "Slack", instance: "local", config: {}, enabled: true });
    await store.addPrincipal({ id: "saajan", name: "Saajan", maxLevel: "ask" }, [{ adapter: "slack", externalId: "U1" }]);
  });
  afterEach(async () => {
    await db.close();
    await pg.drop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const msg = (eventId: string, from: string) => ({
    ...inboundEnvelope({ adapter: "slack", channel: "D9", eventId, at: 5_000, from: { adapter: "slack", id: from, name: from === "U1" ? "saajan" : "Mira" }, text: "are you free?", mentioned: true, thread: { adapter: "slack", externalId: "D9" } }),
    display: { place: "DM" }, link: { url: "https://acme.slack.com/archives/D9/p5000" },
  });
  const link = (over: Partial<store.Link> = {}) => store.addLink({ id: "all", integrationId: "slack", externalId: "*", level: "ask", repos: [], requireMention: true, ...over });
  const targets = async (key: string) => {
    const e = (await store.event(key))!;
    return (await store.deliveries()).filter((d) => d.eventId === e.id).map((d) => d.target.kind).sort();
  };

  test("both on by default: an unknown sender is a bell row, an Inbox row and a READ-ONLY wake; no pairing code", async () => {
    await link();
    expect(await store.link("all")).toMatchObject({ notifyMe: true, notifyAgent: true });
    // "noted": recorded, but no agent will answer it, so an adapter opens no thread for it.
    expect(await router.ingest("slack", msg("e1", "U-stranger"))).toBe("noted");
    expect(await router.ingest("slack", msg("e1", "U-stranger"))).toBe("duplicate");
    expect(await store.pendingPairings()).toEqual([]);
    const ev = (await store.event("slack:e1"))!;
    expect(ev.grant).toEqual({ level: "notify", repos: [], linkId: "all" });
    expect(ev.notify).toEqual({ me: true, agent: true });
    expect(await targets("slack:e1")).toEqual(["orchestrator", "web"]); // no link agent: the default agent (an `orchestrator` target)
    expect(inboxRows([ev], [], [], new Map())[0]).toMatchObject({ readOnly: true, place: "DM", sender: { name: "Mira", externalId: "U-stranger" } });
    // The agent took it: its wake is the chat's row, so no notice beside it.
    expect(await store.noticeEvents({ since: 0, limit: 10 })).toEqual([]);

    // The read-only wake: no verb (no post, no read verbs), and its prompt says not to act or reply.
    expect(grantRefusal(ev.grant, "post", { link: "all" })).toContain('"post" may answer only');
    expect(grantRefusal(ev.grant, "board")).toBeDefined();
    const fenced = fenceExternal(ev);
    expect(fenced).toContain("READ-ONLY");
    expect(fenced).toContain("Do not answer the sender (on slack an answer posts as the user");
    expect(fenced).not.toContain("orca post --reply");
    expect(fenced).toContain("summarise it and tell the user");

    // A known person keeps their grant, and may be answered.
    expect(await router.ingest("slack", msg("e2", "U1"))).toBe("new");
    expect((await store.event("slack:e2"))!.grant).toMatchObject({ level: "ask", linkId: "all", principalId: "saajan" });
    expect(await targets("slack:e2")).toEqual(["orchestrator", "web"]); // the default agent
    expect(fenceExternal((await store.event("slack:e2"))!)).toContain("orca post --reply");
  });

  test("Notify agent off: no wake for anyone on the link; the message is a chat notice and an Inbox row", async () => {
    await link({ notifyAgent: false });
    // An orchestrator subscription takes nothing either; a web one is not a second row.
    await store.addSubscription({ topicPattern: "ext.slack.*", filter: {}, targetKind: "orchestrator" });
    await store.addSubscription({ topicPattern: "ext.slack.*", filter: {}, targetKind: "web" });
    expect(await router.ingest("slack", msg("e1", "U-stranger"))).toBe("noted");
    expect(await router.ingest("slack", msg("e2", "U1"))).toBe("noted");
    expect(await targets("slack:e1")).toEqual(["web"]);
    expect(await targets("slack:e2")).toEqual(["web"]);
    expect((await store.event("slack:e2"))!.grant).toMatchObject({ level: "ask", principalId: "saajan" }); // the grant is unchanged
    const notices = (await store.noticeEvents({ since: 0, limit: 10 })).map((e) => noticeOf(e, false, new Map([["saajan", "Saajan"]]))!);
    const stranger = notices.find((n) => n.sender.externalId === "U-stranger")!;
    expect(stranger).toMatchObject({
      at: 5_000, adapter: "slack", text: "are you free?", sender: { name: "Mira", adapter: "slack", externalId: "U-stranger" },
      place: "DM", url: "https://acme.slack.com/archives/D9/p5000", conversation: "slack|D9", read: false,
    });
    expect(stranger.sender.personId).toBeUndefined();
    expect(notices.find((n) => n.sender.externalId === "U1")!.sender).toMatchObject({ name: "Saajan", personId: "saajan" });
    expect((await store.inboxEvents({ limit: 10 })).map((e) => e.key).sort()).toEqual(["slack:e1", "slack:e2"]);
  });

  test("Notify me off: no bell, no Inbox row, no notice; the agent still wakes. Both off: nothing is recorded", async () => {
    await link({ notifyMe: false });
    expect(await router.ingest("slack", msg("e1", "U-stranger"))).toBe("noted");
    expect(await targets("slack:e1")).toEqual(["orchestrator"]);
    expect(await store.inboxEvents({ limit: 10 })).toEqual([]);
    expect(await store.unreadWithoutCopy(10)).toBe(0);
    expect(await store.noticeEvents({ since: 0, limit: 10 })).toEqual([]);
    expect(inboxRows([(await store.event("slack:e1"))!], [], [], new Map())).toEqual([]);

    await link({ notifyMe: false, notifyAgent: false });
    expect(await router.ingest("slack", msg("e2", "U1"))).toBe("rejected");
    expect(await store.event("slack:e2")).toBeUndefined();
  });

  test("a machine event under a notify grant still reaches no agent; a person under it is a read-only wake", () => {
    expect(agentMay({ grant: { level: "notify", repos: [] } })).toBe(false);
    expect(agentMay({ grant: { level: "notify", repos: [] }, actor: { external: { adapter: "slack", id: "U9" } } })).toBe(true);
    expect(agentMay({ grant: { level: "ask", repos: [] }, notify: { me: true, agent: false } })).toBe(false);
    expect(agentMay({ grant: { level: "ask", repos: [] } })).toBe(true);
  });

  test("named step 20261023-link-switches turns both switches on for an existing link, and runs twice", async () => {
    const step = db.MIGRATIONS.find((m) => m.name === "20261023-link-switches")!;
    expect(step.idempotent).toBe(true);
    await db.withRetry(async (sql) => {
      await sql.unsafe(`ALTER TABLE channel_link DROP COLUMN notify_me; ALTER TABLE channel_link DROP COLUMN notify_agent;`);
      await sql.unsafe(`INSERT INTO channel_link (id, user_id, integration_id, external_id, level, repos, require_mention)
        VALUES ('old', '${db.currentUser()}', 'slack', 'C1', 'ask', '{}', false)`);
      await sql.unsafe(step.sql);
      await sql.unsafe(step.sql);
    });
    expect(await store.link("old")).toMatchObject({ notifyMe: true, notifyAgent: true });
  });

  test("the admin route saves each switch, keeps one a save omits, and refuses a non-boolean", async () => {
    const base = { id: "slack-all", integrationId: "slack", externalId: "*", label: "All", level: "ask", repos: [], requireMention: true };
    await admin.route("/api/integrations/links/save", base);
    expect(await store.link("slack-all")).toMatchObject({ notifyMe: true, notifyAgent: true });
    await admin.route("/api/integrations/links/save", { ...base, notifyAgent: false });
    expect(await store.link("slack-all")).toMatchObject({ notifyMe: true, notifyAgent: false });
    await admin.route("/api/integrations/links/save", { ...base, label: "Mentions", notifyMe: false });
    expect(await store.link("slack-all")).toMatchObject({ label: "Mentions", notifyMe: false, notifyAgent: false });
    await expect(admin.route("/api/integrations/links/save", { ...base, notifyMe: "yes" })).rejects.toThrow("notifyMe: true or false");
    expect((await admin.overview()).links).toEqual([expect.objectContaining({ id: "slack-all", notifyMe: false, notifyAgent: false })]);
  });
});
