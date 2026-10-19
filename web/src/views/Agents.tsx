// The Agents page — Vercel's Deployments list, adapted: a quick-filter row grouped into families
// (State, Activity, Repo) with the active filters as dashed chips — instance and orchestrated stay
// as the row's own column/badge rather than a pill — then one dense row per workstream with only
// what you act on (workstream.listColumns): the title over repo · model, the
// status (a spinner and a live elapsed time while running), the PR state + number, checks and the
// review cluster, the instance, when it last moved, and the actions. The title takes the room left;
// every other column is as wide as its widest cell, measured before paint (useListLayout), so the
// list never scrolls sideways. When the columns leave the title too narrow they fold into the row,
// one at a time (workstream.listLayout): Status, then Checks & review, then the PR; past that each
// row stacks as on a phone. A subline that still does not fit ends in a `+N` chip whose card lists
// the hidden items.
// Clicking a row opens its agent page; every action is in the trailing ⋯ and on right-click
// (WorkstreamActions, menu-only).
// On a phone (below md) each row stacks — title and status, then where it runs —
// with every action in its one ⋯ menu, and the chips and sort move into a Filters bottom sheet
// beside the search box.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { ThreadChips } from "@/components/SourceChip";
import { useAtom, useAtomValue } from "jotai";
import { ArrowDown, GitPullRequest, ListFilter, Loader2, Search, X } from "lucide-react";
import { agentQueryAtom, instanceScopeAtom, repoFilterAtom } from "@/lib/atoms";
import { navigate, useSearch } from "@/lib/route";
import { useNow } from "@/lib/ticker";
import { oneOf, persistedKey, readPersisted, usePersisted, writePersisted } from "@/lib/persisted";
import { useNarrow } from "@/lib/viewport";
import { afterDockMotion } from "@/lib/dock";
import { usePullToRefresh } from "@/lib/gestures";
import { BottomSheet } from "@/components/BottomSheet";
import { instanceChoices, modelFor, refresh, thisInstance, useRepos, useWorkstreams, useWorkstreamsLoaded, type Row } from "../store";
import {
  DEFAULT_LIST_FILTER, NO_QUICK_FILTER, QUICK_GROUPS, SORT_LABELS, applyQuickFilter, attentionReasons, filterRows, formatDuration, formatElapsed, prPill,
  LIST_ITEM_GAP_PX, NO_FOLD, browserKillLabel, listColumns, listLayout, modelBadge, notMergedCount, parseQuickFilter, promptInstruction, quickActive, quickCount, quickFilterQuery, rowDuration, rowInstance, rowTone, sortRows, sublineOverflow, toggleNotMerged, toggleQuick,
  type ListColumn, type ListFold, type ListSort, type ListWidths, type OverviewLane, type QuickFilter, type QuickGroup, type RowTone,
} from "../workstream";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BrowserKillBadge, Pill, Skeleton, UpkeepNote, StatusDot, type DotTone } from "@/components/console";
import { TerminalDialog } from "@/components/Terminal";
import { CopyDone, LaneActions } from "./BulkActions";
import { ConditionBadges } from "./ConditionBadges";
import { useSummary, useTerminalOpen } from "@/lib/workstreamHooks";
import { QuickActionButtons, WorkstreamActions } from "./WorkstreamActions";
import { PreviewCell, PrPreviewInline } from "./PreviewControl";
import { ReviewCluster } from "./Review";
import { StatusHoverCard } from "./StatusCard";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function Agents() {
  return (
    <div className="space-y-5">
      <h1 className="text-heading text-2xl font-semibold tracking-tight">Agents</h1>
      <AgentsList />
    </div>
  );
}

// How many placeholder rows to show while the first agents+PRs refresh is in flight — enough to fill
// a typical viewport without guessing the real count (which we don't have yet).
const SKELETON_ROWS = 6;

