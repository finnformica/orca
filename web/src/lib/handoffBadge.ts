// The Handoffs nav badge (server/db.ts `handoffBadge`): outgoing packs made here and waiting for the
// user's own approval to send. A received pack needs no approval, so it is not counted (Finn: the
// badge counts only what waits on him). One shared poll of /api/handoffs/badge, like
// lib/inboxUnread.ts. The Handoffs page reads it again at once after it sends or deletes a pack.
import { useSyncExternalStore } from "react";
import { api } from "../api";
import { poll } from "./poll";

let count = 0;
let stop: (() => void) | undefined;
const subs = new Set<() => void>();
const fetchCount = () => api.handoffBadge().then((v) => { count = v.unsent; subs.forEach((s) => s()); });

/** Read the count again now (a pack was sent, made or deleted). */
export const refreshHandoffBadge = (): void => { if (stop) void fetchCount().catch(() => {}); };

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (subs.size === 1) stop = poll(fetchCount, 30_000);
  return () => {
    subs.delete(cb);
    if (!subs.size) { stop?.(); stop = undefined; count = 0; }
  };
}

/** How many outgoing handoff packs wait for the user to send them. */
export const useHandoffBadge = (): number => useSyncExternalStore(subscribe, () => count);
