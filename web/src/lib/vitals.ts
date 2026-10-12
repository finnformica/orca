// The header's usage meter + health chip and the overview's stat tiles read the SAME numbers. Each
// resource is polled once however many components show it (the bridge is HTTP/1.1 with six
// connections per host — see lib/poll.ts), and only while something is mounted to show it.
import { useSyncExternalStore } from "react";
import { api, type InstanceHealth, type MetricPoint } from "@/api";
import type { ProfileUsage, Usage, UsageWindow } from "../../../server/usage";
import { poll } from "./poll";

/** One value fed by a loop that runs while anyone subscribes. The value is dropped when the last
 *  subscriber leaves, so a later mount starts from a fresh read rather than a stale one. */
function sharedSource<T>(start: (set: (v: T) => void) => () => void) {
  let value: T | null = null;
  let stop: (() => void) | null = null;
  const subs = new Set<() => void>();
  return {
    subscribe(cb: () => void) {
      subs.add(cb);
      if (subs.size === 1) stop = start((v) => { value = v; subs.forEach((s) => s()); });
      return () => {
        subs.delete(cb);
        if (!subs.size) { stop?.(); stop = null; value = null; }
      };
    },
    get: () => value,
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
    schedule(complete || ++fastTries > MAX_FAST ? SLOW : FAST);
  }).catch(() => schedule(FAST));
  load();
  return () => { cancelled = true; clearTimeout(timer); };
});

/** Provider usage (/api/usage), null until the first answer (or when no provider is signed in). */
export const useUsage = (): Usage | null => useSyncExternalStore(usageSource.subscribe, usageSource.get);

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

// Logins hydra can't route to right now: no reading, or deliberately out of the rotation. Exhausted
// and locked logins DO count — they hold a real reading and are exactly what pulls the fleet up.
export const outOfRotation = (p: ProfileUsage): boolean => !p.usage || p.state === "disabled" || p.state === "not signed in on this machine";

export type FleetUsage = { count: number; exhausted: number; fiveHour: UsageWindow; sevenDay: UsageWindow; fable: UsageWindow | null };

/** One reading for the whole fleet: the mean utilization per window across the logins in rotation,
 *  with the soonest reset — so the header answers "how used are my Claude accounts overall" in one
 *  row, and the per-login truth lives in the breakdown. Null when nothing is in rotation. Pure. */
export function aggregateProfiles(profiles: ProfileUsage[]): FleetUsage | null {
  const live = profiles.filter((p) => !outOfRotation(p));
  if (!live.length) return null;
  const mean = (ws: UsageWindow[]): UsageWindow => ({
    utilization: Math.round(ws.reduce((s, w) => s + w.utilization, 0) / ws.length),
    resetsAt: ws.map((w) => w.resetsAt).filter((r): r is string => Boolean(r)).sort()[0] ?? null,
  });
  const fables = live.map((p) => p.usage!.fable).filter((w): w is UsageWindow => Boolean(w));
  return {
    count: live.length,
    exhausted: live.filter((p) => p.state === "exhausted" || p.state === "locked").length,
    fiveHour: mean(live.map((p) => p.usage!.fiveHour)),
    sevenDay: mean(live.map((p) => p.usage!.sevenDay)),
    fable: fables.length ? mean(fables) : null,
  };
}
