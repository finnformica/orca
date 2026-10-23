// The per-link pairing switch (`channel_link.pairing`, named step 20261023-link-pairing): with
// "request" (the default, every old link) an unknown sender gets a pairing code, an event and a bell
// row; with "off" the message is dropped silently — no code, no event, no delivery. A known person
// passes either way. The admin route accepts the field and keeps the stored value when it is absent.
// Real Postgres (a fresh schema), the real router, store and admin route.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../server/db";
import * as router from "../server/integrations/router";
import * as store from "../server/integrations/store";
import * as admin from "../server/integrations/admin";
import { inboundEnvelope } from "../shared/integrations";
import { freshSchema, type TestDb } from "./pg";

describe("link pairing switch", () => {
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

  const msg = (eventId: string, from: string) =>
    inboundEnvelope({ adapter: "slack", channel: "C1", eventId, from: { adapter: "slack", id: from, name: from }, text: "hi @finn", mentioned: true });

  test("an old link reads as pairing 'request': an unknown sender gets a code and a bell event", async () => {
    await store.addLink({ id: "all", integrationId: "slack", externalId: "*", level: "ask", repos: [], requireMention: true });
    expect((await store.link("all"))?.pairing).toBe("request");
    expect(await router.ingest("slack", msg("e1", "U-stranger"))).toBe("rejected");
    const codes = await store.pendingPairings();
    expect(codes.map((p) => p.externalId)).toEqual(["U-stranger"]);
    expect((await store.event(`pairing:${codes[0]!.code}`))?.topic).toBe("orca.pairing.requested");
  });

  test("pairing 'off': an unknown sender is dropped silently — no code, no event, no delivery; a known person passes", async () => {
    await store.addLink({ id: "all", integrationId: "slack", externalId: "*", level: "ask", repos: [], requireMention: true, pairing: "off" });
    expect(await router.ingest("slack", msg("e1", "U-stranger"))).toBe("rejected");
    expect(await store.pendingPairings()).toEqual([]);
    expect(await store.deliveries()).toEqual([]);
    expect(await store.event("slack:e1")).toBeUndefined();
    // A known person is not touched by the switch.
    expect(await router.ingest("slack", msg("e2", "U1"))).toBe("new");
    expect((await store.event("slack:e2"))?.grant).toMatchObject({ level: "ask", linkId: "all", principalId: "saajan" });
  });

  test("the admin route saves pairing, keeps it when a save omits it, and refuses an unknown value", async () => {
    const base = { id: "slack-all", integrationId: "slack", externalId: "*", label: "All", level: "ask", repos: [], requireMention: true };
    await admin.route("/api/integrations/links/save", { ...base, pairing: "off" });
    expect((await store.link("slack-all"))?.pairing).toBe("off");
    await admin.route("/api/integrations/links/save", { ...base, label: "Mentions" });
    expect(await store.link("slack-all")).toMatchObject({ label: "Mentions", pairing: "off" });
    await admin.route("/api/integrations/links/save", { ...base, pairing: "request" });
    expect((await store.link("slack-all"))?.pairing).toBe("request");
    await expect(admin.route("/api/integrations/links/save", { ...base, pairing: "maybe" })).rejects.toThrow("pairing: request or off");
    expect((await admin.overview()).links).toEqual([expect.objectContaining({ id: "slack-all", pairing: "request" })]);
  });
});
