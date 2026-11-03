// PR state: the Orca database is the source of truth, and GitHub only feeds it (Finn 2026-11-03:
// "we should have these states in the db. And then when we sync with github we just update the db
// version."). ONE sync job here reads GitHub — per repo, the shared open-PR read on a steady interval,
// faster for a repo with a running agent or a queued merge, and the merged / closed lists less often —
// and writes each PR into `pr_state` with its `synced_at`. Every reader of PR state reads the table
// (the board's /api/prs and merged list, `orca board`, upkeep, cleanup, the merge queue, `orca send`,
// auto-PR, PR screenshots, the scheduled wakes). A write (merge, edit, create, label…) still goes to
// GitHub, and gh.ts's write hook makes this job read the repo again at once. Events (merged, CI red,
// conflicts) come from the diff between a PR's old row and its new one. A rate limit only makes rows
// older: while GraphQL is spent, which PRs are open comes from REST (ETag, 304s free) and the rest of
// each row keeps its last value and time. Pure rules: shared/prState.ts.
import { existsSync } from "fs";
import * as agent from "./agent";
import * as db from "./db";
import * as gh from "./gh";
import * as git from "./git";
import * as notify from "./notify";
import * as primary from "./primary";
import { GitHubRateLimitError } from "./github";
import { loadConfig, type OrcaConfig, type RepoConfig } from "./config";
import { mergedNotification } from "../shared/notifications";
import { isStale, prEvents, staleAfterMs, syncDue, syncIntervals, type SyncLoad } from "../shared/prState";

/** The normal interval (ms): ORCA_PR_SYNC_MS, else 60s. */
export const normalMs = (): number => Number(process.env.ORCA_PR_SYNC_MS) || 60_000;
/** Tests only: a reader syncs the repo first, so a changed fixture reads at once. Never in production. */
const inline = (): boolean => process.env.ORCA_PR_SYNC_INLINE === "1";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const here = (repo: RepoConfig) => existsSync(repo.repoPath);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300);

// ── rows ──────────────────────────────────────────────────────────────────────────────────────

/** A PR summary as a row, read at `at`. */
export function rowOf(repo: string, pr: gh.PrSummary, at: number): db.PrStateRow {
  const { syncedAt: _s, staleAt: _t, ...data } = pr;
  return {
    repo, number: pr.number, branch: pr.branch, base: pr.base, headSha: pr.head, state: pr.state, isDraft: pr.isDraft,
    ciStatus: pr.ciStatus, reviewStatus: pr.reviewStatus, mergeable: pr.mergeable, title: pr.title ?? "", url: pr.url ?? "",
    data: data as db.Fields, syncedAt: at,
  };
}

/** A row as the PR summary every reader gets: its `syncedAt`, and `staleAt` once it is old. */
export function summaryOf(r: db.PrStateRow, now = Date.now()): gh.PrSummary {
  const d = r.data as Partial<gh.PrSummary>;
  return {
    ciStatus: "none", reviewStatus: "none", mergeable: "UNKNOWN", externalFeedback: 0, additions: 0, deletions: 0, autoMergeEnabled: false,
    ...d,
    number: r.number, branch: r.branch, base: r.base, head: r.headSha, state: r.state, isDraft: r.isDraft, title: r.title, url: r.url,
    ...(r.ciStatus ? { ciStatus: r.ciStatus as gh.CiStatus } : {}),
    ...(r.reviewStatus ? { reviewStatus: r.reviewStatus as gh.ReviewStatus } : {}),
    ...(r.mergeable ? { mergeable: r.mergeable as gh.Mergeable } : {}),
    syncedAt: r.syncedAt,
    ...(isStale(r.syncedAt, now, normalMs()) ? { staleAt: r.syncedAt } : {}),
  };
}

const same = (a: db.PrStateRow, b: db.PrStateRow) =>
  JSON.stringify({ ...a, syncedAt: 0 }) === JSON.stringify({ ...b, syncedAt: 0 });

