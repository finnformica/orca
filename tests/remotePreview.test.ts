// `orca-shot --preview` (shared/remotePreview.ts, server/remotePreview.ts): each source finds the
// preview of the PR's HEAD commit only, the config and the login recipe are validated, and the
// resolver waits, follows a new push and fails with a clear message. No network, no browser.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
  branchSlug, checkOrCommentVerdict, deploymentVerdict, extractUrl, fillTemplate, joinPreviewPath, loginProblems,
  namesCommit, previewAnswered, remotePreviewProblems, templateVerdict, type RemotePreviewConfig,
} from "../shared/remotePreview";
import {
  RemotePreviewError, forgetSessions, keepSession, loadLogin, parseCookieString, repoFor, resolvePreview,
  sessionCookies, sessionKey, type ResolveDeps,
} from "../server/remotePreview";
import { parseConfigDocument, type RepoConfig } from "../server/config";
import { parseShotRequest } from "../server/screenshot";

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OLD = "0f0e0d0c0b0a09080706050403020100ffeeddcc";
const target = { pr: 7, branch: "feat/New Thing", sha: HEAD, owner: "acme", repo: "app" };
const at = (min: number) => new Date(Date.UTC(2026, 9, 27, 10, min)).toISOString();

describe("github-deployment", () => {
  const cfg: RemotePreviewConfig = { source: "github-deployment", environment: "pr-preview" };

  test("uses the environment_url of the head commit's newest deployment", () => {
    const v = deploymentVerdict(cfg, target,
      [{ id: 1, sha: HEAD, environment: "pr-preview", created_at: at(1) }, { id: 2, sha: HEAD, environment: "pr-preview", created_at: at(5) }],
      { 2: [{ state: "in_progress", created_at: at(5) }, { state: "success", environment_url: "https://pr-7.preview.example.com/demo", created_at: at(9) }] });
    expect(v).toEqual({ state: "ready", url: "https://pr-7.preview.example.com/demo", from: "deployment 2 to pr-preview" });
  });

  test("never uses an older commit's deployment, however new", () => {
    const v = deploymentVerdict(cfg, target,
      [{ id: 9, sha: OLD, environment: "pr-preview", created_at: at(30) }],
      { 9: [{ state: "success", environment_url: "https://stale.example.com", created_at: at(31) }] });
    expect(v.state).toBe("waiting");
    expect(JSON.stringify(v)).not.toContain("stale");
  });

  test("the latest status decides: an old success under a newer failure is a failure", () => {
    const v = deploymentVerdict(cfg, target, [{ id: 3, sha: HEAD, environment: "pr-preview", created_at: at(1) }],
      { 3: [{ state: "success", environment_url: "https://x.example.com", created_at: at(2) }, { state: "failure", created_at: at(3) }] });
    expect(v).toEqual({ state: "failed", why: `deployment 3 to pr-preview for ${HEAD.slice(0, 7)} ended in failure` });
  });

  test("another environment is ignored; pending and no status wait; urlPattern fills a missing URL", () => {
    expect(deploymentVerdict(cfg, target, [{ id: 4, sha: HEAD, environment: "production", created_at: at(1) }], {}).state).toBe("waiting");
    expect(deploymentVerdict(cfg, target, [{ id: 5, sha: HEAD, environment: "pr-preview", created_at: at(1) }], {})).toEqual({ state: "waiting", why: "deployment 5 to pr-preview has no status yet" });
    expect(deploymentVerdict(cfg, target, [{ id: 5, sha: HEAD, environment: "pr-preview", created_at: at(1) }], { 5: [{ state: "queued", created_at: at(1) }] }).state).toBe("waiting");
    const withPattern = { ...cfg, urlPattern: "https://pr-{pr}.preview.example.com/demo" };
    expect(deploymentVerdict(withPattern, target, [{ id: 6, sha: HEAD, environment: "pr-preview", created_at: at(1) }], { 6: [{ state: "success", created_at: at(2) }] }))
      .toMatchObject({ state: "ready", url: "https://pr-7.preview.example.com/demo" });
    expect(deploymentVerdict(cfg, target, [{ id: 6, sha: HEAD, environment: "pr-preview", created_at: at(1) }], { 6: [{ state: "success", created_at: at(2) }] }).state).toBe("failed");
  });
});

