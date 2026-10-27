// `orca-shot --preview`: find the remote preview of a workstream's open PR, wait until it is ready,
// and hand the screenshot queue a URL plus the login to use. It starts no local service. The rules
// are pure in shared/remotePreview.ts; this file is the I/O around them — GitHub reads (through
// server/github.ts, so ETags make the poll cheap), the wait, and the secret store for the login.
import * as github from "./github";
import * as secrets from "./secrets";
import { runCmd } from "./run";
import type { OrcaConfig, RepoConfig } from "./config";
import {
  DEFAULT_WAIT_MINUTES, checkOrCommentVerdict, deploymentVerdict, previewAnswered, templateVerdict,
  type CheckRun, type CommitStatus, type Deployment, type DeploymentStatus, type IssueComment,
  type PreviewLogin, type PreviewTarget, type RemotePreviewConfig, type Verdict,
} from "../shared/remotePreview";

export class RemotePreviewError extends Error { constructor(m: string) { super(m); this.name = "RemotePreviewError"; } }

/** The repo a request is about: by name (a worker's ORCA_REPO), else the one whose checkout or
 *  worktree root holds `cwd`. */
export function repoFor(cfg: Pick<OrcaConfig, "repos">, by: { repo?: string; cwd?: string }): RepoConfig | undefined {
  if (by.repo) return cfg.repos.find((r) => r.name === by.repo);
  const cwd = by.cwd?.replace(/\/+$/, "");
  if (!cwd) return undefined;
  const under = (root: string) => !!root && (cwd === root.replace(/\/+$/, "") || cwd.startsWith(`${root.replace(/\/+$/, "")}/`));
  // A worktree root often sits inside the repo (`.worktrees`), so the worktree root wins.
  return cfg.repos.find((r) => under(r.worktreeRoot)) ?? cfg.repos.find((r) => under(r.repoPath));
}

type Pr = { number: number; state: string; head: { sha: string; ref: string } };
type Rest = <T = any>(path: string) => Promise<T>;

export type ResolveDeps = {
  /** A GitHub client for the repo (`github.forRepo`). */
  client?: (cwd: string) => Promise<{ owner: string; name: string; rest: Rest }>;
  /** `git rev-parse HEAD` / the branch at `cwd`. */
  git?: (cwd: string, args: string[]) => Promise<string | undefined>;
  /** HTTP status of a GET to `url` (0: no answer). For the template source's readiness check. */
  probe?: (url: string) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
};

export type Resolved = { url: string; from: string; pr: number; sha: string; branch: string };

const defaultGit = async (cwd: string, args: string[]) => {
  const r = await runCmd(["git", "-C", cwd, ...args], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() || undefined : undefined;
};
const defaultProbe = async (url: string) => {
  try { return (await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) })).status; } catch { return 0; }
};

/** Find the PR, then poll its preview until it is ready, it failed, the wait ran out or `signal`
 *  aborted. `onWait` hears each new reason it is still waiting. Throws a RemotePreviewError with a
 *  message for the worker. */
