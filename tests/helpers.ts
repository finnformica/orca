import { mkdtemp, writeFile, readFile, chmod, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../server/run";
import { setFetch } from "../server/github";
import { native } from "./happydom";

// Bun's own Response: a component test's happy-dom replaces the global one, which Bun.serve rejects.
const R = native.Response;

/** Create a throwaway git repo on `main` with one commit. Returns its path. */
export async function makeScratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-repo-"));
  await run(["git", "init", "-b", "main", dir]);
  await run(["git", "-C", dir, "config", "user.email", "test@orca.dev"]);
  await run(["git", "-C", dir, "config", "user.name", "Orca Test"]);
  await writeFile(join(dir, "README.md"), "# scratch\n");
  await run(["git", "-C", dir, "add", "."]);
  await run(["git", "-C", dir, "commit", "-m", "init"]);
  return dir;
}

// A `gh` stand-in for what is still the CLI: the auth flows (`auth status`, `auth token`), the
// identity lookup (`api user`) and `repo clone`. Accounts: ORCA_GH_ACCOUNTS lists logins, the first
// active; a token is tok-<login>. Every other GitHub call goes to FAKE_GITHUB below.
const GH_SHIM = `#!/bin/sh
[ -n "$ORCA_GH_ARGS_LOG" ] && echo "gh $*" >> "$ORCA_GH_ARGS_LOG"
case "$1 $2" in
  "auth status") first=1; for a in $ORCA_GH_ACCOUNTS; do echo "  ✓ Logged in to github.com account $a (keyring)"; [ $first = 1 ] && echo "  - Active account: true" || echo "  - Active account: false"; first=0; done ;;
  "auth token") shift 2; while [ $# -gt 0 ]; do [ "$1" = "--user" ] && { echo "tok-$2"; exit 0; }; shift; done; echo "tok-active" ;;
  "api user") printf '{"id":4242,"login":"%s","name":"Finn P","email":null}' "\${GH_TOKEN#tok-}" ;;
  "repo clone") git clone -q "$ORCA_GH_CLONE_SRC" "$4" ;;
  *) echo "fake-gh: unhandled: $*" >&2; exit 1 ;;
esac
`;

