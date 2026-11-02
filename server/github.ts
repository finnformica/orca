// The one GitHub client: REST and GraphQL over `fetch`, no `gh` process per call. Each call runs
// as the account of the repo it is about (RepoConfig.githubUser, else the host's active `gh`
// login), with the token read ONCE per account from `gh auth token` (or GH_TOKEN) and cached.
// Polled GETs send If-None-Match and reuse the cached body on a 304, which GitHub does not count
// against the rate limit. A rate-limited account is blocked until its reset and fails FAST with
// a GitHubRateLimitError. Tokens are never logged or put in an error message.
import { createHash } from "crypto";
import { countGhCall } from "./metrics";
import { githubToken, githubUserFor, scrubbedEnv } from "./env";
import { runCmd } from "./run";

// ---- errors ----

/** Any failed GitHub call. `status` is the HTTP status (0: the request never got an answer). */
export class GitHubError extends Error {
  constructor(message: string, readonly status: number, readonly path: string) { super(message); this.name = "GitHubError"; }
}
/** 401: the token is missing, revoked or expired. */
export class GitHubAuthError extends GitHubError { constructor(m: string, s: number, p: string) { super(m, s, p); this.name = "GitHubAuthError"; } }
/** 404: no such resource, or the account cannot see it. */
export class GitHubNotFoundError extends GitHubError { constructor(m: string, s: number, p: string) { super(m, s, p); this.name = "GitHubNotFoundError"; } }
/** The account is rate-limited until `resetAt` (ms epoch). */
export class GitHubRateLimitError extends GitHubError {
  constructor(m: string, s: number, p: string, readonly resetAt: number) { super(m, s, p); this.name = "GitHubRateLimitError"; }
}
/** A GraphQL answer with `errors`. The message reads like gh's: `GraphQL: <message> (<path>)`. */
export class GitHubGraphQLError extends GitHubError {
  constructor(m: string, p: string, readonly errors: Array<{ message?: string; type?: string; path?: unknown[] }>) { super(m, 200, p); this.name = "GitHubGraphQLError"; }
}

// ---- seams (tests) ----

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch | undefined;
/** Swap the transport (unit tests). Undefined restores the global `fetch`. */
export function setFetch(f: Fetch | undefined): void { fetchImpl = f; }
const doFetch: Fetch = (input, init) => (fetchImpl ?? fetch)(input, init);

/** The API root. `ORCA_GITHUB_API_URL` points it elsewhere (the tests' fake GitHub). Read per call. */
const apiRoot = () => (process.env.ORCA_GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");

// ---- tokens ----

let activeToken: string | undefined;
/** The token for calls made about `cwd`: its repo's pinned account, else GH_TOKEN / GITHUB_TOKEN,
 *  else the active `gh` login's (`gh auth token`, read once). */
export async function tokenFor(cwd?: string): Promise<string> {
  const user = githubUserFor(cwd);
  const pinned = user && githubToken(user);
  if (pinned) return pinned;
  return activeTokenOnce();
}
/** The token of one named login (`gh auth token --user`, cached in env.ts), else the active one. */
export async function tokenForUser(user?: string): Promise<string> {
  return (user && githubToken(user)) || activeTokenOnce();
}
async function activeTokenOnce(): Promise<string> {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  if (activeToken) return activeToken;
  const res = await runCmd(["gh", "auth", "token"], { env: scrubbedEnv(), allowFail: true });
  const tok = res.code === 0 ? res.stdout.trim() : "";
  if (!tok) throw new GitHubAuthError("no GitHub token: run `gh auth login` on this host", 401, "");
  activeToken = tok;
  return tok;
}
/** Forget the cached active token (tests; a re-login). */
export function resetTokens(): void { activeToken = undefined; }

/** A short, one-way label for a token — the cache and rate-limit key. Never the token itself. */
const tokenKey = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16);

// ---- repo resolution ----

const slugCache = new Map<string, string>();
/** `owner/name` of the GitHub repo at `cwd` — what `{owner}/{repo}` meant to `gh`: the remote
 *  `gh repo set-default` marked (`remote.<name>.gh-resolved = base`), else `origin`.
 *  `ORCA_GITHUB_REPO` is the fallback for a checkout with no GitHub remote (the tests). */
