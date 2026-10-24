// The Cloudflare adapter (setup: docs/integrations/cloudflare.md). Inbound only: the bridge has no
// public address, so there are no Cloudflare webhooks. Every `pollSeconds` (default 120, at least 30)
// it reads one account with
// the account API token its secret_ref names (default ORCA_SECRET_CLOUDFLARE, or `secret:<name>` for
// Orca's secret store — the registry loads it, server/integrations/secretRefs.ts) and compares
// with what it saw last time:
//   - the audit log since the cursor  → `ext.cloudflare.audit`, DNS records → `ext.cloudflare.dns`
//   - Workers and their deployments    → `ext.cloudflare.deploy` (deploys), `ext.cloudflare.worker`
//                                         (a new or deleted Worker, a rollback)
//   - Worker custom domains            → `ext.cloudflare.domain`
//   - each Worker's error rate over the last window, against a threshold → `ext.cloudflare.errors`
// One poll's changes become ONE envelope per topic and place (`zone:<name>`, else `account`), so a
// burst of changes is one message, and the core's gate, subscriptions and routing apply as for every
// adapter. No actor: a poller is a machine sender, so the link's level is the grant. Connect makes a
// Viewer (`ask`) catch-all link and subscribes the orchestrator to the topics (`ensureDefaults`); the
// deploys topic comes as an hourly digest. Left out: Orca's own confirmed writes (`orca cloudflare
// … --confirm` stores them, `OWN_WRITES_CURSOR`), and the entries of the deploy actors (default: any
// actor that names GitHub) — their deploys still show in the deploys summary. The state (audit
// cursor, seen ids, Workers, domains, the Workers now alerting) is ONE JSON value in
// integration_cursor, so a restart neither replays nor misses a change. Outbound: none — there is no
// place to post, so `caps.outbound` is false and `orca post` to its link is refused.
import { createHash } from "crypto";
import {
  CLOUDFLARE_ACCOUNT_ENV, CLOUDFLARE_TOKEN_ENV, PERMISSIONS, client, isOwnWrite, workerTotals,
  type AuditLog, type Client, type CloudflareOpts, type Deployment, type Domain, type OwnWrite, type Script, type WorkerTotals,
} from "../../cloudflare";
import { CATCH_ALL, storedSecretName, type Capabilities, type InboundEnvelope, type SendResult } from "../../../shared/integrations";
import type { Adapter, AdapterContext, Connection } from "../adapter";
import * as store from "../store";
import * as secrets from "../../secrets";
import { secretValue } from "../secretRefs";

export const CLOUDFLARE_CAPS: Capabilities = {
  inbound: "poll", outbound: false, threads: false, edits: false, reactions: false, attachments: false, maxTextLength: 0,
};
export const DEFAULT_POLL_SECONDS = 120;
export const MIN_POLL_SECONDS = 30;
/** Deployment reads in one tick at most (one per new or changed Worker). The rest wait for the
 *  next tick, so a tick costs at most this + 4 calls: audit, Workers, custom domains, GraphQL.
 *  At the minimum interval that is 140 calls in 5 minutes; Cloudflare allows 1,200 per token. */
export const MAX_DEPLOYMENT_READS = 10;
/** After a 429 the next tick waits twice as long each time, up to this; a clean tick resets it. */
export const MAX_BACKOFF_MS = 15 * 60_000;
export const DEFAULT_ERROR_RATE_PCT = 5;
export const DEFAULT_MIN_REQUESTS = 100;
export const DEFAULT_DEPLOY_ACTORS = ["github"];
/** The integration_cursor row where `orca cloudflare … --confirm` records Orca's own writes. */
export const OWN_WRITES_CURSOR = "cloudflare:own-writes";
const OWN_WRITES_KEEP_MS = 60 * 60_000;
const SEEN_MAX = 500;
const LINE_MAX = 300;