// A fake GitHub API (server/github.ts points at it through ORCA_GITHUB_API_URL): REST and GraphQL
// answered from the same fixture files the old `gh` shim read, gh-shaped fixtures converted to
// GraphQL's shape. No network. When ORCA_GH_ARGS_LOG is set, each request is one line in it:
// `<METHOD> <path> <json body>` for REST, `graphql <first field> <json variables> <query>` for
// GraphQL — so a test can assert which call was made, and which fields a query asks for.
// - `pr view` → ORCA_GH_FIXTURE; `pr list` → ORCA_PRLIST_FIXTURE (merged/closed: ORCA_PRLIST_DONE_FIXTURE).
// - ORCA_GH_STACKED: a merge fails the way GitHub refuses a stacked PR; merge-async answers
//   ORCA_GH_MERGE_ASYNC. ORCA_GH_NO_AUTO: auto-merge fails the way a repo without it refuses it.
//   ORCA_GH_CLEAN_STATUS: auto-merge fails the way GitHub refuses it on a PR that is already clean
//   to merge (CLEAN) or only has advisory checks failing (UNSTABLE).
// - ORCA_GH_VIEW_DENY: logins whose token cannot see a repository (server/repos.ts tries the next).
const env = (k: string) => process.env[k];
const read = async (k: string): Promise<string | undefined> => { const f = env(k); if (!f) return undefined; try { return await readFile(f, "utf8"); } catch { return undefined; } };
const readJson = async (k: string, fallback: unknown): Promise<any> => { const t = await read(k); try { return t ? JSON.parse(t) : fallback; } catch { return fallback; } };
const conn = (a: unknown) => (Array.isArray(a) ? { nodes: a } : a);
/** A gh `--json` PR fixture in GraphQL's shape (the inverse of gh.ts `flatPr`). */
export function toGraphqlPr(f: any): any {
  if (!f || typeof f !== "object") return f;
  const out: any = { ...f };
  for (const k of ["comments", "reviews", "labels", "files"]) if (k in f) out[k] = conn(f[k]);
  if ("statusCheckRollup" in f) {
    const nodes = (f.statusCheckRollup ?? []).map((c: any) => ("state" in c && !("conclusion" in c))
      ? { __typename: "StatusContext", ...c, createdAt: c.startedAt }
      : { __typename: "CheckRun", ...c });
    out.commits = { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] };
    delete out.statusCheckRollup;
  }
  if (f.author) out.author = { __typename: f.author.is_bot ? "Bot" : "User", ...f.author };
  return out;
}
const STACKED_MSG = "This pull request is part of a stack and must be merged using the asynchronous merge REST API. For more information, see https://docs.github.com/rest/pulls/pulls#merge-a-pull-request-asynchronously";
const json = (body: unknown, status = 200) => new R(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const gqlError = (message: string, path: string, type?: string) => json({ data: null, errors: [{ message, path: [path], ...(type ? { type } : {}) }] });
async function logLine(line: string): Promise<void> {
  const f = env("ORCA_GH_ARGS_LOG");
  if (f) await appendFile(f, `${line}\n`);
}

async function fakeGraphql(query: string, vars: Record<string, any>, token: string): Promise<Response> {
  const field = /\{\s*(\w+)/.exec(query)?.[1] ?? "";
  await logLine(`graphql ${field} ${JSON.stringify(vars)} ${query}`);
  if (/^\s*mutation/.test(query)) {
    const name = /\{\s*(\w+)\(/.exec(query)?.[1] ?? "";
    if (name === "enablePullRequestAutoMerge" && env("ORCA_GH_NO_AUTO")) return gqlError("Auto merge is not allowed for this repository", name);
    if (name === "enablePullRequestAutoMerge" && env("ORCA_GH_CLEAN_STATUS")) return gqlError("Pull request is in clean status", name);
    if ((name === "mergePullRequest" || name === "enablePullRequestAutoMerge") && env("ORCA_GH_STACKED")) return gqlError(STACKED_MSG, name);
    return json({ data: { [name]: { clientMutationId: null } } });
  }
  if (field === "search") {
    const key = /is:(merged|closed)/.test(String(vars.q)) && env("ORCA_PRLIST_DONE_FIXTURE") ? "ORCA_PRLIST_DONE_FIXTURE" : "ORCA_PRLIST_FIXTURE";
    const list = await readJson(key, undefined) as any[] | undefined;
    if (!Array.isArray(list)) return json({ message: `fake-github: no ${key}` }, 502); // what `cat` of a missing fixture did
    return json({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: list.map(toGraphqlPr) } } });
  }
  if (field === "viewer") return json({ data: { viewer: { repositories: { nodes: await readJson("ORCA_GH_REPOLIST_FIXTURE", []) } } } });
  if (field === "repositoryOwner") return json({ data: { repositoryOwner: { repositories: { nodes: await readJson(env("ORCA_GH_ORGREPOLIST_FIXTURE") ? "ORCA_GH_ORGREPOLIST_FIXTURE" : "ORCA_GH_REPOLIST_FIXTURE", []) } } } });
  if (/reviewThreads/.test(query)) return json(await readJson("ORCA_GH_GRAPHQL_FIXTURE", { data: null }));
  if (/pullRequest\(number/.test(query)) {
    const pr = toGraphqlPr(await readJson("ORCA_GH_FIXTURE", {}));
    return json({ data: { repository: { pullRequest: { id: `PR_${vars.number}`, ...pr } } } });
  }
  if (field === "repository") {
    for (const d of (env("ORCA_GH_VIEW_DENY") ?? "").split(/\s+/).filter(Boolean)) {
      if (token === `tok-${d}`) return gqlError(`Could not resolve to a Repository with the name '${vars.owner}/${vars.name}'.`, "repository", "NOT_FOUND");
    }
    return json({ data: { repository: await readJson("ORCA_GH_REPO_FIXTURE", null) } });
  }
  return gqlError(`fake-github: unhandled query ${field}`, field);
}

async function fakeRest(req: Request, url: URL): Promise<Response> {
  const path = url.pathname + url.search;
  const text = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
  await logLine(`${req.method} ${path}${text ? ` ${text}` : ""}`);
  const p = url.pathname;
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (p === "/user") return json({ id: 4242, login: token.replace(/^tok-/, ""), name: "Finn P", email: null });
  if (p === "/user/orgs") return json(await readJson("ORCA_GH_ORGS_FIXTURE", []));
  if (req.method === "DELETE") return new R(null, { status: 204 });
  if (/\/merge-async/.test(p)) return new R(env("ORCA_GH_MERGE_ASYNC") || '{"status":"merged"}', { headers: { "content-type": "application/json" } });
  if (/\/rules\/branches\//.test(p)) return json(await readJson("ORCA_GH_RULES_FIXTURE", []));
  if (/\/git\/matching-refs\//.test(p)) return json(await readJson("ORCA_GH_REFS_FIXTURE", []));
  if (/\/actions\/runs\/\d+\/jobs$/.test(p)) return json({ jobs: [{ id: 1, name: "test", conclusion: "failure" }, { id: 2, name: "lint", conclusion: "success" }] });
  if (p.startsWith("/_logs/")) return req.headers.get("authorization") ? new R("token leaked to the log host", { status: 403 }) : new R(await read("ORCA_GH_RUN_LOG_FIXTURE") ?? "");
  if (/\/actions\/jobs\/\d+\/logs$/.test(p)) return new R(null, { status: 302, headers: { location: `${url.origin}/_logs${p}` } });
  if (/\/pulls$/.test(p) && req.method === "POST") { const n = Number(env("ORCA_PR_NUMBER") ?? 123); return json({ number: n, html_url: `https://github.com/acme/app/pull/${n}` }, 201); }
  if (/\/pulls\/\d+$/.test(p)) {
    if (req.method !== "GET") return json({});
    if (/diff/.test(req.headers.get("accept") ?? "")) return new R("diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n+added line\n-removed line\n", { headers: { "content-type": "application/vnd.github.diff" } });
    return json({ number: Number(p.split("/").at(-1)), body: (await readJson("ORCA_GH_FIXTURE", {})).body ?? "" });
  }
  if (/\/issues\/\d+\/labels$/.test(p)) return json([]);
  return json({ message: `fake-github: unhandled ${req.method} ${path}` }, 404);
}

let fakeGithub: ReturnType<typeof Bun.serve> | undefined;
/** Start the fake GitHub API once per process and point server/github.ts at it. */
export function installFakeGithub(): void {
  fakeGithub ??= Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      // A slow GitHub: every answer waits while the file `ORCA_FAKE_GH_HOLD` names exists.
      for (let hold = env("ORCA_FAKE_GH_HOLD"); hold && existsSync(hold);) await Bun.sleep(20);
      const url = new URL(req.url);
      if (url.pathname === "/graphql" && req.method === "POST") {
        const body = await req.json() as { query: string; variables?: Record<string, unknown> };
        return fakeGraphql(body.query, body.variables ?? {}, (req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
      }
      return fakeRest(req, url);
    },
  });
  fakeGithub.unref();
  setFetch(native.fetch); // happy-dom's fetch CORS-blocks a real port
  process.env.ORCA_GITHUB_API_URL = `http://127.0.0.1:${fakeGithub.port}`;
  process.env.ORCA_GITHUB_REPO = "acme/app"; // the scratch repos have no GitHub remote
}

let realPath: string | undefined;

/** Prepend a fake `gh` to PATH and start the fake GitHub API. Call restorePath() when done. */
export async function installFakeGh(): Promise<void> {
  installFakeGithub();
  const dir = await mkdtemp(join(tmpdir(), "orca-shim-"));
  const gh = join(dir, "gh");
  await writeFile(gh, GH_SHIM);
  await chmod(gh, 0o755);
  realPath = process.env.PATH;
  process.env.PATH = `${dir}:${realPath}`;
}

export function restorePath(): void {
  if (realPath !== undefined) process.env.PATH = realPath;
}

/** Point the fake `gh pr view` at a canned status JSON. */
export async function setPrFixture(status: {
  state: string;
  mergeable: string;
  reviewDecision: string;
  statusCheckRollup: Array<{ name?: string; context?: string; conclusion?: string; state?: string }>;
  baseRefName?: string;
}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orca-fx-"));
  const path = join(dir, "pr.json");
  await writeFile(path, JSON.stringify(status));
  process.env.ORCA_GH_FIXTURE = path;
}

/** Point the fake `gh pr view` at an arbitrary JSON object (for pr-detail tests). */
export async function setViewFixture(obj: unknown): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orca-fxv-"));
  const path = join(dir, "view.json");
  await writeFile(path, JSON.stringify(obj));
  process.env.ORCA_GH_FIXTURE = path;
}

/** Point the fake `gh pr list` at a canned array of PRs. */
export async function setPrListFixture(prs: unknown[]): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orca-fxl-"));
  const path = join(dir, "prs.json");
  await writeFile(path, JSON.stringify(prs));
  process.env.ORCA_PRLIST_FIXTURE = path;
}

/** Point the fake `gh pr list --state merged|closed` at its own list (unset: the open list's). */
export async function setDonePrListFixture(prs: unknown[]): Promise<void> {
  process.env.ORCA_PRLIST_DONE_FIXTURE = await fixtureEnv("done", JSON.stringify(prs));
}

async function fixtureEnv(prefix: string, value: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `orca-${prefix}-`));
  const path = join(dir, "fixture");
  await writeFile(path, value);
  return path;
}

