// The tab's ONE live connection to the bridge, shared by every open chat (server/events.ts).
//
// A browser gets six HTTP/1.1 connections per host, shared by all its tabs, and an EventSource holds
// one for as long as it is open. One per chat (each card terminal, the orchestrator window, other
// tabs) used them all up, and every later fetch — the PR page's included — queued behind them
// indefinitely. So: one stream per tab, open only while some chat wants it AND the tab (or its
// always-on-top pop-out) is visible. A hidden tab gives its connection back; on return the stream
// reopens and every chat catches up from its cursor.
import type { AgentStep } from "../../../shared/agent";
import { api } from "../api";

export type TurnHandlers = {
  step: (runId: string, steps: AgentStep[]) => void;
  turn: (runId: string) => void;
  /** The feed was interrupted (reconnect, tab shown again, another instance came back): events may
   *  have been missed, so catch up. Never called for the stream a chat first opened on. */
  resync: () => void;
};
type Sub = TurnHandlers & { key: string; fresh: boolean };

const subs = new Set<Sub>();
let source: EventSource | null = null;
let live = false; // the current source has said `ready`

const pipOpen = () => Boolean((window as unknown as { documentPictureInPicture?: { window: Window | null } }).documentPictureInPicture?.window);
const wanted = () => subs.size > 0 && (document.visibilityState !== "hidden" || pipOpen());

/** Open or close the stream to match who wants it. Exported so a pop-out closing can re-check. */
export function syncEvents(): void {
  if (wanted() && !source) open();
  else if (!wanted() && source) { source.close(); source = null; live = false; }
}

function open(): void {
  const s = new EventSource(api.eventsUrl());
  source = s;
  live = false;
  s.addEventListener("ready", () => {
    live = true;
    for (const sub of [...subs]) { if (sub.fresh) sub.fresh = false; else sub.resync(); }
  });
  const route = (e: Event, deliver: (sub: Sub, d: { runId: string; steps: AgentStep[] }) => void) => {
    const d = JSON.parse((e as MessageEvent).data) as { repo: string; branch: string; runId: string; steps: AgentStep[] };
    const key = `${d.repo}::${d.branch}`;
    for (const sub of [...subs]) if (sub.key === key) deliver(sub, d);
  };
  s.addEventListener("step", (e) => route(e, (sub, d) => sub.step(d.runId, d.steps)));
  s.addEventListener("turn", (e) => route(e, (sub, d) => sub.turn(d.runId)));
}

if (typeof document !== "undefined") document.addEventListener("visibilitychange", syncEvents);

/** Listen to one conversation's live events. A chat joining a stream that is already live has
 *  nothing to catch up on (it just loaded); one joining a stream still opening skips that `ready`. */
export function subscribeTurns(repo: string, branch: string, handlers: TurnHandlers): () => void {
  const sub: Sub = { ...handlers, key: `${repo}::${branch}`, fresh: !live };
  subs.add(sub);
  syncEvents();
  return () => { subs.delete(sub); syncEvents(); };
}
