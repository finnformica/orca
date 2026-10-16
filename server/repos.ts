// Adding a repo to Orca from GitHub — the orchestrator's `orca repo list` / `orca repo add` and the
// `/api/repos/add` route it reaches another instance through. "Set it up" is: clone it under
// ORCA_DEV_ROOT with the account that can see it, append a RepoConfig (worktrees in `.worktrees`,
// no previews — those are a hand edit), save. Nothing a human would do differently by hand.
import { existsSync } from "fs";
import { join } from "path";
import * as db from "./db";
import { githubIdentity, githubToken } from "./env";
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

export type AccountRow = { login: string; active: boolean; name?: string; email?: string; configured: { name?: string; email?: string }; repos: string[] };

/** The GitHub page's rows for THIS host: each signed-in `gh` login, whether it is the active one, its
 *  effective commit identity and the config's part of it, and the repos that use it (a repo with no
 *  `githubUser` uses the active login). */
export function accountRows(cfg: OrcaConfig, logins: string[], identity: (login: string) => { name?: string; email?: string }): AccountRow[] {
  return logins.map((login, i) => ({
    login, active: i === 0, ...identity(login), configured: cfg.githubAccounts?.[login] ?? {},
    repos: cfg.repos.filter((r) => (r.githubUser ?? logins[0]) === login).map((r) => r.name),
  }));
}

/** The `githubAccounts` map with one login's name / email set (trimmed) or, with "", cleared; a login
 *  left with no field is dropped, and an empty map is undefined. Pure — `setAccount` saves it. */
export function withAccount(all: OrcaConfig["githubAccounts"], login: string, fields: { name?: string; email?: string }): OrcaConfig["githubAccounts"] {
  if (!/^[\w.-]+$/.test(login)) throw new Error("login required");
  const next = { ...all?.[login] };
  for (const k of ["name", "email"] as const) if (fields[k] !== undefined) { if (fields[k]!.trim()) next[k] = fields[k]!.trim(); else delete next[k]; }
  const out = { ...all, [login]: next };
  if (!Object.keys(next).length) delete out[login];
  return Object.keys(out).length ? out : undefined;
}

/** Set (or with "" clear) the configured name / email of one login — the rest of the document untouched. */
export async function setAccount(cfg: OrcaConfig, login: string, fields: { name?: string; email?: string }): Promise<void> {
  await saveConfigDocument({ ...cfg, githubAccounts: withAccount(cfg.githubAccounts, login, fields) });
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

/** This host's accounts with their identities, for `/api/github/accounts`. The identity needs the
 *  token; a login whose token can't be read shows the config's fields alone. */
export async function accountsHere(cfg: OrcaConfig): Promise<AccountRow[]> {
  return accountRows(cfg, await accounts(), (login) => {
    const tok = githubToken(login);
    const id = tok ? githubIdentity(login, tok) : {};
    const c = cfg.githubAccounts?.[login];
    return { name: c?.name ?? id.name, email: c?.email ?? id.email };
  });
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
