// The server switcher (Option B): several fully separate Orca servers that never talk to each other —
// a work box, later a personal one — and ONE browser that talks to each. This module is the server
// side of it, and all of it is off unless the app config says `serverSwitcher.enabled`:
//
// - Discovery (`GET /api/servers`): the Tailscale API's devices with the Orca tag, else the config's
//   own `servers` list. The API, not `tailscale status`: an ACL that blocks box-to-box traffic hides
//   the other box from the local netmap, and the boxes are meant to be blind to each other.
// - CORS: a browser page served by one listed server may call another listed server's `/api`,
//   `/api/events` included. No other origin gets a CORS header.
// - The caller check: such a cross-origin call is accepted only from a Tailscale USER device
//   (`tailscale whois`), never a tagged node — so a server can never call another server.
//
// Same-origin calls and calls with no Origin header (the CLI, workers, other bridges) pass through
// untouched, and so does everything when the feature is off.
import { instanceName } from "./db";
import { API_PORT } from "./ports";

export type ServerEntry = { name: string; url: string };
export type ServerSwitcherConfig = {
  /** Off unless true: /api/servers names only this server, and no CORS header or whois runs. */
  enabled?: boolean;
  /** The Tailscale tag that marks an Orca server (default `tag:orca`). */
  tag?: string;
  /** The port every Orca server listens on (default 8787). */
  port?: number;
  /** The fallback list when the Tailscale API is not configured or fails. */
  servers?: ServerEntry[];
  /** When set, only these Tailscale logins may call cross-origin. */
  allowedLogins?: string[];
};
/** One row of `GET /api/servers`. */
export type ServerInfo = { name: string; url: string; online: boolean; self: boolean };
export type ServersAnswer = { enabled: boolean; self: ServerEntry; servers: ServerInfo[]; source: "tailscale" | "config" | "self" };

export const DEFAULT_TAG = "tag:orca";
export const DISCOVERY_TTL_MS = 60_000;
export const WHOIS_TTL_MS = 5 * 60_000;
/** A device the API last saw this recently counts as online when it does not say connectedToControl. */
const ONLINE_WITHIN_MS = 5 * 60_000;

/** Validation for the config document's `serverSwitcher` block (config.ts calls it). Pure. */
export function serverSwitcherProblems(v: unknown): string[] {
  if (v === undefined) return [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["serverSwitcher must be an object"];
  const s = v as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of Object.keys(s)) {
    if (!["enabled", "tag", "port", "servers", "allowedLogins"].includes(k)) errors.push(`serverSwitcher.${k} is not a known setting (enabled, tag, port, servers, allowedLogins)`);
  }
  if (s.enabled !== undefined && typeof s.enabled !== "boolean") errors.push("serverSwitcher.enabled must be true or false");
  if (s.tag !== undefined && !(typeof s.tag === "string" && /^tag:[\w-]+$/.test(s.tag))) errors.push("serverSwitcher.tag must be a Tailscale tag such as tag:orca");
  if (s.port !== undefined && !(Number.isInteger(s.port) && (s.port as number) > 0 && (s.port as number) < 65536)) errors.push("serverSwitcher.port must be a port number");
  if (s.servers !== undefined && !(Array.isArray(s.servers) && s.servers.every((e) => e && typeof e === "object"
    && typeof (e as ServerEntry).name === "string" && (e as ServerEntry).name.trim() && originOf((e as ServerEntry).url)))) {
    errors.push("serverSwitcher.servers must be a list of { name, url } with an http(s) url");
  }
  if (s.allowedLogins !== undefined && !(Array.isArray(s.allowedLogins) && s.allowedLogins.every((l) => typeof l === "string" && l.trim()))) {
    errors.push("serverSwitcher.allowedLogins must be a list of Tailscale logins");
  }
  return errors;
}

/** The origin (`scheme://host:port`) of a URL, or undefined when it is not an http(s) URL. Pure. */
export function originOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch { return undefined; }
}

const tailscaleBin = () => process.env.ORCA_TAILSCALE_BIN || Bun.which("tailscale") || "/usr/bin/tailscale";
const portOf = (sw: ServerSwitcherConfig) => sw.port ?? API_PORT;

async function runTailscale(args: string[]): Promise<unknown> {
  const proc = Bun.spawn([tailscaleBin(), ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 5_000);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) throw new Error(`tailscale ${args[0]} exited ${code}`);
    return JSON.parse(out);
  } finally { clearTimeout(timer); }
}

/** This server's own entry. `ORCA_SERVER_URL` wins; else this node's MagicDNS name from the local
 *  `tailscale status`; else localhost. Cached for the process: neither changes while it runs. */
