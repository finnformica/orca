// The leak detector for the heavy queue (server/heavy.ts). The queue is the box's only CPU control,
// so a heavy command that skips it is invisible: 2026-10-20, three agents ran whole test suites and
// builds at once on a 4 vCPU box (CPU 98 %, one OOM kill) while the machine card showed the queue
// almost empty. Every 15 s this pass reads each process in the agents' slice and records the heavy
// ones (a test runner, tsc, a build) that run with no ORCA_RUN_SLOT in their environment. It kills
// nothing: the count and the names go to the machine card and `orca machine` as "unqueued heavy".
//
// A process in a slot's own scope (`orca-heavy-…`) is queued by definition. ORCA_RUN_SLOT=none is
// orca-run's fallback with no bridge, so it counts as a leak too. Only the top heavy process of a
// tree counts: a vitest and its fork workers are one leak.
import { readFileSync } from "fs";
import { basename } from "path";
import { isTestRunner, readProcs, type ProcInfo } from "./browserWatch";
import { AGENTS_SLICE, runScopeOf } from "./cgroup";

export const LEAK_INTERVAL_MS = 15_000;

/** Interpreters whose first script argument is the tool. */
const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno"]);
/** Tools that are heavy whatever their subcommand. */
const HEAVY_TOOLS = new Set(["vitest", "jest", "tsc", "tsgo", "turbo", "eslint", "webpack"]);
/** Tools that are heavy only with this subcommand. */
const HEAVY_SUB: Record<string, string> = { vite: "build", next: "build" };
const SLOT_SCOPE = /\/orca-heavy-[^/]*\.scope(\/|$)/;

/** The name to report when this command line is a heavy command, else undefined. Pure. */
export function heavyName(argv: string[]): string | undefined {
  if (!argv.length) return undefined;
  if (isTestRunner(argv)) return "playwright test";
  let i = 0;
  const bin = basename(argv[0]!);
  if (INTERPRETERS.has(bin)) {
    if (bin === "bun" && argv[1] === "test") return "bun test";
    // Skip the interpreter's own flags (`node --max-old-space-size=4096 …/tsc`).
    i = 1;
    while (i < argv.length && argv[i]!.startsWith("-")) i++;
    if (i >= argv.length) return undefined;
  }
  const tool = basename(argv[i]!).replace(/\.(m|c)?(js|ts)$/, "");
  if (HEAVY_TOOLS.has(tool)) return tool;
  const sub = HEAVY_SUB[tool];
  if (sub && argv.slice(i + 1).find((a) => !a.startsWith("-")) === sub) return `${tool} ${sub}`;
  return undefined;
}

/** Whether an environment (NUL-separated, as `/proc/<pid>/environ`) carries a real slot. Pure. */
export function hasSlot(environ: string): boolean {
  for (const kv of environ.split("\0")) {
    if (!kv.startsWith("ORCA_RUN_SLOT=")) continue;
    const v = kv.slice("ORCA_RUN_SLOT=".length);
    return v !== "" && v !== "none";
  }
  return false;
}

export type Leak = { pid: number; name: string; runId?: string };
export type LeakReport = { at: number; count: number; names: string[]; leaks: Leak[] };


/** The unqueued heavy processes among `procs`: in the agents' slice, outside a slot's scope, heavy,
 *  with no slot in their environment, and with no such process above them. `environ` returns null
 *  when a process can't be read (gone, or not ours): it is skipped. Pure but for `environ`. */
export function findLeaks(procs: ProcInfo[], environ: (pid: number) => string | null, self = process.pid): Leak[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const verdict = new Map<number, string | undefined>();
  const leakName = (p: ProcInfo): string | undefined => {
    if (verdict.has(p.pid)) return verdict.get(p.pid);
    let name: string | undefined;
    if (p.pid !== self && p.cgroup.includes(`/${AGENTS_SLICE}/`) && !SLOT_SCOPE.test(p.cgroup)) {
      name = heavyName(p.argv);
      if (name) {
        const env = environ(p.pid);
        if (env === null || hasSlot(env)) name = undefined;
      }
    }
    verdict.set(p.pid, name);
    return name;
  };
  const out: Leak[] = [];
  for (const p of procs) {
    const name = leakName(p);
    if (!name) continue;
    let top = true;
    for (let q = byPid.get(p.ppid ?? 0), n = 0; q && n < 64; q = byPid.get(q.ppid ?? 0), n++) {
      if (leakName(q)) { top = false; break; }
    }
    if (!top) continue;
    const runId = runScopeOf(p.cgroup)?.runId;
    out.push({ pid: p.pid, name, ...(runId ? { runId } : {}) });
  }
  return out;
}

/** The report of one pass. `names`: each name once, sorted. Pure. */
export function leakReport(leaks: Leak[], at: number): LeakReport {
  return { at, count: leaks.length, names: [...new Set(leaks.map((l) => l.name))].sort(), leaks };
}

function readEnviron(pid: number): string | null {
  try { return readFileSync(`/proc/${pid}/environ`, "utf8"); } catch { return null; }
}

let latest: LeakReport | undefined;
const logged = new Set<number>();

/** What the machine card and `orca machine` show: the newest pass without its pids. Undefined
 *  before the first pass (and off Linux, where nothing sweeps). */
export type UnqueuedSummary = { at: number; count: number; names: string[] };
export function unqueuedSummary(): UnqueuedSummary | undefined {
  return latest && { at: latest.at, count: latest.count, names: latest.names };
}

/** One pass: find the leaks, keep the report, and log each new leak once. */
export function sweep(deps: { procs?: () => ProcInfo[]; environ?: (pid: number) => string | null; now?: () => number; log?: boolean } = {}): LeakReport {
  const leaks = findLeaks((deps.procs ?? readProcs)(), deps.environ ?? readEnviron);
  latest = leakReport(leaks, (deps.now ?? Date.now)());
  const live = new Set(leaks.map((l) => l.pid));
  for (const pid of logged) if (!live.has(pid)) logged.delete(pid);
  for (const l of leaks) {
    if (logged.has(l.pid)) continue;
    logged.add(l.pid);
    if (deps.log !== false) console.error(`orca: unqueued heavy command ${l.name} (pid ${l.pid}, run ${l.runId ?? "unknown"}) runs outside orca-run`);
  }
  return latest;
}
