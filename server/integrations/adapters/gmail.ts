// The Gmail adapter (setup: docs/integrations/gmail.md). The user connects their own Gmail with
// "Connect with Google" (OAuth 2.0, code + PKCE: ./gmail/oauth.ts); Orca never sees a password. Each
// account is its own integration row (for example "personal" and "work"), with its own refresh token.
//
// Scopes follow the account's access (./gmail/google.ts scopesFor): read = openid, userinfo.email and
// gmail.readonly; read-write adds gmail.send (asked for alone on a later reconnect, incremental). The
// send verb is NOT built yet: `send` refuses and `caps.outbound` is false. Orca changes no label and
// marks no mail read (no gmail.modify; the History API cursor is its position).
//
// Events: the core's account policy (docs/integrations/POLICY.md). With events `off` the loop makes no
// Gmail call (it rereads the row each tick, so the card's change applies at once); `trigger` and
// `record` poll, and the core decides whether an agent wakes. No public address, so no Pub/Sub push.
// Every `pollSeconds` (30, at least 10) the primary bridge reads the History API from its cursor
// (`{ historyId, account }` in integration_cursor): each message added (or labelled) since. Only a
// message that matches the row's Gmail `query` (default `label:Orca OR to:<you>+orca@<domain>`) goes
// on: Gmail itself decides the match (the query plus `rfc822msgid:` of each new message), so the
// search syntax is Gmail's. Every other mail stays private: Orca reads its labels and its Message-ID
// header only. A matching mail passes the mail gate (not automated, `allowedSenders` when set, an
// aligned DKIM/SPF/DMARC pass from mx.google.com unless the account sent it itself), then
// `ctx.ingest` as `ext.gmail.message`, so the core's gate, links, people and subscriptions apply.
// The channel is the sender's address (one link per correspondent, or the catch-all `*`); the
// thread is Gmail's own thread id. The MIME parse is the email adapter's (./email/mime.ts).
import * as attachments from "../../attachments";
import { clip, inboundEnvelope, type Capabilities, type SendResult } from "../../../shared/integrations";
import type { Adapter, AdapterContext, Connection } from "../adapter";
import { authVerdict, isAutomated, parseMail, senderAllowed, type ParsedMail } from "./email/mime";
import { inboundText } from "./email";
import { fromBase64Url, GoogleError, header, SCOPE, type Gmail } from "./gmail/google";
import * as oauth from "./gmail/oauth";
import * as store from "../store";

export type GmailConfig = {
  clientId: string;
  /** A Gmail search. Empty = `label:Orca OR to:<local>+orca@<domain>` of the connected account. */
  query?: string;
  pollSeconds: number;
  /** Addresses or `@domain`s. Empty = any sender the query lets in (the core's gate still applies). */
  allowedSenders: string[];
  /** Require Google's DKIM/SPF/DMARC pass for the From domain (default true). */
  checkAuth: boolean;
  keepQuoted: boolean;
};

export const GMAIL_AUTHSERV = "mx.google.com";
/** The poll interval of an account with events on: 30 s unless set, never below 10 s. A quiet tick is ONE
 *  users.history.list call (Gmail's quota is per user, and a minute of quiet costs 2 calls). Only the
 *  tests' fake Gmail (the `apiUrl` override) may poll faster. */
export const GMAIL_POLL_DEFAULT_S = 30;
export const GMAIL_POLL_MIN_S = 10;
/** At most this many new messages are checked in one poll; the rest wait for the next one. */
export const MAX_PER_POLL = 200;
/** Gmail's OR group size for `rfc822msgid:` checks (one search for each group). */
const MATCH_GROUP = 20;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown, d: number) => (typeof v === "number" ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : typeof v === "string" && /^(true|false)$/i.test(v.trim()) ? v.trim().toLowerCase() === "true" : d);

