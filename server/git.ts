import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { dlopen, FFIType, suffix } from "bun:ffi";
import { run } from "./run";
import { changelogOnlyConflict, defaultPrBody, type MechanicalMerge, type SyncOutcome, type SyncResult } from "../web/src/workstream";

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

// APFS copy-on-write directory clone via clonefile(2) — clones a whole tree in O(1) (block-shared
// until modified). Bound lazily; on any non-macOS/non-APFS context the binding or the call fails
// and callers fall back. clonefile requires `dst` to not already exist.
let _clonefile: ((src: Buffer, dst: Buffer, flags: number) => number) | null | undefined;
function cloneTree(src: string, dst: string): boolean {
  if (_clonefile === undefined) {
    try {
      _clonefile = dlopen(`libSystem.${suffix}`, {
        clonefile: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
      }).symbols.clonefile as (s: Buffer, d: Buffer, f: number) => number;
    } catch { _clonefile = null; }
  }
  if (!_clonefile) return false;
  try { return _clonefile(Buffer.from(`${src}\0`), Buffer.from(`${dst}\0`), 0) === 0; }
  catch { return false; }
}

export type FileChange = { path: string; additions: number; deletions: number };
export type Commit = { hash: string; subject: string };
export type ChangeSummary = {
  files: FileChange[];
  commits: Commit[];
  additions: number;
  deletions: number;
};

const git = (repoPath: string, ...args: string[]) => run(["git", "-C", repoPath, ...args]);

