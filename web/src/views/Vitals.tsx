// The two vitals cards, Vercel-style. Usage: Claude (per hydra login, plus the fleet) and Codex as
// rows of ring + label + value / limit. Instance: one card per machine, its current vitals as a
// details grid and CPU % / memory GB as line graphs over a chosen range from /api/health/history.
// Both read the shared polls in lib/vitals, so the Overview and the Usage page never poll twice.
// The header's compact meter (HeaderUsageMeter, below) reads the SAME poll and opens a HoverCard
// around this exact UsageCard — no second usage widget to keep in sync.
import { useState } from "react";
import { useAtom } from "jotai";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Loader2, RefreshCw, Server, X } from "lucide-react";
import { api } from "@/api";
import { usageExpandedAtom } from "@/lib/atoms";
import { notifyLocal } from "@/lib/notificationStore";
import { persistedKey, usePersisted } from "@/lib/persisted";
import { useCoarse, useNarrow } from "@/lib/viewport";
import { applyProfileToggle, optimisticProfileToggle, refreshUsageNow, refreshVitals, revertProfileToggle, useHealth, useHealthHistory, useUsage, useUsageLoaded } from "@/lib/vitals";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Tip } from "@/components/ui/tip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { thisInstance } from "../store";
import { HISTORY_RANGES, countMax, headerUsage, heavyQueueRows, hostHints, instanceSeries, loginStatus, monthCostLabel, niceMax, protectionsWarning, routingBroken, usageGroups, type UsageGroup } from "../workstream";
import { ChartSkeleton, Detail, Empty, LineChart, Pill, Ring, Segmented, StatusDot, UsageSkeleton, VCard } from "@/components/console";

/** The Overview's and the Usage page's card — one component, one behaviour: the high-level rows (the
 *  fleet + Codex) always show, and Vercel's chevron (or the header row) expands the per-login breakdown.
 *  The choice is one remembered toggle (`orca.ui.v1.usageExpanded`), shared by both pages. */
export function UsageCard({ className, bodyClass }: { className?: string; bodyClass?: string } = {}) {
  const usage = useUsage();
  const loaded = useUsageLoaded();
  const groups = usageGroups(usage);
  const [expanded, setExpanded] = useAtom(usageExpandedAtom);
  const logins = groups.filter((g) => g.key.startsWith("login:")).length;
  const canToggle = logins > 0;
  const toggle = () => setExpanded(!expanded);
  const shown = expanded ? groups : groups.filter((g) => !g.key.startsWith("login:"));
  return (
    <VCard slot="usage-card" title="Current windows" aside={<span className="text-muted-foreground text-xs">Claude &amp; Codex limits</span>}
      onHeaderClick={canToggle ? toggle : undefined} expanded={canToggle ? expanded : undefined} className={className} bodyClass={bodyClass}>
      {routingBroken(usage) && (
        <div data-slot="routing-warning"
          className="bg-geist-warning-bg text-geist-warning-fg flex items-start gap-2 border-b px-4 py-2 text-xs">
          <Tip label="Claude Code's updater rewrote ~/.local/bin/claude. Re-run hydra's install.sh --shim on the bridge's machine." side="bottom">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          </Tip>
          <span>Claude routing off: hydra is installed but the bridge's <code>claude</code> isn't its shim, so every run lands on the default login.</span>
        </div>
      )}
      {!loaded ? (
        <UsageSkeleton />
      ) : !groups.length ? <Empty>No provider is signed in on this machine.</Empty> : (
        <div className="p-2">
          {shown.map((g) => <UsageGroupRows key={g.key} group={g} />)}
          {canToggle && (
            <button type="button" data-slot="usage-toggle" aria-expanded={expanded} onClick={toggle}
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 py-1.5 text-xs">
              {expanded ? <>Show less <ChevronUp className="size-3.5" /></> : <>Show {logins} login{logins === 1 ? "" : "s"} <ChevronDown className="size-3.5" /></>}
            </button>
          )}
        </div>
      )}
    </VCard>
  );
}

/** The top bar's compact Claude 5-hour-window meter, immediately left of "Ask the orchestrator": a
 *  ring + percent for EXACTLY the number UsageCard's own headline row shows (`headerUsage` reuses
 *  `usageGroups`) — never a separately computed figure that could read differently beside the card.
 *  Hovering or focusing it opens a HoverCard around the SAME `UsageCard` the Overview page shows,
 *  borderless so it isn't double-framed inside the popover — per-login detail lives there, not in
 *  this number or its tooltip. Renders nothing until the first poll answers, or with no Claude login
 *  signed in / none in rotation. */
