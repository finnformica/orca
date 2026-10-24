// The server switcher (the sidebar's server menu, desktop; on a phone there is none — see Shell.tsx):
// several fully separate Orca servers — a work box,
// a personal one — that never talk to each other; only this browser talks to each. The app is
// always served by its HOME server (the origin that loaded the page); every API call and the event
// stream go to ONE base URL, which is empty (same origin) unless another server is chosen. With
// nothing chosen, nothing here changes a request.
//
// The list (`mergeServers`): the home server's GET /api/servers first. When that server has the
// Tailscale API configured, its list is the whole list. Else the browser adds every server it has
// opened, switched to or added (`KNOWN_KEY`), and the lists of the servers that answer it. The
// health of each server is checked FROM THIS BROWSER (`probeServer`, a short timeout), because the
// boxes cannot see each other and the browser is what has to reach them.
//
// A change of server is stored, the event stream is closed and reopened on the new base, and the
// page reloads — on the same (home) origin, so the installed iPhone app keeps its shell — which
// drops every cached store, mirror and poll at once and loads them again from the new server. A
// soft reset would have to clear each cache by hand, and one missed would show one side's data on
// the other.
import { useSyncExternalStore } from "react";
import { persistedKey, readPersisted, writePersisted } from "./persisted";
import { resolveIdentity, type ServerIdentity, type ServerIdentityConfig } from "../../../shared/serverIdentity";

export type ServerRef = { name: string; url: string };
/** The browser's own Tailscale identity, read off `self.tailscaleUser` (server/servers.ts
 *  `tailscaleUserFromHeaders`): present only when `tailscale serve` fronts this bridge and the
 *  request reached it over loopback. `picture` is a URL, absent when the identity provider gives
 *  none. */
export type TailscaleUser = { login: string; name?: string; picture?: string };
/** A server's display name and theme colour, as its GET /api/servers `self` row gives them (absent on
 *  an older server). `name` stays the Tailscale host name. */
export type IdentityFields = { label?: string; color?: string; identity?: ServerIdentityConfig; tailscaleUser?: TailscaleUser };
/** What this browser found when it asked a server (`probeServer`): it answered, it answered 403
 *  (whois refused this device, or no CORS), or no answer inside the timeout. */
export type ServerHealth = "checking" | "online" | "offline" | "refused";
/** One row of the server menu. */
export type ServerEntry = ServerRef & { health: ServerHealth; self?: boolean; label: string; color: string };
/** GET /api/servers (server/servers.ts). `tailscaleApi` and `enabled` are absent on an older server. */
export type ServersAnswer = {
  self: ServerRef & IdentityFields; servers: { name: string; url: string; online: boolean; self: boolean }[];
  enabled?: boolean; source?: string; tailscaleApi?: boolean;
};
export type Probe = { health: "online"; answer: ServersAnswer } | { health: "offline" | "refused" };

/** A new key: a choice stored under the old Settings switch (off by default) is never applied now. */
export const CHOICE_KEY = persistedKey("server.choice");
/** Every server this browser opened, switched to or added. */
export const KNOWN_KEY = persistedKey("servers.known");
/** How long a health check waits. An offline tailnet peer never refuses; it is silent. */
export const PROBE_TIMEOUT_MS = 2_500;

const isRef = (v: unknown): v is ServerRef =>
  !!v && typeof v === "object" && typeof (v as ServerRef).name === "string" && typeof (v as ServerRef).url === "string";
const isRefs = (v: unknown): v is ServerRef[] => Array.isArray(v) && v.every(isRef);
const isAnswer = (v: unknown): v is ServersAnswer => !!v && typeof v === "object" && isRef((v as ServersAnswer).self) && Array.isArray((v as ServersAnswer).servers);

/** A server URL as an origin (`http://host:port`, no path or trailing slash), or null if it isn't
 *  an http(s) URL. A bare `host:port` is read as http. */
export function serverOrigin(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch { return null; }
}

/** The name of a server that has not answered yet: its host's first label, or the whole host for an
 *  IP address (the first label of 100.101.1.2 is "100"). The server's own name replaces it once it
 *  answers. Pure. */
export function defaultServerName(origin: string): string {
  const host = new URL(origin).hostname;
  return /^[\d.]+$|:/.test(host) ? host : host.split(".")[0]!;
}

export const homeOrigin = () => (typeof location === "undefined" ? "" : location.origin);
const storedChoice = (): ServerRef | null => readPersisted<ServerRef | null>(CHOICE_KEY, null, (v): v is ServerRef | null => v === null || isRef(v));

/** The server the app talks to, or null for the home server (nothing chosen, or the home server
 *  itself chosen). */
export function chosenServer(): ServerRef | null {
  const c = storedChoice();
  const origin = c && serverOrigin(c.url);
  return c && origin && origin !== homeOrigin() ? { name: c.name, url: origin } : null;
}

