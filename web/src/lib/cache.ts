// The browser's ONE read cache: every view that loads data from the bridge keeps its last answer
// here, keyed by what it asked for, instead of in its own component state.
//
// Why: a view's `useState(null)` + fetch-on-mount threw the data away on every page change, so on a
// phone (the installed app, no back swipe) going back to a chat, the Inbox or the PR page showed
// "Loading…" for one round trip over the tailnet each time. Now a view paints the last answer at once
// and fetches again in the background (stale-while-revalidate). Live updates are not touched: the
// chat still applies its SSE steps and `turn` events (lib/events.ts) and writes them through here,
// and every poll still runs through `poll()` (lib/poll.ts), so "Refresh everything" re-runs them.
//
// Not TanStack Query: the board store (store.ts) and `poll()` already do the scheduling, dedup and
// refresh work, and a library would sit beside them. This is the missing piece only: a keyed store
// with subscribers, in-flight dedup, and a hook.
//
// The board store keeps its own module state (it already survives a page change) and is NOT persisted:
// its enrichment drives Follow, which launches agents, and a stale `followSig` read from disk could
// fire a run twice. Display-only entries (a chat's newest pages, the Inbox) opt in to `persist`: they
// are written to IndexedDB, at most PERSIST_MAX of them, and read back once at boot, so the installed
// app opens on the last data after iOS kills it in the background. The record names the server
// (lib/server.ts `apiBase`) and CACHE_SCHEMA, so one server's data never shows on another.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { poll } from "./poll";
import { onRefresh } from "./refresh";
import { apiBase } from "./server";

/** Bump when a persisted value's shape changes: old records are then ignored. */
export const CACHE_SCHEMA = 1;
/** Entries kept in memory; the least recently used one with no reader goes first. */
export const CACHE_MAX = 300;
/** Entries written to disk (the most recently used `persist` ones). */
export const PERSIST_MAX = 24;
const SAVE_DELAY_MS = 1_000;

/** `persist`: true writes the value as is; a function writes what it returns (smaller), or nothing
 *  for `undefined`. `ver`: the input the value was fetched for (see useCached's `version`). */
type Persist = boolean | ((v: never) => unknown);
type Entry = { value?: unknown; error?: string; at: number; ver?: unknown; persist?: Persist };

const entries = new Map<string, Entry>(); // insertion order = recency
const subs = new Map<string, Set<() => void>>();
const flights = new Map<string, { run: Promise<unknown>; again?: Promise<unknown> }>();

function touch(key: string, e: Entry): void { entries.delete(key); entries.set(key, e); }
function emit(key: string): void { subs.get(key)?.forEach((fn) => fn()); }
function evict(): void {
  if (entries.size <= CACHE_MAX) return;
  for (const k of entries.keys()) {
    if (entries.size <= CACHE_MAX) break;
    if (!subs.get(k)?.size) entries.delete(k);
  }
}

/** The cached value, or undefined. */
export function cacheGet<T>(key: string): T | undefined {
  return entries.get(key)?.value as T | undefined;
}
/** When the value was last set (ms), or undefined. */
export const cacheAt = (key: string): number | undefined => entries.get(key)?.at;

/** Set a value (or derive it from the one there). Readers re-render; a `persist` entry is saved soon. */
export function cacheSet<T>(key: string, value: T | ((prev: T | undefined) => T), opts: { persist?: Persist; ver?: unknown } = {}): void {
  const prev = entries.get(key);
  const next = typeof value === "function" ? (value as (p: T | undefined) => T)(prev?.value as T | undefined) : value;
  if (prev && prev.value === next && prev.error === undefined) return;
  const persist = opts.persist ?? prev?.persist;
  touch(key, { value: next, at: Date.now(), ver: "ver" in opts ? opts.ver : prev?.ver, persist });
  evict();
  emit(key);
  if (persist) scheduleSave();
}

/** Drop entries whose key starts with `prefix` (after a write that makes them wrong). A mounted
 *  reader keeps what it shows until its next fetch. */
export function cacheDrop(prefix: string): void {
  for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k);
}

/** Fetch into the cache. One request per key at a time: a call while one is in flight gets ONE fresh
 *  request after it (its answer may predate what the caller just did — store.ts `coalesced`). A
 *  failure keeps the last good value and records the error; the promise still rejects. */
export function cacheFetch<T>(key: string, fetcher: () => Promise<T>, opts: { persist?: Persist; ver?: unknown } = {}): Promise<T> {
  const flight = flights.get(key);
  if (flight) {
    if (!flight.again) {
      flight.again = flight.run.catch(() => {}).then(() => { flights.delete(key); return cacheFetch(key, fetcher, opts); });
    }
    return flight.again as Promise<T>;
  }
  const run = fetcher().then(
    (v) => { cacheSet(key, v, opts); return v; },
    (err) => {
      const prev = entries.get(key);
      const error = err instanceof Error ? err.message : String(err);
      touch(key, { ...(prev ?? { at: 0 }), error, persist: opts.persist ?? prev?.persist });
      emit(key);
      throw err;
    },
  );
  const f = { run: run as Promise<unknown> } as { run: Promise<unknown>; again?: Promise<unknown> };
  flights.set(key, f);
  run.then(() => {}, () => {}).then(() => { if (flights.get(key) === f && !f.again) flights.delete(key); });
  return run;
}

function subscribeKey(key: string, fn: () => void): () => void {
  let set = subs.get(key);
  if (!set) subs.set(key, (set = new Set()));
  set.add(fn);
  return () => { set!.delete(fn); if (!set!.size) subs.delete(key); };
}