export function HeaderUsageMeter() {
  const usage = useUsage();
  const loaded = useUsageLoaded();
  if (!loaded) return null;
  const reading = headerUsage(usage);
  if (!reading) return null;
  const pct = Math.round(reading.pct);
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <button type="button" data-slot="header-usage" tabIndex={0} aria-label={`Claude usage — ${reading.tooltip}`}
          className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs max-md:hidden">
          <Ring pct={pct} size={14} />
          <span className="tabular-nums">{pct}%</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <UsageCard className="border-none shadow-none" />
      </HoverCardContent>
    </HoverCard>
  );
}

function UsageGroupRows({ group: g }: { group: UsageGroup }) {
  const [hover, setHover] = useState(false);
  const coarse = useCoarse();
  const narrow = useNarrow();
  const status = g.state ? loginStatus(g.state) : null;
  const hints = hostHints(g);
  return (
    <div data-slot="usage-group" data-group={g.key} className={`mb-1 last:mb-0 ${g.dim ? "opacity-50" : ""}`}>
      {/* One line however long the name or the reason: the status is one word right after the name
          (its reason in the tooltip), the name truncates rather than pushing the row out, and the
          email gives way first. Usage is per ACCOUNT (merged across instances), so the pill is
          whichever host's reading was picked — a host-specific problem elsewhere shows as a small
          secondary hint instead ("Stale on local"), each with its own Refresh targeting that host. */}
      <div data-slot="usage-group-header" className="flex max-w-full min-w-0 items-center justify-between gap-2 px-2 pt-1.5 pb-1" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <span className="flex min-w-0 items-center gap-1.5">
          <span data-slot="usage-group-title" className="min-w-0 truncate text-xs font-medium">{g.title}</span>
          {status && <Tip label={status.detail}><Pill tone={status.tone} slot="usage-state">{status.label}</Pill></Tip>}
          {g.name && status?.label === "Stale" && <RefreshProfileButton name={g.name} instance={g.instance} />}
          {g.name && (hover || coarse) && <LoginToggle name={g.name} enabled={g.state !== "disabled"} />}
          {g.name && hints.map((h) => {
            const hStatus = loginStatus(h.state);
            return (
              <Tip key={h.instance} label={hStatus.detail}>
                <span data-slot="usage-host-hint"
                  className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs">
                  {hStatus.label} on {h.instance}
                  {hStatus.label === "Stale" && <RefreshProfileButton name={g.name!} instance={h.instance} />}
                </span>
              </Tip>
            );
          })}
        </span>
        {g.subtitle && <span className="text-muted-foreground min-w-0 shrink-[2] truncate text-xs">{g.subtitle}</span>}
      </div>
      {g.rows.map((r) => (
        <div key={r.key} data-slot="usage-row"
          className="hover:bg-accent flex h-9 items-center gap-2.5 rounded-md px-2 text-sm">
          <Ring pct={r.pct} />
          <span className="min-w-0 flex-1 truncate">{r.label}</span>
          {(r.resetsIn || r.resetNote) && (
            // Narrow screens get the bare countdown ("4h 32m"), no "resets " prefix — keeps the row
            // on one line without wrapping instead of hiding the reset entirely.
            <span data-slot="usage-reset" className="text-muted-foreground shrink-0 truncate text-xs">
              {narrow ? (r.resetsIn ?? r.resetNote) : r.resetsIn ? `resets ${r.resetsIn}` : r.resetNote}
            </span>
          )}
          <span className="text-muted-foreground shrink-0 tabular-nums"><span className="text-foreground">{r.value}</span> / {r.limit}</span>
        </div>
      ))}
    </div>
  );
}

type SwitchState = "idle" | "loading" | "done" | "error";

/** A hydra login's rotation switch, next to its name — the caller mounts it only on hover (or
 *  always, on a touch screen), so it reserves no space on a row that isn't. OPTIMISTIC: a click
 *  flips the switch, the row's dim styling and the fleet mean in the shared usage mirror at once
 *  (`optimisticProfileToggle`) — no spinner, nothing disabled, so a rapid second click lands and
 *  wins (`applyProfileToggle` / `revertProfileToggle` are no-ops once a later click's token has
 *  superseded this one). `POST /api/usage/profile` runs in the background: its refreshed profile
 *  list is applied when it lands, and a failure rolls the switch back to its pre-click value and
 *  raises the existing failed-action notification. Hydra's rotation is per host, but the switch is
 *  one decision for the ACCOUNT: no `instance` is sent, and the bridge applies it on every host that
 *  has the login — so the row never reads "Disabled on local" beside an enabled cloud. */
