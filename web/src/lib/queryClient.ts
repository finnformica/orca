// The browser's ONE read cache: TanStack Query. Every view that loads data from the bridge keeps its
// last answer here, under a stable query key, instead of in its own component state.
//
// Why: a view's `useState(null)` + fetch-on-mount threw the data away on every page change, so on a
// phone (the installed app, no back swipe) going back to a chat, the Inbox or the PR page showed
// "Loading…" for one round trip over the tailnet each time. Now a view paints the last answer at once
// and fetches again in the background: `staleTime` 0 (always revalidate on mount, as before), `gcTime`
// a day (the data outlives the page). Live updates still win: the chat writes its SSE steps and
// `turn`-event pages into its query with `setQueryData`, and "Refresh everything" (lib/refresh.ts)
// refetches every active query.
//
// The client is one module singleton, not one made inside a component: the chat's SSE handlers, the
// orchestrator's window-hosted polls (lib/poll.ts, which follow a pop-out's visibility) and the test
// reset reach it outside React, and hooks pass it explicitly, so a component works with or without the
// QueryClientProvider that main.tsx puts around the app.
//
// The board store (store.ts) is NOT here and is not persisted: its enrichment drives Follow, which
// launches agents, and a stale `followSig` read from disk could fire a run twice.
import { useEffect, useRef } from "react";
import { notifyManager, QueryClient, type Query } from "@tanstack/react-query";
import { persistQueryClient, type PersistedClient, type Persister } from "@tanstack/react-query-persist-client";
import { createStore, del, get, set } from "idb-keyval";
import { onRefresh } from "./refresh";
import { apiBase } from "./server";

// An answer reaches the views in the same task it resolves in (a microtask), not one timer later
// (TanStack's default `setTimeout(0)`): a view updates as soon as its fetch is in. React still batches.
notifyManager.setScheduler(queueMicrotask);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0, // show the cache at once, and always refetch on mount (chats must be live)
      gcTime: 24 * 60 * 60_000, // keep the data across page changes; at least the persister's maxAge
      retry: false, // the views show a failure with their own Retry; a poll tries again on its tick
      refetchOnWindowFocus: false, // the polls already catch up when the tab is shown (lib/poll.ts)
      networkMode: "always", // navigator.onLine says nothing about the tailnet: always ask the bridge
    },
  },
});

// "Refresh everything" refetches what is on screen, like every poll.
onRefresh(() => queryClient.refetchQueries({ type: "active" }));

// ---- persistence (IndexedDB) ----
// Only display data with no automation behind it goes to disk: a chat's newest pages and the Inbox.
// The installed app then opens on them after iOS ends it in the background.

/** Bump when a persisted value's shape changes: old records are then ignored. */
export const CACHE_SCHEMA = "2";
/** Queries written to disk: the most recently updated ones. */
export const PERSIST_MAX = 24;
/** A persisted record older than this is not restored. */
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60_000;
const SAVE_DELAY_MS = 1_000;

/** The first part of every query key that may be persisted. */
export const PERSISTED_KEYS = new Set(["chat", "inbox"]);
export const shouldPersist = (q: Query): boolean =>
  q.state.status === "success" && q.state.data !== undefined && PERSISTED_KEYS.has(String(q.queryKey[0]));

/** Each persisted query's data, smaller (`shrink`), or dropped (undefined). The chat registers its own. */
const shrinkers = new Map<string, (data: never) => unknown>();
export function persistShrink<T>(keyHead: string, fn: (data: T) => unknown): void { shrinkers.set(keyHead, fn as (d: never) => unknown); }

/** What is written: the newest PERSIST_MAX queries, each through its shrink. Pure. */
export function capPersisted(client: PersistedClient): PersistedClient {
  const queries = client.clientState.queries
    .flatMap((q) => {
      const shrink = shrinkers.get(String(q.queryKey[0]));
      const data = shrink ? shrink(q.state.data as never) : q.state.data;
      return data === undefined ? [] : [{ ...q, state: { ...q.state, data } }];
    })
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(0, PERSIST_MAX);
  return { ...client, clientState: { ...client.clientState, queries, mutations: [] } };
}

/** Where the record goes: idb-keyval in a browser; a test passes a Map. */
export type KeyValue = { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void>; del: (k: string) => Promise<void> };
function idbKeyValue(): KeyValue | null {
  if (typeof indexedDB === "undefined") return null;
  const store = createStore("orca-query-cache", "kv");
  return { get: (k) => get(k, store), set: (k, v) => set(k, v, store), del: (k) => del(k, store) };
}

/** One record per server this browser talks to, written at most once per SAVE_DELAY_MS (a chat
 *  streaming steps changes its query many times a second) and at once when the page is hidden: iOS
 *  ends a backgrounded app without warning. A failure (private mode, quota) is ignored. */
export function createPersister(kv: KeyValue, record: () => string = () => `client:${apiBase() || location.origin}`): Persister & { flush: () => Promise<void> } {
  let pending: PersistedClient | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    clearTimeout(timer);
    timer = undefined;
    const c = pending;
    pending = null;
    if (c) await kv.set(record(), capPersisted(c)).catch(() => {});
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void flush(); });
  return {
    persistClient: (c) => { pending = c; timer ??= setTimeout(() => void flush(), SAVE_DELAY_MS); },
    restoreClient: () => kv.get(record()).then((v) => v as PersistedClient | undefined, () => undefined),
    removeClient: () => kv.del(record()).catch(() => {}),
    flush,
  };
}

/** Restore the persisted chats and Inbox, then keep saving them. Resolves when the restore is done,
 *  or after `waitMs`, so a slow disk never holds the first paint. */
export function startPersistence(waitMs = 300, kv: KeyValue | null = idbKeyValue()): Promise<void> {
  if (!kv) return Promise.resolve();
  const [, restored] = persistQueryClient({
    queryClient, persister: createPersister(kv), maxAge: PERSIST_MAX_AGE_MS, buster: CACHE_SCHEMA,
    dehydrateOptions: { shouldDehydrateQuery: shouldPersist },
  });
  return Promise.race([restored.catch(() => {}), new Promise<void>((r) => setTimeout(r, waitMs))]);
}

/** Refetch a query when `value` changes after mount (an input the answer depends on that is not in the
 *  key, such as an agent's run status for a diffstat). The first render does nothing: `staleTime`
 *  decides the mount fetch. */
export function useRefetchOnChange(refetch: () => unknown, value: unknown, enabled = true): void {
  const last = useRef(value);
  useEffect(() => {
    if (Object.is(last.current, value)) return;
    last.current = value;
    if (enabled) void refetch();
  }, [value, enabled, refetch]);
}
