// The one unread count, shared by the bell and the Inbox nav item (shared/inbox.ts `unreadTotal`):
// the bell's own rows, live from the notification store, plus the inbox rows the bell has no copy
// of, from one shared poll of /api/inbox/unread. The same poll names the notification kinds you
// muted in the inbox, which the bell leaves out of its count and its quick view.
import { useSyncExternalStore } from "react";
import { api } from "../api";
import { poll } from "./poll";
import { useNotifications } from "./notificationStore";
import { unreadTotal } from "../../../shared/inbox";

type Side = { others: number; mutedKinds: string[] };
const EMPTY: Side = { others: 0, mutedKinds: [] };
let side: Side = EMPTY;
let stop: (() => void) | undefined;
const subs = new Set<() => void>();
const fetchSide = () => api.inboxUnread().then((v) => { side = v; subs.forEach((s) => s()); });

/** Read the bridge's half again now (an inbox row was read, muted or unmuted). */
export const refreshInboxUnread = (): void => { if (stop) void fetchSide().catch(() => {}); };

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (subs.size === 1) stop = poll(fetchSide, 30_000);
  return () => {
    subs.delete(cb);
    if (!subs.size) { stop?.(); stop = undefined; side = EMPTY; }
  };
}

/** The bridge's half: other unread rows and the muted notification kinds. */
export const useInboxSide = (): Side => useSyncExternalStore(subscribe, () => side);

/** The one unread count. */
export function useInboxUnread(): number {
  const { list } = useNotifications();
  const { others, mutedKinds } = useInboxSide();
  return unreadTotal(list, others, mutedKinds);
}