export type CloudflareTopic = "audit" | "dns" | "deploy" | "worker" | "domain" | "errors";
/** What Connect subscribes the orchestrator to. Deploys are routine: one digest an hour. */
export const DEFAULT_SUBSCRIPTIONS: { topic: `ext.cloudflare.${CloudflareTopic}`; digestSeconds?: number }[] = [
  { topic: "ext.cloudflare.audit" }, { topic: "ext.cloudflare.dns" }, { topic: "ext.cloudflare.domain" },
  { topic: "ext.cloudflare.worker" }, { topic: "ext.cloudflare.errors" }, { topic: "ext.cloudflare.deploy", digestSeconds: 3600 },
];

// ── Config ───────────────────────────────────────────────────────────────────────────────────────

export type CloudflareConfig = { accountId?: string; pollSeconds: number; errorRatePct: number; minRequests: number; zones: string[]; deployActors: string[] };

const list = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).map((s) => s.trim().toLowerCase()).filter(Boolean)
  : typeof v === "string" && v.trim() ? v.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined;
const num = (v: unknown, fallback: number, min: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min ? n : fallback;
};

/** The Settings form saves every value as a string: parse it, with the defaults. Pure. */
export function cloudflareConfig(raw: Record<string, unknown>, env: Record<string, string | undefined> = process.env): CloudflareConfig {
  const accountId = (typeof raw.accountId === "string" && raw.accountId.trim()) || env[CLOUDFLARE_ACCOUNT_ENV]?.trim() || undefined;
  return {
    ...(accountId ? { accountId } : {}),
    // `pollMinutes` is the first cut's key, kept as an alias when `pollSeconds` is not set.
    // Under the minimum is raised to it, not dropped to the default.
    pollSeconds: Math.max(MIN_POLL_SECONDS, num(raw.pollSeconds ?? (raw.pollMinutes !== undefined && raw.pollMinutes !== "" ? Number(raw.pollMinutes) * 60 : undefined), DEFAULT_POLL_SECONDS, 1)),
    errorRatePct: num(raw.errorRatePct, DEFAULT_ERROR_RATE_PCT, 0.01),
    minRequests: num(raw.minRequests, DEFAULT_MIN_REQUESTS, 1),
    zones: list(raw.zones) ?? [],
    deployActors: list(raw.deployActors) ?? DEFAULT_DEPLOY_ACTORS,
  };
}

/** The token variable of a connection: its secret_ref, else the default. */
export const tokenRef = (c: Pick<Connection, "secretRef">): string => c.secretRef || CLOUDFLARE_TOKEN_ENV;

/** Reads a stored Orca secret for a bridge-side caller (server/secrets.ts `reveal`); a test swaps it. */
export type Reveal = (ref: string, who: string, use: string) => Promise<string>;

/** Where a connection's token comes from, for a message: the stored secret, else the variable. Pure. */
export const tokenSource = (c: Pick<Connection, "secretRef">): string => {
  const name = storedSecretName(tokenRef(c));
  return name ? `the stored secret "${name}"` : tokenRef(c);
};

/** A connection's token for `orca cloudflare`, which runs outside the adapter: a stored secret
 *  (`secret:<name>`) is decrypted here and kept in the caller's memory only — never an env file, a
 *  log or an agent; else the variable. Undefined when the variable is unset; a stored secret that
 *  cannot be read throws. */
export async function resolveToken(c: Pick<Connection, "id" | "secretRef">, env: Record<string, string | undefined> = process.env, reveal: Reveal = secrets.reveal): Promise<string | undefined> {
  const name = storedSecretName(tokenRef(c));
  if (name) return (await reveal(name, `integration ${c.id}`, "cloudflare")).trim() || undefined;
  return env[tokenRef(c)]?.trim() || undefined;
}

/** `orca cloudflare …`'s credentials: the first enabled Cloudflare integration's token (a stored
 *  secret or this bridge's variable) and account id. Empty when none is connected, so the env
 *  fallback applies. A stored secret that cannot be read is an error, not a silent fallback. */
