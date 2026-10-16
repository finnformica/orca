// Adding a repo to Orca from GitHub — the orchestrator's `orca repo list` / `orca repo add` and the
// `/api/repos/add` route it reaches another instance through. "Set it up" is: clone it under
// ORCA_DEV_ROOT with the account that can see it, append a RepoConfig (worktrees in `.worktrees`,
// no previews — those are a hand edit), save. Nothing a human would do differently by hand.
import { existsSync } from "fs";
import { join } from "path";
import * as db from "./db";
import { githubToken } from "./env";
import { runCmd } from "./run";
import { saveConfigDocument, type OrcaConfig, type RepoConfig } from "./config";

/** The `gh` logins signed in on this host, active one first. Parsed from `gh auth status` — it has no
 *  JSON form; the line is "Logged in to github.com account <login> (keyring)". */
export async function accounts(): Promise<string[]> {
  const { stdout, stderr } = await runCmd(["gh", "auth", "status"], { allowFail: true });
  const text = `${stdout}\n${stderr}`;
  const all = [...text.matchAll(/Logged in to \S+ account (\S+)/g)].map((m) => m[1]!);
  const active = text.match(/account (\S+) \([^)]*\)\s*\n\s*- Active account: true/)?.[1];
  return active ? [active, ...all.filter((a) => a !== active)] : all;
}

const envFor = (user?: string) => { const tok = user && githubToken(user); return tok ? { GH_TOKEN: tok } : {}; };

export type RemoteRepo = { nameWithOwner: string; defaultBranch: string; isPrivate: boolean; pushedAt: string; description: string; account: string };

/** Every repo each signed-in account can see, newest push first (bounded per account). */
export async function list(cfg: OrcaConfig, only?: string): Promise<RemoteRepo[]> {
  const users = only ? [only] : await accounts();
  const out: RemoteRepo[] = [];
  for (const user of users) {
    const { stdout } = await runCmd(["gh", "repo", "list", "--limit", "100", "--json", "nameWithOwner,description,isPrivate,defaultBranchRef,pushedAt"], { env: envFor(user) });
    for (const r of JSON.parse(stdout) as Array<{ nameWithOwner: string; description: string | null; isPrivate: boolean; defaultBranchRef: { name: string } | null; pushedAt: string }>) {
      out.push({ nameWithOwner: r.nameWithOwner, description: r.description ?? "", isPrivate: r.isPrivate, defaultBranch: r.defaultBranchRef?.name ?? "main", pushedAt: r.pushedAt, account: user });
    }
  }
  return out.sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
}

/** `orca repo list` as text: one line per repo, the ones Orca already has marked. */
export function listText(cfg: OrcaConfig, repos: RemoteRepo[], have: string[]): string {
  if (!repos.length) return "No repos visible to any signed-in gh account.";
  const known = new Set(have.map((s) => s.toLowerCase()));
  return repos.map((r) => `${known.has(r.nameWithOwner.toLowerCase()) ? "✓" : " "} ${r.nameWithOwner}  ${r.defaultBranch}${r.isPrivate ? "  private" : ""}  (${r.account})${r.description ? `  — ${r.description}` : ""}`).join("\n")
    + "\n✓ = already in Orca. Add one: orca repo add <owner/name> [--on <instance>]";
}

/** Clone `owner/name` here and add it to the config. Returns the new RepoConfig. */
export async function add(cfg: OrcaConfig, nameWithOwner: string, opts: { name?: string } = {}): Promise<RepoConfig> {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(nameWithOwner);
  if (!m) throw new Error(`"${nameWithOwner}" is not owner/name`);
  const [, owner, repoName] = m;
  const root = process.env.ORCA_DEV_ROOT;
  if (!root) throw new Error("ORCA_DEV_ROOT is not set on this instance, so there is nowhere to clone to");
  const name = (opts.name ?? repoName!).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`"${name}" is not a slug; pass --name`);
  if (cfg.repos.some((r) => r.name === name)) throw new Error(`Orca already has a repo named "${name}"`);
  // The account whose login IS the owner can see it; otherwise whoever is active.
  const logins = await accounts();
  const user = logins.find((l) => l.toLowerCase() === owner!.toLowerCase()) ?? (logins.length > 1 ? undefined : logins[0]);
  const env = envFor(user);
  const view = JSON.parse((await runCmd(["gh", "repo", "view", nameWithOwner, "--json", "nameWithOwner,defaultBranchRef"], { env })).stdout) as { nameWithOwner: string; defaultBranchRef: { name: string } | null };
  const repoPath = join(root, repoName!);
  if (existsSync(repoPath)) {
    const url = (await runCmd(["git", "-C", repoPath, "remote", "get-url", "origin"], { env, allowFail: true })).stdout.trim();
    if (!url.toLowerCase().includes(nameWithOwner.toLowerCase())) throw new Error(`${repoPath} exists and is not a clone of ${nameWithOwner}`);
  } else {
    await runCmd(["gh", "repo", "clone", nameWithOwner, repoPath], { env, timeoutMs: 10 * 60_000 });
  }
  const repo: RepoConfig = {
    name, repoPath, worktreeRoot: join(repoPath, ".worktrees"), baseBranch: view.defaultBranchRef?.name ?? "main", previewServices: [],
    ...(cfg.instances ? { runsOn: db.instanceName() } : {}),
    ...(user && user !== logins[0] ? { githubUser: user } : {}),
  };
  await saveConfigDocument({ ...cfg, repos: [...cfg.repos, repo] });
  return repo;
}