/** The config with defaults (every value may be a string, as the Settings form saves it), or why it is unusable. */
export function gmailConfig(raw: Record<string, unknown>): { config: GmailConfig } | { error: string } {
  const clientId = str(raw.clientId);
  if (!clientId) return { error: "config.clientId is required: the OAuth client id from Google Cloud" };
  const senders = Array.isArray(raw.allowedSenders) ? raw.allowedSenders.map(String) : String(raw.allowedSenders ?? "").split(/[\s,;]+/);
  return { config: {
    clientId, ...(str(raw.query) ? { query: str(raw.query) } : {}),
    pollSeconds: Math.max(typeof raw.apiUrl === "string" && raw.apiUrl ? 0.05 : GMAIL_POLL_MIN_S, num(raw.pollSeconds, GMAIL_POLL_DEFAULT_S)),
    allowedSenders: senders.map((s) => s.trim().toLowerCase()).filter(Boolean),
    checkAuth: bool(raw.checkAuth, true),
    keepQuoted: bool(raw.keepQuoted, false),
  } };
}

/** The default query for an account: the `Orca` label, or mail to its `+orca` alias. Pure. */
export function defaultQuery(account: string): string {
  const [local, domain] = account.toLowerCase().split("@");
  return local && domain ? `label:Orca OR to:${local}+orca@${domain}` : "label:Orca";
}

/** The query that finds which of `messageIds` (RFC 822 Message-IDs) match `query`. Pure. */
export const matchQuery = (query: string, messageIds: string[]): string =>
  `(${query}) {${messageIds.map((m) => `rfc822msgid:${m.replace(/^<|>$/g, "")}`).join(" ")}}`;

/** Read only: no outbound side, whatever the config says. */
export const GMAIL_CAPS: Capabilities = {
  inbound: "poll", outbound: false, threads: true, edits: false, reactions: false, attachments: false, maxTextLength: 100_000,
};

/** The class of each `orca gmail` verb, in the access policy's VerbClasses shape (branch
 *  orca/integration-access-policy: `meta.verbs`). Both are reads; Gmail has no write verb. */
export const GMAIL_VERBS = { search: "read", read: "read" } as const;


/** Why the mail gate drops a matching message, or undefined to let it in. Pure. */
export function gmailGate(m: ParsedMail, labels: readonly string[], cfg: Pick<GmailConfig, "allowedSenders" | "checkAuth">, account: string): string | undefined {
  if (!m.from) return "no From address";
  if (labels.includes("DRAFT")) return "a draft";
  if (labels.includes("SENT") && !labels.includes("INBOX")) return "a mail you sent (not one you got)";
  if (isAutomated(m.headers)) return "automated mail (Orca's own, an auto-reply, a bounce or a list)";
  if (cfg.allowedSenders.length && !senderAllowed(m.from.address, cfg.allowedSenders)) return `${m.from.address} is not in allowedSenders`;
  // Gmail made this message itself for the account (a note to your own +orca alias): authentic.
  const own = m.from.address === account && labels.includes("SENT");
  if (cfg.checkAuth && !own) {
    const auth = authVerdict(m.headers, m.from.address, { authservId: GMAIL_AUTHSERV });
    if (!auth.ok) return auth.reason;
  }
  return undefined;
}

export const threadUrl = (account: string, threadId: string): string => `https://mail.google.com/mail/u/${encodeURIComponent(account)}/#all/${threadId}`;

