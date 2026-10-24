// "Connect with Google" for a Gmail integration (docs/integrations/gmail.md): the authorization-code
// flow with PKCE, the refresh token in Orca's secret store, and fresh access tokens for the adapter
// and `orca gmail`.
//
// 1. The Settings card posts /api/integrations/oauth/google/start. `begin` makes a state and a PKCE
//    verifier, keeps them ENCRYPTED in the integration's `<id>:oauth` cursor row (10 minutes, one
//    use; a restart between the two steps loses nothing), and answers Google's consent URL.
// 2. The browser goes to Google and comes back to <the page's origin>/api/integrations/oauth/google/
//    callback. The bridge never needs a public address: the user's browser makes both redirects.
// 3. `finish` checks the state, trades the code (with the verifier) for tokens, stores the refresh
//    token as the stored secret `integrations/gmail.<id>.refresh_token`, and records the account.
// The access token stays in memory. A refresh token Google refuses (revoked, expired) marks the row
// "reconnect needed" and is not tried again until a new Connect stores another one.
// The client secret is the variable the row's secret_ref names (default ORCA_SECRET_GOOGLE_OAUTH),
// else an Orca stored secret of that name (../../secretValue.ts).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as db from "../../../db";
import * as secrets from "../../../secrets";
import type { Connection } from "../../adapter";
import { INTEGRATION_SCOPE, resolveSecret } from "../../secretValue";
import * as store from "../../store";
import { authorizeUrl, endpoints, exchangeCode, Gmail, GoogleError, pkce, redirectUriFor, refreshAccess, revoke, SCOPE, consentScopes, storedSecretPathProblem, missingScopes, type GmailAccess } from "./google";

export const CLIENT_SECRET_DEFAULT = "ORCA_SECRET_GOOGLE_OAUTH";
export const PENDING_TTL_MS = 10 * 60_000;
export const refreshTokenName = (id: string): string => `gmail.${id}.refresh_token`;
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

export const clientSecretRef = (c: Pick<Connection, "secretRef">): string => c.secretRef || CLIENT_SECRET_DEFAULT;

function clientId(c: Connection): string {
  const id = typeof c.config.clientId === "string" ? c.config.clientId.trim() : "";
  if (!id) throw new OAuthError("config.clientId is empty: paste the OAuth client id from Google Cloud (Clients > your Web client)", "config", c.id);
  return id;
}

async function clientSecret(c: Connection): Promise<string> {
  // A stored-secret path in the config (`clientSecretStored`, e.g. a secret saved with /secret) wins.
  const stored = typeof c.config.clientSecretStored === "string" ? c.config.clientSecretStored.trim() : "";
  if (stored) {
    const why = storedSecretPathProblem(stored);
    if (why) throw new OAuthError(why, "config", c.id);
    try { return await secrets.valueOf(stored); }
    catch (e) {
      const notFound = e instanceof secrets.SecretError && e.status === 404;
      throw new OAuthError(notFound ? `the stored secret "${stored}" does not exist (orca secret list shows the names)` : e instanceof Error ? e.message : String(e), "config", c.id);
    }
  }
  const ref = clientSecretRef(c);
  const r = await resolveSecret(ref).catch((e) => { throw new OAuthError(e instanceof Error ? e.message : String(e), "config", c.id); });
  if (!r) throw new OAuthError(`${ref} is not set on this bridge: put the OAuth client secret in its .env, or store it as an Orca secret named ${ref}`, "config", c.id);
  return r.value;
}

