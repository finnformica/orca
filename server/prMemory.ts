// The last known state of each open PR, on its workstream's enrichment (`lastPr`), so a board read
// while GitHub is rate limited or down shows the PR as it was — marked stale — and never as "no PR"
// or a local branch. gh.listPrs keeps the last read in memory; this is the copy that survives a
// restart and that the other instance can read. No table: enrichment is already per workstream.
import * as db from "./db";
import type { PrMemory, PrSummary } from "./gh";

/** The fields kept: what the board, `orca board` and the verbs read off a PR. Feedback text is not. */
export type LastPr = Pick<PrSummary,
  "number" | "title" | "branch" | "base" | "url" | "state" | "isDraft" | "autoMergeEnabled" | "autoMergeMethod" | "ciStatus"
  | "reviewStatus" | "mergeable" | "head" | "failingChecks" | "externalFeedback" | "additions" | "deletions" | "previewUrl" | "hasPreviewLabel"
> & { at: number };

/** A stored `lastPr` is rewritten when its state changes, else at most this often (its age is shown). */
export const LAST_PR_REFRESH_MS = 10 * 60_000;

export function lastPrOf(pr: PrSummary, at: number): LastPr {
  const { feedback: _f, staleAt: _s, staleReason: _r, ...rest } = pr;
  return { ...rest, at };
}
/** The state part of a snapshot: what decides "changed" (never its time). */
const stateKey = (p: Partial<LastPr>) => JSON.stringify({ ...p, at: undefined });

/** Whether `stored` must be rewritten for the read `next`. Pure (tests). */
export function lastPrDue(stored: LastPr | undefined, next: LastPr): boolean {
  return !stored || stateKey(stored) !== stateKey(next) || next.at - stored.at >= LAST_PR_REFRESH_MS;
}

/** The stored snapshots as PR rows, each marked stale with the time it was read. */
export function prsFromEnrichment(enrichment: Record<string, db.Fields>): PrSummary[] {
  const out: PrSummary[] = [];
  for (const [branch, e] of Object.entries(enrichment)) {
    const s = e?.lastPr as LastPr | undefined;
    if (!s || typeof s.number !== "number" || s.state !== "OPEN") continue;
    const { at, ...pr } = s;
    out.push({ ...pr, branch: pr.branch || branch, staleAt: at });
  }
  return out.sort((a, b) => b.number - a.number);
}

/** Write the read `prs` of `repo`: a changed or old snapshot is rewritten, and a branch whose PR is
 *  no longer open loses its snapshot (a stale read must not bring a merged PR back as open). */
export async function saveLastPrs(repo: string, prs: PrSummary[], at: number): Promise<void> {
  const enrichment = await db.enrichment(repo);
  const open = new Set(prs.map((p) => p.branch));
  for (const pr of prs) {
    const next = lastPrOf(pr, at);
    if (lastPrDue(enrichment[pr.branch]?.lastPr as LastPr | undefined, next)) await db.patchEnrichment(repo, pr.branch, { lastPr: next });
  }
  for (const [branch, e] of Object.entries(enrichment)) if (e?.lastPr && !open.has(branch)) await db.patchEnrichment(repo, branch, { lastPr: null });
}

/** The PrMemory for gh.setPrMemory. `repoOf` maps a checkout to its repo name. A write runs only
 *  when the read differs from the last one written (or is LAST_PR_REFRESH_MS old), so the 20s
 *  shared read costs no database write in a steady state. */
export function prMemory(repoOf: (cwd: string) => Promise<string | undefined>): PrMemory {
  const written = new Map<string, { key: string; at: number }>();
  return {
    async save(cwd, prs, at) {
      const repo = await repoOf(cwd);
      if (!repo) return;
      const key = JSON.stringify(prs.map((p) => stateKey(lastPrOf(p, at))));
      const last = written.get(cwd);
      if (last && last.key === key && at - last.at < LAST_PR_REFRESH_MS) return;
      await saveLastPrs(repo, prs, at);
      written.set(cwd, { key, at });
    },
    async load(cwd) {
      const repo = await repoOf(cwd);
      if (!repo) return undefined;
      const prs = prsFromEnrichment(await db.enrichment(repo));
      return prs.length ? { prs } : undefined;
    },
  };
}
