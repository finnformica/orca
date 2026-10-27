// `orca cloudflare …` (server/cloudflare.ts) against a fake Cloudflare API: a real HTTP server on
// loopback that answers the v4 REST routes and the GraphQL endpoint the module calls, and records
// every request. No real Cloudflare call; the token and account below are made up.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { CLOUDFLARE_ACCOUNT_ENV, CLOUDFLARE_TOKEN_ENV, PERMISSIONS, auditMatches, cloudflareTool, configAccountIds, isOwnWrite, parseSince, pickAccount, recordName } from "../server/cloudflare";
import { scrubbedEnv } from "../server/env";
import { CLOUDFLARE_VERBS, cloudflareVerb, grantRefusal, verbClass, type Grant } from "../shared/integrations";
import { orchestratorPrompt } from "../web/src/workstream";
import { native } from "./happydom";

const R = native.Response; // the fake answers with Bun's Response, not the DOM shim's

const TOKEN = "cfat_FAKEtokenFAKEtokenFAKEtokenFAKEtoken123456";
const ACCT = "acct0000000000000000000000000001";
const ZONE = "a".repeat(32);
// A second account on the same token (a studio), and a zone in a third account the token sees only by zone.
const ACCT2 = "acct0000000000000000000000000022";
const ZONE2 = "c".repeat(32);
const ACCOUNTS = [{ id: ACCT, name: "Finn's account" }, { id: ACCT2, name: "SMF Studio" }];
const ZONES = [
  { id: ZONE, name: "example.com", account: ACCOUNTS[0]! }, { id: "b".repeat(32), name: "example.org", account: ACCOUNTS[0]! },
  { id: ZONE2, name: "studio.net", account: ACCOUNTS[1]! }, { id: "d".repeat(32), name: "other.io", account: { id: "acct0000000000000000000000000033", name: "Other" } },
];
const NOW = new Date("2026-10-20T12:00:00Z");

