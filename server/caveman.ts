// The caveman trial's I/O half (decisions: shared/cavemanTrial.ts). A repo with
// `agentProxy: "caveman"` runs its Claude workers through caveman (github.com/JuliusBrussee/caveman,
// binaries bin-v4.0.1, installed by hand under ~/.caveman/bin and checked against the release's
// checksums.txt). Nothing here touches ~/.claude or any user-level setting: each run gets
//   - Read less: ANTHROPIC_BASE_URL → the local caveman-proxy, mode `compress` (the `input` module);
//   - Say less: the pinned `caveman` skill text as --append-system-prompt (the `output` module —
//     the CLI's hook would inject it per prompt, and that hook lives in user settings);
//   - recovery: caveman-mcp as a per-run --mcp-config, so a compressed block can be read back.
// Auto (routing), browse, cloud, login and telemetry stay off: the proxy's own home has a cloud.json
// with routing and telemetry off, no credentials, and CAVEMAN_OFFLINE / DO_NOT_TRACK in its env.
// The proxy forwards the run's own credential, so hydra's per-launch login choice is untouched.
//
// A worker never fails because of the trial: a proxy that will not start makes the run go direct
// (logged, recorded as a fallback), and a caveman run that fails on the API connection marks the
// proxy down and queues one direct retry (agent.ts).
import { homedir } from "os";
import { join } from "path";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { statePath } from "./state";
import { scrubbedEnv } from "./env";
import * as cgroup from "./cgroup";
import type { TrialRow } from "../shared/cavemanTrial";

export const CAVEMAN_VERSION = "bin-v4.0.1";
/** Where the binaries and the skill are installed. */
export const cavemanRoot = (): string => process.env.ORCA_CAVEMAN_ROOT || join(homedir(), ".caveman");
/** The proxy's own state (its CAVEMAN_HOME): separate from the install, never a user's caveman home. */
const runtimeHome = (): string => join(cavemanRoot(), "orca");
/** Loopback only. Not 8787 — caveman's default is Orca's own bridge port. */
export const cavemanPort = (): number => Number(process.env.ORCA_CAVEMAN_PORT) || 8797;
const baseUrl = (): string => `http://127.0.0.1:${cavemanPort()}`;
const binary = (name: string): string => join(cavemanRoot(), "bin", name);
const skillPath = (): string => join(cavemanRoot(), "skills", "caveman", "SKILL.md");

/** How a run is wired: through caveman (extra env + argv), or direct with the reason when the repo
 *  asked for caveman and did not get it. */
export type CavemanWiring = { on: true; env: Record<string, string>; args: string[] } | { on: false; fallback: string };

/** How long the proxy stays off after it failed to start or failed a run: every run in that window
 *  goes direct without waiting on a start. */
export const DOWN_COOLDOWN_MS = 10 * 60_000;
let downUntil = 0;
let downReason = "";

/** Take the proxy out of use for a while. Logged: the trial's report needs to know why runs went direct. */
export function markDown(reason: string, ms = DOWN_COOLDOWN_MS): void {
  downUntil = Date.now() + ms;
  downReason = reason;
  console.warn(`orca: caveman proxy marked down for ${Math.round(ms / 60_000)} min (${reason}); worker runs go direct`);
}
/** Tests only. */
export function resetDown(): void { downUntil = 0; downReason = ""; }

/** Is OUR proxy answering? The health body names the service: any other process that holds the port
 *  (a preview's dev server answers 200 to every path) is not it. */
