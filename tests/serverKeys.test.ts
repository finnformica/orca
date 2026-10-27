// Server keys (shared/serverKeys.ts): the credentials Orca itself owns come only from the bridge's
// environment. A missing variable disables that one feature (`configured: false, needs: <VAR>`); a
// value saved before the move (a stored secret on a Discord / webhook row, Slack's appTokenRef, a
// Gmail row's own client) is ignored with one log line that names the variable.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../server/db";
import * as admin from "../server/integrations/admin";
import * as registry from "../server/integrations/registry";
import * as store from "../server/integrations/store";
import { featureState, needsNote, serverFeatures, serverKeyRefusal, serverKeyRow } from "../shared/serverKeys";
import { freshSchema, type TestDb } from "./pg";

test("featureState: configured when every variable is set (blank is missing); needs names the missing ones", () => {
  expect(featureState("discord", { ORCA_SECRET_DISCORD_BOT: "t" })).toEqual({ configured: true });
  expect(featureState("discord", { ORCA_SECRET_DISCORD_BOT: "  " })).toEqual({ configured: false, needs: "ORCA_SECRET_DISCORD_BOT" });
  expect(featureState("googleSignIn", { ORCA_SECRET_GOOGLE_OAUTH: "s" })).toEqual({ configured: false, needs: "ORCA_GOOGLE_OAUTH_CLIENT_ID" });
  expect(featureState("googleSignIn", {})).toEqual({ configured: false, needs: "ORCA_GOOGLE_OAUTH_CLIENT_ID, ORCA_SECRET_GOOGLE_OAUTH" });
  const all = serverFeatures({ ORCA_SECRET_WEBHOOK: "w", ORCA_SECRET_OPENAI_API_KEY: "k" });
  expect(Object.keys(all).sort()).toEqual(["discord", "googleSignIn", "slackSocketMode", "voice", "webhook"]);
  expect(all.webhook).toEqual({ configured: true });
  expect(all.voice).toEqual({ configured: true });
  expect(all.slackSocketMode).toEqual({ configured: false, needs: "SLACK_APP_TOKEN" });
  expect(needsNote(all.discord)).toBe("Not set up on this server: set ORCA_SECRET_DISCORD_BOT in the server's environment and restart Orca.");
});

test("serverKeyRow: an old stored server key falls back to its variable; user-side keys and env names are untouched", () => {
  const discord = serverKeyRow({ id: "d", kind: "discord", secretRef: "secret:chat/bot", config: { dmLink: "x" } });
  expect(discord.row).toEqual({ id: "d", kind: "discord", secretRef: "ORCA_SECRET_DISCORD_BOT", config: { dmLink: "x" } });
  expect(discord.ignored).toEqual(["integration d: the stored secret secret:chat/bot is a server key and is ignored; set ORCA_SECRET_DISCORD_BOT in the environment"]);
  expect(serverKeyRow({ id: "h", kind: "webhook", secretRef: "secret:hook", config: {} }).row.secretRef).toBe("ORCA_SECRET_WEBHOOK");
  // A second bot under its own variable is still a variable: kept.
  expect(serverKeyRow({ id: "d2", kind: "discord", secretRef: "ORCA_SECRET_DISCORD_TWO", config: {} })).toEqual({ row: { id: "d2", kind: "discord", secretRef: "ORCA_SECRET_DISCORD_TWO", config: {} }, ignored: [] });
  const slack = serverKeyRow({ id: "s", kind: "slack", secretRef: "SLACK_TOKEN", config: { appTokenRef: "secret:app", pollSeconds: "60" } });
  expect(slack.row as unknown).toEqual({ id: "s", kind: "slack", secretRef: "SLACK_TOKEN", config: { pollSeconds: "60" } });
  expect(slack.ignored[0]).toContain("set SLACK_APP_TOKEN");
  const gmail = serverKeyRow({ id: "g", kind: "gmail", secretRef: "secret:chat/g", config: { clientId: "c", redirectOrigin: "https://x", query: "label:Orca" } });
  expect(gmail.row as unknown).toEqual({ id: "g", kind: "gmail", config: { query: "label:Orca" } });
  expect(gmail.ignored).toHaveLength(3);
  // User-side keys stay where they are: a pasted Granola key, a Cloudflare or Linear token in the store.
  for (const kind of ["granola", "cloudflare", "linear"]) {
    expect(serverKeyRow({ id: "u", kind, secretRef: "secret:integrations/u.api_key", config: {} })).toEqual({ row: { id: "u", kind, secretRef: "secret:integrations/u.api_key", config: {} }, ignored: [] });
  }
});