type Seen = { method: string; path: string; query: URLSearchParams; auth: string | null; body: unknown };
let seen: Seen[] = [];
let deny = new Set<string>(); // paths answered 403, as a token without that permission gets
let routes: { id: string; pattern: string; script?: string }[] = [];
type Rec = { id: string; type: string; name: string; content: string; proxied: boolean; ttl: number };
let records: Rec[] = [];
let domainRows: { id: string; hostname: string; service: string; environment?: string; zone_name?: string; zone_id?: string }[] = [];
let server: ReturnType<typeof Bun.serve>;
const ok = (result: unknown, extra: Record<string, unknown> = {}) => R.json({ success: true, errors: [], messages: [], result, ...extra });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/client\/v4/, "");
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json();
      seen.push({ method: req.method, path, query: url.searchParams, auth: req.headers.get("authorization"), body });
      if (deny.has(path)) return R.json({ success: false, errors: [{ code: 10000, message: `Authentication error ${TOKEN}` }], result: null }, { status: 403 });
      const a = `/accounts/${ACCT}`, b = `/accounts/${ACCT2}`;
      if (path === "/accounts") return ok(ACCOUNTS, { result_info: { total_pages: 1 } });
      if (path === b) return ok({ id: ACCT2, name: "SMF Studio", created_on: "2025-02-03T00:00:00Z" });
      if (path === `${b}/workers/scripts` && req.method === "GET") return ok([{ id: "studio-site", created_on: "2026-05-01T00:00:00Z", modified_on: "2026-10-10T00:00:00Z" }]);
      if (path === `${b}/workers/domains` && req.method === "GET") return ok([]);
      if (path === `/zones/${ZONE2}/dns_records` && req.method === "GET") return ok([{ id: "s1", type: "A", name: "studio.net", content: "192.0.2.9", proxied: true, ttl: 1 }]
        .filter((r) => !url.searchParams.get("type") || r.type === url.searchParams.get("type")), { result_info: { total_pages: 1 } });
      if (path.startsWith(`${b}/`) && req.method === "GET") return ok([], { result_info: { total_pages: 1 } });
      const zoneById = path.match(/^\/zones\/([0-9a-f]{32})$/);
      if (zoneById) { const z = ZONES.find((x) => x.id === zoneById[1]); return z ? ok(z) : R.json({ success: false, errors: [{ code: 1001, message: "no zone" }] }, { status: 404 }); }
      if (path === a) return ok({ id: ACCT, name: "Finn's account", created_on: "2024-01-02T03:04:05Z" });
      if (path === `${a}/workers/scripts` && req.method === "GET") return ok([
        { id: "old-api", created_on: "2025-01-01T00:00:00Z", modified_on: "2025-02-01T00:00:00Z" },
        { id: "edge-api", created_on: "2026-03-01T10:00:00.123Z", modified_on: "2026-10-19T08:30:00Z", last_deployed_from: "wrangler" },
      ]);
      if (path === `${a}/workers/scripts/edge-api/deployments` && req.method === "GET") return ok({ deployments: [
        { id: "dep-2", created_on: "2026-10-19T08:30:00Z", source: "wrangler", author_email: "dev@example.com", strategy: "percentage", versions: [{ version_id: "ver-2", percentage: 100 }], annotations: { "workers/message": "ship it" } },
        { id: "dep-1", created_on: "2026-10-01T08:30:00Z", source: "dash", author_email: "ops@example.com", versions: [{ version_id: "ver-1", percentage: 100 }] },
      ] });
      if (path === `${a}/workers/scripts/edge-api/deployments` && req.method === "POST") return ok({ id: "dep-3" });
      if (path === `${a}/workers/scripts/edge-api/versions`) return ok({ items: [
        { id: "ver-2", number: 2, metadata: { author_email: "dev@example.com", created_on: "2026-10-19T08:29:00Z", source: "wrangler" }, annotations: { "workers/tag": "v2" } },
        { id: "ver-1", number: 1, metadata: { author_email: "ops@example.com", created_on: "2026-10-01T08:29:00Z", source: "dash" } },
      ] }, { result_info: { page: 1, total_pages: 1 } });
      if (path === `${a}/workers/scripts/edge-api/versions/ver-1`) return ok({ id: "ver-1", number: 1 });
      if (path.startsWith(`${a}/workers/scripts/edge-api/versions/`)) return R.json({ success: false, errors: [{ code: 10007, message: "version not found" }] }, { status: 404 });
      if (path === `${a}/workers/scripts/edge-api` && req.method === "DELETE") return ok(null);
      if (path === `${a}/workers/domains` && req.method === "GET") return ok(domainRows);
      if (path === `${a}/workers/domains` && req.method === "PUT") {
        const b = body as { hostname: string; service: string; zone_id: string };
        const d = { id: `d${domainRows.length + 1}`, ...b, zone_name: b.zone_id === ZONE ? "example.com" : "?" };
        domainRows.push(d);
        return ok(d);
      }
      if (path.startsWith(`${a}/workers/domains/`) && req.method === "DELETE") {
        domainRows = domainRows.filter((d) => d.id !== path.split("/").pop());
        return ok(null);
      }
      if (path === `${a}/pages/projects`) return ok([{ name: "site", domains: ["site.pages.dev", "www.example.com"], production_branch: "main", created_on: "2025-05-05T00:00:00Z", latest_deployment: { created_on: "2026-10-18T00:00:00Z", deployment_trigger: { metadata: { branch: "main", commit_hash: "abcdef1234567" } } } }], { result_info: { total_pages: 1 } });
      if (path === `${a}/r2/buckets`) return ok({ buckets: [{ name: "assets", creation_date: "2025-06-06T00:00:00Z", location: "WEUR" }] });
      if (path === `${a}/d1/database`) return ok([{ uuid: "db-uuid", name: "prod-db", created_at: "2025-07-07T00:00:00Z", num_tables: 4, file_size: 3 * 1024 * 1024 }], { result_info: { total_pages: 1 } });
      if (path === "/zones") {
        const name = url.searchParams.get("name"), account = url.searchParams.get("account.id");
        return ok(ZONES.filter((z) => (!name || z.name === name) && (!account || z.account.id === account)), { result_info: { total_pages: 1 } });
      }
      if (path === `/zones/${ZONE}/workers/routes` && req.method === "GET") return ok(routes);
      if (path === `/zones/${"b".repeat(32)}/workers/routes`) return ok([]);
      if (path === `/zones/${ZONE}/workers/routes` && req.method === "POST") {
        const r = { id: `route-${routes.length + 1}`, ...(body as { pattern: string; script: string }) };
        routes.push(r);
        return ok(r);
      }
      if (path.startsWith(`/zones/${ZONE}/workers/routes/`) && req.method === "DELETE") {
        routes = routes.filter((r) => r.id !== path.split("/").pop());
        return ok({ id: path.split("/").pop() });
      }
      if (path === `/zones/${ZONE}/dns_records` && req.method === "GET") return ok(records
        .filter((r) => !url.searchParams.get("type") || r.type === url.searchParams.get("type"))
        .filter((r) => !url.searchParams.get("name") || r.name === url.searchParams.get("name")), { result_info: { total_pages: 1 } });
      if (path === `/zones/${ZONE}/dns_records` && req.method === "POST") {
        const r = { id: `r${records.length + 1}`, ...(body as Omit<Rec, "id">) };
        records.push(r);
        return ok(r);
      }
      if (path.startsWith(`/zones/${ZONE}/dns_records/`) && req.method === "DELETE") {
        records = records.filter((r) => r.id !== path.split("/").pop());
        return ok({ id: path.split("/").pop() });
      }
      if (path === "/graphql") return R.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
        { sum: { requests: 900, errors: 9, subrequests: 50 }, quantiles: { cpuTimeP50: 1200, cpuTimeP99: 8000 }, dimensions: { scriptName: "edge-api" } },
        { sum: { requests: 100, errors: 1, subrequests: 0 }, quantiles: { cpuTimeP50: 1000, cpuTimeP99: 9000 }, dimensions: { scriptName: "edge-api" } },
        { sum: { requests: 10, errors: 0, subrequests: 0 }, quantiles: { cpuTimeP50: 500, cpuTimeP99: 700 }, dimensions: { scriptName: "old-api" } },
      ] }] } }, errors: null });
      if (path === `${a}/audit_logs`) {
        const logs = [
          { id: "l1", when: "2026-10-19T08:30:00Z", action: { type: "update", result: true }, actor: { email: "dev@example.com", type: "user" }, resource: { id: "edge-api", type: "script" }, interface: "API" },
          { id: "l2", when: "2026-10-18T08:30:00Z", action: { type: "delete", result: true }, actor: { email: "dev@example.com", type: "user" }, resource: { id: "r1", type: "dns_record" }, oldValue: "{\"name\":\"old.example.com\"}", interface: "UI" },
        ];
        const actor = url.searchParams.get("actor.email");
        return ok(logs.filter((l) => !actor || l.actor.email === actor), { result_info: { total_pages: 1 } });
      }
      return R.json({ success: false, errors: [{ code: 7003, message: `no route ${req.method} ${path}` }] }, { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen = []; deny = new Set(); routes = [{ id: "route-0", pattern: "api.example.com/*", script: "edge-api" }];
  records = [
    { id: "r1", type: "A", name: "example.com", content: "192.0.2.1", proxied: true, ttl: 1 },
    { id: "r2", type: "CNAME", name: "www.example.com", content: "example.com", proxied: false, ttl: 300 },
  ];
  domainRows = [{ id: "d1", hostname: "api.example.com", service: "edge-api", environment: "production", zone_name: "example.com" }];
});

