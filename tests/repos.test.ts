// `orca repo add` (server/repos.ts): which signed-in gh account can see the repo, and whether the
// clone target can be created at all — both found on the cloud box (see the PR this came from).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as verbs from "../server/verbs";
import { add, list } from "../server/repos";
import type { OrcaConfig } from "../server/config";
import { installFakeGh, makeScratchRepo, restorePath } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

let root: string, scratch: string, state: string;
let pg: TestDb;
const ENV_KEYS = [
  "ORCA_DEV_ROOT", "ORCA_GH_ACCOUNTS", "ORCA_GH_CLONE_SRC", "ORCA_GH_REPO_FIXTURE", "ORCA_GH_VIEW_DENY",
  "ORCA_GH_REPOLIST_FIXTURE", "ORCA_GH_ORGS_FIXTURE", "ORCA_GH_ORGREPOLIST_FIXTURE", "ORCA_DATABASE_URL",
  "ORCA_STATE_DIR",
] as const;
let prev: Record<string, string | undefined> = {};

const cfg = (): OrcaConfig => ({ repos: [], portRange: [30000, 40000], staleHours: 24 });

/** A fake `claude` ahead of PATH, answering with a plain successful one-shot result. */
async function fakeClaude(): Promise<void> {
  const shim = await mkdtemp(join(tmpdir(), "orca-repos-claude-"));
  await writeFile(join(shim, "claude"), `#!/bin/sh\nprintf '%s' '{"type":"result","subtype":"success","result":"done","is_error":false}'\n`);
  await chmod(join(shim, "claude"), 0o755);
  process.env.PATH = `${shim}:${process.env.PATH}`;
}

async function fixture(prefix: string, value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `orca-${prefix}-`));
  const path = join(dir, "fixture.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

const setViewFixture = async (obj: unknown) => { process.env.ORCA_GH_REPO_FIXTURE = await fixture("repoview", obj); };

beforeEach(async () => {
  prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  await installFakeGh();
  root = await mkdtemp(join(tmpdir(), "orca-devroot-"));
  scratch = await makeScratchRepo();
  process.env.ORCA_DEV_ROOT = root;
  process.env.ORCA_GH_CLONE_SRC = scratch;
  pg = await freshSchema("repos");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  restorePath();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test("account choice: the owner's own signed-in login is tried first and used when it can see the repo", async () => {
  process.env.ORCA_GH_ACCOUNTS = "active-login owner-login"; // active-login is first/active
  await setViewFixture({ nameWithOwner: "owner-login/widgets", defaultBranchRef: { name: "main" } });
  const repo = await add(cfg(), "owner-login/widgets");
  expect(repo.githubUser).toBe("owner-login"); // not the active account
  expect(existsSync(join(root, "widgets", ".git"))).toBe(true);
});

test("a repo added this way can be spawned on: it gets the claude provider by default", async () => {
  process.env.ORCA_GH_ACCOUNTS = "active-login";
  await setViewFixture({ nameWithOwner: "active-login/widgets", defaultBranchRef: { name: "main" } });
  const repo = await add(cfg(), "active-login/widgets");
  expect(repo.providers).toEqual(["claude"]); // the default every other repo has, not none

  await fakeClaude();
  state = await mkdtemp(join(tmpdir(), "orca-repos-state-"));
  process.env.ORCA_STATE_DIR = state;
  try {
    const { branch, worktreePath } = await verbs.createWorkstream(cfg(), repo, { prompt: "add a feature" });
    for (let i = 0; i < 400 && agent.isRunning(worktreePath); i++) await new Promise((r) => setTimeout(r, 25));
    const turns = await db.turns(repo.name, branch);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.response).toBe("done"); // never refused as "the claude agent is not enabled"
  } finally {
    agent.onRunFinished(undefined);
    await agent.flushHistory();
  }
});

test("an explicit providers choice is kept instead of the claude default", async () => {
  process.env.ORCA_GH_ACCOUNTS = "active-login";
  await setViewFixture({ nameWithOwner: "active-login/widgets", defaultBranchRef: { name: "main" } });
  const repo = await add(cfg(), "active-login/widgets", { providers: ["codex"] });
  expect(repo.providers).toEqual(["codex"]);
});

test("account choice: an org repo the active login can't see is picked up from the second login", async () => {
  process.env.ORCA_GH_ACCOUNTS = "active-login org-member"; // neither name is the org
  process.env.ORCA_GH_VIEW_DENY = "active-login"; // only org-member can see this org's repo
  await setViewFixture({ nameWithOwner: "the-org/widgets", defaultBranchRef: { name: "main" } });
  const repo = await add(cfg(), "the-org/widgets");
  expect(repo.githubUser).toBe("org-member");
  expect(existsSync(join(root, "widgets", ".git"))).toBe(true);
});

test("account choice: when no signed-in login can see the repo, add fails with a clear message", async () => {
  process.env.ORCA_GH_ACCOUNTS = "active-login org-member";
  process.env.ORCA_GH_VIEW_DENY = "active-login org-member"; // nobody can see it
  await setViewFixture({ nameWithOwner: "the-org/widgets", defaultBranchRef: { name: "main" } });
  await expect(add(cfg(), "the-org/widgets")).rejects.toThrow(/No signed-in gh account can see the-org\/widgets/);
  expect(existsSync(join(root, "widgets"))).toBe(false); // never got as far as cloning
});

test("a clone root that can't be created fails with a clear message naming the path, never sudo", async () => {
  process.env.ORCA_GH_ACCOUNTS = "active-login";
  await setViewFixture({ nameWithOwner: "active-login/widgets", defaultBranchRef: { name: "main" } });
  const readOnlyRoot = await mkdtemp(join(tmpdir(), "orca-ro-"));
  await chmod(readOnlyRoot, 0o555); // owned by us, but not writable — stands in for a root-owned /opt
  process.env.ORCA_DEV_ROOT = readOnlyRoot;
  let error: Error | undefined;
  try { await add(cfg(), "active-login/widgets"); } catch (e) { error = e as Error; }
  try {
    expect(error).toBeDefined();
    expect(error!.message).toContain(readOnlyRoot); // names the path
    expect(error!.message).toContain("not writable");
    expect(error!.message.toLowerCase()).not.toContain("sudo");
  } finally {
    await chmod(readOnlyRoot, 0o755); // so test cleanup can remove it
  }
});

test("repo list includes an account's org repos, not just the repos it owns itself", async () => {
  process.env.ORCA_GH_ACCOUNTS = "active-login";
  process.env.ORCA_GH_REPOLIST_FIXTURE = await fixture("ownrepos", [
    { nameWithOwner: "active-login/own-repo", description: null, isPrivate: false, defaultBranchRef: { name: "main" }, pushedAt: "2026-10-10T00:00:00Z" },
  ]);
  process.env.ORCA_GH_ORGS_FIXTURE = await fixture("orgs", [{ login: "the-org" }]);
  process.env.ORCA_GH_ORGREPOLIST_FIXTURE = await fixture("orgrepos", [
    { nameWithOwner: "the-org/site-templates", description: null, isPrivate: true, defaultBranchRef: { name: "main" }, pushedAt: "2026-10-15T00:00:00Z" },
  ]);
  const repos = await list(cfg());
  expect(repos.map((r) => r.nameWithOwner)).toEqual(["the-org/site-templates", "active-login/own-repo"]); // newest push first
});
