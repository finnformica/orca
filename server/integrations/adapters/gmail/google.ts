// Google's OAuth 2.0 (authorization code + PKCE, RFC 7636) and the Gmail REST API, over `fetch`. No
// SDK: four token calls and a handful of Gmail endpoints. Docs: docs/integrations/gmail.md.
// The endpoints come from the integration's config only in tests (`authUrl`, `tokenUrl`, `apiUrl`,
// `revokeUrl`, pointed at a fake Google on loopback); a real row uses Google's.
// Nothing here logs: a token, a code or a verifier never reaches a log line or an error text.
import { createHash, randomBytes } from "node:crypto";

export const GOOGLE = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  api: "https://gmail.googleapis.com",
} as const;
export type Endpoints = { auth: string; token: string; revoke: string; api: string };

/** The endpoints for one integration: Google's, or the test overrides in its config. */
export function endpoints(config: Record<string, unknown>): Endpoints {
  const s = (k: string) => (typeof config[k] === "string" && /^https?:\/\//.test(config[k] as string) ? (config[k] as string).replace(/\/+$/, "") : undefined);
  return { auth: s("authUrl") ?? GOOGLE.auth, token: s("tokenUrl") ?? GOOGLE.token, revoke: s("revokeUrl") ?? GOOGLE.revoke, api: s("apiUrl") ?? GOOGLE.api };
}

/** The scopes, tied to the account's access (the access policy's `access`: read | read-write).
 *  read: who the account is (openid + userinfo.email) and gmail.readonly. read-write adds gmail.send.
 *  gmail.modify is never asked for: Orca marks nothing read and changes no label (the History API
 *  cursor is its position). Docs: docs/integrations/gmail.md section 2. */
export const SCOPE = {
  openid: "openid",
  email: "https://www.googleapis.com/auth/userinfo.email",
  readonly: "https://www.googleapis.com/auth/gmail.readonly",
  send: "https://www.googleapis.com/auth/gmail.send",
} as const;
export type GmailAccess = "read" | "read-write";

/** Every scope an account with `access` needs. Pure. */
export const scopesFor = (access: GmailAccess): string[] =>
  [SCOPE.openid, SCOPE.email, SCOPE.readonly, ...(access === "read-write" ? [SCOPE.send] : [])];

/** The scopes `access` needs that the grant does not have (`gmail.send` after a switch to read-write). Pure. */
export const missingScopes = (access: GmailAccess, granted: readonly string[] = []): string[] =>
  scopesFor(access).filter((s) => !granted.includes(s));

/** What the consent URL asks for. A first connect, or a grant Google refused: every scope. A
 *  connected account that needs more (read → read-write): ONLY the missing scopes. Google's
 *  incremental authorization (`include_granted_scopes=true`) adds them to the grant it has. Pure. */
export function consentScopes(access: GmailAccess, granted?: readonly string[], fresh = false): string[] {
  const missing = missingScopes(access, granted);
  return fresh || !granted?.length || !missing.length ? scopesFor(access) : missing;
}

/** Why `v` is not a stored-secret path (`scope/name` or `name`), or undefined. A value that looks
 *  like the secret itself (Google's `GOCSPX-…`) is refused: config is plain text in the database. Pure. */
export function storedSecretPathProblem(v: string): string | undefined {
  if (/^GOCSPX-/i.test(v) || v.length > 129) return "config.clientSecretStored takes the NAME of a stored Orca secret (scope/name), not the secret itself. Store the secret first (the composer's /secret), then name it here";
  if (!/^(?:[A-Za-z0-9_.-]{1,64}\/)?[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(v)) return `config.clientSecretStored "${v.slice(0, 40)}" is not a stored secret path (scope/name)`;
  return undefined;
}

/** The callback path. The redirect URI is the Orca page's origin + this path. */
export const CALLBACK_PATH = "/api/integrations/oauth/google/callback";
export const redirectUriFor = (origin: string): string => `${origin.replace(/\/+$/, "")}${CALLBACK_PATH}`;

const b64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A PKCE pair: a 43-character verifier and its S256 challenge. */
export function pkce(random: (n: number) => Buffer = randomBytes): { verifier: string; challenge: string } {
  const verifier = b64url(random(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/** Google's consent URL. `access_type=offline` + `prompt=consent` make Google return a refresh token
 *  each time, also on a reconnect. Pure. */
export function authorizeUrl(e: Pick<Endpoints, "auth">, o: { clientId: string; redirectUri: string; scopes: string[]; state: string; challenge: string; loginHint?: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId, redirect_uri: o.redirectUri, response_type: "code", scope: o.scopes.join(" "),
    state: o.state, code_challenge: o.challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent",
    include_granted_scopes: "true",
    ...(o.loginHint ? { login_hint: o.loginHint } : {}),
  });
  return `${e.auth}?${q}`;
}

/** A Google error. `reconnect`: the grant is gone (revoked, expired, a Testing app's 7 days), so
 *  only a new Connect with Google helps. `retryable`: try again later (a 429, a 5xx, the network). */
export class GoogleError extends Error {
  constructor(message: string, readonly status: number, readonly opts: { reconnect?: boolean; retryable?: boolean; scope?: boolean } = {}) { super(message); }
  get reconnect(): boolean { return !!this.opts.reconnect; }
  get retryable(): boolean { return !!this.opts.retryable; }
}

/** What a token endpoint error means. Only the error code and Google's short description go in the
 *  text: never the request. Pure. */
export function tokenError(status: number, body: { error?: string; error_description?: string }): GoogleError {
  const code = body.error ?? `http ${status}`;
  const why = body.error_description ? `${code}: ${body.error_description}` : code;
  if (code === "invalid_grant") return new GoogleError(`Google refused the grant (${why}). It was revoked or it expired`, status, { reconnect: true });
  if (code === "invalid_client" || code === "unauthorized_client") return new GoogleError(`Google refused the OAuth client (${why}). Check the client id and the client secret`, status);
  return new GoogleError(`Google token endpoint: ${why}`, status, { retryable: status === 429 || status >= 500 });
}

export type Tokens = { accessToken: string; expiresAt: number; refreshToken?: string; scopes: string[] };

async function tokenCall(e: Pick<Endpoints, "token">, form: Record<string, string>, now = Date.now()): Promise<Tokens> {
  let res: Response;
  try {
    res = await fetch(e.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form) });
  } catch (err) {
    throw new GoogleError(`Google token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`, 0, { retryable: true });
  }
  const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw tokenError(res.status, body);
  return {
    accessToken: body.access_token,
    expiresAt: now + Math.max(60, Number(body.expires_in ?? 3600)) * 1000,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    scopes: (body.scope ?? "").split(/\s+/).filter(Boolean),
  };
}

/** The callback's code → tokens, with the PKCE verifier. */
export const exchangeCode = (e: Pick<Endpoints, "token">, o: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string }): Promise<Tokens> =>
  tokenCall(e, { grant_type: "authorization_code", code: o.code, code_verifier: o.verifier, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri });

/** A refresh token → a new access token (Google keeps the refresh token the same). */
export const refreshAccess = (e: Pick<Endpoints, "token">, o: { clientId: string; clientSecret: string; refreshToken: string }): Promise<Tokens> =>
  tokenCall(e, { grant_type: "refresh_token", refresh_token: o.refreshToken, client_id: o.clientId, client_secret: o.clientSecret });

/** Revoke a token at Google. Best effort: a token Google no longer knows is already revoked. */
export async function revoke(e: Pick<Endpoints, "revoke">, token: string): Promise<boolean> {
  try {
    const res = await fetch(e.revoke, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
    return res.ok || res.status === 400;
  } catch { return false; }
}

// ── the Gmail API ────────────────────────────────────────────────────────────────────────────────

export type GmailMessageRef = { id: string; threadId: string };
export type GmailHeader = { name: string; value: string };
export type GmailMessage = GmailMessageRef & {
  labelIds?: string[]; snippet?: string; internalDate?: string; historyId?: string; raw?: string;
  payload?: { headers?: GmailHeader[] };
};
export type GmailHistory = { id: string; messagesAdded?: { message: GmailMessage }[]; labelsAdded?: { message: GmailMessage; labelIds: string[] }[] };

/** One Gmail API client for one account. `token()` gives a fresh access token; a 401 asks for a new
 *  one once (`token(true)`), since an access token can end before its expiry (a password change). */
export class Gmail {
  constructor(private readonly e: Pick<Endpoints, "api">, private readonly token: (fresh?: boolean) => Promise<string>) {}

  async call<T>(method: "GET" | "POST", path: string, o: { query?: Record<string, string | number | string[] | undefined>; body?: unknown } = {}): Promise<T> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(o.query ?? {})) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) q.append(k, String(one));
    }
    const url = `${this.e.api}/gmail/v1/users/me/${path}${q.size ? `?${q}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(attempt > 0);
      let res: Response;
      try {
        res = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(o.body ? { "content-type": "application/json" } : {}) }, ...(o.body ? { body: JSON.stringify(o.body) } : {}) });
      } catch (err) {
        throw new GoogleError(`Gmail API unreachable: ${err instanceof Error ? err.message : String(err)}`, 0, { retryable: true });
      }
      if (res.status === 401 && attempt === 0) continue;
      if (res.ok) return (await res.json()) as T;
      const body = await res.json().catch(() => ({})) as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } };
      const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? "";
      const scope = res.status === 403 && /insufficient|scope|permission/i.test(`${reason} ${body.error?.message ?? ""}`);
      throw new GoogleError(`Gmail ${method} ${path.split("?")[0]}: http ${res.status}${body.error?.message ? ` ${body.error.message.slice(0, 200)}` : ""}`, res.status, {
        retryable: res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimit|userRateLimit/i.test(reason)),
        reconnect: res.status === 401, scope,
      });
    }
  }

  profile = () => this.call<{ emailAddress: string; historyId: string; messagesTotal?: number }>("GET", "profile");
  history = (startHistoryId: string, pageToken?: string) => this.call<{ history?: GmailHistory[]; historyId: string; nextPageToken?: string }>("GET", "history", {
    query: { startHistoryId, historyTypes: ["messageAdded", "labelAdded"], maxResults: 500, pageToken },
  });
  list = (q: string, maxResults: number, pageToken?: string) => this.call<{ messages?: GmailMessageRef[]; nextPageToken?: string; resultSizeEstimate?: number }>("GET", "messages", { query: { q, maxResults, pageToken } });
  metadata = (id: string, headers: string[]) => this.call<GmailMessage>("GET", `messages/${encodeURIComponent(id)}`, { query: { format: "metadata", metadataHeaders: headers } });
  raw = (id: string) => this.call<GmailMessage>("GET", `messages/${encodeURIComponent(id)}`, { query: { format: "raw" } });
  thread = (id: string, headers: string[]) => this.call<{ id: string; messages?: GmailMessage[] }>("GET", `threads/${encodeURIComponent(id)}`, { query: { format: "metadata", metadataHeaders: headers } });
}

/** RFC 4648 §5 base64url, as Gmail's `raw` uses it. */
export const fromBase64Url = (s: string): Uint8Array => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

/** One header of a metadata message, case-insensitive. */
export const header = (m: Pick<GmailMessage, "payload">, name: string): string | undefined =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