function AgentsList() {
  const all = useWorkstreams();
  const loaded = useWorkstreamsLoaded();
  const repo = useAtomValue(repoFilterAtom); // the top bar's scope
  const instance = useAtomValue(instanceScopeAtom); // the sidebar's scope
  const [q, setQ] = useAtom(agentQueryAtom);
  const search = useSearch();
  const quick = parseQuickFilter(search);
  const [sort, setSort] = usePersisted<ListSort>(persistedKey("agents.sort"), "updated", oneOf(...(Object.keys(SORT_LABELS) as ListSort[])));
  const here = thisInstance();
  const filtersKey = persistedKey("agents.filters", repo); // the chips + search, per repo scope
  // The URL is the source of truth whenever it has a query (links keep working); /agents opened
  // bare restores this scope's last chips + search and writes them into the URL. Every change after
  // that is saved, so Clear (an empty query, no search) is remembered too.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (restoredFor.current !== filtersKey) {
      restoredFor.current = filtersKey;
      if (!search) {
        const saved = readPersisted(filtersKey, NO_SAVED_FILTERS, isSavedFilters);
        const restoreQ = !q && saved.q; // a query the Find box just typed wins over the saved one
        if (restoreQ) setQ(saved.q);
        const query = quickFilterQuery(parseQuickFilter(saved.query)); // re-normalised: never trust stored text as-is
        if (query) { navigate(`/agents${query}`, true); return; }
        if (restoreQ) return;
      }
    }
    writePersisted(filtersKey, { query: quickFilterQuery(quick), q });
  }, [filtersKey, search, q]); // quick derives from search
  // The scopes first (they hold on every page), then the search box, then the quick chips.
  const scoped = filterRows(all, { ...DEFAULT_LIST_FILTER, repo, instance, q }, here);
  const visible = sortRows(applyQuickFilter(scoped, quick, here), sort);
  const setQuick = (f: QuickFilter) => navigate(`/agents${quickFilterQuery(f)}`, true); // a filter change is not a history step
  const clear = () => { setQ(""); setQuick(NO_QUICK_FILTER); };
  const narrow = useNarrow();
  const listRef = useRef<HTMLDivElement>(null);
  const layout = useListLayout(listRef);
  const fold = layout.fold;
  const cols = listColumns(fold);
  // A phone, or a list too narrow for the grid (the docked panel open): rows stack, no column header.
  const stacked = narrow || fold.stacked;
  const sectionRef = useRef<HTMLElement>(null);
  const pull = usePullToRefresh(sectionRef, refresh, narrow); // a phone: pull down from the top to refresh
  return (
    <section ref={sectionRef} aria-label="Agents" className="space-y-3">
      {narrow && pull.phase !== "idle" && (
        <div data-slot="pull-to-refresh" data-phase={pull.phase} role="status" style={{ height: pull.offset }}
          className="text-muted-foreground flex items-end justify-center gap-1.5 overflow-hidden pb-2 text-xs">
          {pull.phase === "refreshing" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            : <ArrowDown className={`size-4 transition-transform ${pull.phase === "release" ? "rotate-180" : ""}`} aria-hidden="true" />}
          {pull.phase === "refreshing" ? "Refreshing…" : pull.phase === "release" ? "Release to refresh" : "Pull to refresh"}
        </div>
      )}
      <FilterRow scoped={scoped} quick={quick} setQuick={setQuick} clear={clear} visible={visible} total={all.length} q={q} setQ={setQ} sort={sort} setSort={setSort}
        showRepos={repo === "all"} loaded={loaded} />
      <div ref={listRef} data-slot="workstream-list" data-layout={stacked ? "stacked" : "grid"} role="table" aria-label="Workstreams"
        style={{ "--list-cols": layout.template } as CSSProperties} className="bg-card overflow-hidden rounded-lg border">
        {(!loaded || visible.length > 0) && !stacked && <ListHeader cols={cols} />}
        {!loaded ? (
          Array.from({ length: SKELETON_ROWS }, (_, i) => <AgentRowSkeleton key={i} cols={cols} stacked={stacked} />)
        ) : visible.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-3 px-4 py-14 text-sm">
            No agents match.
            <Button size="sm" variant="outline" onClick={clear}>Clear filters</Button>
          </div>
        ) : visible.map((r) => <AgentRow key={r.repo + r.branch} row={r} fold={fold} stacked={stacked} />)}
      </div>
    </section>
  );
}

const NO_WIDTHS: ListWidths = { status: 0, pr: 0, signals: 0, actions: 0 };
/** Each content-sized column's natural width: per grid row, the sum of its `data-col-part` pieces
 *  and their item gaps; the widest row wins. A folded column has no header label, so each label's
 *  width is kept in `labels` from when it was last drawn — else the column unfolds, sees its label
 *  and folds again. Null when no grid row is drawn. */
function measureColumns(list: HTMLElement, labels: ListWidths): ListWidths | null {
  const rows = list.querySelectorAll<HTMLElement>(":scope > [role=row]:not([data-layout=stacked])");
  if (!rows.length) return null;
  const out = { ...NO_WIDTHS };
  for (const p of list.querySelectorAll<HTMLElement>(":scope > [data-slot=workstream-list-header] [data-col-part]")) {
    labels[p.dataset.colPart as keyof ListWidths] = Math.ceil(p.getBoundingClientRect().width);
  }
  for (const row of rows) {
    const sum = { ...NO_WIDTHS }, n = { ...NO_WIDTHS };
    for (const p of row.querySelectorAll<HTMLElement>("[data-col-part]")) {
      const k = p.dataset.colPart as keyof ListWidths;
      const w = Math.ceil(p.getBoundingClientRect().width);
      if (!(k in sum) || w <= 0) continue;
      sum[k] += w + (n[k]++ ? LIST_ITEM_GAP_PX : 0);
    }
    for (const k of Object.keys(out) as (keyof ListWidths)[]) out[k] = Math.max(out[k], sum[k], labels[k]);
  }
  return out;
}
const sameLayout = (a: ReturnType<typeof listLayout>, b: ReturnType<typeof listLayout>) =>
  a.template === b.template && a.fold.status === b.fold.status && a.fold.signals === b.fold.signals && a.fold.pr === b.fold.pr && a.fold.stacked === b.fold.stacked;

/** The list's fold and grid template (workstream.listLayout) from its width and its columns' widths.
 *  Measured in a layout effect after every render, so the first paint already has the right layout;
 *  again when the list or a measured piece resizes (through afterDockMotion, so a sliding dock never
 *  sets state per frame). While rows are stacked, the last grid measure stands. */