type Cursor = { historyId: string; account: string };
const readCursor = (v: string | undefined): Cursor | undefined => {
  try { const c = JSON.parse(v ?? ""); return typeof c?.historyId === "string" && typeof c?.account === "string" ? c : undefined; } catch { return undefined; }
};

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((r) => {
  if (signal.aborted) return r();
  const t = setTimeout(r, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
});
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function gmailAdapter(connection: Connection): Adapter {
  const parsed = gmailConfig(connection.config);
  const cfg = "config" in parsed ? parsed.config : undefined;
  const local = new AbortController();
  let ctx: AdapterContext | undefined;
  let account: string | undefined;
  let lastEventAt: number | undefined;
  let lastPollAt: number | undefined;
  let state: { ok: boolean; detail: string } = { ok: false, detail: "not started" };
  const gmail = (): Gmail => oauth.gmailFor(connection);

  const report = async (ok: boolean, detail: string) => {
    state = { ok, detail };
    await ctx?.status({ ok, detail, ...(lastEventAt ? { lastEventAt } : {}), ...(lastPollAt ? { lastPollAt } : {}) }).catch(() => {});
  };

  async function me(g: Gmail): Promise<{ account: string; historyId: string }> {
    const p = await g.profile();
    account = p.emailAddress.toLowerCase();
    return { account, historyId: p.historyId };
  }

  /** Keep each attachment as an Orca attachment; name the ones that could not be kept. */
  async function keep(m: ParsedMail): Promise<{ refs: string[]; skipped: string[] }> {
    const refs: string[] = [], skipped: string[] = [];
    for (const a of m.attachments) {
      if (a.bytes.byteLength > attachments.MAX_ATTACHMENT_BYTES) { skipped.push(`${a.filename} is over ${attachments.MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`); continue; }
      try { refs.push(...(await attachments.store([new File([new Uint8Array(a.bytes)], a.filename, { type: a.mimeType })]))); }
      catch (e) { skipped.push(`${a.filename} (${errText(e)})`); }
    }
    return { refs, skipped };
  }

  /** One matching message through the mail gate into the core. */
  async function take(g: Gmail, id: string): Promise<string> {
    const msg = await g.raw(id);
    if (!msg.raw) return "no raw content";
    const m = parseMail(fromBase64Url(msg.raw));
    const why = gmailGate(m, msg.labelIds ?? [], cfg!, account!);
    if (why) return `skipped: ${why}`;
    const { refs, skipped } = await keep(m);
    const env = inboundEnvelope({
      adapter: "gmail", integrationId: connection.id, channel: m.from!.address,
      eventId: `${connection.id}:${msg.id}`,
      from: { adapter: "gmail", id: m.from!.address, ...(m.from!.name ? { name: m.from!.name } : {}) },
      text: inboundText(m, { keepQuoted: cfg!.keepQuoted, skipped }),
      thread: { adapter: "gmail", externalId: msg.threadId, messageId: msg.id },
      attachments: refs,
      at: Number(msg.internalDate) || m.date || Date.now(),
      raw: { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds ?? [] },
    });
    lastEventAt = Date.now();
    return ctx!.ingest({ ...env, ...(m.subject ? { title: m.subject } : {}), link: { url: threadUrl(account!, msg.threadId) }, display: { place: clip(m.subject || "(no subject)", 80) } });
  }

  /** The ids among `ids` that match the query (Gmail decides). Reads only labels and Message-ID. */
  async function matching(g: Gmail, ids: string[]): Promise<string[]> {
    const byMsgId = new Map<string, string>();
    for (const id of ids) {
      const meta = await g.metadata(id, ["Message-ID"]).catch((e) => { if (e instanceof GoogleError && e.status === 404) return undefined; throw e; });
      const mid = meta && header(meta, "Message-ID")?.trim();
      if (meta && mid && !(meta.labelIds ?? []).includes("DRAFT")) byMsgId.set(mid, id);
    }
    const query = cfg!.query ?? defaultQuery(account!);
    const hit = new Set<string>();
    const mids = [...byMsgId.keys()];
    for (let i = 0; i < mids.length; i += MATCH_GROUP) {
      const group = mids.slice(i, i + MATCH_GROUP);
      const r = await g.list(matchQuery(query, group), 100);
      for (const ref of r.messages ?? []) if (ids.includes(ref.id)) hit.add(ref.id);
    }
    return ids.filter((id) => hit.has(id));
  }

  /** One poll: the history since the cursor, the matching messages in, the cursor on. */
  async function poll(): Promise<string> {
    const g = gmail();
    const cur = readCursor(await ctx!.cursor.get());
    if (!account || !cur || cur.account !== account) {
      const p = await me(g);
      if (!cur || cur.account !== p.account) {
        // A first connect, or another account: begin at now, never replay the mailbox.
        await ctx!.cursor.set(JSON.stringify({ historyId: p.historyId, account: p.account }));
        return `watching ${p.account} from now`;
      }
    }
    const added = new Map<string, true>();
    let latest = cur!.historyId;
    let pageToken: string | undefined;
    try {
      do {
        const r = await g.history(cur!.historyId, pageToken);
        for (const h of r.history ?? []) {
          for (const a of h.messagesAdded ?? []) added.set(a.message.id, true);
          for (const a of h.labelsAdded ?? []) added.set(a.message.id, true);
        }
        latest = r.historyId ?? latest;
        pageToken = r.nextPageToken;
      } while (pageToken && !local.signal.aborted);
    } catch (e) {
      if (!(e instanceof GoogleError && e.status === 404)) throw e;
      // The cursor is older than Gmail keeps history (about a week): resume from now.
      const p = await me(g);
      await ctx!.cursor.set(JSON.stringify({ historyId: p.historyId, account: p.account }));
      return "history expired; watching from now";
    }
    const ids = [...added.keys()].slice(0, MAX_PER_POLL);
    let taken = 0;
    for (const id of await matching(g, ids)) {
      if (local.signal.aborted) break;
      const outcome = await take(g, id).catch((e) => `failed: ${errText(e)}`);
      if (outcome === "new" || outcome === "noted") taken++;
      ctx!.log(`message ${id}: ${outcome}`);
    }
    // More than one poll's worth: keep the cursor, the next poll reads the rest (ingest dedupes).
    if (added.size <= MAX_PER_POLL) await ctx!.cursor.set(JSON.stringify({ historyId: latest, account }));
    return `watching ${account}${taken ? ` · ${taken} new` : ""}`;
  }

  async function loop(): Promise<void> {
    let backoff = 5_000;
    while (!local.signal.aborted) {
      let wait = cfg!.pollSeconds * 1000;
      try {
        // Events off: no Gmail call at all. Read per tick, so a change on the card applies at once.
        const events = (await store.integration(connection.id).catch(() => undefined))?.events ?? connection.events;
        if (events === "off") { await report(true, "events off: no poll (orca gmail search and read still work)"); await sleep(wait, local.signal); continue; }
        const detail = await poll();
        lastPollAt = Date.now();
        await report(true, `${detail} · polling every ${cfg!.pollSeconds}s`);
        backoff = 5_000;
      } catch (e) {
        if (local.signal.aborted) break;
        if (e instanceof oauth.OAuthError) await report(false, e.message); // not connected / reconnect needed: wait for a Connect
        else if (e instanceof GoogleError && !e.retryable && !e.reconnect) await report(false, `Gmail: ${e.message}`);
        else { await report(false, `Gmail: ${errText(e)}; retry in ${Math.round(backoff / 1000)}s`); wait = backoff; backoff = Math.min(backoff * 2, 15 * 60_000); }
      }
      await sleep(wait, local.signal);
    }
  }

  return {
    kind: "gmail",
    caps: GMAIL_CAPS,
    async start(c) {
      if (!cfg) throw new Error((parsed as { error: string }).error);
      ctx = c;
      c.signal.addEventListener("abort", () => local.abort(), { once: true });
      // Not connected yet is a state the card shows, not a failed start: the loop waits for Connect.
      void loop();
    },
    async stop() { local.abort(); },
    async send(): Promise<SendResult> {
      return { ok: false, retryable: false, error: "Orca sends no Gmail mail yet: the send verb is not built (with read-write access, the gmail.send scope is ready)" };
    },
    async health() {
      if (!cfg) return { ok: false, detail: (parsed as { error: string }).error };
      return { ...state, ...(lastEventAt ? { lastEventAt } : {}), ...(lastPollAt ? { lastPollAt } : {}) };
    },
  };
}

/** The scopes a connection granted that the card names, in words. Pure. */
export function scopeWords(scopes: readonly string[] | undefined): string {
  const s = scopes ?? [];
  return !s.includes(SCOPE.readonly) ? "no Gmail scope" : s.includes(SCOPE.send) ? "read + send" : "read only";
}
