// `orca cloudflare …`: the orchestrator's read access and limited write access to one Cloudflare
// account (docs/integrations/cloudflare.md). The bridge calls Cloudflare; `bin/orca` only talks to
// the bridge, like every other verb. The token and the account id come from the connected
// Cloudflare integration (server/integrations/adapters/cloudflare.ts: the variable its secret_ref
// names, default `ORCA_SECRET_CLOUDFLARE`, and `config.accountId`), else from the environment:
// `ORCA_SECRET_CLOUDFLARE` and `ORCA_CLOUDFLARE_ACCOUNT_ID`. The `ORCA_SECRET_` prefix means
// `scrubbedEnv` drops the token from every spawn, so no agent run sees it; it is never printed or
// logged. The account id is in env.ts ORCA_SECRETS, so agents don't get it either.
//
// Writes are a dry run unless `--confirm`, and each confirmed one is logged (who, what, when, the
// result): roll a Worker back to a version, delete a Worker, add or remove a Worker route, attach or
// detach a Worker custom domain, add or remove a DNS record. There is deliberately NO upload of
// Worker code: new Workers come from the repos' deploy pipelines.
// A 401/403 names the token permission that call needs, so the fix is one edit in the dashboard.
// The account watcher (server/cloudflareWatch.ts) reuses this client.

export const CLOUDFLARE_TOKEN_ENV = "ORCA_SECRET_CLOUDFLARE";
export const CLOUDFLARE_ACCOUNT_ENV = "ORCA_CLOUDFLARE_ACCOUNT_ID";
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const DOC = "docs/integrations/cloudflare.md";
const TIMEOUT_MS = 30_000;
const MAX_PAGES = 20;

type Env = Record<string, string | undefined>;
export type CloudflareOpts = {
  env?: Env; base?: string; fetch?: typeof fetch; log?: (line: string) => void; now?: () => Date;
  /** From the connected integration; each falls back to the environment when absent. */
  token?: string; account?: string;
  /** Called after each confirmed write with the names and ids it touched, so the account watcher
   *  can leave Orca's own changes out (`isOwnWrite`). */
  onWrite?: (targets: string[], at: number) => unknown;
};
type Args = Record<string, unknown> & { _?: unknown[] };

/** The token permission each call needs, as the dashboard names it (the doc lists them all). */
export const PERMISSIONS = {
  account: "Account Settings Read",
  scripts: "Workers Scripts Read",
  scriptsEdit: "Workers Scripts Edit",
  routes: "Workers Routes Read",
  routesEdit: "Workers Routes Edit",
  pages: "Cloudflare Pages Read",
  r2: "Workers R2 Storage Read",
  d1: "D1 Read",
  dns: "DNS Read",
  dnsEdit: "DNS Edit",
  analytics: "Account Analytics Read",
  audit: "Account Audit Logs Read",
} as const;
type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// Which subcommands read and which write is ONE table, shared/integrations.ts CLOUDFLARE_VERBS: the
// grant check reads it (a write needs the owner's own chat), and every write here also needs --confirm.

export class CloudflareError extends Error {}

/** Upstream text with the token (and anything token-shaped) masked. Pure. */
export function redact(text: string, token: string): string {
  let out = token ? text.split(token).join("[redacted]") : text;
  out = out.replace(/\b(?:cfat_|cfut_)?[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
  return out.slice(0, 400);
}

/** `24h`, `7d`, `30m` back from now, or an ISO time. Pure. */
export function parseSince(v: unknown, now: Date, fallback = "24h"): Date {
  const s = typeof v === "string" && v.trim() ? v.trim() : fallback;
  const m = /^(\d+)\s*([mhd])$/.exec(s);
  if (m) return new Date(now.getTime() - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"]);
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) throw new CloudflareError(`bad time "${s}": use 30m, 24h, 7d or an ISO time`);
  return t;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const day = (iso: unknown): string => (typeof iso === "string" && iso ? iso.replace("T", " ").replace(/\.\d+Z$|Z$/, "").slice(0, 16) : "—");
const table = (rows: string[][]): string => {
  if (!rows.length) return "";
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]!))).join("  ").trimEnd()).join("\n");
};

type CfError = { code?: number; message?: string };
type CfBody = { success?: boolean; errors?: CfError[]; result?: unknown; result_info?: { page?: number; total_pages?: number; cursor?: string } };

export class Client {
  constructor(private token: string, readonly account: string, private base: string, private f: typeof fetch) {}

