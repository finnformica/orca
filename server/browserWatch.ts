// The browser watchdog: every 30 s the primary bridge looks at each process in the agents' slice
// and kills a browser or a browser MCP server that a worker started. The MCP lockdown
// (server/mcp.ts) stops the known path; this stops every other one (a worker's own `npx
// chrome-devtools-mcp`, a puppeteer script, a Playwright launch outside the test queue). The
// 2026-10-19 incident: seven playwright-mcp and seven chrome-devtools-mcp, each with Chrome
// children, pushed load to 29 on 4 cores.
//
// Two scopes are exempt: orca-shot's (`orca-shot-…`, the bridge's one capped browser — it runs
// outside the agents' slice anyway) and the test queue's slots (`orca-heavy-…`, where Playwright
// e2e runs). Until that queue is on this install (`bin/worker/orca-run`), a browser under a
// `playwright test` runner is a test and is kept too: workers ran e2e suites in their own scope
// before the queue, and the ban is on browsers outside tests. Each kill is recorded on the workstream that started it (enrichment `browserKilled`,
// the card's warning) and as a step in that run's transcript.
//
// The same pass stops ORPHAN run scopes (`sweepOrphanScopes`): an `orca-run-<owner>-<runId>.scope`
// of THIS bridge's owner (a hash of its state dir, `cgroup.scopeOwner`) whose run no lease file in
// that state dir names: one a dead bridge forgot. A scope of another owner is never touched — a
// test bridge with its own state dir once killed every live worker on the box (2026-10-23). 2026-10-19: six fake claudes of a test looped through the `bun` shims for minutes in real
// run scopes. A scope is killed on the second pass in a row that sees it, so a launch between its
// spawn and its lease write is safe.
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import type { AgentStep } from "../shared/agent";
import * as bus from "./bus";
import { AGENTS_SLICE, defaultScopeOwner, runScopeOf, scopeOwner } from "./cgroup";
import * as db from "./db";
import { WORKER_BIN } from "./env";
import * as lease from "./lease";
import * as outbox from "./outbox";
import * as transcript from "./transcript";

/** 30 s; `ORCA_WATCH_INTERVAL_MS` makes it shorter for a test bridge. */
export const WATCH_INTERVAL_MS = Number(process.env.ORCA_WATCH_INTERVAL_MS) || 30_000;

/** Browser binaries, by the base name of argv[0] (or `comm`, which Linux cuts at 15 characters). */
const BROWSER_BINARIES = ["chrome", "chrome-headless-shell", "chromium", "chromium-browser", "headless_shell", "google-chrome", "google-chrome-stable", "chrome_crashpad_handler"];
/** Browser MCP servers: a whole argument that names the package or a file in it. */
const MCP_SERVER = /(^|[\/@])(chrome-devtools-mcp|playwright-mcp|playwright\/mcp)([\/@.]|$)/i;

/** Scopes whose browsers are allowed: orca-shot's and the test queue's slots. */
const EXEMPT_SCOPE = /\/orca-(shot|heavy)-[^/]*\.scope(\/|$)/;

/** What a process is, when it is a browser or a browser MCP server: the name to report. Pure. */
export function browserProcess(argv: string[], comm = ""): string | undefined {
  const bin = basename(argv[0] ?? "");
  if (BROWSER_BINARIES.includes(bin)) return bin;
  if (comm && BROWSER_BINARIES.some((b) => b.slice(0, 15) === comm)) return BROWSER_BINARIES.find((b) => b.slice(0, 15) === comm);
  for (const a of argv) {
    if (/\s/.test(a)) continue; // a message or a script, not a package
    const m = a.match(MCP_SERVER);
    if (m) return m[2]!.toLowerCase() === "playwright/mcp" ? "@playwright/mcp" : m[2]!.toLowerCase();
  }
  return undefined;
}

export type ProcInfo = { pid: number; ppid?: number; cgroup: string; argv: string[]; comm: string };

