// The MCP lockdown (server/mcp.ts): a repo's committed `.mcp.json` never starts a browser server.
// branch-demo commits playwright and chrome-devtools; every worker started both, and Chrome
// followed (2026-10-19, load 29 on 4 cores). Every claude launch gets `--strict-mcp-config`, an
// Orca-owned `--mcp-config` with only the repo's `mcpAllow` servers minus browser ones, and
// `--disallowedTools` for the two browser servers. The last test drives the real `agent.runAgent`
// with a fake `claude` that records its argv.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import { agentCommand, oneShotCommand, prDescriptionCommand, scopedRules } from "../server/agent";
import { BANNED_MCP_TOOLS, isBrowserServer, mcpArgs, orcaMcpConfig } from "../server/mcp";
import { parseConfigDocument } from "../server/config";
import { launchOptions } from "../server/verbs";
import { freshSchema, type TestDb } from "./pg";

// branch-demo's `.mcp.json`, verbatim, plus one plain server.
const BRANCH_DEMO = {
  mcpServers: {
    playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless", "--browser", "chrome"] },
    "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest", "--headless", "--isolated", "--no-usage-statistics"] },
    docs: { command: "npx", args: ["-y", "some-docs-mcp"] },
  },
};

test("a browser server is known by its name or its package, never by words in a message", () => {
  expect(isBrowserServer("playwright", {})).toBe(true);
  expect(isBrowserServer("chrome-devtools", {})).toBe(true);
  expect(isBrowserServer("web", { command: "npx", args: ["-y", "@playwright/mcp@latest"] })).toBe(true);
  expect(isBrowserServer("dt", { command: "npx", args: ["chrome-devtools-mcp"] })).toBe(true);
  expect(isBrowserServer("x", { command: "/n/node_modules/@modelcontextprotocol/server-puppeteer/dist/index.js" })).toBe(true);
  expect(isBrowserServer("docs", BRANCH_DEMO.mcpServers.docs)).toBe(false);
  expect(isBrowserServer("notes", { command: "echo", args: ["do not use chrome-devtools-mcp here"] })).toBe(false);
});

test("the allow list: unset or empty keeps nothing, names keep only those, a browser server is never kept", () => {
  expect(orcaMcpConfig(BRANCH_DEMO, undefined)).toEqual({ mcpServers: {} });
  expect(orcaMcpConfig(BRANCH_DEMO, [])).toEqual({ mcpServers: {} });
  expect(orcaMcpConfig(BRANCH_DEMO, ["docs", "playwright", "chrome-devtools"])).toEqual({ mcpServers: { docs: BRANCH_DEMO.mcpServers.docs } });
  expect(orcaMcpConfig(BRANCH_DEMO, "all")).toEqual({ mcpServers: { docs: BRANCH_DEMO.mcpServers.docs } });
  expect(orcaMcpConfig(undefined, "all")).toEqual({ mcpServers: {} });
  expect(orcaMcpConfig({ mcpServers: [] }, "all")).toEqual({ mcpServers: {} });
});