  /** One call. A refusal names `perm`; any other failure carries Cloudflare's own message. */
  async call(method: string, path: string, perm: Permission, body?: unknown): Promise<CfBody> {
    const url = path.startsWith("http") ? path : `${this.base}${path}`;
    let res: Response;
    try {
      // A timer race, not an AbortSignal: the test DOM shim swaps that global (as in health.ts).
      let timer: ReturnType<typeof setTimeout> | undefined;
      res = await Promise.race([
        this.f(url, {
          method,
          headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(timer));
    } catch (e) {
      throw new CloudflareError(`Cloudflare did not answer ${method} ${path}: ${redact((e as Error).message, this.token)}`);
    }
    const data = (await res.json().catch(() => ({}))) as CfBody & { data?: unknown };
    const errs = (data.errors ?? []).map((e) => `${e.code ? `${e.code} ` : ""}${e.message ?? ""}`.trim()).filter(Boolean).join("; ");
    // 10000 "Authentication error" and 9109 "Unauthorized to access requested resource" come back
    // for a token that is valid but lacks the permission; GraphQL says "not authorized" with a 200.
    const refused = res.status === 401 || res.status === 403
      || (data.errors ?? []).some((e) => e.code === 10000 || e.code === 9109 || /not authori[sz]ed|permission/i.test(e.message ?? ""));
    if (refused) {
      throw new CloudflareError(`Cloudflare refused ${method} ${path.split("?")[0]}: the token lacks the "${perm}" permission${errs ? ` (Cloudflare: ${redact(errs, this.token)})` : ""}. Add it to the token in the Cloudflare dashboard (${DOC}).`);
    }
    if (!res.ok || data.success === false || (data.errors?.length && data.success !== true && !("data" in data && data.data))) {
      throw new CloudflareError(`Cloudflare ${method} ${path.split("?")[0]} failed (${res.status})${errs ? `: ${redact(errs, this.token)}` : ""}`);
    }
    return data;
  }

  async get<T>(path: string, perm: Permission): Promise<T> {
    return (await this.call("GET", path, perm)).result as T;
  }

  /** Every page of a paged list (`page` / `total_pages`), at most MAX_PAGES. */
  async all<T>(path: string, perm: Permission, perPage = 100): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const data = await this.call("GET", `${path}${sep}page=${page}&per_page=${perPage}`, perm);
      const r = data.result as T[] | { items?: T[] } | undefined;
      const items = Array.isArray(r) ? r : r?.items ?? [];
      out.push(...items);
      const total = data.result_info?.total_pages;
      if (!items.length || !total || page >= total) break;
    }
    return out;
  }

  acct(path: string): string {
    return `/accounts/${encodeURIComponent(this.account)}${path}`;
  }
}

/** The client, or an error that names what to set. */
export function client(opts: CloudflareOpts): Client {
  const env = opts.env ?? process.env;
  const token = opts.token?.trim() || env[CLOUDFLARE_TOKEN_ENV]?.trim();
  const account = opts.account?.trim() || env[CLOUDFLARE_ACCOUNT_ENV]?.trim();
  const missing = [!token && CLOUDFLARE_TOKEN_ENV, !account && CLOUDFLARE_ACCOUNT_ENV].filter(Boolean);
  if (missing.length) {
    throw new CloudflareError(`Cloudflare is not set up on this bridge: connect the Cloudflare integration (Integrations > Connect: account id, and its secret variable set in this bridge's environment), or set ${missing.join(" and ")} and restart it. Create the token with the permissions in ${DOC}.`);
  }
  return new Client(token!, account!, (opts.base ?? env.ORCA_CLOUDFLARE_API ?? CLOUDFLARE_API).replace(/\/$/, ""), opts.fetch ?? Bun.fetch);
}

export type Zone = { id: string; name: string };
const ZONE_ID = /^[0-9a-f]{32}$/;

/** `--zone` as a name or an id → the zone. Without one: every zone of the account. */
export async function zones(c: Client, zone: string | undefined): Promise<Zone[]> {
  if (zone && ZONE_ID.test(zone)) return [{ id: zone, name: zone }];
  const q = `/zones?account.id=${encodeURIComponent(c.account)}${zone ? `&name=${encodeURIComponent(zone)}` : ""}`;
  const list = await c.all<Zone>(q, PERMISSIONS.dns, 50);
  if (zone && !list.length) throw new CloudflareError(`no zone "${zone}" in this account (or the token has no zone permission on it)`);
  return list;
}

function needWorker(words: string[], usage: string): string {
  const w = words[1];
  if (!w) throw new CloudflareError(usage);
  return w;
}

// ---- reads ----

async function account(c: Client): Promise<string> {
  const a = await c.get<{ id: string; name: string; created_on?: string }>(c.acct(""), PERMISSIONS.account);
  return `Account ${a.name} (${a.id}), created ${day(a.created_on)}.`;
}

export type Script = { id: string; created_on?: string; modified_on?: string; usage_model?: string; handlers?: string[]; last_deployed_from?: string };
async function workers(c: Client): Promise<string> {
  const list = await c.get<Script[]>(c.acct("/workers/scripts"), PERMISSIONS.scripts) ?? [];
  if (!list.length) return "No Workers in this account.";
  const sorted = [...list].sort((a, b) => String(b.modified_on ?? "").localeCompare(String(a.modified_on ?? "")));
  return `${list.length} Workers, newest change first:\n${table([["NAME", "CREATED", "MODIFIED", "DEPLOYED FROM"], ...sorted.map((s) => [s.id, day(s.created_on), day(s.modified_on), s.last_deployed_from ?? "—"])])}`;
}

export type Deployment = { id: string; created_on?: string; source?: string; strategy?: string; author_email?: string; versions?: { version_id: string; percentage: number }[]; annotations?: Record<string, string> };
async function deployments(c: Client, words: string[]): Promise<string> {
  const name = needWorker(words, "orca cloudflare deployments <worker>");
  const r = await c.get<{ deployments?: Deployment[] }>(c.acct(`/workers/scripts/${encodeURIComponent(name)}/deployments`), PERMISSIONS.scripts);
  const list = r?.deployments ?? [];
  if (!list.length) return `No deployments of ${name}.`;
  const rows = list.map((d, i) => [
    i === 0 ? `${d.id} (active)` : d.id, day(d.created_on), d.author_email ?? "—", d.source ?? "—",
    (d.versions ?? []).map((v) => `${v.version_id} ${v.percentage}%`).join(", "),
    d.annotations?.["workers/message"] ?? "",
  ]);
  return `${list.length} deployments of ${name}, newest first:\n${table([["DEPLOYMENT", "AT", "AUTHOR", "SOURCE", "VERSIONS", "MESSAGE"], ...rows])}`;
}

type Version = { id: string; number?: number; metadata?: { author_email?: string; author_id?: string; created_on?: string; source?: string }; annotations?: Record<string, string> };
async function versions(c: Client, words: string[]): Promise<string> {
  const name = needWorker(words, "orca cloudflare versions <worker>");
  const list = await c.all<Version>(c.acct(`/workers/scripts/${encodeURIComponent(name)}/versions`), PERMISSIONS.scripts, 50);
  if (!list.length) return `No versions of ${name}.`;
  const rows = list.map((v) => [v.id, String(v.number ?? "—"), day(v.metadata?.created_on), v.metadata?.author_email ?? v.metadata?.author_id ?? "—", v.metadata?.source ?? "—", v.annotations?.["workers/tag"] ?? "", v.annotations?.["workers/message"] ?? ""]);
  return `${list.length} versions of ${name}, newest first:\n${table([["VERSION", "#", "CREATED", "AUTHOR", "SOURCE", "TAG", "MESSAGE"], ...rows])}`;
}

type Route = { id: string; pattern: string; script?: string };
async function routes(c: Client, args: Args): Promise<string> {
  const zs = await zones(c, str(args.zone));
  const rows: string[][] = [];
  for (const z of zs) {
    const list = await c.get<Route[]>(`/zones/${z.id}/workers/routes`, PERMISSIONS.routes) ?? [];
    for (const r of list) rows.push([z.name, r.pattern, r.script || "(none)", r.id]);
  }
  if (!rows.length) return `No Worker routes${str(args.zone) ? ` on ${str(args.zone)}` : ` on ${zs.length} zones`}.`;
  return `${rows.length} Worker routes:\n${table([["ZONE", "PATTERN", "WORKER", "ROUTE ID"], ...rows])}`;
}

export type Domain = { id: string; hostname: string; service: string; environment?: string; zone_name?: string };
async function domains(c: Client): Promise<string> {
  const list = await c.get<Domain[]>(c.acct("/workers/domains"), PERMISSIONS.scripts) ?? [];
  if (!list.length) return "No Worker custom domains.";
  return `${list.length} Worker custom domains:\n${table([["HOSTNAME", "WORKER", "ENVIRONMENT", "ZONE"], ...list.map((d) => [d.hostname, d.service, d.environment ?? "—", d.zone_name ?? "—"])])}`;
}

type PagesProject = { name: string; subdomain?: string; domains?: string[]; created_on?: string; production_branch?: string; latest_deployment?: { created_on?: string; deployment_trigger?: { metadata?: { branch?: string; commit_hash?: string } } } };
async function pages(c: Client): Promise<string> {
  const list = await c.all<PagesProject>(c.acct("/pages/projects"), PERMISSIONS.pages, 10);
  if (!list.length) return "No Pages projects.";
  const rows = list.map((p) => {
    const meta = p.latest_deployment?.deployment_trigger?.metadata;
    return [p.name, (p.domains ?? []).join(", ") || p.subdomain || "—", p.production_branch ?? "—", day(p.created_on), `${day(p.latest_deployment?.created_on)}${meta?.branch ? ` ${meta.branch}` : ""}${meta?.commit_hash ? `@${meta.commit_hash.slice(0, 7)}` : ""}`];
  });
  return `${list.length} Pages projects:\n${table([["PROJECT", "DOMAINS", "PROD BRANCH", "CREATED", "LATEST DEPLOY"], ...rows])}`;
}

async function r2(c: Client): Promise<string> {
  const r = await c.get<{ buckets?: { name: string; creation_date?: string; location?: string; storage_class?: string }[] }>(c.acct("/r2/buckets"), PERMISSIONS.r2);
  const list = r?.buckets ?? [];
  if (!list.length) return "No R2 buckets.";
  return `${list.length} R2 buckets:\n${table([["BUCKET", "CREATED", "LOCATION", "CLASS"], ...list.map((b) => [b.name, day(b.creation_date), b.location ?? "—", b.storage_class ?? "—"])])}`;
}

const size = (n: unknown): string => (typeof n === "number" ? (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`) : "—");
async function d1(c: Client): Promise<string> {
  const list = await c.all<{ uuid: string; name: string; created_at?: string; num_tables?: number; file_size?: number; version?: string }>(c.acct("/d1/database"), PERMISSIONS.d1);
  if (!list.length) return "No D1 databases.";
  return `${list.length} D1 databases:\n${table([["DATABASE", "ID", "CREATED", "TABLES", "SIZE"], ...list.map((d) => [d.name, d.uuid, day(d.created_at), String(d.num_tables ?? "—"), size(d.file_size)])])}`;
}

async function zoneList(c: Client): Promise<string> {
  const list = await zones(c, undefined);
  if (!list.length) return "No zones (or the token has no zone permission).";
  return `${list.length} zones:\n${table([["ZONE", "ID"], ...list.map((z) => [z.name, z.id])])}`;
}

type DnsRecord = { id: string; type: string; name: string; content: string; proxied?: boolean; ttl?: number; comment?: string | null };
async function dns(c: Client, args: Args): Promise<string> {
  const zone = str(args.zone);
  if (!zone) throw new CloudflareError("orca cloudflare dns --zone <zone name|id> [--type <A|CNAME|…>] [--name <record name>]");
  const [z] = await zones(c, zone);
  const q = [str(args.type) && `type=${encodeURIComponent(str(args.type)!.toUpperCase())}`, str(args.name) && `name=${encodeURIComponent(str(args.name)!)}`].filter(Boolean).join("&");
  const list = await c.all<DnsRecord>(`/zones/${z!.id}/dns_records${q ? `?${q}` : ""}`, PERMISSIONS.dns);
  if (!list.length) return `No DNS records on ${z!.name}${q ? " that match" : ""}.`;
  const rows = list.map((r) => [r.type, r.name, r.content, r.proxied ? "proxied" : "dns only", r.ttl === 1 ? "auto" : String(r.ttl ?? "—"), r.comment ?? ""]);
  return `${list.length} DNS records on ${z!.name}:\n${table([["TYPE", "NAME", "CONTENT", "PROXY", "TTL", "COMMENT"], ...rows])}`;
}

export const ANALYTICS_QUERY = `query WorkersSummary($accountTag: string!, $since: Time!, $until: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $until }) {
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 cpuTimeP99 }
      dimensions { scriptName }
    }
  } }
}`;
type Invocation = { sum?: { requests?: number; errors?: number; subrequests?: number }; quantiles?: { cpuTimeP50?: number; cpuTimeP99?: number }; dimensions?: { scriptName?: string } };
export type WorkerTotals = { requests: number; errors: number; subrequests: number; p50: number; p99: number };
/** Each Worker's sums over [since, until], from one GraphQL query. */
export async function workerTotals(c: Client, since: Date, until: Date): Promise<Map<string, WorkerTotals>> {
  const res = await c.call("POST", "/graphql", PERMISSIONS.analytics, { query: ANALYTICS_QUERY, variables: { accountTag: c.account, since: since.toISOString(), until: until.toISOString() } });
  const data = (res as unknown as { data?: { viewer?: { accounts?: { workersInvocationsAdaptive?: Invocation[] }[] } } }).data;
  const groups = data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  // The adaptive dataset groups by every dimension asked for; one script may still span rows.
  const by = new Map<string, WorkerTotals>();
  for (const g of groups) {
    const name = g.dimensions?.scriptName ?? "(unknown)";
    const cur = by.get(name) ?? { requests: 0, errors: 0, subrequests: 0, p50: 0, p99: 0 };
    cur.requests += g.sum?.requests ?? 0; cur.errors += g.sum?.errors ?? 0; cur.subrequests += g.sum?.subrequests ?? 0;
    cur.p50 = Math.max(cur.p50, g.quantiles?.cpuTimeP50 ?? 0); cur.p99 = Math.max(cur.p99, g.quantiles?.cpuTimeP99 ?? 0);
    by.set(name, cur);
  }
  return by;
}
async function analytics(c: Client, args: Args, now: Date): Promise<string> {
  const since = parseSince(args.since, now), until = args.until !== undefined ? parseSince(args.until, now) : now;
  const by = await workerTotals(c, since, until);
  const worker = str(args.worker);
  const rows = [...by].filter(([n]) => !worker || n === worker).sort((a, b) => b[1].requests - a[1].requests);
  const span = `${day(since.toISOString())} – ${day(until.toISOString())} UTC`;
  if (!rows.length) return `No Worker invocations${worker ? ` of ${worker}` : ""} in ${span}.`;
  const pct = (e: number, r: number) => (r ? `${((e / r) * 100).toFixed(2)}%` : "—");
  const ms = (us: number) => `${(us / 1000).toFixed(1)} ms`;
  const tot = rows.reduce((t, [, v]) => ({ r: t.r + v.requests, e: t.e + v.errors }), { r: 0, e: 0 });
  return `Workers analytics, ${span}: ${tot.r} requests, ${tot.e} errors (${pct(tot.e, tot.r)}).\n${table([["WORKER", "REQUESTS", "ERRORS", "ERROR %", "SUBREQUESTS", "CPU P50", "CPU P99"], ...rows.map(([n, v]) => [n, String(v.requests), String(v.errors), pct(v.errors, v.requests), String(v.subrequests), ms(v.p50), ms(v.p99)])])}`;
}

export type AuditLog = { id: string; when?: string; action?: { type?: string; result?: boolean }; actor?: { email?: string; type?: string; ip?: string }; resource?: { id?: string; type?: string }; newValue?: string; oldValue?: string; metadata?: unknown; interface?: string };
/** Whether `log` mentions `resource` anywhere: id, type, values or metadata (the API has no such filter). Pure. */
export function auditMatches(log: AuditLog, resource: string): boolean {
  const hay = JSON.stringify([log.resource, log.newValue, log.oldValue, log.metadata]).toLowerCase();
  return hay.includes(resource.toLowerCase());
}
async function audit(c: Client, args: Args, now: Date): Promise<string> {
  const since = parseSince(args.since, now, "7d"), before = args.until !== undefined ? parseSince(args.until, now) : now;
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500);
  const actor = str(args.actor), resource = str(args.resource);
  const q = [`since=${encodeURIComponent(since.toISOString())}`, `before=${encodeURIComponent(before.toISOString())}`, "direction=desc", ...(actor ? [`actor.email=${encodeURIComponent(actor)}`] : [])].join("&");
  let list = await c.all<AuditLog>(c.acct(`/audit_logs?${q}`), PERMISSIONS.audit, 1000);
  if (resource) list = list.filter((l) => auditMatches(l, resource));
  const shown = list.slice(0, limit);
  if (!shown.length) return `No audit-log entries${resource ? ` for "${resource}"` : ""}${actor ? ` by ${actor}` : ""} in ${day(since.toISOString())} – ${day(before.toISOString())} UTC.`;
  const rows = shown.map((l) => [day(l.when), l.actor?.email ?? l.actor?.type ?? "—", `${l.action?.type ?? "—"}${l.action?.result === false ? " (failed)" : ""}`, `${l.resource?.type ?? ""}${l.resource?.id ? ` ${l.resource.id}` : ""}`.trim() || "—", l.interface ?? ""]);
  return `${shown.length}${list.length > shown.length ? ` of ${list.length}` : ""} audit-log entries, newest first:\n${table([["WHEN (UTC)", "ACTOR", "ACTION", "RESOURCE", "VIA"], ...rows])}`;
}

// ---- writes (dry run unless --confirm; a confirmed one is logged) ----

type Who = { by: string };

/** One confirmed write Orca made: when, and the names and ids it touched (lower case). */
export type OwnWrite = { at: number; targets: string[] };
export const OWN_WRITE_WINDOW_MS = 15 * 60_000;
/** Whether `text` (an audit entry, a Worker name) names a target of an own write made within
 *  OWN_WRITE_WINDOW_MS of `at`. Pure. */
export function isOwnWrite(text: string, at: number, writes: OwnWrite[]): boolean {
  const hay = text.toLowerCase();
  return writes.some((w) => Math.abs(w.at - at) <= OWN_WRITE_WINDOW_MS && w.targets.some((t) => t && hay.includes(t)));
}

function logWrite(opts: CloudflareOpts, who: Who, what: string, result: string, now: Date): void {
  (opts.log ?? ((l: string) => console.log(l)))(`[cloudflare] ${now.toISOString()} ${who.by}: ${what} → ${result}`);
}
async function confirmed(opts: CloudflareOpts, who: Who, what: string, now: Date, act: () => Promise<string>, targets: string[] = []): Promise<string> {
  try {
    const out = await act();
    logWrite(opts, who, what, "ok", now);
    try { await opts.onWrite?.(targets.filter(Boolean).map((t) => t.toLowerCase()), now.getTime()); } catch { /* the write stands; only the watcher's filter misses it */ }
    return out;
  } catch (e) {
    logWrite(opts, who, what, `failed: ${(e as Error).message}`, now);
    throw e;
  }
}
const dry = (plan: string) => `Dry run, nothing changed. ${plan}\nRun it again with --confirm to do it.`;

async function rollback(c: Client, words: string[], args: Args, opts: CloudflareOpts, who: Who, now: Date): Promise<string> {
  const name = needWorker(words, "orca cloudflare rollback <worker> --version <version id> [--message \"…\"] [--confirm]");
  const version = str(args.version);
  if (!version) throw new CloudflareError("orca cloudflare rollback <worker> --version <version id> [--message \"…\"] [--confirm] (orca cloudflare versions <worker> lists them)");
  // Check the version exists before anything moves: a typo must not become a failed deploy.
  const v = await c.get<Version>(c.acct(`/workers/scripts/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`), PERMISSIONS.scripts);
  const plan = `Roll back Worker ${name} to version ${version}${v?.number ? ` (#${v.number})` : ""}: deploy it at 100% of traffic.`;
  if (args.confirm === undefined) return dry(plan);
  const message = str(args.message) ?? `Rollback by Orca (${who.by})`;
  return confirmed(opts, who, `rollback ${name} to ${version}`, now, async () => {
    const r = await c.call("POST", c.acct(`/workers/scripts/${encodeURIComponent(name)}/deployments`), PERMISSIONS.scriptsEdit, {
      strategy: "percentage", versions: [{ version_id: version, percentage: 100 }], annotations: { "workers/message": message.slice(0, 100) },
    });
    const id = (r.result as { id?: string } | undefined)?.id;
    return `Rolled back ${name} to version ${version}${id ? ` (deployment ${id})` : ""}.`;
  }, [name, version]);
}

async function remove(c: Client, words: string[], args: Args, opts: CloudflareOpts, who: Who, now: Date): Promise<string> {
  const name = needWorker(words, "orca cloudflare delete <worker> [--confirm]");
  const list = await c.get<Script[]>(c.acct("/workers/scripts"), PERMISSIONS.scripts) ?? [];
  const s = list.find((x) => x.id === name);
  if (!s) throw new CloudflareError(`no Worker "${name}" in this account (orca cloudflare workers lists them)`);
  const plan = `Delete Worker ${name} (created ${day(s.created_on)}, modified ${day(s.modified_on)}) with all its versions. Routes and custom domains on it stop serving it.`;
  if (args.confirm === undefined) return dry(plan);
  return confirmed(opts, who, `delete ${name}`, now, async () => {
    await c.call("DELETE", c.acct(`/workers/scripts/${encodeURIComponent(name)}`), PERMISSIONS.scriptsEdit);
    return `Deleted Worker ${name}.`;
  }, [name]);
}

async function route(c: Client, words: string[], args: Args, opts: CloudflareOpts, who: Who, now: Date): Promise<string> {
  const sub = words[1];
  const zone = str(args.zone), pattern = str(args.pattern);
  if (sub === "add") {
    const worker = str(args.worker);
    if (!zone || !pattern || !worker) throw new CloudflareError("orca cloudflare route add --zone <zone> --pattern <host/path*> --worker <name> [--confirm]");
    const [z] = await zones(c, zone);
    const existing = await c.get<Route[]>(`/zones/${z!.id}/workers/routes`, PERMISSIONS.routes) ?? [];
    const same = existing.find((r) => r.pattern === pattern);
    if (same) throw new CloudflareError(`route ${pattern} already exists on ${z!.name} (→ ${same.script || "no worker"}, id ${same.id}); remove it first`);
    const plan = `Add route ${pattern} → Worker ${worker} on zone ${z!.name}.`;
    if (args.confirm === undefined) return dry(plan);
    return confirmed(opts, who, `route add ${pattern} → ${worker} on ${z!.name}`, now, async () => {
      const r = await c.call("POST", `/zones/${z!.id}/workers/routes`, PERMISSIONS.routesEdit, { pattern, script: worker });
      return `Added route ${pattern} → ${worker} on ${z!.name} (id ${(r.result as { id?: string } | undefined)?.id ?? "?"}).`;
    }, [pattern]);
  }
  if (sub === "remove") {
    const id = str(args.id);
    if (!zone || (!id && !pattern)) throw new CloudflareError("orca cloudflare route remove --zone <zone> (--id <route id> | --pattern <pattern>) [--confirm]");
    const [z] = await zones(c, zone);
    const existing = await c.get<Route[]>(`/zones/${z!.id}/workers/routes`, PERMISSIONS.routes) ?? [];
    const r = existing.find((x) => (id ? x.id === id : x.pattern === pattern));
    if (!r) throw new CloudflareError(`no route ${id ?? pattern} on ${z!.name} (orca cloudflare routes --zone ${zone} lists them)`);
    const plan = `Remove route ${r.pattern} → ${r.script || "no worker"} (id ${r.id}) from zone ${z!.name}.`;
    if (args.confirm === undefined) return dry(plan);
    return confirmed(opts, who, `route remove ${r.pattern} (${r.id}) on ${z!.name}`, now, async () => {
      await c.call("DELETE", `/zones/${z!.id}/workers/routes/${r.id}`, PERMISSIONS.routesEdit);
      return `Removed route ${r.pattern} from ${z!.name}.`;
    }, [r.pattern, r.id]);
  }
  throw new CloudflareError("orca cloudflare route add … | orca cloudflare route remove … (orca cloudflare help)");
}

/** The zone `hostname` sits in: `--zone` when given (it must contain the hostname), else the
 *  account zone with the longest matching suffix. */
async function zoneFor(c: Client, hostname: string, zone: string | undefined): Promise<Zone> {
  const host = hostname.toLowerCase();
  const inZone = (z: Zone) => host === z.name.toLowerCase() || host.endsWith(`.${z.name.toLowerCase()}`);
  if (zone) {
    const [z] = await zones(c, zone);
    // A zone given by id has no name yet: the domain call checks the hostname against it.
    if (z!.name !== z!.id && !inZone(z!)) throw new CloudflareError(`${hostname} is not in zone ${z!.name}`);
    return z!;
  }
  const match = (await zones(c, undefined)).filter(inZone).sort((a, b) => b.name.length - a.name.length)[0];
  if (!match) throw new CloudflareError(`no zone in this account holds ${hostname} (orca cloudflare zones lists them; or pass --zone)`);
  return match;
}

async function domain(c: Client, words: string[], args: Args, opts: CloudflareOpts, who: Who, now: Date): Promise<string> {
  const sub = words[1];
  const hostname = str(args.hostname)?.toLowerCase();
  const list = async () => await c.get<Domain[]>(c.acct("/workers/domains"), PERMISSIONS.scripts) ?? [];
  if (sub === "add") {
    const worker = str(args.worker);
    if (!worker || !hostname) throw new CloudflareError("orca cloudflare domain add --worker <name> --hostname <host> [--zone <zone>] [--confirm]");
    const scripts = await c.get<Script[]>(c.acct("/workers/scripts"), PERMISSIONS.scripts) ?? [];
    if (!scripts.some((s) => s.id === worker)) throw new CloudflareError(`no Worker "${worker}" in this account (orca cloudflare workers lists them). Deploy it from its repo's pipeline first`);
    const same = (await list()).find((d) => d.hostname.toLowerCase() === hostname);
    if (same) throw new CloudflareError(`${hostname} is already a custom domain of Worker ${same.service} (id ${same.id})${same.service === worker ? "" : "; remove it first"}`);
    const z = await zoneFor(c, hostname, str(args.zone));
    // Cloudflare refuses a custom domain on a hostname that has a CNAME record: say so before the call.
    const cname = await c.all<DnsRecord>(`/zones/${z.id}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`, PERMISSIONS.dns);
    if (cname.length) throw new CloudflareError(`${hostname} has a CNAME record (→ ${cname[0]!.content}, id ${cname[0]!.id}); Cloudflare refuses a custom domain there. Remove the record first (orca cloudflare dns remove --zone ${z.name} --id ${cname[0]!.id})`);
    const plan = `Attach custom domain ${hostname} → Worker ${worker} on zone ${z.name}. Cloudflare creates its DNS record and certificate.`;
    if (args.confirm === undefined) return dry(plan);
    return confirmed(opts, who, `domain add ${hostname} → ${worker} on ${z.name}`, now, async () => {
      const r = await c.call("PUT", c.acct("/workers/domains"), PERMISSIONS.scriptsEdit, { hostname, service: worker, zone_id: z.id });
      return `Attached ${hostname} → ${worker} (id ${(r.result as { id?: string } | undefined)?.id ?? "?"}).`;
    }, [hostname]);
  }
  if (sub === "remove") {
    const id = str(args.id);
    if (!id && !hostname) throw new CloudflareError("orca cloudflare domain remove (--hostname <host> | --id <domain id>) [--confirm]");
    const d = (await list()).find((x) => (id ? x.id === id : x.hostname.toLowerCase() === hostname));
    if (!d) throw new CloudflareError(`no custom domain ${id ?? hostname} (orca cloudflare domains lists them)`);
    const plan = `Detach custom domain ${d.hostname} from Worker ${d.service} (id ${d.id}). Cloudflare removes its DNS record; the hostname stops serving the Worker.`;
    if (args.confirm === undefined) return dry(plan);
    return confirmed(opts, who, `domain remove ${d.hostname} (${d.id})`, now, async () => {
      await c.call("DELETE", c.acct(`/workers/domains/${encodeURIComponent(d.id)}`), PERMISSIONS.scriptsEdit);
      return `Detached ${d.hostname} from ${d.service}.`;
    }, [d.hostname, d.id]);
  }
  throw new CloudflareError("orca cloudflare domain add … | orca cloudflare domain remove … (orca cloudflare help)");
}