describe("github-check-or-comment", () => {
  const cfg: RemotePreviewConfig = { source: "github-check-or-comment" };
  const none = { checkRuns: [], statuses: [], comments: [] };

  test("a check run of the head commit gives the URL; one of an older commit does not", () => {
    const run = (sha: string, url: string) => ({ name: "Cloudflare Pages", head_sha: sha, status: "completed", conclusion: "success", output: { summary: `## Deployed\nPreview URL: ${url}\n` } });
    expect(checkOrCommentVerdict(cfg, target, { ...none, checkRuns: [run(OLD, "https://old1.app.pages.dev"), run(HEAD, "https://9f8e7d6c.app.pages.dev")] }))
      .toEqual({ state: "ready", url: "https://9f8e7d6c.app.pages.dev", from: 'check run "Cloudflare Pages"' });
    expect(checkOrCommentVerdict(cfg, target, { ...none, checkRuns: [run(OLD, "https://old1.app.pages.dev")] }).state).toBe("waiting");
  });

  test("a comment counts only when it names the head commit", () => {
    const comment = (sha: string, url: string, at_: string) => ({
      user: { login: "cloudflare-workers-and-pages[bot]" }, created_at: at(0), updated_at: at_,
      body: `| Latest commit: | <code>${sha.slice(0, 7)}</code> |\n| Preview URL: | ${url} |\n| Branch Preview URL: | https://feat-new-thing.app.pages.dev |`,
    });
    expect(checkOrCommentVerdict(cfg, target, { ...none, comments: [comment(OLD, "https://old2.app.pages.dev", at(5))] }).state).toBe("waiting");
    expect(checkOrCommentVerdict(cfg, target, { ...none, comments: [comment(HEAD, "https://abcd1234.app.pages.dev", at(1)), comment(OLD, "https://old2.app.pages.dev", at(5))] }))
      .toEqual({ state: "ready", url: "https://abcd1234.app.pages.dev", from: "comment by cloudflare-workers-and-pages[bot]" });
    // commentAuthor filters out the same text from someone else.
    expect(checkOrCommentVerdict({ ...cfg, commentAuthor: "other[bot]" }, target, { ...none, comments: [comment(HEAD, "https://abcd1234.app.pages.dev", at(1))] }).state).toBe("waiting");
    // A comment that names no commit is never trusted.
    expect(checkOrCommentVerdict(cfg, target, { ...none, comments: [{ user: { login: "x" }, created_at: at(1), body: "see https://zz.app.pages.dev" }] }).state).toBe("waiting");
  });

  test("commit statuses: the newest per context decides; a failure stops", () => {
    const statuses = [
      { context: "netlify/deploy-preview", state: "failure", target_url: "https://deploy-preview-7--app.netlify.app" },
      { context: "netlify/deploy-preview", state: "success", target_url: "https://deploy-preview-7--app.netlify.app" },
    ];
    const netlify = { ...cfg, urlRegex: "https://deploy-preview-\\d+--[a-z0-9-]+\\.netlify\\.app" };
    expect(checkOrCommentVerdict(netlify, target, { ...none, statuses })).toMatchObject({ state: "failed" });
    expect(checkOrCommentVerdict(netlify, target, { ...none, statuses: [...statuses].reverse() })).toMatchObject({ state: "ready", url: "https://deploy-preview-7--app.netlify.app" });
  });

  test("checkName filters; a running check waits; a failed one stops", () => {
    const running = { name: "Workers Builds: app", head_sha: HEAD, status: "in_progress", output: {} };
    expect(checkOrCommentVerdict(cfg, target, { ...none, checkRuns: [running] })).toEqual({ state: "waiting", why: 'check run "Workers Builds: app" is in_progress' });
    const failed = { ...running, status: "completed", conclusion: "failure" };
    expect(checkOrCommentVerdict(cfg, target, { ...none, checkRuns: [failed] }).state).toBe("failed");
    expect(checkOrCommentVerdict({ ...cfg, checkName: "pages" }, target, { ...none, checkRuns: [failed] }).state).toBe("waiting");
  });

  test("regex extraction: group 1, else the whole match; trailing table punctuation is cut", () => {
    expect(extractUrl("Preview URL: https://abc.app.pages.dev/|", /https:\/\/\S+/)).toBe("https://abc.app.pages.dev/");
    expect(extractUrl("[open](https://abc.app.pages.dev)", /https:\/\/[^\s)]+/)).toBe("https://abc.app.pages.dev");
    expect(extractUrl("url=<https://x.example.com/p>", /<(https:[^>]+)>/)).toBe("https://x.example.com/p");
    expect(extractUrl(undefined, /x/)).toBeUndefined();
    expect(extractUrl("https://v1-app.acme.workers.dev ok", new RegExp("https://[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:pages|workers)\\.dev\\S*"))).toBe("https://v1-app.acme.workers.dev");
  });

  test("namesCommit: the full SHA or a 7+ prefix, as a word", () => {
    expect(namesCommit(`commit ${HEAD.slice(0, 7)}`, HEAD)).toBe(true);
    expect(namesCommit(HEAD, HEAD)).toBe(true);
    expect(namesCommit(`commit ${HEAD.slice(0, 6)}`, HEAD)).toBe(false);
    expect(namesCommit(`commit ${OLD.slice(0, 7)}`, HEAD)).toBe(false);
  });
});

