// A repo pinned to a gh account (RepoConfig.githubUser) gets that account's token as GH_TOKEN in
// every process Orca runs under its paths — gh, git, agents, previews — and nothing else does.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { githubEnv, setGithubAccounts } from "../server/env";
import { runCmd } from "../server/run";
import { parseConfigDocument } from "../server/config";
import { repoLabel } from "../web/src/workstream";
import { installFakeGh, restorePath } from "./helpers";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "orca-ghacct-")); await installFakeGh(); });
afterEach(() => { restorePath(); setGithubAccounts([]); });

test("GH_TOKEN follows the repo: its path and worktrees get the pinned account's token, other paths nothing", async () => {
  const personal = { repoPath: join(root, "hydra"), worktreeRoot: join(root, "hydra-wt"), githubUser: "finn-personal" };
  const work = { repoPath: join(root, "app"), worktreeRoot: join(root, "app", ".worktrees") };
  setGithubAccounts([personal, work]);
  // Identity rides along: the profile's name, and GitHub's noreply address when the email is private.
  const id = { GIT_AUTHOR_NAME: "Finn P", GIT_COMMITTER_NAME: "Finn P", GIT_AUTHOR_EMAIL: "4242+finn-personal@users.noreply.github.com", GIT_COMMITTER_EMAIL: "4242+finn-personal@users.noreply.github.com" };
  expect(githubEnv(personal.repoPath)).toEqual({ GH_TOKEN: "tok-finn-personal", ...id });
  expect(githubEnv(join(personal.worktreeRoot, "feature-x"))).toEqual({ GH_TOKEN: "tok-finn-personal", ...id });
  expect(githubEnv(join(root, "hydra-other"))).toEqual({}); // a prefix match is on path segments, not strings
  expect(githubEnv(work.repoPath)).toEqual({});
  expect(githubEnv(undefined)).toEqual({});
  // runCmd lays it in by cwd (git.ts's `git -C <repo>` with no cwd is matched on that path the same way).
  await mkdir(join(personal.worktreeRoot, "f"), { recursive: true });
  expect((await runCmd(["sh", "-c", 'printf %s "$GH_TOKEN"'], { cwd: join(personal.worktreeRoot, "f") })).stdout).toBe("tok-finn-personal");
  expect((await runCmd(["sh", "-c", 'printf %s "$GH_TOKEN"'], { cwd: root })).stdout).toBe("");
  // A commit in a pinned repo carries that identity, whatever the global git config says.
  await runCmd(["git", "init", "-q", personal.repoPath]);
  await runCmd(["git", "-C", personal.repoPath, "commit", "-q", "--allow-empty", "-m", "x"]);
  expect((await runCmd(["git", "-C", personal.repoPath, "log", "-1", "--format=%an <%ae>"])).stdout.trim()).toBe("Finn P <4242+finn-personal@users.noreply.github.com>");
  // The config's fields win over the profile's.
  setGithubAccounts([personal, work], { "finn-personal": { email: "finn@home.example" } });
  expect(githubEnv(personal.repoPath)).toMatchObject({ GIT_AUTHOR_NAME: "Finn P", GIT_AUTHOR_EMAIL: "finn@home.example" });
});

test("githubUser is validated as a login; the switcher prefixes owners only when repos span more than one", () => {
  const base = { repoPath: "/x/r", worktreeRoot: "/x/r/.worktrees", baseBranch: "main", previewServices: [] };
  expect(parseConfigDocument({ repos: [{ name: "r", ...base, githubUser: "finnformica" }] }).errors).toEqual([]);
  expect(parseConfigDocument({ repos: [{ name: "r", ...base, githubUser: "not a login" }] }).errors.join()).toContain("githubUser");
  expect(parseConfigDocument({ repos: [{ name: "r", ...base }], githubAccounts: { finnformica: { email: "f@x.y" } } }).errors).toEqual([]);
  expect(parseConfigDocument({ repos: [{ name: "r", ...base }], githubAccounts: { finnformica: "f@x.y" } }).errors.join()).toContain("githubAccounts");
  const one = [{ name: "orca", owner: "finnformicaflow" }, { name: "branch-demo", owner: "finnformicaflow" }];
  expect(repoLabel(one, "orca")).toBe("orca");
  const two = [...one, { name: "claude-hydra", owner: "finnformica" }];
  expect(repoLabel(two, "orca")).toBe("finnformicaflow/orca");
  expect(repoLabel(two, "claude-hydra")).toBe("finnformica/claude-hydra");
  expect(repoLabel([...two, { name: "local-only" }], "local-only")).toBe("local-only");
});