const branchExists = async (repoPath: string, branch: string) => {
  try { await git(repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`); return true; } catch { return false; }
};

/** A branch name not already taken (appends -2, -3, … on collision). */
export async function uniqueBranch(repoPath: string, branch: string): Promise<string> {
  if (!(await branchExists(repoPath, branch))) return branch;
  for (let i = 2; ; i++) {
    const candidate = `${branch}-${i}`;
    if (!(await branchExists(repoPath, candidate))) return candidate;
  }
}

/**
 * Resolve the base ref to diff/merge against. Prefers the remote-tracking `origin/<base>` over the
 * local branch, which is frequently stale (behind origin) and would make change summaries include
 * commits already merged upstream — the exact "why are there 6 commits?" surprise. Falls back to
 * the local ref for local-only repos (no origin).
 */
export async function resolveBase(repoPath: string, base: string): Promise<string> {
  const remote = `origin/${base}`;
  try {
    await git(repoPath, "rev-parse", "--verify", "--quiet", remote);
    return remote;
  } catch {
    return base;
  }
}

/** Create a new branch + worktree off `base`. Branch name is made unique on collision. */
export async function createWorktree(
  repoPath: string,
  worktreeRoot: string,
  branch: string,
  base: string,
): Promise<{ branch: string; worktreePath: string }> {
  branch = await uniqueBranch(repoPath, branch);
  const worktreePath = join(worktreeRoot, branch);
  // Do deterministic synchronization here instead of spending agent turns on fetch/merge setup.
  await git(repoPath, "fetch", "origin", base).catch(() => {}); // local-only repos have no origin
  const start = await resolveBase(repoPath, base);
  await git(repoPath, "worktree", "add", "-b", branch, worktreePath, start);
  return { branch, worktreePath };
}

/**
 * Create or refresh a DETACHED worktree at the latest `base` — for previewing the base branch
 * itself ("test master": confirm on a clean main whether a bug is already fixed / still there).
 * Fetches origin so it's current, then checks out the resolved base ref detached. Detached is the
 * point: with no `branch refs/heads/…` line it's invisible to `listWorktrees`, so it never shows up
 * as a board workstream. Reused across runs (its copied env + linked node_modules stay in place),
 * just moved to the newest base each time.
 */
export async function baseWorktree(repoPath: string, worktreeRoot: string, base: string): Promise<{ worktreePath: string }> {
  await git(repoPath, "worktree", "prune").catch(() => {}); // clear stale registrations
  await git(repoPath, "fetch", "origin", base).catch(() => {}); // best-effort; local-only repos have no origin
  const ref = await resolveBase(repoPath, base); // origin/<base> when present (newest), else the local branch
  const worktreePath = join(worktreeRoot, base);
  try {
    await git(worktreePath, "checkout", "--detach", ref); // existing worktree → move it to the newest base
  } catch {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {}); // clear any stale/leftover dir
    await git(repoPath, "worktree", "add", "--detach", worktreePath, ref);
  }
  return { worktreePath };
}

/** List worktrees under `worktreeRoot` (excludes the main working tree). */
export async function listWorktrees(
  repoPath: string,
  worktreeRoot: string,
): Promise<{ branch: string; worktreePath: string; head?: string }[]> {
  const out = await git(repoPath, "worktree", "list", "--porcelain");
  const root = real(worktreeRoot); // resolve symlinks (macOS /var → /private/var)
  const result: { branch: string; worktreePath: string; head?: string }[] = [];
  for (const block of out.split("\n\n")) {
    const worktreePath = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    // HEAD's sha rides along free: it tells a merged PR's leftover worktree from a reused branch.
    const head = block.match(/^HEAD ([0-9a-f]+)$/m)?.[1];
    if (worktreePath && branch && real(worktreePath).startsWith(root)) result.push({ branch, worktreePath, head });
  }
  return result;
}

/**
 * Fast-forward ONE worktree's branch to its upstream. Safety is the point — never forces, never
 * discards local work: a dirty tree, a diverged branch (no fast-forward possible), or a branch with
 * no upstream is left untouched and reported. Assumes the repo's remote was already fetched.
 */
async function syncWorktree(worktreePath: string): Promise<SyncOutcome> {
  if ((await git(worktreePath, "status", "--porcelain")).trim()) return "dirty";
  try {
    await git(worktreePath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"); // errors with no upstream
  } catch {
    return "no upstream";
  }
  const [local, remote] = await Promise.all([
    git(worktreePath, "rev-parse", "HEAD").then((s) => s.trim()),
    git(worktreePath, "rev-parse", "@{u}").then((s) => s.trim()),
  ]);
  if (local === remote) return "up to date";
  try {
    await git(worktreePath, "merge", "--ff-only", "@{u}"); // refuses (exits non-zero) if not a fast-forward
    return "synced";
  } catch {
    return "diverged";
  }
}

/**
 * Pull remote work down into local worktrees: fetch the repo's remote ONCE, then fast-forward every
 * worktree's branch to its upstream. Returns a per-branch outcome. Never forces or discards local
 * work (see syncWorktree) — dirty/diverged/no-upstream worktrees are skipped and reported.
 */
export async function syncWorktrees(repoPath: string, worktreeRoot: string): Promise<SyncResult[]> {
  await git(repoPath, "fetch").catch(() => {}); // best-effort; local-only repos have no remote
  const worktrees = await listWorktrees(repoPath, worktreeRoot);
  return Promise.all(worktrees.map(async ({ branch, worktreePath }) => ({ branch, outcome: await syncWorktree(worktreePath) })));
}

/** Add a worktree for an EXISTING branch (adopt a PR). Fetches the remote branch first. */
export async function adoptWorktree(
  repoPath: string,
  worktreeRoot: string,
  branch: string,
): Promise<{ branch: string; worktreePath: string }> {
  await git(repoPath, "worktree", "prune").catch(() => {}); // clear stale registrations
  await git(repoPath, "fetch", "origin", branch).catch(() => {}); // best-effort; may be local-only
  const worktreePath = join(worktreeRoot, branch);
  await rm(worktreePath, { recursive: true, force: true }).catch(() => {}); // clear any leftover dir
  // --force fallback: the branch may already be checked out in the main working tree (e.g. you
  // `git switch`ed to it) — git refuses a second checkout without it. A preview only reads the
  // tree, so a shared checkout is safe.
  const add = (...args: string[]) =>
    git(repoPath, "worktree", "add", ...args).catch(() => git(repoPath, "worktree", "add", "--force", ...args));
  if (await branchExists(repoPath, branch)) {
    await add(worktreePath, branch);
  } else {
    await add("--track", "-b", branch, worktreePath, `origin/${branch}`);
  }
  return { branch, worktreePath };
}

/**
 * Copy gitignored config (e.g. `backend/.env`) from the main repo into a worktree — a fresh
 * checkout only has tracked files, so local secrets/integrations would otherwise be missing and
 * the previewed app boots without its API keys. Best-effort per file (missing ones are skipped).
 */
export async function copyToWorktree(
  repoPath: string, worktreePath: string, paths: string[] = [],
  // Preview start re-runs this to self-heal a worktree that never got the file (created before the
  // config listed it, or it was deleted) — the same way previewDeps self-heals node_modules. There
  // it must NOT clobber a worktree-local edit, so existing files are left alone.
  options: { keepExisting?: boolean } = {},
): Promise<void> {
  await Promise.all(paths.map((rel) =>
    cp(join(repoPath, rel), join(worktreePath, rel), {
      recursive: true, force: !options.keepExisting, errorOnExist: false,
    }).catch(() => {})));
}

/**
 * Provision heavy shared dirs (e.g. `node_modules`) from the main repo into a worktree — a fresh
 * checkout has none, and a real per-worktree install is slow + disk-heavy. Best-effort per path.
 *
 * `node_modules` is special-cased: it's CLONED, not symlinked, via APFS copy-on-write (clonefile).
 * A copy-on-write clone is near-instant and shares disk blocks with the source until a file is
 * modified, so it costs almost nothing — but each worktree gets a fully INDEPENDENT tree. That
 * isolation is the point: when worktrees shared one node_modules (a whole-dir symlink, or even
 * per-entry symlinks), any process mutating it — an `npm install` self-heal, an agent adding a
 * dep, Vite rewriting `.vite/deps` — corrupted every other concurrent preview reading the same
 * files. The worst symptom was mikro-orm's "only abstract entities discovered" when a preview ran
 * `cache:generate` while the shared `@mikro-orm/core` was mid-rewrite, plus Vite 504s from a shared
 * `.vite/deps`. With a per-worktree clone, no worktree can perturb another's deps.
 *
 * Falls back to the old per-entry symlink if the clone fails (e.g. a non-APFS volume where
 * clonefile isn't supported) — shared but functional. Other (non-node_modules) paths stay symlinked.
 */
export async function linkToWorktree(repoPath: string, worktreePath: string, paths: string[] = []): Promise<void> {
  await Promise.all(paths.map(async (rel) => {
    const src = join(repoPath, rel);
    const dest = join(worktreePath, rel);
    await mkdir(dirname(dest), { recursive: true }).catch(() => {});
    await rm(dest, { recursive: true, force: true }).catch(() => {}); // replace any stale entry; clonefile needs dest absent
    if (basename(rel) !== "node_modules") {
      await symlink(src, dest).catch(() => {});
      return;
    }
    // APFS CoW directory clone: ~2s for an 82k-file node_modules (vs ~40s for per-file `cp -c`),
    // block-shared with the source until modified, but a fully independent tree per worktree.
    if (cloneTree(src, dest)) return;
    // Linux: GNU cp's reflink is the same idea (block-shared on btrfs/xfs, a real copy elsewhere);
    // either way the worktree gets its own tree, which is the property that matters.
    if (process.platform === "linux" && Bun.spawnSync(["cp", "-a", "--reflink=auto", src, dest]).exitCode === 0) return;
    // Non-APFS / clonefile unavailable → degrade to the old per-entry symlink (keeps .vite local).
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    await mkdir(dest, { recursive: true }).catch(() => {});
    const entries = await readdir(src).catch(() => [] as string[]);
    await Promise.all(entries
      .filter((e) => !e.startsWith(".vite"))
      .map((e) => symlink(join(src, e), join(dest, e)).catch(() => {})));
  }));
}

/** Why a worktree is up for cleanup: its PR merged, its PR was closed unmerged, or its workstream
 *  was archived while the worktree stayed behind. */
export type ReapReason = "merged" | "closed" | "archived";

const commitExists = (cwd: string, ref: string) =>
  git(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`).then(() => true, () => false);

/** Is `maybeAncestor` already part of `head`'s history, or `head` itself (`mergedPrIsHistory`'s
 *  `headBehindPr`)? A worktree whose branch was last pushed from somewhere else never fetched that
 *  commit, so a plain `merge-base --is-ancestor` on it errors on the unknown object instead of
 *  answering "no" — fetch `branch` once and retry before giving up. Best-effort: a failed fetch
 *  (offline, local-only repo) just leaves the check unconfirmed. */
export async function isAncestor(repoPath: string, maybeAncestor: string, head: string, branch: string): Promise<boolean> {
  const check = () => git(repoPath, "merge-base", "--is-ancestor", maybeAncestor, head).then(() => true, () => false);
  if (await check()) return true;
  await git(repoPath, "fetch", "origin", branch).catch(() => {});
  return check();
}

/** How many commits on `ref` exist nowhere else: on no remote-tracking branch, not in `base`, and
 *  not in `head` (a PR's last pushed commit — after a squash merge GitHub deletes the remote branch
 *  and a prune drops it from `--remotes`, yet those commits were pushed). A ref git can't read counts
 *  as one unpushed commit, so a cleanup errs toward keeping it. */
export async function unpushedCount(repoPath: string, ref: string, opts: { base?: string; head?: string } = {}): Promise<number> {
  const not = ["--remotes"];
  for (const r of [opts.base, opts.head]) if (r && await commitExists(repoPath, r)) not.push(r);
  try {
    return (await git(repoPath, "rev-list", ref, "--not", ...not)).split("\n").filter(Boolean).length;
  } catch { return 1; }
}

/** What removing a worktree would lose: paths with uncommitted changes (tracked edits and untracked
 *  files, minus `ignore` — the repo's own copied/linked entries, e.g. a symlinked node_modules that a
 *  `node_modules/` pattern does not match) and the branch's commits that exist nowhere else. A
 *  worktree directory that is already gone has no uncommitted work. */
export async function worktreeSafety(
  repoPath: string, w: { branch: string; worktreePath: string }, opts: { base?: string; head?: string; ignore?: string[] } = {},
): Promise<{ dirty: string[]; unpushed: number }> {
  const ignore = new Set((opts.ignore ?? []).map((p) => p.replace(/\/+$/, "")));
  let dirty: string[] = [];
  if (existsSync(w.worktreePath)) {
    try {
      dirty = (await git(w.worktreePath, "status", "--porcelain")).split("\n").filter(Boolean)
        .map((l) => l.slice(3).replace(/^"|"$/g, "").replace(/\/$/, ""))
        .filter((p) => !ignore.has(p));
    } catch { dirty = ["(git status failed)"]; }
  }
  return { dirty, unpushed: await unpushedCount(repoPath, `refs/heads/${w.branch}`, opts) };
}

/** Every local branch and the worktree it is checked out in ("" for none). */
export async function localBranches(repoPath: string): Promise<{ branch: string; worktreePath: string }[]> {
  const out = await git(repoPath, "for-each-ref", "refs/heads", "--format=%(refname:short)%09%(worktreepath)");
  return out.split("\n").filter(Boolean).map((l) => { const [branch = "", worktreePath = ""] = l.split("\t"); return { branch, worktreePath }; });
}

/** Remove a worktree (does NOT touch the branch — that's an explicit, separate op). */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, "worktree", "remove", "--force", worktreePath);
}

