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
import { attachmentRefs, type AttachmentRef } from "../workstream";

/** `agent`: a named agent's message (a recipient chip); absent = the Chief of Staff's. */
export type OutgoingMessage = { id: number; text: string; attachments?: AttachmentRef[]; agent?: string };

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
 *  refuses it, so the caller can give the text back. `agent` names another named agent (a recipient
 *  chip); none, or `chief`, is the Chief of Staff. */
export function sendToOrchestrator(text: string, files: File[] = [], agent?: string): Promise<{ status: "running" | "queued" }> {
  const id = ++seq;
  const to = agent && agent !== "chief" ? agent : undefined;
  pending = [...pending, { id, text, ...(to ? { agent: to } : {}) }];
  changed();
  const sent = chain.then(async () => {
    const refs = files.length ? await api.uploadAttachments(files) : [];
    // The upload lands before the message does — show the real thumbnails/chips (served from
    // /api/attachments/<id>, like a sent message's) on the "sending…" bubble as soon as they're known,
    // rather than only once the bridge confirms the message as a running turn or a queued entry.
    if (refs.length) {
      pending = pending.map((m) => (m.id === id ? { ...m, attachments: attachmentRefs(refs.join("\n")) } : m));
      changed();
    }
    return api.orchestratorMessage(text, refs, to);
  });
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
let chiefOf: OutgoingMessage[] = [], chiefList: OutgoingMessage[] = [];
/** The Chief of Staff's share of `pending`, the same array while `pending` is unchanged. */
const chiefOnly = (all: OutgoingMessage[]) => {
  if (all !== chiefOf) { chiefOf = all; chiefList = all.some((m) => m.agent) ? all.filter((m) => !m.agent) : all; }
  return chiefList;
};
/** The Chief of Staff's messages still on their way; `on: false` reads none (a chat that isn't the
 *  orchestrator's). A message to another named agent is not drawn here. */
export function useOrchestratorOutbox(on: boolean): OutgoingMessage[] {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  return on ? chiefOnly(all) : none;
}

/** Send one message to each named agent in `agents` (recipient chips), and only to them. */
export function sendToAgents(agents: string[], text: string, files: File[] = []): Promise<unknown> {
  return Promise.all(agents.map((a) => sendToOrchestrator(text, files, a)));
}