const env = () => ({ [CLOUDFLARE_TOKEN_ENV]: TOKEN, [CLOUDFLARE_ACCOUNT_ENV]: ACCT });
const logs: string[] = [];
const wrote: { targets: string[]; at: number }[] = [];
const cf = (words: string[], flags: Record<string, unknown> = {}) =>
  cloudflareTool({ ...flags, _: words }, { env: env(), base: `http://127.0.0.1:${server.port}/client/v4`, now: () => NOW, log: (l) => logs.push(l), by: "test", onWrite: (targets, at) => wrote.push({ targets, at }) });
const writes = () => seen.filter((s) => s.method !== "GET" && s.path !== "/graphql");

test("a missing token names the variable and the doc; an account id is optional", async () => {
  await expect(cloudflareTool({ _: ["workers"] }, { env: {} })).rejects.toThrow(/connect the Cloudflare integration.*or set ORCA_SECRET_CLOUDFLARE and restart.*docs\/integrations\/cloudflare\.md/);
  expect(await cloudflareTool({ _: [] }, { env: {} })).toContain("orca cloudflare [--cf-account <name or id>] account | workers");
});

// ── One connection, many accounts ──
const many = (words: string[], flags: Record<string, unknown> = {}, o: { accounts?: string[] } = {}) =>
  cloudflareTool({ ...flags, _: words }, { env: { [CLOUDFLARE_TOKEN_ENV]: TOKEN }, ...o, base: `http://127.0.0.1:${server.port}/client/v4`, now: () => NOW, log: (l) => logs.push(l), by: "test" });

test("account ids: accountIds wins, accountId may be a list, none = every account; --cf-account matches a name or an id", () => {
  expect(configAccountIds({ accountId: ACCT })).toEqual([ACCT]);
  expect(configAccountIds({ accountId: ` ${ACCT}, ${ACCT2} ` })).toEqual([ACCT, ACCT2]);
  expect(configAccountIds({ accountId: ACCT, accountIds: [ACCT2] })).toEqual([ACCT2]);
  expect(configAccountIds({ accountId: "", accountIds: "" })).toEqual([]);
  expect(configAccountIds(undefined)).toEqual([]);
  expect(pickAccount(ACCOUNTS, "smf studio")?.id).toBe(ACCT2);
  expect(pickAccount(ACCOUNTS, ACCT.toUpperCase())?.id).toBe(ACCT);
  expect(pickAccount(ACCOUNTS, "nobody")).toBeUndefined();
});

test("one account named: no GET /accounts, no account label, no flag needed (the old config)", async () => {
  seen = [];
  const out = await cf(["workers"]);
  expect(out.startsWith("2 Workers")).toBe(true);
  expect(seen.some((x) => x.path === "/accounts")).toBe(false);
  expect(await cf(["workers"], { "cf-account": "Finn's account" })).toContain("edge-api"); // a name, read once from GET /accounts
  await expect(cf(["workers"], { "cf-account": "SMF Studio" })).rejects.toThrow(/"SMF Studio" is not an account of this connection/);
});

