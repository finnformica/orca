// The Overview — Vercel's team overview, adapted. Left column: Usage (Claude per login + Codex, as
// ring rows — the header meter's replacement) and ONE Agents card with the four numbers that matter
// (running, needs attention, open PRs by state, merged today), each opening the Agents list already
// filtered. Right column: one card per machine (vitals + CPU / memory line graphs over a range) and
// Recent activity. Every number is a pure derivation over the board's rows (workstream.ts) — no
// endpoint of its own — scoped by the top bar's repo switcher and the sidebar's instance switcher.
import type { ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Activity } from "lucide-react";
import { agentQueryAtom, instanceScopeAtom, repoFilterAtom } from "@/lib/atoms";
import { navigate } from "@/lib/route";
import { instanceChoices, thisInstance, useRepos, useWorkstreams, useWorkstreamsLoaded, type Row } from "../store";
import {
  DEFAULT_LIST_FILTER, LANE_LABELS, NO_QUICK_FILTER, ago, attentionReasons, filterRows, quickFilterQuery, type QuickFilter, overviewStats, recentActivity, sparklineSegments,
  type ActivityItem, type OverviewLane,
} from "../workstream";
import { Empty, SectionTitle, StatSkeleton, StatusDot, VCard, type DotTone } from "@/components/console";
import { InstanceCard, RefreshVitals, UsageCard } from "./Vitals";
import { detailPath } from "./Agents";

export function Overview() {
  const all = useWorkstreams();
  const repo = useAtomValue(repoFilterAtom);
  const scope = useAtomValue(instanceScopeAtom);
  useRepos(); // config (and the instance list) lands after first paint
  const here = thisInstance();
  const rows = filterRows(all, { ...DEFAULT_LIST_FILTER, repo, instance: scope }, here);
  const instances = instanceChoices();
  const machines = scope === "all" ? (instances.length ? instances : here ? [here] : []) : [scope];
  return (
    <div data-slot="overview-grid" className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(22rem,26rem)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-6">
        <div><SectionTitle>Usage</SectionTitle><UsageCard /></div>
        <div><SectionTitle>Agents</SectionTitle><AgentsSnapshot rows={rows} /></div>
      </div>
      <div className="min-w-0 space-y-6">
        <div>
          <SectionTitle aside={<RefreshVitals />}>{machines.length > 1 ? "Instances" : "Instance"}</SectionTitle>
          <div className="space-y-4">
            {machines.length ? machines.map((m) => <InstanceCard key={m} instance={m} here={m === here || !instances.length} />)
              : <VCard><Empty>Loading…</Empty></VCard>}
          </div>
        </div>
        <div><SectionTitle>Recent activity</SectionTitle><RecentActivity rows={rows} /></div>
      </div>
    </div>
  );
}

// ---- Agents: four numbers in one card ----

function AgentsSnapshot({ rows }: { rows: Row[] }) {
  const loaded = useWorkstreamsLoaded();
  const s = overviewStats(rows);
  const setQ = useSetAtom(agentQueryAtom);
  // Open the Agents list with the quick chips that count exactly this — a link, like any filtered view.
  const open = (f: Partial<QuickFilter>) => () => { setQ(""); navigate(`/agents${quickFilterQuery({ ...NO_QUICK_FILTER, ...f })}`); };
  const pipeline: { lane: OverviewLane; n: number; cls: string; chip: QuickFilter["pr"][number] }[] = [
    { lane: "DRAFT", n: s.prs.draft, cls: "bg-geist-gray", chip: "open" },
    { lane: "IN_REVIEW", n: s.prs.inReview, cls: "bg-geist-amber", chip: "open" },
    { lane: "MERGEABLE", n: s.prs.mergeable, cls: "bg-geist-blue", chip: "mergeable" },
  ];
  if (!loaded) {
    return (
      <VCard slot="agents-card" bodyClass="grid grid-cols-2 [&>*:nth-child(odd)]:border-r [&>*:nth-child(n+3)]:border-t">
        {[0, 1, 2, 3].map((i) => <StatSkeleton key={i} />)}
      </VCard>
    );
  }
  return (
    <VCard slot="agents-card" bodyClass="grid grid-cols-2 [&>*:nth-child(odd)]:border-r [&>*:nth-child(n+3)]:border-t">
      <Stat slot="running" label="Running" value={s.running} onClick={open({ status: ["running"] })} dot={s.running ? "building" : "neutral"}
        below={<RunsSparkline values={s.turnsByHour} />} />
      <Stat slot="attention" label="Needs attention" value={s.attention} onClick={open({ status: ["attention"] })} dot={s.attention ? "warning" : "neutral"}
        below={<span data-slot="attention-reasons" className="text-muted-foreground text-xs">{reasonSummary(rows) || "nothing waiting on you"}</span>} />
      <Stat slot="prs" label="Open PRs" value={s.prs.total} onClick={open({ pr: ["open"] })} dot="queued"
        below={
          <div className="space-y-1.5">
            <div className="bg-muted flex h-1.5 overflow-hidden rounded-full" aria-hidden="true">
              {s.prs.total > 0 && pipeline.map((p) => p.n > 0 && <span key={p.lane} className={p.cls} style={{ width: `${(p.n / s.prs.total) * 100}%` }} />)}
            </div>
            <div className="flex flex-wrap gap-x-2.5 text-xs">
              {pipeline.map((p) => (
                <button key={p.lane} type="button" data-slot={`pipeline-${p.lane}`} onClick={(e) => { e.stopPropagation(); open({ pr: [p.chip] })(); }} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                  <span className={`size-1.5 rounded-full ${p.cls}`} />{LANE_LABELS[p.lane]} <span className="text-foreground tabular-nums">{p.n}</span>
                </button>
              ))}
            </div>
          </div>
        } />
      <Stat slot="merged" label="Merged today" value={s.mergedToday} onClick={open({ pr: ["merged"] })} dot={s.mergedToday ? "ready" : "neutral"}
        below={<span className="text-muted-foreground text-xs">since midnight</span>} />
    </VCard>
  );
}

