// The MCP servers an agent Orca starts may run. A repo can commit a `.mcp.json`, and Claude Code
// starts every server in it for each session in that worktree. branch-demo's lists playwright
// (`npx @playwright/mcp --headless`) and chrome-devtools (`npx chrome-devtools-mcp --headless`), so
// every worker started two browser servers and Chrome followed: on 2026-10-19 seven of each plus
// eslint pushed load to 29 on 4 cores. A prompt ban did not stop it.
//
// So Orca owns the MCP config: every claude launch gets `--strict-mcp-config` (no project, user or
// connector servers) and `--mcp-config` with only the project servers the repo's `mcpAllow` names.
// A browser server is never kept, whatever the list says, and `--disallowedTools` denies the two
// known browser servers' tools as a second guard. orca-shot is the one way to look at a page.
import { existsSync, readFileSync } from "fs";
import { join } from "path";

/** Tool rules denied on every claude launch: every tool of these servers (`mcp__<server>`). */
export const BANNED_MCP_TOOLS = ["mcp__playwright", "mcp__chrome-devtools"];

/** Packages and binaries that are a browser server. Matched as a path segment of an argument. */
const BROWSER_SERVER = /(^|[\/@])(chrome-devtools-mcp|playwright-mcp|playwright\/mcp|puppeteer-mcp|server-puppeteer|browsermcp)([\/@.]|$)/i;
const BROWSER_NAME = /playwright|chrome-devtools|puppeteer|browser/i;

type ServerDef = { command?: unknown; args?: unknown; url?: unknown };

/** Whether an `.mcp.json` server starts or drives a browser: its name or its command says so. Pure. */
export function isBrowserServer(name: string, def: unknown): boolean {
  if (BROWSER_NAME.test(name)) return true;
  const d = (def && typeof def === "object" ? def : {}) as ServerDef;
  const words = [d.command, ...(Array.isArray(d.args) ? d.args : [])].filter((w): w is string => typeof w === "string");
  return words.some((w) => !/\s/.test(w) && BROWSER_SERVER.test(w));
}

/** `all`: every project server (the orchestrator's own cwd, which you write). Else a repo's
 *  `mcpAllow`: server names. Unset or empty: no server. */
export type McpAllow = string[] | "all";

/** The config Orca passes with `--mcp-config`: the project's servers that the allow list names,
 *  minus every browser server. Pure. */
export function orcaMcpConfig(project: unknown, allow: McpAllow | undefined): { mcpServers: Record<string, unknown> } {
  const servers = (project as { mcpServers?: unknown } | undefined)?.mcpServers;
  const out: Record<string, unknown> = {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { mcpServers: out };
  for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
    if (allow !== "all" && !allow?.includes(name)) continue;
    if (isBrowserServer(name, def)) continue;
    out[name] = def;
  }
  return { mcpServers: out };
}

/** The `.mcp.json` in `cwd`, parsed; undefined when it is missing or not JSON. */
export function readProjectMcp(cwd: string): unknown {
  const file = join(cwd, ".mcp.json");
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

/** The MCP lockdown of one claude launch in `cwd`. */
export function mcpLockdown(cwd: string, allow: McpAllow | undefined): { config: { mcpServers: Record<string, unknown> }; deny: string[] } {
  return { config: orcaMcpConfig(readProjectMcp(cwd), allow), deny: BANNED_MCP_TOOLS };
}

/** The claude argv for a lockdown. Each variadic option is followed by another option. Pure. */
export function mcpArgs(lock: { config: { mcpServers: Record<string, unknown> } }): string[] {
  return ["--strict-mcp-config", "--mcp-config", JSON.stringify(lock.config)];
}
