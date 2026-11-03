// The PR-state sync's pure rules (server/prSync.ts does the I/O). The Orca database is the source of
// truth for PR state: one sync job reads GitHub and writes `pr_state`; every reader reads the table.
// GitHub only feeds it. The same pattern (integration → sync job → database, readers read the
// database) is the model for the other integrations later.

/** The sync intervals, ms. `normalMs` is a repo with open PRs; `fastMs` one with a running agent or
 *  a queued merge; `idleMs` one with no open PR; `doneMs` the merged / closed lists. ORCA_PR_SYNC_MS
 *  sets `normalMs`; the rest follow it. */
export function syncIntervals(normalMs = 60_000): { normalMs: number; fastMs: number; idleMs: number; doneMs: number } {
  return { normalMs, fastMs: Math.max(1, Math.round(normalMs / 3)), idleMs: normalMs * 5, doneMs: normalMs * 5 };
}

/** What a repo is now, for its interval. */
export type SyncLoad = "fast" | "normal" | "idle";

/** Whether a repo's sync is due. `attemptedAt` is the last try on ANY instance (pr_sync is shared),
 *  so two instances with the same checkout do not both read GitHub. Pure. */
export function syncDue(s: { attemptedAt?: number; load: SyncLoad; now: number; normalMs: number }): boolean {
  const iv = syncIntervals(s.normalMs);
  const every = s.load === "fast" ? iv.fastMs : s.load === "idle" ? iv.idleMs : iv.normalMs;
  return s.attemptedAt === undefined || s.now - s.attemptedAt >= every;
}

/** A row is stale when its last sync is older than two normal intervals: the card then shows its age. */
export const staleAfterMs = (normalMs: number): number => 2 * normalMs;
export function isStale(syncedAt: number, now: number, normalMs: number): boolean {
  return now - syncedAt > staleAfterMs(normalMs);
}

/** The part of a PR row the events read. */
export type PrFacts = { number: number; state: string; ciStatus?: string; mergeable?: string; headSha?: string; mergedAt?: number };

/** An event the sync job emits: the change between the row before and the row after a sync. */
export type PrEvent = "merged" | "ci_failed" | "conflicts";

/** How far back a merge seen for the first time is still news (a first sync lists a week). */
export const MERGED_NEWS_MS = 24 * 60 * 60 * 1000;

/** The events between `old` (undefined: first seen) and `next`. Pure. A red CI is news once per head
 *  commit; conflicts once until they clear; a merge once, and only when recent. */
export function prEvents(old: PrFacts | undefined, next: PrFacts, now: number): PrEvent[] {
  const out: PrEvent[] = [];
  if (next.state === "MERGED" && old?.state !== "MERGED" && (old !== undefined || (next.mergedAt !== undefined && now - next.mergedAt <= MERGED_NEWS_MS))) out.push("merged");
  if (next.state === "OPEN") {
    if (next.ciStatus === "failing" && (old?.ciStatus !== "failing" || old.headSha !== next.headSha || old.state !== "OPEN")) out.push("ci_failed");
    if (next.mergeable === "CONFLICTING" && (old?.mergeable !== "CONFLICTING" || old.state !== "OPEN")) out.push("conflicts");
  }
  return out;
}