// ── what to watch ─────────────────────────────────────────────────────────────────────────────

// PR numbers a caller needs fresh although they may not be in the account's open list (a pending
// `pr:` wake on another person's PR, a PR the merge queue marked): source → repo → numbers.
const watched = new Map<string, Map<string, Set<number>>>();
/** Replace what `source` watches (scheduledWake.watchPrs, the merge queue). */
export function watch(source: string, byRepo: Map<string, Set<number>>): void { watched.set(source, byRepo); }
const watchedIn = (repo: string): Set<number> => {
  const out = new Set<number>();
  for (const m of watched.values()) for (const n of m.get(repo) ?? []) out.add(n);
  return out;
};

// ── the sync ──────────────────────────────────────────────────────────────────────────────────

// The last rows this process wrote per repo: what a reader gets while the database is down.
const mirror = new Map<string, Map<number, db.PrStateRow>>();

export type SyncResult = { open: boolean; rows: number; events: Array<{ number: number; event: string }>; error?: string };

const running = new Map<string, Promise<SyncResult>>();
const again = new Map<string, Promise<SyncResult>>();
/** Sync one repo now. A sync asked for while one runs runs once more after it (a write's refresh
 *  must not get the answer of a read that started before the write). */
export function syncRepo(repo: RepoConfig, opts: { done?: boolean; gates?: number[] } = {}): Promise<SyncResult> {
  // A branch preview's read-only bridge never syncs: it reads no GitHub and writes no pr_state row.
  if (db.previewBridge()) return Promise.resolve({ open: false, rows: 0, events: [] });
  const cur = running.get(repo.name);
  if (cur) {
    const next = again.get(repo.name) ?? cur.catch(() => undefined).then(() => { again.delete(repo.name); return syncRepo(repo, opts); });
    again.set(repo.name, next);
    return next;
  }
  const p = runSync(repo, opts).finally(() => running.delete(repo.name));
  running.set(repo.name, p);
  return p;
}

async function oldRows(repo: string): Promise<db.PrStateRow[]> {
  try { return await db.prStates(repo); } catch { return [...(mirror.get(repo)?.values() ?? [])]; }
}

