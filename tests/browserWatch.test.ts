// The browser watchdog (server/browserWatch.ts): every 30 s a browser or a browser MCP server in
// the agents' slice is killed, outside orca-shot's scope and the test queue's slots, and the kill is
// recorded on the workstream card and in the run's transcript. The 2026-10-19 incident: seven
// playwright-mcp and seven chrome-devtools-mcp, with Chrome children, pushed load to 29 on 4 cores.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as transcript from "../server/transcript";
import { browserProcess, isTestRunner, killStep, nextKillRecord, orphanRun, readProcs, recordKills, sweep, sweepOrphanScopes, watchVerdict, type ProcInfo } from "../server/browserWatch";
import * as lease from "../server/lease";
import { defaultScopeOwner, runScopeOf, runScopeUnit, scopeOwner } from "../server/cgroup";
import { browserKillLabel, rowStatus, BROWSER_KILL_SHOW_MS } from "../web/src/workstream";
import { freshSchema, type TestDb } from "./pg";

const RUN = "973850c8-bd60-4660-b71c-093509735372";
const SLICE = "/user.slice/user-1000.slice/user@1000.service/orca.slice/orca-agents.slice";
const inRun = `${SLICE}/orca-run-${RUN}.scope`;
const proc = (argv: string[], cgroup = inRun, comm = ""): ProcInfo => ({ pid: 4242, cgroup, argv, comm });

test("the matcher: browser binaries and browser MCP servers, never a message that names one", () => {
  expect(browserProcess(["/opt/google/chrome/chrome", "--type=renderer"])).toBe("chrome");
  expect(browserProcess(["/home/o/.cache/ms-playwright/chromium_headless_shell-1/chrome-linux/headless_shell", "--headless"])).toBe("headless_shell");
  expect(browserProcess(["/x/chrome-headless-shell", "--headless"])).toBe("chrome-headless-shell");
  expect(browserProcess(["/usr/bin/chromium"])).toBe("chromium");
  expect(browserProcess(["whatever"], "chrome-headless")).toBe("chrome-headless-shell"); // comm cut at 15
  expect(browserProcess(["npm", "exec", "chrome-devtools-mcp@latest", "--headless"])).toBe("chrome-devtools-mcp");
  expect(browserProcess(["node", "/root/.npm/_npx/1/node_modules/.bin/chrome-devtools-mcp", "--isolated"])).toBe("chrome-devtools-mcp");
  expect(browserProcess(["npm", "exec", "@playwright/mcp@latest", "--headless"])).toBe("@playwright/mcp");
  expect(browserProcess(["node", "/n/node_modules/@playwright/mcp/cli.js"])).toBe("@playwright/mcp");
  expect(browserProcess(["node", "/n/.bin/playwright-mcp"])).toBe("playwright-mcp");
  expect(browserProcess(["git", "commit", "-m", "ban chrome-devtools-mcp and @playwright/mcp"])).toBeUndefined();
  expect(browserProcess(["grep", "-r", "chrome", "src"])).toBeUndefined();
  expect(browserProcess(["bun", "test", "tests/browserWatch.test.ts"])).toBeUndefined();
  expect(browserProcess(["node", "/n/node_modules/@playwright/test/cli.js", "test"])).toBeUndefined(); // the runner itself
});

test("the verdict: only the agents' slice, never orca-shot's scope or a test-queue slot, with the run named", () => {
  expect(watchVerdict(proc(["chrome"]))).toEqual({ kill: true, name: "chrome", runId: RUN });
  expect(watchVerdict(proc(["chrome"], `${inRun}/sub`))).toEqual({ kill: true, name: "chrome", runId: RUN });
  expect(watchVerdict(proc(["chrome"], `${SLICE}/orca-heavy-ab12cd.scope`))).toEqual({ kill: false }); // the e2e slot
  expect(watchVerdict(proc(["chrome"], "/user.slice/user-1000.slice/user@1000.service/app.slice/orca-shot-2026-10-19T17-30-00-000Z-ab12cd34.scope"))).toEqual({ kill: false });
  expect(watchVerdict(proc(["chrome"], `${SLICE}/orca-shot-x.scope`))).toEqual({ kill: false });
  expect(watchVerdict(proc(["chrome"], "/system.slice/orca.service"))).toEqual({ kill: false }); // not an agent
  expect(watchVerdict(proc(["chrome"], `${SLICE}/other.scope`))).toEqual({ kill: true, name: "chrome", runId: undefined });
  expect(watchVerdict(proc(["node", "server.js"]))).toEqual({ kill: false });
  expect(watchVerdict({ ...proc(["chrome"]), pid: 7 }, 7)).toEqual({ kill: false }); // never itself
});

