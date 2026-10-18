// Automatic integrations (shared/integrations.ts AUTO_INSTANCE): any instance's primary bridge may run
// the row, but only the one holding its lease (`status.auto`). Pure decisions first, then the real
// registry and store over a fresh Postgres schema, with ONE process playing two instances by
// switching ORCA_INSTANCE: the lease, the failover when the holder stops renewing, the release at
// stop, and the health line when no primary has the secret. A webhook row: no network.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../server/db";
import * as admin from "../server/integrations/admin";
import * as registry from "../server/integrations/registry";
import * as store from "../server/integrations/store";
import { hostsFromStatus } from "../server/servers";
import { AUTO_INSTANCE, AUTO_LEASE_MS, leaseHolder, mayClaim, runsOn } from "../shared/integrations";
import { healthLine, healthTone, instanceOptions, instanceText, integrationProblem, type IntegrationCard } from "../shared/integrationSettings";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const dom = { fetch: globalThis.fetch, Response: globalThis.Response };
beforeAll(() => { Object.assign(globalThis, native); });
afterAll(() => { Object.assign(globalThis, dom); });

describe("decisions (pure)", () => {
  test("runsOn: a pinned row runs on its instance; an Automatic row where its live lease is; never on a secondary", () => {
    const pinned = { instance: "cloud", enabled: true };
    expect(runsOn(pinned, "cloud", true, 0)).toBe(true);
    expect(runsOn(pinned, "local", true, 0)).toBe(false);
    expect(runsOn(pinned, "cloud", false, 0)).toBe(false);
    const auto = { instance: AUTO_INSTANCE, enabled: true, auto: { holder: "cloud", until: 1_000 } };
    expect(runsOn(auto, "cloud", true, 999)).toBe(true);
    expect(runsOn(auto, "local", true, 999)).toBe(false);
    expect(runsOn(auto, "cloud", false, 999)).toBe(false); // the primary moved off this bridge
    expect(runsOn(auto, "cloud", true, 1_000)).toBe(false); // the lease ended: nobody runs it until a claim
    expect(runsOn({ ...auto, enabled: false }, "cloud", true, 0)).toBe(false);
    expect(runsOn({ instance: AUTO_INSTANCE, enabled: true }, "cloud", true, 0)).toBe(false);
    expect(registry.runsHere(auto, "cloud", true, 999)).toBe(true);
    expect(registry.runsHere(auto, "local", true, 999)).toBe(false);
  });

  test("lease: one live holder; another instance may claim only after it ends", () => {
    const lease = { holder: "cloud", until: 1_000 };
    expect(leaseHolder(lease, 999)).toBe("cloud");
    expect(leaseHolder(lease, 1_000)).toBeUndefined();
    expect(leaseHolder(undefined, 0)).toBeUndefined();
    expect(mayClaim(lease, "cloud", 999)).toBe(true); // a renewal
    expect(mayClaim(lease, "local", 999)).toBe(false);
    expect(mayClaim(lease, "local", 1_000)).toBe(true); // the failover
    expect(mayClaim(undefined, "local", 0)).toBe(true);
  });

  test("instance names: the server's display name on its home, the Tailscale host elsewhere, the id as a fallback", () => {
    const opts = instanceOptions(["cloud", "local", "spare", "cloud"], { cloud: "orca-flow-box", local: "finns-mbp" }, "Flow", "cloud");
    expect(opts).toEqual([
      { id: "cloud", label: "Flow", host: "orca-flow-box" },
      { id: "local", label: "finns-mbp", host: "finns-mbp" },
      { id: "spare", label: "spare" },
    ]);
    expect(instanceText("cloud", opts)).toBe("Flow / orca-flow-box");
    expect(instanceText("local", opts)).toBe("finns-mbp");
    expect(instanceText("spare", opts)).toBe("spare");
    expect(instanceText(AUTO_INSTANCE, opts)).toBe("Automatic");
    expect(instanceText("gone", opts)).toBe("gone");
    expect(instanceOptions(["cloud"], {}, "  ", "cloud")).toEqual([{ id: "cloud", label: "cloud" }]);
  });

  test("Tailscale hosts: a tailnet IP reads as its peer's MagicDNS label; a name as its first label; self as its own host", () => {
    const status = {
      Self: { DNSName: "orca-flow-box.tail1234.ts.net.", TailscaleIPs: ["100.115.134.63"] },
      Peer: { k: { HostName: "Finn's MacBook", DNSName: "finns-mbp.tail1234.ts.net.", TailscaleIPs: ["100.124.201.119", "fd7a::1"] } },
    };
    const instances = { cloud: "http://orca-flow-box:8787", local: "http://100.124.201.119:8787", gone: "http://100.1.2.3:8787", bad: "not a url" };
    expect(hostsFromStatus(instances, status)).toEqual({ cloud: "orca-flow-box", local: "finns-mbp" });
    expect(hostsFromStatus({ local: "http://100.124.201.119:8787" }, undefined, { id: "cloud", host: "orca-flow-box" })).toEqual({ cloud: "orca-flow-box" });
  });

  test("health: an Automatic row nobody runs names the variable and the instances without it", () => {
    const opts = instanceOptions(["cloud", "local"], { cloud: "orca-flow-box", local: "finns-mbp" }, "Flow", "cloud");
    const card = (over: Partial<IntegrationCard> = {}): IntegrationCard => ({ id: "d", kind: "discord", name: "Discord", instance: AUTO_INSTANCE, enabled: true, config: {}, secretRef: "ORCA_SECRET_DISCORD_BOT", running: false, ...over });
    const missing = card({ secretMissingOn: ["cloud", "local"] });
    expect(healthLine(missing, 0, opts)).toBe("ORCA_SECRET_DISCORD_BOT is not set on Flow / orca-flow-box, finns-mbp. Set it there and restart Orca.");
    expect(healthTone(missing)).toBe("error");
    expect(healthLine(card(), 0, opts)).toBe("Automatic: no primary bridge runs it yet · no events yet");
    expect(healthTone(card())).toBe("warning");
    expect(healthLine(card({ runsOn: "cloud" }), 0, opts)).toBe("Not checked yet on Flow / orca-flow-box · no events yet");
    expect(healthLine(card({ runsOn: "local", secretSet: false }), 0, opts)).toBe("ORCA_SECRET_DISCORD_BOT is not set on finns-mbp");
    expect(integrationProblem({ id: "d", kind: "discord", name: "Discord", instance: AUTO_INSTANCE }, ["discord"], [])).toBeUndefined();
  });
});