async function gmailRow(id: string): Promise<Connection> {
  const c = await store.integration(id);
  if (!c || c.kind !== "gmail") throw new OAuthError(`no Gmail integration "${id}"`, "config", id);
  return c;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The origin Google sends the browser back to: the row's `redirectOrigin`, else the page's own. */
export function redirectOrigin(c: Pick<Connection, "config">, pageOrigin: string | undefined): string {
  const fixed = typeof c.config.redirectOrigin === "string" ? c.config.redirectOrigin.trim() : "";
  const o = fixed || pageOrigin || "";
  if (!/^https?:\/\/[^/\s]+$/i.test(o.replace(/\/+$/, ""))) throw new OAuthError(`"${o.slice(0, 80)}" is not an origin (https://host[:port])`, "config");
  return o.replace(/\/+$/, "");
}

/** Step 1: Google's consent URL for integration `id`, with the page's origin for the redirect. */
export async function begin(id: string, pageOrigin: string | undefined, now = Date.now()): Promise<{ url: string; redirectUri: string }> {
  const c = await gmailRow(id);
  const cid = clientId(c);
  await clientSecret(c); // fail here, not after the user has been to Google
  const redirectUri = redirectUriFor(redirectOrigin(c, pageOrigin));
  const { verifier, challenge } = pkce();
  const state = `${id}~${randomBytes(16).toString("hex")}`;
  await store.setCursor(pendingKey(id), secrets.encrypt(JSON.stringify({ state, verifier, redirectUri, at: now })));
  const prev = await statusOf(id).catch(() => undefined);
  const hint = prev?.account; // a reconnect offers the same account
  // An upgrade (read → read-write) asks only for the missing scope; a refused grant asks for all again.
  const scopes = consentScopes(gmailAccess(c), prev?.account ? prev.scopes : undefined, !!prev?.reconnect);
  return { url: authorizeUrl(endpoints(c.config), { clientId: cid, redirectUri, scopes, state, challenge, ...(hint ? { loginHint: hint } : {}) }), redirectUri };
}

/** The integration a callback's state names (before the state is checked), for the page it returns to. */
export const stateIntegration = (state: string | null): string | undefined => {
  const i = state?.lastIndexOf("~") ?? -1;
  return i > 0 ? state!.slice(0, i) : undefined;
};

/** Step 3: the callback's query → a stored refresh token. Answers the account it connected. */
export async function finish(q: URLSearchParams, now = Date.now()): Promise<{ id: string; account: string; scopes: string[] }> {
  const state = q.get("state") ?? "";
  const id = stateIntegration(state);
  if (!id) throw new OAuthError("the callback has no Orca state: start again with Connect with Google", "state");
  const raw = await store.cursor(pendingKey(id));
  if (!raw) throw new OAuthError("no sign-in is in progress for this integration (it was used, or it is older than 10 minutes): start again", "state", id);
  let pending: { state: string; verifier: string; redirectUri: string; at: number };
  try { pending = JSON.parse(secrets.decrypt(raw)); }
  catch { throw new OAuthError("the sign-in state was stored with another instance's key: start again from this server's page, or share ORCA_SECRETS_KEY", "state", id); }
  if (!sameText(pending.state, state)) throw new OAuthError("the state does not match the sign-in in progress: start again", "state", id);
  await store.setCursor(pendingKey(id), ""); // one use
  if (now - pending.at > PENDING_TTL_MS) throw new OAuthError("the sign-in took more than 10 minutes: start again", "state", id);
  const denied = q.get("error");
  if (denied) throw new OAuthError(denied === "access_denied" ? "you did not allow access at Google" : `Google answered: ${denied.slice(0, 100)}`, "google", id);
  const code = q.get("code");
  if (!code) throw new OAuthError("Google sent no code", "google", id);
  const c = await gmailRow(id);
  const e = endpoints(c.config);
  let t;
  try { t = await exchangeCode(e, { clientId: clientId(c), clientSecret: await clientSecret(c), code, verifier: pending.verifier, redirectUri: pending.redirectUri }); }
  catch (err) { throw new OAuthError(err instanceof Error ? err.message : String(err), "google", id); }
  if (!t.refreshToken) throw new OAuthError("Google sent no refresh token. Remove Orca's access at myaccount.google.com/permissions, then connect again", "google", id);
  if (t.scopes.length && !t.scopes.includes(SCOPE.readonly)) throw new OAuthError("Google did not grant gmail.readonly. Connect again and allow Orca to read your mail", "google", id);
  const access = { token: t.accessToken, expiresAt: t.expiresAt, refreshHash: hash(t.refreshToken) };
  const profile = await new Gmail(e, async () => access.token).profile().catch((err) => { throw new OAuthError(err instanceof Error ? err.message : String(err), "google", id); });
  await secrets.store({ scope: INTEGRATION_SCOPE, name: refreshTokenName(id), value: t.refreshToken, who: "gmail connect", source: `google oauth (${id})` });
  tokens.set(id, access);
  dead.delete(id);
  const account = profile.emailAddress.toLowerCase();
  const oauth: OAuthStatus = { account, scopes: t.scopes, connectedAt: now, reconnect: null };
  await store.setIntegrationStatus(id, { oauth, ok: true, detail: `connected as ${account}`, error: null, at: now });
  return { id, account, scopes: t.scopes };
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
    if (e instanceof secrets.SecretError && e.status === 404) throw new OAuthError("not connected: press Connect with Google on the integration's card", "not_connected", id);
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
    const t = await refreshAccess(endpoints(c.config), { clientId: clientId(c), clientSecret: await clientSecret(c), refreshToken: refresh });
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
export const gmailFor = (c: Connection): Gmail => new Gmail(endpoints(c.config), (fresh) => accessToken(c, fresh));

/** Disconnect: revoke the grant at Google (best effort), delete the stored refresh token, clear the
 *  card's account. The row stays; Connect with Google again to reuse it. */
export async function disconnect(id: string, who = "gmail disconnect"): Promise<{ revoked: boolean }> {
  const c = await store.integration(id);
  let revoked = false;
  const refresh = await secrets.valueOf(refreshRef(id)).catch(() => undefined);
  if (refresh && c) revoked = await revoke(endpoints(c.config), refresh);
  if (refresh) await secrets.remove(refreshRef(id), who).catch(() => {});
  tokens.delete(id);
  dead.delete(id);
  if (c) await store.setIntegrationStatus(id, { oauth: null, ok: false, detail: "not connected: press Connect with Google", at: Date.now() }).catch(() => {});
  return { revoked };
}