/** Read one key and re-render when it changes (no fetch). */
export function useCacheValue<T>(key: string | null): T | undefined {
  const sub = useCallback((fn: () => void) => (key ? subscribeKey(key, fn) : () => {}), [key]);
  return useSyncExternalStore(sub, () => (key ? entries.get(key)?.value as T | undefined : undefined));
}
function useCacheError(key: string | null): string | undefined {
  const sub = useCallback((fn: () => void) => (key ? subscribeKey(key, fn) : () => {}), [key]);
  return useSyncExternalStore(sub, () => (key ? entries.get(key)?.error : undefined));
}

export type CachedOpts = {
  /** Fetch again every `poll` ms while mounted (through lib/poll.ts). Without it: once per mount. */
  poll?: number;
  /** The window whose visibility and timers the poll uses (the orchestrator's pop-out passes its own). */
  host?: Window;
  /** Skip the mount fetch while the value is younger than this (ms) AND was fetched for the same
   *  `version`. Default 0: always revalidate. */
  fresh?: number;
  /** An input the answer depends on that is not in the key (an agent's run status, for a diffstat).
   *  A change fetches again at once, even inside `fresh`. */
  version?: unknown;
  persist?: Persist;
};

/** Stale-while-revalidate for one key: `data` is the cached value at once (undefined only the first
 *  time), then the fetch's answer. `error` is the last failure, cleared by the next success.
 *  `key` null: nothing is read or fetched. */
export function useCached<T>(key: string | null, fetcher: () => Promise<T>, opts: CachedOpts = {}): { data: T | undefined; error: string | undefined; refresh: () => Promise<void> } {
  const data = useCacheValue<T>(key);
  const error = useCacheError(key);
  const latest = useRef({ fetcher, opts });
  latest.current = { fetcher, opts };
  const refresh = useCallback(async () => {
    if (!key) return;
    const { fetcher: f, opts: o } = latest.current;
    await cacheFetch(key, f, { persist: o.persist, ver: o.version }).catch(() => {});
  }, [key]);
  const { poll: every, host, fresh = 0, version } = opts;
  useEffect(() => {
    if (!key) return;
    if (every) return poll(refresh, every, host ?? window);
    const e = entries.get(key);
    const young = e && e.value !== undefined && Date.now() - e.at < fresh && Object.is(e.ver, version);
    if (!young) void refresh();
    return onRefresh(refresh);
  }, [key, every, host, version, refresh]);
  return { data, error, refresh };
}

// ---- persistence (IndexedDB) ----

/** Where persisted entries go. IndexedDB in a browser; a test passes its own. */
export type CacheBackend = { load: (record: string) => Promise<unknown>; save: (record: string, value: unknown) => Promise<void> };
type Saved = { schema: number; entries: [string, { value: unknown; at: number }][] };

const DB = "orca-cache", STORE = "kv";
function indexedDbBackend(): CacheBackend | null {
  if (typeof indexedDB === "undefined") return null;
  let db: Promise<IDBDatabase> | null = null;
  const open = () => (db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
  const tx = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => open().then((d) => new Promise<T>((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  return {
    load: (record) => tx("readonly", (s) => s.get(record)),
    save: (record, value) => tx("readwrite", (s) => s.put(value, record)).then(() => {}),
  };
}

let backend: CacheBackend | null | undefined;
const backendOf = () => (backend === undefined ? (backend = indexedDbBackend()) : backend);
/** The record's name: one per server this browser talks to. */
const recordName = () => `entries:${apiBase() || (typeof location === "undefined" ? "" : location.origin)}`;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** What would be written now: the newest PERSIST_MAX persisted entries, each through its shrink. */
export function persistSnapshot(): Saved {
  const out: Saved["entries"] = [];
  for (const [k, e] of [...entries].reverse()) {
    if (out.length >= PERSIST_MAX) break;
    if (!e.persist || e.value === undefined) continue;
    const value = typeof e.persist === "function" ? (e.persist as (v: unknown) => unknown)(e.value) : e.value;
    if (value !== undefined) out.push([k, { value, at: e.at }]);
  }
  return { schema: CACHE_SCHEMA, entries: out.reverse() };
}

/** Write the persisted entries now. A failure (private mode, quota) is ignored: the cache is a speed-up. */
export async function cacheSave(): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const b = backendOf();
  if (!b) return;
  try { await b.save(recordName(), persistSnapshot()); } catch { /* keep working from memory */ }
}
function scheduleSave(): void {
  if (saveTimer || !backendOf()) return;
  saveTimer = setTimeout(() => void cacheSave(), SAVE_DELAY_MS);
}
// iOS ends a backgrounded app without warning: write when the page is hidden.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && saveTimer) void cacheSave(); });
}

/** Read the persisted entries back, once, at boot. An entry already in memory (a fetch that won the
 *  race) is newer and stays. Gives up after `waitMs`, so a slow disk never holds the first paint. */
export async function cacheHydrate(waitMs = 300): Promise<void> {
  const b = backendOf();
  if (!b) return;
  const read = b.load(recordName()).then((raw) => {
    const saved = raw as Saved | undefined;
    if (!saved || saved.schema !== CACHE_SCHEMA || !Array.isArray(saved.entries)) return;
    for (const [k, { value, at }] of saved.entries) {
      if (entries.has(k)) continue;
      entries.set(k, { value, at, persist: true });
      emit(k);
    }
  }).catch(() => {});
  await Promise.race([read, new Promise((r) => setTimeout(r, waitMs))]);
}

/** Tests: start empty, and use `b` (or no disk) for persistence. */
export function _resetCache(b: CacheBackend | null = null): void {
  entries.clear();
  flights.clear();
  clearTimeout(saveTimer);
  saveTimer = undefined;
  backend = b;
}
