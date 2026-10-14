// Keep a child process running: restart it when it exits (with a short, growing backoff), and restart
// it at once when a watched file changes.
//
// The dev launcher used `bun --watch` for both jobs, and it only does one: when the bridge died with
// an uncaught error at startup (the database on the cloud box hung, `db.open()` threw), `bun --watch`
// stayed alive waiting for a file change and never re-ran it — no board, no agents, for the whole
// outage, even after a `git pull`. A plain `bun run` under this loop exits on the crash and comes
// back; the watch is ours (fs.watch, debounced), so an edit still restarts it.
import { watch, type FSWatcher } from "fs";

export type SuperviseOptions = {
  /** Environment for each start — a function, so every restart reads it afresh. */
  env?: () => Record<string, string | undefined>;
  cwd?: string;
  stdio?: "inherit" | "ignore";
  /** First restart delay; doubles per consecutive crash up to `maxBackoffMs`. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** A run that lasted this long was healthy: the next crash starts the backoff over. */
  healthyAfterMs?: number;
  log?: (line: string) => void;
  name?: string;
};

export type Supervisor = {
  /** How many times the child has been started. */
  readonly starts: number;
  /** Kill the child and start it again now (a file changed). */
  restart(): void;
  /** Kill the child and stop restarting it. Resolves once it has exited. */
  stop(): Promise<void>;
  /** The running child's exit, for a caller that waits on the whole loop. */
  readonly done: Promise<void>;
};

export function supervise(cmd: string[], opts: SuperviseOptions = {}): Supervisor {
  const { minBackoffMs = 1_000, maxBackoffMs = 15_000, healthyAfterMs = 60_000, log = console.error, name = cmd.join(" ") } = opts;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let starts = 0;
  let stopped = false;
  let restartNow = false;
  let wake: (() => void) | undefined;

  const done = (async () => {
    let backoff = minBackoffMs;
    while (!stopped) {
      const startedAt = Date.now();
      starts++;
      child = Bun.spawn(cmd, {
        cwd: opts.cwd, env: opts.env?.() as Record<string, string> | undefined,
        stdout: opts.stdio ?? "inherit", stderr: opts.stdio ?? "inherit",
      });
      const code = await child.exited;
      if (stopped) break;
      if (restartNow) { restartNow = false; backoff = minBackoffMs; continue; } // a file changed: no delay
      if (Date.now() - startedAt >= healthyAfterMs) backoff = minBackoffMs;
      log(`orca dev: ${name} exited (code ${code}) — restarting in ${(backoff / 1000).toFixed(1)}s`);
      await new Promise<void>((r) => { wake = r; setTimeout(r, backoff); });
      wake = undefined;
      backoff = Math.min(backoff * 2, maxBackoffMs);
    }
  })();

  return {
    get starts() { return starts; },
    done,
    restart() {
      if (stopped) return;
      restartNow = true;
      wake?.(); // waiting out a backoff: go now
      try { child?.kill("SIGTERM"); } catch { /* already gone */ }
    },
    async stop() {
      stopped = true;
      wake?.();
      try { child?.kill("SIGTERM"); } catch { /* already gone */ }
      await done;
    },
  };
}

/** Call `onChange` (debounced) when a source file under any of `paths` changes. Returns a closer. */
export function watchSources(paths: string[], onChange: (file: string) => void, debounceMs = 250): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers: FSWatcher[] = [];
  for (const p of paths) {
    try {
      watchers.push(watch(p, { recursive: true }, (_event, file) => {
        const f = String(file ?? "");
        if (/node_modules|(^|\/)dist\/|\.tmp$|~$/.test(f)) return;
        clearTimeout(timer);
        timer = setTimeout(() => onChange(f || p), debounceMs);
      }));
    } catch { /* a path that doesn't exist (no .env yet) is simply not watched */ }
  }
  return () => { clearTimeout(timer); for (const w of watchers) w.close(); };
}