export async function resolvePreview(
  repo: RepoConfig,
  req: { cwd?: string; branch?: string; pr?: number; maxWaitMs?: number },
  opts: { signal?: AbortSignal; onWait?: (why: string) => void } = {},
  deps: ResolveDeps = {},
): Promise<Resolved> {
  const cfg = repo.remotePreview;
  if (!cfg) throw new RemotePreviewError(`repo ${repo.name} has no remotePreview in Orca's config: shoot a URL instead (orca-shot <url>)`);
  const git = deps.git ?? defaultGit;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 15_000;
  const cwd = req.cwd ?? repo.repoPath;
  const gh = await (deps.client ?? github.forRepo)(cwd);
  const branch = req.branch ?? (req.pr ? undefined : await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
  if (!req.pr && (!branch || branch === "HEAD")) throw new RemotePreviewError("no branch: run orca-shot --preview in the workstream's worktree, or pass --pr N");

  const findPr = async (): Promise<Pr> => {
    if (req.pr) {
      const pr = await gh.rest<Pr>(`{repo}/pulls/${req.pr}`).catch((e) => { throw new RemotePreviewError(`no PR #${req.pr}: ${(e as Error).message}`); });
      if (pr.state !== "open") throw new RemotePreviewError(`PR #${req.pr} is ${pr.state}: its preview is gone or stale`);
      return pr;
    }
    const prs = await gh.rest<Pr[]>(`{repo}/pulls?state=open&head=${encodeURIComponent(`${gh.owner}:${branch}`)}`);
    if (!prs?.length) throw new RemotePreviewError(`no open PR for branch ${branch}: push the branch and open a (draft) PR first — the preview deploys from the PR`);
    return prs[0]!;
  };

  let pr = await findPr();
  // The preview shows what was pushed. A worktree ahead of its PR would get a shot of older code.
  if (!req.pr && req.cwd) {
    const head = await git(req.cwd, ["rev-parse", "HEAD"]);
    if (head && head !== pr.head.sha) {
      throw new RemotePreviewError(`PR #${pr.number} head is ${pr.head.sha.slice(0, 7)} but this worktree is at ${head.slice(0, 7)}: push first, then shoot the preview`);
    }
  }

  const deadline = now() + Math.min(req.maxWaitMs ?? Infinity, (cfg.waitMinutes ?? DEFAULT_WAIT_MINUTES) * 60_000);
  let lastWhy = "";
  for (;;) {
    if (opts.signal?.aborted) throw new RemotePreviewError("cancelled");
    const target: PreviewTarget = { pr: pr.number, branch: pr.head.ref, sha: pr.head.sha, owner: gh.owner, repo: gh.name };
    let v = await verdict(cfg, target, gh.rest);
    if (v.state === "ready" && cfg.source === "template" && !previewAnswered(await (deps.probe ?? defaultProbe)(v.url))) {
      v = { state: "waiting", why: `${v.url} does not answer yet` };
    }
    if (v.state === "ready") return { url: v.url, from: v.from, pr: pr.number, sha: pr.head.sha, branch: pr.head.ref };
    if (v.state === "failed") throw new RemotePreviewError(`preview for PR #${pr.number}: ${v.why}`);
    if (v.why !== lastWhy) opts.onWait?.(v.why);
    lastWhy = v.why;
    if (now() + pollMs > deadline) {
      throw new RemotePreviewError(`timed out waiting for the preview of PR #${pr.number} (${pr.head.sha.slice(0, 7)}): ${v.why}`);
    }
    await sleep(pollMs);
    pr = await findPr(); // a push while waiting moves the target to the new head
  }
}

/** One look at the source, for the PR's head commit. */
export async function verdict(cfg: RemotePreviewConfig, t: PreviewTarget, rest: Rest): Promise<Verdict> {
  if (cfg.source === "template") return templateVerdict(cfg, t);
  if (cfg.source === "github-deployment") {
    const env = cfg.environment ? `&environment=${encodeURIComponent(cfg.environment)}` : "";
    const deployments = (await rest<Deployment[]>(`{repo}/deployments?sha=${t.sha}${env}&per_page=30`)) ?? [];
    const statuses: Record<number, DeploymentStatus[]> = {};
    // Only the newest deployment of the head commit is judged, so only its statuses are read.
    const newest = deployments.filter((d) => d.sha === t.sha).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (newest) statuses[newest.id] = (await rest<DeploymentStatus[]>(`{repo}/deployments/${newest.id}/statuses?per_page=30`)) ?? [];
    return deploymentVerdict(cfg, t, deployments, statuses);
  }
  const [runs, statuses, comments] = await Promise.all([
    rest<{ check_runs?: CheckRun[] }>(`{repo}/commits/${t.sha}/check-runs?per_page=100`),
    rest<CommitStatus[]>(`{repo}/commits/${t.sha}/statuses?per_page=100`),
    rest<IssueComment[]>(`{repo}/issues/${t.pr}/comments?per_page=100`),
  ]);
  return checkOrCommentVerdict(cfg, t, { checkRuns: runs?.check_runs ?? [], statuses: statuses ?? [], comments: comments ?? [] });
}

// ---- login ----

/** What the browser needs to be signed in. Values are secret: never logged, never in an error. */
export type ShotLogin = {
  /** The preview origin: headers and cookies go only there. */
  origin: string;
  headers?: Record<string, string>;
  cookies?: Array<{ name: string; value: string }>;
  form?: { url: string; userField: string; passwordField: string; submit: string; user: string; password: string; waitFor?: string };
};

/** Read the recipe's secrets (one audit row each, `secrets.reveal`) into a ShotLogin. */
export async function loadLogin(login: PreviewLogin | undefined, previewUrl: string, reveal: (ref: string) => Promise<string> = (ref) => secrets.reveal(ref, "orca-shot", "orca-shot --preview login")): Promise<ShotLogin | undefined> {
  if (!login || login.kind === "none") return undefined;
  const origin = new URL(previewUrl).origin;
  const read = async (ref: string) => {
    try { return await reveal(ref); } catch (e) { throw new RemotePreviewError(`login failed: secret "${ref}": ${(e as Error).message}`); }
  };
  if (login.kind === "header") {
    const headers: Record<string, string> = {};
    for (const [h, ref] of Object.entries(login.headers)) headers[h] = await read(ref);
    return { origin, headers };
  }
  if (login.kind === "cookie") {
    const v = await read(login.secret);
    return { origin, cookies: login.name ? [{ name: login.name, value: v }] : parseCookieString(v) };
  }
  const user = login.userSecret ? await read(login.userSecret) : login.user!;
  return {
    origin,
    form: {
      url: /^https?:\/\//.test(login.url) ? login.url : new URL(login.url, origin).toString(),
      userField: login.userField, passwordField: login.passwordField, submit: login.submit,
      user, password: await read(login.passwordSecret), waitFor: login.waitFor,
    },
  };
}

/** `a=1; b=2` → cookies. Pure. */
export function parseCookieString(s: string): Array<{ name: string; value: string }> {
  return s.split(";").map((p) => p.trim()).filter(Boolean).flatMap((p) => {
    const i = p.indexOf("=");
    return i > 0 ? [{ name: p.slice(0, i).trim(), value: p.slice(i + 1).trim() }] : [];
  });
}

// ---- the browser session, kept per run ----

/** Cookies a form login got, as CDP cookie params. */
export type SessionCookie = { name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: number };

const SESSION_TTL_MS = 6 * 60 * 60_000;
const SESSION_MAX = 200;
const sessions = new Map<string, { cookies: SessionCookie[]; at: number }>();

/** The key of a run's session on one preview origin: the worker's ORCA_RUN_ID, else its worktree. */
export const sessionKey = (who: string, origin: string): string => `${who}|${origin}`;

/** The cookies an earlier shot of this run got by logging in, if they are recent. In memory only. */
export function sessionCookies(key: string, now = Date.now()): SessionCookie[] | undefined {
  const s = sessions.get(key);
  if (!s) return undefined;
  if (now - s.at > SESSION_TTL_MS) { sessions.delete(key); return undefined; }
  return s.cookies;
}

export function keepSession(key: string, cookies: SessionCookie[], now = Date.now()): void {
  sessions.delete(key);
  sessions.set(key, { cookies, at: now });
  while (sessions.size > SESSION_MAX) sessions.delete(sessions.keys().next().value!);
}

export function forgetSessions(): void { sessions.clear(); }
