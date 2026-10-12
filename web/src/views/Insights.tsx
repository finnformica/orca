// The Overview's insight cards — Vercel's Usage / Observability, Linear Insights, Railway's cost
// breakdown, adapted to what Orca can actually measure. One range (Today / 7d / 30d) drives all four:
//   Spend           — by category: the orchestrator's wakes, the workers it drives, your own runs,
//                     and each machine's hourly cost. Every figure an ESTIMATE, labelled and explained.
//   Runs            — runs per hour / day by outcome, success rate, Orca's check pass rate, median run.
//   Where it went   — spend (or runtime) by model, by repo, or the top workstreams.
//   Limit forecast  — each usage window projected at its current burn rate.
// The first three read ONE aggregate (/api/insights, workstream.ts `insights`); the box cost and the
// forecast are finished here from polls the Overview already runs (/api/health, /api/usage).
import { useEffect, useState, type ReactNode } from "react";
import { useAtom } from "jotai";
import { BarChart3, Gauge } from "lucide-react";
import { insightRangeAtom } from "@/lib/atoms";
import { useHealth, useInsights, useUsage } from "@/lib/vitals";
import { cn } from "@/lib/utils";
import {
  INSIGHT_RANGES, SPEND_CATEGORIES, boxSpend, formatDuration, formatUsd, limitForecasts,
  type InsightBucket, type InsightSlice, type Insights, type SpendCategory, type WindowForecast,
} from "../workstream";
import { Empty, Pill, Segmented, SectionTitle, VCard } from "@/components/console";

const RANGE_WORDS: Record<number, string> = { 1: "today", 7: "the last 7 days", 30: "the last 30 days" };
const CATEGORY_CLASS: Record<SpendCategory | "box", string> = {
  orchestrator: "bg-geist-blue", workers: "bg-geist-teal", direct: "bg-geist-amber", box: "bg-geist-gray",
};
const AGENT_BASIS = "Agent runs: the cost the Claude CLI reports for each run (total_cost_usd) — API list-price equivalent, "
  + "not what a subscription login is billed. Codex and Cursor report no cost.";

/** A placeholder block the size of what it stands in for, so nothing moves when data lands. */
export const Skeleton = ({ className }: { className?: string }) => <span data-slot="skeleton" aria-hidden="true" className={cn("bg-muted block animate-pulse rounded", className)} />;

/** The Insights section: a heading with the range picker, then the four cards. `machines`/`here` are
 *  the Overview's instance list, so each machine's hourly cost joins the spend. */
export function InsightsSection({ repo, instance, machines, here }: { repo?: string; instance?: string; machines: string[]; here?: string }) {
  const [days, setDays] = useAtom(insightRangeAtom);
  const data = useInsights(days, repo, instance);
  const [boxes, setBoxes] = useState<Record<string, BoxCost>>({});
  const onBox = (m: string, cost: BoxCost | undefined) => setBoxes((prev) => {
    const cur = prev[m];
    if (cost?.hourlyUsd === cur?.hourlyUsd && cost?.billingSince === cur?.billingSince && cost?.sinceIso === cur?.sinceIso) return prev;
    const next = { ...prev };
    if (cost) next[m] = cost; else delete next[m];
    return next;
  });
  // A repo filter has no machine to charge: a box runs every repo at once.
  const shownBoxes = repo ? [] : machines.filter((m) => boxes[m]);
  return (
    <div data-slot="insights">
      <SectionTitle aside={<Segmented label="Insights range" value={String(days)} onChange={(v) => setDays(Number(v))} options={INSIGHT_RANGES.map((r) => ({ value: String(r.days), label: r.label }))} />}>
        Insights
      </SectionTitle>
      {machines.map((m) => <BoxProbe key={m} instance={m} here={m === here} onCost={onBox} />)}
      <div className="grid gap-4 lg:grid-cols-2">
        <SpendCard data={data} days={days} boxes={shownBoxes.map((m) => ({ instance: m, cost: boxes[m]! }))} />
        <RunsCard data={data} days={days} />
        <BreakdownCard data={data} />
        <ForecastCard />
      </div>
    </div>
  );
}

type BoxCost = { hourlyUsd: number; sinceIso: string; billingSince?: string };

