// Screenshots in a PR's description, so a UI change can be reviewed without checking it out. The
// shots a workstream's workers reported (`orca-shot` PNGs, named by path in their replies — nothing
// stores them per turn) are pushed to the PR's own repo as ONE orphan commit on
// `refs/heads/pr-assets/<pr>-<slug>` through GitHub's git data API (blobs → tree → commit → ref),
// and linked as `blob/<commit>/<file>?raw=true`, which renders for anyone who can read the repo.
// The body's `## Screenshots` section is replaced in place (workstream.ts `withScreenshotsSection`),
// the rest left untouched; its marker names the shot ids, so an unchanged set is never re-uploaded.
// Only PNGs from the shot store (`diskStore`, ids validated there) are ever uploaded. The ref goes
// when the PR is merged or closed (verbs.reapWorktree).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { run } from "./run";
import { countGhCall } from "./metrics";
import * as db from "./db";
import * as gh from "./gh";
import * as git from "./git";
import { diskStore } from "./screenshot";
import type { RepoConfig } from "./config";
import { PR_SHOTS_MAX, prAssetsRef, prShotIds, screenshotsSection, shotRefs, withScreenshotsSection, workstreamShots, type ShotRef } from "../web/src/workstream";

const ghRun = (cwd: string, ...args: string[]) => { countGhCall(); return run(["gh", ...args], cwd); };