describe("template", () => {
  test("fills every placeholder", () => {
    const url = fillTemplate("https://{branchSlug}.{repo}.pages.dev/{pr}/{sha7}?b={branch}&o={owner}&s={sha}", target);
    expect(url).toBe(`https://feat-new-thing.app.pages.dev/7/${HEAD.slice(0, 7)}?b=feat%2FNew%20Thing&o=acme&s=${HEAD}`);
    expect(branchSlug("Feat/__x--Y")).toBe("feat-x-y");
    expect(templateVerdict({ source: "template", urlPattern: "https://pr-{pr}.example.com" }, target)).toEqual({ state: "ready", url: "https://pr-7.example.com", from: "template" });
  });

  test("a 404 or 5xx is not ready; a login wall is", () => {
    expect([0, 404, 502].map(previewAnswered)).toEqual([false, false, false]);
    expect([200, 302, 401, 403].map(previewAnswered)).toEqual([true, true, true, true]);
  });

  test("joinPreviewPath keeps the preview's own path", () => {
    expect(joinPreviewPath("https://h.example.com/demo", "/settings")).toBe("https://h.example.com/demo/settings");
    expect(joinPreviewPath("https://h.example.com/demo/", "settings?tab=2")).toBe("https://h.example.com/demo/settings?tab=2");
    expect(joinPreviewPath("https://h.example.com/demo")).toBe("https://h.example.com/demo");
    expect(() => joinPreviewPath("https://h.example.com", "https://evil.example.com")).toThrow(/a path under the preview/);
  });
});