function useListLayout(ref: RefObject<HTMLElement | null>): ReturnType<typeof listLayout> {
  const [layout, setLayout] = useState(() => listLayout(0, NO_WIDTHS));
  const widths = useRef<ListWidths>(NO_WIDTHS);
  const labels = useRef<ListWidths>({ ...NO_WIDTHS });
  const ro = useRef<ResizeObserver | null>(null);
  const measure = useRef(() => {
    const el = ref.current;
    if (!el) return;
    widths.current = measureColumns(el, labels.current) ?? widths.current;
    const next = listLayout(el.clientWidth, widths.current);
    setLayout((prev) => (sameLayout(prev, next) ? prev : next));
  }).current;
  const settled = useRef(() => afterDockMotion(measure)).current;
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    ro.current = new ResizeObserver(settled);
    return () => { ro.current?.disconnect(); ro.current = null; };
  }, []);
  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el || !ro.current) return;
    ro.current.observe(el);
    for (const p of el.querySelectorAll("[data-col-part]")) ro.current.observe(p); // a cell that grows (a review loads, a timer ticks)
  });
  return layout;
}

/** A row-shaped placeholder, matching `AgentRow`'s grid (desktop) or stacked (phone) layout, so the
 *  list doesn't reflow once the real rows land. */
function AgentRowSkeleton({ cols, stacked }: { cols: ListColumn[]; stacked: boolean }) {
  if (stacked) {
    return (
      <div data-slot="workstream-row-skeleton" className="flex items-start gap-1 border-b py-3 px-4 last:border-b-0">
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-16" />
          </div>
          <Skeleton className="h-3 w-56" />
          <Skeleton className="h-3 w-full max-w-xs" />
        </div>
      </div>
    );
  }
  return (
    <div data-slot="workstream-row-skeleton" role="row" className={`${GRID} h-14 border-b last:border-b-0`}>
      {cols.map((c) => (
        <div key={c.key} role="cell" className="min-w-0">
          {c.key === "workstream" ? <Skeleton className="h-3.5 w-40" /> : (
            <div data-col-part={c.key} className={`w-max ${c.key === "actions" ? "ml-auto" : ""}`}><Skeleton className={`h-3.5 ${c.key === "actions" ? "w-8" : "w-16"}`} /></div>
          )}
        </div>
      ))}
    </div>
  );
}

// What the Agents list remembers per repo scope: the chips as their URL query, and the search text.
type SavedFilters = { query: string; q: string };
const NO_SAVED_FILTERS: SavedFilters = { query: "", q: "" };
const isSavedFilters = (v: unknown): v is SavedFilters =>
  typeof v === "object" && v !== null && typeof (v as SavedFilters).query === "string" && typeof (v as SavedFilters).q === "string";

type Chip = { group: QuickGroup; value: string; label: string; dot?: DotTone };

// The grouping is in the data only now (no visible caption or extra gap between families): this
// wrapper stays in the DOM, keyed by `label`, so a chip's family is still inspectable, but
// `contents` keeps it out of layout so every chip reads as one flat, evenly-gapped wrapping row.
function ChipFamily({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div data-slot="quick-filter-group" data-group={label.toLowerCase()} className="contents">
      {children}
    </div>
  );
}

