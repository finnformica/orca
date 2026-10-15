// The caveman A/B trial (server/caveman.ts, shared/cavemanTrial.ts): the per-repo switch, the direct
// fallback, the trial record and the report. A fake `caveman-proxy` (a Bun health server) under a
// scratch caveman root, a fake `claude` on PATH that records its env and argv, real Postgres for the
// queued direct retry. No network: the fake claude never calls the proxy.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agent from "../server/agent";
import * as caveman from "../server/caveman";
import * as db from "../server/db";
import { launchOptions } from "../server/verbs";
import { parseConfigDocument, type OrcaConfig } from "../server/config";
import {
  CAVEMAN_RETRY_MARKER, renderTrialReport, retryDirect, summarizeTrial, wantsCaveman, type TrialRow,
} from "../shared/cavemanTrial";
import { ORCHESTRATOR_REPO } from "../web/src/workstream";
import { freshSchema, type TestDb } from "./pg";
import { native } from "./happydom";

let state: string, shim: string, root: string, log: string, wt: string;
let prev: Record<string, string | undefined> = {};
let browser: { fetch: typeof fetch; AbortSignal: typeof AbortSignal };
const PORT = 20_000 + Math.floor(Math.random() * 20_000);

const RESULT = `{"type":"result","subtype":"success","is_error":false,"result":"## Outcome\\\\nDone.","session_id":"S","usage":{"input_tokens":120,"cache_read_input_tokens":3000,"cache_creation_input_tokens":500,"output_tokens":40},"total_cost_usd":0.25,"modelUsage":{"claude-opus-5-5":{"outputTokens":40,"contextWindow":200000}}}`;

/** A caveman install: the three binaries (the proxy is a Bun health server, or one that dies) and
 *  the skill. `proxy: "none"` leaves the proxy out. */
async function install(proxy: "healthy" | "dies" | "none"): Promise<void> {
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "skills", "caveman"), { recursive: true });
  await writeFile(join(root, "skills", "caveman", "SKILL.md"), "Respond terse like smart caveman.\n");
  for (const b of ["caveman-mcp", "caveman-engine"]) {
    await writeFile(join(root, "bin", b), "#!/bin/sh\nexit 0\n");
    await chmod(join(root, "bin", b), 0o755);
  }
  if (proxy === "none") return;
  const server = `echo $$ > "${root}/proxy.pid"; exec bun -e 'Bun.serve({ hostname: "127.0.0.1", port: ${PORT}, fetch: () => Response.json({ ok: true, service: "caveman-proxy" }) })'`;
  await writeFile(join(root, "bin", "caveman-proxy"), proxy === "healthy" ? `#!/bin/sh\n${server}\n` : "#!/bin/sh\nexit 1\n");
  await chmod(join(root, "bin", "caveman-proxy"), 0o755);
}

beforeEach(async () => {
  prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_CAVEMAN_ROOT", "ORCA_CAVEMAN_PORT", "ORCA_FAKE_LOG", "ORCA_FAKE_FAIL"].map((k) => [k, process.env[k]]));
  [state, shim, root, log, wt] = await Promise.all(["state", "claude", "root", "log", "wt"].map(async (n) => realpathSync(await mkdtemp(join(tmpdir(), `orca-caveman-${n}-`))))) as [string, string, string, string, string];
  process.env.ORCA_STATE_DIR = state;
  process.env.ORCA_CAVEMAN_ROOT = root;
  process.env.ORCA_CAVEMAN_PORT = String(PORT);
  process.env.ORCA_FAKE_LOG = log;
  delete process.env.ORCA_FAKE_FAIL;
  process.env.PATH = `${shim}:${prev.PATH}`;
  // A fake claude: records "<base url>|<argv>"; with ORCA_FAKE_FAIL set it fails the way the CLI does
  // when its API connection breaks, but only through the proxy.
  await writeFile(join(shim, "claude"), `#!/bin/sh
printf '%s|%s%s|%s' "$ANTHROPIC_BASE_URL" "$ENABLE_TOOL_SEARCH" "$_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL" "$*" > "$ORCA_FAKE_LOG/$(date +%s%N)-$$"
if [ -n "$ORCA_FAKE_FAIL" ] && [ -n "$ANTHROPIC_BASE_URL" ]; then echo "API Error: Connection error." >&2; exit 1; fi
printf '%s\\n' '${RESULT}'
`);
  await chmod(join(shim, "claude"), 0o755);
  caveman.resetDown();
  // The preloaded happy-dom swaps in a browser fetch and AbortSignal; the bridge's health probe runs
  // on Bun's own.
  browser = { fetch: globalThis.fetch, AbortSignal: globalThis.AbortSignal };
  Object.assign(globalThis, { fetch: native.fetch, AbortSignal: native.AbortSignal });
});

afterEach(async () => {
  for (let i = 0; i < 200 && agent.isRunning(wt); i++) await new Promise((r) => setTimeout(r, 25));
  await agent.flushHistory();
  try { process.kill(Number(await readFile(join(root, "proxy.pid"), "utf8")), "SIGTERM"); } catch { /* none started */ }
  Object.assign(globalThis, browser);
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, root, log, wt]) await rm(d, { recursive: true, force: true });
});