export async function setReviewEvidenceFixture(obj: unknown): Promise<void> {
  process.env.ORCA_GH_REPO_FIXTURE = await fixtureEnv("repo", JSON.stringify({ nameWithOwner: "acme/app" }));
  process.env.ORCA_GH_GRAPHQL_FIXTURE = await fixtureEnv("graphql", JSON.stringify(obj));
}

/** Point the fake `gh api …/git/matching-refs/…` at these ref names. */
export async function setRefsFixture(refs: string[]): Promise<void> {
  process.env.ORCA_GH_REFS_FIXTURE = await fixtureEnv("refs", JSON.stringify(refs.map((ref) => ({ ref }))));
}

export async function setRunLogFixture(log: string): Promise<void> {
  process.env.ORCA_GH_RUN_LOG_FIXTURE = await fixtureEnv("run-log", log);
}

/** Point the fake `gh api .../rules/branches/*` at a canned rules array (what requiredChecks parses).
 *  Pass the required check names; unset (or []) means no branch protection. */
export async function setRequiredChecksFixture(contexts: string[]): Promise<void> {
  const rules = contexts.length ? [{ type: "required_status_checks", parameters: { required_status_checks: contexts.map((context) => ({ context })) } }] : [];
  process.env.ORCA_GH_RULES_FIXTURE = await fixtureEnv("rules", JSON.stringify(rules));
}

