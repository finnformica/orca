// The header's usage meter + health chip and the overview's stat tiles read the SAME numbers. Each
// resource is polled once however many components show it (the bridge is HTTP/1.1 with six
// connections per host — see lib/poll.ts), and only while something is mounted to show it.
import { useSyncExternalStore } from "react";
import { api, type InstanceHealth, type MetricPoint } from "@/api";
import type { Usage } from "../../../server/usage";
import { poll } from "./poll";

/** One value fed by a loop that runs while anyone subscribes. The value is dropped when the last
 *  subscriber leaves, so a later mount starts from a fresh read rather than a stale one. */
export function sharedSource<T>(start: (set: (v: T) => void) => () => void) {
  let value: T | null = null;
  let stop: (() => void) | null = null;
  const subs = new Set<() => void>();
  const set = (v: T) => { value = v; subs.forEach((s) => s()); };
  return {
    subscribe(cb: () => void) {
      subs.add(cb);
      if (subs.size === 1) stop = start(set);
      return () => {
        subs.delete(cb);
        if (!subs.size) { stop?.(); stop = null; value = null; }
      };
    },
    get: () => value,
    // Push a value in from OUTSIDE the poll loop (a mutation's own response) — e.g. the usage
    // card's enable/disable switch, so the row updates at once rather than waiting for the next tick.
    push: set,
  };
}

/** Merge a fresh usage poll over the last-known one, PER PROVIDER: a provider that came back null
 *  this poll (a transient failure, or not fetched yet) keeps its previous value instead of blanking
 *  the bar. Pure, so the belt is testable without a timer. */
export function mergeUsage(prev: Usage | null, next: Usage): Usage {
  return { claude: next.claude ?? prev?.claude ?? null, codex: next.codex ?? prev?.codex ?? null, profiles: next.profiles ?? prev?.profiles, routing: next.routing ?? prev?.routing };
}

// Poll cadence self-adjusts: fast until both providers are in, then every five minutes. Merge PER
// PROVIDER: a single provider's transient null — Claude's endpoint rate-limiting, the Codex
// app-server handshake timing out, or a just-restarted bridge with a cold cache — must not drop the
// OTHER provider that's already showing. Until both are present, retry soon (bounded) so a cold
// start fills the bar in seconds; once complete, settle into the slow cadence.
//
// `usageLoaded` is a SEPARATE signal from the value itself: a genuine "no provider signed in"
// answer is also `null` on the wire, so the card can't tell "not answered yet" from "answered with
// nothing" by reading `useUsage()` alone — it needs to know whether the first poll has landed at
// all, for the loading skeleton. It resets with the same lifecycle as the value (the last
// subscriber leaving), so a later mount starts from "not yet loaded" rather than a stale true.
let usageLoaded = false;
const usageLoadedSubs = new Set<() => void>();
const notifyUsageLoaded = () => usageLoadedSubs.forEach((s) => s());

const usageSource = sharedSource<Usage>((set) => {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout>;
  let fastTries = 0;
  let latest: Usage | null = null;
  const SLOW = 5 * 60_000, FAST = 15_000, MAX_FAST = 4;
  const schedule = (ms: number) => { if (!cancelled) timer = setTimeout(load, ms); };
  const load = () => void api.usage().then((u) => {
    if (cancelled) return;
    let complete = false;
    if (u) {
      latest = mergeUsage(latest, u);
      set(latest);
      complete = Boolean(latest.claude && latest.codex);
    }
    if (!usageLoaded) { usageLoaded = true; notifyUsageLoaded(); }
    schedule(complete || ++fastTries > MAX_FAST ? SLOW : FAST);
  }).catch(() => { if (!usageLoaded) { usageLoaded = true; notifyUsageLoaded(); } schedule(FAST); });
  load();
  return () => { cancelled = true; clearTimeout(timer); usageLoaded = false; notifyUsageLoaded(); };
});

/** Provider usage (/api/usage), null until the first answer (or when no provider is signed in). */
export const useUsage = (): Usage | null => useSyncExternalStore(usageSource.subscribe, usageSource.get);

/** Whether the first usage poll has answered yet — the Usage card's loading skeleton reads this
 *  instead of `useUsage() === null`, which is ALSO what "no provider signed in" looks like. */
export const useUsageLoaded = (): boolean =>
  useSyncExternalStore((cb) => { usageLoadedSubs.add(cb); return () => usageLoadedSubs.delete(cb); }, () => usageLoaded);

/** Apply the profile list POST /api/usage/profile hands back, so the row the switch is on shows
 *  the new state at once rather than waiting for the next (up to 5-minute) poll tick. */
export function applyProfiles(profiles: NonNullable<Usage["profiles"]>): void {
  const current = usageSource.get();
  if (current) usageSource.push({ ...current, profiles });
}

export type HealthReading = { health: InstanceHealth | null; down: boolean };
const healthSources = new Map<string, ReturnType<typeof sharedSource<HealthReading>>>();

const NOTHING = { subscribe: () => () => {}, get: () => null };

/** An instance's vitals (/api/health), polled every 15s. `instance` undefined = the answering one;
 *  null = nothing to watch (no poll at all). */
export function useHealth(instance: string | undefined | null): HealthReading | null {
  if (instance === null) return useSyncExternalStore(NOTHING.subscribe, NOTHING.get);
  const key = instance ?? "";
  let src = healthSources.get(key);
  if (!src) {
    src = sharedSource<HealthReading>((set) => {
      let live = true;
      let last: InstanceHealth | null = null;
      const stop = poll(() => api.health(instance).then(
        (h) => { if (live) { last = h; set({ health: h, down: false }); } },
        () => { if (live) set({ health: last, down: true }); },
      ), 15_000);
      return () => { live = false; stop(); };
    });
    healthSources.set(key, src);
  }
  return useSyncExternalStore(src.subscribe, src.get);
}

const historySources = new Map<string, ReturnType<typeof sharedSource<MetricPoint[]>>>();

/** An instance's last-day samples (/api/health/history — database-only, so any instance answers),
 *  polled once a minute (the sampler writes once a minute) while something shows them: the header
 *  chip's popover, the overview's instance tiles. One loop per instance however many show it. null
 *  = nothing to watch; the value is null until the first answer, [] when the fetch fails. */
export function useHealthHistory(instance: string | null, hours = 24): MetricPoint[] | null {
  if (instance === null) return useSyncExternalStore(NOTHING.subscribe, NOTHING.get);
  const key = `${instance}|${hours}`;
  let src = historySources.get(key);
  if (!src) {
    src = sharedSource<MetricPoint[]>((set) => {
      let live = true;
      const stop = poll(() => api.healthHistory(instance, hours).then((v) => { if (live) set(v); }, () => { if (live) set([]); }), 60_000);
      return () => { live = false; stop(); };
    });
    historySources.set(key, src);
  }
  return useSyncExternalStore(src.subscribe, src.get);
}

// The fleet mean lives with the other pure usage derivations (workstream.ts), so the Usage card and
// this module can't compute it two ways.
export { aggregateProfiles, outOfRotation, type FleetUsage } from "../workstream";
