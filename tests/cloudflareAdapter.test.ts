// The Cloudflare adapter (server/integrations/adapters/cloudflare.ts, docs/integrations/cloudflare.md):
// a poll of one account — audit log, Workers and deployments, custom domains, Worker error rate —
// whose changes become one envelope per topic and place through the core's gate. Cloudflare is a
// fake v4 API on loopback; no real Cloudflare call. The token and account below are made up.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../server/db";
import * as admin from "../server/integrations/admin";
import * as registry from "../server/integrations/registry";
import * as store from "../server/integrations/store";
import type { AdapterContext, Connection } from "../server/integrations/adapter";
import {
  DEFAULT_SUBSCRIPTIONS, OWN_WRITES_CURSOR, auditItems, batchEnvelopes, cloudflareAdapter, cloudflareConfig, connectedCredentials, errorItems,
  nextAudit, readOwnWrites, recordOwnWrite, type CloudflareAdapter,
} from "../server/integrations/adapters/cloudflare";
import type { AuditLog } from "../server/cloudflare";
import { fenceExternal, outboundRefusal, type InboundEnvelope } from "../shared/integrations";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const R = native.Response;
const TOKEN = "cfat_FAKEtokenFAKEtokenFAKEtokenFAKEtoken654321";
const ACCT = "acct0000000000000000000000000002";

type Dep = { id: string; created_on: string; author_email?: string; source?: string; versions?: { version_id: string; percentage: number }[]; annotations?: Record<string, string> };
let scripts: { id: string; created_on: string; modified_on: string }[] = [];
let deployments: Record<string, Dep[]> = {};
let domains: { id: string; hostname: string; service: string; zone_name?: string }[] = [];
let audit: AuditLog[] = [];
let totals: { requests: number; errors: number; name: string }[] = [];
let deny = new Set<string>();
let auditQueries: URLSearchParams[] = [];
let server: ReturnType<typeof Bun.serve>;
const ok = (result: unknown, extra: Record<string, unknown> = {}) => R.json({ success: true, errors: [], result, ...extra });

beforeAll(() => {
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/client\/v4/, "");
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return R.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 401 });
      if (deny.has(path)) return R.json({ success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }] }, { status: 403 });
      const a = `/accounts/${ACCT}`;
      if (path === a) return ok({ id: ACCT, name: "Test account" });
      if (path === `${a}/workers/scripts`) return ok(scripts);
      const dep = path.match(/^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/deployments$/);
      if (dep) return ok({ deployments: deployments[decodeURIComponent(dep[1]!)] ?? [] });
      if (path === `${a}/workers/domains`) return ok(domains);
      if (path === `${a}/audit_logs`) {
        auditQueries.push(url.searchParams);
        const since = Date.parse(url.searchParams.get("since") ?? ""), before = Date.parse(url.searchParams.get("before") ?? "");
        return ok(audit.filter((l) => Date.parse(l.when!) >= since && Date.parse(l.when!) <= before), { result_info: { total_pages: 1 } });
      }
      if (path === "/graphql") return R.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: totals.map((t) => ({ sum: { requests: t.requests, errors: t.errors, subrequests: 0 }, quantiles: {}, dimensions: { scriptName: t.name } })) }] } } });
      return R.json({ success: false, errors: [{ code: 7003, message: `no route ${path}` }] }, { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  scripts = [{ id: "edge-api", created_on: "2026-01-01T00:00:00Z", modified_on: "2026-10-01T00:00:00Z" }];
  deployments = { "edge-api": [{ id: "dep-1", created_on: "2026-10-01T00:00:00Z", author_email: "dev@example.com", source: "wrangler" }] };
  domains = [{ id: "d1", hostname: "api.example.com", service: "edge-api", zone_name: "example.com" }];
  audit = []; totals = []; deny = new Set(); auditQueries = [];
});

const base = () => `http://127.0.0.1:${server.port}/client/v4`;
const T0 = Date.parse("2026-10-24T12:00:00Z");
const conn = (config: Record<string, unknown> = {}): Connection => ({ id: "cf", kind: "cloudflare", name: "Cloudflare", instance: "*", config: { accountId: ACCT, ...config }, enabled: true });

