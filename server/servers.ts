// The server switcher (Option B): several fully separate Orca servers that never talk to each other —
// a work box, later a personal one — and ONE browser that talks to each. This module is the server
// side of it. It is on unless the app config says `serverSwitcher.enabled: false`:
//
// - Discovery (`GET /api/servers`): the Tailscale API's devices with the Orca tag, else the config's
//   own `servers` list. The API, not `tailscale status`: an ACL that blocks box-to-box traffic hides
//   the other box from the local netmap, and the boxes are meant to be blind to each other. The
//   answer says whether the API is configured (`tailscaleApi`); without it the browser adds the
//   servers it already knows (web/src/lib/server.ts), and it checks every server's health itself.
// - CORS: a browser page served by another Orca server may call this server's `/api`, `/api/events`
//   included. "Another Orca server" is a listed origin, or an origin on this tailnet on the Orca port
//   (`trustedOrigin`) — so it works with no API and no list. A `localhost`/`127.0.0.1` origin on the
//   API port or the Vite dev port (`ORCA_UI_PORT`, 8788) is trusted too: the laptop dev app runs on
//   plain localhost, with no tailnet name of its own, and must still reach a box's switcher. No other
//   origin gets a CORS header.
// - The caller check: such a cross-origin call is accepted only from a Tailscale USER device
//   (`tailscale whois`), never a tagged node — so a server can never call another server.
//
// Same-origin calls and calls with no Origin header (the CLI, workers, other bridges) pass through
// untouched, and so does everything when the feature is off.
import { instanceName } from "./db";
import { API_PORT } from "./ports";

export type ServerEntry = { name: string; url: string };
export type ServerSwitcherConfig = {
  /** On unless false. False: /api/servers names only this server, and no CORS header or whois runs. */
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
export type ServersAnswer = {
  enabled: boolean; self: ServerEntry; servers: ServerInfo[]; source: "tailscale" | "config" | "self";
  /** The Tailscale API is configured here (TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET are set). */
  tailscaleApi: boolean;
};

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
/** The Vite dev port (web/vite.config.ts), trusted for a localhost/127.0.0.1 origin alongside the
 *  API port, so the laptop dev app (http://localhost:8788) reaches a box's switcher. */
const DEV_UI_PORT = Number(process.env.ORCA_UI_PORT ?? 8788);
/** The switcher is on unless the config turns it off. */
export const switcherEnabled = (sw: ServerSwitcherConfig | undefined): boolean => sw?.enabled !== false;
const apiConfigured = () => !!(process.env.TS_OAUTH_CLIENT_ID && process.env.TS_OAUTH_CLIENT_SECRET);

async function runTailscale(args: string[]): Promise<unknown> {
  const proc = Bun.spawn([tailscaleBin(), ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 5_000);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) throw new Error(`tailscale ${args[0]} exited ${code}`);
    return JSON.parse(out);
  } finally { clearTimeout(timer); }
}

/** This server's own entry and its tailnet's MagicDNS suffix (`tail1234.ts.net`). The url is
 *  `ORCA_SERVER_URL`, else this node's MagicDNS name from the local `tailscale status`, else
 *  localhost. The name is the MagicDNS name's first label (its Tailscale hostname, e.g.
 *  `orca-flow-box`) when `tailscale status` gives one, else `instanceName()` — the Orca instance
 *  name (`cloud`, `local`) stays the name everywhere else in Orca (the board's `on:`, `instances`);
 *  only the switcher's self entry reads the tailnet hostname. Cached for the process: none of it
 *  changes while it runs. */
let selfCache: { key: string; entry: ServerEntry; suffix?: string } | undefined;
async function selfInfo(sw: ServerSwitcherConfig): Promise<{ entry: ServerEntry; suffix?: string }> {
  const port = portOf(sw);
  const key = `${process.env.ORCA_SERVER_URL ?? ""}|${port}`;
  if (selfCache?.key === key) return selfCache;
  let url = originOf(process.env.ORCA_SERVER_URL);
  let dns: string | undefined;
  try {
    const status = await runTailscale(["status", "--json"]) as { Self?: { DNSName?: string } };
    dns = status.Self?.DNSName?.replace(/\.$/, "") || undefined;
  } catch { /* no tailscale here: a laptop without it, a CI runner */ }
  const name = dns ? dns.split(".")[0]! : instanceName();
  if (!url && dns) url = `http://${dns}:${port}`;
  const suffix = dns?.includes(".") ? dns.slice(dns.indexOf(".") + 1) : undefined;
  selfCache = { key, entry: { name, url: url ?? `http://localhost:${port}` }, suffix };
  return selfCache;
}
export const selfServer = async (sw: ServerSwitcherConfig): Promise<ServerEntry> => (await selfInfo(sw)).entry;