let selfCache: { key: string; entry: ServerEntry } | undefined;
export async function selfServer(sw: ServerSwitcherConfig): Promise<ServerEntry> {
  const port = portOf(sw);
  const key = `${process.env.ORCA_SERVER_URL ?? ""}|${port}`;
  if (selfCache?.key === key) return selfCache.entry;
  const name = instanceName();
  let url = originOf(process.env.ORCA_SERVER_URL);
  if (!url) {
    try {
      const status = await runTailscale(["status", "--json"]) as { Self?: { DNSName?: string } };
      const dns = status.Self?.DNSName?.replace(/\.$/, "");
      if (dns) url = `http://${dns}:${port}`;
    } catch { /* no tailscale here: a laptop without it, a CI runner */ }
  }
  const entry = { name, url: url ?? `http://localhost:${port}` };
  selfCache = { key, entry };
  return entry;
}

type TsDevice = { name?: string; hostname?: string; tags?: string[]; lastSeen?: string; connectedToControl?: boolean };

/** Devices with the Orca tag, from the Tailscale API (tailnet `-`, the OAuth client's own). Returns
 *  undefined when no OAuth client is configured. The secret is sent to the API only, never logged. */
async function tailscaleDevices(tag: string): Promise<TsDevice[] | undefined> {
  const id = process.env.TS_OAUTH_CLIENT_ID;
  const secret = process.env.TS_OAUTH_CLIENT_SECRET;
  if (!id || !secret) return undefined;
  const base = (process.env.TS_API_URL || "https://api.tailscale.com").replace(/\/$/, "");
  const signal = AbortSignal.timeout(10_000);
  const tokenRes = await fetch(`${base}/api/v2/oauth/token`, {
    method: "POST", signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials", scope: "devices:core:read" }),
  });
  if (!tokenRes.ok) throw new Error(`Tailscale OAuth token request failed: HTTP ${tokenRes.status}`);
  const { access_token } = await tokenRes.json() as { access_token?: string };
  if (!access_token) throw new Error("Tailscale OAuth token response has no access_token");
  const res = await fetch(`${base}/api/v2/tailnet/-/devices?fields=all`, { signal, headers: { Authorization: `Bearer ${access_token}` } });
  if (!res.ok) throw new Error(`Tailscale device list failed: HTTP ${res.status}`);
  const { devices } = await res.json() as { devices?: TsDevice[] };
  return (devices ?? []).filter((d) => d.tags?.includes(tag));
}

/** Map API devices to rows. The url is the MagicDNS name and the configured port; online is
 *  connectedToControl, else a lastSeen inside the last five minutes. Pure. */
export function devicesToServers(devices: TsDevice[], port: number, now = Date.now()): (ServerEntry & { online: boolean })[] {
  return devices.filter((d) => d.name).map((d) => {
    const dns = d.name!.replace(/\.$/, "");
    const seen = d.lastSeen ? Date.parse(d.lastSeen) : NaN;
    const online = typeof d.connectedToControl === "boolean" ? d.connectedToControl : Number.isFinite(seen) && now - seen < ONLINE_WITHIN_MS;
    return { name: d.hostname || dns.split(".")[0]!, url: `http://${dns}:${port}`, online };
  });
}

/** Mark self and put it first; add it when the source does not list it. Pure. */
export function withSelf(rows: (ServerEntry & { online: boolean })[], self: ServerEntry): ServerInfo[] {
  const selfOrigin = originOf(self.url);
  const out: ServerInfo[] = rows.map((r) => ({ ...r, self: originOf(r.url) === selfOrigin }));
  const mine = out.find((r) => r.self);
  if (mine) { mine.online = true; return [mine, ...out.filter((r) => r !== mine)]; }
  return [{ ...self, online: true, self: true }, ...out];
}

let discovery: { key: string; at: number; answer: ServersAnswer } | undefined;

/** The answer of `GET /api/servers`. Cached for a minute (the API has rate limits, and the client
 *  polls). A failed API call falls back to the config list and is logged without the secret. */