export async function healthy(timeoutMs = 1_000): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/health/ready`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = await res.json() as { service?: string; ok?: boolean };
    return body?.service === "caveman-proxy" && body.ok === true;
  } catch {
    return false;
  }
}

const writeIfChanged = (path: string, content: string): void => {
  try { if (readFileSync(path, "utf8") === content) return; } catch { /* absent */ }
  writeFileSync(path, content);
};

/** The proxy's config, its cloud state (routing and telemetry off, never signed in) and the per-run
 *  MCP config. Written on every prepare, so a hand edit can't turn Auto or telemetry on. */
function writeRuntimeFiles(): { config: string; mcp: string } {
  const home = runtimeHome();
  mkdirSync(home, { recursive: true });
  const config = join(home, "caveman.yaml");
  writeIfChanged(config, [
    "# Written by Orca (server/caveman.ts). Edits are overwritten.",
    "label: orca-trial",
    "mode: compress", // the `input` module: logs, JSON, code and diffs shrink before the model reads them
    `listen: 127.0.0.1:${cavemanPort()}`,
    "subscription_compress: live_zone", // hydra logins are subscription traffic
    "upstream_proxy: env",
    "",
  ].join("\n"));
  writeIfChanged(join(home, "cloud.json"), JSON.stringify({
    modules: { output: true, input: true, "waste-fixes": false, routing: false, scripts: false, browse: false },
    telemetry: { enabled: false },
  }, null, 2) + "\n");
  const mcp = join(home, "mcp.json");
  writeIfChanged(mcp, JSON.stringify({
    mcpServers: { caveman: { command: binary("caveman-mcp"), args: [], env: { CAVEMAN_HOME: home, ...OFFLINE_ENV } } },
  }, null, 2) + "\n");
  return { config, mcp };
}

/** Everything caveman reads to stay away from its services. */
const OFFLINE_ENV = { CAVEMAN_OFFLINE: "1", DO_NOT_TRACK: "1", CAVEMAN_TELEMETRY: "off" } as const;

let starting: Promise<boolean> | undefined;

/** Start the proxy unless it already answers. It runs in its OWN systemd scope where one is
 *  available, so a bridge restart (an auto-deploy) does not kill it under live runs. */
async function ensureProxy(config: string): Promise<boolean> {
  if (await healthy()) return true;
  starting ??= (async () => {
    try {
      const home = runtimeHome();
      const log = openSync(join(home, "serve.log"), "a");
      const scoped = cgroup.available();
      const argv = cgroup.scopedCommand([binary("caveman-proxy"), "serve"], {
        available: scoped, memoryMaxGb: 1, cpuWeight: cgroup.DEFAULT_CPU_WEIGHT, unit: `orca-caveman-proxy-${Date.now()}`,
      });
      const child = spawn(argv[0]!, argv.slice(1), {
        detached: true, stdio: ["ignore", log, log],
        env: scrubbedEnv({
          ...(scoped ? cgroup.runtimeEnv() : {}),
          CAVEMAN_HOME: home, CAVEMAN_CONFIG: config, CAVEMAN_CACHE_WARM: "off", ...OFFLINE_ENV,
        }),
      });
      child.on("error", () => { /* reported as "did not start" below */ });
      child.unref();
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (await healthy(500)) return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      starting = undefined;
    }
  })();
  return starting;
}

/** How this run is wired. Never throws: anything wrong means direct, with the reason. */
export async function prepare(): Promise<CavemanWiring> {
  if (Date.now() < downUntil) return { on: false, fallback: `proxy marked down: ${downReason}` };
  const missing = ["caveman-proxy", "caveman-mcp", "caveman-engine"].map(binary).concat(skillPath()).filter((p) => !existsSync(p));
  if (missing.length) {
    console.warn(`orca: caveman not installed on this host (${missing.join(", ")}); worker runs go direct`);
    return { on: false, fallback: "caveman not installed on this host" };
  }
  try {
    const { config, mcp } = writeRuntimeFiles();
    if (!(await ensureProxy(config))) {
      markDown("proxy did not start");
      return { on: false, fallback: "proxy did not start" };
    }
    const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");
    return {
      on: true,
      // ENABLE_TOOL_SEARCH: Claude Code turns tool search off when ANTHROPIC_BASE_URL is set, and then
      // sends every tool schema on every request — about 16k more input tokens than a direct run, so
      // the trial cost more (docs/research/caveman-trial-samples-2026-10-15.md). The proxy forwards
      // the deferred-tool request unchanged, so it stays on here.
      env: { ANTHROPIC_BASE_URL: baseUrl(), ENABLE_TOOL_SEARCH: "true", NO_PROXY: noProxy, no_proxy: noProxy },
      args: ["--mcp-config", mcp, "--append-system-prompt", readFileSync(skillPath(), "utf8")],
    };
  } catch (e) {
    const reason = `setup failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    markDown(reason);
    return { on: false, fallback: reason };
  }
}

const trialLog = (): string => statePath("trial", "caveman.jsonl");
const trialStart = (): string => statePath("trial", "caveman-start.json");

/** Append one finished worker run. Advisory: a failed write drops the row, never the run. The first
 *  caveman run on a host records the trial's start time. */
export function recordRun(row: TrialRow): void {
  try {
    appendFileSync(trialLog(), JSON.stringify(row) + "\n");
    if (row.caveman && !existsSync(trialStart())) {
      writeFileSync(trialStart(), JSON.stringify({ startedAt: row.at, version: CAVEMAN_VERSION }) + "\n");
    }
  } catch (e) {
    console.error("orca: caveman trial row not written", e);
  }
}

/** The rows of a trial log file; a torn last line is skipped. */
export function readRows(path = trialLog()): TrialRow[] {
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  return text.split("\n").flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line) as TrialRow] : []; } catch { return []; }
  });
}

/** When the trial started on this host: the first caveman run, if any. */
export function startedAt(): number | undefined {
  try { return (JSON.parse(readFileSync(trialStart(), "utf8")) as { startedAt?: number }).startedAt; } catch { return undefined; }
}
