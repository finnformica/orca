// Scoped mode (agent.scopedRules): the permission mode of a workstream an outside sender's "work"
// grant started or steered. `claude -p --permission-mode dontAsk` plus allow and deny rules — never
// bypassPermissions, which approves everything so an allow list under it restricts nothing. The
// real CLI's behaviour (an allowed Edit and git commit run; `cat /opt/orca/.env`, a Read of ~/.ssh
// and `git commit --no-verify` are denied) was checked by hand with a headless haiku run (PR body);
// here a fake `claude` records its argv, commits, and reports a denial the way the CLI does.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import { agentCommand, denials, scopedRules } from "../server/agent";
import { launchOptions } from "../server/verbs";
import type { OrcaConfig, RepoConfig } from "../server/config";
import { effectiveGrant, grantRefusal } from "../shared/integrations";
import { grantScopeLabel, workerEvent } from "../web/src/workstream";
import { makeScratchRepo } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

const git = async (cwd: string, ...args: string[]) => (await Bun.$`git -C ${cwd} ${args}`.quiet()).stdout.toString();
const work = { level: "work" as const, repos: ["r"], linkId: "L1" };

describe("decisions (pure)", () => {
  test("the rules: files in the worktree, git and the toolchain; no secrets, no --no-verify, no push to base", () => {
    const r = scopedRules("/wt/feat", { baseBranch: "main", checkCommand: "make check", home: "/home/u", stateDir: "/home/u/.orca", orcaRoots: ["/srv/orca"] });
    expect(r.allow).toEqual(expect.arrayContaining([
      "Read(//wt/feat/**)", "Edit(//wt/feat/**)", "Write(//wt/feat/**)", "Glob", "Grep",
      "Bash(git *)", "Bash(bun *)", "Bash(pnpm *)", "Bash(npm *)", "Bash(npx *)", "Bash(node *)", "Bash(orca-shot *)", "Bash(make check)",
    ]));
    expect(r.allow.some((a) => a.startsWith("Bash(cat") || a === "Bash" || a === "Read" || a === "Edit")).toBe(false);
    expect(r.deny).toEqual(expect.arrayContaining([
      "Bash(git *--no-verify*)", "Bash(git commit -n*)", "Bash(git -c *)", "Bash(git config *)",
      "Bash(git push * main)", "Bash(git push *:main)", "Bash(git push *:refs/heads/main*)",
      "Bash(git -C * push *:main)", "Bash(git -C * push * main)", "Bash(git -C * commit -n*)", "Bash(git -C * config *)",
      "Read(//opt/orca/.env)", "Read(//srv/orca/.env)", "Read(~/.ssh/**)", "Edit(~/.ssh/**)", "Read(~/.config/gh/**)",
      "Read(//home/u/.orca/secrets/**)", "Read(~/.hydra/**)",
    ]));
    expect(r.addDirs).toEqual(["/home/u/.orca/attachments"]); // attachments are materialised there
    expect(scopedRules("/wt", { checkCommand: "a, b" }).allow.some((a) => a.includes("a, b"))).toBe(false); // a comma would split the list
  });

  test("the argv: dontAsk, the settings that block reads outside the worktree, never bypassPermissions", () => {
    const rules = scopedRules("/wt/feat", { baseBranch: "main" });
    const argv = agentCommand("claude", "/wt/feat", "go", undefined, "s-1", "claude-haiku-4-5", "scoped", undefined, undefined, rules);
    expect(argv).not.toContain("bypassPermissions");
    expect(argv.slice(1, 5)).toEqual(["-p", "--permission-mode", "dontAsk", "--settings"]);
    expect(JSON.parse(argv[5]!)).toEqual({ permissions: { blockReadsOutsideWorkingDirectories: true } });
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(rules.allow.join(","));
    expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe(rules.deny.join(","));
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe(rules.addDirs[0]);
    expect(argv.slice(-2)).toEqual(["--", "go"]);
    // The owner's own chat is unchanged.
    expect(agentCommand("claude", "/wt/feat", "go", undefined, "s-1", undefined, "bypass")).toContain("bypassPermissions");
  });

  test("denied tool calls: parsed off the result event, listed in the worker report", () => {
    const d = denials({ permission_denials: [
      { tool_name: "Bash", tool_input: { command: "cat /opt/orca/.env" } },
      { tool_name: "Read", tool_input: { file_path: "/home/u/.ssh/id_rsa" } },
    ] });
    expect(d).toEqual(["Bash: cat /opt/orca/.env", "Read: /home/u/.ssh/id_rsa"]);
    expect(agent.parseRunMeta({ permission_denials: [] }).permissionDenials).toBeUndefined();
    const text = workerEvent({ repo: "r", branch: "feat", runId: "x", status: "done", response: "ok", denied: d });
    expect(text).toContain("Denied tool calls (scoped mode — tell the user if the work needs them):\n- Bash: cat /opt/orca/.env\n- Read: /home/u/.ssh/id_rsa");
    expect(workerEvent({ repo: "r", branch: "feat", runId: "x", status: "done", response: "ok" })).not.toContain("Denied");
  });

  test("the card says who started it and that it is scoped; your own work says nothing", () => {
    expect(grantScopeLabel({ level: "work", by: "Saajan", via: "discord" })).toBe("started from Discord by Saajan, scoped mode");
    expect(grantScopeLabel({ level: "work" })).toBe("started from outside Orca, scoped mode");
    expect(grantScopeLabel(undefined)).toBeUndefined();
  });

  test("--clear-grant is the owner's; the link stays the ceiling of a person's level", () => {
    expect(grantRefusal(work, "status", { repo: "r" })).toBeUndefined();
    expect(grantRefusal(work, "status", { repo: "r", "clear-grant": "" })).toContain("needs your own chat");
    expect(grantRefusal(undefined, "status", { repo: "r", "clear-grant": "" })).toBeUndefined();
    expect(grantRefusal(work, "merge", { repo: "r" })).toContain('needs "admin"'); // work queues only with --when-green
    expect(effectiveGrant({ id: "L1", level: "work", repos: ["r"] }, { id: "finn", maxLevel: "full" }).level).toBe("work");
  });
});