/** A Playwright test runner: `playwright test …` (the bin or its cli.js). Pure. */
export function isTestRunner(argv: string[]): boolean {
  const i = argv.findIndex((a) => /(^|\/)playwright(\.js)?$/.test(a) || /@playwright\/test\/cli\.js$/.test(a));
  return i >= 0 && argv[i + 1] === "test";
}

/** Whether the test queue is on this install: then e2e runs go through its slots alone. */
export const testQueuePresent = (): boolean => existsSync(join(WORKER_BIN, "orca-run"));
export type Verdict = { kill: false } | { kill: true; name: string; runId?: string };

/** Whether the watchdog kills this process. Only the agents' slice is looked at. Pure. */
/** `underTest`: an ancestor is a Playwright test runner, and no test queue is here to run it. */
export function watchVerdict(p: ProcInfo, self = process.pid, underTest = false): Verdict {
  if (p.pid === self || !p.cgroup.includes(`/${AGENTS_SLICE}/`) || EXEMPT_SCOPE.test(p.cgroup)) return { kill: false };
  const name = browserProcess(p.argv, p.comm);
  if (!name || underTest) return { kill: false };
  return { kill: true, name, runId: runScopeOf(p.cgroup)?.runId };
}

/** Every process this user can read under `/proc`. Gone or unreadable ones are skipped. */
export function readProcs(root = "/proc"): ProcInfo[] {
  const out: ProcInfo[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return out; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const cgroup = readFileSync(`${root}/${e}/cgroup`, "utf8").split("\n").find((l) => l.startsWith("0::"))?.slice(3) ?? "";
      const argv = readFileSync(`${root}/${e}/cmdline`, "utf8").split("\0").filter(Boolean);
      const comm = readFileSync(`${root}/${e}/comm`, "utf8").trim();
      // `stat`: "pid (comm) state ppid …" — comm may hold spaces and parentheses, so cut at the last ")".
      let ppid: number | undefined;
      try { const stat = readFileSync(`${root}/${e}/stat`, "utf8"); ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]); } catch { /* none */ }
      out.push({ pid: Number(e), ...(Number.isFinite(ppid) ? { ppid } : {}), cgroup, argv, comm });
    } catch { /* gone, or not ours */ }
  }
  return out;
}

/** The card's record of the kills on one workstream. */
export type BrowserKillRecord = { at: string; runId?: string; names: string[]; count: number };

/** The record after one more batch of kills for a run: a new run starts it again. Pure. */
export function nextKillRecord(prev: BrowserKillRecord | undefined, runId: string | undefined, names: string[], now: Date): BrowserKillRecord {
  const same = prev && prev.runId === runId;
  return {
    at: now.toISOString(), runId,
    names: [...new Set([...(same ? prev.names : []), ...names])].sort(),
    count: (same ? prev.count : 0) + names.length,
  };
}

/** The warning step in the run's transcript. Pure. */
export function killStep(names: string[], at = Date.now()): AgentStep {
  const list = [...new Set(names)].sort().join(", ");
  return { at, kind: "text", text: `⚠ Orca killed ${names.length} browser process${names.length === 1 ? "" : "es"} that this run started (${list}). Workers must not start a browser or a browser MCP server. Use \`orca-shot\` to look at a page, and run Playwright e2e tests in the test queue's e2e slot.` };
}

export type WatchDeps = {
  procs?: () => ProcInfo[];
  /** Whether the test queue is installed (default: `bin/worker/orca-run` exists). */
  testQueue?: () => boolean;
  kill?: (pid: number) => void;
  /** Record the kills of one run: the card and the transcript. */
  record?: (runId: string | undefined, names: string[]) => Promise<void>;
};

