// The browser watchdog: every 30 s the primary bridge looks at each process in the agents' slice
// and kills a browser or a browser MCP server that a worker started. The MCP lockdown
// (server/mcp.ts) stops the known path; this stops every other one (a worker's own `npx
// chrome-devtools-mcp`, a puppeteer script, a Playwright launch outside the test queue). The
// 2026-10-19 incident: seven playwright-mcp and seven chrome-devtools-mcp, each with Chrome
// children, pushed load to 29 on 4 cores.
//
// Two scopes are exempt: orca-shot's (`orca-shot-…`, the bridge's one capped browser — it runs
// outside the agents' slice anyway) and the test queue's slots (`orca-heavy-…`, where Playwright
// e2e runs). Each kill is recorded on the workstream that started it (enrichment `browserKilled`,
// the card's warning) and as a step in that run's transcript.
import { readdirSync, readFileSync } from "fs";
import { basename } from "path";
import type { AgentStep } from "../shared/agent";
import * as bus from "./bus";
import { AGENTS_SLICE } from "./cgroup";
import * as db from "./db";
import * as outbox from "./outbox";
import * as transcript from "./transcript";

export const WATCH_INTERVAL_MS = 30_000;

/** Browser binaries, by the base name of argv[0] (or `comm`, which Linux cuts at 15 characters). */
const BROWSER_BINARIES = ["chrome", "chrome-headless-shell", "chromium", "chromium-browser", "headless_shell", "google-chrome", "google-chrome-stable", "chrome_crashpad_handler"];
/** Browser MCP servers: a whole argument that names the package or a file in it. */
const MCP_SERVER = /(^|[\/@])(chrome-devtools-mcp|playwright-mcp|playwright\/mcp)([\/@.]|$)/i;

/** Scopes whose browsers are allowed: orca-shot's and the test queue's slots. */
const EXEMPT_SCOPE = /\/orca-(shot|heavy)-[^/]*\.scope(\/|$)/;
const RUN_SCOPE = /\/orca-run-([0-9a-f-]{36})\.scope(\/|$)/;

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

export type ProcInfo = { pid: number; cgroup: string; argv: string[]; comm: string };
export type Verdict = { kill: false } | { kill: true; name: string; runId?: string };

/** Whether the watchdog kills this process. Only the agents' slice is looked at. Pure. */
export function watchVerdict(p: ProcInfo, self = process.pid): Verdict {
  if (p.pid === self || !p.cgroup.includes(`/${AGENTS_SLICE}/`) || EXEMPT_SCOPE.test(p.cgroup)) return { kill: false };
  const name = browserProcess(p.argv, p.comm);
  if (!name) return { kill: false };
  return { kill: true, name, runId: p.cgroup.match(RUN_SCOPE)?.[1] };
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
      out.push({ pid: Number(e), cgroup, argv, comm });
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
  kill?: (pid: number) => void;
  /** Record the kills of one run: the card and the transcript. */
  record?: (runId: string | undefined, names: string[]) => Promise<void>;
};

/** One pass: kill each browser in the agents' slice, then record them per run. Returns the kills. */
export async function sweep(deps: WatchDeps = {}): Promise<{ pid: number; name: string; runId?: string }[]> {
  const kill = deps.kill ?? ((pid: number) => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
  const killed: { pid: number; name: string; runId?: string }[] = [];
  for (const p of (deps.procs ?? readProcs)()) {
    const v = watchVerdict(p);
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
