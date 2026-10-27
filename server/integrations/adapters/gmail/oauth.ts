// "Sign in with Google" for a Gmail integration (docs/integrations/gmail.md): the authorization-code
// flow with PKCE, the refresh token in Orca's secret store, and fresh access tokens for the adapter
// and `orca gmail`.
//
// 1. The page posts /api/integrations/oauth/google/start: with no id for "Sign in with Google" (a NEW
//    account), or with a row's id for its Reconnect. `begin` makes a state and a PKCE verifier, keeps
//    them ENCRYPTED in the cursor row `<id>:oauth` (a new account: `+new-<hex>:oauth`; 10 minutes,
//    one use; a restart between the two steps loses nothing), and answers Google's consent URL.
// 2. The browser goes to Google and comes back to <the page's origin>/api/integrations/oauth/google/
//    callback. The bridge never needs a public address: the user's browser makes both redirects.
// 3. `finish` checks the state, trades the code (with the verifier) for tokens, and reads the address.
//    A new account becomes a row named by its address (read, events off: GMAIL_POLICY_DEFAULTS), or
//    the row already connected to that address. The refresh token goes in the stored secret
//    `integrations/gmail.<id>.refresh_token`.
// The access token stays in memory. A refresh token Google refuses (revoked, expired) marks the row
// "reconnect needed" and is not tried again until a new Connect stores another one.
// The OAuth client is a server key (shared/serverKeys.ts), read ONLY from the bridge's environment:
// ORCA_GOOGLE_OAUTH_CLIENT_ID, ORCA_SECRET_GOOGLE_OAUTH and the optional
// ORCA_GOOGLE_OAUTH_REDIRECT_ORIGIN. A missing variable disables the sign-in, never the bridge. An
// old `googleOAuth` in the app config, or a row's own client id or secret_ref, is ignored with a log line.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as db from "../../../db";
import * as secrets from "../../../secrets";
import type { Connection } from "../../adapter";
import * as store from "../../store";
import { connectOriginProblem } from "../../../../shared/integrationSettings";
import { AUTO_INSTANCE, type Access, type EventsMode } from "../../../../shared/integrations";
import { GOOGLE_API_BASE_ENV, GOOGLE_CLIENT_ID_ENV, GOOGLE_CLIENT_SECRET_ENV, GOOGLE_REDIRECT_ORIGIN_ENV } from "../../../../shared/serverKeys";
import { authorizeUrl, endpoints, exchangeCode, Gmail, GoogleError, pkce, redirectUriFor, refreshAccess, revoke, SCOPE, consentScopes, missingScopes, type GmailAccess } from "./google";

export const CLIENT_SECRET_DEFAULT = GOOGLE_CLIENT_SECRET_ENV;
export const CLIENT_ID_ENV = GOOGLE_CLIENT_ID_ENV;
/** A new Gmail account's policy (docs/integrations/POLICY.md section 6): read, events off until you
 *  set them on the card. The registry's `meta.policyDefaults` is this too. */
export const GMAIL_POLICY_DEFAULTS: { access: Access; events: EventsMode } = { access: "read", events: "off" };
/** The pending id of a sign-in for a NEW account. "+" is never in an integration id. */
const NEW_PREFIX = "+new-";
export const PENDING_TTL_MS = 10 * 60_000;
export const refreshTokenName = (id: string): string => `gmail.${id}.refresh_token`;
/** The scope Orca keeps its own integration secrets in (the Gmail refresh token). */
export const INTEGRATION_SCOPE = "integrations";
const refreshRef = (id: string) => `${INTEGRATION_SCOPE}/${refreshTokenName(id)}`;
const pendingKey = (id: string) => `${id}:oauth`;

/** What the card shows of a connection (`integration.status.oauth`). Never a token. */
export type OAuthStatus = { account?: string; scopes?: string[]; connectedAt?: number; reconnect?: string | null };

