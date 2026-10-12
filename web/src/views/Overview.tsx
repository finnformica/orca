import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useAtom } from "jotai";
import { Bot, ExternalLink, Eye, Loader2, Play, Search, SquareTerminal, X } from "lucide-react";
import { repoFilterAtom } from "@/lib/atoms";
import { navigate } from "@/lib/route";
import { aggregateProfiles, useHealth, useHealthHistory, useUsage } from "@/lib/vitals";
import {
  baseBranch, instanceChoices, rerunAgent, thisInstance, useRepos, useWorkstreams, type Row,
} from "../store";
import {
  DEFAULT_LIST_FILTER, LANE_LABELS, OVERVIEW_LANES, SORT_LABELS, ago, attentionReasons, filterRows, lastActivity,
  overviewStats, recentActivity, rowInstance, rowTone, sortRows, sparklineSegments,
  type ActivityItem, type Attention, type ListFilter, type ListSort, type OverviewLane, type RowTone,
} from "../workstream";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TerminalDialog } from "@/components/Terminal";
import { WorkstreamActions } from "./WorkstreamActions";
import { PreviewControl } from "./PreviewControl";
import { ReviewCluster } from "./Review";
import { AgentBadge, CardModelPicker, ConditionBadges, CopyDone, CopyMenu, LaneActions, NewDraft, useSummary, useTerminalOpen } from "./Board";

// The board's default view: a Vercel-style overview. Stat tiles up top (what's running, what's
// waiting on you, the PR pipeline, today's merges, usage, each machine), then ONE dense list of
// every workstream with its actions inline, and a recent-activity feed beside it. Everything is
// derived from the rows the swimlanes already render (workstream.overviewStats / filterRows /
// recentActivity) — the overview adds no endpoint. The swimlanes stay one click away (Board).
export function Overview() {
  const all = useWorkstreams();
  const [repo, setRepo] = useAtom(repoFilterAtom); // shared with the Board view's repo filter
  const [rest, setRest] = useState<Omit<ListFilter, "repo">>(DEFAULT_LIST_FILTER);
  const [sort, setSort] = useState<ListSort>("updated");
  const filter: ListFilter = { ...rest, repo };
  const setFilter = (patch: Partial<ListFilter>) => {
    const { repo: r, ...others } = patch;
    if (r !== undefined) setRepo(r);
    setRest((f) => ({ ...f, ...others }));
  };
  const here = thisInstance();
  // The tiles follow the repo scope (as the swimlanes do); the list's other filters narrow only it.
  const scoped = repo === "all" ? all : all.filter((r) => r.repo === repo);
  const stats = overviewStats(scoped);
  const visible = sortRows(filterRows(all, filter, here), sort);

  return (
    <div className="space-y-6">
      <StatTiles rows={scoped} stats={stats} filter={filter} setFilter={setFilter} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-label="Workstreams" className="min-w-0 space-y-3">
          <FilterBar rows={all} visible={visible} filter={filter} setFilter={setFilter} sort={sort} setSort={setSort} />
          <WorkstreamList rows={visible} onClear={() => { setRest(DEFAULT_LIST_FILTER); setRepo("all"); }} />
        </section>
        <aside className="min-w-0 space-y-6">
          <Panel title="New draft">
            <div className="p-2"><NewDraft /></div>
          </Panel>
          <RecentActivity rows={scoped} />
        </aside>
      </div>
    </div>
  );
}

// ---- stat tiles ----

type StatsProps = { rows: Row[]; stats: ReturnType<typeof overviewStats>; filter: ListFilter; setFilter: (f: Partial<ListFilter>) => void };