let base = chosenServer()?.url ?? "";
const baseSubs = new Set<() => void>();
/** The one API base: "" (same origin) unless another server is chosen. */
export const apiBase = (): string => base;
/** `path` (an absolute `/api/…` path) on the chosen server. Anything else (a data: URL, a full
 *  URL) is returned unchanged. */
export const apiUrl = (path: string): string => (path.startsWith("/") && !path.startsWith("//") ? base + path : path);
/** Called with every base change (the event stream reopens itself on it). */
export function onBaseChange(fn: () => void): () => void { baseSubs.add(fn); return () => { baseSubs.delete(fn); }; }
function setBase(next: string): boolean {
  if (next === base) return false;
  base = next;
  // A new server starts with no verdict: the old one's "unreachable" says nothing about it.
  setStatus("ok");
  baseSubs.forEach((f) => f());
  return true;
}

// ---- reachability of the chosen server ----
// Only a REMOTE base is judged: the home server has its own offline screen (Freshness.tsx).
export type ServerStatus = "ok" | "unreachable" | "refused";
let status: ServerStatus = "ok";
const statusSubs = new Set<() => void>();
function setStatus(s: ServerStatus) { if (s !== status) { status = s; statusSubs.forEach((f) => f()); } }
export const serverStatus = (): ServerStatus => status;
export const useServerStatus = (): ServerStatus =>
  useSyncExternalStore((cb) => { statusSubs.add(cb); return () => { statusSubs.delete(cb); }; }, () => status);

/** `fetch` of an API path on the chosen server. On a remote base it records what the answer says
 *  about the server: a 403 is "refused" (not in its allow-list), a network error "unreachable"
 *  (offline, or a CORS refusal, which the browser reports the same way), anything else "ok". An
 *  abort (a stuck request a refresh gave up on) says nothing. */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const remote = base !== "" && path.startsWith("/");
  return fetch(apiUrl(path), init).then(
    (r) => { if (remote) setStatus(r.status === 403 ? "refused" : "ok"); return r; },
    (e: unknown) => {
      if (remote && !(e instanceof Error && e.name === "AbortError") && !init?.signal?.aborted) setStatus("unreachable");
      throw e;
    },
  );
}

// ---- choosing ----
let reloader = (): void => { window.location.reload(); };
/** Tests: replace the page reload. */
export function _setReloader(fn: () => void): void { reloader = fn; }

/** Talk to `server` from now on (null: the home server): stored, remembered, the stream moved, the
 *  page reloaded so every store loads again from there. */
export function switchServer(server: ServerRef | null): void {
  const origin = server && serverOrigin(server.url);
  const next = origin && origin !== homeOrigin() ? { name: server.name, url: origin } : null;
  if (next) rememberServer(next);
  writePersisted(CHOICE_KEY, next);
  setBase(chosenServer()?.url ?? "");
  reloader();
}

// ---- the list ----
export const knownServers = (): ServerRef[] => readPersisted(KNOWN_KEY, [], isRefs);
const knownSubs = new Set<() => void>();
/** Called when the known list changes. */
export function onKnownChange(fn: () => void): () => void { knownSubs.add(fn); return () => { knownSubs.delete(fn); }; }
/** Remember a server (by origin; a new name replaces the old one). Returns the stored entry, or
 *  null for a URL that isn't http(s). */
export function rememberServer(server: { url: string; name?: string }): ServerRef | null {
  const url = serverOrigin(server.url);
  if (!url) return null;
  const name = server.name?.trim() || defaultServerName(url);
  const known = knownServers();
  const prev = known.find((s) => s.url === url);
  if (prev?.name === name) return prev;
  writePersisted(KNOWN_KEY, prev ? known.map((s) => (s.url === url ? { name, url } : s)) : [...known, { name, url }]);
  knownSubs.forEach((f) => f());
  return { name, url };
}

/** Ask one server for its GET /api/servers, with a short timeout. A cross-origin call: the server
 *  answers it only for a Tailscale user device (server/servers.ts `serverGate`). Never throws.
 *
 *  An origin the server does not trust (server/servers.ts `trustedOrigin`) sends no
 *  Access-Control-Allow-Origin header at all, so the browser blocks the answer before this code ever
 *  sees it — the same network-error shape as a server that is simply down. The two are told apart
 *  with a second, `no-cors` fetch of the same URL: it still fails for a dead server (the connection
 *  itself never succeeds), but resolves (as an unreadable opaque response) for a live server that
 *  just refused the first call on origin — read as "refused", not "offline". */
