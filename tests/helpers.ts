import { mkdtemp, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../server/run";

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

// A `gh` stand-in: `pr create` prints a URL, `pr view` cats the fixture file,
// `pr merge` succeeds (or, with ORCA_GH_STACKED set, fails the way GitHub refuses a stacked PR, and
// the merge-async endpoint answers ORCA_GH_MERGE_ASYNC; with ORCA_GH_NO_AUTO set, `--auto` fails the
// way a repo without auto-merge enabled refuses it). Same code path as real gh, no network. When ORCA_GH_ARGS_LOG is set it
// records each invocation's args, so a test can assert *which* --json fields we ask gh for (the
// shim otherwise ignores the field list — cat'ing the whole fixture regardless).
const GH_SHIM = `#!/bin/sh
[ -n "$ORCA_GH_ARGS_LOG" ] && echo "$*" >> "$ORCA_GH_ARGS_LOG"
case "$*" in *merge-async*) if [ -n "$ORCA_GH_MERGE_ASYNC" ]; then echo "$ORCA_GH_MERGE_ASYNC"; else echo '{"status":"merged"}'; fi; exit 0 ;; esac
# pr-assets cleanup (server/prShots.ts): the matching refs from ORCA_GH_REFS_FIXTURE, a DELETE succeeds.
case "$*" in *git/matching-refs/*) cat "$ORCA_GH_REFS_FIXTURE" 2>/dev/null || echo '[]'; exit 0 ;; "api -X DELETE "*) exit 0 ;; esac
case "$1 $2" in
  "pr create") echo "https://github.com/acme/app/pull/\${ORCA_PR_NUMBER:-123}" ;;
  "pr view") cat "$ORCA_GH_FIXTURE" ;;
  "pr list") case "$*" in *"--state merged"*|*"--state closed"*) [ -n "$ORCA_PRLIST_DONE_FIXTURE" ] && { cat "$ORCA_PRLIST_DONE_FIXTURE"; exit 0; } ;; esac
    cat "$ORCA_PRLIST_FIXTURE" ;;
  "pr diff") printf 'diff --git a/x.ts b/x.ts\\n@@ -1 +1 @@\\n+added line\\n-removed line\\n' ;;
  # ORCA_GH_VIEW_DENY lists logins (space-separated) whose GH_TOKEN makes repo view fail, the way
  # GitHub refuses a repo the token's account can't see (server/repos.ts tries the next login).
  "repo view") for d in $ORCA_GH_VIEW_DENY; do [ "$GH_TOKEN" = "tok-$d" ] && { echo "GraphQL: Could not resolve to a Repository with the name '$3'." >&2; exit 1; }; done
    cat "$ORCA_GH_REPO_FIXTURE" ;;
  # Accounts (server/repos.ts, server/env.ts): ORCA_GH_ACCOUNTS lists logins, the first active; a token is tok-<login>.
  "auth status") first=1; for a in $ORCA_GH_ACCOUNTS; do echo "  ✓ Logged in to github.com account $a (keyring)"; [ $first = 1 ] && echo "  - Active account: true" || echo "  - Active account: false"; first=0; done ;;
  "auth token") shift 2; while [ $# -gt 0 ]; do [ "$1" = "--user" ] && { echo "tok-$2"; exit 0; }; shift; done; echo "tok-active" ;;
  # repo list with no owner lists the account's own repos; repo list <org> (ORCA_GH_ORGREPOLIST_FIXTURE)
  # lists an org's — server/repos.ts also asks for each org via api user/orgs (ORCA_GH_ORGS_FIXTURE).
  "repo list") if [ "$3" = "--limit" ]; then cat "$ORCA_GH_REPOLIST_FIXTURE"; else cat "\${ORCA_GH_ORGREPOLIST_FIXTURE:-$ORCA_GH_REPOLIST_FIXTURE}"; fi ;;
  "api user/orgs") [ -n "$ORCA_GH_ORGS_FIXTURE" ] && cat "$ORCA_GH_ORGS_FIXTURE" || echo '[]' ;;
  "api user") printf '{"id":4242,"login":"%s","name":"Finn P","email":null}' "\${GH_TOKEN#tok-}" ;;
  "repo clone") git clone -q "$ORCA_GH_CLONE_SRC" "$4" ;;
  "api graphql") cat "$ORCA_GH_GRAPHQL_FIXTURE" ;;
  *rules/branches*) cat "$ORCA_GH_RULES_FIXTURE" 2>/dev/null || echo '[]' ;;
  "run view") cat "$ORCA_GH_RUN_LOG_FIXTURE" ;;
  "pr merge") case "$*" in *--auto*) [ -n "$ORCA_GH_NO_AUTO" ] && { echo "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)" >&2; exit 1; } ;; esac
    [ -n "$ORCA_GH_STACKED" ] && { echo "GraphQL: This pull request is part of a stack and must be merged using the asynchronous merge REST API. For more information, see https://docs.github.com/rest/pulls/pulls#merge-a-pull-request-asynchronously (mergePullRequest)" >&2; exit 1; }; exit 0 ;;
  "pr ready") exit 0 ;;
  "pr edit") exit 0 ;;
  *) echo "fake-gh: unhandled: $*" >&2; exit 1 ;;
esac
`;

let realPath: string | undefined;

/** Prepend a fake `gh` to PATH. Call restorePath() when done. */
export async function installFakeGh(): Promise<void> {
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
  statusCheckRollup: Array<{ conclusion?: string; state?: string }>;
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