// Vercel's filter row: one-click chips, each with its count, toggleable and combinable (AND across
// groups, OR within one); the URL query holds them, so a filtered view is a link. Search and sort sit
// at the end.
function FilterRow({ scoped, quick, setQuick, clear, visible, total, q, setQ, sort, setSort, showRepos, loaded }: {
  scoped: Row[]; quick: QuickFilter; setQuick: (f: QuickFilter) => void; clear: () => void; visible: Row[]; total: number;
  q: string; setQ: (v: string) => void; sort: ListSort; setSort: (s: ListSort) => void;
  showRepos: boolean; loaded: boolean;
}) {
  const repos = useRepos();
  const here = thisInstance();
  // State and instance/by are columns and badges already (instance column, the orchestrated bot
  // icon); only the lane-ish and activity chips earn a pill here. Grouped Vercel-style: a muted
  // caption per family, chips within a family read as one segmented row.
  const stateChips: Chip[] = [
    { group: "pr", value: "open", label: "Open PRs" },
    { group: "pr", value: "mergeable", label: "Mergeable", dot: "queued" },
    { group: "pr", value: "merged", label: "Merged today", dot: "ready" },
  ];
  const activityChips: Chip[] = [
    { group: "status", value: "running", label: "Running", dot: "building" },
    { group: "status", value: "attention", label: "Needs attention", dot: "warning" },
  ];
  const repoChips: Chip[] = showRepos && repos.length > 1 ? repos.map((r): Chip => ({ group: "repo", value: r.name, label: r.name })) : [];
  // The lane the chips narrow to, when exactly one: the swimlanes' bulk verbs apply to it.
  const lane: OverviewLane | null = quick.pr.length === 1 && quick.pr[0] !== "open" ? (quick.pr[0] === "merged" ? "DONE" : "MERGEABLE") : null;
  const narrow = useNarrow();
  const [sheet, setSheet] = useState(false);
  const renderChip = (c: Chip) => {
    const on = (quick[c.group] as string[]).includes(c.value);
    return (
      <button key={`${c.group}:${c.value}`} type="button" data-slot="quick-filter" data-chip={`${c.group}:${c.value}`} aria-pressed={on}
        onClick={() => setQuick(toggleQuick(quick, c.group, c.value))}
        className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition-colors ${on ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:border-foreground/30"}`}>
        {c.dot && <StatusDot tone={c.dot} className="size-2" />}
        {c.label}
        <span data-slot="quick-count" className={`tabular-nums ${on ? "opacity-70" : "opacity-60"}`}>
          {loaded ? quickCount(scoped, quick, c.group, c.value, here) : <Skeleton className="h-3 w-3" />}
        </span>
      </button>
    );
  };
  const notMergedChip = (
    <button key="notMerged" type="button" data-slot="quick-filter" data-chip="notMerged" aria-pressed={quick.notMerged}
      onClick={() => setQuick(toggleNotMerged(quick))}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition-colors ${quick.notMerged ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:border-foreground/30"}`}>
      Not merged
      <span data-slot="quick-count" className={`tabular-nums ${quick.notMerged ? "opacity-70" : "opacity-60"}`}>
        {loaded ? notMergedCount(scoped, quick, here) : <Skeleton className="h-3 w-3" />}
      </span>
    </button>
  );
  const chipGroup = (
      <div role="group" aria-label="Quick filters" className="flex flex-wrap items-center gap-1.5">
        <ChipFamily label="State">{stateChips.map(renderChip)}{notMergedChip}</ChipFamily>
        <ChipFamily label="Activity">{activityChips.map(renderChip)}</ChipFamily>
        {repoChips.length > 0 && <ChipFamily label="Repo">{repoChips.map(renderChip)}</ChipFamily>}
        {(quickActive(quick) || q) && (
          <button type="button" data-slot="clear-filters" onClick={clear} className="text-muted-foreground hover:text-foreground inline-flex h-7 items-center gap-1 px-1.5 text-[13px]">
            <X className="size-3.5" /> Clear
          </button>
        )}
      </div>
  );
  const sortSelect = (
          <Select value={sort} onValueChange={(v) => setSort(v as ListSort)}>
            <Tip label={`Sort: ${SORT_LABELS[sort]}`}>
              <SelectTrigger className="h-8 w-40" aria-label="Sort"><span className="text-muted-foreground text-xs">Sort</span><SelectValue /></SelectTrigger>
            </Tip>
            <SelectContent>{(Object.keys(SORT_LABELS) as ListSort[]).map((k) => <SelectItem key={k} value={k}>{SORT_LABELS[k]}</SelectItem>)}</SelectContent>
          </Select>
  );
  const searchBox = (
        <label className="bg-card focus-within:ring-ring/40 flex h-8 min-w-48 flex-1 items-center gap-2 rounded-md border px-2.5 focus-within:ring-2 sm:max-w-72 max-md:h-11 max-md:min-w-0">
          <Search className="text-muted-foreground size-4 shrink-0" strokeWidth={1.5} />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents…" aria-label="Search workstreams"
            className="h-auto rounded-none border-0 bg-transparent px-0 py-0 focus-visible:ring-0 flex-1 md:text-[13px]" />
          {q && <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="text-muted-foreground hover:text-foreground max-md:-mr-2 max-md:inline-flex max-md:size-11 max-md:items-center max-md:justify-center"><X className="size-3.5" /></button>}
        </label>
  );
  const laneActions = (
    <>
      {lane === "DONE" && visible.length > 0 && <span className="text-muted-foreground"><CopyDone cards={visible} /></span>}
      {lane && <span className="text-muted-foreground"><LaneActions lane={lane} cards={visible} /></span>}
    </>
  );
  if (narrow) {
    // A phone: the search box and a Filters button (with how many chips are on) on one line; the
    // chips and the sort live in a bottom sheet. The count and the lane's bulk verbs stay in view.
    const active = QUICK_GROUPS.reduce((n, g) => n + quick[g].length, 0) + (quick.notMerged ? 0 : 1);
    return (
      <div data-slot="filter-bar" className="space-y-2">
        <div className="flex items-center gap-2">
          {searchBox}
          <Button variant="outline" className="h-11 shrink-0" data-slot="filters-button" aria-haspopup="dialog" onClick={() => setSheet(true)}>
            <ListFilter className="size-4" />Filters{active > 0 && <span data-slot="filters-active" className="bg-foreground text-background rounded-full px-1.5 text-[11px] tabular-nums">{active}</span>}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums" data-slot="agents-count">{loaded ? `${visible.length} of ${total}` : <Skeleton className="h-3 w-16" />}</span>
          <span className="ml-auto flex items-center gap-2">{laneActions}</span>
        </div>
        <BottomSheet open={sheet} onClose={() => setSheet(false)} title="Filters" slot="filter-sheet">
          {chipGroup}
          <div className="flex items-center justify-between gap-2">{sortSelect}<Button onClick={() => setSheet(false)}>Show {visible.length}</Button></div>
        </BottomSheet>
      </div>
    );
  }
  return (
    <div data-slot="filter-bar" className="space-y-2">
      {chipGroup}
      <div className="flex flex-wrap items-center gap-2">
        {searchBox}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums" data-slot="agents-count">{loaded ? `${visible.length} of ${total}` : <Skeleton className="h-3 w-16" />}</span>
          {laneActions}
          {sortSelect}
        </div>
      </div>
    </div>
  );
}

// ---- the row ----

// One template for every row: the list's `--list-cols` (useListLayout). gap / padding:
// workstream.LIST_GAP_PX / LIST_PAD_PX.
const GRID = "grid items-center gap-x-3 px-4 grid-cols-[var(--list-cols)]";
/** The checks & review badges, compact: the Checks & review cell and its folded copies. */
const SIGNALS = "[&_[data-slot=badge]]:px-1.5 [&_[data-slot=badge]]:py-0 [&_[data-slot=badge]]:text-[10px] [&_[data-slot=badge]_svg]:size-2.5";

/** Lines added/removed, compact: green `+N`, red `-N` — a PR's own diffstat (gh, free) or, for a
 *  branch with no PR yet, the worktree's `git diff` against base (useSummary). */
function Diffstat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span data-slot="diffstat" className="shrink-0 tabular-nums">
      <span className="text-emerald-700 dark:text-emerald-400">+{additions}</span>{" "}
      <span className="text-destructive">−{deletions}</span>
    </span>
  );
}