function StatTiles({ rows, stats, filter, setFilter }: StatsProps) {
  const reasons = countReasons(rows);
  const instances = instanceChoices();
  const toggleState = (state: OverviewLane) => setFilter({ state: filter.state === state ? "all" : state });
  return (
    <div data-slot="stat-tiles" className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3">
      <Tile label="Running" value={stats.running} hint="agents working now" slot="running">
        <Sparkline values={stats.turnsByHour} label="Runs started per hour, last 24 hours" />
      </Tile>
      <Tile
        label="Awaiting you" value={stats.attention} slot="attention"
        tone={stats.attention ? "attention" : undefined}
        pressed={filter.attention}
        onClick={() => setFilter({ attention: !filter.attention })}
        title="Show only workstreams that need you (click again to clear)"
        hint={reasons.length ? reasons.map(([why, n]) => `${n} ${why}`).join(" · ") : "nothing needs you"}
      />
      <Tile label="Open PRs" value={stats.prs.total} slot="prs" hint={`${stats.local} local branch${stats.local === 1 ? "" : "es"}`} below={
        <PipelineBar
          parts={[
            { lane: "DRAFT", n: stats.prs.draft },
            { lane: "IN_REVIEW", n: stats.prs.inReview },
            { lane: "MERGEABLE", n: stats.prs.mergeable },
          ]}
          active={filter.state}
          onPick={toggleState}
        />
      } />
      <Tile
        label="Merged today" value={stats.mergedToday} slot="merged"
        tone={stats.mergedToday ? "ready" : undefined}
        pressed={filter.state === "DONE"} onClick={() => toggleState("DONE")} title="Show today's merges"
        hint={stats.mergedToday ? "shipped since midnight" : "nothing merged yet"}
      />
      <UsageTile />
      {instances.length > 1 && instances.map((i) => <InstanceTile key={i} instance={i} here={i === thisInstance()} />)}
    </div>
  );
}

function countReasons(rows: Row[]): [Attention, number][] {
  const n = new Map<Attention, number>();
  for (const r of rows) for (const why of attentionReasons(r)) n.set(why, (n.get(why) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]);
}

const TONE_TEXT: Partial<Record<RowTone, string>> = {
  attention: "text-amber-600 dark:text-amber-400",
  failed: "text-red-600 dark:text-red-400",
  ready: "text-emerald-600 dark:text-emerald-400",
};

// `below` puts the figure's chart under the number at full width (one that needs the room), not beside it.
function Tile({ label, value, hint, tone, slot, pressed, onClick, title, children, below }: {
  label: string; value: ReactNode; hint?: ReactNode; tone?: RowTone; slot: string;
  pressed?: boolean; onClick?: () => void; title?: string; children?: ReactNode; below?: ReactNode;
}) {
  const body = (
    <>
      <div className="text-muted-foreground text-xs font-medium">{label}</div>
      <div className="flex items-end justify-between gap-3">
        <div data-slot="stat-value" className={`text-3xl font-semibold tracking-tight ${tone ? TONE_TEXT[tone] ?? "" : ""}`}>{value}</div>
        {children && <div className="min-w-0 flex-1 pb-1">{children}</div>}
      </div>
      {below}
      {hint && <div className="text-muted-foreground truncate text-xs" title={typeof hint === "string" ? hint : undefined}>{hint}</div>}
    </>
  );
  const cls = `bg-card flex min-w-0 flex-col gap-2 rounded-lg border p-4 text-left ${pressed ? "ring-foreground/70 ring-1" : ""}`;
  return onClick
    ? <button type="button" data-slot={`tile-${slot}`} aria-pressed={pressed} title={title} onClick={onClick} className={`${cls} hover:bg-accent/40 transition-colors`}>{body}</button>
    : <div data-slot={`tile-${slot}`} className={cls}>{body}</div>;
}