const gateAt = new Map<string, number>(); // repo#pr → when its merge gate was last read
async function runSync(repo: RepoConfig, opts: { done?: boolean; gates?: number[] }): Promise<SyncResult> {
  const now = Date.now();
  const old = await oldRows(repo.name);
  const before = new Map(old.map((r) => [r.number, r]));
  const next = new Map<number, db.PrStateRow>();
  let error: string | undefined;
  let openSet: Set<number> | undefined;
  let openRead: gh.PrSummary[] | undefined;

  // 1. The open list: GraphQL, else (GraphQL spent) REST with each row's old CI, review and time.
  try {
    openRead = await gh.listPrs(repo.repoPath, repo.previewLabel ?? "preview");
    for (const p of openRead) next.set(p.number, rowOf(repo.name, p, now));
    openSet = new Set(openRead.map((p) => p.number));
  } catch (e) {
    error = msg(e);
    if (e instanceof GitHubRateLimitError && e.path === "graphql") {
      try {
        const known = old.filter((r) => r.state === "OPEN").map((r) => summaryOf(r, now));
        for (const p of await gh.openPrsRest(repo.repoPath, known)) {
          const k = before.get(p.number);
          const r = rowOf(repo.name, p, k?.state === "OPEN" ? k.syncedAt : now);
          if (k?.headSha && p.head && k.headSha !== p.head) { delete r.data.files; delete r.data.changedFiles; } // a new head: its files are unknown
          next.set(p.number, r);
        }
        openSet = new Set(next.keys());
      } catch (e2) { error = msg(e2); }
    }
  }

  // 2. A PR that left the open list: how it ended, by REST (no GraphQL).
  let vanished = false;
  if (openSet) {
    for (const r of old) {
      if (r.state !== "OPEN" || openSet.has(r.number)) continue;
      vanished = true;
      try {
        const p = await gh.prRest(repo.repoPath, r.number);
        next.set(r.number, { ...r, state: p.state, mergedAt: p.mergedAt, closedAt: p.closedAt, headSha: p.head ?? r.headSha, title: p.title || r.title, url: p.url || r.url, syncedAt: now });
      } catch { /* the done list below, or the next sync */ }
    }
  }

  // 3. The merged and closed lists: every doneMs, and at once after a PR left the open list.
  const status = await db.prSyncStatus(repo.name).catch(() => ({ repo: repo.name }) as db.PrSyncStatus);
  let doneOk = false;
  if (opts.done || vanished || !status.doneSyncedAt || now - status.doneSyncedAt >= syncIntervals(normalMs()).doneMs) {
    try {
      const [done, merged] = await Promise.all([gh.donePrs(repo.repoPath), gh.listMerged(repo.repoPath, now - WEEK_MS)]);
      const put = (n: number, f: Partial<db.PrStateRow> & { branch: string; state: string }) => {
        if (next.get(n)?.state === "OPEN") return; // the open list is newer than a closed one (reopened)
        const base = next.get(n) ?? before.get(n);
        next.set(n, { repo: repo.name, number: n, isDraft: false, title: "", url: "", data: {}, ...base, ...f, syncedAt: now });
      };
      for (const m of merged) put(m.number, { branch: m.branch, state: "MERGED", title: m.title, url: m.url, headSha: m.headSha, mergedAt: Date.parse(m.mergedAt) || undefined });
      for (const [branch, d] of done) if (d.number !== undefined && !next.has(d.number)) put(d.number, { branch, state: d.reason === "merged" ? "MERGED" : "CLOSED", headSha: d.head, ...(d.reason === "merged" ? { mergedAt: d.at } : { closedAt: d.at }) });
      doneOk = true;
    } catch (e) { error ??= msg(e); }
  }

  // 4. Watched PRs (a merge mark, a `pr:` wake, a command's refresh): one merge-gate read each, at most
  //    once a normal interval unless forced. It carries the files the merge queue's deny paths need.
  for (const n of watchedIn(repo.name)) {
    const key = `${repo.name}#${n}`;
    if (!opts.gates?.includes(n) && now - (gateAt.get(key) ?? 0) < normalMs()) {
      const old = before.get(n);
      const cur = next.get(n);
      if (cur && old?.data.files && cur.headSha === old.headSha) { cur.data.files = old.data.files; cur.data.changedFiles = old.data.changedFiles; }
      continue;
    }
    try {
      const g = await gh.prMergeGate(repo.repoPath, n);
      gateAt.set(key, now);
      const base = next.get(n) ?? before.get(n);
      const keep = base ? summaryOf(base, now) : { externalFeedback: 0, additions: 0, deletions: 0, autoMergeEnabled: false };
      next.set(n, rowOf(repo.name, { ...keep, ...g, head: g.headSha } as gh.PrSummary, now));
    } catch (e) { error ??= msg(e); }
  }

  // 5. Write the changed rows (an open row always: its synced_at is the news), then the events.
  const write = [...next.values()].filter((r) => r.state === "OPEN" ? r.syncedAt === now || !before.has(r.number) : !before.get(r.number) || !same(before.get(r.number)!, r));
  const m = mirror.get(repo.name) ?? new Map<number, db.PrStateRow>();
  for (const r of next.values()) m.set(r.number, r);
  mirror.set(repo.name, m);
  await db.upsertPrStates(write).catch(db.logUnlessDown(`orca: PR state write failed for ${repo.name}`));
  await db.notePrSync(repo.name, {
    openSyncedAt: openRead ? now : undefined, doneSyncedAt: doneOk ? now : undefined, attemptedAt: now, error: error ?? null,
  }).catch(db.logUnlessDown(`orca: PR sync record failed for ${repo.name}`));

  const events: SyncResult["events"] = [];
  const titles = await db.enrichment(repo.name).catch(() => ({}) as Record<string, db.Fields>);
  const titleOf = (r: db.PrStateRow) => { const t = titles[r.branch]?.title; return typeof t === "string" && t.trim() ? t.trim() : r.title; };
  for (const r of next.values()) {
    if (r.syncedAt !== now) continue; // a REST row with old CI: nothing new to say about it
    for (const ev of prEvents(before.get(r.number), r, now)) {
      events.push({ number: r.number, event: ev });
      if (ev === "merged") await notify.emit(mergedNotification(repo.name, { number: r.number, branch: r.branch, title: titleOf(r), by: "github" })).catch(db.logUnlessDown("orca: merged notification failed"));
      else await notify.prs(repo.name, [{ ...summaryOf(r, now), title: titleOf(r) }]).catch(db.logUnlessDown("orca: PR notification failed"));
    }
  }
  if (openRead) await notify.hiddenFeedback(repo.name, openRead).catch(db.logUnlessDown("orca: hidden PR feedback check failed"));
  return { open: Boolean(openRead), rows: write.length, events, ...(error ? { error } : {}) };
}