export type OAuthErrorCode = "config" | "not_connected" | "reconnect" | "state" | "google";
export class OAuthError extends Error {
  constructor(message: string, readonly code: OAuthErrorCode, readonly integrationId?: string) { super(message); }
}

/** The account's access, from the access policy's `access` on the row (branch
 *  orca/integration-access-policy). A row without it is READ: a Gmail account is read only unless
 *  the user set "Read and write". */
export const gmailAccess = (c: Pick<Connection, "kind"> & { access?: unknown }): GmailAccess => (c.access === "read-write" ? "read-write" : "read");

/** What the card shows of the grant: the status, plus the scopes the access needs and the grant
 *  lacks (`missing`: then the card says "Reconnect to allow sending"). Undefined when not connected. */
export function cardOAuth(c: Pick<Connection, "kind"> & { access?: unknown }, s: OAuthStatus | null | undefined): (OAuthStatus & { missing: string[] }) | undefined {
  if (!s) return undefined;
  return { ...s, missing: s.account ? missingScopes(gmailAccess(c), s.scopes) : [] };
}

const ENDPOINT_KEYS = ["authUrl", "tokenUrl", "apiUrl", "revokeUrl"] as const;

/** The client a sign-in uses, from the environment only. The endpoints are Google's, unless
 *  ORCA_GOOGLE_API_BASE (a fake Google in the tests, or a proxy) or the row's own endpoint keys name
 *  others. They are not secrets. Pure. */
export function resolveClient(row?: Pick<Connection, "config">, env: Record<string, string | undefined> = process.env):
  { clientId?: string; secretRef: string; redirectOrigin?: string; endpoints: Record<string, unknown> } {
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const clientId = s(env[CLIENT_ID_ENV]);
  const redirectOrigin = s(env[GOOGLE_REDIRECT_ORIGIN_ENV]);
  const base = s(env[GOOGLE_API_BASE_ENV])?.replace(/\/+$/, "");
  const fromRow = Object.fromEntries(ENDPOINT_KEYS.filter((k) => row?.config[k] !== undefined).map((k) => [k, row!.config[k]]));
  return {
    ...(clientId ? { clientId } : {}), secretRef: CLIENT_SECRET_DEFAULT, ...(redirectOrigin ? { redirectOrigin } : {}),
    endpoints: { ...(base ? { authUrl: `${base}/auth`, tokenUrl: `${base}/token`, apiUrl: base, revokeUrl: `${base}/revoke` } : {}), ...fromRow },
  };
}
type Client = ReturnType<typeof resolveClient>;
const clientOf = async (row?: Connection): Promise<Client> => resolveClient(row);

/** Why "Sign in with Google" cannot work on this bridge yet, in one line, or undefined when it can.
 *  Reads names only, never a value. Pure. */
export function setupProblem(c: Pick<Client, "clientId">, env: Record<string, string | undefined> = process.env): string | undefined {
  const missing = [...(c.clientId ? [] : [CLIENT_ID_ENV]), ...(env[CLIENT_SECRET_DEFAULT]?.trim() ? [] : [CLIENT_SECRET_DEFAULT])];
  return missing.length ? `Gmail sign-in is not set up: set ${missing.join(" and ")} in the server's environment.` : undefined;
}

/** The server client on this bridge, for the Connect dialog: its setup problem, and whether it names
 *  a fixed redirect origin (then the page's own origin does not matter). */
export async function serverSetup(): Promise<{ problem?: string; fixedOrigin: boolean }> {
  const c = await clientOf();
  const problem = setupProblem(c);
  return { ...(problem ? { problem } : {}), fixedOrigin: !!c.redirectOrigin };
}

function clientId(c: Client, id?: string): string {
  if (!c.clientId) throw new OAuthError(`Gmail sign-in is not set up: set ${CLIENT_ID_ENV} in the server's environment`, "config", id);
  return c.clientId;
}

function clientSecret(c: Client, id?: string): string {
  const value = process.env[c.secretRef]?.trim();
  if (!value) throw new OAuthError(`Gmail sign-in is not set up: set ${c.secretRef} in the server's environment`, "config", id);
  return value;
}