function ListHeader({ cols }: { cols: ListColumn[] }) {
  return (
    <div role="row" data-slot="workstream-list-header" className={`${GRID} text-muted-foreground h-9 border-b text-xs`}>
      {cols.map((c) => (
        <div key={c.key} role="columnheader" data-col={c.key} className={`truncate ${c.key === "actions" ? "text-right" : ""}`}>
          {c.key === "workstream" ? c.label : <span data-col-part={c.key} className="inline-block w-max">{c.label}</span>}
        </div>
      ))}
    </div>
  );
}

export const TONE_DOT: Record<RowTone, DotTone> = { running: "building", failed: "error", attention: "warning", ready: "ready", neutral: "neutral" };
export const TONE_LABEL: Record<RowTone, string> = { running: "Running", failed: "Error", attention: "Needs you", ready: "Ready", neutral: "Idle" };

/** The agent page a row opens: its PR page, or its local-session page. */
export function detailPath(row: Pick<Row, "repo" | "branch" | "lane" | "prNumber">): string | null {
  if (row.prNumber) return `/${row.repo}/prs/${row.prNumber}`;
  if (row.lane !== "DONE" && !row.branch.startsWith("opt-")) return `/${row.repo}/local/${encodeURIComponent(row.branch)}`;
  return null;
}

// A click on the row (not on one of its controls) opens the agent page. Menus portal out of the
// row's DOM but React still bubbles their clicks here — hence the contains().
const INTERACTIVE = "button, a, input, textarea, select, dialog, [role=menu], [role=menuitem], [role=dialog]";
function openOnRowClick(row: Row) {
  return (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (!e.currentTarget.contains(t) || t.closest(INTERACTIVE)) return;
    const to = detailPath(row);
    if (to) navigate(to);
  };
}

/** The newest thing asked of the agent — what Vercel's row shows as the commit message. */
export function latestInstruction(row: Row): string {
  const last = row.transcript?.[row.transcript.length - 1];
  const text = last ? (last.instruction ?? promptInstruction(last.prompt)) : row.prompt;
  return (text || "").replace(/\s+/g, " ").trim();
}

