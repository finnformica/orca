// One shared clock for every live elapsed time on screen (the Agents list's running rows). A row
// subscribes only while its agent runs; the first subscriber starts ONE interval, the last one out
// stops it, so ten running rows cost one timer and an idle list costs none. Each tick re-renders
// only the subscribed cells (useSyncExternalStore), never the list. A clock, not a poll: nothing is
// fetched (polls go through lib/poll.ts).
import { useSyncExternalStore } from "react";

type Clock = { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (id: unknown) => void; now: () => number };
const realClock: Clock = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

export function createTicker(periodMs = 1000, clock: Clock = realClock) {
  const listeners = new Set<() => void>();
  let timer: unknown = null;
  let now = clock.now();
  const tick = () => { now = clock.now(); for (const l of listeners) l(); };
  return {
    subscribe(l: () => void): () => void {
      listeners.add(l);
      if (timer === null) { now = clock.now(); timer = clock.setInterval(tick, periodMs); }
      return () => {
        listeners.delete(l);
        if (listeners.size === 0 && timer !== null) { clock.clearInterval(timer); timer = null; }
      };
    },
    // Idle (no timer yet), the stored time may be hours old: read the clock, floored to the period so
    // React sees the same value for back-to-back reads within a tick.
    getSnapshot: (): number => (timer === null ? Math.floor(clock.now() / periodMs) * periodMs : now),
    /** Live subscribers and whether the one timer is running — for tests. */
    stats: () => ({ listeners: listeners.size, running: timer !== null }),
  };
}

export const ticker = createTicker();
const noop = () => () => {};

/** The shared clock's current time while `active`, else undefined (and no subscription). */
export function useNow(active: boolean): number | undefined {
  const now = useSyncExternalStore(active ? ticker.subscribe : noop, ticker.getSnapshot);
  return active ? now : undefined;
}