/** A context with the cursor in memory, and every envelope the adapter hands in. */
function fakeCtx(cursor: { v?: string } = {}) {
  const ingested: InboundEnvelope[] = [];
  const statuses: { ok: boolean; detail?: string }[] = [];
  const abort = new AbortController();
  const ctx: AdapterContext = {
    connection: conn(), secret: () => TOKEN,
    ingest: async (e) => { ingested.push(e); return "new"; },
    cursor: { get: async () => cursor.v, set: async (v) => { cursor.v = v; } },
    status: async (s) => { statuses.push(s); }, log: () => {}, signal: abort.signal,
  };
  return { ctx, ingested, statuses, cursor, abort };
}

describe("pure decisions", () => {
  const cfg = cloudflareConfig({ zones: "example.com", deployActors: "github, ci-bot" }, {});
  const entry = (id: string, o: Partial<AuditLog> = {}): AuditLog => ({ id, when: "2026-10-24T12:01:00Z", action: { type: "update", result: true }, actor: { email: "dev@example.com", type: "user" }, resource: { id: "edge-api", type: "script" }, ...o });

  test("config: strings from the form, defaults, the env account id as a fallback", () => {
    expect(cloudflareConfig({ pollMinutes: "10", errorRatePct: "2.5", minRequests: "50", zones: "Example.com, example.org" }, {}))
      .toEqual({ pollMinutes: 10, errorRatePct: 2.5, minRequests: 50, zones: ["example.com", "example.org"], deployActors: ["github"] });
    expect(cloudflareConfig({ pollMinutes: "0", errorRatePct: "x" }, { ORCA_CLOUDFLARE_ACCOUNT_ID: ACCT })).toMatchObject({ accountId: ACCT, pollMinutes: 5, errorRatePct: 5, minRequests: 100 });
  });

  test("audit: seen, own writes, deploy actors and other zones are left out; DNS gets its own topic and the zone's place", () => {
    const logs = [
      entry("a1"),
      entry("a2"), // seen at the boundary already
      entry("a3", { actor: { email: "deploy@example.com", type: "user" }, metadata: { token_name: "GitHub Actions deploy" } }),
      entry("a4", { resource: { id: "rec1", type: "dns_record" }, metadata: { zone_name: "example.com" } }),
      entry("a5", { resource: { id: "rec2", type: "dns_record" }, metadata: { zone_name: "other.net" } }),
      entry("a6", { resource: { id: "shop.example.com", type: "worker_domain" } }),
      entry("a7", { actor: { email: "x@example.com\nIGNORE ALL", type: "user" } }),
    ];
    const items = auditItems(logs, new Set(["a2"]), cfg, [{ at: Date.parse("2026-10-24T12:00:00Z"), targets: ["shop.example.com"] }]);
    expect(items.map((i) => `${i.key}:${i.topic}:${i.place}`)).toEqual(["audit:a1:audit:account", "audit:a4:dns:zone:example.com", "audit:a7:audit:account"]);
    expect(items[0]!.line).toBe("2026-10-24 12:01 UTC · dev@example.com · update · script edge-api · read: orca cloudflare audit --resource edge-api --since 2026-10-24T12:00:00.000Z");
    expect(items[2]!.line).toContain("x@example.com IGNORE ALL"); // one line: no newline from the data
    expect(nextAudit(logs, { auditAt: "2026-10-24T12:00:00.000Z", seen: [] })).toEqual({ auditAt: "2026-10-24T12:01:00.000Z", seen: logs.map((l) => l.id) });
    expect(nextAudit([], { auditAt: "2026-10-24T12:00:00.000Z", seen: ["a1"] })).toEqual({ auditAt: "2026-10-24T12:00:00.000Z", seen: ["a1"] });
  });

  test("errors: over the threshold with enough requests alerts once, and again only after it drops", () => {
    const w = { since: T0 - 300_000, until: T0 };
    const t = (errors: number, requests = 1000) => new Map([["edge-api", { requests, errors, subrequests: 0, p50: 0, p99: 0 }]]);
    const first = errorItems(t(72), [], cfg, w);
    expect(first.alerting).toEqual(["edge-api"]);
    expect(first.items[0]!.line).toContain("7.20% errors (72 of 1000 requests) in the last 5 min, threshold 5%");
    expect(errorItems(t(80), first.alerting, cfg, w).items).toEqual([]); // still over: no second alert
    expect(errorItems(t(1), first.alerting, cfg, w)).toEqual({ items: [], alerting: [] });
    expect(errorItems(t(9, 10), [], cfg, w).items).toEqual([]); // 90% of 10 requests is under minRequests
  });

  test("batches: one envelope per topic and place, a stable key, the zone link's parent is the account", () => {
    const items = auditItems([entry("a1"), entry("a4", { resource: { id: "rec1", type: "dns_record" }, metadata: { zone_name: "example.com" } }), entry("a8")], new Set(), cfg, []);
    const envs = batchEnvelopes("cf", "Test account", items);
    expect(envs.map((e) => `${e.topic} ${e.source.channel} ${e.title}`)).toEqual([
      "ext.cloudflare.audit account Cloudflare: 2 audit-log entries", "ext.cloudflare.dns zone:example.com Cloudflare: 1 DNS change",
    ]);
    expect(envs[1]!.source.parents).toEqual(["account"]);
    expect(envs[0]!.text.split("\n")).toHaveLength(3);
    expect(batchEnvelopes("cf", "Test account", [...items].reverse())[0]!.key).toBe(envs[0]!.key);
    expect(envs[0]!.actor).toBeUndefined(); // a poller: the link's level is the grant
  });

  test("no posts: the adapter refuses a send, orca post is refused, and the fence says there is nobody to answer", async () => {
    const a = cloudflareAdapter(conn(), { env: {}, base: base() });
    expect(a.caps.outbound).toBe(false);
    expect(await a.send({ externalId: "*" }, { text: "hi" }, "k")).toMatchObject({ ok: false, retryable: false });
    expect(outboundRefusal("cloudflare", a.caps)).toContain("the cloudflare adapter takes no posts");
    expect(outboundRefusal("discord", { outbound: true })).toBeUndefined();
    const fence = fenceExternal({ text: "- a change", source: { adapter: "cloudflare", linkId: "cf-account" }, grant: { level: "ask", repos: [] }, display: { sender: "Cloudflare" } });
    expect(fence).toContain("from the cloudflare integration (a machine event) · grant: ask");
    expect(fence).toContain("There is no sender to answer");
    expect(fence).not.toContain("orca post --reply");
  });
});