test("readProcs reads cgroup, cmdline and comm; a process that went away is skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "orca-proc-"));
  try {
    mkdirSync(join(root, "101"));
    writeFileSync(join(root, "101", "cgroup"), `0::${inRun}\n`);
    writeFileSync(join(root, "101", "cmdline"), "npm\0exec\0chrome-devtools-mcp@latest\0");
    writeFileSync(join(root, "101", "comm"), "npm exec chrome\n");
    writeFileSync(join(root, "101", "stat"), "101 (npm exec (x) y) S 77 101 101 0 -1\n");
    mkdirSync(join(root, "102")); // gone mid-read: no files
    mkdirSync(join(root, "self"));
    expect(readProcs(root)).toEqual([{ pid: 101, ppid: 77, cgroup: inRun, argv: ["npm", "exec", "chrome-devtools-mcp@latest"], comm: "npm exec chrome" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a sweep kills each browser once and records them per run", async () => {
  const procs: ProcInfo[] = [
    { pid: 1, cgroup: inRun, argv: ["npm", "exec", "@playwright/mcp@latest"], comm: "npm exec @playw" },
    { pid: 2, cgroup: inRun, argv: ["/x/chrome", "--headless"], comm: "chrome" },
    { pid: 3, cgroup: inRun, argv: ["node", "build.js"], comm: "node" },
    { pid: 4, cgroup: `${SLICE}/orca-heavy-1.scope`, argv: ["/x/chrome"], comm: "chrome" },
  ];
  const killed: number[] = [];
  const recorded: [string | undefined, string[]][] = [];
  const out = await sweep({ procs: () => procs, kill: (pid) => killed.push(pid), record: async (r, n) => { recorded.push([r, n]); } });
  expect(killed).toEqual([1, 2]);
  expect(out.map((k) => k.name)).toEqual(["@playwright/mcp", "chrome"]);
  expect(recorded).toEqual([[RUN, ["@playwright/mcp", "chrome"]]]);
});

test("a browser under `playwright test` is a test: kept until the test queue is installed, then only its slots", async () => {
  const procs: ProcInfo[] = [
    { pid: 10, ppid: 9, cgroup: inRun, argv: ["node", "/w/e2e/node_modules/.bin/playwright", "test", "tests/a.spec.ts", "--workers=1"], comm: "node" },
    { pid: 11, ppid: 10, cgroup: inRun, argv: ["/c/chrome-headless-shell", "--headless"], comm: "chrome-headless" },
    { pid: 12, ppid: 11, cgroup: inRun, argv: ["/c/chrome-headless-shell", "--type=renderer"], comm: "chrome-headless" },
    { pid: 20, ppid: 9, cgroup: inRun, argv: ["node", "shot.js"], comm: "node" },
    { pid: 21, ppid: 20, cgroup: inRun, argv: ["/c/chrome", "--headless"], comm: "chrome" }, // a script's own browser
  ];
  const run = async (testQueue: boolean) => { const k: number[] = []; await sweep({ procs: () => procs, testQueue: () => testQueue, kill: (p) => k.push(p) }); return k; };
  expect(await run(false)).toEqual([21]);
  expect(await run(true)).toEqual([11, 12, 21]); // the queue is here: e2e goes through its e2e slot
  expect(isTestRunner(["node", "/n/@playwright/test/cli.js", "test"])).toBe(true);
  expect(isTestRunner(["npx", "playwright", "test"])).toBe(true);
  expect(isTestRunner(["npx", "playwright", "install"])).toBe(false);
  expect(isTestRunner(["node", "server.js", "test"])).toBe(false);
});

test("the card's record adds up within a run, starts again for a new run, and shows for a day", () => {
  const t = new Date("2026-10-19T17:30:00Z");
  const a = nextKillRecord(undefined, "r1", ["chrome", "chrome-devtools-mcp"], t);
  expect(a).toEqual({ at: t.toISOString(), runId: "r1", names: ["chrome", "chrome-devtools-mcp"], count: 2 });
  expect(nextKillRecord(a, "r1", ["chrome"], t)).toMatchObject({ names: ["chrome", "chrome-devtools-mcp"], count: 3 });
  expect(nextKillRecord(a, "r2", ["chrome"], t)).toMatchObject({ runId: "r2", names: ["chrome"], count: 1 });
  expect(browserKillLabel(a, t.getTime())).toBe("Orca killed 2 browser processes this workstream started (chrome, chrome-devtools-mcp). Use orca-shot.");
  expect(browserKillLabel(a, t.getTime() + BROWSER_KILL_SHOW_MS + 1)).toBeUndefined();
  expect(browserKillLabel(undefined)).toBeUndefined();
  const row = { lane: "LOCAL", branch: "b", repo: "r", browserKilled: a } as any;
  expect(rowStatus(row, { now: t.getTime() }).reasons).toContain(browserKillLabel(a, t.getTime())!);
  expect(killStep(["chrome", "chrome"]).text).toContain("killed 2 browser processes that this run started (chrome)");
});

// ---- the record against a real database ----
let pg: TestDb;
let prev: Record<string, string | undefined> = {};
let state: string;
beforeEach(async () => {
  prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_STATE_DIR: process.env.ORCA_STATE_DIR };
  state = mkdtempSync(join(tmpdir(), "orca-bw-"));
  process.env.ORCA_STATE_DIR = state;
  pg = await freshSchema("browserwatch");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(state, { recursive: true, force: true });
});

test("recordKills flags the run's workstream and writes the warning into its transcript", async () => {
  const runId = crypto.randomUUID();
  await db.startTurn({ repo: "branch-demo", branch: "feat", runId, provider: "claude", prompt: "go", startedAt: Date.now() });
  await recordKills(runId, ["chrome-devtools-mcp", "chrome"]);
  await recordKills(runId, ["chrome"]);
  const flag = (await db.enrichment("branch-demo")).feat?.browserKilled as any;
  expect(flag).toMatchObject({ runId, names: ["chrome", "chrome-devtools-mcp"], count: 3 });
  const steps = await transcript.read(runId);
  expect(steps).toHaveLength(2);
  expect(steps[0]!.text).toContain("⚠ Orca killed 2 browser processes that this run started (chrome, chrome-devtools-mcp)");
  await recordKills(crypto.randomUUID(), ["chrome"]); // no turn behind it: nothing to flag, no throw
  await recordKills(undefined, ["chrome"]);
});

// On this box an agent's own shell is in orca-agents.slice: a real process named `chrome` there is
// killed. Only that one pid is looked at, so nothing else on the box is touched.
const ownCgroup = (() => { try { return readFileSync("/proc/self/cgroup", "utf8"); } catch { return ""; } })();
// Under the test queue (`bun test` through orca-run) the test is in an exempt `orca-heavy-` scope.
const inRunScope = ownCgroup.includes("/orca-agents.slice/") && runScopeOf(ownCgroup) !== undefined && !/\/orca-(shot|heavy)-/.test(ownCgroup);
test.skipIf(!inRunScope)("a real `chrome` process in an agent's scope is killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-bw-bin-"));
  try {
    copyFileSync("/bin/sleep", join(dir, "chrome"));
    Bun.spawnSync(["chmod", "+x", join(dir, "chrome")]);
    const child = Bun.spawn([join(dir, "chrome"), "60"], { stdout: "ignore", stderr: "ignore" });
    await new Promise((r) => setTimeout(r, 100));
    const out = await sweep({ procs: () => readProcs().filter((p) => p.pid === child.pid) });
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("chrome");
    expect(await child.exited).not.toBe(0);
    expect(child.signalCode).toBe("SIGKILL");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- orphan run scopes (2026-10-19: six fake claudes of a test looped in real run scopes) ----
// 2026-10-23: a test bridge with its own state dir killed the live bridge's workers. A run scope's
// unit names its owner (`orca-run-<owner>-<runId>`, the owner a hash of the state dir).
const OTHER = "0b7a2f4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
/** A run scope of THIS test's state dir (set in beforeEach), so call it inside a test. */
const own = (runId: string) => `${SLICE}/${runScopeUnit(runId)}.scope`;

test("a run scope's unit names its owner; an untagged one belongs to ~/.orca", () => {
  expect(scopeOwner("/a/state")).toMatch(/^[0-9a-f]{12}$/);
  expect(scopeOwner("/a/state")).toBe(scopeOwner("/a/state/"));
  expect(scopeOwner("/a/state")).not.toBe(scopeOwner("/b/state"));
  expect(runScopeUnit(OTHER, "abcdef123456")).toBe(`orca-run-abcdef123456-${OTHER}`);
  expect(runScopeOf(`${SLICE}/orca-run-abcdef123456-${OTHER}.scope/sub`)).toEqual({ runId: OTHER, owner: "abcdef123456" });
  expect(runScopeOf(`${SLICE}/orca-run-${OTHER}.scope`)).toEqual({ runId: OTHER, owner: defaultScopeOwner() });
  expect(runScopeOf(`${SLICE}/orca-heavy-1.scope`)).toBeUndefined();
});

test("an orphan is a process in a run scope of this bridge's owner in the agents' slice that no lease names", () => {
  const known = new Set([RUN]);
  const inOther = own(OTHER);
  expect(orphanRun(proc(["sh", "claude"], inOther), known)).toBe(OTHER);
  expect(orphanRun(proc(["sh", "claude"], `${inOther}/sub`), known)).toBe(OTHER);
  expect(orphanRun(proc(["sh", "claude"], own(RUN)), known)).toBeUndefined(); // leased
  expect(orphanRun(proc(["sh"], `${SLICE}/orca-heavy-1.scope`), known)).toBeUndefined(); // a queue slot
  expect(orphanRun(proc(["sh"], `/system.slice/${runScopeUnit(OTHER)}.scope`), known)).toBeUndefined(); // not the agents' slice
  expect(orphanRun({ ...proc(["sh"], inOther), pid: 7 }, known, 7)).toBeUndefined(); // never itself
  // Another bridge's scope (another state dir) is never an orphan here, leased or not.
  expect(orphanRun(proc(["sh"], `${SLICE}/${runScopeUnit(OTHER, scopeOwner("/other/state"))}.scope`), known)).toBeUndefined();
  // An untagged scope (older code) is the default state dir's: only that bridge may stop it.
  expect(orphanRun(proc(["sh"], `${SLICE}/orca-run-${OTHER}.scope`), known)).toBeUndefined();
  expect(orphanRun(proc(["sh"], `${SLICE}/orca-run-${OTHER}.scope`), known, process.pid, defaultScopeOwner())).toBe(OTHER);
});

test("an orphan scope is killed on the second pass that sees it; a run leased in between is kept; no lease read kills nothing", () => {
  const inOther = own(OTHER), inRun = own(RUN);
  const procs: ProcInfo[] = [
    { pid: 1, cgroup: inOther, argv: ["/bin/sh", "/opt/orca/bin/worker/bun", "/tmp/x/claude"], comm: "sh" },
    { pid: 2, cgroup: `${inOther}/sub`, argv: ["sleep", "60"], comm: "sleep" },
    { pid: 3, cgroup: inRun, argv: ["claude"], comm: "claude" },
  ];
  const killed: number[] = [];
  const suspects = new Set<string>();
  const pass = (known: Set<string> | undefined) => sweepOrphanScopes({ procs: () => procs, known: () => known, kill: (p) => killed.push(p), suspects });
  expect(pass(new Set([RUN]))).toEqual([]); // first sight: a launch may not have its lease yet
  expect(pass(new Set([RUN]))).toEqual([{ pid: 1, runId: OTHER }, { pid: 2, runId: OTHER }]);
  expect(killed).toEqual([1, 2]);
  // Seen once, then its lease appears: kept.
  killed.length = 0;
  suspects.clear();
  pass(new Set([RUN]));
  expect(pass(new Set([RUN, OTHER]))).toEqual([]);
  // The leases can't be read: nothing is killed, and nothing is a suspect after.
  pass(new Set([RUN]));
  expect(pass(undefined)).toEqual([]);
  expect(pass(new Set([RUN]))).toEqual([]);
  expect(killed).toEqual([]);
});

test("knownRunIds reads every lease file here, and refuses when one can't be read", () => {
  expect(lease.knownRunIds()).toEqual(new Set()); // no leases dir yet
  lease.acquire({ key: "/w/a", worktreePath: "/w/a", provider: "claude", runId: RUN, pid: process.pid, startedAt: Date.now() });
  lease.acquire({ key: "/w/b", worktreePath: "/w/b", provider: "claude", runId: OTHER, pid: 999_999_999, startedAt: 0, timeoutMs: 1 }); // dead and expired: still named
  expect(lease.knownRunIds()).toEqual(new Set([RUN, OTHER]));
  writeFileSync(join(state, "leases", "bad.json"), "{not json");
  expect(lease.knownRunIds()).toBeUndefined();
});

test("a real process in an orphan scope dies; a leased run's process is kept", async () => {
  const orphan = Bun.spawn(["sleep", "30"]);
  const leased = Bun.spawn(["sleep", "30"]);
  try {
    lease.acquire({ key: "/w/leased", worktreePath: "/w/leased", provider: "claude", runId: RUN, pid: leased.pid, startedAt: Date.now() });
    const inOther = own(OTHER), inRun = own(RUN);
    const procs = (): ProcInfo[] => [
      { pid: orphan.pid, cgroup: inOther, argv: ["sleep", "30"], comm: "sleep" },
      { pid: leased.pid, cgroup: inRun, argv: ["sleep", "30"], comm: "sleep" },
    ];
    const suspects = new Set<string>();
    sweepOrphanScopes({ procs, suspects });
    sweepOrphanScopes({ procs, suspects });
    expect(await orphan.exited).not.toBe(0);
    expect(leased.exitCode).toBeNull();
  } finally {
    orphan.kill("SIGKILL");
    leased.kill("SIGKILL");
  }
});