/** Start recording every fake-`gh` invocation's args; returns a reader for what's been logged. */
export async function recordGhArgs(): Promise<() => Promise<string>> {
  const dir = await mkdtemp(join(tmpdir(), "orca-args-"));
  const path = join(dir, "args.log");
  await writeFile(path, "");
  process.env.ORCA_GH_ARGS_LOG = path;
  return async () => readFile(path, "utf8");
}

// A `docker` stand-in for server/docker.ts: `ps --filter name=X --format {{.Names}}` lists the
// fixture's container names, `inspect -f {{.Created}} <name>` prints that container's canned
// creation timestamp, `rm -f <name>` records the removal. Same shape as GH_SHIM.
const DOCKER_SHIM = `#!/bin/sh
case "$1" in
  ps) cat "$ORCA_DOCKER_PS_FIXTURE" 2>/dev/null ;;
  inspect) awk -F'\\t' -v n="$4" '$1==n{print $2}' "$ORCA_DOCKER_CREATED_FIXTURE" ;;
  rm) [ -n "$ORCA_DOCKER_RM_LOG" ] && echo "$3" >> "$ORCA_DOCKER_RM_LOG" ;;
  *) echo "fake-docker: unhandled: $*" >&2; exit 1 ;;
esac
`;

let realDockerPath: string | undefined;

/** Prepend a fake `docker` to PATH and point it at the given containers (name + RFC3339 `.Created`
 *  timestamp, e.g. from `new Date(...).toISOString()`). Returns a reader for the names `docker rm -f`
 *  was actually called with. Call restoreDockerPath() when done. */
export async function installFakeDocker(containers: { name: string; createdAt: string }[]): Promise<() => Promise<string[]>> {
  const dir = await mkdtemp(join(tmpdir(), "orca-dshim-"));
  const docker = join(dir, "docker");
  await writeFile(docker, DOCKER_SHIM);
  await chmod(docker, 0o755);
  await writeFile(join(dir, "ps.fixture"), containers.map((c) => c.name).join("\n") + (containers.length ? "\n" : ""));
  await writeFile(join(dir, "created.fixture"), containers.map((c) => `${c.name}\t${c.createdAt}`).join("\n") + "\n");
  await writeFile(join(dir, "rm.log"), "");
  process.env.ORCA_DOCKER_PS_FIXTURE = join(dir, "ps.fixture");
  process.env.ORCA_DOCKER_CREATED_FIXTURE = join(dir, "created.fixture");
  process.env.ORCA_DOCKER_RM_LOG = join(dir, "rm.log");
  realDockerPath = process.env.PATH;
  process.env.PATH = `${dir}:${realDockerPath}`;
  return async () => (await readFile(join(dir, "rm.log"), "utf8")).split("\n").filter(Boolean);
}

export function restoreDockerPath(): void {
  if (realDockerPath !== undefined) process.env.PATH = realDockerPath;
}