test("no account named: list reads show every account under its name; --cf-account narrows to one", async () => {
  const out = await many(["workers"]);
  expect(out).toContain(`Account Finn's account (${ACCT}):\n2 Workers`);
  expect(out).toContain(`Account SMF Studio (${ACCT2}):\n1 Workers`);
  expect(out.indexOf("edge-api")).toBeLessThan(out.indexOf("studio-site"));
  const zones = await many(["zones"]);
  expect(zones).toMatch(/Account SMF Studio[^\n]*\n1 zones:\n[\s\S]*studio\.net/);
  expect(zones.split("SMF Studio")[0]).not.toContain("studio.net");
  expect(await many(["account"])).toBe(`Account Finn's account (${ACCT}), created 2024-01-02 03:04.\nAccount SMF Studio (${ACCT2}), created 2025-02-03 00:00.`);
  // One account's refusal stays in its section.
  deny.add(`/accounts/${ACCT}/audit_logs`);
  const audit = await many(["audit"]);
  expect(audit).toContain('the token lacks the "Account Audit Logs Read" permission');
  expect(audit).toContain(`Account SMF Studio (${ACCT2}):\nNo audit-log entries`);
  // The flag: by name or id, no label; an unknown one names the accounts.
  const studio = await many(["workers"], { "cf-account": "smf studio" });
  expect(studio).toBe(studio.replace(/^Account /, "")); // no label
  expect(studio).toContain("studio-site");
  expect(studio).not.toContain("edge-api");
  expect(await many(["workers"], { "cf-account": ACCT })).not.toContain("studio-site");
  await expect(many(["workers"], { "cf-account": "nope" })).rejects.toThrow(`Its accounts: Finn's account (${ACCT}), SMF Studio (${ACCT2})`);
  // A config list covers exactly those accounts, named from GET /accounts.
  expect(await many(["workers"], {}, { accounts: [ACCT2, ACCT] })).toMatch(/^Account SMF Studio/);
});

test("no account named: a Worker read finds its account; rollback, delete and domain remove refuse and name the accounts", async () => {
  const dep = await many(["deployments", "edge-api"]);
  expect(dep).toStartWith(`Account Finn's account (${ACCT}):\n2 deployments of edge-api`);
  await expect(many(["versions", "ghost"])).rejects.toThrow('no Worker "ghost" in the accounts of this connection');
  seen = [];
  for (const [words, flags] of [[["rollback", "edge-api"], { version: "ver-1", confirm: "" }], [["delete", "edge-api"], { confirm: "" }], [["domain", "remove"], { hostname: "api.example.com", confirm: "" }]] as const) {
    await expect(many([...words], flags)).rejects.toThrow(`this connection covers 2 Cloudflare accounts: Finn's account (${ACCT}), SMF Studio (${ACCT2}). Pick one for "${words[0] === "domain" ? "domain remove" : words[0]}" with --cf-account <name or id>`);
  }
  expect(writes()).toEqual([]);
  expect(await many(["rollback", "edge-api"], { version: "ver-1", "cf-account": "Finn's account" })).toContain("Dry run, nothing changed. Roll back Worker edge-api");
  await expect(many(["rollback"])).rejects.toThrow("orca cloudflare rollback <worker> --version"); // the usage first
});