/** Delete a local branch (best-effort). Only call for branches with no open PR. */
export const deleteBranch = (repoPath: string, branch: string) => git(repoPath, "branch", "-D", branch).catch(() => {});

/** Push a branch to origin (setting upstream) so a PR can be opened against it. A worktree branch
 *  created/adopted locally isn't on the remote yet, and `gh pr create` needs it there. */
export const pushBranch = (worktreePath: string, branch: string) =>
  git(worktreePath, "push", "-u", "origin", branch);

/** Does the repo have any git remote? (Determines PR vs local-only lifecycle.) */
export async function hasRemote(repoPath: string): Promise<boolean> {
  try { return (await git(repoPath, "remote")).trim().length > 0; } catch { return false; }
}

/** Whether `branch` merges into `base` cleanly, per `git merge-tree` (no working-tree changes). */
export async function mergeClean(repoPath: string, base: string, branch: string): Promise<"clean" | "conflict"> {
  try {
    await git(repoPath, "merge-tree", "--write-tree", base, branch); // exits non-zero on conflict
    return "clean";
  } catch {
    return "conflict";
  }
}

/** Merge a branch into `base` locally (no remote). Guarded: base must be checked out & clean. */
export async function mergeLocal(repoPath: string, base: string, branch: string): Promise<void> {
  const cur = (await git(repoPath, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  if (cur !== base) throw new Error(`check out ${base} in the repo first (currently on ${cur})`);
  if ((await git(repoPath, "status", "--porcelain")).trim()) throw new Error("repo working tree is not clean");
  await git(repoPath, "merge", "--no-ff", "--no-edit", branch);
}

/** Diff + commit summary of a worktree's branch against `base`. */
/** Full patch of the branch vs its base — powers the Files tab on the local-session detail view. */
// GitHub's standard PR-template locations (root, docs/, .github/), tried in that order. Read from
// the worktree so it reflects the template checked in on this branch.
const PR_TEMPLATE_PATHS = [
  ".github/PULL_REQUEST_TEMPLATE.md", ".github/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md", "pull_request_template.md",
];

/** The repo's checked-in PR template (its own guidelines), read from the worktree so it reflects
 *  this branch, or null if there isn't one. Shared by the deterministic body and the AI writer. */
export async function readPrTemplate(worktreePath: string): Promise<string | null> {
  for (const rel of PR_TEMPLATE_PATHS) {
    const f = Bun.file(join(worktreePath, rel));
    if (await f.exists()) {
      const text = (await f.text()).trim();
      if (text) return text;
    }
  }
  return null;
}

/** Legacy deterministic body helper: the repo's template when present, otherwise commit subjects.
 *  Promote now requires the implementation agent to fill the template; this remains useful to
 *  callers that explicitly need a non-AI summary. */
export async function resolvePrBody(worktreePath: string, base: string, provided?: string): Promise<string> {
  if (provided?.trim()) return provided;
  const template = await readPrTemplate(worktreePath);
  if (template) return template;
  const { commits } = await changeSummary(worktreePath, base);
  return defaultPrBody(commits.map((c) => c.subject).reverse()); // changeSummary is newest-first
}

export const worktreeDiff = (worktreePath: string, base: string) =>
  run(["git", "-C", worktreePath, "diff", `${base}...HEAD`]);

export async function changeSummary(worktreePath: string, base: string): Promise<ChangeSummary> {
  const numstat = await run(["git", "-C", worktreePath, "diff", "--numstat", `${base}...HEAD`]);
  const files: FileChange[] = numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [add, del, path] = line.split("\t");
      return {
        path: path ?? "",
        additions: add === "-" ? 0 : Number(add),
        deletions: del === "-" ? 0 : Number(del),
      };
    });

  const log = await run(["git", "-C", worktreePath, "log", "--format=%H%x00%s", `${base}..HEAD`]);
  const commits: Commit[] = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject] = line.split("\0");
      return { hash: hash ?? "", subject: subject ?? "" };
    });

  return {
    files,
    commits,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

/**
 * Merge the base into a worktree's branch the way an agent would be asked to, but only when no
 * judgement is needed: a clean merge, or one whose every conflict is in a changelog (`patterns`, the
 * repo's `changelogFiles`). Each such file is resolved with `git merge-file --union` — both sides'
 * added lines, ours first, in order — which is exactly the resolution "both added an entry under the
 * same heading" needs. Then commit and push. Anything else (a code conflict, a delete/modify, a dirty
 * tree, a push that fails) leaves the worktree exactly as it was and says so, and the caller hands the
 * conflict to the agent. Never forces.
 */
export async function mergeBaseUnioningChangelogs(worktreePath: string, base: string, patterns?: string[]): Promise<{ outcome: MechanicalMerge; files: string[] }> {
  if ((await git(worktreePath, "status", "--porcelain")).trim()) return { outcome: "dirty", files: [] };
  const remote = await hasRemote(worktreePath);
  if (remote) await git(worktreePath, "fetch", "origin", base).catch(() => {});
  const ref = await resolveBase(worktreePath, base);
  const before = (await git(worktreePath, "rev-parse", "HEAD")).trim();
  const message = `Merge ${ref} into ${(await git(worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).trim()}`;
  let files: string[] = [];
  let outcome: MechanicalMerge;
  try {
    await git(worktreePath, "merge", "--no-edit", "-m", message, ref);
    outcome = (await git(worktreePath, "rev-parse", "HEAD")).trim() === before ? "up to date" : "merged";
  } catch {
    files = (await git(worktreePath, "diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
    if (!changelogOnlyConflict(files, patterns) || !(await unionConflicts(worktreePath, files))) {
      await git(worktreePath, "merge", "--abort").catch(() => git(worktreePath, "reset", "--hard", before));
      return { outcome: "conflict", files };
    }
    await git(worktreePath, "commit", "--no-edit", "-m", `${message}\n\nOrca resolved the changelog-only conflict mechanically (both sides' entries kept): ${files.join(", ")}`);
    outcome = "resolved";
  }
  if (outcome === "up to date" || !remote) return { outcome, files };
  try {
    await git(worktreePath, "push", "origin", "HEAD");
  } catch {
    // Most likely the remote branch moved on: undo our merge (the tree was clean before it) and let the
    // agent, which pulls first, do it properly.
    await git(worktreePath, "reset", "--hard", before);
    return { outcome: "push failed", files };
  }
  return { outcome, files };
}

/** Resolve each conflicted file from its index stages by union. False — nothing written that matters,
 *  the caller aborts — when a side is missing (a delete/modify conflict has no lines to union). */
async function unionConflicts(worktreePath: string, files: string[]): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "orca-union-"));
  try {
    for (const [i, file] of files.entries()) {
      const stage = (n: number) => git(worktreePath, "show", `:${n}:${file}`);
      let ours: string, theirs: string;
      try { [ours, theirs] = await Promise.all([stage(2), stage(3)]); } catch { return false; }
      const ancestor = await stage(1).catch(() => ""); // both added the file: no common ancestor
      const [o, a, t] = ["ours", "base", "theirs"].map((n) => join(dir, `${i}.${n}`));
      await Promise.all([writeFile(o!, ours), writeFile(a!, ancestor), writeFile(t!, theirs)]);
      const merged = await run(["git", "merge-file", "--union", "-p", o!, a!, t!]);
      await writeFile(join(worktreePath, file), merged);
      await git(worktreePath, "add", "--", file);
    }
    return true;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