/** `www`, `@` or a full name → the record's full name in `zone`. Pure. */
export function recordName(name: string, zone: string): string {
  const n = name.toLowerCase().replace(/\.$/, ""), z = zone.toLowerCase();
  if (n === "@" || n === z) return z;
  return n.endsWith(`.${z}`) ? n : `${n}.${z}`;
}

async function dnsWrite(c: Client, words: string[], args: Args, opts: CloudflareOpts, who: Who, now: Date): Promise<string> {
  const sub = words[1];
  const zone = str(args.zone);
  if (sub === "add") {
    const type = str(args.type)?.toUpperCase(), name = str(args.name), content = str(args.content);
    if (!zone || !type || !name || !content) throw new CloudflareError("orca cloudflare dns add --zone <zone> --type <A|AAAA|CNAME|TXT|…> --name <name> --content <value> [--proxied] [--ttl <s>] [--comment …] [--confirm]");
    const [z] = await zones(c, zone);
    if (z!.name === z!.id) throw new CloudflareError("dns add takes --zone as a zone NAME (example.com), so the record name can be checked");
    const full = recordName(name, z!.name);
    const ttl = args.ttl !== undefined ? Number(args.ttl) : 1;
    if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 30 || ttl > 86400))) throw new CloudflareError("--ttl is 1 (automatic) or 30–86400 seconds");
    const proxied = args.proxied !== undefined && args.proxied !== false && args.proxied !== "false";
    const there = await c.all<DnsRecord>(`/zones/${z!.id}/dns_records?name=${encodeURIComponent(full)}`, PERMISSIONS.dns);
    const dup = there.find((r) => r.type === type && r.content === content);
    if (dup) throw new CloudflareError(`${type} ${full} → ${content} already exists (id ${dup.id})`);
    // A CNAME may not share its name with any other record (RFC 1034), so neither side may be added.
    const clash = type === "CNAME" ? there[0] : there.find((r) => r.type === "CNAME");
    if (clash) throw new CloudflareError(`${full} already has a ${clash.type} record (→ ${clash.content}, id ${clash.id}); a CNAME cannot share a name with another record`);
    const plan = `Add DNS record ${type} ${full} → ${content} (${proxied ? "proxied" : "dns only"}, TTL ${ttl === 1 ? "auto" : ttl}) on zone ${z!.name}.`;
    if (args.confirm === undefined) return dry(plan);
    const comment = str(args.comment);
    return confirmed(opts, who, `dns add ${type} ${full} → ${content} on ${z!.name}`, now, async () => {
      const r = await c.call("POST", `/zones/${z!.id}/dns_records`, PERMISSIONS.dnsEdit, { type, name: full, content, proxied, ttl, ...(comment ? { comment } : {}) });
      return `Added ${type} ${full} → ${content} on ${z!.name} (id ${(r.result as { id?: string } | undefined)?.id ?? "?"}).`;
    }, [full]);
  }
  if (sub === "remove") {
    const id = str(args.id);
    if (!zone || !id) throw new CloudflareError("orca cloudflare dns remove --zone <zone> --id <record id> [--confirm] (orca cloudflare dns --zone <zone> lists ids)");
    const [z] = await zones(c, zone);
    const r = (await c.all<DnsRecord>(`/zones/${z!.id}/dns_records`, PERMISSIONS.dns)).find((x) => x.id === id);
    if (!r) throw new CloudflareError(`no DNS record ${id} on ${z!.name} (orca cloudflare dns --zone ${zone} lists them)`);
    const plan = `Remove DNS record ${r.type} ${r.name} → ${r.content} (id ${r.id}) from zone ${z!.name}.`;
    if (args.confirm === undefined) return dry(plan);
    return confirmed(opts, who, `dns remove ${r.type} ${r.name} (${r.id}) on ${z!.name}`, now, async () => {
      await c.call("DELETE", `/zones/${z!.id}/dns_records/${encodeURIComponent(r.id)}`, PERMISSIONS.dnsEdit);
      return `Removed ${r.type} ${r.name} from ${z!.name}.`;
    }, [r.name, r.id]);
  }
  throw new CloudflareError("orca cloudflare dns --zone z (read) | dns add … | dns remove … (orca cloudflare help)");
}

