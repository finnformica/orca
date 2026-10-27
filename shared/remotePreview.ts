// Remote PR previews for `orca-shot --preview`: the rules, pure. A repo whose PRs deploy to a preview
// (GitHub deployments, Cloudflare Pages / Workers Builds, a fixed URL scheme) names it once in its
// RepoConfig as `remotePreview`, and a worker shoots that preview instead of a local stack of
// database, backend and Vite on the box. The I/O (GitHub reads, the wait, the secret store) is in
// server/remotePreview.ts; this file decides what the fetched data means, so it is testable alone.
//
// The one rule every source keeps: a URL is used only when it belongs to the PR's HEAD commit. A
// deployment, check, status or comment of an older commit is never a preview of this code.

export const REMOTE_PREVIEW_SOURCES = ["github-deployment", "github-check-or-comment", "template"] as const;
export type RemotePreviewSource = (typeof REMOTE_PREVIEW_SOURCES)[number];

/** Login recipe. Every credential is the NAME of a stored secret (`orca secret`), never a value. */
export type PreviewLogin =
  | { kind: "none" }
  /** A login form: open `url` (absolute, or a path under the preview URL), type the user and the
   *  password into their fields, click `submit`. `user` is a plain login name; `userSecret` reads it
   *  from the store instead. `waitFor` is a selector that shows only after a good login. */
  | { kind: "form"; url: string; userField: string; passwordField: string; submit: string; user?: string; userSecret?: string; passwordSecret: string; waitFor?: string }
  /** A cookie on the preview origin. With `name` the secret is the value; else the secret is a
   *  whole `a=1; b=2` cookie string. */
  | { kind: "cookie"; secret: string; name?: string }
  /** Request headers sent only to the preview origin: header name → secret name (e.g. Cloudflare
   *  Access `CF-Access-Client-Id` / `CF-Access-Client-Secret`). */
  | { kind: "header"; headers: Record<string, string> };

export type RemotePreviewConfig = {
  source: RemotePreviewSource;
  /** `template`: the URL. `github-deployment`: the URL when a status has no `environment_url`.
   *  Placeholders: {pr} {branch} {branchSlug} {sha} {sha7} {owner} {repo}. */
  urlPattern?: string;
  /** `github-deployment`: only deployments to this environment (e.g. `pr-preview`). */
  environment?: string;
  /** `github-check-or-comment`: a regex for the URL. Group 1 when it has one, else the whole match. */
  urlRegex?: string;
  /** `github-check-or-comment`: only check runs and commit statuses whose name contains this. */
  checkName?: string;
  /** `github-check-or-comment`: only PR comments by this login (e.g. `cloudflare-workers-and-pages[bot]`). */
  commentAuthor?: string;
  /** How long to wait for the preview to be ready. Default DEFAULT_WAIT_MINUTES. */
  waitMinutes?: number;
  login?: PreviewLogin;
};

export const DEFAULT_WAIT_MINUTES = 8;
export const MAX_WAIT_MINUTES = 60;
export const URL_PLACEHOLDERS = ["pr", "branch", "branchSlug", "sha", "sha7", "owner", "repo"] as const;
/** The default `urlRegex`: a Cloudflare Pages or Workers preview URL. */
export const CLOUDFLARE_PREVIEW_REGEX = "https://[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:pages|workers)\\.dev\\S*";

const SECRET_NAME = /^[\w.-]+(?:\/[\w.-]+)?$/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => typeof v === "string" && v.trim() !== "";

