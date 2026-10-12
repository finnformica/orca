// The Agents page — Vercel's Deployments list, adapted: an "Add Filter" chip row (repo, state,
// instance, needs attention) with the active filters as dashed chips, then one dense row per
// workstream: repo icon + title, its latest instruction (where Vercel has the commit message), the
// status dot with a duration, the state pill, the signals (CI / conflicts / the review cluster), PR
// #, branch, instance, when, and the model as the avatar. Clicking a row opens its agent page; every
// action is in the trailing ⋯ (WorkstreamActions, menu-only). The swimlanes stay behind List | Board.
import { useState, type MouseEvent, type ReactNode } from "react";
import { useAtom, useAtomValue } from "jotai";
import { Bot, Columns3, FolderGit2, GitBranch, GitPullRequest, List, Rows2, Rows3, Search, X } from "lucide-react";
import { agentQueryAtom, boardViewAtom, densityAtom, instanceScopeAtom, repoFilterAtom, type BoardView } from "@/lib/atoms";
import { navigate, useSearch } from "@/lib/route";
import { instanceChoices, modelFor, thisInstance, useRepos, useWorkstreams, type Row } from "../store";
import {
  DEFAULT_LIST_FILTER, LANE_LABELS, NO_QUICK_FILTER, SORT_LABELS, ago, applyQuickFilter, attentionReasons, filterRows, formatDuration, lastActivity,
  parseQuickFilter, promptInstruction, quickActive, quickCount, quickFilterQuery, rowDuration, rowInstance, rowTone, sortRows, toggleQuick,
  type ListSort, type OverviewLane, type QuickFilter, type QuickGroup, type RowTone,
} from "../workstream";
import { modelLabel } from "../../../shared/models";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pill, StatusDot, type DotTone } from "@/components/console";
import { TerminalDialog } from "@/components/Terminal";
import { Board, ConditionBadges, CopyDone, LaneActions, useTerminalOpen } from "./Board";
import { WorkstreamActions } from "./WorkstreamActions";
import { PreviewControl } from "./PreviewControl";
import { ReviewCluster } from "./Review";

export function Agents() {
  const [view, setView] = useAtom(boardViewAtom);
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <div className="flex items-center gap-2">
          {view === "board" && <DensityToggle />}
          <ViewToggle view={view} setView={setView} />
        </div>
      </div>
      {view === "board" ? <Board /> : <AgentsList />}
    </div>
  );
}

const VIEWS: { value: BoardView; label: string; Icon: typeof List }[] = [
  { value: "list", label: "List", Icon: List },
  { value: "board", label: "Board", Icon: Columns3 },
];
// Board only: flip every (non-Done) card between the full card and a status-only dense one.
function DensityToggle() {
  const [density, setDensity] = useAtom(densityAtom);
  const dense = density === "dense";
  const label = dense ? "Switch to comfortable view" : "Switch to dense view";
  return (
    <Button size="icon" variant="outline" className="size-8" aria-pressed={dense} onClick={() => setDensity(dense ? "comfortable" : "dense")} title={label} aria-label={label}>
      {dense ? <Rows2 className="size-4" /> : <Rows3 className="size-4" />}
    </Button>
  );
}