function LoginToggle({ name, enabled }: { name: string; enabled: boolean }) {
  const [error, setError] = useState(false);
  const toggle = () => {
    const next = !enabled;
    const { token, prev } = optimisticProfileToggle(name, next);
    setError(false);
    api.setProfileEnabled(name, next).then(
      ({ profiles }) => applyProfileToggle(name, token, profiles),
      (e) => {
        revertProfileToggle(name, token, prev);
        const verb = next ? "Enable" : "Disable", error = e instanceof Error ? e.message : String(e);
        notifyLocal({
          kind: "action_failed", repo: "", title: `Login ${name}`, label: `${verb} failed`, body: error,
          copy: `Action: ${verb} hydra login ${name}\nError:\n${error}`,
          ask: `${verb} hydra login ${name} failed: ${error}. Please investigate and fix.`,
        });
        setError(true);
        setTimeout(() => setError(false), 2000);
      },
    );
  };
  return (
    <Tip label={enabled ? `Take ${name} out of hydra's rotation` : `Put ${name} back`}>
      <Switch size="sm" checked={enabled} data-slot="login-toggle"
        onClick={(e) => e.stopPropagation()} onCheckedChange={toggle}
        className={cn(
          "data-[state=checked]:bg-geist-blue [&>[data-slot=switch-thumb]]:bg-white",
          error && "data-[state=checked]:bg-destructive data-[state=unchecked]:bg-destructive",
        )}>
        {error && <X className="size-2.5" />}
      </Switch>
    </Tip>
  );
}

/** A stale login's fix, right on the row. Calls `POST /api/usage/refresh` against the HOST whose
 *  login is stale (`instance` — the merged row's own host, else this browser's), which re-reads
 *  usage and, when the access token has lapsed, renews it with one minimal Claude launch under that
 *  login (hydra itself never renews a token). The server answers an error when the endpoint
 *  rate-limits (429) or the login is still stale after renewing (its refresh token is gone — `hydra
 *  login`, which needs a browser); a re-read that is still stale is treated as that failure too.
 *  Then re-polls the merged fleet view so the row reflects the fix at once. */