test("a claude launch carries --strict-mcp-config, Orca's config and the browser deny rules", () => {
  const mcp = { config: { mcpServers: {} }, deny: BANNED_MCP_TOOLS };
  const argv = agentCommand("claude", "/wt/x", "go", undefined, "s-1", undefined, "bypass", undefined, undefined, undefined, mcp);
  expect(argv).toContain("--strict-mcp-config");
  expect(argv[argv.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
  expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe("mcp__playwright,mcp__chrome-devtools");
  // Each variadic option is followed by another option, and the prompt stays after `--`.
  expect(argv[argv.indexOf("--mcp-config") + 2]).toStartWith("--");
  expect(argv.slice(-2)).toEqual(["--", "go"]);
  expect(mcpArgs(mcp)).toEqual(["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']);
});

test("a scoped run gets ONE deny list: its own rules plus the browser servers", () => {
  const rules = scopedRules("/wt/feat", { baseBranch: "main" });
  const argv = agentCommand("claude", "/wt/feat", "go", undefined, "s-1", undefined, "scoped", undefined, undefined, rules, { config: { mcpServers: {} }, deny: BANNED_MCP_TOOLS });
  expect(argv.filter((a) => a === "--disallowedTools")).toHaveLength(1);
  expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe([...rules.deny, ...BANNED_MCP_TOOLS].join(","));
});

test("the claude one-shots (title, PR description) start no MCP server either", () => {
  expect(oneShotCommand("claude", "/tmp", "x", "title")).toContain("--strict-mcp-config");
  expect(prDescriptionCommand("claude", "/wt/x", "x", "s-1")).toContain("--strict-mcp-config");
});

const doc = (repo: Record<string, unknown>) => ({ repos: [{ name: "app", repoPath: "/a", worktreeRoot: "/a/.wt", baseBranch: "main", ...repo }] });

test("a repo's mcpAllow is validated and reaches every launch of that repo", () => {
  expect(parseConfigDocument(doc({ mcpAllow: "docs" })).errors).toContain("repos[0].mcpAllow must be a list of MCP server names");
  expect(parseConfigDocument(doc({ mcpAllow: ["docs", ""] })).errors).toContain("repos[0].mcpAllow must be a list of MCP server names");
  const { config, errors } = parseConfigDocument(doc({ mcpAllow: ["docs"] }));
  expect(errors).toEqual([]);
  expect(launchOptions(config!, config!.repos[0]!, "claude").mcpAllow).toEqual(["docs"]);
  const plain = parseConfigDocument(doc({})).config!;
  expect(launchOptions(plain, plain.repos[0]!, "claude").mcpAllow).toBeUndefined(); // default: no server
});

// ---- the real launch ----
let dir: string, shim: string, runtime: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};
const ENV_KEYS = ["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "XDG_RUNTIME_DIR", "ORCA_TEST_FORCE_CGROUP_LINUX"];

beforeEach(async () => {
  prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = await mkdtemp(join(tmpdir(), "orca-mcp-"));
  shim = await mkdtemp(join(tmpdir(), "orca-mcp-shim-"));
  runtime = await mkdtemp(join(tmpdir(), "orca-mcp-run-")); // no user bus: the run is unscoped
  // `claude`: one argument per line, then a clean result.
  await writeFile(join(shim, "claude"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${dir}/argv"\nprintf '{"type":"result","subtype":"success","result":"done","is_error":false}'\n`);
  await chmod(join(shim, "claude"), 0o755);
  Object.assign(process.env, { ORCA_STATE_DIR: dir, PATH: `${shim}:${prev.PATH}`, XDG_RUNTIME_DIR: runtime });
  delete process.env.ORCA_TEST_FORCE_CGROUP_LINUX;
  pg = await freshSchema("mcp");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [dir, shim, runtime]) await rm(d, { recursive: true, force: true });
});

test("a worker in a branch-demo worktree: claude gets only the allowed server, never playwright or chrome-devtools", async () => {
  const wt = join(dir, "feat");
  await mkdir(wt, { recursive: true });
  await writeFile(join(wt, ".mcp.json"), JSON.stringify(BRANCH_DEMO));
  await agent.runAgent(wt, "go", { repo: "r", branch: "feat", provider: "claude", permissionMode: "bypass", mcpAllow: ["docs", "playwright"] });
  for (let i = 0; i < 400 && !(await db.turns("r", "feat"))[0]?.finishedAt; i++) await new Promise((r) => setTimeout(r, 25));
  expect((await db.turns("r", "feat"))[0]?.response).toBe("done");
  const argv = (await readFile(join(dir, "argv"), "utf8")).split("\n");
  expect(argv).toContain("--strict-mcp-config");
  expect(JSON.parse(argv[argv.indexOf("--mcp-config") + 1]!)).toEqual({ mcpServers: { docs: BRANCH_DEMO.mcpServers.docs } });
  expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe("mcp__playwright,mcp__chrome-devtools");
});