export function AgentRow({ row, fold = NO_FOLD, stacked = false }: { row: Row; fold?: ListFold; stacked?: boolean }) {
  const isDone = row.lane === "DONE";
  const pill = prPill(row);
  const [busy, setBusy] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [terminalOpen, setTerminalOpen] = useTerminalOpen(row); // "New chat" pops its conversation open on arrival
  const tone = rowTone(row);
  const reasons = attentionReasons(row);
  const multiInstance = instanceChoices().length > 1; // instance is a phone-only subline detail, not its own column
  const instance = rowInstance(row, thisInstance());
  const to = detailPath(row);
  const model = modelBadge(row.agentMeta?.model, row.worktreePath || row.prNumber ? modelFor(row) : undefined);
  const error = row.agentStatus === "error" ? row.agentError : undefined;
  const hasMenu = !isDone;
  // A PR's own diffstat (gh, free) when there is one; otherwise the worktree's `git diff` against
  // base (useSummary — shared with the card, cached/polled there already).
  const localSummary = useSummary(row.prNumber ? undefined : row);
  const diffAdditions = row.prNumber ? row.prAdditions : localSummary?.additions;
  const diffDeletions = row.prNumber ? row.prDeletions : localSummary?.deletions;
  const hasDiff = Boolean((diffAdditions ?? 0) > 0 || (diffDeletions ?? 0) > 0);
  const diffstat = hasDiff && <Diffstat additions={diffAdditions ?? 0} deletions={diffDeletions ?? 0} />;
  // Right-click (or the keyboard's menu key / Shift+F10 on a focused row) opens the ⋯ menu's items
  // where the pointer is; from the keyboard there is no pointer, so it opens at the row's left edge.
  // Never from a finger: a long-press fires contextmenu too, and popped the menu while you were only
  // scrolling or holding — on touch the menu opens from the ⋯ alone (see the stacked row below).
  const lastPointer = useRef("");
  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (!hasMenu || (e.target as HTMLElement).closest("a, input, textarea")) return; // links keep the browser's menu
    if (lastPointer.current === "touch") { e.preventDefault(); return; }
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setMenuAt(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 16, y: r.bottom });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" && to) navigate(to);
  };
  const closeMenu = () => { setMenuAt(null); if (!document.activeElement || document.activeElement === document.body) ref.current?.focus({ preventScroll: true }); };
  // Create PR needs commits of its own — the same worktree summary the diffstat reads.
  const hasWork = row.prNumber ? true : (localSummary?.commits.length ?? 0) > 0;
  // The state-aware quick icons sit left of the preview cell; they only PEEK at the review cache.
  const quick = hasMenu && <QuickActionButtons row={row} hasWork={hasWork} peek onBusy={setBusy} />;
  const menu = hasMenu && <WorkstreamActions row={row} hasWork={hasWork} compact menuOnly onBusy={setBusy} onFollowUp={to ? () => navigate(`${to}/chat`) : undefined}
    onOpen={to ? () => navigate(to) : undefined} contextAt={menuAt} onContextClose={closeMenu} />;
  // The checks & review chips, one overflow item each: a chip that does not fit goes into the +N card.
  const signals: SublineItem[] = [
    row.prNumber && !isDone && { key: "checks", sep: "none", part: "signals", node: <ConditionBadges row={row} /> },
    row.prNumber && !isDone && { key: "review", sep: "none", part: "signals", node: <ReviewCluster row={row} /> },
    !row.prNumber && row.mergeClean === "conflict" && { key: "conflicts", sep: "none", part: "signals", node: <Pill tone="red">Conflicts</Pill> },
    browserKillLabel(row.browserKilled) && { key: "browser", sep: "none", part: "signals", node: <BrowserKillBadge record={row.browserKilled} /> },
  ].filter(Boolean) as SublineItem[];
  // The PR cell's pill and number; the folded checks join them, or all of it joins the subline.
  const prItems: SublineItem[] = [];
  const prLink = row.prNumber && <a href={row.prUrl} target="_blank" rel="noreferrer" data-slot="pr-link" className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-0.5 font-mono text-xs"><GitPullRequest className="size-3.5" />{row.prNumber}</a>;
  prItems.push({ key: "state", sep: "none", part: "pr", node: pill.tooltip ? <Tip label={pill.tooltip}><Pill tone={pill.tone} slot="state-pill">{pill.label}</Pill></Tip> : <Pill tone={pill.tone} slot="state-pill">{pill.label}</Pill> });
  if (prLink) prItems.push({ key: "pr", sep: "none", part: "pr", node: prLink });
  if (fold.pr) prItems.push(...signals);
  if (stacked) return (
    // A phone (or a narrow list): a taller, card-like row with no fixed-width columns — everything wraps instead of
    // scrolling sideways. Line 1 is title + status; line 2 is branch/model/PR/preview/diffstat. The
    // quick actions and ⋯ menu used to sit in their own trailing column — fixed-width touch targets
    // squeezing the title/branch text into a narrow strip that truncated badly. They now sit at the
    // end of the state/condition-badges line instead (icon-only, no forced touch-target size), so the
    // content column gets the row's full width. State/condition badges, reasons and a run error
    // follow as their own wrapping lines.
    <div
      ref={ref} role="row" tabIndex={0} data-slot="workstream-row" data-layout="stacked" data-branch={row.branch} aria-busy={busy}
      aria-label={row.title}
      onClick={openOnRowClick(row)} onKeyDown={onKeyDown}
      // A phone: no menu from a long-press or contextmenu at all, only the browser's own on a link.
      // No selection or iOS callout either, which looked like a menu popping; links keep their callout.
      onContextMenu={(e) => { if (!(e.target as HTMLElement).closest("a, input, textarea")) e.preventDefault(); }}
      className={`active:bg-accent/40 flex items-start select-none [-webkit-touch-callout:none] [&_a]:[-webkit-touch-callout:default] gap-1 border-b py-3 px-4 text-sm outline-none last:border-b-0 ${to ? "cursor-pointer" : ""} ${busy ? "pointer-events-none opacity-60" : ""}`}
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div role="cell" className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate font-medium">{row.title}</span>
          <RunStatus row={row} tone={tone} reasons={reasons} />
        </div>
        <div role="cell" className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
          <span className="shrink-0">{row.repo}</span>
          <ThreadChips repo={row.repo} branch={row.branch} />
          <span aria-hidden="true">·</span><span className="min-w-0 font-mono break-all">{row.branch}</span>
          {model && <><span aria-hidden="true">·</span><span data-slot="model-label">{model.label}</span></>}
          {prLink}
          {!isDone && <PrPreviewInline row={row} />}
          {diffstat && <><span aria-hidden="true">·</span>{diffstat}</>}
          {instance && multiInstance && <><span aria-hidden="true">·</span><span data-slot="instance-chip">{instance}</span></>}
        </div>
        {/* No description lines here (the orchestrator's plan, a grant): a stacked row keeps its chips only. */}
        {!isDone && <UpkeepNote upkeep={row.upkeep} running={row.agentStatus === "running"} />}
        <div role="cell" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
          {pill.tooltip ? <Tip label={pill.tooltip}><Pill tone={pill.tone} slot="state-pill">{pill.label}</Pill></Tip> : <Pill tone={pill.tone} slot="state-pill">{pill.label}</Pill>}
          {row.prNumber && !isDone && <ConditionBadges row={row} />}
          {row.prNumber && !isDone && <ReviewCluster row={row} />}
          {!row.prNumber && row.mergeClean === "conflict" && <Pill tone="red">Conflicts</Pill>}
          <BrowserKillBadge record={row.browserKilled} />
          {(quick || menu) && <div data-slot="row-actions" className="ml-auto flex shrink-0 items-center gap-1">{quick}{menu}</div>}
        </div>
        {reasons.length > 0 && <div role="cell" data-slot="row-reasons" className="text-geist-warning-fg text-xs">{reasons.join(" · ")}</div>}
        {error && <div role="cell" data-slot="row-error" className="text-geist-red line-clamp-3 text-xs break-words">{error}</div>}
      </div>
      {!isDone && <TerminalDialog row={row} open={terminalOpen} onClose={() => setTerminalOpen(false)} />}
    </div>
  );
  return (
    <div
      ref={ref} role="row" tabIndex={0} data-slot="workstream-row" data-branch={row.branch} aria-busy={busy}
      aria-label={row.title} aria-haspopup={hasMenu ? "menu" : undefined}
      onClick={openOnRowClick(row)} onContextMenu={onContextMenu} onKeyDown={onKeyDown}
      onPointerDown={(e) => { lastPointer.current = e.pointerType; }}
      // `content-visibility: auto`: a row off screen skips its layout and paint, so a dock slide (the
      // page frame changes width every frame) lays out only the rows you see. 56px is its fixed height.
      className={`${GRID} hover:bg-accent/40 focus-visible:bg-accent/40 h-14 border-b md:[content-visibility:auto] md:[contain-intrinsic-size:auto_56px] text-sm outline-none last:border-b-0 ${to ? "cursor-pointer" : ""} ${busy ? "pointer-events-none opacity-60" : ""}`}
    >
      <div role="cell" className="min-w-0">
        <div className="truncate font-medium">{row.title}</div>
        <Subline className={SIGNALS} items={[
          // A folded column leads the subline: the status, then the PR with its checks.
          fold.status && { key: "status", sep: "after", node: <RunStatus row={row} tone={tone} reasons={reasons} /> },
          ...(fold.pr ? prItems.map((i, k) => (k === prItems.length - 1 ? { ...i, sep: "after" as const } : i)) : []),
          { key: "repo", sep: "none", node: row.repo },
          { key: "threads", sep: "none", node: <ThreadChips repo={row.repo} branch={row.branch} iconOnly /> },
          model && { key: "model", node: <Tip label={model.title}><span data-slot="model-label">{model.label}</span></Tip> },
          !isDone && { key: "preview", sep: "none", node: <PrPreviewInline row={row} /> },
          diffstat && { key: "diffstat", node: diffstat },
          error && { key: "error", node: <span data-slot="row-error" className="text-geist-red">{error}</span> },
        ]} />
      </div>
      {!fold.status && <div role="cell" className="min-w-0"><RunStatus row={row} tone={tone} reasons={reasons} /></div>}
      {!fold.pr && (
        <div role="cell" className="min-w-0">
          {/* Folded, the checks & review follow the PR number. */}
          <Subline slot="row-pr-line" className={SIGNALS} items={fold.signals ? [...prItems, ...signals] : prItems} />
        </div>
      )}
      {!fold.signals && (
        <div role="cell" data-slot="row-signals" className="min-w-0">
          <Subline slot="row-signals-line" className={SIGNALS} items={signals} />
        </div>
      )}
      <div role="cell" className="flex justify-end">
        <div data-col-part="actions" className="flex w-max items-center gap-1">
          {quick}
          {!isDone && <PreviewCell row={row} />}
          {menu}
          {!isDone && <TerminalDialog row={row} open={terminalOpen} onClose={() => setTerminalOpen(false)} />}
        </div>
      </div>
    </div>
  );
}

