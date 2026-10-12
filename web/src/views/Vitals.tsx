// The two vitals cards, Vercel-style. Usage: Claude (per hydra login, plus the fleet) and Codex as
// rows of ring + label + value / limit — this replaced the header's usage meter. Instance: one card
// per machine, its current vitals as a details grid and CPU % / memory GB as line graphs over a
// chosen range from /api/health/history. Both read the shared polls in lib/vitals, so the Overview
// and the Usage page never poll twice.
import { useState } from "react";
import { useAtom } from "jotai";
import { AlertTriangle, ChevronDown, ChevronUp, Server } from "lucide-react";
import { usageExpandedAtom, usageStatsExpandedAtom } from "@/lib/atoms";
import { useHealth, useHealthHistory, useUsage, useUsageLoaded } from "@/lib/vitals";
import { HISTORY_RANGES, downsample, routingBroken, usageGroups, type UsageGroup } from "../workstream";
import { ChartSkeleton, Detail, Empty, LineChart, Pill, Ring, RowSkeleton, Segmented, StatusDot, VCard, type ChartOverlay } from "@/components/console";

/** `all`: the Usage page — every login (never just the fleet), and the whole card is itself
 *  collapsible (starts collapsed, remembered — `orca.usageStatsExpanded`). On the Overview the card
 *  is always open, and Vercel's chevron (or the header row) toggles the per-login breakdown instead
 *  (`orca.usageExpanded`) — the two toggles are independent, since they collapse different things. */
export function UsageCard({ all = false }: { all?: boolean }) {
  const usage = useUsage();
  const loaded = useUsageLoaded();
  const groups = usageGroups(usage);
  const [stored, setStored] = useAtom(usageExpandedAtom);
  const [sectionStored, setSectionStored] = useAtom(usageStatsExpandedAtom);
  const sectionExpanded = !all || sectionStored;
  const loginsExpanded = all || stored;
  const logins = groups.filter((g) => g.key.startsWith("login:")).length;
  const canToggleLogins = !all && logins > 0;
  const toggleLogins = () => setStored(!stored);
  const toggleSection = () => setSectionStored(!sectionStored);
  const shown = loginsExpanded ? groups : groups.filter((g) => !g.key.startsWith("login:"));
  return (
    <VCard slot="usage-card" title="Current windows" aside={<span className="text-muted-foreground text-xs">Claude &amp; Codex limits</span>}
      onHeaderClick={all ? toggleSection : canToggleLogins ? toggleLogins : undefined} expanded={all ? sectionExpanded : canToggleLogins ? loginsExpanded : undefined}>
      {sectionExpanded && (<>
        {routingBroken(usage) && (
          <div data-slot="routing-warning" title="Claude Code's updater rewrote ~/.local/bin/claude. Re-run hydra's install.sh --shim on the bridge's machine."
            className="bg-geist-warning-bg text-geist-warning-fg flex items-start gap-2 border-b px-4 py-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>Claude routing off: hydra is installed but the bridge's <code>claude</code> isn't its shim, so every run lands on the default login.</span>
          </div>
        )}
        {!loaded ? (
          <div data-slot="usage-skeleton" className="space-y-1 p-2">
            <RowSkeleton /><RowSkeleton />
          </div>
        ) : !groups.length ? <Empty>No provider is signed in on this machine.</Empty> : (
          <div className="p-2">
            {shown.map((g) => <UsageGroupRows key={g.key} group={g} />)}
            {canToggleLogins && (
              <button type="button" data-slot="usage-toggle" aria-expanded={loginsExpanded} onClick={toggleLogins}
                className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 py-1.5 text-xs">
                {loginsExpanded ? <>Show less <ChevronUp className="size-3.5" /></> : <>Show {logins} login{logins === 1 ? "" : "s"} <ChevronDown className="size-3.5" /></>}
              </button>
            )}
          </div>
        )}
      </>)}
    </VCard>
  );
}

function UsageGroupRows({ group: g }: { group: UsageGroup }) {
  return (
    <div data-slot="usage-group" data-group={g.key} className={`mb-1 last:mb-0 ${g.dim ? "opacity-50" : ""}`}>
      <div className="flex items-baseline justify-between gap-2 px-2 pt-1.5 pb-1">
        <span className="truncate text-xs font-medium" title={g.subtitle}>{g.title}</span>
        <span className="flex items-center gap-1.5">
          {g.subtitle && <span className="text-muted-foreground truncate text-xs">{g.subtitle}</span>}
          {g.state && <Pill tone={g.state === "exhausted" || g.state === "locked" ? "red" : "default"} slot="usage-state">{g.state}</Pill>}
        </span>
      </div>
      {g.rows.map((r) => (
        <div key={r.key} data-slot="usage-row" title={r.resetsIn ? `resets in ${r.resetsIn}` : undefined}
          className="hover:bg-accent/60 flex h-9 items-center gap-2.5 rounded-md px-2 text-sm">
          <Ring pct={r.pct} />
          <span className="min-w-0 flex-1 truncate">{r.label}</span>
          {r.resetsIn && <span className="text-muted-foreground hidden text-xs sm:inline">resets {r.resetsIn}</span>}
          <span className="text-muted-foreground shrink-0 tabular-nums"><span className="text-foreground">{r.value}</span> / {r.limit}</span>
        </div>
      ))}
    </div>
  );
}

const fmtUptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

/** One machine. `here`: the instance answering this page (its health needs no `?instance=`). */
export function InstanceCard({ instance, here }: { instance: string; here: boolean }) {
  const [hours, setHours] = useState<number>(24);
  const reading = useHealth(here ? undefined : instance);
  const history = useHealthHistory(instance, hours);
  const h = reading?.health;
  const down = Boolean(reading?.down);
  const to = Date.now(), from = to - hours * 3_600_000;
  const cpu = downsample((history ?? []).map((p) => ({ at: p.at, v: p.cpuPct })), 300, from, to);
  const mem = downsample((history ?? []).map((p) => ({ at: p.at, v: p.memUsedGb })), 300, from, to);
  const memTotal = h?.memTotalGb ?? Math.max(1, ...(history ?? []).map((p) => p.memTotalGb));
  // Running sessions on this instance, same window and downsampling as cpu/mem — overlaid on both
  // graphs as a pink series on its own right-hand axis (a different scale: a small integer count).
  const sessions = downsample((history ?? []).map((p) => ({ at: p.at, v: p.runningAgents ?? 0 })), 300, from, to);
  const sessionsOverlay: ChartOverlay = { points: sessions, label: "Sessions", fmt: (v) => `${Math.round(v)}`, color: "var(--geist-pink)" };
  const tone = down ? "error" : !h ? "neutral" : h.cpuPct >= 80 || h.memUsedGb / h.memTotalGb >= 0.9 ? "warning" : "ready";
  return (
    <VCard
      slot={`instance-${instance}`}
      title={<span className="flex items-center gap-2"><Server className="text-muted-foreground size-4" />{instance}{here && <span className="text-muted-foreground font-normal">· this machine</span>}</span>}
      aside={<Segmented label="Range" value={String(hours)} onChange={(v) => setHours(Number(v))} options={HISTORY_RANGES.map((r) => ({ value: String(r.hours), label: r.label }))} />}
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Detail label="Status" slot="instance-status">
          <StatusDot tone={tone} />{down ? "Unreachable" : h ? "Online" : "Loading…"}
        </Detail>
        <Detail label="CPU" slot="instance-cpu">{h ? <><span className="tabular-nums">{h.cpuPct}%</span><span className="text-muted-foreground text-xs">of {h.cores} cores</span></> : "—"}</Detail>
        <Detail label="Memory" slot="instance-mem">{h ? <span className="tabular-nums">{h.memUsedGb} / {h.memTotalGb} GB</span> : "—"}</Detail>
        <Detail label="Disk">{h?.disk ? <span className="tabular-nums">{h.disk.usedGb} / {h.disk.totalGb} GB</span> : "—"}</Detail>
        <Detail label="Uptime">{h ? fmtUptime(h.uptimeS) : "—"}</Detail>
        <Detail label="Cost" slot="instance-cost">{h?.cost ? <span className="tabular-nums" title={`estimated at $${h.cost.hourlyUsd}/h since ${h.cost.sinceIso.slice(0, 10)}`}>${h.cost.monthUsd.toFixed(2)} <span className="text-muted-foreground text-xs">this month</span></span> : "—"}</Detail>
      </div>
      {history === null ? (
          <div className="grid gap-6 p-4 md:grid-cols-2">
            <ChartSkeleton slot="chart-cpu-skeleton" /><ChartSkeleton slot="chart-mem-skeleton" />
          </div>
        )
        : !history.length ? <Empty>No history recorded yet — the sampler writes once a minute.</Empty>
        : (
          <div className="grid gap-6 p-4 md:grid-cols-2">
            <LineChart slot="chart-cpu" label="CPU" points={cpu} from={from} to={to} max={100} fmt={(v) => `${Math.round(v)}%`} overlay={sessionsOverlay} />
            <LineChart slot="chart-mem" label="Memory used" points={mem} from={from} to={to} max={memTotal} fmt={(v) => `${v.toFixed(1)} GB`} axis={(v) => `${Math.round(v)}G`} color="var(--geist-green)" overlay={sessionsOverlay} />
          </div>
        )}
    </VCard>
  );
}
