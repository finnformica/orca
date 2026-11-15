// The typing indicator while an agent works on an inbound message (an adapter's optional
// `typing`; only Discord has one). Discord shows "Orca is typing…" for about 10 s after each call,
// so one loop per place calls it again every `everyMs` until one of these ends it:
// - the agent posts to that place (the dispatcher calls `stopPlace` after a successful send);
// - the run ends: done, failed or stopped (`check()` from the run-finished hook and the Stop route,
//   and `alive()` on each tick as a backstop);
// - `maxMs` has passed (a run that hangs).
// A typing call that fails is logged once per loop and never fails the run or the reply.
// In memory, per process: the dispatcher runs on the primary bridge only, so one process owns it.
import { replyToOf, type Envelope } from "../../shared/integrations";
import type { Adapter } from "./adapter";

export const TYPING = { everyMs: 8_000, maxMs: 10 * 60_000 };

/** The timers the loop uses. A test swaps in a fake clock. */
export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
};
const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};
let clock: Clock = realClock;
/** Swap the clock (tests). No argument: the real one. */
export const useClock = (c?: Clock): void => { clock = c ?? realClock; };

export type TypingResult = { ok: boolean; error?: string };
export type TypingStart = {
  integrationId: string;
  /** The place the reply goes to (the delivery target's `externalId`): a post there ends the loop. */
  place: string;
  /** The adapter's typing call for this place. */
  send(): Promise<TypingResult>;
  /** False once the agent's run has ended (done, failed or stopped). */
  alive(): boolean | Promise<boolean>;
};

type Loop = TypingStart & { key: string; deadline: number; timer?: unknown; logged: boolean; ended: boolean };
const loops = new Map<string, Loop>();

const keyOf = (integrationId: string, place: string): string => `${integrationId}|${place}`;
const log = (msg: string): void => console.log(`orca: typing: ${msg}`);

/** Start the loop for a place: one typing call now, then one every `everyMs`. A loop already there
 *  is replaced, so a second message to the same place gets a fresh `maxMs`. */
export function start(s: TypingStart): void {
  const key = keyOf(s.integrationId, s.place);
  end(loops.get(key));
  const loop: Loop = { ...s, key, deadline: clock.now() + TYPING.maxMs, logged: false, ended: false };
  loops.set(key, loop);
  void tick(loop, true);
}

async function tick(loop: Loop, first = false): Promise<void> {
  if (loop.ended) return;
  if (clock.now() >= loop.deadline) { log(`${loop.key}: stopped after ${Math.round(TYPING.maxMs / 60_000)} min`); end(loop); return; }
  // The first call has no check: the agent's launch can still be on its way.
  if (!first) {
    let alive = true;
    try { alive = await loop.alive(); } catch { /* a failed check keeps the loop; maxMs ends it */ }
    if (!alive) { end(loop); return; }
    if (loop.ended) return;
  }
  try {
    const r = await loop.send();
    if (!r.ok) warn(loop, r.error ?? "failed");
  } catch (e) {
    warn(loop, e instanceof Error ? e.message : String(e));
  }
  if (!loop.ended) loop.timer = clock.setTimeout(() => void tick(loop), TYPING.everyMs);
}

function warn(loop: Loop, error: string): void {
  if (loop.logged) return;
  loop.logged = true;
  log(`${loop.key}: typing call failed (${error}); the run continues`);
}

function end(loop: Loop | undefined): void {
  if (!loop || loop.ended) return;
  loop.ended = true;
  if (loop.timer !== undefined) clock.clearTimeout(loop.timer);
  if (loops.get(loop.key) === loop) loops.delete(loop.key);
}

/** Start the loop for an inbound message handed to an agent, when the message's adapter has
 *  `typing`. Only for a message an agent may answer: an outside sender, not read-only (`notify`).
 *  The place is where `orca post --reply` goes (`replyToOf`). True when a loop started. */
export function startFor(e: Envelope, adapter: Pick<Adapter, "typing"> | undefined, alive: () => boolean | Promise<boolean>): boolean {
  const typing = adapter?.typing;
  if (!typing || !e.grant || e.grant.level === "notify" || !e.source.integrationId) return false;
  const reply = replyToOf(e);
  if (!reply?.channel) return false;
  const target = { linkId: reply.linkId, externalId: reply.channel, ...(reply.threadId ? { threadId: reply.threadId } : {}) };
  start({ integrationId: e.source.integrationId, place: reply.channel, send: () => typing.call(adapter, target), alive });
  return true;
}

/** The agent posted to this place: stop at once. */
export function stopPlace(integrationId: string, place: string): void {
  end(loops.get(keyOf(integrationId, place)));
}

/** A run ended or was stopped: end every loop whose agent is no longer running. */
export async function check(): Promise<void> {
  for (const loop of [...loops.values()]) {
    let alive = true;
    try { alive = await loop.alive(); } catch { /* keep it; maxMs ends it */ }
    if (!alive) end(loop);
  }
}

/** The places with a loop now (diagnostics, tests). */
export const active = (): string[] => [...loops.keys()];

/** End every loop (shutdown, tests). */
export function stopAll(): void {
  for (const loop of [...loops.values()]) end(loop);
}