export async function repoSlug(cwd: string): Promise<string> {
  const hit = slugCache.get(cwd);
  if (hit) return hit;
  const marked = await runCmd(["git", "-C", cwd, "config", "--get-regexp", "^remote\\..*\\.gh-resolved$"], { allowFail: true });
  const base = marked.code === 0 ? /^remote\.(.+)\.gh-resolved base$/m.exec(marked.stdout)?.[1] : undefined;
  const res = await runCmd(["git", "-C", cwd, "remote", "get-url", base ?? "origin"], { allowFail: true });
  const slug = parseSlug(res.code === 0 ? res.stdout.trim() : "") ?? process.env.ORCA_GITHUB_REPO;
  if (!slug) throw new GitHubError(`could not resolve GitHub repository for ${cwd}: no GitHub origin remote`, 0, "");
  slugCache.set(cwd, slug);
  return slug;
}
/** `owner/name` from a GitHub remote URL (https, ssh or scp form), else undefined. */
export function parseSlug(url: string): string | undefined {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

// ---- rate limits ----
// GitHub keeps one budget per account and RESOURCE: GraphQL (5,000 points/h), REST core (5,000/h)
// and search are separate. A block is per token AND resource, so an exhausted GraphQL budget never
// stops a REST call (2026-11-02: `orca archive` failed on a GraphQL block while REST had quota).

/** The rate-limit resource a call spends: what `x-ratelimit-resource` will name. */
export function resourceOf(path: string): string {
  if (path === "graphql") return "graphql";
  if (/^(?:https?:\/\/[^/]+\/)?\/?search\//.test(path)) return "search";
  return "core";
}
const blockedUntil = new Map<string, number>();
const blockKey = (token: string, resource: string) => `${tokenKey(token)}:${resource}`;
/** How long a short secondary limit (Retry-After) is waited out in place before one retry. */
const RETRY_INLINE_MAX_MS = 10_000;

function rateLimitReset(res: Response, now: number): number | undefined {
  const retryAfter = Number(res.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1000;
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (remaining === "0" && Number.isFinite(reset) && reset > 0) return reset * 1000;
  return undefined;
}

/** Ms until `token`'s account may call `resource` again (0: now). Default: the REST core budget. */
export function rateLimitedFor(token: string, now = Date.now(), resource = "core"): number {
  const until = blockedUntil.get(blockKey(token, resource)) ?? 0;
  return Math.max(0, until - now);
}

/** The last budget GitHub reported per token and resource (headers of each answer). */
type Budget = { resource: string; limit: number; remaining: number; reset: number; at: number };
const budgets = new Map<string, Budget>();
function noteBudget(token: string, res: Response, fallback: string, now: number): void {
  const limit = Number(res.headers.get("x-ratelimit-limit"));
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (!res.headers.has("x-ratelimit-remaining") || !Number.isFinite(remaining)) return;
  const resource = res.headers.get("x-ratelimit-resource") || fallback;
  budgets.set(blockKey(token, resource), { resource, limit, remaining, reset: reset * 1000, at: now });
}

/** Every block in force now: what the UI's banner reads. No token, only a short account label. */
export function rateLimitState(now = Date.now()): { blocks: Array<{ account: string; resource: string; until: number }>; budgets: Budget[] } {
  const blocks: Array<{ account: string; resource: string; until: number }> = [];
  for (const [k, until] of blockedUntil) {
    if (until <= now) continue;
    const [account, resource] = k.split(":") as [string, string];
    blocks.push({ account, resource, until });
  }
  return { blocks, budgets: [...budgets.values()] };
}

// A block is CHECKED against `GET /rate_limit` (free: it does not count against any budget), at
// most once a minute per token while a call is refused and the block is a minute old — or at once
// for a GraphQL error, which carries no reset time. A block that outlived GitHub's own reset kept
// the board on "no PR" with quota left (2026-11-02).
const PROBE_EVERY_MS = 60_000;
const probedAt = new Map<string, number>();
const blockedAt = new Map<string, number>();
function block(key: string, until: number): void { blockedUntil.set(key, until); blockedAt.set(key, Date.now()); }
function probeBlocks(token: string, now: number, force = false): void {
  const k = tokenKey(token);
  if (now - (probedAt.get(k) ?? 0) < PROBE_EVERY_MS) return;
  if (!force && ![...blockedAt].some(([key, at]) => key.startsWith(`${k}:`) && now - at >= PROBE_EVERY_MS)) return;
  probedAt.set(k, now);
  void (async () => {
    countGhCall("rate_limit", "rest", false);
    const res = await doFetch(`${apiRoot()}/rate_limit`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "orca" } });
    if (!res.ok) return;
    const body = await res.json() as { resources?: Record<string, { limit: number; remaining: number; reset: number }> };
    const at = Date.now();
    for (const [resource, b] of Object.entries(body.resources ?? {})) {
      if (!["core", "graphql", "search"].includes(resource)) continue;
      budgets.set(blockKey(token, resource), { resource, limit: b.limit, remaining: b.remaining, reset: b.reset * 1000, at });
      const key = blockKey(token, resource);
      if (b.remaining > 0) { if ((blockedUntil.get(key) ?? 0) > at && !secondary.has(key)) blockedUntil.delete(key); }
      else block(key, b.reset * 1000);
    }
  })().catch(() => { /* the next refused call probes again after PROBE_EVERY_MS */ });
}
/** Blocks set by a secondary limit (Retry-After): /rate_limit does not report them, so a probe never lifts one. */
const secondary = new Set<string>();

// ---- ETag cache ----

type Cached = { etag: string; body: unknown; at: number; size: number };
const etags = new Map<string, Cached>();
const ETAG_MAX = 500;
/** The cache's size bound, in characters of response text: 500 entries alone did not bound it, since
 *  one answer (a job log, a long file list) can be megabytes. An answer over ETAG_ENTRY_MAX_CHARS is
 *  never kept. */
export const ETAG_MAX_CHARS = 16 << 20;
export const ETAG_ENTRY_MAX_CHARS = 1 << 20;
let etagChars = 0;
function remember(key: string, etag: string, body: unknown, size: number): void {
  const old = etags.get(key);
  if (old) { etags.delete(key); etagChars -= old.size; }
  if (size > ETAG_ENTRY_MAX_CHARS) return;
  etags.set(key, { etag, body, at: Date.now(), size });
  etagChars += size;
  while (etags.size > ETAG_MAX || etagChars > ETAG_MAX_CHARS) {
    const [oldest, entry] = etags.entries().next().value!;
    etags.delete(oldest);
    etagChars -= entry.size;
  }
}

/** The ETag cache's size (tests). */
export const etagCacheSize = (): { entries: number; chars: number } => ({ entries: etags.size, chars: etagChars });

/** Clear every cache (tests). */
export function resetCaches(): void { etags.clear(); etagChars = 0; blockedUntil.clear(); blockedAt.clear(); secondary.clear(); budgets.clear(); probedAt.clear(); slugCache.clear(); }

// ---- the request ----

export type RequestOptions = {
  method?: string;
  /** JSON body for a non-GET. */
  body?: unknown;
  /** Accept header (default the v3 JSON media type); a non-JSON type returns the text. */
  accept?: string;
  /** Follow a redirect by hand, WITHOUT the token (a log download points at a storage host). */
  redirectWithoutAuth?: boolean;
  token: string;
  /** What asked (the gh.ts function): the key of the per-op counters in /api/diagnostics. */
  op?: string;
};

function errorFor(res: Response, path: string, text: string, now: number): GitHubError {
  let message = text;
  try { const j = JSON.parse(text) as { message?: string }; if (j.message) message = j.message; } catch { /* not JSON */ }
  const line = `HTTP ${res.status}: ${message || res.statusText} (${path})`;
  const reset = (res.status === 403 || res.status === 429) ? rateLimitReset(res, now) : undefined;
  if (reset !== undefined || res.status === 429) return new GitHubRateLimitError(line, res.status, path, reset ?? now + 60_000);
  if (res.status === 401) return new GitHubAuthError(line, res.status, path);
  if (res.status === 404) return new GitHubNotFoundError(line, res.status, path);
  return new GitHubError(line, res.status, path);
}

/** One REST call. `path` is relative to the API root (`repos/o/n/pulls`). GETs carry
 *  If-None-Match and a 304 returns the cached body. Returns parsed JSON, the text for a non-JSON
 *  Accept, or undefined for an empty answer (204). */
export async function request<T = any>(path: string, opts: RequestOptions): Promise<T> {
  const method = opts.method ?? "GET";
  const key = tokenKey(opts.token);
  const now = Date.now();
  const resource = resourceOf(path);
  const wait = rateLimitedFor(opts.token, now, resource);
  if (wait > 0) {
    probeBlocks(opts.token, now);
    throw new GitHubRateLimitError(`GitHub rate limit: retry in ${Math.ceil(wait / 1000)}s (${path})`, 429, path, now + wait);
  }
  const op = opts.op ?? (resource === "graphql" ? "graphql" : "rest");
  const url = /^https?:/.test(path) ? path : `${apiRoot()}/${path.replace(/^\//, "")}`;
  const accept = opts.accept ?? "application/vnd.github+json";
  const cacheKey = method === "GET" ? `${key} ${accept} ${url}` : undefined;
  const cached = cacheKey ? etags.get(cacheKey) : undefined;
  const headers: Record<string, string> = {
    Accept: accept, Authorization: `Bearer ${opts.token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "orca",
  };
  if (cached) headers["If-None-Match"] = cached.etag;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const send = () => doFetch(url, {
    method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: opts.redirectWithoutAuth ? "manual" : "follow",
  });
  let res: Response;
  try { res = await send(); countGhCall(op, resource === "graphql" ? "graphql" : "rest", res.status === 304); } catch (e) { throw new GitHubError(`GitHub request failed: ${e instanceof Error ? e.message : String(e)} (${path})`, 0, path); }
  // A short secondary limit: wait it out once, in place.
  if ((res.status === 403 || res.status === 429) && Number(res.headers.get("retry-after")) * 1000 <= RETRY_INLINE_MAX_MS && Number(res.headers.get("retry-after")) > 0) {
    await Bun.sleep(Number(res.headers.get("retry-after")) * 1000);
    res = await send();
    countGhCall(op, resource === "graphql" ? "graphql" : "rest", res.status === 304);
  }
  const after = Date.now();
  noteBudget(opts.token, res, resource, after);
  const bkey = blockKey(opts.token, res.headers.get("x-ratelimit-resource") || resource);
  if (res.status === 304 && cached) return cached.body as T;
  if (opts.redirectWithoutAuth && res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    const next = await doFetch(res.headers.get("location")!, { headers: { "User-Agent": "orca" } });
    if (!next.ok) throw new GitHubError(`HTTP ${next.status}: redirect target failed (${path})`, next.status, path);
    return (await next.text()) as T;
  }
  const text = await res.text();
  if (!res.ok) {
    const err = errorFor(res, path, text, after);
    if (err instanceof GitHubRateLimitError) {
      block(bkey, err.resetAt);
      if (res.headers.get("retry-after")) secondary.add(bkey); else secondary.delete(bkey);
    }
    throw err;
  }
  // Out of quota after this call: block the account until its window resets.
  const reset = rateLimitReset(res, after);
  if (res.headers.get("x-ratelimit-remaining") === "0" && reset) block(bkey, reset);
  const json = /json/.test(accept) && /json/.test(res.headers.get("content-type") ?? "json");
  const body = !text ? undefined : json ? JSON.parse(text) : text;
  const etag = res.headers.get("etag");
  if (cacheKey && etag) remember(cacheKey, etag, body, text.length);
  return body as T;
}

/** One GraphQL call. Errors in the answer throw a GitHubGraphQLError worded like gh's. */
export async function graphql<T = any>(query: string, variables: Record<string, unknown>, token: string, op?: string): Promise<T> {
  const res = await request<{ data?: T; errors?: Array<{ message?: string; type?: string; path?: unknown[] }> }>("graphql", { method: "POST", body: { query, variables }, token, op });
  if (res?.errors?.length) {
    const msg = res.errors.map((e) => `GraphQL: ${e.message ?? "error"}${e.path?.length ? ` (${e.path.join(".")})` : ""}`).join("\n");
    if (res.errors.some((e) => e.type === "RATE_LIMITED")) {
      // No reset in a GraphQL error: block a minute, and the probe reads the real reset.
      const known = budgets.get(blockKey(token, "graphql"));
      const resetAt = known && known.remaining === 0 && known.reset > Date.now() ? known.reset : Date.now() + 60_000;
      block(blockKey(token, "graphql"), resetAt);
      probeBlocks(token, Date.now(), true);
      throw new GitHubRateLimitError(msg, 200, "graphql", resetAt);
    }
    throw new GitHubGraphQLError(msg, "graphql", res.errors);
  }
  return res?.data as T;
}

// ---- per-repo convenience: the account and slug come from the checkout ----

/** A client bound to the repo at `cwd`: its token and `owner/name`. `rest` expands `{repo}` to
 *  `repos/<owner>/<name>`; `gql` sends exactly the variables it is given. */
export async function forRepo(cwd: string, op?: string): Promise<{
  slug: string; owner: string; name: string; token: string;
  rest: <T = any>(path: string, opts?: Omit<RequestOptions, "token">) => Promise<T>;
  gql: <T = any>(query: string, variables?: Record<string, unknown>) => Promise<T>;
}> {
  const [token, slug] = await Promise.all([tokenFor(cwd), repoSlug(cwd)]);
  const [owner, name] = slug.split("/") as [string, string];
  return {
    slug, owner, name, token,
    rest: (path, opts = {}) => request(path.replace("{repo}", `repos/${slug}`), { op, ...opts, token }),
    gql: (query, variables = {}) => graphql(query, variables, token, op),
  };
}