describe("with Postgres", () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  const as = (instance: string) => { process.env.ORCA_INSTANCE = instance; };
  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE, ORCA_SECRET_TEST_AUTO: process.env.ORCA_SECRET_TEST_AUTO };
    pg = await freshSchema("integrations_auto");
    process.env.ORCA_DATABASE_URL = pg.url;
    process.env.ORCA_SECRET_TEST_AUTO = "s";
    await db.close();
  });
  afterEach(async () => {
    await registry.stopAll();
    await db.close();
    await pg.drop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const addAuto = () => store.addIntegration({ id: "hook", kind: "webhook", name: "Hook", instance: AUTO_INSTANCE, config: {}, secretRef: "ORCA_SECRET_TEST_AUTO", enabled: true });

  test("one primary takes the lease and runs it; another waits; it fails over when the lease ends; the old holder then stops", async () => {
    await addAuto();
    as("cloud");
    expect(await registry.sync(0)).toEqual(["hook"]);
    expect((await store.integration("hook"))?.auto).toEqual({ holder: "cloud", until: AUTO_LEASE_MS });
    expect((await admin.overview("cloud", 0)).integrations[0]).toMatchObject({ instance: AUTO_INSTANCE, runsOn: "cloud", secretSet: true, running: true });

    // The other instance's primary: the lease is live, so it opens nothing. (One process plays both
    // bridges, so its sync also stops the adapter the "cloud" bridge started — not a real effect.)
    as("local");
    expect(await registry.sync(1_000)).toEqual([]);
    expect((await store.integration("hook"))?.auto?.holder).toBe("cloud");

    // cloud stops renewing (down, asleep): once the lease ends, local takes it — the failover.
    expect(await registry.sync(AUTO_LEASE_MS)).toEqual(["hook"]);
    expect((await store.integration("hook"))?.auto).toEqual({ holder: "local", until: 2 * AUTO_LEASE_MS });
    expect((await admin.overview("cloud", AUTO_LEASE_MS)).integrations[0]).toMatchObject({ runsOn: "local" });

    // cloud comes back: local holds a live lease, so cloud runs nothing (one session, never two).
    await registry.stopAll(); // local's adapter, released ...
    expect((await store.integration("hook"))?.auto).toBeUndefined();
    as("local");
    expect(await registry.sync(AUTO_LEASE_MS + 1)).toEqual(["hook"]); // ... and taken again at once
    as("cloud");
    expect(await registry.sync(AUTO_LEASE_MS + 2)).toEqual([]);
    expect((await store.integration("hook"))?.auto?.holder).toBe("local");
  });

  test("a pinned row ignores leases; a disabled Automatic row is never claimed", async () => {
    await store.addIntegration({ id: "pinned", kind: "webhook", name: "P", instance: "cloud", config: {}, secretRef: "ORCA_SECRET_TEST_AUTO", enabled: true });
    await store.addIntegration({ id: "off", kind: "webhook", name: "O", instance: AUTO_INSTANCE, config: {}, secretRef: "ORCA_SECRET_TEST_AUTO", enabled: false });
    as("local");
    expect(await registry.sync(0)).toEqual([]);
    as("cloud");
    expect(await registry.sync(0)).toEqual(["pinned"]);
    expect((await store.integration("off"))?.auto).toBeUndefined();
    expect((await store.integration("pinned"))?.auto).toBeUndefined();
  });

  test("a primary without the secret does not take the lease; the page names the variable and the instance", async () => {
    await addAuto();
    delete process.env.ORCA_SECRET_TEST_AUTO;
    as("cloud");
    expect(await registry.sync(0)).toEqual([]);
    const card = (await admin.overview("cloud", 0)).integrations[0]!;
    expect(card).toMatchObject({ secretMissingOn: ["cloud"], running: false });
    expect(card.runsOn).toBeUndefined();
    const opts = instanceOptions(["cloud", "local"], { cloud: "orca-flow-box", local: "finns-mbp" }, "Flow", "cloud");
    expect(healthLine(card, 0, opts)).toBe("ORCA_SECRET_TEST_AUTO is not set on Flow / orca-flow-box. Set it there and restart Orca.");

    // Another instance has it: it takes the lease, and the line is the normal one.
    process.env.ORCA_SECRET_TEST_AUTO = "s";
    as("local");
    expect(await registry.sync(1)).toEqual(["hook"]);
    const after = (await admin.overview("cloud", 1)).integrations[0]!;
    expect(after.runsOn).toBe("local");
    expect(after.secretMissingOn).toBeUndefined();

    // Set on cloud too: its mark goes on the next sync.
    as("cloud");
    await registry.sync(2);
    expect(((await db.withRetry(async (sql) => (await sql`SELECT status FROM integration WHERE id = 'hook'`)[0])) as { status: { secretMissing?: object } }).status.secretMissing).toEqual({});
  });
});