export const CLOUDFLARE_USAGE = [
  "orca cloudflare account | workers | deployments <worker> | versions <worker> | routes [--zone z] | domains",
  "  | pages | r2 | d1 | zones | dns --zone z [--type t] [--name n] | analytics [--worker w] [--since 24h] [--until t]",
  "  | audit [--resource name] [--actor email] [--since 7d] [--until t] [--limit 50]",
  "  | rollback <worker> --version <id> [--message m] [--confirm] | delete <worker> [--confirm]",
  "  | route add --zone z --pattern p --worker w [--confirm] | route remove --zone z (--id i | --pattern p) [--confirm]",
  "  | domain add --worker w --hostname h [--zone z] [--confirm] | domain remove (--hostname h | --id i) [--confirm]",
  "  | dns add --zone z --type t --name n --content c [--proxied] [--ttl s] [--comment m] [--confirm] | dns remove --zone z --id i [--confirm]",
  "No command uploads Worker code: new Workers come from the repo's deploy pipeline.",
].join("\n");

/** `orca cloudflare <sub> …` → the text it prints. `by` names who asked, for the write log. */
export async function cloudflareTool(args: Args, opts: CloudflareOpts & { by?: string } = {}): Promise<string> {
  const words = (args._ ?? []).map(String);
  const sub = words[0] ?? "";
  if (!sub || sub === "help") return CLOUDFLARE_USAGE;
  const c = client(opts);
  const now = (opts.now ?? (() => new Date()))();
  const who = { by: opts.by ?? "orchestrator" };
  switch (sub) {
    case "account": return account(c);
    case "workers": return workers(c);
    case "deployments": return deployments(c, words);
    case "versions": return versions(c, words);
    case "routes": return routes(c, args);
    case "domains": return domains(c);
    case "pages": return pages(c);
    case "r2": return r2(c);
    case "d1": return d1(c);
    case "zones": return zoneList(c);
    case "dns": return words[1] === "add" || words[1] === "remove" ? dnsWrite(c, words, args, opts, who, now) : dns(c, args);
    case "analytics": return analytics(c, args, now);
    case "audit": return audit(c, args, now);
    case "rollback": return rollback(c, words, args, opts, who, now);
    case "delete": return remove(c, words, args, opts, who, now);
    case "route": return route(c, words, args, opts, who, now);
    case "domain": return domain(c, words, args, opts, who, now);
    default: throw new CloudflareError(`unknown subcommand "${sub}".\n${CLOUDFLARE_USAGE}`);
  }
}