/** One pass: kill each browser in the agents' slice, then record them per run. Returns the kills. */
export async function sweep(deps: WatchDeps = {}): Promise<{ pid: number; name: string; runId?: string }[]> {
  const kill = deps.kill ?? ((pid: number) => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
  const killed: { pid: number; name: string; runId?: string }[] = [];
  const procs = (deps.procs ?? readProcs)();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const testQueue = (deps.testQueue ?? testQueuePresent)();
  const underTest = (p: ProcInfo): boolean => {
    for (let q = byPid.get(p.ppid ?? 0), n = 0; q && n < 64; q = byPid.get(q.ppid ?? 0), n++) if (isTestRunner(q.argv)) return true;
    return false;
  };
  for (const p of procs) {
    const v = watchVerdict(p, process.pid, !testQueue && underTest(p));
    if (!v.kill) continue;
    kill(p.pid);
    killed.push({ pid: p.pid, name: v.name, runId: v.runId });
  }
  const byRun = new Map<string | undefined, string[]>();
  for (const k of killed) byRun.set(k.runId, [...(byRun.get(k.runId) ?? []), k.name]);
  for (const [runId, names] of byRun) {
    console.error(`orca: browser watchdog killed ${names.length} process(es) (${[...new Set(names)].join(", ")}) of run ${runId ?? "unknown"}`);
    await deps.record?.(runId, names);
  }
  return killed;
}

/** The real record: the run's workstream gets `browserKilled` on its enrichment, and the run's
 *  transcript gets the warning step (pushed to any open chat). A run with no turn is only logged. */
export async function recordKills(runId: string | undefined, names: string[]): Promise<void> {
  if (!runId) return;
  const owner = await db.turnOwner(runId).catch(() => undefined);
  if (!owner) return;
  const prev = (await outbox.enrichment(owner.repo)).data[owner.branch]?.browserKilled as BrowserKillRecord | undefined;
  await outbox.patchEnrichment(owner.repo, owner.branch, { browserKilled: nextKillRecord(prev, runId, names, new Date()) });
  const written = await transcript.append(runId, [killStep(names)]);
  if (written.length) bus.publish({ kind: "step", runId, repo: owner.repo, branch: owner.branch, steps: written });
}

/** The run of a process in a run scope of `owner` in the agents' slice that no lease names. A scope
 *  of another owner is never an orphan here. Pure. */
export function orphanRun(p: ProcInfo, known: Set<string>, self = process.pid, owner = scopeOwner(), defaultOwner = defaultScopeOwner()): string | undefined {
  if (p.pid === self || !p.cgroup.includes(`/${AGENTS_SLICE}/`)) return undefined;
  const scope = runScopeOf(p.cgroup, defaultOwner);
  return scope && scope.owner === owner && !known.has(scope.runId) ? scope.runId : undefined;
}

export type OrphanDeps = {
  procs?: () => ProcInfo[];
  /** Run ids with a lease file here; `undefined` (unreadable) kills nothing. */
  known?: () => Set<string> | undefined;
  /** This bridge's scope owner (default: its state dir's). */
  owner?: string;
  kill?: (pid: number) => void;
  /** The orphan runs the last pass saw: read, then replaced with this pass's. */
  suspects?: Set<string>;
};

const suspects = new Set<string>();

/** One pass: kill every process of a run scope seen as an orphan on this pass and the last one. */
export function sweepOrphanScopes(deps: OrphanDeps = {}): { pid: number; runId: string }[] {
  const kill = deps.kill ?? ((pid: number) => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
  const last = deps.suspects ?? suspects;
  // The processes first, then the leases: a run that starts between the two reads is known.
  const procs = (deps.procs ?? readProcs)();
  const known = (deps.known ?? lease.knownRunIds)();
  const owner = deps.owner ?? scopeOwner();
  const defaultOwner = defaultScopeOwner();
  const seen = new Set<string>();
  const killed: { pid: number; runId: string }[] = [];
  if (known) {
    for (const p of procs) {
      const runId = orphanRun(p, known, process.pid, owner, defaultOwner);
      if (!runId) continue;
      seen.add(runId);
      if (!last.has(runId)) continue;
      kill(p.pid);
      killed.push({ pid: p.pid, runId });
    }
  }
  last.clear();
  for (const r of seen) last.add(r);
  for (const runId of new Set(killed.map((k) => k.runId))) {
    console.error(`orca: watchdog killed ${killed.filter((k) => k.runId === runId).length} process(es) of orphan scope of run ${runId} (no lease in this bridge's state dir)`);
  }
  return killed;
}