/** One item of the grid row's subline. `sep` places its "·" (before it by default); `part` names
 *  the column whose width it counts toward (useListLayout measures it wherever it sits). */
type SublineItem = { key: string; node: ReactNode; sep?: "before" | "after" | "none"; part?: keyof ListWidths };
const SUBLINE_GAP_PX = 4; // gap-1
const CHIP_FALLBACK_PX = 28; // the +N chip's width before it is first drawn

/** The subline: one line, never clipped mid-item. Items that do not fit leave the flow (still drawn
 *  invisibly, so they stay measurable) and a trailing `+N` chip lists them in full
 *  (workstream.sublineOverflow decides which). Widths are read when they settle (afterDockMotion). */
function Subline({ items, slot = "row-subline", className = "" }: { items: (SublineItem | false | null | undefined | "" | 0)[]; slot?: string; className?: string }) {
  const list = items.filter(Boolean) as SublineItem[];
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const keys = list.map((i) => i.key).join(",");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const parts = [...el.querySelectorAll<HTMLElement>(":scope > [data-subline-item]")];
      const chip = el.querySelector<HTMLElement>(":scope > [data-slot=subline-more]");
      const gap = parseFloat(getComputedStyle(el).columnGap);
      const out = sublineOverflow(parts.map((p) => p.offsetWidth), el.clientWidth, Number.isFinite(gap) ? gap : SUBLINE_GAP_PX, chip?.offsetWidth || CHIP_FALLBACK_PX);
      const next = out.map((i) => parts[i]!.dataset.sublineItem!);
      setHidden((prev) => (prev.join(",") === next.join(",") ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => afterDockMotion(measure));
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    return () => ro.disconnect();
  }, [keys]);
  const dot = <span aria-hidden="true">·</span>;
  const over = list.filter((i) => hidden.includes(i.key));
  return (
    // relative + overflow-hidden: a hidden item is drawn out of the flow and never over the next cell.
    <div ref={ref} data-slot={slot} data-overflow-line="" className={`text-muted-foreground relative flex min-w-0 items-center gap-1 overflow-hidden text-xs whitespace-nowrap ${className}`}>
      {list.map((i) => (
        <span key={i.key} data-subline-item={i.key} data-slot={i.key === "status" ? "folded-status" : undefined}
          aria-hidden={hidden.includes(i.key) || undefined} data-col-part={i.part}
          className={`flex shrink-0 items-center gap-1 ${hidden.includes(i.key) ? "invisible absolute top-0 left-0" : ""}`}>
          {(i.sep ?? "before") === "before" && dot}{i.node}{i.sep === "after" && dot}
        </span>
      ))}
      {over.length > 0 && <SublineMore items={over} />}
    </div>
  );
}

