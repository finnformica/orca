// A git hook exports GIT_DIR. A suite started from a hook in a linked worktree once ran
// makeScratchRepo() against the MAIN clone: `git init <dir>` re-initialised the hook's repo
// (core.bare=true, the scratch identity in its config) and `git -C <dir> commit` put a scratch
// "init" commit over the worker's branch. Here a decoy has that exact shape (a main clone plus a
// linked worktree, GIT_DIR = its gitdir) and must come through the scratch helpers and the worktree
// ops untouched. The preload (tests/env.ts) refuses to start a suite with the variables set at all.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GIT_REPO_VARS, inheritedGitRepoVars, scrubbedEnv } from "../server/env";
import { createWorktree, removeWorktree } from "../server/git";
import { run } from "../server/run";
import { makeScratchRepo } from "./helpers";

const ROOT = join(import.meta.dir, "..");
const saved: Record<string, string | undefined> = Object.fromEntries(GIT_REPO_VARS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of GIT_REPO_VARS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

/** A main clone with a linked worktree on `feat`, made before any GIT_* is set. */
async function decoy(): Promise<{ main: string; wt: string; gitdir: string }> {
  const main = await makeScratchRepo();
  const wt = join(mkdtempSync(join(tmpdir(), "orca-decoy-wt-")), "wt");
  await run(["git", "-C", main, "worktree", "add", "-b", "feat", wt]);
  return { main, wt, gitdir: join(main, ".git", "worktrees", "wt") };
}

/** What the incident changed: the shared config, every ref, and the worktree's index. */
async function snapshot(d: { main: string; gitdir: string }): Promise<string> {
  // Its own env with only PATH, so the snapshot does not depend on the fix under test.
  const proc = Bun.spawn(["git", "-C", d.main, "for-each-ref", "--format=%(refname) %(objectname)"], { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe" });
  const refs = await new Response(proc.stdout).text();
  return [readFileSync(join(d.main, ".git", "config"), "utf8"), refs, readFileSync(join(d.gitdir, "index")).toString("base64")].join("\n--\n");
}

test("scrubbedEnv drops every inherited repo pointer, and a caller may still set one", () => {
  for (const k of GIT_REPO_VARS) process.env[k] = "/decoy";
  const env = scrubbedEnv();
  for (const k of GIT_REPO_VARS) expect(env[k]).toBeUndefined();
  expect(scrubbedEnv({ GIT_DIR: "/named" }).GIT_DIR).toBe("/named");
  expect(inheritedGitRepoVars()).toEqual([...GIT_REPO_VARS]);
  expect(inheritedGitRepoVars({})).toEqual([]);
});

test("with a hook's GIT_DIR on a decoy, the scratch helpers and worktree ops leave the decoy untouched", async () => {
  const d = await decoy();
  const before = await snapshot(d);
  process.env.GIT_DIR = d.gitdir; // exactly what git exports to a hook run in the linked worktree
  process.env.GIT_WORK_TREE = d.wt;
  process.env.GIT_INDEX_FILE = join(d.gitdir, "index");

  const scratch = await makeScratchRepo();
  writeFileSync(join(scratch, "two.txt"), "2\n");
  await run(["git", "-C", scratch, "add", "."]);
  await run(["git", "-C", scratch, "commit", "-m", "two"]);
  const { worktreePath } = await createWorktree(scratch, mkdtempSync(join(tmpdir(), "orca-decoy-root-")), "orca/x", "main");
  await removeWorktree(scratch, worktreePath);

  expect(await snapshot(d)).toBe(before);
  expect(readFileSync(join(d.main, ".git", "config"), "utf8")).not.toContain("bare = true");
  // The scratch repo got its own repository and both commits.
  expect(existsSync(join(scratch, ".git", "HEAD"))).toBe(true);
  expect((await run(["git", "-C", scratch, "log", "--format=%s", "main"])).trim().split("\n")).toEqual(["two", "init"]);
});

test("bun test refuses to start with GIT_DIR set", () => {
  const p = Bun.spawnSync([process.execPath, "test", "tests/favicon.test.ts"], {
    cwd: ROOT, env: { ...process.env, GIT_DIR: "/nonexistent/decoy.git", ORCA_RUN_SLOT: "1" } as Record<string, string>, stdout: "pipe", stderr: "pipe",
  });
  expect(p.exitCode).not.toBe(0);
  expect(p.stderr.toString()).toContain("bun test refuses to start: GIT_DIR set");
});