/** "1 CI failing · 1 run error" — why the number is what it is, most common reason first. */
function reasonSummary(rows: Row[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) for (const why of attentionReasons(r)) counts.set(why, (counts.get(why) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([why, n]) => `${n} ${why}`).join(" · ");
}

function Stat({ slot, label, value, onClick, dot, below }: { slot: string; label: string; value: number; onClick: () => void; dot: DotTone; below?: ReactNode }) {
  return (
    <div role="button" tabIndex={0} data-slot={`stat-${slot}`} onClick={onClick} onKeyDown={(e) => { if (e.key === "Enter") onClick(); }}
      className="hover:bg-accent/40 min-w-0 cursor-pointer space-y-2 p-4 text-left transition-colors">
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs"><StatusDot tone={dot} className="size-2" />{label}</div>
      <div data-slot="stat-value" className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {below}
    </div>
  );
}

/** Runs started per hour over the last 24h — a one-line trend under "Running". The viewBox is padded
 *  by half the stroke on every side: a peak sits on y=0 and a quiet hour on y=H, and an unpadded
 *  18px box clipped half the line away there, so it read 0.75px at the extremes and 1.5px between.
 *  The stroke itself is non-scaling, so the box stretching with the card never thickens it. */
function RunsSparkline({ values }: { values: number[] }) {
  const W = 120, H = 18, PAD = SPARK_STROKE / 2, max = Math.max(1, ...values);
  const pts = values.map((v, i) => ({ at: i, v }));
  return (
    <svg viewBox={`0 ${-PAD} ${W} ${H + 2 * PAD}`} preserveAspectRatio="none" className="text-geist-blue h-[18px] w-full" role="img" aria-label={`Runs started per hour, last 24 hours: ${values.reduce((a, b) => a + b, 0)} total`}>
      {sparklineSegments(pts, { from: 0, to: Math.max(1, values.length - 1), max, w: W, h: H, gapMs: Infinity }).map((p, i) => (
        <polyline key={i} points={p} fill="none" stroke="currentColor" strokeWidth={SPARK_STROKE} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}
const SPARK_STROKE = 1.5;

// ---- Recent activity (Vercel's Recent Previews) ----

const ACTIVITY_DOT: Record<ActivityItem["status"], DotTone> = { running: "building", failed: "error", stopped: "warning", done: "ready" };

function RecentActivity({ rows }: { rows: Row[] }) {
  const items = recentActivity(rows, 10);
  return (
    <VCard slot="recent-activity">
      {items.length === 0 ? <Empty icon={<Activity />}>Runs you start, and their results, will appear here.</Empty> : (
        <ul className="divide-y">
          {items.map((it, i) => {
            const to = detailPath(it);
            return (
              <li key={`${it.repo}:${it.branch}:${i}`}>
                <button type="button" disabled={!to} onClick={() => to && navigate(`${to}/chat`)}
                  className="hover:bg-accent/40 flex w-full items-center gap-3 px-4 py-3 text-left text-sm disabled:cursor-default">
                  <StatusDot tone={ACTIVITY_DOT[it.status]} title={it.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" title={it.text}>{it.text || "(no instruction)"}</span>
                    <span className="text-muted-foreground block truncate text-xs">{it.title} · {it.repo}{it.prNumber ? ` · #${it.prNumber}` : ""}</span>
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{ago(it.at)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </VCard>
  );
}
