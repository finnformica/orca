import { useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { Check, CircleUser, Columns3, FolderSync, List, Loader2, Monitor, Moon, RefreshCw, Rows2, Rows3, Server, Sun, X } from "lucide-react";
import { navigate, useRoute } from "@/lib/route";
import { boardViewAtom, densityAtom, repoFilterAtom, type BoardView } from "@/lib/atoms";
import { useTheme, type Theme } from "@/lib/theme";
import { api } from "./api";
import type { ClaudeUsage, CodexUsage, ExtraUsage, Usage, ProfileUsage, UsageWindow } from "../../server/usage";
import { useRepos } from "./store";
import { summarizeSync } from "./workstream";
import { Board } from "./views/Board";
import { Overview } from "./views/Overview";
import { PreviewManagerMenu, TestMasterMenu } from "./views/PreviewControl";
import { PrDetail } from "./views/PrDetail";
import { LocalDetail } from "./views/LocalDetail";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { OrchestratorButton } from "@/components/Terminal";

import { instanceChoices, thisInstance } from "./store";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { aggregateProfiles, outOfRotation, useHealth, useUsage } from "@/lib/vitals";
export function App() {
  const route = useRoute();
  const topLevel = route.name === "board";
  const view = useAtomValue(boardViewAtom);
  return (
    <div className="w-full px-4 py-4 md:px-6">
      <header className="mb-6 flex items-center gap-3">
        <Wordmark />
        <p className="text-muted-foreground hidden text-sm sm:block">the pod that ships</p>
        {/* Right cluster reads as two groups: read-only usage status, then a divider, then controls. */}
        <div className="ml-auto flex items-center gap-3">
          <UsageMeter />
          <InstanceHealthChip />
          <div className="flex items-center gap-2">
            {/* Test master + running-previews read as one segmented control (connected borders). */}
            {topLevel && (
              <div className="inline-flex -space-x-px [&>button]:rounded-none [&>button:first-of-type]:rounded-l-md [&>button:last-of-type]:rounded-r-md">
                <TestMasterMenu />
                <PreviewManagerMenu />
              </div>
            )}
            {/* The List view has its own filter bar (repo included); these two shape the swimlanes. */}
            {topLevel && view === "board" && <RepoFilter />}
            {topLevel && view === "board" && <DensityToggle />}
            {topLevel && <ViewToggle />}
            <ProfileMenu />
          </div>
        </div>
      </header>
      {route.name === "pr" ? <PrDetail repo={route.repo} number={route.number} sub={route.sub} />
        : route.name === "local" ? <LocalDetail repo={route.repo} branch={route.branch} sub={route.sub} />
        : view === "board" ? <Board /> : <Overview />}
      <OrchestratorButton />
    </div>
  );
}

// The mark: a geometric orca silhouette (single-fill, currentColor, eye punched out via evenodd so
// it reads on any theme) beside a monospace "Orca" wordmark. The whole lockup links home to the board.
function Wordmark() {
  return (
    <button onClick={() => navigate("/")} className="flex items-center gap-2" title="Orca — board" aria-label="Orca — go to board">
      <OrcaMark className="text-foreground size-6" />
      <span className="font-mono text-xl font-semibold tracking-tight">Orca</span>
    </button>
  );
}

function OrcaMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" className={className} aria-hidden="true">
      <path d="M2 12.5C2 9.5 5.5 8 9 8L11 3L13.5 8C16.5 8 19 8.5 20.5 9L22.5 6L20.3 11L22.5 15.5C19 13 10 14 2 12.5ZM5.6 10a1 1 0 1 0 0 2a1 1 0 1 0 0 -2Z" />
    </svg>
  );
}