describe("the poll loop", () => {
  const adapter = (o: { now: () => Date; own?: { at: number; targets: string[] }[] }) =>
    cloudflareAdapter(conn({ deployActors: "github", errorRatePct: "5", minRequests: "100" }), { env: {}, base: base(), now: o.now, ownWrites: async () => o.own ?? [] });

  test("baseline, then one envelope per topic; no repeat; a restart replays nothing; health names a missing permission", async () => {
    let now = new Date(T0);
    const f = fakeCtx();
    const a = adapter({ now: () => now, own: [{ at: T0 + 120_000, targets: ["orca-made"] }] }) as CloudflareAdapter;
    await a.start(f.ctx);
    await a.poll();
    expect(f.ingested).toEqual([]); // the first poll is the baseline: no history replayed
    expect(JSON.parse(f.cursor.v!)).toMatchObject({ v: 1, auditAt: new Date(T0).toISOString(), workers: { "edge-api": {} } });
    expect(f.statuses.at(-1)).toMatchObject({ ok: true, detail: "connected to Test account, 1 Workers watched" });

    // Five minutes of changes.
    now = new Date(T0 + 300_000);
    audit = [
      { id: "l1", when: "2026-10-24T12:01:00Z", action: { type: "delete", result: true }, actor: { email: "dev@example.com", type: "user" }, resource: { id: "rec1", type: "dns_record" }, metadata: { zone_name: "example.com" } },
      { id: "l2", when: "2026-10-24T12:02:00Z", action: { type: "update", result: true }, actor: { email: "ci@example.com", type: "user" }, resource: { id: "edge-api", type: "script" }, metadata: { token_name: "GitHub deploy" } },
      { id: "l3", when: "2026-10-24T12:02:30Z", action: { type: "create", result: true }, actor: { email: "dev@example.com", type: "user" }, resource: { id: "orca-made", type: "dns_record" } },
    ];
    scripts = [
      { id: "edge-api", created_on: "2026-01-01T00:00:00Z", modified_on: "2026-10-24T12:02:00Z" },
      { id: "new-api", created_on: "2026-10-24T12:03:00Z", modified_on: "2026-10-24T12:03:00Z" },
    ];
    deployments["edge-api"] = [{ id: "dep-2", created_on: "2026-10-24T12:02:00Z", author_email: "ci@example.com", source: "wrangler", versions: [{ version_id: "ver-2", percentage: 100 }] }, ...deployments["edge-api"]!];
    deployments["new-api"] = [{ id: "dep-n", created_on: "2026-10-24T12:03:00Z", author_email: "dev@example.com" }];
    domains = [{ id: "d2", hostname: "shop.example.com", service: "new-api", zone_name: "example.com" }];
    totals = [{ name: "edge-api", requests: 1000, errors: 90 }];
    await a.poll();
    const by = Object.fromEntries(f.ingested.map((e) => [`${e.topic} ${e.source.channel}`, e]));
    expect(Object.keys(by).sort()).toEqual([
      "ext.cloudflare.deploy account", "ext.cloudflare.dns zone:example.com", "ext.cloudflare.domain zone:example.com", "ext.cloudflare.errors account", "ext.cloudflare.worker account",
    ]);
    expect(by["ext.cloudflare.dns zone:example.com"]!.text).toContain("dev@example.com · delete · dns_record rec1 · read: orca cloudflare audit --resource rec1");
    expect(by["ext.cloudflare.dns zone:example.com"]!.text).not.toContain("orca-made"); // Orca's own write
    expect(f.ingested.some((e) => e.topic === "ext.cloudflare.audit")).toBe(false); // the CI token's entry is left out…
    expect(by["ext.cloudflare.deploy account"]!.text).toContain("ci@example.com · deploy · Worker edge-api · dep-2 via wrangler (ver-2 100%)"); // …its deploy is in the summary
    expect(by["ext.cloudflare.worker account"]!.text).toContain("new Worker · new-api");
    expect(by["ext.cloudflare.domain zone:example.com"]!.text).toContain("custom domain shop.example.com added → Worker new-api");
    expect(by["ext.cloudflare.domain zone:example.com"]!.text).toContain("custom domain api.example.com removed (was Worker edge-api)");
    expect(by["ext.cloudflare.errors account"]!.text).toContain("Worker edge-api · 9.00% errors (90 of 1000 requests)");
    expect(auditQueries.at(-1)!.get("since")).toBe(new Date(T0).toISOString());

    // Nothing new: nothing in, and the error alert does not fire twice.
    const count = f.ingested.length;
    now = new Date(T0 + 600_000);
    await a.poll();
    expect(f.ingested.length).toBe(count);
    expect(auditQueries.at(-1)!.get("since")).toBe("2026-10-24T12:02:30.000Z");

    // A restart (a new adapter on the same cursor) replays nothing; a rollback and a deleted Worker come in.
    await a.stop();
    const b = adapter({ now: () => now }) as CloudflareAdapter;
    const g = fakeCtx(f.cursor);
    await b.start(g.ctx);
    now = new Date(T0 + 900_000);
    scripts = [{ id: "edge-api", created_on: "2026-01-01T00:00:00Z", modified_on: "2026-10-24T12:12:00Z" }];
    deployments["edge-api"] = [{ id: "dep-3", created_on: "2026-10-24T12:12:00Z", author_email: "ops@example.com", annotations: { "workers/triggered_by": "rollback" } }, ...deployments["edge-api"]!];
    await b.poll();
    expect(g.ingested.map((e) => e.topic)).toEqual(["ext.cloudflare.worker"]);
    expect(g.ingested[0]!.text).toContain("ops@example.com · rollback · Worker edge-api · dep-3");
    expect(g.ingested[0]!.text).toContain("deleted Worker · new-api");

    // Health: connected, or the permission the token lacks.
    expect(await b.health()).toMatchObject({ ok: true, detail: "connected to Test account" });
    deny.add(`/accounts/${ACCT}`);
    expect((await b.health()).detail).toContain('the token lacks the "Account Settings Read" permission');
    deny.clear();
    deny.add(`/accounts/${ACCT}/audit_logs`);
    await b.poll();
    expect(g.statuses.at(-1)).toMatchObject({ ok: false });
    expect(g.statuses.at(-1)!.detail).toContain('audit log: Cloudflare refused GET /accounts/');
    expect(g.statuses.at(-1)!.detail).toContain('"Account Audit Logs Read"');
    await b.stop();
    expect((await cloudflareAdapter({ ...conn(), config: {} }, { env: {}, base: base() }).health()).detail).toBe("ORCA_SECRET_CLOUDFLARE is not set on this bridge");
  });
});