describe("config validation", () => {
  // The docs' examples are the contract: they must validate as written.
  const doc = readFileSync(new URL("../docs/remote-previews.md", import.meta.url), "utf8");
  const block = (title: string) => JSON.parse(`{${doc.split(`\`\`\`json title=${title}\n`)[1]!.split("\n```")[0]}}`);

  test("the branch-demo and Cloudflare examples in the docs are valid", () => {
    const branchDemo = block("branch-demo").remotePreview;
    expect(remotePreviewProblems(branchDemo, "rp")).toEqual([]);
    expect(branchDemo).toMatchObject({ source: "github-deployment", environment: "pr-preview", login: { kind: "form", user: "test@example.com" } });
    const cf = block("Cloudflare").remotePreview;
    expect(remotePreviewProblems(cf, "rp")).toEqual([]);
    expect(new RegExp(cf.urlRegex).test("https://abc.app.pages.dev")).toBe(true);
    expect(loginProblems(block("Cloudflare Access").login, "l")).toEqual([]);
  });

  test("bad blocks are refused with reasons", () => {
    expect(remotePreviewProblems({ source: "netlify" }, "rp")).toContain("rp.source must be one of github-deployment, github-check-or-comment, template");
    expect(remotePreviewProblems({ source: "template" }, "rp")).toContain("rp.urlPattern is required for source template");
    expect(remotePreviewProblems({ source: "template", urlPattern: "https://{prnum}.x" }, "rp")[0]).toMatch(/unknown placeholder \{prnum\}/);
    expect(remotePreviewProblems({ source: "template", urlPattern: "ftp://x/{pr}" }, "rp")).toContain("rp.urlPattern must start with http:// or https://");
    expect(remotePreviewProblems({ source: "github-check-or-comment", urlRegex: "(" }, "rp")[0]).toMatch(/not a valid regular expression/);
    expect(remotePreviewProblems({ source: "github-deployment", urlRegex: "x" }, "rp")).toContain("rp.urlRegex applies only to source github-check-or-comment");
    expect(remotePreviewProblems({ source: "template", urlPattern: "https://x", environment: "e" }, "rp")).toContain("rp.environment applies only to source github-deployment");
    expect(remotePreviewProblems({ source: "github-deployment", waitMinutes: 999 }, "rp")).toContain("rp.waitMinutes must be a number from 0 to 60");
    expect(remotePreviewProblems({ source: "github-deployment", typo: 1 }, "rp")[0]).toMatch(/rp.typo is not a known setting/);
  });

  test("parseConfigDocument checks remotePreview on each repo", () => {
    const repo = { name: "app", repoPath: "/r", worktreeRoot: "/r/.worktrees", baseBranch: "main", previewServices: [] };
    expect(parseConfigDocument({ repos: [{ ...repo, remotePreview: { source: "github-deployment", environment: "pr-preview" } }] }).errors).toEqual([]);
    expect(parseConfigDocument({ repos: [{ ...repo, remotePreview: { source: "x" } }] }).errors)
      .toContain("repos[0].remotePreview.source must be one of github-deployment, github-check-or-comment, template");
  });
});

describe("login recipe", () => {
  const form = { kind: "form", url: "/login", userField: "#email", passwordField: "#pw", submit: "button", user: "test@example.com", passwordSecret: "app/pw" };

  test("parses the four kinds", () => {
    expect(loginProblems({ kind: "none" }, "l")).toEqual([]);
    expect(loginProblems(form, "l")).toEqual([]);
    expect(loginProblems({ ...form, user: undefined, userSecret: "app/user" }, "l")).toEqual([]);
    expect(loginProblems({ kind: "cookie", secret: "app/session", name: "sid" }, "l")).toEqual([]);
    expect(loginProblems({ kind: "header", headers: { Authorization: "app/basic" } }, "l")).toEqual([]);
  });

  test("a credential in the config itself is refused", () => {
    expect(loginProblems({ ...form, password: "hunter2" }, "l").join("\n")).toMatch(/l.password is not allowed/);
    expect(loginProblems({ ...form, passwordSecret: undefined }, "l")).toContain("l.passwordSecret is required (the name of a stored secret)");
    expect(loginProblems({ ...form, passwordSecret: "not a name!" }, "l")).toContain("l.passwordSecret must be a stored secret name (scope/name or name)");
    expect(loginProblems({ ...form, user: undefined }, "l")).toContain("l needs user or userSecret");
    expect(loginProblems({ ...form, userSecret: "u" }, "l")).toContain("l takes user or userSecret, not both");
    expect(loginProblems({ ...form, url: "login" }, "l")).toContain("l.url must be an http(s) URL or a path that starts with /");
    expect(loginProblems({ kind: "header", headers: { "Bad Header": "x" } }, "l")[0]).toMatch(/is not a header name/);
    expect(loginProblems({ kind: "basic" }, "l")).toEqual(["l.kind must be one of none, form, cookie, header"]);
  });

  test("loadLogin reads secrets by name, resolves a relative form URL, and never puts a value in an error", async () => {
    const store: Record<string, string> = { "app/pw": "s3cret-pw", "app/session": "sid=abc; theme=dark", "app/basic": "Basic Zm9v" };
    const reveal = async (ref: string) => { if (!(ref in store)) throw new Error(`no secret "${ref}"`); return store[ref]!; };
    const f = await loadLogin(form as never, "https://pr-7.preview.example.com/demo", reveal);
    expect(f?.form).toMatchObject({ url: "https://pr-7.preview.example.com/login", user: "test@example.com", password: "s3cret-pw" });
    expect(f?.origin).toBe("https://pr-7.preview.example.com");
    expect((await loadLogin({ kind: "cookie", secret: "app/session" }, "https://x.example.com", reveal))?.cookies).toEqual([{ name: "sid", value: "abc" }, { name: "theme", value: "dark" }]);
    expect((await loadLogin({ kind: "header", headers: { Authorization: "app/basic" } }, "https://x.example.com", reveal))?.headers).toEqual({ Authorization: "Basic Zm9v" });
    expect(await loadLogin({ kind: "none" }, "https://x.example.com", reveal)).toBeUndefined();
    const err = await loadLogin({ ...form, passwordSecret: "app/missing" } as never, "https://x.example.com", reveal).then(() => new Error("no error"), (e: Error) => e);
    expect(err).toBeInstanceOf(RemotePreviewError);
    expect(err.message).toMatch(/^login failed: secret "app\/missing"/);
    expect(err.message).not.toContain("s3cret");
    expect(parseCookieString(" a=1 ;; b = x=y ;bad")).toEqual([{ name: "a", value: "1" }, { name: "b", value: "x=y" }]);
  });

  test("a run's session cookies are kept per run and origin, and expire", () => {
    forgetSessions();
    const k = sessionKey("run-1", "https://x.example.com");
    keepSession(k, [{ name: "sid", value: "v" }], 1000);
    expect(sessionCookies(k, 2000)).toEqual([{ name: "sid", value: "v" }]);
    expect(sessionCookies(sessionKey("run-2", "https://x.example.com"), 2000)).toBeUndefined();
    expect(sessionCookies(k, 1000 + 7 * 60 * 60_000)).toBeUndefined();
  });
});

test("a request body can never set the login: only the bridge does, after it resolves the preview", () => {
  const req = parseShotRequest({ url: "https://x.example.com", login: { origin: "https://evil.example.com", headers: { Authorization: "x" } } });
  expect(req.login).toBeUndefined();
});

describe("resolvePreview", () => {
  const repo = (rp: RemotePreviewConfig): RepoConfig => ({ name: "app", repoPath: "/r", worktreeRoot: "/r/.worktrees", baseBranch: "main", previewServices: [], remotePreview: rp });

  /** A fake GitHub: `prs` is the open PR list the poll sees, one entry per poll (the last repeats). */
  function fake(opts: { prs: Array<Array<{ number: number; state: string; head: { sha: string; ref: string } }>>; deployments?: Record<string, unknown[]>; statuses?: Record<string, unknown[]>; head?: string }) {
    let poll = 0;
    let clock = 0;
    const calls: string[] = [];
    const deps: ResolveDeps = {
      client: async () => ({
        owner: "acme", name: "app",
        rest: async (path: string) => {
          calls.push(path);
          if (path.startsWith("{repo}/pulls?")) return opts.prs[Math.min(poll++, opts.prs.length - 1)];
          const sha = /sha=(\w+)/.exec(path)?.[1];
          if (path.startsWith("{repo}/deployments?")) return opts.deployments?.[sha!] ?? [];
          const id = /deployments\/(\d+)\/statuses/.exec(path)?.[1];
          if (id) return opts.statuses?.[id] ?? [];
          throw new Error(`unexpected ${path}`);
        },
      }) as never,
      git: async (_cwd, args) => (args.includes("--abbrev-ref") ? "feat/x" : opts.head ?? HEAD),
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      pollMs: 15_000,
    };
    return { deps, calls };
  }
  const pr = (sha: string) => [{ number: 7, state: "open", head: { sha, ref: "feat/x" } }];
  const dep = { source: "github-deployment", environment: "pr-preview" } as const;

  test("no open PR is a clear error", async () => {
    const { deps } = fake({ prs: [[]] });
    await expect(resolvePreview(repo(dep), { cwd: "/r/.worktrees/x" }, {}, deps)).rejects.toThrow(/no open PR for branch feat\/x: push the branch and open a \(draft\) PR first/);
  });

  test("a worktree ahead of its PR is told to push first", async () => {
    const { deps } = fake({ prs: [pr(OLD)], head: HEAD });
    await expect(resolvePreview(repo(dep), { cwd: "/r/.worktrees/x" }, {}, deps)).rejects.toThrow(/PR #7 head is 0f0e0d0 but this worktree is at a1b2c3d: push first/);
  });

  test("waits for the deploy, follows a push made while waiting, and ignores the old commit's URL", async () => {
    const { deps } = fake({
      prs: [pr(OLD), pr(OLD), pr(HEAD)],
      deployments: { [OLD]: [{ id: 1, sha: OLD, environment: "pr-preview", created_at: at(0) }], [HEAD]: [{ id: 2, sha: HEAD, environment: "pr-preview", created_at: at(3) }] },
      statuses: { 1: [{ state: "in_progress", created_at: at(1) }], 2: [{ state: "success", environment_url: "https://pr-7.preview.example.com/demo", created_at: at(4) }] },
    });
    const waits: string[] = [];
    const got = await resolvePreview(repo(dep), { pr: 7 }, { onWait: (w) => waits.push(w) }, {
      ...deps,
      client: async (cwd) => {
        const c = await deps.client!(cwd);
        return { ...c, rest: (async (p: string) => (p === "{repo}/pulls/7" ? (await c.rest<unknown[]>(`{repo}/pulls?head`))[0] : c.rest(p))) as typeof c.rest };
      },
    });
    expect(got).toEqual({ url: "https://pr-7.preview.example.com/demo", from: "deployment 2 to pr-preview", pr: 7, sha: HEAD, branch: "feat/x" });
    expect(waits).toEqual(["deployment 1 to pr-preview is in_progress"]);
  });

  test("times out with the last reason", async () => {
    const { deps } = fake({ prs: [pr(HEAD)] });
    await expect(resolvePreview(repo({ ...dep, waitMinutes: 1 }), { cwd: "/r/.worktrees/x" }, {}, deps))
      .rejects.toThrow(`timed out waiting for the preview of PR #7 (a1b2c3d): no deployment to pr-preview for a1b2c3d yet`);
  });

  test("a template waits until the URL answers", async () => {
    const { deps } = fake({ prs: [pr(HEAD)] });
    const answers = [404, 503, 200];
    const got = await resolvePreview(repo({ source: "template", urlPattern: "https://{branchSlug}.app.pages.dev" }), { cwd: "/r/.worktrees/x" }, {}, { ...deps, probe: async () => answers.shift()! });
    expect(got.url).toBe("https://feat-x.app.pages.dev");
  });

  test("a repo without remotePreview, and repo lookup by name or worktree", async () => {
    await expect(resolvePreview({ ...repo(dep), remotePreview: undefined }, {}, {}, {})).rejects.toThrow(/has no remotePreview/);
    const cfg = { repos: [{ ...repo(dep), name: "a", repoPath: "/src/a", worktreeRoot: "/src/a/.worktrees" }, { ...repo(dep), name: "b", repoPath: "/src/b", worktreeRoot: "/wt/b" }] };
    expect(repoFor(cfg, { cwd: "/wt/b/feat-x/web" })?.name).toBe("b");
    expect(repoFor(cfg, { cwd: "/src/a/.worktrees/y" })?.name).toBe("a");
    expect(repoFor(cfg, { repo: "b" })?.name).toBe("b");
    expect(repoFor(cfg, { cwd: "/elsewhere" })).toBeUndefined();
  });
});