export async function connectedCredentials(env: Record<string, string | undefined> = process.env, reveal: Reveal = secrets.reveal): Promise<Pick<CloudflareOpts, "token" | "account">> {
  const rows = await store.integrations().catch(() => []);
  const c = rows.find((r) => r.kind === "cloudflare" && r.enabled);
  if (!c) return {};
  let token: string | undefined;
  try { token = await resolveToken(c, env, reveal); }
  catch (e) { throw new Error(`the Cloudflare integration's token, ${tokenSource(c)}, cannot be read: ${e instanceof Error ? e.message : String(e)}`); }
  const account = cloudflareConfig(c.config, env).accountId;
  return { ...(token ? { token } : {}), ...(account ? { account } : {}) };
}

/** Record one confirmed write for the watcher (any instance reads it from the database). */
export async function recordOwnWrite(targets: string[], at: number): Promise<void> {
  const keep = (await readOwnWrites()).filter((w) => w.at > at - OWN_WRITES_KEEP_MS);
  await store.setCursor(OWN_WRITES_CURSOR, JSON.stringify([...keep, { at, targets }]));
}
export async function readOwnWrites(): Promise<OwnWrite[]> {
  try { const v = JSON.parse((await store.cursor(OWN_WRITES_CURSOR)) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** The first connect of a Cloudflare integration: a Viewer catch-all link (so its machine events
 *  pass the gate, and the orchestrator may run the reads but no write), and the orchestrator's
 *  subscriptions. A later edit adds nothing, so a link or subscription you removed stays removed. */
export async function ensureDefaults(c: Pick<Connection, "id">): Promise<void> {
  const links = (await store.links()).filter((l) => l.integrationId === c.id);
  if (!links.length) await store.addLink({ id: `${c.id}-account`.slice(0, 63), integrationId: c.id, externalId: CATCH_ALL, label: "Whole account", level: "ask", repos: [], requireMention: false });
  const subs = await store.subscriptions();
  for (const d of DEFAULT_SUBSCRIPTIONS) {
    if (subs.some((s) => s.topicPattern === d.topic && s.targetKind === "orchestrator")) continue;
    await store.addSubscription({ topicPattern: d.topic, filter: {}, targetKind: "orchestrator", ...(d.digestSeconds ? { digestSeconds: d.digestSeconds } : {}) });
  }
}

// ── State and items ──────────────────────────────────────────────────────────────────────────────

export type WatchState = {
  v: 1;
  polledAt: string; // the previous poll: the error window starts here, and keys of diffs carry it
  auditAt: string; // the audit log is read from here (inclusive)
  seen: string[]; // audit ids already handled at the boundary, newest last
  workers: Record<string, { modified?: string; created?: string; deployment?: string }>;
  domains: Record<string, { service: string; zone?: string }>;
  alerting: string[]; // Workers over the error threshold: no second alert until they drop under it
};

export function parseState(raw: string | undefined): WatchState | undefined {
  if (!raw) return undefined;
  try { const s = JSON.parse(raw) as WatchState; return s && s.v === 1 ? s : undefined; } catch { return undefined; }
}

/** One change. `key` is stable for the change, so the batch it rides in has a stable key too. */
export type WatchItem = { key: string; topic: CloudflareTopic; place: string; at: number; line: string };

const one = (s: unknown): string => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 120);
const utc = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const ms = (iso: unknown): number => (typeof iso === "string" && iso ? Date.parse(iso) || 0 : 0);
const inZones = (zone: string | undefined, zones: string[]): boolean => !zone || !zones.length || zones.includes(zone.toLowerCase());

/** The zone an audit entry is about: its metadata's zone name, else a watched zone it names. Pure. */
export function auditZone(l: AuditLog, zones: string[]): string | undefined {
  const m = (l.metadata ?? {}) as Record<string, unknown>;
  const named = [m.zone_name, m.zoneName, (m.zone as { name?: unknown } | undefined)?.name].find((v) => typeof v === "string" && v);
  if (named) return String(named).toLowerCase();
  const hay = JSON.stringify([l.resource, l.newValue, l.oldValue, l.metadata]).toLowerCase();
  return zones.find((z) => hay.includes(z));
}

/** Whether an entry or a deploy comes from a deploy actor (a CI token), by its actor and metadata. Pure. */
export function isDeployActor(text: string, actors: string[]): boolean {
  const hay = text.toLowerCase();
  return actors.some((a) => a && hay.includes(a));
}

/** The audit entries worth a line: not seen, not Orca's own write, not a deploy actor's, in a
 *  watched zone. DNS records get their own topic. Pure. */
export function auditItems(logs: AuditLog[], seen: Set<string>, cfg: CloudflareConfig, own: OwnWrite[]): WatchItem[] {
  const out: WatchItem[] = [];
  for (const l of logs) {
    if (!l.id || seen.has(l.id)) continue;
    const at = ms(l.when);
    const whole = JSON.stringify(l);
    if (isOwnWrite(whole, at, own)) continue;
    if (isDeployActor(JSON.stringify([l.actor, l.metadata]), cfg.deployActors)) continue;
    const zone = auditZone(l, cfg.zones);
    if (!inZones(zone, cfg.zones)) continue;
    const type = l.resource?.type ?? "";
    const resource = `${type}${l.resource?.id ? ` ${l.resource.id}` : ""}`.trim() || "—";
    const since = new Date(Math.max(0, at - 60_000)).toISOString();
    out.push({
      key: `audit:${l.id}`, topic: /dns/i.test(type) ? "dns" : "audit", place: zone ? `zone:${zone}` : "account", at,
      line: [utc(at), one(l.actor?.email ?? l.actor?.type ?? "unknown actor"), `${one(l.action?.type ?? "?")}${l.action?.result === false ? " (failed)" : ""}`, one(resource),
        `read: orca cloudflare audit --resource ${one(l.resource?.id ?? type) || "?"} --since ${since}`].join(" · "),
    });
  }
  return out;
}

/** The new boundary of the audit cursor: the newest entry's time, and the ids AT that time (the next
 *  read starts there, inclusive). Pure. */
export function nextAudit(logs: AuditLog[], prev: { auditAt: string; seen: string[] }): { auditAt: string; seen: string[] } {
  const newest = logs.reduce((m, l) => Math.max(m, ms(l.when)), ms(prev.auditAt));
  if (newest <= ms(prev.auditAt)) return { auditAt: prev.auditAt, seen: [...new Set([...prev.seen, ...logs.map((l) => l.id)])].slice(-SEEN_MAX) };
  const iso = new Date(newest).toISOString();
  return { auditAt: iso, seen: logs.filter((l) => ms(l.when) === newest).map((l) => l.id).slice(-SEEN_MAX) };
}

/** Workers that appeared, went, or changed since the last poll. Pure. */
export function workerDiff(prev: WatchState["workers"], scripts: Script[]): { added: Script[]; removed: string[]; changed: Script[] } {
  const now = new Set(scripts.map((s) => s.id));
  return {
    added: scripts.filter((s) => !prev[s.id]),
    removed: Object.keys(prev).filter((n) => !now.has(n)),
    changed: scripts.filter((s) => prev[s.id] && prev[s.id]!.modified !== s.modified_on),
  };
}

/** A Worker's newest deployment as a line: a rollback is a `worker` change, any other a `deploy`.
 *  Undefined when it is the deployment already seen, or Orca's own rollback. Pure. */
export function deployItem(name: string, d: Deployment | undefined, prevDeployment: string | undefined, own: OwnWrite[]): WatchItem | undefined {
  if (!d || d.id === prevDeployment) return undefined;
  const at = ms(d.created_on);
  const rollback = d.annotations?.["workers/triggered_by"] === "rollback";
  if (rollback && isOwnWrite(`${name} ${JSON.stringify(d.versions ?? [])}`, at, own)) return undefined;
  const versions = (d.versions ?? []).map((v) => `${v.version_id} ${v.percentage}%`).join(", ");
  return {
    key: `deploy:${name}:${d.id}`, topic: rollback ? "worker" : "deploy", place: "account", at,
    line: [utc(at), one(d.author_email ?? "unknown author"), rollback ? "rollback" : "deploy", `Worker ${one(name)}`, `${d.id}${d.source ? ` via ${one(d.source)}` : ""}${versions ? ` (${one(versions)})` : ""}`,
      `read: orca cloudflare deployments ${one(name)}`].join(" · "),
  };
}

/** Custom domains added, removed or moved to another Worker, in watched zones. Pure. */
export function domainItems(prev: WatchState["domains"], domains: Domain[], polledAt: string, cfg: CloudflareConfig, own: OwnWrite[], now: number): WatchItem[] {
  const cur = new Map(domains.map((d) => [d.hostname.toLowerCase(), d]));
  const out: WatchItem[] = [];
  const item = (host: string, op: string, what: string, zone: string | undefined): void => {
    if (!inZones(zone, cfg.zones) || isOwnWrite(host, now, own)) return;
    out.push({ key: `domain:${host}:${op}:${polledAt}`, topic: "domain", place: zone ? `zone:${zone.toLowerCase()}` : "account", at: now,
      line: [utc(now), `custom domain ${one(host)} ${what}`, "read: orca cloudflare domains"].join(" · ") });
  };
  for (const [host, d] of cur) {
    const p = prev[host];
    if (!p) item(host, `+${d.service}`, `added → Worker ${one(d.service)}`, d.zone_name);
    else if (p.service !== d.service) item(host, `~${d.service}`, `moved from Worker ${one(p.service)} to ${one(d.service)}`, d.zone_name);
  }
  for (const [host, p] of Object.entries(prev)) if (!cur.has(host)) item(host, `-${p.service}`, `removed (was Worker ${one(p.service)})`, p.zone);
  return out;
}

/** Workers whose error rate crossed the threshold this window, and the new alerting set. A Worker
 *  alerts once, then not again until it is back under the threshold. Pure. */
export function errorItems(totals: Map<string, WorkerTotals>, alerting: string[], cfg: CloudflareConfig, window: { since: number; until: number }): { items: WatchItem[]; alerting: string[] } {
  const over = new Set<string>();
  const items: WatchItem[] = [];
  const minutes = Math.max(1, Math.round((window.until - window.since) / 60_000));
  for (const [name, t] of totals) {
    const pct = t.requests ? (t.errors / t.requests) * 100 : 0;
    if (t.requests < cfg.minRequests || pct < cfg.errorRatePct) continue;
    over.add(name);
    if (alerting.includes(name)) continue;
    items.push({
      key: `errors:${name}:${window.since}`, topic: "errors", place: "account", at: window.until,
      line: [utc(window.until), `Worker ${one(name)}`, `${pct.toFixed(2)}% errors (${t.errors} of ${t.requests} requests) in the last ${minutes} min, threshold ${cfg.errorRatePct}%`,
        `read: orca cloudflare analytics --worker ${one(name)} --since 1h`].join(" · "),
    });
  }
  return { items, alerting: [...over].sort() };
}

const TITLE: Record<CloudflareTopic, (n: number) => string> = {
  audit: (n) => `${n} audit-log ${n === 1 ? "entry" : "entries"}`,
  dns: (n) => `${n} DNS ${n === 1 ? "change" : "changes"}`,
  deploy: (n) => `${n} Worker ${n === 1 ? "deploy" : "deploys"}`,
  worker: (n) => `${n} Worker ${n === 1 ? "change" : "changes"} (new, deleted or rolled back)`,
  domain: (n) => `${n} custom domain ${n === 1 ? "change" : "changes"}`,
  errors: (n) => `${n} Worker${n === 1 ? "" : "s"} over the error threshold`,
};

/** One envelope per topic and place, its lines oldest first. The key hashes the items' keys, so the
 *  same batch handed in twice (a poll retried after a failure) is a core duplicate. Pure. */
export function batchEnvelopes(connectionId: string, account: string, items: WatchItem[]): InboundEnvelope[] {
  const groups = new Map<string, WatchItem[]>();
  for (const i of items) { const k = `${i.topic}|${i.place}`; groups.set(k, [...(groups.get(k) ?? []), i]); }
  return [...groups.values()].map((g) => {
    const sorted = [...g].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
    const { topic, place } = sorted[0]!;
    const hash = createHash("sha256").update(sorted.map((i) => i.key).join("\n")).digest("hex").slice(0, 16);
    const where = place === "account" ? `account ${account}` : `zone ${place.slice("zone:".length)}`;
    const title = `Cloudflare: ${TITLE[topic](sorted.length)}`;
    return {
      key: `cloudflare:${connectionId}:${topic}:${place}:${hash}`,
      topic: `ext.cloudflare.${topic}` as const,
      at: sorted.at(-1)!.at || Date.now(),
      source: { adapter: "cloudflare", integrationId: connectionId, channel: place, ...(place === "account" ? {} : { parents: ["account"] }) },
      display: { sender: "Cloudflare", place: where },
      title,
      text: [`${title} in ${where}. Each line: time · actor · action · resource · a read command to dig in.`, ...sorted.map((i) => `- ${i.line.slice(0, LINE_MAX)}`)].join("\n"),
      raw: { keys: sorted.map((i) => i.key) },
    };
  });
}

// ── The adapter ──────────────────────────────────────────────────────────────────────────────────

export type PollResult = { items: number; ingested: number; problems: string[]; error?: string; rateLimited?: boolean };

/** The wait before the next tick: the interval, doubled for each rate-limited tick in a row. Pure. */
export function pollDelayMs(pollSeconds: number, limitedInARow: number): number {
  return Math.min(pollSeconds * 1000 * 2 ** Math.max(0, limitedInARow), Math.max(MAX_BACKOFF_MS, pollSeconds * 1000));
}
const isRateLimit = (e: unknown): boolean => /\(429\)|rate.?limit/i.test(errText(e));
export type CloudflareDeps = { base?: string; fetch?: typeof fetch; now?: () => Date; env?: Record<string, string | undefined>; ownWrites?: () => Promise<OwnWrite[]> };
export type CloudflareAdapter = Adapter & { poll(): Promise<PollResult> };
type Health = { ok: boolean; detail?: string; lastEventAt?: number; lastPollAt?: number };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function cloudflareAdapter(connection: Connection, deps: CloudflareDeps = {}): CloudflareAdapter {
  const env = deps.env ?? process.env;
  const cfg = cloudflareConfig(connection.config, env);
  const now = deps.now ?? (() => new Date());
  let ctx: AdapterContext | undefined;
  let accountName: string | undefined;
  let lastEventAt: number | undefined, lastPollAt: number | undefined;
  let inFlight: Promise<PollResult> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let limitedInARow = 0;

  // The registry loaded a stored secret before start (and loads it again on rotation).
  const fromStore = storedSecretName(tokenRef(connection)) !== undefined;
  const token = () => ctx?.secret() ?? secretValue(tokenRef(connection), env);
  const api = (): Client => client({ token: token() ?? "", account: cfg.accountId ?? "", env: { ORCA_CLOUDFLARE_API: env.ORCA_CLOUDFLARE_API }, ...(deps.base ? { base: deps.base } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const missing = (): string | undefined =>
    !token() ? (fromStore ? `${tokenSource(connection)} is not loaded on this bridge` : `${tokenRef(connection)} is not set on this bridge`) : !cfg.accountId ? "the account id is not set (config accountId)" : undefined;

  async function account(c: Client): Promise<string> {
    const a = await c.get<{ name?: string }>(c.acct(""), PERMISSIONS.account);
    return a?.name ?? cfg.accountId!;
  }

  async function pollNow(): Promise<PollResult> {
    if (!ctx) return { items: 0, ingested: 0, problems: [], error: "not started" };
    const c = api();
    const t = now();
    const iso = t.toISOString();
    const prev = parseState(await ctx.cursor.get());
    const own = await (deps.ownWrites ?? readOwnWrites)().catch(() => [] as OwnWrite[]);
    const next: WatchState = prev ? structuredClone(prev) : { v: 1, polledAt: iso, auditAt: iso, seen: [], workers: {}, domains: {}, alerting: [] };
    const items: WatchItem[] = [];
    const problems: string[] = [];
    // A 429 ends the tick: the steps after it keep their last state and run on the next tick.
    let rateLimited = false;
    const step = async (name: string, fn: () => Promise<void>) => {
      if (rateLimited) return;
      try { await fn(); } catch (e) { problems.push(`${name}: ${errText(e)}`); if (isRateLimit(e)) rateLimited = true; }
    };

    await step("audit log", async () => {
      if (!prev) return; // the first poll starts the cursor at now: no history replayed
      const q = `since=${encodeURIComponent(prev.auditAt)}&before=${encodeURIComponent(iso)}&direction=asc`;
      const logs = await c.all<AuditLog>(c.acct(`/audit_logs?${q}`), PERMISSIONS.audit, 1000);
      items.push(...auditItems(logs, new Set(prev.seen), cfg, own));
      Object.assign(next, nextAudit(logs, prev));
    });
    await step("workers", async () => {
      const scripts = await c.get<Script[]>(c.acct("/workers/scripts"), PERMISSIONS.scripts) ?? [];
      const before = prev?.workers ?? {};
      const diff = workerDiff(before, scripts);
      const newest = async (name: string) =>
        (await c.get<{ deployments?: Deployment[] }>(c.acct(`/workers/scripts/${encodeURIComponent(name)}/deployments`), PERMISSIONS.scripts))?.deployments?.[0];
      next.workers = Object.fromEntries(scripts.map((s) => [s.id, { ...before[s.id], modified: s.modified_on, created: s.created_on }]));
      if (!prev) return; // the first poll is the baseline
      // At most MAX_DEPLOYMENT_READS deployment reads a tick: a Worker past the cap keeps its old
      // state (a new one stays unknown), so the next tick sees it as new or changed again.
      let reads = 0;
      const budget = () => reads++ < MAX_DEPLOYMENT_READS;
      for (const s of diff.added) {
        if (!budget()) { delete next.workers[s.id]; continue; }
        const d = await newest(s.id).catch(() => undefined);
        next.workers[s.id]!.deployment = d?.id;
        if (isOwnWrite(s.id, ms(s.created_on), own)) continue;
        const at = ms(s.created_on) || t.getTime();
        items.push({ key: `worker:+${s.id}:${s.created_on ?? ""}`, topic: "worker", place: "account", at,
          line: [utc(at), one(d?.author_email ?? "unknown author"), "new Worker", one(s.id), `read: orca cloudflare deployments ${one(s.id)}`].join(" · ") });
      }
      for (const name of diff.removed) {
        if (isOwnWrite(name, t.getTime(), own)) continue;
        items.push({ key: `worker:-${name}:${before[name]?.modified ?? ""}`, topic: "worker", place: "account", at: t.getTime(),
          line: [utc(t.getTime()), "deleted Worker", one(name), `read: orca cloudflare audit --resource ${one(name)} --since ${prev.polledAt}`].join(" · ") });
      }
      for (const s of diff.changed) {
        if (!budget()) { next.workers[s.id] = before[s.id]!; continue; }
        const d = await newest(s.id);
        const it = deployItem(s.id, d, before[s.id]?.deployment, own);
        if (d) next.workers[s.id]!.deployment = d.id;
        if (it) items.push(it);
      }
    });
    await step("custom domains", async () => {
      const domains = await c.get<Domain[]>(c.acct("/workers/domains"), PERMISSIONS.scripts) ?? [];
      if (prev) items.push(...domainItems(prev.domains, domains, prev.polledAt, cfg, own, t.getTime()));
      next.domains = Object.fromEntries(domains.map((d) => [d.hostname.toLowerCase(), { service: d.service, ...(d.zone_name ? { zone: d.zone_name.toLowerCase() } : {}) }]));
    });
    await step("analytics", async () => {
      // The window is the time since the last poll, at least 5 minutes: a short window is noise.
      const since = Math.min(prev ? ms(prev.polledAt) : t.getTime(), t.getTime() - 5 * 60_000);
      const totals = await workerTotals(c, new Date(since), t);
      const r = errorItems(totals, prev?.alerting ?? [], cfg, { since, until: t.getTime() });
      items.push(...r.items);
      next.alerting = r.alerting;
    });

    let ingested = 0;
    for (const e of batchEnvelopes(connection.id, accountName ?? cfg.accountId ?? "?", items)) {
      // A failed ingest throws out of the poll before the state is saved: the next poll makes the
      // same batch again, and the core drops the copy of any batch it already has.
      if (["new", "noted"].includes(await ctx.ingest(e))) { ingested++; lastEventAt = Date.now(); }
    }
    next.polledAt = iso;
    await ctx.cursor.set(JSON.stringify(next));
    lastPollAt = Date.now();
    const detail = problems.length ? problems.join("; ") : `connected to ${accountName ?? cfg.accountId}, ${Object.keys(next.workers).length} Workers watched`;
    await ctx.status({ ok: !problems.length, detail, lastPollAt, ...(lastEventAt ? { lastEventAt } : {}) });
    return { items: items.length, ingested, problems, ...(rateLimited ? { rateLimited } : {}) };
  }

  /** One poll at a time: a call while one runs waits for it, then polls again. */
  function poll(): Promise<PollResult> {
    const run = (inFlight ?? Promise.resolve()).catch(() => undefined).then(() => pollNow()).catch(async (e) => {
      const error = errText(e);
      await ctx?.status({ ok: false, detail: `poll failed: ${error}` }).catch(() => {});
      return { items: 0, ingested: 0, problems: [], error };
    });
    inFlight = run;
    return run;
  }

  function loop(signal: AbortSignal): void {
    if (signal.aborted) return;
    void poll().then((r) => {
      if (signal.aborted) return;
      limitedInARow = r.rateLimited ? limitedInARow + 1 : 0;
      timer = setTimeout(() => loop(signal), pollDelayMs(cfg.pollSeconds, limitedInARow));
    });
  }

  return {
    kind: "cloudflare",
    caps: CLOUDFLARE_CAPS,
    poll,
    async start(c) {
      ctx = c;
      const why = missing();
      if (why) throw new Error(why);
      accountName = await account(api()); // a bad token fails the start, and names the permission
      c.log(`watching account ${accountName} every ${cfg.pollSeconds}s`);
      loop(c.signal);
    },
    async stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inFlight?.catch(() => undefined);
      ctx = undefined;
    },
    async send(): Promise<SendResult> {
      return { ok: false, retryable: false, error: "the cloudflare adapter takes no posts (it only watches the account)" };
    },
    async health(): Promise<Health> {
      const polled = { ...(lastEventAt ? { lastEventAt } : {}), ...(lastPollAt ? { lastPollAt } : {}) };
      const why = missing();
      if (why) return { ok: false, detail: why, ...polled };
      try { accountName = await account(api()); return { ok: true, detail: `connected to ${accountName}`, ...polled }; }
      catch (e) { return { ok: false, detail: errText(e), ...polled }; }
    },
  };
}