/** The `+N` chip: hover opens its card on a mouse, a click or tap pins it open until a second one
 *  (or Esc, or a click outside) closes it — a hover card ignores touch, so this is a popover. Neither
 *  the tap nor a click in the card opens the row. */
function SublineMore({ items }: { items: SublineItem[] }) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false); // opened by a click or tap: leaving with the pointer keeps it open
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hover = (on: boolean) => (e: { pointerType: string }) => {
    if (e.pointerType !== "mouse" || pinned.current) return;
    clearTimeout(closing.current);
    if (on) setOpen(true);
    else closing.current = setTimeout(() => setOpen(false), 150);
  };
  useEffect(() => () => clearTimeout(closing.current), []);
  // preventDefault skips Radix's own toggle: the hover may already have opened the card, so a click
  // pins it rather than toggling it shut.
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    clearTimeout(closing.current);
    pinned.current = !pinned.current;
    setOpen(pinned.current);
  };
  const onOpenChange = (o: boolean) => { if (!o) pinned.current = false; setOpen(o); };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" data-slot="subline-more" aria-label={`${items.length} more: ${items.map((i) => i.key).join(", ")}`}
          onClick={onClick} onPointerEnter={hover(true)} onPointerLeave={hover(false)}
          className="bg-muted text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex h-4 shrink-0 items-center rounded-sm px-1.5 text-[11px] font-medium tabular-nums outline-none focus-visible:ring-2">
          +{items.length}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" data-slot="subline-more-card" className="w-auto max-w-80 p-0 text-xs"
        onOpenAutoFocus={(e) => e.preventDefault()} onClick={(e) => e.stopPropagation()}
        onPointerEnter={hover(true)} onPointerLeave={hover(false)}>
        {/* One item a line; an item's own leading "·" (the PR preview link draws one) is hidden here. */}
        <ul className="divide-y">
          {items.map((i) => <li key={i.key} data-subline-hidden={i.key} className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1 px-3 py-2 break-words [&>[aria-hidden=true]:first-child]:hidden">{i.node}</li>)}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** The status cell: dot + label, and the duration. While running, a spinner and an elapsed time read
 *  off the ONE shared ticker (lib/ticker) — only this cell re-renders each second, never the list. */
export function RunStatus({ row, tone, reasons }: { row: Row; tone: RowTone; reasons: string[] }) {
  const running = row.agentStatus === "running" && Boolean(row.agentStartedAt);
  const now = useNow(running);
  const duration = running ? undefined : rowDuration(row);
  return (
    <div data-slot="run-status" data-col-part="status" className="flex w-max items-center gap-2 whitespace-nowrap">
      <StatusHoverCard row={row}>
        {tone === "running" ? <Loader2 data-slot="run-spinner" aria-hidden="true" className="text-geist-amber size-3 shrink-0 animate-spin" /> : <StatusDot tone={TONE_DOT[tone]} />}
        <span data-tone={tone} className="truncate font-medium">{TONE_LABEL[tone]}</span>
      </StatusHoverCard>
      {running && now !== undefined && (
        <Tip label={`Running since ${new Date(row.agentStartedAt!).toLocaleTimeString()}`}>
          <span data-slot="elapsed" className="text-muted-foreground tabular-nums">{formatElapsed(now - row.agentStartedAt!)}</span>
        </Tip>
      )}
      {duration !== undefined && <span className="text-muted-foreground tabular-nums">{formatDuration(duration)}</span>}
    </div>
  );
}
