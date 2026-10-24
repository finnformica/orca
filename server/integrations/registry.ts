// The adapter registry (docs/research/integrations.md §3.3, phase 1). A factory per kind; one running
// adapter per `integration` row. Adapters start ONLY on a primary bridge (primary.held()), so a socket
// is opened by exactly one process. A row is pinned to the instance it names (`integration.instance`),
// or Automatic (`AUTO_INSTANCE`): then the primary that holds its lease runs it (`status.auto`). Each
// primary with the row's secret tries the lease on every sync; when the holder stops renewing (down,
// asleep, no longer primary), the lease ends and another primary takes it — the failover.
import * as db from "../db";
import * as primary from "../primary";
import { ORCA_SECRETS } from "../env";
import { AUTO_LEASE_MS, isAutomatic, leaseHolder, runsOn, secretRefRefusal, storedSecretName, type AdapterKind, type AdapterMeta, type InboundEnvelope, type VerbClasses } from "../../shared/integrations";
import type { Adapter, AdapterContext, AdapterFactory, Connection } from "./adapter";
import * as router from "./router";
import * as store from "./store";
import * as secretRefs from "./secretRefs";
import { SLACK_CAPS, slackAdapter } from "./adapters/slack";
import { WEBHOOK_CAPS, webhookAdapter } from "./adapters/webhook";
import { DISCORD_CAPS, discordAdapter } from "./adapters/discord";
import { emailAdapter, emailCaps } from "./adapters/email";
import { LINEAR_CAPS, linearAdapter } from "./adapters/linear";
import { CLOUDFLARE_CAPS, cloudflareAdapter, ensureDefaults as cloudflareDefaults } from "./adapters/cloudflare";
import { SLACK_VERBS } from "../slackTool";
import { CLOUDFLARE_VERBS } from "../cloudflare";

const factories = new Map<AdapterKind, AdapterFactory>();
const metas = new Map<AdapterKind, AdapterMeta>();
const running = new Map<string, { adapter: Adapter; connection: Connection; abort: AbortController }>();
const connectHooks = new Map<AdapterKind, (c: Connection) => Promise<void>>();
const cliVerbs = new Map<AdapterKind, VerbClasses>();

/** Register a kind. A later adapter (Discord, email, GitHub, Linear) adds one line here. `meta` is
 *  what Settings > Integrations shows for the kind (its card, its Connect form). */
export function register(kind: AdapterKind, factory: AdapterFactory, meta?: Omit<AdapterMeta, "kind">, onConnect?: (c: Connection) => Promise<void>): void {
  factories.set(kind, factory);
  if (meta) metas.set(kind, { kind, ...meta });
  if (onConnect) connectHooks.set(kind, onConnect);
}

/** A kind's setup on its FIRST connect (its default links and subscriptions), if it has one. */
export async function onConnect(c: Connection): Promise<void> {
  await connectHooks.get(c.kind)?.(c);
}

/** The meta of one kind, if registered with one. */
export const meta = (kind: AdapterKind): AdapterMeta | undefined => metas.get(kind);
/** Declare the verb classes of a kind that has an `orca <kind>` CLI but no adapter yet (the account
 *  policy, docs/integrations/POLICY.md). A kind's `meta.verbs` wins over this. */
export function registerVerbs(kind: AdapterKind, verbs: VerbClasses): void { cliVerbs.set(kind, verbs); }
/** The verb classes of a kind, for `integrationAccessRefusal`. */
export const verbsFor = (kind: AdapterKind): VerbClasses => metas.get(kind)?.verbs ?? cliVerbs.get(kind) ?? {};

register("slack", slackAdapter, {
  label: "Slack", caps: SLACK_CAPS, place: "channel", secretExample: "SLACK_TOKEN", verbs: SLACK_VERBS,
  help: "Your user token (xoxp-…): Orca posts as you and polls your mentions, DMs and group DMs each minute. Link `im` / `mpim` for DMs. Setup: docs/integrations/slack.md.",
});
register("webhook", webhookAdapter, { label: "Webhook", caps: WEBHOOK_CAPS, place: "hook", secretExample: "ORCA_SECRET_WEBHOOK", help: "Signed POSTs to /api/integrations/<id>/inbound (HMAC sha256 of the body)." });
register("discord", discordAdapter, {
  label: "Discord", caps: DISCORD_CAPS, place: "channel", secretExample: "ORCA_SECRET_DISCORD_BOT",
  config: [
    { key: "dmLink", label: "DM link id (optional)", placeholder: "the link DMs go to; empty = the * link" },
    { key: "threads", label: "Threads (optional)", placeholder: "true = a thread for each request; empty = reply in place" },
  ],
  help: "A bot token with the Message Content intent. Only one bridge runs it, also on Automatic. Setup: docs/integrations/discord.md.",
});
register("email", emailAdapter, {
  label: "Email", caps: emailCaps({ imap: { host: "" }, outbound: "smtp" }), place: "address", secretExample: "ORCA_SECRET_EMAIL_IMAP",
  help: "One mailbox only Orca reads. The secret is the IMAP password. Link each person's address. Setup: docs/integrations/email.md.",
  config: [
    { key: "address", label: "Orca's address", placeholder: "orca@yourdomain.com" },
    { key: "imapHost", label: "IMAP host", placeholder: "imap.gmail.com" },
    { key: "imapPort", label: "IMAP port", placeholder: "993" },
    { key: "outbound", label: "Outbound (smtp, resend or none)", placeholder: "smtp" },
    { key: "smtpHost", label: "SMTP host", placeholder: "smtp.gmail.com" },
    { key: "smtpPort", label: "SMTP port", placeholder: "465" },
    { key: "smtpSecretRef", label: "SMTP password variable", placeholder: "ORCA_SECRET_EMAIL_SMTP" },
    { key: "resendSecretRef", label: "Resend key variable", placeholder: "ORCA_SECRET_RESEND" },
    { key: "allowedSenders", label: "Allowed senders (comma-separated; @domain for a domain)", placeholder: "finn@yourdomain.com" },
    { key: "authservId", label: "Receiving server's authserv-id", placeholder: "mx.google.com" },
  ],
});

