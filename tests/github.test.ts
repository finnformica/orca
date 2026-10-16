// The GitHub client (server/github.ts) over a fake fetch: REST and GraphQL requests, ETag reuse on
// a 304, rate-limit backoff, one token per repo account, and typed errors that never carry a token.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  forRepo, GitHubAuthError, GitHubError, GitHubGraphQLError, GitHubNotFoundError, GitHubRateLimitError,
  graphql, parseSlug, rateLimitedFor, repoSlug, request, resetCaches, resetTokens, setFetch, tokenFor,
} from "../server/github";
import { setGithubAccounts } from "../server/env";
import { installFakeGh, makeScratchRepo, restorePath } from "./helpers";
import { run } from "../server/run";
import { native } from "./happydom";

type Seen = { url: string; method: string; headers: Record<string, string>; body?: any };
let seen: Seen[] = [];
let answer: (s: Seen) => Response | Promise<Response>;
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new native.Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const saved: Record<string, string | undefined> = {};
const KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "ORCA_GITHUB_API_URL", "ORCA_GITHUB_REPO"] as const;
beforeAll(async () => { await installFakeGh(); }); // the `gh auth token` shim
afterAll(() => restorePath());
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN;
  process.env.ORCA_GITHUB_API_URL = "https://api.github.test";
  process.env.ORCA_GITHUB_REPO = "acme/app";
  resetCaches(); resetTokens();
  seen = [];
  answer = () => reply({ ok: true });
  setFetch((async (url: string, init?: RequestInit) => {
    const s: Seen = { url, method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) }, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(s);
    return answer(s);
  }) as never);
});
afterEach(() => {
  setFetch(undefined);
  setGithubAccounts([]);
  resetCaches(); resetTokens();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test("REST: method, path under the API root, JSON body and the GitHub headers; a 204 is undefined", async () => {
  answer = () => reply({ number: 5, html_url: "https://github.com/acme/app/pull/5" }, 201);
  const c = await forRepo("/tmp");
  expect(await c.rest<unknown>("{repo}/pulls", { method: "POST", body: { title: "T" } })).toEqual({ number: 5, html_url: "https://github.com/acme/app/pull/5" });
  expect(seen[0]).toMatchObject({ url: "https://api.github.test/repos/acme/app/pulls", method: "POST", body: { title: "T" } });
  expect(seen[0]!.headers).toMatchObject({ Authorization: "Bearer tok-active", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" });
  answer = () => new native.Response(null, { status: 204 });
  expect(await c.rest("{repo}/git/refs/heads/x", { method: "DELETE" })).toBeUndefined();
  // A non-JSON Accept returns the text (a PR's diff).
  answer = () => new native.Response("diff --git a b", { headers: { "content-type": "application/vnd.github.diff" } });
  expect(await c.rest<unknown>("{repo}/pulls/5", { accept: "application/vnd.github.diff" })).toBe("diff --git a b");
});

test("GraphQL: POST /graphql with query + variables, returns data; errors read like gh's", async () => {
  answer = () => reply({ data: { repository: { pullRequest: { number: 7 } } } });
  const data = await graphql("query($n:Int!){repository(owner:\"a\",name:\"b\"){pullRequest(number:$n){number}}}", { n: 7 }, "tok-x");
  expect(data).toEqual({ repository: { pullRequest: { number: 7 } } });
  expect(seen[0]).toMatchObject({ url: "https://api.github.test/graphql", method: "POST", body: { variables: { n: 7 } } });
  answer = () => reply({ data: null, errors: [{ message: "Auto merge is not allowed for this repository", path: ["enablePullRequestAutoMerge"] }] });
  const err = await graphql("mutation{x}", {}, "tok-x").catch((e) => e);
  expect(err).toBeInstanceOf(GitHubGraphQLError);
  expect(err.message).toBe("GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)");
});

test("ETag: a polled GET sends If-None-Match and a 304 reuses the cached body; the cache is per token", async () => {
  answer = (s) => s.headers["If-None-Match"] === '"v1"' ? new native.Response(null, { status: 304 }) : reply([{ ref: "refs/heads/a" }], 200, { etag: '"v1"' });
  const first = await request("repos/acme/app/git/matching-refs/heads/x", { token: "tok-a" });
  const second = await request("repos/acme/app/git/matching-refs/heads/x", { token: "tok-a" });
  expect(second).toEqual(first);
  expect(second).toEqual([{ ref: "refs/heads/a" }]);
  expect(seen.map((s) => s.headers["If-None-Match"])).toEqual([undefined, '"v1"']);
  await request("repos/acme/app/git/matching-refs/heads/x", { token: "tok-b" }); // another account: no shared cache
  expect(seen[2]!.headers["If-None-Match"]).toBeUndefined();
  await request("repos/acme/app/pulls", { token: "tok-a", method: "POST", body: {} }); // never on a write
  expect(seen[3]!.headers["If-None-Match"]).toBeUndefined();
});

test("rate limit: an exhausted account is blocked until its reset and fails fast; another account is not", async () => {
  const reset = Math.floor(Date.now() / 1000) + 120;
  answer = () => reply({ message: "API rate limit exceeded for user ID 1." }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
  const err = await request("user", { token: "tok-a" }).catch((e) => e);
  expect(err).toBeInstanceOf(GitHubRateLimitError);
  expect(err.resetAt).toBe(reset * 1000);
  expect(rateLimitedFor("tok-a")).toBeGreaterThan(100_000);
  answer = () => reply({ login: "a" });
  await expect(request("user", { token: "tok-a" })).rejects.toBeInstanceOf(GitHubRateLimitError);
  expect(seen).toHaveLength(1); // the blocked call never reached GitHub
  expect(await request<unknown>("user", { token: "tok-b" })).toEqual({ login: "a" });
  // A success that spends the last of the quota blocks the account too.
  answer = () => reply({ ok: 1 }, 200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
  await request("user", { token: "tok-c" });
  await expect(request("user", { token: "tok-c" })).rejects.toBeInstanceOf(GitHubRateLimitError);
});

test("rate limit: a short Retry-After (secondary limit) is waited out once, then the call is retried", async () => {
  let n = 0;
  answer = () => (++n === 1 ? reply({ message: "secondary rate limit" }, 403, { "retry-after": "1" }) : reply({ ok: true }));
  const t0 = Date.now();
  expect(await request<unknown>("user", { token: "tok-a" })).toEqual({ ok: true });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  expect(seen).toHaveLength(2);
  // A long one is not waited out: the account is blocked and the error says when to retry.
  answer = () => reply({ message: "secondary rate limit" }, 429, { "retry-after": "600" });
  const err = await request("user", { token: "tok-b" }).catch((e) => e);
  expect(err).toBeInstanceOf(GitHubRateLimitError);
  expect(rateLimitedFor("tok-b")).toBeGreaterThan(500_000);
});

test("token per account: a pinned repo's paths use that login's token, every other path the active one, read once", async () => {
  setGithubAccounts([{ repoPath: "/r/hydra", worktreeRoot: "/r/hydra/.worktrees", githubUser: "finn-personal" }]);
  expect(await tokenFor("/r/hydra/.worktrees/feat")).toBe("tok-finn-personal");
  expect(await tokenFor("/r/app")).toBe("tok-active");
  expect(await tokenFor(undefined)).toBe("tok-active");
  await (await forRepo("/r/hydra")).rest("user");
  await (await forRepo("/r/app")).rest("user");
  expect(seen.map((s) => s.headers.Authorization)).toEqual(["Bearer tok-finn-personal", "Bearer tok-active"]);
  process.env.GH_TOKEN = "tok-env"; // GH_TOKEN overrides the active login, as it does for gh
  expect(await tokenFor("/r/app")).toBe("tok-env");
  expect(await tokenFor("/r/hydra")).toBe("tok-finn-personal");
});

test("errors: typed by status, worded like gh's `HTTP <status>: <message> (<path>)`, never with the token", async () => {
  const cases: Array<[number, unknown]> = [[401, GitHubAuthError], [404, GitHubNotFoundError], [422, GitHubError], [500, GitHubError]];
  for (const [status, type] of cases) {
    answer = () => reply({ message: `boom ${status}` }, status);
    const err = await request("repos/acme/app/pulls/1", { token: "tok-secret" }).catch((e) => e);
    expect(err).toBeInstanceOf(type as never);
    expect(err.status).toBe(status);
    expect(err.message).toBe(`HTTP ${status}: boom ${status} (repos/acme/app/pulls/1)`);
    expect(err.message).not.toContain("tok-secret");
  }
  answer = () => { throw new Error("connect ECONNREFUSED"); };
  const net = await request("user", { token: "tok-secret" }).catch((e) => e);
  expect(net).toBeInstanceOf(GitHubError);
  expect(net.status).toBe(0);
  expect(net.message).toContain("ECONNREFUSED");
});

test("a log download follows the redirect WITHOUT the token", async () => {
  answer = (s) => s.url.includes("/logs")
    ? new native.Response(null, { status: 302, headers: { location: "https://storage.test/log.txt" } })
    : new native.Response("line 1\nError: x", { status: 200 });
  const text = await request("repos/acme/app/actions/jobs/9/logs", { token: "tok-a", accept: "application/vnd.github.v3.raw", redirectWithoutAuth: true });
  expect(text).toBe("line 1\nError: x");
  expect(seen[1]!.url).toBe("https://storage.test/log.txt");
  expect(seen[1]!.headers.Authorization).toBeUndefined();
});

test("parseSlug reads owner/name from every GitHub remote form, nothing else", () => {
  expect(parseSlug("https://github.com/acme/app.git")).toBe("acme/app");
  expect(parseSlug("https://github.com/acme/app")).toBe("acme/app");
  expect(parseSlug("git@github.com:acme/my.app.git")).toBe("acme/my.app");
  expect(parseSlug("ssh://git@github.com/acme/app.git")).toBe("acme/app");
  expect(parseSlug("/tmp/origin.git")).toBeUndefined();
  expect(parseSlug("")).toBeUndefined();
});

test("repoSlug: the remote `gh repo set-default` marked, else origin, as gh resolved {owner}/{repo}", async () => {
  const repo = await makeScratchRepo();
  await run(["git", "-C", repo, "remote", "add", "origin", "git@github.com:me/app-fork.git"]);
  expect(await repoSlug(repo)).toBe("me/app-fork");
  resetCaches();
  await run(["git", "-C", repo, "remote", "add", "upstream", "https://github.com/acme/app.git"]);
  await run(["git", "-C", repo, "config", "remote.upstream.gh-resolved", "base"]);
  expect(await repoSlug(repo)).toBe("acme/app");
});
