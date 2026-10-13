// The tab's ONE live connection to the bridge, shared by every open chat (server/events.ts).
//
// A browser gets six HTTP/1.1 connections per host, shared by all its tabs, and an EventSource holds
// one for as long as it is open. One per chat (each card terminal, the orchestrator window, other
// tabs) used them all up, and every later fetch — the PR page's included — queued behind them
// indefinitely. So: one stream per tab, open only while some chat wants it AND the tab (or its
// always-on-top pop-out) is visible. A hidden tab gives its connection back; on return the stream
// reopens and every chat catches up from its cursor.
import type { AgentStep } from "../../../shared/agent";
import type { Notification } from "../../../shared/notifications";
import { api } from "../api";

export type TurnHandlers = {
  step: (runId: string, steps: AgentStep[]) => void;
  turn: (runId: string) => void;
  /** Reply text as it is generated (claude only) — live, never stored; the whole message follows as a
   *  `text` step, which replaces whatever streamed. Optional: a chat that ignores it still gets the
   *  message, a message later. */
  delta?: (runId: string, text: string) => void;
  /** The feed (re)started — the first open, a reconnect, the tab shown again, another instance came
   *  back: events may have been missed since the chat last read, so catch up. Called on EVERY
   *  `ready`, the first included: a chat that loaded before the stream was live (opened while the
   *  tab was hidden, or while it was still connecting) would otherwise never hear what landed in
   *  between. */
  resync: () => void;
};
type Sub = TurnHandlers & { key: string; notification?: (n: Notification) => void };

// The notification centre's subscription has no conversation; this key matches no repo::branch.
const NOTIFICATIONS_KEY = "\0notifications";

const subs = new Set<Sub>();
let source: EventSource | null = null;
let reopen: ReturnType<typeof setTimeout> | undefined;
/** How long a stream the browser gave up on waits before it is opened again. */
const REOPEN_MS = 1_000;

const pipOpen = () => Boolean((window as unknown as { documentPictureInPicture?: { window: Window | null } }).documentPictureInPicture?.window);
const wanted = () => subs.size > 0 && (document.visibilityState !== "hidden" || pipOpen());

/** Open or close the stream to match who wants it. Exported so a pop-out closing can re-check. */
export function syncEvents(): void {
  if (wanted() && !source) open();
  else if (!wanted() && source) { source.close(); source = null; }
}

function open(): void {
  clearTimeout(reopen);
  const s = new EventSource(api.eventsUrl());
  source = s;
  s.addEventListener("ready", () => { for (const sub of [...subs]) sub.resync(); });
  // A network drop is retried by the browser itself (and its `ready` catches up), but an HTTP error —
  // a 502 from a restarting bridge, a 500 — closes an EventSource FOR GOOD, and nothing reopened it:
  // the chat sat on whatever it last heard until the page was reloaded or you sent something.
  s.addEventListener("error", () => {
    if (s.readyState !== 2 /* CLOSED */ || source !== s) return;
    source = null;
    clearTimeout(reopen);
    reopen = setTimeout(syncEvents, REOPEN_MS);
  });
  const route = (e: Event, deliver: (sub: Sub, d: { runId: string; steps: AgentStep[] }) => void) => {
    const d = JSON.parse((e as MessageEvent).data) as { repo: string; branch: string; runId: string; steps: AgentStep[] };
    const key = `${d.repo}::${d.branch}`;
    for (const sub of [...subs]) if (sub.key === key) deliver(sub, d);
  };
  s.addEventListener("step", (e) => route(e, (sub, d) => sub.step(d.runId, d.steps)));
  s.addEventListener("turn", (e) => route(e, (sub, d) => sub.turn(d.runId)));
  s.addEventListener("delta", (e) => route(e, (sub, d) => sub.delta?.(d.runId, (d as unknown as { text: string }).text)));
  s.addEventListener("notification", (e) => {
    const n = JSON.parse((e as MessageEvent).data) as Notification;
    for (const sub of [...subs]) sub.notification?.(n);
  });
}

if (typeof document !== "undefined") document.addEventListener("visibilitychange", syncEvents);

/** The notification centre's live feed: every new notification, from either instance. Holding this
 *  keeps the tab's one stream open while the tab is visible (a hidden tab still gives it back, and
 *  `resync` on return says to catch up from the centre's cursor). */
export function subscribeNotifications(handlers: { notification: (n: Notification) => void; resync: () => void }): () => void {
  const sub: Sub = { key: NOTIFICATIONS_KEY, step: () => {}, turn: () => {}, resync: handlers.resync, notification: handlers.notification };
  subs.add(sub);
  syncEvents();
  return () => { subs.delete(sub); syncEvents(); };
}

/** Listen to one conversation's live events. A chat joining a stream that is already live hears no
 *  `ready` until the next gap (it just loaded); one joining a stream still opening catches up on it. */
export function subscribeTurns(repo: string, branch: string, handlers: TurnHandlers): () => void {
  const sub: Sub = { ...handlers, key: `${repo}::${branch}` };
  subs.add(sub);
  syncEvents();
  return () => { subs.delete(sub); syncEvents(); };
}