register("linear", linearAdapter, {
  label: "Linear", caps: LINEAR_CAPS, place: "team or project", secretExample: "ORCA_SECRET_LINEAR",
  config: [
    { key: "pollSeconds", label: "Poll every (seconds)", placeholder: "60" },
    { key: "userId", label: "Linear user id (optional)", placeholder: "empty = the key's own user" },
    { key: "lookbackMinutes", label: "First poll reads back (minutes)", placeholder: "0" },
  ],
  help: "A personal API key. Orca polls; it needs no webhook. Link team:<KEY>, project:<id> or *. Setup: docs/integrations/linear.md.",
});

register("cloudflare", (c) => cloudflareAdapter(c), {
  label: "Cloudflare", caps: CLOUDFLARE_CAPS, place: "place (* = the whole account, zone:<name>)",
  secretExample: "ORCA_SECRET_CLOUDFLARE", secretDefault: "ORCA_SECRET_CLOUDFLARE",
  // The class of each `orca cloudflare` verb, for the account policy (POLICY.md): the ONE table.
  verbs: CLOUDFLARE_VERBS,
  config: [
    { key: "accountId", label: "Account id", placeholder: "32 hex characters, from the account home page" },
    { key: "pollSeconds", label: "Poll every (seconds, at least 30)", placeholder: "120" },
    { key: "errorRatePct", label: "Worker error-rate threshold (%)", placeholder: "5" },
    { key: "minRequests", label: "Fewest requests for an error alert", placeholder: "100" },
    { key: "zones", label: "Zones to watch (comma-separated; empty = all)", placeholder: "example.com" },
    { key: "deployActors", label: "Deploy actors to leave out (comma-separated)", placeholder: "github" },
  ],
  help: "An account API token, in Orca's secret store (Stored secret) or a secret variable. Orca polls the account (audit log, deploys, Worker errors, custom domains, DNS) and tells the orchestrator; it takes no posts. Setup: docs/integrations/cloudflare.md.",
}, cloudflareDefaults);

/** Every registered kind with what the Settings page shows for it. A kind with no meta gets a plain one. */
export function kinds(): AdapterMeta[] {
  return [...factories.keys()].map((kind) => metas.get(kind) ?? {
    kind, label: kind, caps: { inbound: "none", outbound: true, threads: false, edits: false, reactions: false, attachments: false, maxTextLength: 4000 },
  });
}

/** Whether this process may run `c` now: enabled, this process primary, and the row pinned to this
 *  instance or Automatic with this instance's live lease. */
export const runsHere = (c: Pick<Connection, "instance" | "enabled" | "auto">, here = db.instanceName(), isPrimary = primary.held(), now = Date.now()): boolean =>
  runsOn(c, here, isPrimary, now);

/** Whether this process has the row's secret: the variable is set, and each stored secret it names
 *  (`secret:<name>`, its secret_ref or a config `…Ref`) is in `readable` — the store's names this
 *  bridge's key can decrypt (secretRefs.readable). No secret: true. */
export const secretHere = (c: Pick<Connection, "secretRef" | "config">, env: Record<string, string | undefined> = process.env, readable: Set<string> = new Set()): boolean =>
  (!c.secretRef || storedSecretName(c.secretRef) !== undefined || !!env[c.secretRef])
  && secretRefs.storedNames({ secretRef: c.secretRef, config: c.config ?? {} }).every((n) => readable.has(n));

export function context(connection: Connection, abort: AbortController): AdapterContext {
  return {
    connection,
    secret: () => secretRefs.secretValue(connection.secretRef),
    ingest: (e: InboundEnvelope) => router.ingest(connection.id, e),
    cursor: { get: () => store.cursor(connection.id), set: (v) => store.setCursor(connection.id, v) },
    status: (s) => store.setIntegrationStatus(connection.id, { ...s, at: Date.now() }),
    log: (msg) => console.log(`orca: integration ${connection.kind}/${connection.id}: ${msg}`),
    signal: abort.signal,
  };
}

