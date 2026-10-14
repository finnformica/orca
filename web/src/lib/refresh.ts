// "Refresh everything", the top bar's Updated-… chip. Every source of what a page shows registers
// here — each `poll()` (lib/poll.ts) does so itself; the loops that aren't polls (the board's agents/PRs
// stream, usage, the notification centre, an open chat) call `onRefresh`. A refresh first ABORTS every
// GET that has been in flight longer than STUCK_MS (a request held by a peer that isn't answering, or
// queued behind the browser's six connections — what makes the board look frozen), then re-runs
// every source at once and resolves when all have settled. A refresh still pending after DEADLINE_MS
// means the page itself is wedged: it falls back to a hard reload.
import { useSyncExternalStore } from "react";

export const STUCK_MS = 3_000;
export const DEADLINE_MS = 15_000;

type InFlight = { ctl: AbortController; at: number };
const inflight = new Set<InFlight>();

/** `fetch` for a GET, tracked so a refresh can abort it once it is stuck. */
export function trackedFetch(input: string, init?: RequestInit): Promise<Response> {
  const entry: InFlight = { ctl: new AbortController(), at: Date.now() };
  inflight.add(entry);
  return fetch(input, { ...init, signal: entry.ctl.signal }).finally(() => inflight.delete(entry));
}

/** Abort every tracked GET older than `ms`; returns how many. */
export function abortStuck(ms = STUCK_MS, now = Date.now()): number {
  let n = 0;
  for (const e of [...inflight]) {
    if (now - e.at >= ms) { e.ctl.abort(); inflight.delete(e); n++; }
  }
  return n;
}

const sources = new Set<() => unknown>();
/** Register something to re-run on a refresh; returns the unregister. Its promise counts toward "done". */
export function onRefresh(fn: () => unknown): () => void {
  sources.add(fn);
  return () => { sources.delete(fn); };
}

let refreshing = false;
const subs = new Set<() => void>();
const setRefreshing = (v: boolean) => { refreshing = v; subs.forEach((s) => s()); };
export const useRefreshing = (): boolean =>
  useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => refreshing);

let current: Promise<"done" | "reloaded"> | null = null;

/** Abort the stuck, re-run every source, resolve when all settle (or reload past the deadline). A
 *  click while one runs joins it. */
export function refreshEverything(opts: { stuckMs?: number; deadlineMs?: number; reload?: () => void } = {}): Promise<"done" | "reloaded"> {
  if (current) return current;
  const { stuckMs = STUCK_MS, deadlineMs = DEADLINE_MS, reload = () => window.location.reload() } = opts;
  setRefreshing(true);
  abortStuck(stuckMs);
  const all = Promise.allSettled([...sources].map((fn) => { try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); } }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"reloaded">((resolve) => { timer = setTimeout(() => { reload(); resolve("reloaded"); }, deadlineMs); });
  current = Promise.race([all.then(() => "done" as const), late]).finally(() => {
    clearTimeout(timer);
    current = null;
    setRefreshing(false);
  });
  return current;
}

/** Tests. */
export function _resetRefresh(): void { inflight.clear(); current = null; refreshing = false; }