export async function probeServer(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<Probe> {
  try {
    const r = await fetch(`${url}/api/servers`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 403) return { health: "refused" };
    const v: unknown = r.ok ? await r.json() : null;
    return isAnswer(v) ? { health: "online", answer: v } : { health: "offline" };
  } catch {
    try {
      await fetch(`${url}/api/servers`, { cache: "no-store", mode: "no-cors", signal: AbortSignal.timeout(timeoutMs) });
      return { health: "refused" };
    } catch { return { health: "offline" }; }
  }
}

/** Whether `origin` is this machine talking to itself with no tailnet name: `localhost` or
 *  `127.0.0.1` (the laptop dev app, run as instance `local`). Such an origin is never an Orca box —
 *  it is never listed in the switcher, as a home row or learned from any other source. Pure. */
function isLocalOrigin(origin: string): boolean {
  try { return ["localhost", "127.0.0.1"].includes(new URL(origin).hostname); } catch { return false; }
}

/** The identity a server shows: its own answer's label and colour, else (an older server, or one
 *  that has not answered) its name and the colour derived from it — what the server itself shows
 *  with nothing set. Pure. */
export function identityOf(self: { name: string } & IdentityFields): ServerIdentity {
  const resolved = resolveIdentity(undefined, self.label || self.name);
  return { label: resolved.label, color: self.color ?? resolved.color };
}

/**
 * The menu's rows, in order; each server once. Pure.
 * 1. The home server (the origin that served this page), under the name its answer gives it —
 *    unless that origin is localhost/127.0.0.1 (not an Orca box), which is never listed.
 * 2. The home server's list: the Tailscale API's devices, else its config list.
 * 3. Only when the home server has no Tailscale API: every server this browser knows, then the
 *    lists of the servers that answered this browser.
 * The chosen server is always listed. A server that answered goes by ITS OWN name, and a second
 * URL for a server already listed (a short name, an IP, the MagicDNS name) is dropped. A
 * localhost/127.0.0.1 URL, learned from any source, is never listed.
 */
export function mergeServers(
  home: string, answer: ServersAnswer | null, known: ServerRef[], probes: Record<string, Probe>, chosen: ServerRef | null = null,
): ServerEntry[] {
  const out: ServerEntry[] = [];
  const origins = new Set<string>();
  const names = new Set<string>();
  const homeLocal = isLocalOrigin(home);
  if (!homeLocal) {
    const homeName = answer?.self.name ?? "This server";
    out.push({ name: homeName, url: home, self: true, health: "online", ...identityOf(answer?.self ?? { name: homeName }) });
    names.add(homeName.toLowerCase());
  }
  origins.add(home);
  const selfUrl = answer && serverOrigin(answer.self.url);
  if (selfUrl) origins.add(selfUrl);
  const candidates: ServerRef[] = [...(answer?.servers ?? []).filter((s) => !s.self), ...(chosen ? [chosen] : [])];
  if (!answer?.tailscaleApi) {
    candidates.push(...known);
    for (const p of Object.values(probes)) if (p.health === "online") candidates.push(p.answer.self, ...p.answer.servers.filter((s) => !s.self));
  }
  for (const c of candidates) {
    const url = serverOrigin(c.url);
    if (!url || origins.has(url) || isLocalOrigin(url)) continue;
    const probe = probes[url];
    const name = probe?.health === "online" ? probe.answer.self.name : c.name || defaultServerName(url);
    if (names.has(name.toLowerCase())) continue;
    origins.add(url);
    names.add(name.toLowerCase());
    if (probe?.health === "online") { const own = serverOrigin(probe.answer.self.url); if (own) origins.add(own); }
    out.push({ name, url, health: probe?.health ?? "checking", ...identityOf(probe?.health === "online" ? probe.answer.self : { name }) });
  }
  return out;
}

/** Whether the sidebar shows a server section in its menu: the home server has not turned the switcher off, and
 *  there is a server to switch to — or there is no Tailscale API, so Add server must be reachable.
 *  The list has a self row only when the home origin is an Orca box (not localhost/127.0.0.1): then
 *  "a server to switch to" needs more than that one row; with no self row, any row is one. No
 *  answer (a fetch failure, an older server): only with more than one server. Pure. */
export const showServerMenu = (answer: ServersAnswer | null, list: ServerEntry[]): boolean => {
  const minListed = list.some((s) => s.self) ? 1 : 0;
  return answer ? answer.enabled !== false && (list.length > minListed || !answer.tailscaleApi) : list.length > 1;
};

/** GET /api/servers on the HOME server — never the chosen base: the list is the home server's. */
export async function fetchServers(): Promise<ServersAnswer | null> {
  try {
    const r = await fetch("/api/servers", { cache: "no-store" });
    if (!r.ok) return null;
    const v: unknown = await r.json();
    return isAnswer(v) ? v : null;
  } catch { return null; }
}

/** The current side: the chosen server, else the home server — or, on a localhost/127.0.0.1 home
 *  (not an Orca box, so it is not in the list), the first server of the home answer's list. */
export function currentServer(list: ServerEntry[]): ServerEntry {
  const c = chosenServer();
  return (c && list.find((s) => s.url === c.url)) ?? (c ? { ...c, health: "checking", ...identityOf(c) }
    : list.find((s) => s.self) ?? list[0] ?? { name: "This server", url: homeOrigin(), self: true, health: "online", ...identityOf({ name: "This server" }) });
}

/** Tests: re-read the stored choice and forget the status. */
export function _resetServer(): void { setBase(chosenServer()?.url ?? ""); status = "ok"; }