/** May a page from `origin` call this server cross-origin (subject to whois)? Yes when the
 *  discovery lists it, or when it is an Orca page on this tailnet: a host under this node's MagicDNS
 *  suffix, a MagicDNS short name or a Tailscale address (100.64.0.0/10) — on the Orca port, or on
 *  HTTPS (`tailscale serve`). A preview on another port, or any site off the tailnet, is not. A plain
 *  `localhost`/`127.0.0.1` origin is trusted too, but only on the API port or the Vite dev port
 *  (`uiPort`): the laptop dev app has no tailnet name of its own and must still reach a box. The
 *  whois check still runs after this (`checkCaller`): only a Tailscale user device, never a tagged
 *  node or an off-tailnet caller, gets through. Pure. */
export function trustedOrigin(origin: string, listed: string[], suffix: string | undefined, port: number, uiPort: number = DEV_UI_PORT): boolean {
  if (listed.includes(origin)) return true;
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  const host = u.hostname.toLowerCase();
  if (u.protocol === "http:" && (host === "localhost" || host === "127.0.0.1")) {
    return u.port === String(port) || u.port === String(uiPort);
  }
  const onPort = u.protocol === "https:" ? u.port === "" || u.port === "443" : u.protocol === "http:" && u.port === String(port);
  if (!onPort) return false;
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  if (m) return Number(m[1]) >= 64 && Number(m[1]) <= 127;
  if (/^[a-z0-9-]+$/.test(host)) return host !== "localhost";
  return !!suffix && host.endsWith(`.${suffix.toLowerCase()}`);
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
  const tailscaleApi = apiConfigured();
  if (!switcherEnabled(cfg)) return { enabled: false, self, servers: [{ ...self, online: true, self: true }], source: "self", tailscaleApi };
  const key = JSON.stringify(cfg);
  if (discovery && discovery.key === key && now - discovery.at < DISCOVERY_TTL_MS) return discovery.answer;
  let answer: ServersAnswer | undefined;
  try {
    const devices = await tailscaleDevices(cfg.tag ?? DEFAULT_TAG);
    if (devices) answer = { enabled: true, self, servers: withSelf(devicesToServers(devices, portOf(cfg), now), self), source: "tailscale", tailscaleApi };
  } catch (e) {
    console.error(`orca: server discovery from the Tailscale API failed, the config list is used: ${(e as Error).message}`);
  }
  // Config entries are not probed: the boxes may not reach each other at all. The browser checks
  // each server itself, so `online` here is only the API's view (true for a config entry).
  answer ??= { enabled: true, self, servers: withSelf((cfg.servers ?? []).map((s) => ({ name: s.name, url: s.url, online: true })), self), source: "config", tailscaleApi };
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
 * own); or the Origin is not trusted (`trustedOrigin`). A trusted foreign Origin gets a 204 preflight answer,
 * and every other method is first checked with whois — a 403 JSON error on refusal, else the answer
 * of `next` with CORS headers.
 */
export async function serverGate(
  req: Request, remoteIp: string | undefined, sw: ServerSwitcherConfig | undefined,
  next: () => Promise<Response>,
): Promise<Response> {
  const origin = req.headers.get("origin");
  if (!switcherEnabled(sw) || !origin) return next();
  if (origin === new URL(req.url).origin) return next();
  const cfg = sw ?? {};
  const answer = await listServers(cfg);
  if (origin === originOf(answer.self.url)) return next();
  const listed = answer.servers.filter((s) => !s.self).map((s) => originOf(s.url)).filter((o): o is string => !!o);
  if (!trustedOrigin(origin, listed, (await selfInfo(cfg)).suffix, portOf(cfg))) return next();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  const verdict = remoteIp ? await checkCaller(plainIp(remoteIp), cfg) : { ok: false as const, reason: "the caller address is unknown" };
  if (!verdict.ok) {
    return withCors(Response.json({ error: `Cross-origin call refused: ${verdict.reason}. Only a Tailscale user device may call this Orca server from another Orca server's page.` }, { status: 403 }), origin);
  }
  return withCors(await next(), origin);
}