/** Reads one machine's hourly rate off the shared /api/health poll (the instance cards' own). */
function BoxProbe({ instance, here, onCost }: { instance: string; here: boolean; onCost: (m: string, c: BoxCost | undefined) => void }) {
  const cost = useHealth(here ? undefined : instance)?.health?.cost;
  useEffect(() => { onCost(instance, cost); }, [instance, cost?.hourlyUsd, cost?.sinceIso, cost?.billingSince]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// ---- Spend ----

function SpendCard({ data, days, boxes }: { data: Insights | null; days: number; boxes: { instance: string; cost: BoxCost }[] }) {
  const boxRows = data ? boxes.map((b) => {
    const usd = boxSpend(b.cost, data.from, data.to, data.generatedAt);
    const hours = b.cost.hourlyUsd > 0 ? usd / b.cost.hourlyUsd : 0;
    return {
      key: `box:${b.instance}`, label: boxes.length > 1 ? `${b.instance} box` : "Cloud box", cls: CATEGORY_CLASS.box, usd, note: `${Math.round(hours)}h`,
      basis: `Estimated: $${b.cost.hourlyUsd}/h × ${hours.toFixed(1)} h billed in ${RANGE_WORDS[days]} (since ${(b.cost.billingSince ?? b.cost.sinceIso).slice(0, 10)}), from ORCA_HOURLY_USD.`,
    };
  }) : [];
  const rows = data ? [
    ...SPEND_CATEGORIES.map((c) => ({
      key: c.key, label: c.label, cls: CATEGORY_CLASS[c.key], usd: data.spend[c.key], note: `${data.runsBy[c.key]} run${data.runsBy[c.key] === 1 ? "" : "s"}`,
      basis: `Estimated: ${c.basis}. ${AGENT_BASIS}`,
    })),
    ...boxRows,
  ] : [];
  const total = rows.reduce((s, r) => s + r.usd, 0);
  return (
    <VCard slot="insight-spend" title="Spend" aside={<Pill slot="estimate-pill" title={AGENT_BASIS}>Estimate</Pill>}>
      <div className="space-y-3 p-4">
        <div className="flex items-baseline gap-2">
          {data ? <span data-slot="spend-total" className="text-2xl font-semibold tracking-tight tabular-nums" title={AGENT_BASIS}>~{formatUsd(total)}</span> : <Skeleton className="h-8 w-24" />}
          <span className="text-muted-foreground text-xs">{RANGE_WORDS[days]}</span>
        </div>
        <div className="bg-muted flex h-1.5 overflow-hidden rounded-full" aria-hidden="true">
          {total > 0 && rows.map((r) => r.usd > 0 && <span key={r.key} className={r.cls} style={{ width: `${(r.usd / total) * 100}%` }} />)}
        </div>
      </div>
      <ul className="divide-y border-t">
        {data ? rows.map((r) => (
          <li key={r.key} data-slot={`spend-${r.key}`} title={r.basis} className="flex h-10 items-center gap-2.5 px-4 text-sm">
            <span className={cn("size-2 shrink-0 rounded-full", r.cls)} />
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            <span className="text-muted-foreground text-xs tabular-nums">{r.note}</span>
            <span className="w-16 text-right tabular-nums">{formatUsd(r.usd)}</span>
            <span className="text-muted-foreground w-9 text-right text-xs tabular-nums">{total > 0 ? `${Math.round((r.usd / total) * 100)}%` : "—"}</span>
          </li>
        )) : [0, 1, 2, 3].map((i) => <li key={i} className="flex h-10 items-center px-4"><Skeleton className="h-3.5 w-full" /></li>)}
      </ul>
      <p data-slot="spend-footnote" className="text-muted-foreground border-t px-4 py-2.5 text-xs">
        {data ? <>Hover a row for its basis.{data.unpriced > 0 && <> {data.unpriced} run{data.unpriced === 1 ? "" : "s"} reported no cost (Codex, Cursor, or recorded before costs were) and count as $0.</>}</> : <Skeleton className="h-3 w-2/3" />}
      </p>
    </VCard>
  );
}

// ---- Runs ----

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

function RunsCard({ data, days }: { data: Insights | null; days: number }) {
  const checked = data ? data.checks.passed + data.checks.failed : 0;
  return (
    <VCard slot="insight-runs" title="Runs" aside={<span data-slot="runs-total" className="text-muted-foreground text-xs tabular-nums">{data ? `${data.runs.total} in ${RANGE_WORDS[days]}` : ""}</span>}>
      <div className="grid grid-cols-3 border-b [&>*:not(:last-child)]:border-r">
        <Figure slot="success-rate" label="Success rate" value={data && pct(data.successRate)}
          sub={data && `${data.runs.error} failed · ${data.runs.stopped} stopped`} title="Finished runs that ended cleanly: done ÷ (done + failed). A run you stopped counts as neither." />
        <Figure slot="check-rate" label="Check pass rate" value={data && (checked ? pct(data.checks.passed / checked) : "—")}
          sub={data && (checked ? `${data.checks.passed} of ${checked} commits` : "no commits checked")} title="Orca's own verification: the repo's checkCommand, run after every run that committed." />
        <Figure slot="median-run" label="Median run" value={data && (data.medianMs === null ? "—" : formatDuration(data.medianMs))}
          sub={data && (data.runs.running ? `${data.runs.running} running now` : "wall-clock")} title="Median wall-clock time of finished runs, start to exit." />
      </div>
      <div className="p-4">
        {data ? <RunBars buckets={data.buckets} bucketMs={data.bucketMs} /> : <Skeleton className="h-[104px] w-full" />}
      </div>
    </VCard>
  );
}

function Figure({ slot, label, value, sub, title }: { slot: string; label: string; value: ReactNode | null; sub: ReactNode | null; title: string }) {
  return (
    <div data-slot={slot} title={title} className="min-w-0 space-y-1 p-4">
      <div className="text-muted-foreground truncate text-xs">{label}</div>
      {value === null ? <Skeleton className="h-7 w-14" /> : <div data-slot="figure-value" className="text-xl font-semibold tracking-tight tabular-nums">{value}</div>}
      {sub === null ? <Skeleton className="h-3 w-20" /> : <div className="text-muted-foreground truncate text-xs">{sub}</div>}
    </div>
  );
}

const OUTCOMES: { key: "done" | "error" | "stopped" | "running"; label: string; fill: string }[] = [
  { key: "done", label: "done", fill: "var(--geist-teal)" },
  { key: "error", label: "failed", fill: "var(--geist-red)" },
  { key: "stopped", label: "stopped", fill: "var(--geist-amber)" },
  { key: "running", label: "running", fill: "var(--geist-blue)" },
];

/** Runs per bucket, stacked by outcome — hover a bar for its numbers. */
function RunBars({ buckets, bucketMs }: { buckets: InsightBucket[]; bucketMs: number }) {
  const W = 600, H = 80, max = Math.max(1, ...buckets.map((b) => b.runs));
  const slot = W / Math.max(1, buckets.length), bar = Math.max(2, slot * 0.7);
  const hourly = bucketMs < 86_400_000;
  const when = (at: number) => hourly ? new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const ticks = [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <figure data-slot="run-bars" className="space-y-2">
      <figcaption className="flex flex-wrap gap-x-3 text-xs">
        <span className="text-muted-foreground">Runs per {hourly ? "hour" : "day"}</span>
        {OUTCOMES.map((o) => <span key={o.key} className="text-muted-foreground inline-flex items-center gap-1"><span className="size-1.5 rounded-full" style={{ background: o.fill }} />{o.label}</span>)}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-20 w-full" role="img" aria-label={`Runs per ${hourly ? "hour" : "day"}: ${buckets.reduce((s, b) => s + b.runs, 0)} total`}>
        <line x1={0} x2={W} y1={H} y2={H} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {buckets.map((b, i) => {
          let y = H;
          return (
            <g key={b.at} data-slot="run-bar">
              <title>{`${when(b.at)} — ${b.runs} run${b.runs === 1 ? "" : "s"}${b.runs ? `: ${OUTCOMES.filter((o) => b[o.key]).map((o) => `${b[o.key]} ${o.label}`).join(", ")}` : ""}${b.costUsd ? ` · ~${formatUsd(b.costUsd)}` : ""}`}</title>
              <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
              {OUTCOMES.map((o) => {
                const h = (b[o.key] / max) * H;
                if (!h) return null;
                y -= h;
                return <rect key={o.key} x={i * slot + (slot - bar) / 2} y={y} width={bar} height={h} fill={o.fill} />;
              })}
            </g>
          );
        })}
      </svg>
      <div className="text-muted-foreground relative h-3 font-mono text-[10px]">
        {ticks.map((i, n) => (
          <span key={i} className="absolute" style={n === ticks.length - 1 && n > 0 ? { right: 0 } : { left: `${(i / buckets.length) * 100}%` }}>{when(buckets[i]!.at)}</span>
        ))}
      </div>
    </figure>
  );
}

// ---- Where it went ----

type BreakdownKey = "model" | "repo" | "workstream";
const BREAKDOWNS: { value: BreakdownKey; label: string }[] = [{ value: "model", label: "Model" }, { value: "repo", label: "Repo" }, { value: "workstream", label: "Workstream" }];

function BreakdownCard({ data }: { data: Insights | null }) {
  const [by, setBy] = useState<BreakdownKey>("model");
  const all: InsightSlice[] = data ? (by === "model" ? data.byModel : by === "repo" ? data.byRepo : data.topWorkstreams) : [];
  const slices = all.slice(0, 5);
  // Nothing priced (a Codex-only range): rank and draw by runtime instead of a column of $0.00.
  const byCost = slices.some((s) => s.costUsd > 0);
  const top = Math.max(1e-9, ...slices.map((s) => (byCost ? s.costUsd : s.runtimeMs)));
  return (
    <VCard slot="insight-breakdown" title="Where it went" aside={<Segmented label="Break down by" value={by} onChange={setBy} options={BREAKDOWNS} />}>
      {!data ? (
        <ul className="divide-y">{[0, 1, 2, 3, 4].map((i) => <li key={i} className="flex h-12 items-center px-4"><Skeleton className="h-3.5 w-full" /></li>)}</ul>
      ) : !slices.length ? <Empty icon={<BarChart3 />}>No runs in this range.</Empty> : (
        <ul className="divide-y">
          {slices.map((s) => (
            <li key={s.key} data-slot="breakdown-row" className="relative flex h-12 items-center gap-3 px-4 text-sm"
              title={`${s.label}: ${s.runs} run${s.runs === 1 ? "" : "s"}, ${formatDuration(s.runtimeMs)} of agent time${s.tokens ? `, ${s.tokens.toLocaleString("en-GB")} tokens` : ""}${byCost ? ` · ~${formatUsd(s.costUsd)} estimated` : ""}`}>
              <span aria-hidden="true" className="bg-geist-blue/10 absolute inset-y-1.5 left-1.5 rounded" style={{ width: `calc(${((byCost ? s.costUsd : s.runtimeMs) / top) * 100}% - 0.75rem)` }} />
              <span className="relative min-w-0 flex-1">
                <span className="block truncate">{s.label}</span>
                {s.sub && <span className="text-muted-foreground block truncate text-xs">{s.sub}</span>}
              </span>
              <span className="text-muted-foreground relative text-xs tabular-nums">{s.runs} run{s.runs === 1 ? "" : "s"} · {formatDuration(s.runtimeMs)}</span>
              <span data-slot="breakdown-value" className="relative w-16 text-right tabular-nums">{byCost ? formatUsd(s.costUsd) : "—"}</span>
            </li>
          ))}
        </ul>
      )}
    </VCard>
  );
}

// ---- Limit forecast ----

const span = (ms: number) => (ms >= 86_400_000 ? `${Math.floor(ms / 86_400_000)}d ${Math.floor((ms % 86_400_000) / 3_600_000)}h` : formatDuration(Math.round(ms / 60_000) * 60_000));
const FORECAST_BASIS = "Projection: the average rate since the window opened, carried forward to its reset. "
  + "Linear and naive — a burst early in the window overstates it, a quiet start understates it. Not projected until 10% of the window has passed.";

function forecastText(f: WindowForecast): { text: string; tone: "red" | "amber" | "muted" } {
  if (f.state === "reached") return { text: `limit reached${f.resetsInMs !== null ? ` · resets in ${span(f.resetsInMs)}` : ""}`, tone: "red" };
  if (f.state === "will-hit") return { text: `runs out in ~${span(f.hitsInMs!)}${f.resetsInMs !== null ? `, ${span(f.resetsInMs - f.hitsInMs!)} before reset` : ""}`, tone: "amber" };
  if (f.state === "ok") return { text: `on pace for ~${f.projectedPct}% at reset`, tone: "muted" };
  return { text: "too early to project", tone: "muted" };
}

function ForecastCard() {
  const usage = useUsage();
  const groups = limitForecasts(usage);
  return (
    <VCard slot="insight-forecast" title="Limit forecast" aside={<Pill slot="projection-pill" title={FORECAST_BASIS}>Projection</Pill>}>
      {!usage ? (
        <ul className="divide-y">{[0, 1, 2].map((i) => <li key={i} className="flex h-12 items-center px-4"><Skeleton className="h-3.5 w-full" /></li>)}</ul>
      ) : !groups.length ? <Empty icon={<Gauge />}>No provider is signed in on this machine.</Empty> : (
        <div className="divide-y">
          {groups.map((g) => (
            <div key={g.key} data-slot={`forecast-${g.key}`}>
              <div className="bg-accent/30 flex items-baseline justify-between px-4 py-1.5 text-xs">
                <span className="font-medium">{g.title}</span>{g.subtitle && <span className="text-muted-foreground">{g.subtitle}</span>}
              </div>
              {g.rows.map((f) => {
                const t = forecastText(f);
                return (
                  <div key={f.key} data-slot="forecast-row" data-state={f.state} title={FORECAST_BASIS} className="flex h-11 items-center gap-3 px-4 text-sm">
                    <span className="min-w-0 flex-1 truncate">{f.label}</span>
                    <span className={cn("truncate text-xs", t.tone === "red" ? "text-geist-red" : t.tone === "amber" ? "text-geist-warning-fg" : "text-muted-foreground")}>{t.text}</span>
                    <span className="w-10 text-right tabular-nums">{f.pct}%</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </VCard>
  );
}