/** Start one connection, unless it is already running. A failed start is logged and recorded. */
export async function startOne(connection: Connection): Promise<boolean> {
  if (running.has(connection.id)) return true;
  const factory = factories.get(connection.kind);
  if (!factory) { console.error(`orca: integration ${connection.id}: no adapter for kind "${connection.kind}"`); return false; }
  const refusal = secretRefRefusal(connection.secretRef, ORCA_SECRETS);
  if (refusal) { console.error(`orca: integration ${connection.id}: ${refusal}`); return false; }
  const abort = new AbortController();
  const adapter = factory(connection);
  try {
    await secretRefs.load(connection); // stored secrets into memory first: a missing one fails the start
    await adapter.start(context(connection, abort));
    running.set(connection.id, { adapter, connection, abort });
    await store.setIntegrationStatus(connection.id, { ok: true, startedAt: Date.now(), error: null }).catch(() => {});
    return true;
  } catch (e) {
    abort.abort();
    const error = e instanceof Error ? e.message : String(e);
    console.error(`orca: integration ${connection.id} did not start: ${error}`);
    await store.setIntegrationStatus(connection.id, { ok: false, error, at: Date.now() }).catch(() => {});
    return false;
  }
}

/** Start every enabled integration this instance runs, and stop any that no longer should (a row
 *  disabled, moved to another instance, or deleted). Idempotent: run it at startup and after a
 *  config change. A secondary bridge starts nothing. */
export async function sync(now = Date.now()): Promise<string[]> {
  const here = db.instanceName();
  const rows = primary.held() ? await store.integrations(here) : [];
  // Stored secrets (`secret:<name>`): which this bridge can decrypt, read only when a row names one.
  const usesStored = rows.some((c) => secretRefs.storedNames(c).length);
  const readable = usesStored ? await secretRefs.readable().catch(() => new Set<string>()) : new Set<string>();
  for (const c of rows) {
    if (!isAutomatic(c.instance) || !c.enabled) continue;
    // Only a primary with the secret contends, so the lease goes where the connection can start.
    const has = secretHere(c, process.env, readable);
    await store.markSecretMissing(c.id, here, !has, now);
    if (has) { const lease = await store.claimAuto(c.id, here, now, AUTO_LEASE_MS); if (lease) c.auto = lease; else delete c.auto; }
    else if (leaseHolder(c.auto, now) === here) { await store.releaseAuto(c.id, here); delete c.auto; }
  }
  const mine = rows.filter((c) => runsHere(c, here, true, now));
  const want = new Set(mine.map((c) => c.id));
  for (const id of [...running.keys()]) if (!want.has(id)) await stopOne(id);
  // A stored secret that changed (rotated, deleted) restarts its adapter, which loads it again.
  if (usesStored) {
    const secretRows = await db.secrets().catch(() => undefined);
    for (const c of mine) if (running.has(c.id) && secretRows && await secretRefs.stale(c, secretRows)) await stopOne(c.id);
  }
  for (const c of mine) await startOne(c);
  return [...running.keys()];
}

export async function stopOne(id: string): Promise<void> {
  const r = running.get(id);
  if (!r) return;
  running.delete(id);
  r.abort.abort();
  await r.adapter.stop().catch((e) => console.error(`orca: integration ${id} stop failed`, e));
  // An Automatic row: let its lease go, so another primary starts it now, not when the lease ends.
  if (isAutomatic(r.connection.instance)) await store.releaseAuto(id, db.instanceName()).catch(() => {});
}

export async function stopAll(): Promise<void> {
  for (const id of [...running.keys()]) await stopOne(id);
}

/** The running adapter for an integration on this process (the dispatcher's link sink). */
export const adapterFor = (id: string): Adapter | undefined => running.get(id)?.adapter;
export const runningIds = (): string[] => [...running.keys()];

/** An HTTP request for `/api/integrations/<id>/inbound`. */
export async function handle(id: string, req: Request, body: string): Promise<Response> {
  const r = running.get(id);
  if (!r) {
    const row = await store.integration(id).catch(() => undefined);
    const elsewhere = row && (isAutomatic(row.instance) ? leaseHolder(row.auto, Date.now()) : row.instance);
    const where = row ? (!row.enabled ? "it is disabled" : elsewhere && elsewhere !== db.instanceName() ? `it runs on ${elsewhere}` : "it is not running on this bridge") : "no such integration";
    return Response.json({ error: `integration ${id}: ${where}` }, { status: 404 });
  }
  if (!r.adapter.handle) return Response.json({ error: `integration ${id} (${r.connection.kind}) takes no HTTP requests` }, { status: 405 });
  return r.adapter.handle(req, body);
}

/** Health of every integration this process runs (diagnostics, the later settings card). */
export async function health(): Promise<Record<string, { kind: string; ok: boolean; detail?: string; lastEventAt?: number; lastPollAt?: number }>> {
  const out: Record<string, { kind: string; ok: boolean; detail?: string; lastEventAt?: number; lastPollAt?: number }> = {};
  for (const [id, r] of running) {
    out[id] = { kind: r.connection.kind, ...(await r.adapter.health().catch((e) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }))) };
  }
  return out;
}
