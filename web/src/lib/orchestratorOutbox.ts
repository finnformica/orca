// Messages on their way to the orchestrator, from ANY of its entry points — the quick-ask box, the
// panel's own composer (a toast's Ask and the palette prefill that one), the phone's page, the
// New-draft box. The panel's chat draws them at once as "sending…" and drops each one only after it
// has re-read the conversation and the queue, so the message never disappears between the two.
//
// Why it is shared: the panel's "sending…" receipt used to be the panel's own state, so a quick-ask
// (a separate component) left it nothing to draw while the bridge built the wake — seconds — and a
// message QUEUED behind a busy wake publishes no event, so a panel already mounted (it stays mounted
// while closed) showed it only when the wake finished and its `turn` event made it re-read.
import { useSyncExternalStore } from "react";
import { api } from "../api";

export type OutgoingMessage = { id: number; text: string };

let pending: OutgoingMessage[] = [];
let seq = 0;
const listeners = new Set<() => void>();
/** What a mounted orchestrator chat does when a message has reached the bridge: re-read its newest
 *  page and the queue, so the real copy is in hand before the optimistic one goes. */
const deliveredHooks = new Set<() => Promise<void>>();
const changed = () => { for (const l of listeners) l(); };

// One chain for the whole tab: each POST starts only once the previous one has answered, so quick
// sends arrive as typed (in parallel, the second could reach the bridge first). A failure does not
// break the chain for the messages behind it.
let chain: Promise<unknown> = Promise.resolve();

/** Send `text` (and any files) to the orchestrator: drawn in its chat at once, delivered in order,
 *  reconciled with the recorded turn / queued entry. Rejects (the entry withdrawn) if the bridge
 *  refuses it, so the caller can give the text back. */
export function sendToOrchestrator(text: string, files: File[] = []): Promise<{ status: "running" | "queued" }> {
  const id = ++seq;
  pending = [...pending, { id, text }];
  changed();
  const sent = chain.then(async () => api.orchestratorMessage(text, files.length ? await api.uploadAttachments(files) : []));
  chain = sent.catch(() => {});
  const settle = () => { pending = pending.filter((m) => m.id !== id); changed(); };
  return sent.then(
    async (r) => {
      await Promise.all([...deliveredHooks].map((h) => h().catch(() => {})));
      settle();
      return r;
    },
    (e) => { settle(); throw e; },
  );
}

/** Register a mounted chat's reload (see `deliveredHooks`); returns the unregister. */
export function onOrchestratorDelivered(hook: () => Promise<void>): () => void {
  deliveredHooks.add(hook);
  return () => { deliveredHooks.delete(hook); };
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => pending;
const none: OutgoingMessage[] = [];
/** The messages still on their way; `on: false` reads none (a chat that isn't the orchestrator's). */
export function useOrchestratorOutbox(on: boolean): OutgoingMessage[] {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  return on ? all : none;
}
