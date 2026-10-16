// The server switcher (Settings → Server switcher): several fully separate Orca servers — a work box,
// a personal one — that never talk to each other; only this browser talks to each. The app is
// always served by its HOME server (the origin that loaded the page); every API call and the event
// stream go to ONE base URL, which is empty (same origin) unless the switcher is on and another
// server is chosen. Off, nothing here changes a request: the base is "" and the app calls only its
// own origin, exactly as before.
//
// A change of server is stored, the event stream is closed and reopened on the new base, and the
// page reloads — on the same (home) origin, so the installed iPhone app keeps its shell — which
// drops every cached store, mirror and poll at once and loads them again from the new server. A
// soft reset would have to clear each cache by hand, and one missed would show one side's data on
// the other.
import { useSyncExternalStore } from "react";
import { persistedKey, readPersisted, writePersisted } from "./persisted";

export type ServerRef = { name: string; url: string };
/** One row of the server menu: GET /api/servers' entries plus the ones added by hand. */
export type ServerEntry = ServerRef & { online?: boolean; self?: boolean; manual?: boolean };
/** GET /api/servers on the home server (the server workstream's contract). */
export type ServersAnswer = { self: ServerRef; servers: { name: string; url: string; online: boolean; self: boolean }[] };

export const SWITCHER_KEY = persistedKey("serverSwitcher");
export const CHOICE_KEY = persistedKey("server");
export const MANUAL_KEY = persistedKey("servers.manual");

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isRef = (v: unknown): v is ServerRef =>
  !!v && typeof v === "object" && typeof (v as ServerRef).name === "string" && typeof (v as ServerRef).url === "string";
const isRefs = (v: unknown): v is ServerRef[] => Array.isArray(v) && v.every(isRef);

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

export const homeOrigin = () => (typeof location === "undefined" ? "" : location.origin);
export const switcherOn = (): boolean => readPersisted(SWITCHER_KEY, false, isBool);
const storedChoice = (): ServerRef | null => readPersisted<ServerRef | null>(CHOICE_KEY, null, (v): v is ServerRef | null => v === null || isRef(v));

/** The server the app talks to, or null for the home server (the switcher off, nothing chosen, or
 *  the home server itself chosen). */
export function chosenServer(): ServerRef | null {
  if (!switcherOn()) return null;
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

/** Talk to `server` from now on (null: the home server): stored, the stream moved, the page
 *  reloaded so every store loads again from there. */
export function switchServer(server: ServerRef | null): void {
  const origin = server && serverOrigin(server.url);
  const next = origin && origin !== homeOrigin() ? { name: server.name, url: origin } : null;
  writePersisted(CHOICE_KEY, next);
  setBase(chosenServer()?.url ?? "");
  reloader();
}

/** Settings' switch. Off while on another server goes back home (reloads). */
export function setSwitcher(on: boolean): void {
  writePersisted(SWITCHER_KEY, on);
  switcherSubs.forEach((f) => f());
  if (setBase(chosenServer()?.url ?? "")) reloader();
}
const switcherSubs = new Set<() => void>();
export const useSwitcherOn = (): boolean =>
  useSyncExternalStore((cb) => { switcherSubs.add(cb); return () => { switcherSubs.delete(cb); }; }, switcherOn);

// ---- the list ----
export const manualServers = (): ServerRef[] => readPersisted(MANUAL_KEY, [], isRefs);
/** Add a server by URL (the fallback when the home server's list lacks it). Returns the entry, or
 *  null for a URL that isn't http(s). The name defaults to the host's first label. */
export function addManualServer(rawUrl: string, rawName = ""): ServerRef | null {
  const url = serverOrigin(rawUrl);
  if (!url) return null;
  const name = rawName.trim() || new URL(url).hostname.split(".")[0]!;
  writePersisted(MANUAL_KEY, [...manualServers().filter((s) => s.url !== url), { name, url }]);
  listSubs.forEach((f) => f());
  return { name, url };
}
const listSubs = new Set<() => void>();
/** Called when a server is added by hand. */
export function onManualChange(fn: () => void): () => void { listSubs.add(fn); return () => { listSubs.delete(fn); }; }

/** The menu's rows: the home server's answer (self first), then the added-by-hand ones it lacks.
 *  With no answer (an older server without the route, or a failed fetch) the home server is still
 *  listed, as "Home". Pure. */
export function mergeServers(answer: ServersAnswer | null, manual: ServerRef[], home: string): ServerEntry[] {
  const out: ServerEntry[] = [];
  const seen = new Set<string>();
  const push = (e: ServerEntry) => { const u = serverOrigin(e.url); if (!u || seen.has(u)) return; seen.add(u); out.push({ ...e, url: u }); };
  const self = answer?.self ? { ...answer.self, url: home } : { name: "Home", url: home };
  push({ ...self, self: true, online: true });
  for (const s of answer?.servers ?? []) if (!s.self) push({ name: s.name, url: s.url, online: s.online });
  for (const s of manual) push({ ...s, manual: true });
  return out;
}

/** GET /api/servers on the HOME server — never the chosen base: the list is the home server's. */
export async function fetchServers(): Promise<ServersAnswer | null> {
  try {
    const r = await fetch("/api/servers", { cache: "no-store" });
    if (!r.ok) return null;
    const v = await r.json() as ServersAnswer;
    return v && isRef(v.self) && Array.isArray(v.servers) ? v : null;
  } catch { return null; }
}

/** The current side: the chosen server, else the home server under the name its list gives it. */
export function currentServer(list: ServerEntry[]): ServerEntry {
  const c = chosenServer();
  return (c && list.find((s) => s.url === c.url)) ?? (c ? { ...c } : list.find((s) => s.self) ?? { name: "Home", url: homeOrigin(), self: true });
}

/** A stable tint per server name, so each side reads at a glance. Pure. */
const TONES = [
  "bg-geist-blue/15 text-geist-blue",
  "bg-geist-green/15 text-geist-green",
  "bg-purple-500/15 text-purple-700 dark:text-purple-400",
  "bg-geist-amber/15 text-geist-warning-fg",
  "bg-geist-pink/15 text-geist-pink",
  "bg-geist-teal/20 text-teal-700 dark:text-geist-teal",
];
export function serverTone(name: string): string {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length]!;
}

/** Tests: re-read the stored choice and forget the status. */
export function _resetServer(): void { setBase(chosenServer()?.url ?? ""); status = "ok"; }