test("no account named: zone verbs find the account from the zone, by name or id; a zone of another account is refused", async () => {
  const dns = await many(["dns"], { zone: "studio.net" });
  expect(dns).toBe(`Account SMF Studio (${ACCT2}):\n1 DNS records on studio.net:\nTYPE  NAME        CONTENT    PROXY    TTL   COMMENT\nA     studio.net  192.0.2.9  proxied  auto`);
  expect(await many(["dns"], { zone: ZONE2 })).toContain("1 DNS records on");
  expect(await many(["routes"], { zone: "example.com" })).toMatch(/^Account Finn's account[\s\S]*api\.example\.com\/\*/);
  seen = [];
  const plan = await many(["dns", "add"], { zone: "studio.net", type: "TXT", name: "@", content: "hello" });
  expect(plan).toBe(`Account SMF Studio (${ACCT2}):\nDry run, nothing changed. Add DNS record TXT studio.net → hello (dns only, TTL auto) on zone studio.net.\nRun it again with --confirm to do it.`);
  expect(writes()).toEqual([]);
  await expect(many(["dns"], { zone: "other.io" })).rejects.toThrow(`zone other.io is in account Other, which this connection does not cover (Finn's account (${ACCT}), SMF Studio (${ACCT2}))`);
  await expect(many(["dns"], { zone: "nope.com" })).rejects.toThrow('no zone "nope.com" in the accounts of this connection');
  await expect(many(["dns", "add"], {})).rejects.toThrow("orca cloudflare dns add --zone"); // the usage first
  // domain add with no --zone: the account whose zone holds the hostname.
  const attach = await many(["domain", "add"], { worker: "studio-site", hostname: "www.studio.net" });
  expect(attach).toContain(`Account SMF Studio (${ACCT2}):\nDry run, nothing changed. Attach custom domain www.studio.net → Worker studio-site on zone studio.net.`);
  await expect(many(["domain", "add"], { worker: "studio-site", hostname: "www.nowhere.dev" })).rejects.toThrow("no zone in the accounts of this connection holds www.nowhere.dev");
});

test("workers list with created and modified dates, newest change first, with the bearer token", async () => {
  const out = await cf(["workers"]);
  expect(out).toContain("2 Workers");
  expect(out.indexOf("edge-api")).toBeLessThan(out.indexOf("old-api"));
  expect(out).toMatch(/edge-api\s+2026-03-01 10:00\s+2026-10-19 08:30\s+wrangler/);
  expect(seen[0]!.auth).toBe(`Bearer ${TOKEN}`);
  expect(seen[0]!.path).toBe(`/accounts/${ACCT}/workers/scripts`);
  expect(await cf(["account"])).toContain("Finn's account");
});

test("deployments and versions show author and source", async () => {
  const dep = await cf(["deployments", "edge-api"]);
  expect(dep).toMatch(/dep-2 \(active\)\s+2026-10-19 08:30\s+dev@example\.com\s+wrangler\s+ver-2 100%\s+ship it/);
  expect(dep).toContain("ops@example.com");
  const ver = await cf(["versions", "edge-api"]);
  expect(ver).toMatch(/ver-2\s+2\s+2026-10-19 08:29\s+dev@example\.com\s+wrangler\s+v2/);
  expect(ver).toMatch(/ver-1\s+1\s+.*ops@example\.com\s+dash/);
  await expect(cf(["versions"])).rejects.toThrow("orca cloudflare versions <worker>");
});

test("routes across zones, custom domains, Pages, R2, D1, zones and DNS", async () => {
  const r = await cf(["routes"]);
  expect(r).toMatch(/example\.com\s+api\.example\.com\/\*\s+edge-api\s+route-0/);
  expect(seen.filter((s) => s.path.endsWith("/workers/routes")).length).toBe(2); // both zones
  expect(seen.find((s) => s.path === "/zones")!.query.get("account.id")).toBe(ACCT);
  expect(await cf(["domains"])).toMatch(/api\.example\.com\s+edge-api\s+production\s+example\.com/);
  expect(await cf(["pages"])).toMatch(/site\s+site\.pages\.dev, www\.example\.com\s+main\s+2025-05-05 00:00\s+2026-10-18 00:00 main@abcdef1/);
  expect(await cf(["r2"])).toMatch(/assets\s+2025-06-06 00:00\s+WEUR/);
  expect(await cf(["d1"])).toMatch(/prod-db\s+db-uuid\s+2025-07-07 00:00\s+4\s+3\.0 MB/);
  expect(await cf(["zones"])).toContain("example.org");
  seen = [];
  const dns = await cf(["dns"], { zone: "example.com", type: "cname" });
  expect(dns).toContain("1 DNS records on example.com");
  expect(dns).toMatch(/CNAME\s+www\.example\.com\s+example\.com\s+dns only\s+300/);
  expect(seen.find((s) => s.path === "/zones")!.query.get("name")).toBe("example.com");
  expect(seen.find((s) => s.path.endsWith("/dns_records"))!.query.get("type")).toBe("CNAME");
  await expect(cf(["dns"])).rejects.toThrow("--zone");
  await expect(cf(["dns"], { zone: "nope.com" })).rejects.toThrow('no zone "nope.com"');
});

test("analytics sums each Worker over the window from one GraphQL query", async () => {
  const out = await cf(["analytics"], { since: "6h" });
  const q = seen.find((s) => s.path === "/graphql")!;
  expect(q.method).toBe("POST");
  const vars = (q.body as { variables: Record<string, string> }).variables;
  expect(vars).toEqual({ accountTag: ACCT, since: "2026-10-20T06:00:00.000Z", until: NOW.toISOString() });
  expect(out).toContain("1010 requests, 10 errors (0.99%)");
  expect(out).toMatch(/edge-api\s+1000\s+10\s+1\.00%\s+50\s+1\.2 ms\s+9\.0 ms/);
  expect(await cf(["analytics"], { worker: "old-api" })).not.toContain("edge-api  ");
});

test("audit search filters by actor (Cloudflare), resource name (here) and time", async () => {
  const all = await cf(["audit"], { actor: "dev@example.com", since: "3d" });
  const q = seen.find((s) => s.path.endsWith("/audit_logs"))!.query;
  expect(q.get("actor.email")).toBe("dev@example.com");
  expect(q.get("since")).toBe("2026-10-17T12:00:00.000Z");
  expect(q.get("before")).toBe(NOW.toISOString());
  expect(all).toContain("2 audit-log entries");
  const one = await cf(["audit"], { resource: "old.example.com" });
  expect(one).toContain("1 audit-log entries");
  expect(one).toMatch(/2026-10-18 08:30\s+dev@example\.com\s+delete\s+dns_record r1\s+UI/);
  expect(await cf(["audit"], { resource: "missing" })).toContain('No audit-log entries for "missing"');
  expect(auditMatches({ id: "x", resource: { id: "Edge-API" } }, "edge-api")).toBe(true);
  expect(parseSince("2026-10-01T00:00:00Z", NOW).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  expect(() => parseSince("yesterday", NOW)).toThrow("bad time");
});

test("a refusal names the missing permission and never echoes the token", async () => {
  deny.add(`/accounts/${ACCT}/audit_logs`);
  const err = await cf(["audit"]).catch((e: Error) => e.message);
  expect(err).toContain(`the token lacks the "${PERMISSIONS.audit}" permission`);
  expect(err).toContain("docs/integrations/cloudflare.md");
  expect(err).not.toContain(TOKEN);
  deny.add(`/zones/${ZONE}/workers/routes`);
  expect(await cf(["route", "add"], { zone: "example.com", pattern: "x.example.com/*", worker: "edge-api", confirm: "" }).catch((e: Error) => e.message)).toContain(`"${PERMISSIONS.routes}"`);
});

test("rollback: a dry run changes nothing, --confirm deploys the version at 100% and is logged", async () => {
  logs.length = 0;
  const plan = await cf(["rollback", "edge-api"], { version: "ver-1" });
  expect(plan).toContain("Dry run, nothing changed. Roll back Worker edge-api to version ver-1 (#1)");
  expect(writes()).toEqual([]);
  await expect(cf(["rollback", "edge-api"], { version: "ver-9", confirm: "" })).rejects.toThrow("version not found");
  expect(writes()).toEqual([]);
  const done = await cf(["rollback", "edge-api"], { version: "ver-1", confirm: "", message: "bad deploy" });
  expect(done).toBe("Rolled back edge-api to version ver-1 (deployment dep-3).");
  expect(writes()).toEqual([expect.objectContaining({ method: "POST", path: `/accounts/${ACCT}/workers/scripts/edge-api/deployments`, body: { strategy: "percentage", versions: [{ version_id: "ver-1", percentage: 100 }], annotations: { "workers/message": "bad deploy" } } })]);
  expect(logs).toEqual([`[cloudflare] ${NOW.toISOString()} test: rollback edge-api to ver-1 → ok`]);
});

test("delete: dry run, unknown Worker, then a confirmed delete; a refused delete is logged as failed", async () => {
  logs.length = 0;
  expect(await cf(["delete", "edge-api"])).toContain("Delete Worker edge-api (created 2026-03-01 10:00");
  await expect(cf(["delete", "ghost"], { confirm: "" })).rejects.toThrow('no Worker "ghost"');
  expect(writes()).toEqual([]);
  expect(await cf(["delete", "edge-api"], { confirm: "" })).toBe("Deleted Worker edge-api.");
  expect(writes().map((w) => `${w.method} ${w.path}`)).toEqual([`DELETE /accounts/${ACCT}/workers/scripts/edge-api`]);
  deny.add(`/accounts/${ACCT}/workers/scripts/edge-api`);
  const err = await cf(["delete", "edge-api"], { confirm: "" }).catch((e: Error) => e.message);
  expect(err).toContain(`"${PERMISSIONS.scriptsEdit}"`);
  expect(logs[0]).toContain("test: delete edge-api → ok");
  expect(logs[1]).toMatch(/delete edge-api → failed: .*Workers Scripts Edit/);
});

test("route add and remove, each behind --confirm", async () => {
  const add = { zone: "example.com", pattern: "new.example.com/*", worker: "edge-api" };
  expect(await cf(["route", "add"], add)).toContain("Add route new.example.com/* → Worker edge-api on zone example.com.");
  expect(writes()).toEqual([]);
  expect(await cf(["route", "add"], { ...add, confirm: "" })).toBe("Added route new.example.com/* → edge-api on example.com (id route-2).");
  expect(writes()[0]).toMatchObject({ method: "POST", path: `/zones/${ZONE}/workers/routes`, body: { pattern: "new.example.com/*", script: "edge-api" } });
  await expect(cf(["route", "add"], { ...add, confirm: "" })).rejects.toThrow("already exists");
  seen = [];
  expect(await cf(["route", "remove"], { zone: ZONE, pattern: "api.example.com/*" })).toContain("Remove route api.example.com/* → edge-api (id route-0)");
  expect(writes()).toEqual([]);
  expect(await cf(["route", "remove"], { zone: ZONE, id: "route-0", confirm: "" })).toBe(`Removed route api.example.com/* from ${ZONE}.`);
  expect(writes().map((w) => `${w.method} ${w.path}`)).toEqual([`DELETE /zones/${ZONE}/workers/routes/route-0`]);
  await expect(cf(["route", "remove"], { zone: ZONE, id: "route-0", confirm: "" })).rejects.toThrow("no route route-0");
});

test("an outside sender's wake may read Cloudflare but never write; your own chat may do both", () => {
  const ask: Grant = { level: "ask", repos: [] } as unknown as Grant;
  const admin: Grant = { level: "admin", repos: ["orca"] } as unknown as Grant;
  expect(grantRefusal(ask, "cloudflare", { _: ["workers"] })).toBeUndefined();
  expect(grantRefusal(ask, "cloudflare", { _: ["audit"] })).toBeUndefined();
  expect(grantRefusal(ask, "cloudflare", { _: ["dns"], zone: "example.com" })).toBeUndefined(); // bare dns is the read
  expect(grantRefusal(ask, "cloudflare", { _: ["domains"] })).toBeUndefined();
  for (const words of [["rollback", "w"], ["delete", "w"], ["route", "add"], ["route", "remove"], ["domain", "add"], ["domain", "remove"], ["dns", "add"], ["dns", "remove"]]) {
    expect(grantRefusal(admin, "cloudflare", { _: words, confirm: "" })).toContain("needs your own chat");
    expect(grantRefusal(undefined, "cloudflare", { _: words, confirm: "" })).toBeUndefined();
  }
  expect(grantRefusal({ level: "notify", repos: [] } as unknown as Grant, "cloudflare", { _: ["workers"] })).toContain("refused");
});

test("agents never see the token or the account id; the orchestrator's help lists the commands", () => {
  const saved = { t: process.env[CLOUDFLARE_TOKEN_ENV], a: process.env[CLOUDFLARE_ACCOUNT_ENV] };
  process.env[CLOUDFLARE_TOKEN_ENV] = TOKEN;
  process.env[CLOUDFLARE_ACCOUNT_ENV] = ACCT;
  try {
    const e = scrubbedEnv();
    expect(e[CLOUDFLARE_TOKEN_ENV]).toBeUndefined();
    expect(e[CLOUDFLARE_ACCOUNT_ENV]).toBeUndefined();
  } finally {
    for (const [k, v] of [[CLOUDFLARE_TOKEN_ENV, saved.t], [CLOUDFLARE_ACCOUNT_ENV, saved.a]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const help = orchestratorPrompt({ fresh: false, board: "(empty)", messages: ["hi"] });
  for (const c of ["orca cloudflare <read>", "orca cloudflare rollback <worker> --version", "orca cloudflare delete <worker>", "orca cloudflare route add", "orca cloudflare route remove",
    "orca cloudflare domain add --worker", "orca cloudflare domain remove", "orca cloudflare dns add --zone", "orca cloudflare dns remove --zone"]) expect(help).toContain(c);
});

test("the connected integration's token and account win; the environment is the fallback", async () => {
  const base = `http://127.0.0.1:${server.port}/client/v4`;
  expect(await cloudflareTool({ _: ["account"] }, { env: {}, token: TOKEN, account: ACCT, base })).toContain("Finn's account");
  expect(seen.at(-1)!.auth).toBe(`Bearer ${TOKEN}`);
  expect(await cloudflareTool({ _: ["account"] }, { env: env(), token: "", base })).toContain("Finn's account");
  const err = await cloudflareTool({ _: ["account"] }, { env: {} }).catch((e: Error) => e.message);
  expect(err).toContain("connect the Cloudflare integration");
});

test("domain add checks the Worker, the hostname and a CNAME, then attaches it behind --confirm; remove detaches it", async () => {
  logs.length = 0; wrote.length = 0;
  const add = { worker: "edge-api", hostname: "shop.example.com" };
  const plan = await cf(["domain", "add"], add);
  expect(plan).toContain("Dry run, nothing changed. Attach custom domain shop.example.com → Worker edge-api on zone example.com.");
  expect(writes()).toEqual([]);
  await expect(cf(["domain", "add"], { ...add, worker: "ghost", confirm: "" })).rejects.toThrow('no Worker "ghost"');
  await expect(cf(["domain", "add"], { ...add, hostname: "api.example.com", confirm: "" })).rejects.toThrow("already a custom domain of Worker edge-api");
  await expect(cf(["domain", "add"], { ...add, hostname: "www.example.com", confirm: "" })).rejects.toThrow("has a CNAME record");
  await expect(cf(["domain", "add"], { ...add, hostname: "x.nowhere.net" })).rejects.toThrow("no zone in this account holds x.nowhere.net");
  await expect(cf(["domain", "add"], { ...add, zone: "example.org" })).rejects.toThrow("not in zone example.org");
  expect(writes()).toEqual([]);
  expect(await cf(["domain", "add"], { ...add, confirm: "" })).toBe("Attached shop.example.com → edge-api (id d2).");
  expect(writes()).toEqual([expect.objectContaining({ method: "PUT", path: `/accounts/${ACCT}/workers/domains`, body: { hostname: "shop.example.com", service: "edge-api", zone_id: ZONE } })]);
  expect(logs).toEqual([`[cloudflare] ${NOW.toISOString()} test: domain add shop.example.com → edge-api on example.com → ok`]);
  expect(wrote).toEqual([{ targets: ["shop.example.com"], at: NOW.getTime() }]);
  seen = [];
  expect(await cf(["domain", "remove"], { hostname: "shop.example.com" })).toContain("Detach custom domain shop.example.com from Worker edge-api (id d2)");
  expect(writes()).toEqual([]);
  expect(await cf(["domain", "remove"], { id: "d2", confirm: "" })).toBe("Detached shop.example.com from edge-api.");
  expect(writes().map((w) => `${w.method} ${w.path}`)).toEqual([`DELETE /accounts/${ACCT}/workers/domains/d2`]);
  await expect(cf(["domain", "remove"], { id: "d2", confirm: "" })).rejects.toThrow("no custom domain d2");
  deny.add(`/accounts/${ACCT}/workers/domains`);
  expect(await cf(["domain", "remove"], { id: "d1", confirm: "" }).catch((e: Error) => e.message)).toContain(`"${PERMISSIONS.scripts}"`);
});

test("dns add and remove: full names, CNAME and duplicate checks, --confirm, DNS Edit named on a refusal", async () => {
  logs.length = 0; wrote.length = 0;
  expect(recordName("@", "example.com")).toBe("example.com");
  expect(recordName("Shop", "example.com")).toBe("shop.example.com");
  expect(recordName("shop.example.com.", "example.com")).toBe("shop.example.com");
  const add = { zone: "example.com", type: "a", name: "shop", content: "192.0.2.7" };
  expect(await cf(["dns", "add"], add)).toContain("Add DNS record A shop.example.com → 192.0.2.7 (dns only, TTL auto) on zone example.com.");
  expect(writes()).toEqual([]);
  await expect(cf(["dns", "add"], { ...add, name: "@", content: "192.0.2.1", confirm: "" })).rejects.toThrow("A example.com → 192.0.2.1 already exists (id r1)");
  await expect(cf(["dns", "add"], { ...add, name: "www", confirm: "" })).rejects.toThrow("already has a CNAME record");
  await expect(cf(["dns", "add"], { ...add, type: "CNAME", name: "@", content: "x.example.net", confirm: "" })).rejects.toThrow("a CNAME cannot share a name");
  await expect(cf(["dns", "add"], { ...add, ttl: "5" })).rejects.toThrow("--ttl");
  await expect(cf(["dns", "add"], { ...add, zone: ZONE })).rejects.toThrow("zone NAME");
  expect(writes()).toEqual([]);
  expect(await cf(["dns", "add"], { ...add, proxied: "", ttl: "300", comment: "shop", confirm: "" })).toBe("Added A shop.example.com → 192.0.2.7 on example.com (id r3).");
  expect(writes()[0]).toMatchObject({ method: "POST", path: `/zones/${ZONE}/dns_records`, body: { type: "A", name: "shop.example.com", content: "192.0.2.7", proxied: true, ttl: 300, comment: "shop" } });
  expect(logs[0]).toContain("test: dns add A shop.example.com → 192.0.2.7 on example.com → ok");
  expect(wrote[0]!.targets).toEqual(["shop.example.com"]);
  seen = [];
  expect(await cf(["dns", "remove"], { zone: "example.com", id: "r3" })).toContain("Remove DNS record A shop.example.com → 192.0.2.7 (id r3) from zone example.com.");
  expect(writes()).toEqual([]);
  await expect(cf(["dns", "remove"], { zone: "example.com", id: "r9", confirm: "" })).rejects.toThrow("no DNS record r9");
  deny.add(`/zones/${ZONE}/dns_records/r3`);
  expect(await cf(["dns", "remove"], { zone: "example.com", id: "r3", confirm: "" }).catch((e: Error) => e.message)).toContain(`"${PERMISSIONS.dnsEdit}"`);
  deny.clear();
  expect(await cf(["dns", "remove"], { zone: "example.com", id: "r3", confirm: "" })).toBe("Removed A shop.example.com from example.com.");
  // No command uploads Worker code: the usage says where new Workers come from.
  expect(await cloudflareTool({ _: ["help"] })).toContain("No command uploads Worker code");
  expect(isOwnWrite('{"name":"shop.example.com"}', NOW.getTime() + 60_000, wrote)).toBe(true);
  expect(isOwnWrite('{"name":"shop.example.com"}', NOW.getTime() + 3_600_000, wrote)).toBe(false);
});

test("one table classifies every verb read or write; the grant check follows it; an unknown verb fails closed", async () => {
  // Every subcommand the tool dispatches is in the table, alone or as "subcommand action".
  const src = await Bun.file(new URL("../server/cloudflare.ts", import.meta.url)).text();
  const tool = src.slice(src.indexOf("export async function cloudflareTool"));
  const cases = [...tool.matchAll(/case "([a-z0-9]+)":/g)].map((m) => m[1]!);
  expect(cases.length).toBeGreaterThan(10);
  for (const c of cases) expect(Object.keys(CLOUDFLARE_VERBS).some((k) => k === c || k.startsWith(`${c} `))).toBe(true);
  expect(Object.entries(CLOUDFLARE_VERBS).filter(([, a]) => a === "write").map(([k]) => k).sort()).toEqual(
    ["delete", "dns add", "dns remove", "domain add", "domain remove", "rollback", "route add", "route remove"]);
  const ask: Grant = { level: "ask", repos: [] } as unknown as Grant;
  for (const [verb, access] of Object.entries(CLOUDFLARE_VERBS)) {
    const refusal = grantRefusal(ask, "cloudflare", { _: verb.split(" ") });
    if (access === "read") expect(refusal).toBeUndefined();
    else expect(refusal).toContain(`"cloudflare ${verb}" needs your own chat`);
  }
  const cls = (words: string[]) => [cloudflareVerb(words), verbClass(cloudflareVerb(words), CLOUDFLARE_VERBS)];
  expect(cls(["dns"])).toEqual(["dns", "read"]);
  expect(cls(["dns", "remove"])).toEqual(["dns remove", "write"]);
  expect(cls(["domain", "add"])).toEqual(["domain add", "write"]);
  expect(cls(["domain"])).toEqual(["domain", "write"]); // not in the table: a write
  expect(cls(["purge", "all"])).toEqual(["purge", "write"]);
  // Every write is still a dry run without --confirm.
  expect(await cf(["dns", "add"], { zone: "example.com", type: "TXT", name: "t", content: "x" })).toStartWith("Dry run, nothing changed.");
  expect(writes()).toEqual([]);
});