describe("a work grant's run (fake claude, real git and Postgres)", () => {
  let state: string, shim: string, repo: string, pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  beforeEach(async () => {
    prev = { ORCA_STATE_DIR: process.env.ORCA_STATE_DIR, ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, PATH: process.env.PATH };
    state = await mkdtemp(join(tmpdir(), "orca-scoped-"));
    shim = await mkdtemp(join(tmpdir(), "orca-claude-"));
    repo = await makeScratchRepo();
    process.env.ORCA_STATE_DIR = state;
    process.env.PATH = `${shim}:${prev.PATH}`;
    pg = await freshSchema("scoped");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
  });
  afterEach(async () => {
    await agent.flushHistory();
    await db.close();
    await pg.drop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const d of [state, shim, repo]) await rm(d, { recursive: true, force: true });
  });

  test("a spawn under a work grant runs scoped, commits on its branch, and reports what was denied", async () => {
    // The fake records its argv, commits, and — as the real CLI does under these rules — refuses
    // `cat /opt/orca/.env`, which it reports as a permission denial.
    await writeFile(join(shim, "claude"), `#!/bin/sh
printf '%s\\n' "$@" > "${state}/argv"
echo work > work.txt && git add work.txt && git commit -q -m "agent work"
printf '{"type":"result","subtype":"success","result":"Done.","is_error":false,"permission_denials":[{"tool_name":"Bash","tool_input":{"command":"cat /opt/orca/.env"}}]}'
`);
    await chmod(join(shim, "claude"), 0o755);
    const cfg = {} as OrcaConfig;
    const repoCfg = { name: "r", repoPath: repo, baseBranch: "main", agentPermissionMode: "bypass", checkCommand: "true" } as RepoConfig;
    const before = (await git(repo, "rev-parse", "HEAD")).trim();
    await agent.runAgent(repo, "do it", {
      ...launchOptions(cfg, repoCfg, "claude", "claude-haiku-4-5", { orchestrated: true, grantScope: work }),
      branch: "feat", instruction: "do it",
    });
    for (let i = 0; i < 400 && agent.isRunning(repo); i++) await new Promise((r) => setTimeout(r, 25));
    const argv = (await readFile(join(state, "argv"), "utf8")).split("\n");
    expect(argv).toContain("dontAsk");
    expect(argv).not.toContain("bypassPermissions"); // the repo says bypass; the grant wins
    expect(argv[argv.indexOf("--allowedTools") + 1]).toContain(`Edit(/${repo}/**)`);
    expect(argv[argv.indexOf("--disallowedTools") + 1]).toContain("Read(//opt/orca/.env)");
    expect((await git(repo, "rev-parse", "HEAD")).trim()).not.toBe(before); // the work got done
    expect(agent.status(repo).meta?.permissionDenials).toEqual(["Bash: cat /opt/orca/.env"]);
  });

  test("a scoped run refuses a provider with no tool rules", async () => {
    await expect(agent.runAgent(repo, "do it", { provider: "codex", permissionMode: "scoped", repo: "r", branch: "feat" })).rejects.toThrow("needs a Claude model");
  });
});