describe("with Postgres", () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE, ORCA_SECRET_CLOUDFLARE: process.env.ORCA_SECRET_CLOUDFLARE, ORCA_CLOUDFLARE_API: process.env.ORCA_CLOUDFLARE_API };
    process.env.ORCA_INSTANCE = "local";
    process.env.ORCA_SECRET_CLOUDFLARE = TOKEN;
    process.env.ORCA_CLOUDFLARE_API = base();
    pg = await freshSchema("cloudflare");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
  });
  afterEach(async () => {
    await registry.stopAll();
    await db.close();
    await pg.drop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test("Connect makes the Viewer link and the orchestrator's subscriptions; events pass the gate; the cursor is stored; orca cloudflare reads the integration", async () => {
    await admin.saveIntegration({ id: "cf", kind: "cloudflare", name: "Cloudflare", instance: "local", secretRef: "", config: { accountId: ACCT } });
    const row = await store.integration("cf");
    expect(row?.secretRef).toBe("ORCA_SECRET_CLOUDFLARE"); // the default when the form leaves it empty
    expect((await store.links()).map((l) => [l.id, l.externalId, l.level, l.requireMention])).toEqual([["cf-account", "*", "ask", false]]);
    const subs = await store.subscriptions();
    expect(subs.map((s) => [s.topicPattern, s.targetKind, s.digestSeconds ?? 0])).toEqual(DEFAULT_SUBSCRIPTIONS.map((d) => [d.topic, "orchestrator", d.digestSeconds ?? 0]));
    // An edit adds nothing back: a subscription you removed stays removed.
    await store.removeSubscription(subs[0]!.id);
    await admin.saveIntegration({ id: "cf", kind: "cloudflare", name: "Cloudflare", instance: "local", secretRef: "", config: { accountId: ACCT, pollMinutes: "60" } });
    expect((await store.subscriptions()).length).toBe(DEFAULT_SUBSCRIPTIONS.length - 1);

    expect(registry.runningIds()).toEqual(["cf"]);
    const a = registry.adapterFor("cf") as CloudflareAdapter;
    await a.poll(); // after the loop's own first poll: the baseline
    const state = JSON.parse((await store.cursor("cf"))!);
    expect(state).toMatchObject({ v: 1, workers: { "edge-api": {} } });
    // A domain change and an error spike: the gate gives them the link's level, the orchestrator gets them.
    await recordOwnWrite(["orca.example.com"], Date.now());
    expect((await readOwnWrites()).map((w) => w.targets)).toEqual([["orca.example.com"]]);
    expect(await store.cursor(OWN_WRITES_CURSOR)).toBeDefined();
    domains = [...domains, { id: "d3", hostname: "orca.example.com", service: "edge-api", zone_name: "example.com" }, { id: "d4", hostname: "shop.example.com", service: "edge-api", zone_name: "example.com" }];
    totals = [{ name: "edge-api", requests: 500, errors: 100 }];
    const r = await a.poll();
    expect(r.ingested).toBe(2);
    const events = (await store.deliveries()).map((d) => d.envelope);
    const domain = events.find((e) => e.topic === "ext.cloudflare.domain")!;
    expect(domain).toMatchObject({ source: { adapter: "cloudflare", channel: "zone:example.com", linkId: "cf-account" }, grant: { level: "ask", linkId: "cf-account" } });
    expect(domain.text).toContain("shop.example.com added");
    expect(domain.text).not.toContain("orca.example.com"); // Orca's own write, recorded in the database
    const targets = (await store.deliveries()).map((d) => `${d.envelope.topic}>${d.target.kind}`).sort();
    expect(targets).toEqual(["ext.cloudflare.domain>orchestrator", "ext.cloudflare.domain>web", "ext.cloudflare.errors>orchestrator", "ext.cloudflare.errors>web"]);
    // The same poll again: nothing new.
    expect((await a.poll()).ingested).toBe(0);
    expect(await connectedCredentials({ ORCA_SECRET_CLOUDFLARE: TOKEN })).toEqual({ token: TOKEN, account: ACCT });
    expect(await connectedCredentials({})).toEqual({ account: ACCT });
  });
});
