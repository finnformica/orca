// A poll that can't pile up. `setInterval(fetch…)` fires on the clock whether or not the last request
// came back, and a browser has only six connections per host (all tabs, plain HTTP/1.1). Once they
// were busy, every card's preview status, the orchestrator window, the previews menu… kept queueing
// more — hundreds of requests deep — and a page's own fetch (the PR page's) waited behind all of them.
// Here the next tick is scheduled only after this one SETTLES (at most one request in flight per
// poller), and a hidden page doesn't fetch at all (a phone in a pocket costs nothing); it just checks
// again next tick — and the moment it is shown again it fetches at once instead of waiting a tick.
import { onRefresh } from "./refresh";

/** Run `fn` now, then `ms` after each run settles, until the returned stop is called. `host` is the
 *  window whose timers and visibility count — the orchestrator's pop-out passes its own. Every poll
 *  is a source of "Refresh everything" (lib/refresh.ts): a refresh runs it at once — right after the
 *  run in flight, if any (whose stuck request the refresh has just aborted) — and waits for that. */
export function poll(fn: () => unknown, ms: number, host: Window = window): () => void {
  let stopped = false, running = false, again = false;
  let timer: ReturnType<Window["setTimeout"]> | undefined;
  let waiters: (() => void)[] = [];
  const release = () => { const w = waiters; waiters = []; w.forEach((r) => r()); };
  const run = async () => {
    if (stopped) return;
    if (running) { again = true; return; }
    host.clearTimeout(timer);
    running = true;
    if (host.document.visibilityState !== "hidden") {
      try { await fn(); } catch { /* the caller reports its own errors; a poll just tries again */ }
    }
    running = false;
    if (again) { again = false; void run(); return; }
    release();
    if (!stopped) timer = host.setTimeout(run, ms);
  };
  const onShow = () => { if (host.document.visibilityState === "visible") void run(); };
  host.document.addEventListener("visibilitychange", onShow);
  const unregister = onRefresh(() => new Promise<void>((resolve) => {
    if (stopped) return resolve();
    waiters.push(resolve);
    if (running) again = true; else void run();
  }));
  void run();
  return () => { stopped = true; host.clearTimeout(timer); host.document.removeEventListener("visibilitychange", onShow); unregister(); release(); };
}