function ViewToggle({ view, setView }: { view: BoardView; setView: (v: BoardView) => void }) {
  return (
    <div role="group" aria-label="View" className="inline-flex h-8 items-center rounded-md border p-0.5">
      {VIEWS.map(({ value, label, Icon }) => (
        <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)} title={`${label} view`}
          className={`inline-flex h-full items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium transition-colors ${view === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          <Icon className="size-3.5" /> {label}
        </button>
      ))}
    </div>
  );
}

function AgentsList() {
  const all = useWorkstreams();
  const repo = useAtomValue(repoFilterAtom); // the top bar's scope
  const instance = useAtomValue(instanceScopeAtom); // the sidebar's scope
  const [q, setQ] = useAtom(agentQueryAtom);
  const search = useSearch();
  const quick = parseQuickFilter(search);
  const [sort, setSort] = useState<ListSort>("updated");
  const here = thisInstance();
  // The scopes first (they hold on every page), then the search box, then the quick chips.
  const scoped = filterRows(all, { ...DEFAULT_LIST_FILTER, repo, instance, q }, here);
  const visible = sortRows(applyQuickFilter(scoped, quick, here), sort);
  const setQuick = (f: QuickFilter) => navigate(`/agents${quickFilterQuery(f)}`, true); // a filter change is not a history step
  const clear = () => { setQ(""); setQuick(NO_QUICK_FILTER); };
  return (
    <section aria-label="Agents" className="space-y-3">
      <FilterRow scoped={scoped} quick={quick} setQuick={setQuick} visible={visible} total={all.length} q={q} setQ={setQ} sort={sort} setSort={setSort}
        showRepos={repo === "all"} showInstances={instance === "all"} />
      <div data-slot="workstream-list" className="bg-card overflow-x-auto rounded-lg border">
        {visible.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-3 px-4 py-14 text-sm">
            No agents match.
            <Button size="sm" variant="outline" onClick={clear}>Clear filters</Button>
          </div>
        ) : <div className="min-w-[78rem]">{visible.map((r) => <AgentRow key={r.repo + r.branch} row={r} />)}</div>}
      </div>
    </section>
  );
}

type Chip = { group: QuickGroup; value: string; label: string; dot?: DotTone };

// Vercel's filter row: one-click chips, each with its count, toggleable and combinable (AND across
// groups, OR within one); the URL query holds them, so a filtered view is a link. Search and sort sit
// at the end.
function FilterRow({ scoped, quick, setQuick, visible, total, q, setQ, sort, setSort, showRepos, showInstances }: {
  scoped: Row[]; quick: QuickFilter; setQuick: (f: QuickFilter) => void; visible: Row[]; total: number;
  q: string; setQ: (v: string) => void; sort: ListSort; setSort: (s: ListSort) => void;
  showRepos: boolean; showInstances: boolean;
}) {
  const repos = useRepos();
  const instances = instanceChoices();
  const here = thisInstance();
  const chips: Chip[] = [
    { group: "status", value: "attention", label: "Needs attention", dot: "warning" },
    { group: "status", value: "running", label: "Running", dot: "building" },
    { group: "by", value: "mine", label: "Mine" },
    { group: "by", value: "orchestrated", label: "Orchestrated" },
    { group: "pr", value: "open", label: "Open PRs" },
    { group: "pr", value: "mergeable", label: "Mergeable", dot: "queued" },
    { group: "pr", value: "merged", label: "Merged today", dot: "ready" },
    ...(showInstances && instances.length > 1 ? instances.map((i): Chip => ({ group: "on", value: i, label: i })) : []),
    ...(showRepos && repos.length > 1 ? repos.map((r): Chip => ({ group: "repo", value: r.name, label: r.name })) : []),
  ];
  // The lane the chips narrow to, when exactly one: the swimlanes' bulk verbs apply to it.
  const lane: OverviewLane | null = quick.pr.length === 1 && quick.pr[0] !== "open" ? (quick.pr[0] === "merged" ? "DONE" : "MERGEABLE") : null;
  return (
    <div data-slot="filter-bar" className="space-y-2">
      <div role="group" aria-label="Quick filters" className="flex flex-wrap items-center gap-1.5">
        {chips.map((c) => {
          const on = (quick[c.group] as string[]).includes(c.value);
          return (
            <button key={`${c.group}:${c.value}`} type="button" data-slot="quick-filter" data-chip={`${c.group}:${c.value}`} aria-pressed={on}
              onClick={() => setQuick(toggleQuick(quick, c.group, c.value))}
              className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition-colors ${on ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:text-foreground hover:border-foreground/30"}`}>
              {c.dot && <StatusDot tone={c.dot} className="size-2" />}
              {c.label}
              <span data-slot="quick-count" className={`tabular-nums ${on ? "opacity-70" : "opacity-60"}`}>{quickCount(scoped, quick, c.group, c.value, here)}</span>
            </button>
          );
        })}
        {quickActive(quick) && (
          <button type="button" onClick={() => setQuick(NO_QUICK_FILTER)} className="text-muted-foreground hover:text-foreground inline-flex h-7 items-center gap-1 px-1.5 text-[13px]">
            <X className="size-3.5" /> Clear
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="bg-card focus-within:ring-ring/40 flex h-8 min-w-48 flex-1 items-center gap-2 rounded-md border px-2.5 focus-within:ring-2 sm:max-w-72">
          <Search className="text-muted-foreground size-4 shrink-0" strokeWidth={1.5} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents…" aria-label="Search workstreams"
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
          {q && <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>}
        </label>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums" data-slot="agents-count">{visible.length} of {total}</span>
          {lane === "DONE" && visible.length > 0 && <span className="text-muted-foreground"><CopyDone cards={visible} /></span>}
          {lane && <span className="text-muted-foreground"><LaneActions lane={lane} cards={visible} /></span>}
          <Select value={sort} onValueChange={(v) => setSort(v as ListSort)}>
            <SelectTrigger className="h-8 w-40" aria-label="Sort"><span className="text-muted-foreground text-xs">Sort</span><SelectValue /></SelectTrigger>
            <SelectContent>{(Object.keys(SORT_LABELS) as ListSort[]).map((k) => <SelectItem key={k} value={k}>{SORT_LABELS[k]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

// ---- the row ----

// One grid per row (fixed tracks so every row lines up): workstream · latest instruction · status ·
// state · signals · PR · branch · instance · updated · model · actions.
const COLS = "grid grid-cols-[minmax(11rem,1.4fr)_minmax(8rem,1.1fr)_9.5rem_6.5rem_minmax(12rem,1.4fr)_3.5rem_minmax(6rem,0.8fr)_4rem_4.5rem_1.5rem_6.5rem] items-center gap-x-3";

export const TONE_DOT: Record<RowTone, DotTone> = { running: "building", failed: "error", attention: "warning", ready: "ready", neutral: "neutral" };
export const TONE_LABEL: Record<RowTone, string> = { running: "Running", failed: "Error", attention: "Needs you", ready: "Ready", neutral: "Idle" };
const LANE_PILL: Record<OverviewLane, "default" | "blue" | "green"> = { LOCAL: "default", DRAFT: "default", IN_REVIEW: "default", MERGEABLE: "blue", DONE: "green" };

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

export function AgentRow({ row }: { row: Row }) {
  const isDone = row.lane === "DONE";
  const [busy, setBusy] = useState(false);
  const [terminalOpen, setTerminalOpen] = useTerminalOpen(row); // "New chat" pops its conversation open on arrival
  const tone = rowTone(row);
  const reasons = attentionReasons(row);
  const instance = rowInstance(row, thisInstance());
  const updated = lastActivity(row);
  const duration = rowDuration(row);
  const to = detailPath(row);
  const model = row.agentMeta?.model ?? (row.worktreePath || row.prNumber ? modelLabel(modelFor(row)) : undefined);
  const instruction = latestInstruction(row);
  return (
    <div
      role="row" data-slot="workstream-row" data-branch={row.branch} aria-busy={busy}
      onClick={openOnRowClick(row)}
      className={`${COLS} hover:bg-accent/40 h-14 border-b px-4 text-sm last:border-b-0 ${to ? "cursor-pointer" : ""} ${busy ? "pointer-events-none opacity-60" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="bg-muted inline-flex size-6 shrink-0 items-center justify-center rounded-full" title={row.repo}><FolderGit2 className="size-3.5" /></span>
        <div className="min-w-0">
          <div className="truncate font-medium" title={row.title}>{row.title}</div>
          <div className="text-muted-foreground flex items-center gap-1 truncate text-xs">
            {row.repo}{row.orchestrated && <span title="Started or continued by the orchestrator" aria-label="Orchestrated"><Bot className="size-3" /></span>}
          </div>
        </div>
      </div>
      <div className="text-muted-foreground truncate" title={row.agentStatus === "error" && row.agentError ? row.agentError : instruction}>
        {row.agentStatus === "error" && row.agentError ? <span className="text-geist-red">{row.agentError}</span> : instruction || "—"}
      </div>
      <div className="flex min-w-0 items-center gap-2 whitespace-nowrap" title={reasons.length ? reasons.join(", ") : undefined}>
        <StatusDot tone={TONE_DOT[tone]} />
        <span data-tone={tone} className="font-medium">{TONE_LABEL[tone]}</span>
        {duration !== undefined && <span className="text-muted-foreground tabular-nums">{formatDuration(duration)}</span>}
      </div>
      <div><Pill tone={LANE_PILL[row.lane]} slot="state-pill">{isDone ? "Merged" : LANE_LABELS[row.lane]}</Pill></div>
      <div className="flex min-w-0 flex-wrap items-center gap-1 [&>*]:shrink-0 [&_[data-slot=badge]]:px-1.5 [&_[data-slot=badge]]:py-0 [&_[data-slot=badge]]:text-[10px] [&_[data-slot=badge]_svg]:size-2.5">
        {row.prNumber && !isDone && <ConditionBadges row={row} />}
        {row.prNumber && !isDone && <ReviewCluster row={row} />}
        {!row.prNumber && row.mergeClean === "conflict" && <Pill tone="red">Conflicts</Pill>}
      </div>
      <div className="text-muted-foreground flex items-center gap-1 font-mono text-xs">
        {row.prNumber ? <a href={row.prUrl} target="_blank" rel="noreferrer" className="hover:text-foreground inline-flex items-center gap-1"><GitPullRequest className="size-3.5" />{row.prNumber}</a> : "—"}
      </div>
      <div className="text-muted-foreground flex min-w-0 items-center gap-1 font-mono text-xs" title={row.branch}>
        <GitBranch className="size-3.5 shrink-0" /><span className="truncate">{row.branch}</span>
      </div>
      <div className="text-muted-foreground truncate text-xs" data-slot="instance-chip">{instanceChoices().length > 1 ? instance ?? "—" : ""}</div>
      <div className="text-muted-foreground text-right text-xs tabular-nums" title={updated ? new Date(updated).toLocaleString() : undefined}>{ago(updated)}</div>
      <ModelAvatar model={model} />
      <div className="flex items-center justify-end gap-1">
        {!isDone && <PreviewControl row={row} compact />}
        {!isDone && <WorkstreamActions row={row} compact menuOnly onBusy={setBusy} onFollowUp={to ? () => navigate(`${to}/chat`) : undefined} />}
        {!isDone && <TerminalDialog row={row} open={terminalOpen} onClose={() => setTerminalOpen(false)} />}
      </div>
    </div>
  );
}

/** The row's "avatar": the model's initials in a circle (Vercel shows the author). */
export function ModelAvatar({ model }: { model?: string }): ReactNode {
  if (!model) return <span />;
  const initials = model.replace(/[^A-Za-z0-9 ]/g, "").split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return (
    <span data-slot="model-avatar" title={model} aria-label={`Model ${model}`}
      className="bg-muted text-foreground inline-flex size-6 items-center justify-center rounded-full text-[9px] font-semibold">
      {initials}
    </span>
  );
}