async function gmailRow(id: string): Promise<Connection> {
  const c = await store.integration(id);
  if (!c || c.kind !== "gmail") throw new OAuthError(`no Gmail integration "${id}"`, "config", id);
  return c;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The origin Google sends the browser back to: the configured `redirectOrigin` (a public base URL:
 *  ORCA_GOOGLE_OAUTH_REDIRECT_ORIGIN), else the page's own Origin. Only https on a domain
 *  name: never 127.0.0.1:8787 or plain http (`connectOriginProblem`). A refusal names the https
 *  address to open (ORCA_SERVER_URL) when known. */
export function redirectOrigin(c: { redirectOrigin?: string }, pageOrigin: string | undefined, serverUrl = process.env.ORCA_SERVER_URL): string {
  const fixed = (c.redirectOrigin ?? "").trim().replace(/\/+$/, "");
  const o = (fixed || pageOrigin || "").replace(/\/+$/, "");
  let https: string | undefined;
  try { const u = serverUrl ? new URL(serverUrl) : undefined; https = u?.protocol === "https:" ? u.origin : undefined; } catch { /* not a URL */ }
  const why = connectOriginProblem(o, https);
  if (why) throw new OAuthError(fixed ? `${GOOGLE_REDIRECT_ORIGIN_ENV}: ${why}` : why, "config");
  return new URL(o).origin;
}

/** Step 1: Google's consent URL, with the page's origin for the redirect. No `id`: "Sign in with
 *  Google" for a NEW account (read scopes; Google lets the user pick the account). An `id`: that
 *  row's Connect / Reconnect. */
export async function begin(id: string | undefined, pageOrigin: string | undefined, now = Date.now()): Promise<{ url: string; redirectUri: string }> {
  const row = id ? await gmailRow(id) : undefined;
  const client = await clientOf(row);
  const cid = clientId(client, id);
  await clientSecret(client, id); // fail here, not after the user has been to Google
  const redirectUri = redirectUriFor(redirectOrigin(client, pageOrigin));
  const { verifier, challenge } = pkce();
  const pending = id ?? `${NEW_PREFIX}${randomBytes(8).toString("hex")}`;
  if (!id) await store.dropCursors(`${NEW_PREFIX}%`, now - PENDING_TTL_MS).catch(() => {}); // sign-ins never finished
  const state = `${pending}~${randomBytes(16).toString("hex")}`;
  await store.setCursor(pendingKey(pending), secrets.encrypt(JSON.stringify({ state, verifier, redirectUri, at: now })));
  const prev = id ? await statusOf(id).catch(() => undefined) : undefined;
  const hint = prev?.account; // a reconnect offers the same account
  // An upgrade (read → read-write) asks only for the missing scope; a refused grant asks for all again.
  const scopes = consentScopes(row ? gmailAccess(row) : GMAIL_POLICY_DEFAULTS.access, prev?.account ? prev.scopes : undefined, !!prev?.reconnect);
  return { url: authorizeUrl(endpoints(client.endpoints), { clientId: cid, redirectUri, scopes, state, challenge, ...(hint ? { loginHint: hint } : {}) }), redirectUri };
}

/** The integration id for a new account's address: lower case, `@` as `-`, made unique with a suffix.
 *  For example finn@example.com → `finn-example.com`. Pure. */
export function accountId(address: string, taken: ReadonlySet<string>): string {
  const base = address.toLowerCase().replace("@", "-").replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 56) || "gmail";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The row a new sign-in for `address` lands on: the Gmail row already connected to that address (a
 *  sign-in again reconnects it, never a second row), else a new one, named by the address. */
async function rowForAccount(address: string, now: number): Promise<{ id: string; added: boolean }> {
  const rows = await store.integrations();
  for (const r of rows.filter((x) => x.kind === "gmail")) {
    if ((await statusOf(r.id).catch(() => undefined))?.account === address) return { id: r.id, added: false };
  }
  const id = accountId(address, new Set(rows.map((r) => r.id)));
  await store.addIntegration({ id, kind: "gmail", name: address, instance: AUTO_INSTANCE, config: {}, enabled: true, ...GMAIL_POLICY_DEFAULTS });
  await store.setIntegrationStatus(id, { ok: false, detail: "signed in; starting", at: now }).catch(() => {});
  return { id, added: true };
}

/** The integration a callback's state names (before the state is checked), for the page it returns to. */
export const stateIntegration = (state: string | null): string | undefined => {
  const i = state?.lastIndexOf("~") ?? -1;
  return i > 0 ? state!.slice(0, i) : undefined;
};

/** Step 3: the callback's query → a stored refresh token. Answers the account it connected. */
export async function finish(q: URLSearchParams, now = Date.now()): Promise<{ id: string; account: string; scopes: string[]; added: boolean }> {
  const state = q.get("state") ?? "";
  const pendingId = stateIntegration(state);
  if (!pendingId) throw new OAuthError("the callback has no Orca state: start again with Sign in with Google", "state");
  const isNew = pendingId.startsWith(NEW_PREFIX);
  const id = isNew ? undefined : pendingId; // the row a failure names (none yet for a new account)
  const raw = await store.cursor(pendingKey(pendingId));
  if (!raw) throw new OAuthError("no sign-in is in progress for this integration (it was used, or it is older than 10 minutes): start again", "state", id);
  let pending: { state: string; verifier: string; redirectUri: string; at: number };
  try { pending = JSON.parse(secrets.decrypt(raw)); }
  catch { throw new OAuthError("the sign-in state was stored with another instance's key: start again from this server's page, or share ORCA_SECRETS_KEY", "state", id); }
  if (!sameText(pending.state, state)) throw new OAuthError("the state does not match the sign-in in progress: start again", "state", id);
  if (isNew) await store.dropCursor(pendingKey(pendingId)); else await store.setCursor(pendingKey(pendingId), ""); // one use
  if (now - pending.at > PENDING_TTL_MS) throw new OAuthError("the sign-in took more than 10 minutes: start again", "state", id);
  const denied = q.get("error");
  if (denied) throw new OAuthError(denied === "access_denied" ? "you did not allow access at Google" : `Google answered: ${denied.slice(0, 100)}`, "google", id);
  const code = q.get("code");
  if (!code) throw new OAuthError("Google sent no code", "google", id);
  const row = id ? await gmailRow(id) : undefined;
  const client = await clientOf(row);
  const e = endpoints(client.endpoints);
  let t;
  try { t = await exchangeCode(e, { clientId: clientId(client, id), clientSecret: await clientSecret(client, id), code, verifier: pending.verifier, redirectUri: pending.redirectUri }); }
  catch (err) { throw new OAuthError(err instanceof Error ? err.message : String(err), "google", id); }
  if (!t.refreshToken) throw new OAuthError("Google sent no refresh token. Remove Orca's access at myaccount.google.com/permissions, then connect again", "google", id);
  if (t.scopes.length && !t.scopes.includes(SCOPE.readonly)) throw new OAuthError("Google did not grant gmail.readonly. Connect again and allow Orca to read your mail", "google", id);
  const access = { token: t.accessToken, expiresAt: t.expiresAt, refreshHash: hash(t.refreshToken) };
  const profile = await new Gmail(e, async () => access.token).profile().catch((err) => { throw new OAuthError(err instanceof Error ? err.message : String(err), "google", id); });
  const account = profile.emailAddress.toLowerCase();
  const { id: target, added } = id ? { id, added: false } : await rowForAccount(account, now);
  await secrets.store({ scope: INTEGRATION_SCOPE, name: refreshTokenName(target), value: t.refreshToken, who: "gmail connect", source: `google oauth (${target})` });
  tokens.set(target, access);
  dead.delete(target);
  const oauth: OAuthStatus = { account, scopes: t.scopes, connectedAt: now, reconnect: null };
  await store.setIntegrationStatus(target, { oauth, ok: true, detail: `connected as ${account}`, error: null, at: now });
  return { id: target, account, scopes: t.scopes, added };
}

// ── access tokens ────────────────────────────────────────────────────────────────────────────────

const tokens = new Map<string, { token: string; expiresAt: number; refreshHash: string }>();
const dead = new Map<string, string>(); // integration id → the hash of the refresh token Google refused

/** Forget every cached token (tests). */
export const resetTokens = (): void => { tokens.clear(); dead.clear(); };

/** The row's `status.oauth`. */
export async function statusOf(id: string): Promise<OAuthStatus | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT status->'oauth' AS oauth FROM integration WHERE user_id = ${db.currentUser()} AND id = ${id}`;
    return ((rows as { oauth: OAuthStatus | null }[])[0]?.oauth) ?? undefined;
  });
}

/** The stored refresh token, or a not_connected error. */
async function refreshToken(id: string): Promise<string> {
  try { return await secrets.valueOf(refreshRef(id)); }
  catch (e) {
    if (e instanceof secrets.SecretError && e.status === 404) throw new OAuthError("not connected: press Sign in with Google on the account's card", "not_connected", id);
    throw new OAuthError(e instanceof Error ? e.message : String(e), "config", id);
  }
}

/** A valid access token for `c`. `fresh` skips the cache (after a 401). A refused refresh token
 *  records "reconnect needed" on the row once, and fails fast after that. */
export async function accessToken(c: Connection, fresh = false, now = Date.now()): Promise<string> {
  const cached = tokens.get(c.id);
  if (!fresh && cached && cached.expiresAt - 60_000 > now) return cached.token;
  const refresh = await refreshToken(c.id);
  const h = hash(refresh);
  if (dead.get(c.id) === h) throw new OAuthError("reconnect needed: Google refused the stored grant. Press Reconnect with Google", "reconnect", c.id);
  try {
    const client = await clientOf(c);
    const t = await refreshAccess(endpoints(client.endpoints), { clientId: clientId(client, c.id), clientSecret: await clientSecret(client, c.id), refreshToken: refresh });
    tokens.set(c.id, { token: t.accessToken, expiresAt: t.expiresAt, refreshHash: h });
    return t.accessToken;
  } catch (e) {
    if (e instanceof GoogleError && e.reconnect) {
      dead.set(c.id, h);
      tokens.delete(c.id);
      const reconnect = `reconnect needed: ${e.message}`;
      const prev = await statusOf(c.id).catch(() => undefined);
      await store.setIntegrationStatus(c.id, { oauth: { ...(prev ?? {}), reconnect }, ok: false, detail: reconnect, at: now }).catch(() => {});
      throw new OAuthError(reconnect, "reconnect", c.id);
    }
    throw e;
  }
}

/** A Gmail API client for the row, with its tokens. */
export async function gmailFor(c: Connection): Promise<Gmail> {
  return new Gmail(endpoints((await clientOf(c)).endpoints), (fresh) => accessToken(c, fresh));
}

/** Disconnect: revoke the grant at Google (best effort), delete the stored refresh token, clear the
 *  card's account. The row stays; Sign in with Google again to reuse it. */
export async function disconnect(id: string, who = "gmail disconnect"): Promise<{ revoked: boolean }> {
  const c = await store.integration(id);
  let revoked = false;
  const refresh = await secrets.valueOf(refreshRef(id)).catch(() => undefined);
  if (refresh && c) revoked = await revoke(endpoints((await clientOf(c)).endpoints), refresh);
  if (refresh) await secrets.remove(refreshRef(id), who).catch(() => {});
  tokens.delete(id);
  dead.delete(id);
  if (c) await store.setIntegrationStatus(id, { oauth: null, ok: false, detail: "not connected: press Sign in with Google", at: Date.now() }).catch(() => {});
  return { revoked };
}