/** Problems with a login recipe, each prefixed by `where`. Pure. */
export function loginProblems(v: unknown, where: string): string[] {
  if (!isObj(v)) return [`${where} must be an object`];
  const p: string[] = [];
  const known = (keys: string[]) => { for (const k of Object.keys(v)) if (!keys.includes(k)) p.push(`${where}.${k} is not a known setting (${keys.join(", ")})`); };
  const secret = (k: string) => { if (v[k] !== undefined && !(typeof v[k] === "string" && SECRET_NAME.test(v[k] as string))) p.push(`${where}.${k} must be a stored secret name (scope/name or name)`); };
  switch (v.kind) {
    case "none": known(["kind"]); break;
    case "form":
      known(["kind", "url", "userField", "passwordField", "submit", "user", "userSecret", "passwordSecret", "waitFor"]);
      for (const k of ["url", "userField", "passwordField", "submit"]) if (!str(v[k])) p.push(`${where}.${k} is required`);
      if (!str(v.passwordSecret)) p.push(`${where}.passwordSecret is required (the name of a stored secret)`);
      secret("passwordSecret"); secret("userSecret");
      if (v.user === undefined && v.userSecret === undefined) p.push(`${where} needs user or userSecret`);
      if (v.user !== undefined && v.userSecret !== undefined) p.push(`${where} takes user or userSecret, not both`);
      if (v.user !== undefined && !str(v.user)) p.push(`${where}.user must be a login name`);
      if (v.waitFor !== undefined && !str(v.waitFor)) p.push(`${where}.waitFor must be a CSS selector`);
      if (str(v.url) && !/^(https?:\/\/|\/)/.test(v.url as string)) p.push(`${where}.url must be an http(s) URL or a path that starts with /`);
      // A password in the config itself is the mistake this guards against: this file is shared.
      if ("password" in v) p.push(`${where}.password is not allowed: store it with orca secret and name it in passwordSecret`);
      break;
    case "cookie":
      known(["kind", "secret", "name"]);
      if (!str(v.secret)) p.push(`${where}.secret is required (the name of a stored secret)`);
      secret("secret");
      if (v.name !== undefined && !(typeof v.name === "string" && /^[^\s=;,]+$/.test(v.name))) p.push(`${where}.name must be a cookie name`);
      break;
    case "header":
      known(["kind", "headers"]);
      if (!isObj(v.headers) || !Object.keys(v.headers).length) p.push(`${where}.headers must map header names to stored secret names`);
      else for (const [h, s] of Object.entries(v.headers)) {
        if (!HEADER_NAME.test(h)) p.push(`${where}.headers: "${h}" is not a header name`);
        if (!(typeof s === "string" && SECRET_NAME.test(s))) p.push(`${where}.headers.${h} must be a stored secret name`);
      }
      break;
    default: p.push(`${where}.kind must be one of none, form, cookie, header`);
  }
  return p;
}

/** Problems with a `remotePreview` block, each prefixed by `where`. Pure. */
export function remotePreviewProblems(v: unknown, where: string): string[] {
  if (!isObj(v)) return [`${where} must be an object`];
  const p: string[] = [];
  const keys = ["source", "urlPattern", "environment", "urlRegex", "checkName", "commentAuthor", "waitMinutes", "login"];
  for (const k of Object.keys(v)) if (!keys.includes(k)) p.push(`${where}.${k} is not a known setting (${keys.join(", ")})`);
  if (!REMOTE_PREVIEW_SOURCES.includes(v.source as never)) p.push(`${where}.source must be one of ${REMOTE_PREVIEW_SOURCES.join(", ")}`);
  for (const k of ["environment", "checkName", "commentAuthor"]) if (v[k] !== undefined && !str(v[k])) p.push(`${where}.${k} must be a non-empty string`);
  if (v.urlPattern !== undefined) {
    if (!str(v.urlPattern)) p.push(`${where}.urlPattern must be a URL template`);
    else p.push(...templateProblems(v.urlPattern as string).map((m) => `${where}.urlPattern ${m}`));
  }
  if (v.source === "template" && v.urlPattern === undefined) p.push(`${where}.urlPattern is required for source template`);
  if (v.urlRegex !== undefined) {
    if (!str(v.urlRegex)) p.push(`${where}.urlRegex must be a regular expression`);
    else try { new RegExp(v.urlRegex as string); } catch (e) { p.push(`${where}.urlRegex is not a valid regular expression: ${(e as Error).message}`); }
  }
  if (v.source !== "github-check-or-comment") {
    for (const k of ["urlRegex", "checkName", "commentAuthor"]) if (v[k] !== undefined) p.push(`${where}.${k} applies only to source github-check-or-comment`);
  }
  if (v.environment !== undefined && v.source !== "github-deployment") p.push(`${where}.environment applies only to source github-deployment`);
  if (v.waitMinutes !== undefined && !(typeof v.waitMinutes === "number" && v.waitMinutes >= 0 && v.waitMinutes <= MAX_WAIT_MINUTES)) {
    p.push(`${where}.waitMinutes must be a number from 0 to ${MAX_WAIT_MINUTES}`);
  }
  if (v.login !== undefined) p.push(...loginProblems(v.login, `${where}.login`));
  return p;
}