function RefreshProfileButton({ name, instance }: { name: string; instance?: string }) {
  const [state, setState] = useState<SwitchState>("idle");
  const target = instance ?? thisInstance();
  const fail = (error: string) => {
    notifyLocal({
      kind: "action_failed", repo: "", title: `Login ${name}`, label: "Refresh failed", body: error,
      copy: `Action: Refresh hydra login ${name}\nError:\n${error}`,
      ask: `Refresh hydra login ${name} failed: ${error}. Please investigate and fix.`,
    });
    setState("error");
  };
  const refresh = async () => {
    if (state === "loading") return;
    setState("loading");
    try {
      const { profiles } = await api.refreshProfile(name, target);
      const stillStale = profiles?.find((p) => p.name === name)?.state?.startsWith("token stale");
      await refreshUsageNow();
      if (stillStale) {
        fail(`Still stale after renewing — the refresh token itself has expired. Run "hydra login ${name}"${target ? ` on ${target}` : ""}.`);
      } else {
        setState("done");
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <Tip label={`Renew ${name}'s expired token on ${target ?? "this host"}`}>
      <button type="button" data-slot="login-refresh" disabled={state === "loading"}
        aria-label={`Renew ${name}'s token`}
        onClick={(e) => { e.stopPropagation(); void refresh(); }}
        className="text-muted-foreground hover:text-foreground flex size-4 shrink-0 items-center justify-center">
        {state === "loading" ? <Loader2 className="size-3 animate-spin" />
          : state === "done" ? <Check className="size-3" />
          : state === "error" ? <X className="size-3" />
          : <RefreshCw className="size-3" />}
      </button>
    </Tip>
  );
}

const isRange = (v: unknown): v is number => HISTORY_RANGES.some((r) => r.hours === v);

const fmtUptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

/** The Instances heading's refresh: every machine card's health and history, fetched now rather than
 *  on its next tick — a spinner until they have all answered. */
export function RefreshVitals() {
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try { await refreshVitals(); } finally { setBusy(false); }
  };
  return (
    <Tip label="Refresh" side="bottom">
      <Button type="button" variant="soft" size="icon" data-slot="instances-refresh" aria-label="Refresh" aria-busy={busy} disabled={busy}
        onClick={() => void refresh()} className="size-7">
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
      </Button>
    </Tip>
  );
}

const pct = (v: number) => `${Math.round(v)}%`;
const count = (v: number) => String(Math.round(v));

/** One machine. `here`: the instance answering this page (its health needs no `?instance=`). */
export function InstanceCard({ instance, here }: { instance: string; here: boolean }) {
  // The range is remembered per machine (`orca.ui.v1.instanceRange:<instance>`).
  const [hours, setHours] = usePersisted<number>(persistedKey("instanceRange", instance), 24, isRange);
  const reading = useHealth(here ? undefined : instance);
  const history = useHealthHistory(instance, hours);
  const h = reading?.health;
  const down = Boolean(reading?.down);
  const to = Date.now(), from = to - hours * 3_600_000;
  // The machine's rate and this month's cost, from its own /api/health (kept from the last answer
  // while it is down).
  const cost = monthCostLabel(h?.month, h?.rate);
  // One series for every chart AND the header stats: the newest sample (the live reading when it is
  // newer than the last recorded one) is both what the grid shows and where every line ends.
  const s = instanceSeries(history ?? [], h && { ...h, diskUsedGb: h.disk?.usedGb }, from, to, 300);
  const now = s.latest;
  const ooms = s.ooms.reduce((n, o) => n + o.n, 0);
  const memTotal = h?.memTotalGb ?? Math.max(1, ...(history ?? []).map((p) => p.memTotalGb));
  const tone = down ? "error" : !h ? "neutral" : h.cpuPct >= 80 || h.memUsedGb / h.memTotalGb >= 0.9 ? "warning" : "ready";
  const guard = protectionsWarning(h?.protections);
  const heavyRows = heavyQueueRows(h?.heavy);
  return (
    <VCard
      slot={`instance-${instance}`}
      title={<span className="flex items-center gap-2"><Server className="text-muted-foreground size-4" />{instance}{here && <span className="text-muted-foreground font-normal">· this machine</span>}</span>}
      aside={<Segmented label="Range" value={String(hours)} onChange={(v) => setHours(Number(v))} options={HISTORY_RANGES.map((r) => ({ value: String(r.hours), label: r.label }))} />}
    >
      {guard && (
        <div data-slot="protections-warning" data-warn={guard.warn || undefined}
          className={cn("flex items-start gap-2 border-b px-4 py-2 text-xs", guard.warn ? "bg-geist-warning-bg text-geist-warning-fg" : "text-muted-foreground")}>
          {guard.warn && <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}
          <span>{guard.text}{guard.detail && <span className="opacity-80"> {guard.detail}</span>}</span>
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Detail label="Status" slot="instance-status">
          <StatusDot tone={tone} />{down ? "Unreachable" : h ? "Online" : "Loading…"}
        </Detail>
        <Detail label="CPU" slot="instance-cpu">{now ? (
          <>
            <span className="tabular-nums">{pct(now.cpuPct)}</span>
            {h && <span data-slot="instance-load" className="text-muted-foreground text-xs"> · load {h.load1.toFixed(1)} / {h.cores} cores</span>}
            {h && h.iowaitPct !== undefined && h.iowaitPct > 10 && (
              <span data-slot="instance-iowait" className="text-muted-foreground text-xs"> · iowait {pct(h.iowaitPct)}</span>
            )}
          </>
        ) : "—"}</Detail>
        <Detail label="Memory" slot="instance-mem">
          {now ? (h?.memPressure ? (
            <Tip label={`pressure — ${h.memPressurePct}% used`}><span className="tabular-nums">{now.memUsedGb.toFixed(1)} / {memTotal} GB</span></Tip>
          ) : <span className="tabular-nums">{now.memUsedGb.toFixed(1)} / {memTotal} GB</span>) : "—"}
        </Detail>
        <Detail label="Disk">{h?.disk ? <span className="tabular-nums">{h.disk.usedGb} / {h.disk.totalGb} GB</span> : "—"}</Detail>
        <Detail label="Uptime">{h ? fmtUptime(h.uptimeS) : "—"}</Detail>
        <Detail label="Cost · this month" slot="instance-cost">{cost ? (
          <Tip label={cost.detail}><span className="tabular-nums">{cost.value}{h?.rate?.source === "estimate" && <span className="text-muted-foreground ml-1 text-xs">est.</span>}</span></Tip>
        ) : "—"}</Detail>
      </div>
      {heavyRows.length > 0 && (
        <div data-slot="heavy-queue" className="border-b px-4 py-3">
          <div className="text-muted-foreground mb-1.5 text-xs">Heavy commands · orca-run{h?.heavy?.cpu && <span data-slot="heavy-cpu" className="tabular-nums"> · CPU {h.heavy.cpu.used} / {h.heavy.cpu.budget}</span>}{h?.heavy?.memory?.budget !== undefined && <span data-slot="heavy-memory" className="tabular-nums"> · Memory {h.heavy.memory.used} / {h.heavy.memory.budget} GB</span>}</div>
          {/* Many rows (a busy queue) scroll inside the card, on a phone too, instead of growing it. */}
          <ScrollArea viewportClassName="max-h-64">
          <ul className="divide-y pr-2.5">
            {heavyRows.map((r) => (
              <li key={r.id} data-slot="heavy-row" data-state={r.state} className="flex items-center gap-2 py-1.5 text-[13px]">
                <StatusDot tone={r.state === "running" ? "building" : "queued"} />
                <span className="text-muted-foreground w-16 shrink-0 text-xs">{r.state === "running" ? "running" : `queued #${r.position}`}</span>
                <span className="w-14 shrink-0 text-xs">{r.kind}</span>
                {/* The Tip's own wrapper must shrink too, or a long command pushes the row past the card. */}
                <Tip label={r.command} className="min-w-0 flex-1"><span data-slot="heavy-command" className="min-w-0 truncate font-mono text-xs">{r.command}</span></Tip>
                <span className="text-muted-foreground max-w-[40%] shrink-0 truncate text-xs max-md:max-w-[25%]">{r.who}</span>
              </li>
            ))}
          </ul>
          </ScrollArea>
        </div>
      )}
      {history === null ? (
          <div className="grid gap-6 p-4 md:grid-cols-2">
            <ChartSkeleton slot="chart-cpu-skeleton" /><ChartSkeleton slot="chart-mem-skeleton" />
            <ChartSkeleton slot="chart-agents-skeleton" /><ChartSkeleton slot="chart-disk-skeleton" />
            <ChartSkeleton slot="chart-bridge-skeleton" />
          </div>
        )
        : !history.length ? <Empty>No history recorded yet — the sampler writes once a minute.</Empty>
        : (
          <div className="grid gap-6 p-4 md:grid-cols-2">
            <LineChart slot="chart-cpu" label="CPU" points={s.cpu} from={from} to={to} max={100} fmt={pct} />
            <LineChart slot="chart-mem" label={<>Memory used{ooms > 0 && <span data-slot="chart-oom" className="text-[var(--geist-red)]"> · {ooms} OOM kill{ooms === 1 ? "" : "s"}</span>}</>} points={s.mem}
              marks={s.ooms.map((o) => ({ at: o.at, title: `${o.n} agent run${o.n === 1 ? "" : "s"} out of memory` }))} from={from} to={to} max={memTotal} fmt={(v) => `${v.toFixed(1)} GB`} axis={(v) => `${Math.round(v)}G`} color="var(--geist-green)" />
            <LineChart slot="chart-agents" label="Agents" points={s.agents} from={from} to={to} max={countMax(Math.max(0, ...s.agents.map((p) => p.v)))} fmt={count} color="var(--geist-pink)" />
            <LineChart slot="chart-disk" label="Disk used" points={s.disk} from={from} to={to} max={h?.disk?.totalGb ?? niceMax(Math.max(1, ...s.disk.map((p) => p.v)) * 1.1)}
              fmt={(v) => `${v.toFixed(1)} GB`} axis={(v) => `${Math.round(v)}G`} color="var(--geist-amber)" />
            <LineChart slot="chart-bridge" label="Bridge memory" points={s.bridge} from={from} to={to} max={niceMax(Math.max(256, ...s.bridge.map((p) => p.v)) * 1.1)}
              fmt={(v) => `${Math.round(v)} MB`} axis={(v) => `${Math.round(v)}M`} color="var(--geist-blue)" />
          </div>
        )}
    </VCard>
  );
}
