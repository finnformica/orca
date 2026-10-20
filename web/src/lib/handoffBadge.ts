// The Handoffs nav badge (server/db.ts `handoffBadge`): outgoing packs not sent yet, plus incoming
// packs the user has not seen. One shared poll of /api/handoffs/badge, like lib/inboxUnread.ts. The
// Handoffs page reads it again at once after it marks the incoming packs seen, sends or deletes.
import { useSyncExternalStore } from "react";
import { api } from "../api";
import { poll } from "./poll";

let count = 0;
let stop: (() => void) | undefined;
const subs = new Set<() => void>();
const fetchCount = () => api.handoffBadge().then((v) => { count = v.unsent + v.unseen; subs.forEach((s) => s()); });

/** Read the count again now (a pack was seen, sent, made or deleted). */
export const refreshHandoffBadge = (): void => { if (stop) void fetchCount().catch(() => {}); };

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (subs.size === 1) stop = poll(fetchCount, 30_000);
  return () => {
    subs.delete(cb);
    if (!subs.size) { stop?.(); stop = undefined; count = 0; }
  };
}

/** How many handoff packs need the user. */
export const useHandoffBadge = (): number => useSyncExternalStore(subscribe, () => count);