function templateProblems(t: string): string[] {
  const p: string[] = [];
  for (const m of t.matchAll(/\{([^}]*)\}/g)) if (!URL_PLACEHOLDERS.includes(m[1] as never)) p.push(`has an unknown placeholder {${m[1]}} (known: ${URL_PLACEHOLDERS.map((x) => `{${x}}`).join(" ")})`);
  if (!/^https?:\/\//.test(t)) p.push("must start with http:// or https://");
  return p;
}

/** What a template is filled from: the PR and its head commit. */
export type PreviewTarget = { pr: number; branch: string; sha: string; owner: string; repo: string };

/** A branch as a DNS label: lower case, every run of other characters one `-` (the form Cloudflare
 *  Pages uses for its branch aliases). Pure. */
export const branchSlug = (b: string): string => b.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Fill a URL template. Every value is URL-encoded except the slug and the numbers. Pure. */
export function fillTemplate(t: string, x: PreviewTarget): string {
  const values: Record<string, string> = {
    pr: String(x.pr), branch: encodeURIComponent(x.branch), branchSlug: branchSlug(x.branch),
    sha: x.sha, sha7: x.sha.slice(0, 7), owner: encodeURIComponent(x.owner), repo: encodeURIComponent(x.repo),
  };
  return t.replace(/\{(\w+)\}/g, (all, k: string) => values[k] ?? all);
}

/** A path under the preview URL: `/settings` on `https://h/demo` is `https://h/demo/settings`. The
 *  base's own path is kept, because a preview often lives under one (branch-demo's `/demo`). Pure. */