const launches = async () => Promise.all((await readdir(log)).sort().map((f) => readFile(join(log, f), "utf8")));
async function finished(n = 1): Promise<TrialRow[]> {
  for (let i = 0; i < 400; i++) {
    const rows = caveman.readRows(join(state, "trial", "caveman.jsonl"));
    if (rows.length >= n && !agent.isRunning(wt)) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the run never finished");
}

const cfg = (): OrcaConfig => ({
  repos: [
    { name: "orca", repoPath: "/x/orca", worktreeRoot: "/x/orca/.worktrees", baseBranch: "main", agentProxy: "caveman", previewServices: [] },
    { name: "branch-demo", repoPath: "/x/bd", worktreeRoot: "/x/bd/.worktrees", baseBranch: "master", previewServices: [] },
  ],
  portRange: [30000, 40000], staleHours: 24,
});

test("CV1: only a Claude worker in an opted-in repo goes through caveman", () => {
  const base = { orchestratorRepo: ORCHESTRATOR_REPO };
  expect(wantsCaveman({ ...base, agentProxy: "caveman", provider: "claude", repo: "orca" })).toBe(true);
  expect(wantsCaveman({ ...base, provider: "claude", repo: "branch-demo" })).toBe(false);
  expect(wantsCaveman({ ...base, agentProxy: "caveman", provider: "codex", repo: "orca" })).toBe(false);
  expect(wantsCaveman({ ...base, agentProxy: "caveman", provider: "claude", repo: ORCHESTRATOR_REPO })).toBe(false);
  // The config switch: validated, and carried by launchOptions for the opted-in repo only.
  const [orca, bd] = cfg().repos as [OrcaConfig["repos"][0], OrcaConfig["repos"][0]];
  expect(launchOptions(cfg(), orca, "claude").agentProxy).toBe("caveman");
  expect(launchOptions(cfg(), bd, "claude").agentProxy).toBeUndefined();
  expect(parseConfigDocument({ repos: [{ ...orca }] }).errors).toEqual([]);
  expect(parseConfigDocument({ repos: [{ ...orca, agentProxy: "other" }] }).errors.join()).toContain("agentProxy");
});

test("CV2: switch on — the run gets the proxy URL, the skill and caveman-mcp; the run is recorded as caveman", async () => {
  await install("healthy");
  await agent.runAgent(wt, "add a cache", { ...launchOptions(cfg(), cfg().repos[0]!, "claude"), action: "launch" });
  const [row] = await finished();
  const [call] = await launches();
  // The proxy is treated as the Anthropic API: tool search and the global cache scope stay on.
  expect(call!.startsWith(`http://127.0.0.1:${PORT}|true1|`)).toBe(true);
  expect(call).toContain(`--mcp-config ${join(root, "orca", "mcp.json")}`);
  expect(call).toContain("--append-system-prompt Respond terse like smart caveman.");
  expect(row).toMatchObject({ repo: "orca", provider: "claude", caveman: true, status: "done", inputTokens: 120, cacheReadTokens: 3000, cacheCreationTokens: 500, outputTokens: 40, costUsd: 0.25 });
  expect(row!.fallback).toBeUndefined();
  // Routing (Auto) and telemetry are off in the proxy's own home; the MCP server runs offline.
  const cloud = JSON.parse(await readFile(join(root, "orca", "cloud.json"), "utf8"));
  expect(cloud.modules.routing).toBe(false);
  expect(cloud.modules.browse).toBe(false);
  expect(cloud.telemetry.enabled).toBe(false);
  const yaml = await readFile(join(root, "orca", "caveman.yaml"), "utf8");
  expect(yaml).toContain(`listen: 127.0.0.1:${PORT}`);
  expect(yaml).toContain("mode: compress");
  expect(JSON.parse(await readFile(join(root, "orca", "mcp.json"), "utf8")).mcpServers.caveman.env).toMatchObject({ CAVEMAN_OFFLINE: "1", DO_NOT_TRACK: "1" });
  // The first caveman run records the trial's start.
  expect(caveman.startedAt()).toBe(row!.at);
});

test("CV3: the control repo runs direct and is recorded as caveman off, with no fallback", async () => {
  await install("healthy");
  await agent.runAgent(wt, "add a cache", { ...launchOptions(cfg(), cfg().repos[1]!, "claude") });
  const [row] = await finished();
  const [call] = await launches();
  expect(call!.startsWith("||")).toBe(true);
  expect(call).not.toContain("--append-system-prompt");
  expect(row).toMatchObject({ repo: "branch-demo", caveman: false, status: "done" });
  expect(row!.fallback).toBeUndefined();
  expect(existsSync(join(root, "proxy.pid"))).toBe(false); // the control never starts the proxy
});

test("CV4: caveman not installed — the run goes direct, succeeds, and the fallback is recorded", async () => {
  await install("none");
  await agent.runAgent(wt, "add a cache", { ...launchOptions(cfg(), cfg().repos[0]!, "claude") });
  const [row] = await finished();
  expect((await launches())[0]!.startsWith("|")).toBe(true);
  expect(row).toMatchObject({ caveman: false, status: "done", fallback: "caveman not installed on this host" });
});

test("CV5: a proxy that does not start — the run goes direct, and the proxy is marked down for the next run", async () => {
  await install("dies");
  await agent.runAgent(wt, "add a cache", { ...launchOptions(cfg(), cfg().repos[0]!, "claude") });
  const [row] = await finished();
  expect(row).toMatchObject({ caveman: false, status: "done", fallback: "proxy did not start" });
  expect(await caveman.prepare()).toEqual({ on: false, fallback: "proxy marked down: proxy did not start" });
}, 15_000);

test("CV6: a caveman run that fails on the API connection queues ONE direct retry on the same branch", async () => {
  const pg: TestDb = await freshSchema("caveman");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  try {
    await install("healthy");
    process.env.ORCA_FAKE_FAIL = "1";
    await agent.runAgent(wt, "add a cache", { ...launchOptions(cfg(), cfg().repos[0]!, "claude"), branch: "b1", instruction: "add a cache" });
    const [row] = await finished();
    expect(row).toMatchObject({ caveman: true, status: "error" });
    let queued: db.QueuedMessage[] = [];
    for (let i = 0; i < 200 && !queued.length; i++) { queued = await db.queuedMessages("orca", "b1"); await new Promise((r) => setTimeout(r, 25)); }
    expect(queued).toHaveLength(1);
    expect(queued[0]!.instruction.startsWith(CAVEMAN_RETRY_MARKER)).toBe(true);
    expect(queued[0]!.instruction).toContain("API Error: Connection error.");
    // The retry runs direct: the proxy is out of use, and the direct run succeeds.
    const wiring = await caveman.prepare();
    expect(wiring.on).toBe(false);
    await agent.runAgent(wt, "retry", { ...launchOptions(cfg(), cfg().repos[0]!, "claude"), branch: "b1", instruction: queued[0]!.instruction });
    const rows = await finished(2);
    expect(rows[1]).toMatchObject({ caveman: false, status: "done" });
    expect((await launches())[1]!.startsWith("|")).toBe(true);
  } finally {
    await agent.flushHistory();
    await db.close();
    await pg.drop();
  }
}, 15_000);

test("CV7: retryDirect — only a failed caveman run, never a stop or a retry", () => {
  const base = { caveman: true, ok: false, stopped: false, proxyHealthy: true, error: "API Error: 502 Bad Gateway" };
  expect(retryDirect(base)).toBe(true);
  expect(retryDirect({ ...base, error: "tests failed", proxyHealthy: false })).toBe(true); // the proxy died
  expect(retryDirect({ ...base, error: "tests failed" })).toBe(false); // the work failed, not the trial
  expect(retryDirect({ ...base, stopped: true })).toBe(false);
  expect(retryDirect({ ...base, caveman: false })).toBe(false);
  expect(retryDirect({ ...base, instruction: `${CAVEMAN_RETRY_MARKER} more` })).toBe(false);
});

test("CV8: the report compares the arms over the range: medians, totals, cost, failure rate, duration", () => {
  const t0 = Date.parse("2026-10-16T00:00:00Z");
  const row = (o: Partial<TrialRow>): TrialRow => ({ at: t0 + 1000, repo: "orca", provider: "claude", caveman: true, status: "done", ...o });
  const rows = [
    row({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 10, costUsd: 1, durationMs: 60_000 }),
    row({ inputTokens: 300, cacheReadTokens: 700, cacheCreationTokens: 1000, outputTokens: 30, costUsd: 3, durationMs: 120_000, status: "error" }),
    row({ repo: "branch-demo", caveman: false, inputTokens: 5000, outputTokens: 100, costUsd: 4, durationMs: 180_000 }),
    row({ caveman: false, fallback: "proxy did not start", inputTokens: 7000, outputTokens: 300, costUsd: 6, durationMs: 60_000 }),
    row({ provider: "codex", caveman: false, inputTokens: 1e9 }), // another provider: not compared
    row({ at: t0 - 1, inputTokens: 1e9 }), // before the range
  ];
  const { on, off } = summarizeTrial(rows, { from: t0, to: t0 + 86_400_000 });
  expect(on).toMatchObject({ runs: 2, failed: 1, failureRate: 0.5, inputMedian: 1500, inputTotal: 3000, freshInputTotal: 400, outputMedian: 20, outputTotal: 40, costTotal: 4, durationMedianMs: 90_000 });
  expect(off).toMatchObject({ runs: 2, failed: 0, fallbacks: 1, inputTotal: 12_000, outputTotal: 400, costTotal: 10 });
  const text = renderTrialReport(rows, { from: t0, to: t0 + 86_400_000 }, t0);
  expect(text).toContain("Trial start: 2026-10-16T00:00:00.000Z");
  expect(text).toMatch(/Failed runs\s+1 \(50\.0%\)\s+0 \(0\.0%\)/);
  expect(text).toMatch(/Cost, total\s+\$4\.00\s+\$10\.00/);
});