/** How busy a repo is now, for its interval: a running agent, a queued merge or a watched PR is fast;
 *  no open PR is idle. */
async function loadOf(repo: RepoConfig): Promise<SyncLoad> {
  const ench = await db.enrichment(repo.name).catch(() => ({}) as Record<string, db.Fields>);
  if (watchedIn(repo.name).size || Object.values(ench).some((e) => e?.mergeWhenGreen)) return "fast";
  const wts = await git.listWorktrees(repo.repoPath, repo.worktreeRoot).catch(() => []);
  if (wts.some((w) => agent.isRunning(w.worktreePath))) return "fast";
  const open = (await db.prStates(repo.name, { state: "OPEN" }).catch(() => [])).length;
  return open ? "normal" : "idle";
}

let ticking = false;
/** The job's tick (index.ts, every fast interval, on the primary): each repo here whose sync is due. */
export async function tick(cfg: OrcaConfig, now = Date.now()): Promise<void> {
  if (!primary.held() || db.previewBridge() || ticking) return;
  ticking = true;
  try {
    for (const repo of cfg.repos.filter(here)) {
      const status = await db.prSyncStatus(repo.name).catch(() => undefined);
      if (!status) return; // the database is down: nothing to write to
      if (!syncDue({ attemptedAt: status.attemptedAt, load: await loadOf(repo), now, normalMs: normalMs() })) continue;
      await syncRepo(repo).catch(db.logUnlessDown(`orca: PR sync failed for ${repo.name}`));
    }
  } finally {
    ticking = false;
  }
}

/** A write to GitHub about the checkout at `cwd` (a repo or one of its worktrees): sync it now. */
export async function afterWrite(cwd: string): Promise<void> {
  const cfg = await loadConfig().catch(() => undefined);
  const repo = cfg?.repos.find((r) => cwd === r.repoPath || cwd.startsWith(`${r.worktreeRoot.replace(/\/$/, "")}/`));
  if (repo && here(repo)) await syncRepo(repo, { done: true });
}
gh.setWriteHook(afterWrite);

/** A command about to act on PR state (Merge, merge-when-green): read these PRs from GitHub now. */
export async function refresh(repo: RepoConfig, prs: number[] = []): Promise<void> {
  if (!here(repo)) return;
  if (prs.length) watch(`refresh:${repo.name}`, new Map([[repo.name, new Set(prs)]]));
  try { await syncRepo(repo, { gates: prs }); } finally { if (prs.length) watched.delete(`refresh:${repo.name}`); }
}

// ── readers: the database only ────────────────────────────────────────────────────────────────

async function rows(repo: RepoConfig, opts: { state?: string; since?: number } = {}): Promise<db.PrStateRow[]> {
  if (inline() && here(repo)) await syncRepo(repo, { done: true }).catch(() => undefined);
  try { return await db.prStates(repo.name, opts); } catch (e) {
    const m = mirror.get(repo.name);
    if (!m) throw e;
    return [...m.values()].filter((r) => (!opts.state || r.state === opts.state) && (opts.since === undefined || (r.mergedAt ?? r.closedAt ?? 0) >= opts.since)).sort((a, b) => b.number - a.number);
  }
}