export function joinPreviewPath(base: string, path?: string): string {
  if (!path || path === "/") return base;
  if (/^[a-z]+:\/\//i.test(path)) throw new Error("--preview takes a path under the preview (e.g. /settings), not a URL");
  const u = new URL(base);
  const [p, q] = path.split(/\?(.*)/s, 2) as [string, string | undefined];
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;
  if (q !== undefined) u.search = q;
  return u.toString();
}

// ---- the verdicts: what the fetched data says ----

export type Verdict = { state: "ready"; url: string; from: string } | { state: "waiting"; why: string } | { state: "failed"; why: string };

/** The fields of a GitHub deployment and deployment status that the verdict reads. */
export type Deployment = { id: number; sha: string; environment?: string; created_at: string };
export type DeploymentStatus = { state: string; environment_url?: string | null; created_at: string };

/** `github-deployment`: the newest deployment of the head commit (in the environment, when one is
 *  set), judged by its LATEST status. A deployment of another commit is ignored, however new, so an
 *  `environment_url` of older code is never used. Pure. */
export function deploymentVerdict(cfg: RemotePreviewConfig, target: PreviewTarget, deployments: Deployment[], statuses: Record<number, DeploymentStatus[]>): Verdict {
  const own = deployments
    .filter((d) => d.sha === target.sha && (!cfg.environment || d.environment === cfg.environment))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const env = cfg.environment ? ` to ${cfg.environment}` : "";
  const d = own[0];
  if (!d) return { state: "waiting", why: `no deployment${env} for ${target.sha.slice(0, 7)} yet` };
  const latest = [...(statuses[d.id] ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!latest) return { state: "waiting", why: `deployment ${d.id}${env} has no status yet` };
  if (latest.state === "success") {
    const url = latest.environment_url || (cfg.urlPattern ? fillTemplate(cfg.urlPattern, target) : "");
    if (!url) return { state: "failed", why: `deployment ${d.id} succeeded but has no environment_url: set remotePreview.urlPattern` };
    return { state: "ready", url, from: `deployment ${d.id}${env}` };
  }
  if (latest.state === "failure" || latest.state === "error") return { state: "failed", why: `deployment ${d.id}${env} for ${target.sha.slice(0, 7)} ended in ${latest.state}` };
  if (latest.state === "inactive") return { state: "failed", why: `deployment ${d.id}${env} for ${target.sha.slice(0, 7)} is inactive (taken down)` };
  return { state: "waiting", why: `deployment ${d.id}${env} is ${latest.state}` };
}

export type CheckRun = { name: string; head_sha: string; status: string; conclusion?: string | null; details_url?: string | null; output?: { title?: string | null; summary?: string | null; text?: string | null } };
export type CommitStatus = { context: string; state: string; target_url?: string | null; description?: string | null; created_at?: string };
export type IssueComment = { user?: { login?: string } | null; body?: string | null; created_at: string; updated_at?: string };

/** The first URL `re` finds in `text`: group 1 when the regex has one, else the whole match. Trailing
 *  markdown and table punctuation is cut. Pure. */
export function extractUrl(text: string | null | undefined, re: RegExp): string | undefined {
  if (!text) return undefined;
  const m = new RegExp(re.source, re.flags.replace("g", "")).exec(text);
  const raw = m?.[1] ?? m?.[0];
  return raw?.replace(/[)\]>|'"`*_.,;]+$/, "") || undefined;
}

/** `github-check-or-comment`: a URL in a check run or commit status of the head commit, else in a PR
 *  comment that names the head commit (its full SHA or first 7+ characters, as the Cloudflare bot's
 *  "Latest commit" row does). A comment that names no commit, or an older one, is ignored. Pure. */
export function checkOrCommentVerdict(cfg: RemotePreviewConfig, target: PreviewTarget, data: { checkRuns: CheckRun[]; statuses: CommitStatus[]; comments: IssueComment[] }): Verdict {
  const re = new RegExp(cfg.urlRegex ?? CLOUDFLARE_PREVIEW_REGEX, "i");
  const named = (n: string) => !cfg.checkName || n.toLowerCase().includes(cfg.checkName.toLowerCase());
  const runs = data.checkRuns.filter((r) => r.head_sha === target.sha && named(r.name));
  for (const r of runs) {
    const url = extractUrl([r.output?.title, r.output?.summary, r.output?.text].filter(Boolean).join("\n"), re);
    if (url && r.status === "completed" && r.conclusion === "success") return { state: "ready", url, from: `check run "${r.name}"` };
  }
  // The statuses endpoint is per commit already; newest first, so the first per context is current.
  const latest = new Map<string, CommitStatus>();
  for (const s of data.statuses) if (named(s.context) && !latest.has(s.context)) latest.set(s.context, s);
  for (const s of latest.values()) {
    const url = extractUrl(`${s.target_url ?? ""}\n${s.description ?? ""}`, re);
    if (url && s.state === "success") return { state: "ready", url, from: `status "${s.context}"` };
  }
  const sha7 = target.sha.slice(0, 7);
  const comments = data.comments
    .filter((c) => !cfg.commentAuthor || c.user?.login === cfg.commentAuthor)
    .sort((a, b) => Date.parse(b.updated_at ?? b.created_at) - Date.parse(a.updated_at ?? a.created_at));
  for (const c of comments) {
    if (!namesCommit(c.body ?? "", target.sha)) continue;
    const url = extractUrl(c.body, re);
    if (url) return { state: "ready", url, from: `comment by ${c.user?.login ?? "unknown"}` };
  }
  const failed = runs.find((r) => r.status === "completed" && r.conclusion && !["success", "neutral", "skipped"].includes(r.conclusion));
  if (failed) return { state: "failed", why: `check run "${failed.name}" for ${sha7} ended in ${failed.conclusion}` };
  const badStatus = [...latest.values()].find((s) => s.state === "failure" || s.state === "error");
  if (badStatus) return { state: "failed", why: `status "${badStatus.context}" for ${sha7} is ${badStatus.state}` };
  const pending = runs.find((r) => r.status !== "completed");
  if (pending) return { state: "waiting", why: `check run "${pending.name}" is ${pending.status}` };
  return { state: "waiting", why: `no check, status or comment with a preview URL for ${sha7} yet` };
}

/** Does `text` name `sha`? The full SHA, or a prefix of 7 or more hex characters as a whole word. Pure. */
export function namesCommit(text: string, sha: string): boolean {
  for (const m of text.matchAll(/\b[0-9a-f]{7,40}\b/gi)) if (sha.toLowerCase().startsWith(m[0].toLowerCase())) return true;
  return false;
}

/** `template`: the URL is known at once; the server then waits until it answers. Pure. */
export function templateVerdict(cfg: RemotePreviewConfig, target: PreviewTarget): Verdict {
  if (!cfg.urlPattern) return { state: "failed", why: "remotePreview.urlPattern is not set" };
  return { state: "ready", url: fillTemplate(cfg.urlPattern, target), from: "template" };
}

/** Is a preview URL that answered with `status` up? A 404 or a 5xx is a preview still deploying (or
 *  gone); a 401 or 403 is up behind a login. Pure. */
export const previewAnswered = (status: number): boolean => status > 0 && status < 500 && status !== 404;