// "/" as the overview (List, default) or the five swimlanes (Board) — one persisted segmented control.
const VIEWS: { value: BoardView; label: string; Icon: typeof List }[] = [
  { value: "list", label: "List", Icon: List },
  { value: "board", label: "Board", Icon: Columns3 },
];
function ViewToggle() {
  const [view, setView] = useAtom(boardViewAtom);
  return (
    <div role="group" aria-label="View" className="bg-muted/50 inline-flex h-8 items-center rounded-md border p-0.5">
      {VIEWS.map(({ value, label, Icon }) => (
        <button
          key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)} title={`${label} view`}
          className={`inline-flex h-full items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium transition-colors ${view === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
        >
          <Icon className="size-3.5" /> {label}
        </button>
      ))}
    </div>
  );
}

// Board-only control: flip every (non-Done) card between the full comfortable card and a compact,
// status-only dense card — one persisted toggle, so a board with many sessions fits on screen.
function DensityToggle() {
  const [density, setDensity] = useAtom(densityAtom);
  const dense = density === "dense";
  return (
    <Button
      size="icon" variant="outline" className="size-8" aria-pressed={dense}
      onClick={() => setDensity(dense ? "comfortable" : "dense")}
      title={dense ? "Switch to comfortable view" : "Switch to dense view"}
      aria-label={dense ? "Switch to comfortable view" : "Switch to dense view"}
    >
      {dense ? <Rows2 className="size-4" /> : <Rows3 className="size-4" />}
    </Button>
  );
}

// Board-only control: filter by repo (only meaningful with more than one configured).
function RepoFilter() {
  const repos = useRepos();
  const [filter, setFilter] = useAtom(repoFilterAtom);
  if (repos.length <= 1) return null;
  return (
    <Select value={filter} onValueChange={setFilter}>
      <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All repos</SelectItem>
        {repos.map((r) => <SelectItem key={r.name} value={r.name}>{r.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export { mergeUsage } from "@/lib/vitals";

// Provider usage (top-right): two compact terminal-bar groups, side by side. The poll is shared with
// the overview's usage tile (lib/vitals.useUsage).
function UsageMeter() {
  const usage = useUsage();
  if (!usage) return null;
  return (
    <>
      <div className="text-muted-foreground hidden items-center gap-3 font-mono text-[10px] leading-tight sm:flex" aria-label="Agent usage limits">
        {/* hydra is installed but the `claude` the bridge runs isn't its shim: every run is quietly
            landing on the default login (Claude Code's updater rewrites ~/.local/bin/claude). */}
        {usage.routing?.hydra && !usage.routing.shim && (
          <span data-slot="routing-warning" className="rounded border border-amber-500/40 px-1 text-amber-600 dark:text-amber-400" title="claude on the bridge's PATH isn't hydra's shim, so runs aren't load-balanced across logins. Re-run claude-hydra's install.sh --shim.">
            routing off — claude on PATH isn't hydra's shim
          </span>
        )}
        {usage.profiles ? <ClaudeFleetGroup profiles={usage.profiles} /> : usage.claude && <ClaudeUsageGroup usage={usage.claude} />}
        {(usage.profiles?.some((p) => p.usage) || usage.claude) && usage.codex && <span className="opacity-30" aria-hidden="true">│</span>}
        {usage.codex && <CodexUsageGroup usage={usage.codex} />}
      </div>
      {/* Full button-height footprint (h-8) but the visible line is inset by py-1 — reads as the
          same height as the buttons, just a touch shorter. */}
      <div className="hidden h-8 py-1 sm:block" aria-hidden="true">
        <div className="bg-border h-full w-px" />
      </div>
    </>
  );
}

// `name` is the login's hydra profile name (one group per login); `state` is hydra's verdict, shown
// only when it isn't the ordinary "ok" — exhausted, locked, disabled, token stale, no data yet, not
// signed in — so a login that can't be used says why instead of showing misleading bars.
export { aggregateProfiles, type FleetUsage } from "@/lib/vitals";

// The whole fleet as ONE row (three logins × three bars was too much header), with the per-login
// breakdown in a hover card. Pure CSS hover (group-hover) plus focus-within so it opens from the
// keyboard too; the card is always in the DOM, only hidden, so it costs no state. The card hangs
// off a padded wrapper rather than a margin: a margin is a gap the cursor must cross, and leaving
// the group for even one pixel closed it before you could reach it.
function ClaudeFleetGroup({ profiles }: { profiles: ProfileUsage[] }) {
  const fleet = aggregateProfiles(profiles);
  return (
    <div className="group relative flex items-center gap-2 outline-none" tabIndex={0} aria-label="Claude usage limits">
      <span className="opacity-70">claude ×{fleet?.count ?? 0}</span>
      {fleet ? <>
        <UsageStat provider="Claude" label="5h" pct={fleet.fiveHour.utilization} resetsAt={fleet.fiveHour.resetsAt} />
        <UsageStat provider="Claude" label="1w" pct={fleet.sevenDay.utilization} resetsAt={fleet.sevenDay.resetsAt} />
        {fleet.fable && <UsageStat provider="Claude" label="fable" pct={fleet.fable.utilization} resetsAt={fleet.fable.resetsAt} />}
        {fleet.exhausted > 0 && <span data-slot="usage-state" className="rounded border border-red-500/40 px-1 text-red-600 dark:text-red-400">{fleet.exhausted} exhausted</span>}
      </> : <span data-slot="usage-state" className="rounded border px-1 opacity-60">no login in rotation</span>}
      <div className="absolute top-full right-0 z-30 hidden pt-2 group-hover:block group-focus-within:block">
        <div data-slot="usage-breakdown" role="tooltip" className="bg-popover text-popover-foreground w-96 rounded-lg border px-4 py-3 shadow-lg">
          <div className="mb-2 flex items-baseline justify-between text-[11px] opacity-60">
            <span>Claude logins</span>
            <span>{fleet ? `${fleet.count} in rotation` : "none in rotation"}</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {profiles.map((p) => <LoginUsage key={p.name} profile={p} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

// One login in the breakdown: name + state on the first line, then a bar per window with the
// figure and the time to reset. Dimmed when hydra can't route to it.
function LoginUsage({ profile: p }: { profile: ProfileUsage }) {
  const state = p.state ?? "ok";
  const windows: [string, UsageWindow | null | undefined][] = [["5h", p.usage?.fiveHour], ["1w", p.usage?.sevenDay], ["fable", p.usage?.fable]];
  return (
    <div data-slot="usage-login" className={outOfRotation(p) ? "opacity-50" : ""}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-medium" title={p.email}>{p.name}</span>
        <span className={`shrink-0 rounded px-1 text-[10px] uppercase tracking-wide ${state === "ok" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : state === "exhausted" || state === "locked" ? "bg-red-500/10 text-red-600 dark:text-red-400" : "bg-muted opacity-70"}`}>{state}</span>
      </div>
      <div className="mt-1 grid grid-cols-3 gap-4">
        {windows.map(([label, w]) => <UsageBar key={label} label={label} window={w} />)}
      </div>
    </div>
  );
}

const ZONE_BAR: Record<"ok" | "warn" | "danger", string> = { ok: "bg-emerald-500", warn: "bg-amber-500", danger: "bg-red-500" };

function UsageBar({ label, window: w }: { label: string; window: UsageWindow | null | undefined }) {
  return (
    <div className="min-w-0">
      <div className="flex justify-between text-[10px] leading-tight">
        <span className="opacity-60">{label}</span>
        <span className={w ? `font-semibold ${ZONE_TEXT[usageZone(w.utilization)]}` : "opacity-40"}>{w ? `${w.utilization}%` : "—"}</span>
      </div>
      <div className="bg-muted mt-0.5 h-1.5 w-full overflow-hidden rounded-full">
        {w && <div className={`h-full rounded-full ${ZONE_BAR[usageZone(w.utilization)]}`} style={{ width: `${Math.min(100, w.utilization)}%` }} />}
      </div>
    </div>
  );
}

function ClaudeUsageGroup({ usage, name, state }: { usage: ClaudeUsage | null; name?: string; state?: string }) {
  const off = state && state !== "ok";
  return (
    <div className="flex items-center gap-2" aria-label={name ? `Claude ${name} usage limits` : "Claude usage limits"}>
      <span className="opacity-70">{name ? `claude·${name}` : "claude"}</span>
      {usage && <>
        <UsageStat provider="Claude" label="5h" pct={usage.fiveHour.utilization} resetsAt={usage.fiveHour.resetsAt} />
        <UsageStat provider="Claude" label="1w" pct={usage.sevenDay.utilization} resetsAt={usage.sevenDay.resetsAt} />
        {usage.fable && <UsageStat provider="Claude" label="fable" pct={usage.fable.utilization} resetsAt={usage.fable.resetsAt} />}
        {usage.extra && <SpendStat extra={usage.extra} />}
      </>}
      {off && <span data-slot="usage-state" className={`rounded border px-1 ${state === "exhausted" || state === "locked" ? "border-red-500/40 text-red-600 dark:text-red-400" : "opacity-60"}`} title={`hydra: ${state}`}>{state}</span>}
    </div>
  );
}

function CodexUsageGroup({ usage }: { usage: CodexUsage }) {
  return (
    <div className="flex items-center gap-2" aria-label="Codex usage limits">
      <span className="opacity-70">codex</span>
      {usage.windows.map((window, index) => (
        <UsageStat key={`${window.label}-${index}`} provider="Codex" label={window.label === "wk" ? "1w" : window.label} pct={window.utilization} resetsAt={window.resetsAt} />
      ))}
    </div>
  );
}

// Traffic-light zone by how much of the allowance is burned: green (fine) → amber (caution, ≥75%)
// → red (the "red-zone", ≥90%). Colours the figure only — statusline style, not a badge.
function usageZone(pct: number): "ok" | "warn" | "danger" {
  return pct >= 90 ? "danger" : pct >= 75 ? "warn" : "ok";
}
const ZONE_TEXT: Record<"ok" | "warn" | "danger", string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
};

/** Compact countdown to a window's reset, e.g. "45m", "1h 15m", "2h", "7d 2h" — null if unknown or
 *  already past. `now` is injectable for tests (defaults to wall-clock). Pure. Lives here (not
 *  server/usage.ts) so it stays out of a browser bundle that can't resolve that module's node/Bun
 *  imports. */
export function untilReset(resetsAt: string | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) {
    const hours = Math.floor(mins / 60);
    const minutes = mins % 60;
    return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
  }
  const days = Math.floor(mins / (24 * 60));
  const hours = Math.floor((mins % (24 * 60)) / 60);
  return `${days}d${hours ? ` ${hours}h` : ""}`;
}

function UsageStat({ provider, label, pct, resetsAt }: { provider: string; label: string; pct: number; resetsAt: string | null }) {
  const left = untilReset(resetsAt);
  const resets = resetsAt ? `, resets ${new Date(resetsAt).toLocaleString()}` : "";
  const filled = Math.max(0, Math.min(5, Math.round(pct / 20)));
  return (
    <span className="whitespace-nowrap" title={`${provider} ${label} usage: ${pct}%${resets}`}>
      {label}{" "}
      <span className={`font-semibold ${ZONE_TEXT[usageZone(pct)]}`}>
        <span aria-hidden="true">{"█".repeat(filled)}{"░".repeat(5 - filled)}</span>{" "}{pct}%
        {left && <span className="ml-0.5 font-normal opacity-60">({left})</span>}
      </span>
    </span>
  );
}

/** Format money carried as minor units (+ exponent) in its own currency, e.g. 8535/2/GBP → "£85.35". */
function formatMoney(minor: number, exponent: number, currency: string): string {
  const amount = minor / 10 ** exponent;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: exponent }).format(amount);
  } catch {
    return `${amount.toFixed(exponent)} ${currency}`; // unknown currency code → plain number + code
  }
}

// Pay-as-you-go spend this month as actual money, coloured by how much of the cap is used.
function SpendStat({ extra }: { extra: ExtraUsage }) {
  const used = formatMoney(extra.usedMinor, extra.exponent, extra.currency);
  const limit = formatMoney(extra.limitMinor, extra.exponent, extra.currency);
  return (
    <span className="whitespace-nowrap" title={`Extra usage this month: ${used} of ${limit} (${extra.utilization}%)`}>
      $ <span className={`font-semibold ${ZONE_TEXT[usageZone(extra.utilization)]}`}>{used}</span>
    </span>
  );
}

// Pull remote work down across every configured repo: fetch each, fast-forward its worktrees to
// their upstreams (never forces). Keeps the menu open (onSelect preventDefault) so its inline
// spinner → ✓/✗ feedback and per-outcome summary stay visible, matching the ActionButton pattern.
function SyncWorktreesItem() {
  const repos = useRepos();
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [summary, setSummary] = useState("");
  const run = async () => {
    if (state === "loading") return;
    setState("loading");
    setSummary("");
    try {
      const results = (await Promise.all(repos.map((r) => api.syncWorktrees(r.name)))).flat();
      setSummary(summarizeSync(results));
      setState("done");
    } catch {
      setSummary("sync failed");
      setState("error");
    }
    setTimeout(() => { setState("idle"); setSummary(""); }, 6000);
  };
  const Icon = state === "loading" ? Loader2 : state === "done" ? Check : state === "error" ? X : FolderSync;
  return (
    <DropdownMenuItem
      onSelect={(e) => { e.preventDefault(); void run(); }}
      disabled={state === "loading"}
      title="Fetch each repo and fast-forward every worktree to its upstream (never forces, skips dirty/diverged)"
    >
      <Icon className={`size-3.5${state === "loading" ? " animate-spin" : ""}`} /> Sync worktrees
      {summary && <span className="text-muted-foreground ml-auto pl-3 text-xs">{summary}</span>}
    </DropdownMenuItem>
  );
}

const THEMES: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

// Profile menu (top-right, all views): refresh the app + a theme submenu (light/dark/system).
function ProfileMenu() {
  const [theme, setTheme] = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="outline" className="size-8" title="Profile" aria-label="Profile menu">
          <CircleUser className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => window.location.reload()} title="Reload the app (pick up rebuilt code + refetch)">
          <RefreshCw className="size-3.5" /> Refresh
        </DropdownMenuItem>
        <SyncWorktreesItem />
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Theme</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              {THEMES.map(({ value, label, Icon }) => (
                <DropdownMenuRadioItem key={value} value={value}><Icon className="size-3.5" /> {label}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The cloud box's vitals in the header — CPU (load against cores), memory, disk, and the month's
// estimated cost — polled every 15s from /api/health?instance=<other>, only when there is another
// instance. A hover card has the details; the chip itself stays to one line.
export function InstanceHealthChip() {
  useRepos(); // subscribe: config lands after first paint, and `other` is read from it — without this the chip stayed null for good
  const choices = instanceChoices();
  const other = choices.find((i) => i !== thisInstance());
  const reading = useHealth(other ?? null);
  const h = other ? reading?.health ?? null : null;
  const down = Boolean(other && reading?.down);
  if (!other) return null;
  const tone = down ? "text-destructive" : (h?.cpuPct ?? 0) >= 80 || (h && h.memUsedGb / h.memTotalGb >= 0.9) ? "text-amber-500" : "text-muted-foreground";
  const uptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-slot="instance-health" className={`hidden items-center gap-1.5 rounded-md border px-2 py-1 text-xs sm:inline-flex ${tone} hover:bg-accent`} title={`${other}: machine health`}>
          <Server className="size-3.5" />
          <span className="font-medium">{other}</span>
          {down ? <span>unreachable</span> : h ? <span>cpu {h.cpuPct}% · mem {h.memUsedGb}/{h.memTotalGb} GB{h.cost ? ` · $${h.cost.monthUsd.toFixed(2)}` : ""}</span> : <span>…</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 text-xs">
        {down || !h ? <p>{down ? `${other} did not answer.` : "Loading…"}</p> : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">host</dt><dd>{h.hostname}</dd>
            <dt className="text-muted-foreground">cpu</dt><dd>{h.cpuPct}% of {h.cores} cores (load {h.load1.toFixed(2)} / {h.load5.toFixed(2)})</dd>
            <dt className="text-muted-foreground">memory</dt><dd>{h.memUsedGb} of {h.memTotalGb} GB</dd>
            {h.disk && <><dt className="text-muted-foreground">disk</dt><dd>{h.disk.usedGb} of {h.disk.totalGb} GB</dd></>}
            <dt className="text-muted-foreground">uptime</dt><dd>{uptime(h.uptimeS)}</dd>
            {h.cost && <><dt className="text-muted-foreground">cost</dt><dd>${h.cost.monthUsd.toFixed(2)} this month, estimated at ${h.cost.hourlyUsd}/h since {h.cost.sinceIso.slice(0, 10)}</dd></>}
          </dl>
        )}
      </PopoverContent>
    </Popover>
  );
}