/** The account's open PRs of a repo, as last synced. */
export async function openPrs(repo: RepoConfig): Promise<gh.PrSummary[]> {
  const now = Date.now();
  return (await rows(repo, { state: "OPEN" })).map((r) => summaryOf(r, now));
}

/** The repo's PRs merged since `since` (ms; default this server's local midnight): the Done rows. */
export async function mergedPrs(repo: RepoConfig, since?: number): Promise<gh.MergedPr[]> {
  const boundary = since ?? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  return (await rows(repo, { state: "MERGED", since: boundary }))
    .filter((r) => r.mergedAt !== undefined && r.mergedAt >= boundary)
    .sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0))
    .map((r) => ({ number: r.number, title: r.title, branch: r.branch, url: r.url, mergedAt: new Date(r.mergedAt!).toISOString(), headSha: r.headSha }));
}

/** Each branch whose PR is done with (cleanup): merged wins over closed, the newest PR per branch. */
export async function donePrs(repo: RepoConfig): Promise<Map<string, gh.DonePr>> {
  const all = (await rows(repo)).filter((r) => r.state === "MERGED" || r.state === "CLOSED");
  const out = new Map<string, gh.DonePr>();
  for (const r of all) if (r.state === "MERGED" && !out.has(r.branch)) out.set(r.branch, { reason: "merged", at: r.mergedAt, head: r.headSha, number: r.number });
  for (const r of all) if (!out.has(r.branch)) out.set(r.branch, { reason: "closed", at: r.closedAt, head: r.headSha, number: r.number });
  return out;
}

/** One PR of a repo, any state, as last synced. */
export async function prByNumber(repo: RepoConfig, pr: number): Promise<gh.PrSummary | undefined> {
  if (inline() && here(repo)) await refresh(repo, [pr]).catch(() => undefined);
  const r = await db.prState(repo.name, pr).catch(() => mirror.get(repo.name)?.get(pr));
  return r && summaryOf(r);
}

/** The merge queue's facts about one PR, from its row. Undefined when the row is missing, older than
 *  two sync intervals, or has no file list (a deny-path check needs one): the queue then waits. */
export async function mergeGate(repo: RepoConfig, pr: number, now = Date.now()): Promise<gh.PrMergeGate | undefined> {
  if (inline() && here(repo)) await refresh(repo, [pr]).catch(() => undefined);
  const r = await db.prState(repo.name, pr).catch(() => mirror.get(repo.name)?.get(pr));
  if (!r || now - r.syncedAt > staleAfterMs(normalMs())) return undefined;
  const s = summaryOf(r, now);
  if (r.state === "OPEN" && !s.files) return undefined;
  return {
    number: r.number, title: r.title, branch: r.branch, url: r.url, isDraft: r.isDraft, headSha: r.headSha ?? "",
    state: r.state, ciStatus: s.ciStatus, reviewStatus: s.reviewStatus, mergeable: s.mergeable,
    files: s.files ?? [], changedFiles: s.changedFiles ?? (s.files ?? []).length, failingChecks: s.failingChecks ?? [],
  };
}

/** Whether the repo's open list was read within two sync intervals: cleanup reaps only then. */
export async function openFresh(repo: RepoConfig, now = Date.now()): Promise<boolean> {
  if (inline() && here(repo)) return Boolean((await syncRepo(repo).catch(() => undefined))?.open); // tests: this read's own result
  const s = await db.prSyncStatus(repo.name).catch(() => undefined);
  return s?.openSyncedAt !== undefined && now - s.openSyncedAt <= staleAfterMs(normalMs());
}

/** Forget this process's mirror and watches (tests). */
export function resetPrSync(): void { mirror.clear(); watched.clear(); gateAt.clear(); }
