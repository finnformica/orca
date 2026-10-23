// What a link does with an unknown sender (`channel_link.pairing`, named steps 20261023-link-pairing
// and 20261023-link-pairing-notify): with "request" (the default, every old link) they get a pairing
// code, an event and a bell row; with "notify" their message is recorded with a "notify" grant and
// shown to you only — one web delivery (the bell, the Inbox), a notice for the orchestrator's chat, no
// code, no agent target, no reply. A known person passes either way, with their grant. The step moves
// stored "off" rows to "notify"; the admin route takes the value and keeps it when absent.
// Real Postgres (a fresh schema), the real router, store and admin route.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../server/db";
import * as router from "../server/integrations/router";
import * as store from "../server/integrations/store";
import * as admin from "../server/integrations/admin";
import { inboundEnvelope } from "../shared/integrations";
import { inboxRows, noticeOf } from "../shared/inbox";
import { freshSchema, type TestDb } from "./pg";

describe("link pairing: request or notify", () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE };
    process.env.ORCA_INSTANCE = "local";
    pg = await freshSchema("link_pairing");
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

  const msg = (eventId: string, from: string, over: Record<string, unknown> = {}) => ({
    ...inboundEnvelope({ adapter: "slack", channel: "D9", eventId, at: 5_000, from: { adapter: "slack", id: from, name: from === "U1" ? "saajan" : "Mira" }, text: "are you free?", mentioned: true, thread: { adapter: "slack", externalId: "D9" } }),
    display: { place: "DM" }, link: { url: "https://acme.slack.com/archives/D9/p5000" }, ...over,
  });

  test("an old link reads as pairing 'request': an unknown sender gets a code and a bell event", async () => {
    await store.addLink({ id: "all", integrationId: "slack", externalId: "*", level: "ask", repos: [], requireMention: true });
    expect((await store.link("all"))?.pairing).toBe("request");
    expect(await router.ingest("slack", msg("e1", "U-stranger"))).toBe("rejected");
    const codes = await store.pendingPairings();
    expect(codes.map((p) => p.externalId)).toEqual(["U-stranger"]);
    expect((await store.event(`pairing:${codes[0]!.code}`))?.topic).toBe("orca.pairing.requested");
    expect(await store.event("slack:e1")).toBeUndefined();
  });

  test("pairing 'notify': the message is recorded and shown to you only — one web delivery, no code, no agent; a known person still wakes the orchestrator", async () => {
    await store.addLink({ id: "all", integrationId: "slack", externalId: "*", level: "ask", repos: [], requireMention: true, pairing: "notify" });
    // An orchestrator subscription takes nothing under a notify grant; a web one is not a second row.
    await store.addSubscription({ topicPattern: "ext.slack.*", filter: {}, targetKind: "orchestrator" });
    await store.addSubscription({ topicPattern: "ext.slack.*", filter: {}, targetKind: "web" });
    expect(await router.ingest("slack", msg("e1", "U-stranger"))).toBe("new");
    expect(await router.ingest("slack", msg("e1", "U-stranger"))).toBe("duplicate");
    expect(await store.pendingPairings()).toEqual([]);
    const ev = (await store.event("slack:e1"))!;
    expect(ev.grant).toEqual({ level: "notify", repos: [], linkId: "all" });
    expect(ev.source).toMatchObject({ integrationId: "slack", linkId: "all" });
    expect(ev.actor?.principalId).toBeUndefined();
    expect((await store.deliveries()).map((d) => d.target)).toEqual([{ kind: "web" }]); // no orchestrator, no reply to a link

    // The chat's notice: sender, place, text, link, time and the conversation's stable id.
    const notices = await store.noticeEvents({ since: 0, limit: 10 });
    expect(notices.map((e) => noticeOf(e))).toEqual([{
      id: ev.id, at: 5_000, adapter: "slack", text: "are you free?", sender: { name: "Mira", adapter: "slack", externalId: "U-stranger" },
      place: "DM", url: "https://acme.slack.com/archives/D9/p5000", conversation: "slack|D9", read: false,
    }]);
    // The Inbox row says so, with its place.
    expect(inboxRows(notices, [], [], new Map())[0]).toMatchObject({ notice: true, place: "DM", sender: { name: "Mira", externalId: "U-stranger" } });

    // A known person is not touched: their grant, the orchestrator, no notice.
    expect(await router.ingest("slack", msg("e2", "U1"))).toBe("new");
    const known = (await store.event("slack:e2"))!;
    expect(known.grant).toMatchObject({ level: "ask", linkId: "all", principalId: "saajan" });
    expect((await store.deliveries()).filter((d) => d.eventId === known.id).map((d) => d.target.kind).sort()).toEqual(["orchestrator", "web"]);
    expect(noticeOf(known)).toBeUndefined();
    expect((await store.noticeEvents({ since: 0, limit: 10 })).map((e) => e.key)).toEqual(["slack:e1"]);
  });

  test("a notify link level still takes nothing from an unknown sender, whatever the pairing", async () => {
    await store.addLink({ id: "all", integrationId: "slack", externalId: "*", level: "notify", repos: [], requireMention: true, pairing: "notify" });
    expect(await router.ingest("slack", msg("e1", "U-stranger"))).toBe("rejected");
    expect(await store.event("slack:e1")).toBeUndefined();
    expect(await store.pendingPairings()).toEqual([]);
  });

  test("named step 20261023-link-pairing-notify moves 'off' rows to 'notify', refuses 'off' after, and runs twice", async () => {
    const step = db.MIGRATIONS.find((m) => m.name === "20261023-link-pairing-notify")!;
    expect(step.idempotent).toBe(true);
    await store.addLink({ id: "all", integrationId: "slack", externalId: "*", level: "ask", repos: [], requireMention: true });
    // The database as 20261023-link-pairing left it, with a row a tab saved as 'off'.
    await db.withRetry(async (sql) => {
      await sql.unsafe(`ALTER TABLE channel_link DROP CONSTRAINT channel_link_pairing_check;
        ALTER TABLE channel_link ADD CONSTRAINT channel_link_pairing_check CHECK (pairing IN ('request','off'));
        UPDATE channel_link SET pairing = 'off';`);
      await sql.unsafe(step.sql);
      await sql.unsafe(step.sql);
    });
    expect((await store.link("all"))?.pairing).toBe("notify");
    await expect(db.withRetry((sql) => sql.unsafe(`UPDATE channel_link SET pairing = 'off'`))).rejects.toThrow();
  });

  test("the admin route saves pairing, keeps it when a save omits it, reads an old tab's 'off' as 'notify' and refuses an unknown value", async () => {
    const base = { id: "slack-all", integrationId: "slack", externalId: "*", label: "All", level: "ask", repos: [], requireMention: true };
    await admin.route("/api/integrations/links/save", { ...base, pairing: "notify" });
    expect((await store.link("slack-all"))?.pairing).toBe("notify");
    await admin.route("/api/integrations/links/save", { ...base, label: "Mentions" });
    expect(await store.link("slack-all")).toMatchObject({ label: "Mentions", pairing: "notify" });
    await admin.route("/api/integrations/links/save", { ...base, pairing: "request" });
    expect((await store.link("slack-all"))?.pairing).toBe("request");
    await admin.route("/api/integrations/links/save", { ...base, pairing: "off" });
    expect((await store.link("slack-all"))?.pairing).toBe("notify");
    await expect(admin.route("/api/integrations/links/save", { ...base, pairing: "maybe" })).rejects.toThrow("pairing: request or notify");
    expect((await admin.overview()).links).toEqual([expect.objectContaining({ id: "slack-all", pairing: "notify" })]);
  });
});