export async function listServers(sw: ServerSwitcherConfig | undefined, now = Date.now()): Promise<ServersAnswer> {
  const cfg = sw ?? {};
  const self = await selfServer(cfg);
  if (!cfg.enabled) return { enabled: false, self, servers: [{ ...self, online: true, self: true }], source: "self" };
  const key = JSON.stringify(cfg);
  if (discovery && discovery.key === key && now - discovery.at < DISCOVERY_TTL_MS) return discovery.answer;
  let answer: ServersAnswer | undefined;
  try {
    const devices = await tailscaleDevices(cfg.tag ?? DEFAULT_TAG);
    if (devices) answer = { enabled: true, self, servers: withSelf(devicesToServers(devices, portOf(cfg), now), self), source: "tailscale" };
  } catch (e) {
    console.error(`orca: server discovery from the Tailscale API failed, the config list is used: ${(e as Error).message}`);
  }
  // Config entries are not probed: the boxes may not reach each other at all. The browser finds out.
  answer ??= { enabled: true, self, servers: withSelf((cfg.servers ?? []).map((s) => ({ name: s.name, url: s.url, online: true })), self), source: "config" };
  discovery = { key, at: now, answer };
  return answer;
}

export type WhoisVerdict = { ok: true; login: string } | { ok: false; reason: string };
const whoisCache = new Map<string, { at: number; verdict: WhoisVerdict }>();

/** Decide on one `tailscale whois --json` answer. Accept only a user device: a UserProfile login,
 *  and no tags (a tagged node is a server, and reports the `tagged-devices` pseudo-user). Pure. */
export function whoisVerdict(whois: unknown, allowedLogins?: string[]): WhoisVerdict {
  const w = whois as { Node?: { Tags?: string[] }; UserProfile?: { LoginName?: string } } | null;
  const tags = w?.Node?.Tags ?? [];
  const login = w?.UserProfile?.LoginName ?? "";
  if (tags.length) return { ok: false, reason: `the caller is a tagged node (${tags.join(", ")}), not a user device` };
  if (!login || login === "tagged-devices") return { ok: false, reason: "the caller has no Tailscale user login" };
  if (allowedLogins?.length && !allowedLogins.includes(login)) return { ok: false, reason: `the Tailscale login ${login} is not in serverSwitcher.allowedLogins` };
  return { ok: true, login };
}

/** Who is calling from this address, cached per address for five minutes. A whois that fails (not
 *  a tailnet address, no tailscale) is a refusal and is NOT cached, so a fixed daemon takes effect. */
export async function checkCaller(ip: string, sw: ServerSwitcherConfig, now = Date.now()): Promise<WhoisVerdict> {
  const hit = whoisCache.get(ip);
  if (hit && now - hit.at < WHOIS_TTL_MS) return hit.verdict;
  let whois: unknown;
  try { whois = await runTailscale(["whois", "--json", ip]); } catch (e) {
    return { ok: false, reason: `tailscale whois could not identify ${ip} (${(e as Error).message})` };
  }
  const verdict = whoisVerdict(whois, sw.allowedLogins);
  whoisCache.set(ip, { at: now, verdict });
  return verdict;
}

/** Forget the discovery, whois and self caches (tests). */
export function resetServerCaches(): void {
  discovery = undefined;
  selfCache = undefined;
  whoisCache.clear();
}

const CORS_METHODS = "GET, POST, PUT, DELETE, OPTIONS";

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": CORS_METHODS,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Expose-Headers": "x-orca-database",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/** The response with CORS headers added. A new Response over the same body, so a streamed answer
 *  (the SSE stream) keeps streaming and an immutable header set is never written to. */
function withCors(res: Response, origin: string): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Strip the IPv4-mapped IPv6 prefix Bun reports for an IPv4 peer on a dual-stack socket. Pure. */
export const plainIp = (ip: string): string => ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");

/**
 * Wrap one `/api` request. `next` is the normal handler. Unchanged (no CORS header, no whois) when:
 * the feature is off; the request has no Origin; the Origin is this server's own (or the request's
 * own); or the Origin is not a listed server. A listed foreign Origin gets a 204 preflight answer,
 * and every other method is first checked with whois — a 403 JSON error on refusal, else the answer
 * of `next` with CORS headers.
 */
export async function serverGate(
  req: Request, remoteIp: string | undefined, sw: ServerSwitcherConfig | undefined,
  next: () => Promise<Response>,
): Promise<Response> {
  const origin = req.headers.get("origin");
  if (!sw?.enabled || !origin) return next();
  if (origin === new URL(req.url).origin) return next();
  const answer = await listServers(sw);
  if (origin === originOf(answer.self.url)) return next();
  const listed = answer.servers.some((s) => !s.self && originOf(s.url) === origin);
  if (!listed) return next();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  const verdict = remoteIp ? await checkCaller(plainIp(remoteIp), sw) : { ok: false as const, reason: "the caller address is unknown" };
  if (!verdict.ok) {
    return withCors(Response.json({ error: `Cross-origin call refused: ${verdict.reason}. Only a Tailscale user device may call this Orca server from another Orca server's page.` }, { status: 403 }), origin);
  }
  return withCors(await next(), origin);
}