// 24 thin columns, the current hour in full ink and the rest receding — the shape of the day, not
// a reading of it (the tooltip per column has the number).
function Sparkline({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values);
  const W = 120, H = 32, gap = 2, w = (W - gap * (values.length - 1)) / values.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-8 w-full" role="img" aria-label={label} preserveAspectRatio="none">
      {values.map((v, i) => {
        const h = v ? Math.max(2, (v / max) * H) : 1;
        const hoursAgo = values.length - 1 - i;
        return (
          <rect key={i} x={i * (w + gap)} y={H - h} width={w} height={h} rx={1}
            className={i === values.length - 1 ? "fill-foreground" : v ? "fill-foreground/35" : "fill-foreground/10"}>
            <title>{`${v} run${v === 1 ? "" : "s"} ${hoursAgo ? `${hoursAgo}h ago` : "this hour"}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

// The open-PR pipeline as one segmented bar (draft → in review → mergeable), each segment a filter.
// Monochrome steps for the two in-flight states; mergeable carries the "ready" green.
const SEGMENT: Record<string, string> = { DRAFT: "bg-foreground/20", IN_REVIEW: "bg-foreground/50", MERGEABLE: "bg-emerald-500" };
function PipelineBar({ parts, active, onPick }: { parts: { lane: OverviewLane; n: number }[]; active: ListFilter["state"]; onPick: (l: OverviewLane) => void }) {
  const total = parts.reduce((s, p) => s + p.n, 0);
  return (
    <div className="space-y-1.5">
      <div className="bg-muted flex h-1.5 gap-0.5 overflow-hidden rounded-full">
        {total > 0 && parts.filter((p) => p.n).map((p) => (
          <div key={p.lane} className={SEGMENT[p.lane]} style={{ width: `${(p.n / total) * 100}%` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px]">
        {parts.map((p) => (
          <button key={p.lane} type="button" data-slot={`pipeline-${p.lane}`} onClick={() => onPick(p.lane)} aria-pressed={active === p.lane}
            className={`inline-flex items-center gap-1 rounded px-0.5 whitespace-nowrap hover:underline ${active === p.lane ? "text-foreground font-semibold" : "text-muted-foreground"}`}>
            <span className={`size-1.5 rounded-full ${SEGMENT[p.lane]}`} aria-hidden="true" />
            {LANE_LABELS[p.lane]} {p.n}
          </button>
        ))}
      </div>
    </div>
  );
}

const zone = (pct: number) => (pct >= 90 ? "bg-red-500" : pct >= 75 ? "bg-amber-500" : "bg-emerald-500");

function Meter({ label, pct, detail }: { label: string; pct: number; detail?: string }) {
  return (
    <div className="min-w-0" title={detail}>
      <div className="flex justify-between text-[10px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{Math.round(pct)}%</span>
      </div>
      <div className="bg-muted mt-0.5 h-1 overflow-hidden rounded-full">
        <div className={`h-full rounded-full ${zone(pct)}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
    </div>
  );
}

// Claude usage as a tile: the same reading the header meter shows (one shared poll), the 5-hour
// window as the number since it is the one that stops work today.
function UsageTile() {
  const usage = useUsage();
  const fleet = usage?.profiles ? aggregateProfiles(usage.profiles) : null;
  const c = fleet ?? usage?.claude ?? null;
  if (!c) return null;
  const fable = "fable" in c ? c.fable : null;
  return (
    <Tile label={fleet ? `Claude usage · ${fleet.count} logins` : "Claude usage"} value={`${c.fiveHour.utilization}%`} slot="usage"
      tone={c.fiveHour.utilization >= 90 ? "failed" : c.fiveHour.utilization >= 75 ? "attention" : undefined}
      hint="5-hour window">
      <div className="space-y-1">
        <Meter label="1w" pct={c.sevenDay.utilization} />
        {fable && <Meter label="fable" pct={fable.utilization} />}
      </div>
    </Tile>
  );
}

// One machine: CPU as the number, then CPU and memory over the last 24h (/api/health/history — the
// same shared loop as the header chip's graphs, running only while a tile or that popover shows it).
// Until history arrives, or when the instance has none, each line is a plain meter of the reading.
function InstanceTile({ instance, here }: { instance: string; here: boolean }) {
  const reading = useHealth(here ? undefined : instance);
  const history = useHealthHistory(instance);
  const h = reading?.health;
  const cpu = history?.map((p) => ({ at: p.at, v: p.cpuPct }));
  const mem = history?.map((p) => ({ at: p.at, v: p.memTotalGb ? (p.memUsedGb / p.memTotalGb) * 100 : 0 }));
  return (
    <Tile label={`${instance}${here ? " · here" : ""}`} slot={`instance-${instance}`}
      value={reading?.down ? "—" : h ? `${h.cpuPct}%` : "…"}
      tone={reading?.down ? "failed" : h && h.cpuPct >= 80 ? "attention" : undefined}
      hint={reading?.down ? "unreachable" : h ? `cpu · ${h.cores} cores${h.cost ? ` · $${h.cost.monthUsd.toFixed(2)} this month` : ""}` : "loading"}>
      {h && !reading?.down && (
        <div className="space-y-1">
          <Trend label="cpu" pct={h.cpuPct} points={cpu} detail={`load ${h.load1.toFixed(2)} / ${h.load5.toFixed(2)}`} />
          <Trend label="mem" pct={(h.memUsedGb / h.memTotalGb) * 100} points={mem} detail={`${h.memUsedGb} of ${h.memTotalGb} GB`} />
        </div>
      )}
    </Tile>
  );
}

/** A metric's last 24h as a one-line sparkline (gaps where the sampler was silent), now on the right. */
function Trend({ label, pct, points, detail }: { label: string; pct: number; points?: { at: number; v: number }[]; detail?: string }) {
  if (!points?.length) return <Meter label={label} pct={pct} detail={detail} />;
  const W = 120, H = 14, to = Date.now();
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[10px]" title={detail} data-slot={`trend-${label}`}>
      <span className="text-muted-foreground w-6 shrink-0">{label}</span>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-3.5 min-w-0 flex-1 text-foreground/70" role="img" aria-label={`${label} over the last 24 hours, now ${Math.round(pct)}%`}>
        {sparklineSegments(points, { from: to - 24 * 3_600_000, to, max: 100, w: W, h: H }).map((pts, i) => (
          <polyline key={i} points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <span className="w-8 shrink-0 text-right font-medium tabular-nums">{Math.round(pct)}%</span>
    </div>
  );
}

// ---- filter bar ----

function FilterBar({ rows, visible, filter, setFilter, sort, setSort }: {
  rows: Row[]; visible: Row[]; filter: ListFilter; setFilter: (f: Partial<ListFilter>) => void; sort: ListSort; setSort: (s: ListSort) => void;
}) {
  const repos = useRepos();
  const instances = instanceChoices();
  // Counts per state reflect every filter EXCEPT state, so each chip says what clicking it shows.
  const byState = filterRows(rows, { ...filter, state: "all" }, thisInstance());
  const count = (lane: OverviewLane) => byState.filter((r) => r.lane === lane).length;
  const needYou = filterRows(rows, { ...filter, attention: false }, thisInstance()).filter((r) => attentionReasons(r).length).length;
  const chip = (active: boolean) =>
    `inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors ${active ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`;
  return (
    <div data-slot="filter-bar" className="flex flex-wrap items-center gap-2">
      <label className="bg-background focus-within:ring-ring/50 flex h-8 min-w-48 flex-1 items-center gap-2 rounded-md border px-2 focus-within:ring-2 sm:max-w-72">
        <Search className="text-muted-foreground size-3.5 shrink-0" />
        <input
          value={filter.q} onChange={(e) => setFilter({ q: e.target.value })} placeholder="Search workstreams…" aria-label="Search workstreams"
          className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
        {filter.q && <button type="button" onClick={() => setFilter({ q: "" })} aria-label="Clear search" className="text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>}
      </label>
      {repos.length > 1 && (
        <Select value={filter.repo} onValueChange={(v) => setFilter({ repo: v })}>
          <SelectTrigger className="h-8 w-36" aria-label="Repo"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All repos</SelectItem>
            {repos.map((r) => <SelectItem key={r.name} value={r.name}>{r.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      {instances.length > 1 && (
        <Select value={filter.instance} onValueChange={(v) => setFilter({ instance: v })}>
          <SelectTrigger className="h-8 w-36" aria-label="Instance"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All instances</SelectItem>
            {instances.map((i) => <SelectItem key={i} value={i}>{i}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      <div role="group" aria-label="State" className="flex flex-wrap items-center gap-0.5 rounded-md border p-0.5">
        <button type="button" className={chip(filter.state === "all")} aria-pressed={filter.state === "all"} onClick={() => setFilter({ state: "all" })}>
          All <span className="opacity-60">{byState.length}</span>
        </button>
        {OVERVIEW_LANES.map((lane) => (
          <button key={lane} type="button" className={chip(filter.state === lane)} aria-pressed={filter.state === lane} onClick={() => setFilter({ state: lane })}>
            {LANE_LABELS[lane]} <span className="opacity-60">{count(lane)}</span>
          </button>
        ))}
      </div>
      <button type="button" aria-pressed={filter.attention} onClick={() => setFilter({ attention: !filter.attention })}
        className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs font-medium ${filter.attention ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}>
        <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" /> Needs you <span className="opacity-60">{needYou}</span>
      </button>
      <div className="ml-auto flex items-center gap-2">
        {/* The swimlanes' bulk verbs, for the lane the list is showing — same menu, same per-card actions. */}
        {filter.state !== "all" && filter.state === "DONE" && visible.length > 0 && <span className="text-muted-foreground"><CopyDone cards={visible} /></span>}
        {filter.state !== "all" && <span className="text-muted-foreground"><LaneActions lane={filter.state} cards={visible} /></span>}
        <Select value={sort} onValueChange={(v) => setSort(v as ListSort)}>
          <SelectTrigger className="h-8 w-40" aria-label="Sort"><span className="text-muted-foreground text-xs">Sort</span><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(SORT_LABELS) as ListSort[]).map((k) => <SelectItem key={k} value={k}>{SORT_LABELS[k]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// ---- the list ----

// Columns: workstream · state · signals · agent · PR · changes · updated · actions. A grid rather
// than a <table> so a row can hold the inline follow-up composer WorkstreamActions opens. Every
// track is sized without `auto`: each row is its own grid, so a content-sized track would line up
// differently on a row that has one more button (Merge).
const COLS = "grid grid-cols-[minmax(15rem,2.2fr)_6.5rem_minmax(9rem,1.3fr)_minmax(10rem,1.2fr)_4.5rem_5.5rem_5.5rem_15rem] items-center gap-x-3";

function WorkstreamList({ rows, onClear }: { rows: Row[]; onClear: () => void }) {
  return (
    <div data-slot="workstream-list" className="bg-card overflow-x-auto rounded-lg border">
      <div className="min-w-[73rem]">
        <div role="row" className={`${COLS} text-muted-foreground border-b px-4 py-2 text-xs font-medium`}>
          <span>Workstream</span><span>State</span><span>Signals</span><span>Agent</span><span>PR</span><span>Changes</span><span>Updated</span><span className="text-right">Actions</span>
        </div>
        {rows.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 px-4 py-12 text-sm">
            No workstreams match.
            <Button size="sm" variant="outline" onClick={onClear}>Clear filters</Button>
          </div>
        ) : rows.map((r) => <ListRow key={r.repo + r.branch} row={r} />)}
      </div>
    </div>
  );
}

const DOT: Record<RowTone, string> = {
  running: "bg-sky-500 animate-pulse",
  failed: "bg-red-500",
  attention: "bg-amber-500",
  ready: "bg-emerald-500",
  neutral: "bg-foreground/25",
};
const TONE_LABEL: Record<RowTone, string> = { running: "Running", failed: "Failed", attention: "Needs you", ready: "Ready", neutral: "Idle" };

/** The detail route a row opens: its PR page, or its local-session page. */
function detailPath(row: Row): string | null {
  if (row.prNumber) return `/${row.repo}/prs/${row.prNumber}`;
  if (row.lane !== "DONE" && !row.branch.startsWith("opt-")) return `/${row.repo}/local/${encodeURIComponent(row.branch)}`;
  return null;
}

// A click on the row (not on one of its controls) opens the detail page, as the card's title does.
// Menus portal out of the row's DOM but React still bubbles their clicks here — hence the contains().
const INTERACTIVE = "button, a, input, textarea, select, dialog, [role=menu], [role=menuitem], [role=dialog]";
function openOnRowClick(row: Row) {
  return (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (!e.currentTarget.contains(t) || t.closest(INTERACTIVE)) return;
    const to = detailPath(row);
    if (to) navigate(to);
  };
}

export function ListRow({ row }: { row: Row }) {
  const isDone = row.lane === "DONE";
  const isLocal = !row.prNumber && !isDone;
  const summary = useSummary(row);
  const hasWork = (summary?.commits.length ?? 0) > 0;
  const [busy, setBusy] = useState(false);
  const [terminalOpen, setTerminalOpen] = useTerminalOpen(row);
  const tone = rowTone(row);
  const reasons = attentionReasons(row);
  const instance = instanceChoices().length > 1 ? rowInstance(row, thisInstance()) : undefined;
  const updated = lastActivity(row);
  const to = detailPath(row);
  return (
    <div
      role="row" data-slot="workstream-row" data-branch={row.branch} aria-busy={busy}
      onClick={openOnRowClick(row)}
      className={`${COLS} hover:bg-accent/40 relative border-b px-4 py-2.5 text-sm last:border-b-0 ${to ? "cursor-pointer" : ""} ${busy ? "pointer-events-none opacity-60" : ""}`}
    >
      {busy && <Loader2 className="text-muted-foreground absolute top-1/2 left-1 size-3.5 -translate-y-1/2 animate-spin" />}
      {/* Workstream: status dot + title, then repo / instance / branch. */}
      <div className="flex min-w-0 items-start gap-2.5">
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${DOT[tone]}`} title={reasons.length ? reasons.join(", ") : TONE_LABEL[tone]} aria-label={TONE_LABEL[tone]} data-tone={tone} />
        <div className="min-w-0">
          <div className="truncate font-medium" title={row.title}>{row.title}</div>
          <div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
            <Chip>{row.repo}</Chip>
            {instance && <Chip slot="instance-chip" title={row.remote ? `Runs on ${instance}` : "Runs here"}>{instance}</Chip>}
            {row.orchestrated && <span title="Started or continued by the orchestrator, which hears when its agent finishes" aria-label="Orchestrated"><Bot className="size-3" /></span>}
            <span className="truncate font-mono text-[11px]" title={row.branch}>{row.branch}</span>
          </div>
          {row.agentStatus === "error" && row.agentError && (
            <div className="text-destructive mt-0.5 truncate text-xs" title={row.agentError}>{row.agentError}</div>
          )}
        </div>
      </div>
      <div className="text-xs">
        <span className="text-muted-foreground">{isDone ? "Merged" : LANE_LABELS[row.lane]}</span>
      </div>
      {/* Signals: the card's condition badges, at list size. */}
      <div className="flex min-w-0 flex-wrap items-center gap-1 [&_[data-slot=badge]]:px-1.5 [&_[data-slot=badge]]:py-0 [&_[data-slot=badge]]:text-[10px] [&_[data-slot=badge]_svg]:size-2.5">
        {row.following && !isDone && <Badge variant="outline" className="border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-400" title="Orca is watching this PR and auto-runs the agent on conflicts, CI and review.">Following <Eye /></Badge>}
        {row.prNumber && !isDone && <ConditionBadges row={row} />}
        {row.prNumber && !isDone && <ReviewCluster row={row} />}
        {isLocal && row.mergeClean === "conflict" && <Badge variant="destructive">Conflicts with {baseBranch(row.repo)}</Badge>}
      </div>
      {/* Agent: status (incl. Orca's check verdict) + run, then the model picker. */}
      <div className="min-w-0 space-y-0.5">
        {!isDone && (
          <div className="flex items-center gap-1 [&_[data-slot=badge]]:px-1.5 [&_[data-slot=badge]]:py-0 [&_[data-slot=badge]]:text-[10px] [&_[data-slot=badge]_svg]:size-2.5">
            {(isLocal || (row.agentStatus && row.agentStatus !== "idle")) ? <AgentBadge row={row} hasWork={hasWork} /> : <span className="text-muted-foreground text-xs">idle</span>}
            {isLocal && row.worktreePath && row.agentStatus !== "running" && (
              <button type="button" onClick={() => { setBusy(true); void rerunAgent(row).finally(() => setBusy(false)); }} title="Run agent" aria-label="Run agent"
                className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-5 items-center justify-center rounded">
                <Play className="size-3" />
              </button>
            )}
          </div>
        )}
        {!isDone && (row.agentMeta || row.agentProvider || row.worktreePath || row.prNumber) && <div className="text-xs"><CardModelPicker row={row} /></div>}
      </div>
      <div className="flex flex-col gap-0.5 text-xs">
        {row.prNumber ? <Ext href={row.prUrl}>#{row.prNumber}</Ext> : <span className="text-muted-foreground">—</span>}
        {row.previewUrl && <Ext href={row.previewUrl}>Preview</Ext>}
      </div>
      <div className="font-mono text-xs tabular-nums">
        {summary ? (
          <span title={`${summary.files.length} files`}>
            <span className="text-emerald-700 dark:text-emerald-400">+{summary.additions}</span>{" "}
            <span className="text-destructive">−{summary.deletions}</span>
          </span>
        ) : <span className="text-muted-foreground">—</span>}
      </div>
      <div className="text-muted-foreground text-xs tabular-nums" title={updated ? new Date(updated).toLocaleString() : undefined}>{ago(updated)}</div>
      {/* Actions: the card's own controls, icon-sized — Test/preview, terminal, Follow up, Merge, the ⋯ menu, copy. */}
      <div className="flex min-w-0 items-start justify-end gap-1">
        {!isDone && (
          <WorkstreamActions
            row={row} hasWork={hasWork} onBusy={setBusy} compact
            leading={
              <>
                <PreviewControl row={row} compact />
                <Button size="icon" variant="outline" className="size-7" onClick={() => setTerminalOpen(true)} title="Open terminal" aria-label="Open terminal">
                  <SquareTerminal className="size-3.5" />
                </Button>
              </>
            }
          />
        )}
        <span className="inline-flex h-7 items-center px-1"><CopyMenu row={row} /></span>
        {!isDone && <TerminalDialog row={row} open={terminalOpen} onClose={() => setTerminalOpen(false)} />}
      </div>
    </div>
  );
}

const Chip = ({ children, slot, title }: { children: ReactNode; slot?: string; title?: string }) => (
  <span data-slot={slot} title={title} className="shrink-0 rounded border px-1 text-[10px] leading-4 tracking-wide">{children}</span>
);

const Ext = ({ href, children }: { href?: string; children: ReactNode }) => (
  <a className="hover:text-foreground text-muted-foreground inline-flex items-center gap-0.5 hover:underline" href={href} target="_blank" rel="noreferrer">
    {children} <ExternalLink className="size-3" />
  </a>
);

// ---- side panels ----

function Panel({ title, description, children, slot }: { title: string; description?: string; children: ReactNode; slot?: string }) {
  return (
    <div data-slot={slot} className="bg-card rounded-lg border">
      <div className="border-b px-4 py-3">
        <div className="text-sm font-semibold">{title}</div>
        {description && <div className="text-muted-foreground mt-0.5 text-xs">{description}</div>}
      </div>
      {children}
    </div>
  );
}

const ACTIVITY_DOT: Record<ActivityItem["status"], string> = {
  running: "bg-sky-500 animate-pulse", failed: "bg-red-500", stopped: "bg-foreground/30", done: "bg-emerald-500",
};

// The newest turns across every workstream, from the transcripts the board already holds.
function RecentActivity({ rows }: { rows: Row[] }) {
  const items = useMemo(() => recentActivity(rows, 12), [rows]);
  const byKey = new Map(rows.map((r) => [`${r.repo}::${r.branch}`, r]));
  return (
    <Panel title="Recent activity" description="Latest agent turns across workstreams" slot="recent-activity">
      {items.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-xs">No agent turns yet.</p>
      ) : (
        <ol className="divide-y">
          {items.map((it, i) => {
            const row = byKey.get(`${it.repo}::${it.branch}`);
            const to = row && detailPath(row);
            return (
              <li key={`${it.repo}::${it.branch}::${it.at}::${i}`}>
                <button type="button" disabled={!to} onClick={() => to && navigate(to)} className="hover:bg-accent/40 flex w-full items-start gap-2.5 px-4 py-2.5 text-left disabled:cursor-default">
                  <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${ACTIVITY_DOT[it.status]}`} aria-label={it.status} />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-xs">{it.text || "(no instruction)"}</span>
                    <span className="text-muted-foreground mt-0.5 flex items-center gap-1 text-[11px]">
                      <span className="truncate">{it.title}</span>
                      <span aria-hidden="true">·</span>
                      <span className="shrink-0">{ago(it.at)}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