test("serverKeyRefusal: a save may not point a server key at a stored secret", () => {
  expect(serverKeyRefusal({ kind: "discord", secretRef: "secret:bot" })).toContain("default ORCA_SECRET_DISCORD_BOT");
  expect(serverKeyRefusal({ kind: "webhook", secretRef: "secret:hook" })).toContain("default ORCA_SECRET_WEBHOOK");
  expect(serverKeyRefusal({ kind: "slack", secretRef: "SLACK_TOKEN", config: { appTokenRef: "secret:app" } })).toContain("SLACK_APP_TOKEN");
  expect(serverKeyRefusal({ kind: "discord", secretRef: "ORCA_SECRET_DISCORD_BOT" })).toBeUndefined();
  expect(serverKeyRefusal({ kind: "cloudflare", secretRef: "secret:cf" })).toBeUndefined();
});

describe("with Postgres", () => {
  let pg: TestDb;
  const VARS = ["ORCA_DATABASE_URL", "ORCA_INSTANCE", "ORCA_SECRET_DISCORD_BOT", "ORCA_SECRET_WEBHOOK"];
  let prev: Record<string, string | undefined> = {};
  beforeEach(async () => {
    prev = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
    pg = await freshSchema("server_keys");
    process.env.ORCA_DATABASE_URL = pg.url;
    process.env.ORCA_INSTANCE = "local";
    delete process.env.ORCA_SECRET_DISCORD_BOT;
    delete process.env.ORCA_SECRET_WEBHOOK;
    await db.close();
  });
  afterEach(async () => {
    await registry.stopAll();
    await db.close();
    await pg.drop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test("a Discord row saved with a stored secret reads as ORCA_SECRET_DISCORD_BOT, with one log line; a new save of a stored secret is refused", async () => {
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      // Written straight to the table, as an older bridge did.
      await store.addIntegration({ id: "bot", kind: "discord", name: "Bot", instance: "local", config: {}, secretRef: "secret:chat/discord-bot", enabled: false });
      expect((await store.integration("bot"))!.secretRef).toBe("ORCA_SECRET_DISCORD_BOT");
      expect((await store.integrations()).find((c) => c.id === "bot")!.secretRef).toBe("ORCA_SECRET_DISCORD_BOT");
    } finally { console.warn = warn; }
    expect(lines.filter((l) => l.includes("integration bot:"))).toEqual(["orca: integration bot: the stored secret secret:chat/discord-bot is a server key and is ignored; set ORCA_SECRET_DISCORD_BOT in the environment"]);
    await expect(admin.saveIntegration({ id: "bot2", kind: "discord", name: "Bot 2", instance: "local", secretRef: "secret:chat/discord-bot", enabled: false }))
      .rejects.toThrow("not a stored secret");
    // An empty secret field takes the kind's variable.
    await admin.saveIntegration({ id: "hook", kind: "webhook", name: "Hook", instance: "local", secretRef: "", enabled: false });
    expect((await store.integration("hook"))!.secretRef).toBe("ORCA_SECRET_WEBHOOK");
  });

  test("the overview: a server-key kind says configured false and needs its variable until this bridge has it; a user-side kind has no serverKey", async () => {
    const kind = async (k: string) => (await admin.overview()).kinds.find((x) => x.kind === k)!;
    expect((await kind("discord")).serverKey).toEqual({ configured: false, needs: "ORCA_SECRET_DISCORD_BOT" });
    expect((await kind("webhook")).serverKey).toEqual({ configured: false, needs: "ORCA_SECRET_WEBHOOK" });
    expect((await kind("granola")).serverKey).toBeUndefined();
    expect((await kind("cloudflare")).serverKey).toBeUndefined();
    process.env.ORCA_SECRET_DISCORD_BOT = "token";
    expect((await kind("discord")).serverKey).toEqual({ configured: true });
    // A webhook row under its own variable that is set here: the kind is set up on this bridge.
    process.env.ORCA_SECRET_WEBHOOK_TWO = "w";
    try {
      await store.addIntegration({ id: "h2", kind: "webhook", name: "H2", instance: "local", config: {}, secretRef: "ORCA_SECRET_WEBHOOK_TWO", enabled: true });
      expect((await kind("webhook")).serverKey).toEqual({ configured: true });
    } finally { delete process.env.ORCA_SECRET_WEBHOOK_TWO; }
  });
});