/** One `gh api` call with a JSON payload (written to a temp file — a blob's base64 is too big for argv). */
async function api(cwd: string, method: string, path: string, payload?: unknown): Promise<any> {
  if (payload === undefined) {
    const out = await ghRun(cwd, "api", "-X", method, path);
    return out.trim() ? JSON.parse(out) : undefined;
  }
  const dir = mkdtempSync(join(tmpdir(), "orca-prshots-"));
  try {
    const file = join(dir, "body.json");
    writeFileSync(file, JSON.stringify(payload));
    const out = await ghRun(cwd, "api", "-X", method, path, "--input", file);
    return out.trim() ? JSON.parse(out) : undefined;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const PNG = [0x89, 0x50, 0x4e, 0x47];
const isPng = (b: Uint8Array) => PNG.every((x, i) => b[i] === x);

/** Push `files` (PNGs) as one parentless commit on `refs/heads/<ref>`, created or force-moved.
 *  Returns the commit sha and the repo's `owner/name`, for the links. */
export async function uploadPrAssets(cwd: string, ref: string, files: { name: string; path: string }[]): Promise<{ commit: string; repo: string }> {
  const repo = (await ghRun(cwd, "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner")).trim();
  const tree = [];
  for (const f of files) {
    const bytes = readFileSync(f.path);
    if (!isPng(bytes)) throw new Error(`${f.name} is not a PNG; only screenshots are uploaded`);
    const blob = await api(cwd, "POST", "repos/{owner}/{repo}/git/blobs", { content: bytes.toString("base64"), encoding: "base64" });
    tree.push({ path: f.name, mode: "100644", type: "blob", sha: blob.sha as string });
  }
  const t = await api(cwd, "POST", "repos/{owner}/{repo}/git/trees", { tree });
  const c = await api(cwd, "POST", "repos/{owner}/{repo}/git/commits", { message: "PR screenshots (Orca)", tree: t.sha, parents: [] });
  try {
    await api(cwd, "PATCH", `repos/{owner}/{repo}/git/refs/heads/${ref}`, { sha: c.sha, force: true });
  } catch {
    await api(cwd, "POST", "repos/{owner}/{repo}/git/refs", { ref: `refs/heads/${ref}`, sha: c.sha });
  }
  return { commit: c.sha as string, repo };
}

/** Delete every `pr-assets/<pr>[-…]` ref of a PR. Returns the refs removed. */
export async function deletePrAssets(cwd: string, pr: number): Promise<string[]> {
  const refs = ((await api(cwd, "GET", `repos/{owner}/{repo}/git/matching-refs/heads/pr-assets/${pr}`)) ?? []) as { ref: string }[];
  const mine = refs.map((r) => r.ref).filter((r) => new RegExp(`^refs/heads/pr-assets/${pr}(-|$)`).test(r));
  for (const r of mine) await api(cwd, "DELETE", `repos/{owner}/{repo}/git/${r.replace(/^refs\//, "")}`);
  return mine;
}

export type PrShotsResult = { pr: number; shots: number; updated: boolean; ref?: string; why?: string };

/** Make PR `pr`'s Screenshots section show `shots` (newest first, each with its file on this disk):
 *  nothing is uploaded or edited when the section already shows exactly these. */
export async function syncPrShots(cwd: string, pr: number, branch: string, shots: (ShotRef & { file: string })[]): Promise<PrShotsResult> {
  const picked = shots.slice(0, PR_SHOTS_MAX);
  if (!picked.length) return { pr, shots: 0, updated: false, why: "no screenshots reported on this branch" };
  const body = (JSON.parse(await ghRun(cwd, "pr", "view", String(pr), "--json", "body")) as { body?: string }).body ?? "";
  if (prShotIds(body).join(",") === picked.map((s) => s.id).join(",")) return { pr, shots: picked.length, updated: false, why: "already up to date" };
  const ref = prAssetsRef(pr, branch);
  const { commit, repo } = await uploadPrAssets(cwd, ref, picked.map((s) => ({ name: `${s.id}.png`, path: s.file })));
  const section = screenshotsSection(picked.map((s) => ({
    id: s.id, alt: s.label ?? "screenshot", url: `https://github.com/${repo}/blob/${commit}/${s.id}.png?raw=true`,
  })));
  const dir = mkdtempSync(join(tmpdir(), "orca-prbody-"));
  try {
    const file = join(dir, "body.md");
    writeFileSync(file, withScreenshotsSection(body, section));
    await ghRun(cwd, "pr", "edit", String(pr), "--body-file", file);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return { pr, shots: picked.length, updated: true, ref };
}

const busy = new Map<string, Promise<PrShotsResult>>();

/** The workstream's newest reported screenshots (still on this disk) into its open PR — `orca
 *  pr-shots`, a PR Orca opens, and a later run reporting new shots all come here. One at a time per
 *  branch: two calls racing would push two commits. */
export function attachPrShots(repo: RepoConfig, branch: string, opts: { pr?: number } = {}): Promise<PrShotsResult> {
  const key = `${repo.name}::${branch}`;
  const prev = busy.get(key) ?? Promise.resolve(undefined as unknown as PrShotsResult);
  const next = prev.catch(() => undefined).then(async () => {
    const pr = opts.pr ?? (await gh.listPrs(repo.repoPath)).find((p) => p.branch === branch)?.number;
    if (!pr) throw new Error(`${repo.name}/${branch} has no open PR`);
    const store = diskStore();
    const shots = workstreamShots(await db.turns(repo.name, branch)).flatMap((t) => t.shots)
      .flatMap((s) => { const file = store.path(s.id); return file ? [{ ...s, file }] : []; });
    return syncPrShots(repo.repoPath, pr, branch, shots);
  });
  busy.set(key, next);
  void next.finally(() => { if (busy.get(key) === next) busy.delete(key); }).catch(() => {});
  return next;
}

/** After a run: if it reported screenshots and its branch already has an open PR, refresh the PR's
 *  section. Silent otherwise; never throws (a failure is logged — the run's own result stands). */
export async function afterRun(repo: RepoConfig | undefined, branch: string | undefined, text: string): Promise<void> {
  if (!repo || !branch || !shotRefs(text).length) return;
  try {
    if (!(await git.hasRemote(repo.repoPath))) return;
    const pr = (await gh.listPrs(repo.repoPath)).find((p) => p.branch === branch)?.number;
    if (pr) await attachPrShots(repo, branch, { pr });
  } catch (e) {
    console.warn(`orca: could not update ${repo.name}/${branch}'s PR screenshots: ${e instanceof Error ? e.message : String(e)}`);
  }
}
