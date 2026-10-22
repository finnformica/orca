// Is what's on screen current? Two answers, both in the top bar's reach. The stale indicator: the
// board's poll hasn't been answered for a while (a phone that slept, a dropped tailnet, a bridge
// restart) — said in words, not on hover. The refresh banner: the server now serves a newer build
// than the one this tab runs (a deploy happened) — one tap hands over to the new build's service
// worker (lib/sw.ts applyUpdate) and reloads.
import { useEffect, useState } from "react";
import { CloudOff, DatabaseZap, RefreshCw, Server, WifiOff } from "lucide-react";
import { poll } from "@/lib/poll";
import { refreshEverything, useDatabaseDown, useRefreshing } from "@/lib/refresh";
import { applyUpdate } from "@/lib/sw";
import { useBridge, useLastSync } from "../store";
import { ago, bridgeLabel, databaseBannerText, newerBuild, staleAge } from "../workstream";
import { Tip } from "@/components/ui/tip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const RUNNING_BUILD = typeof __ORCA_BUILD__ === "undefined" ? undefined : __ORCA_BUILD__;
const PREVIEW_PAGE = typeof __ORCA_PREVIEW__ === "undefined" ? false : __ORCA_PREVIEW__;

/** On a branch preview, which bridge answers its /api — the branch's own, or (warning) main's. */
export function BridgeLabel({ previewPage = PREVIEW_PAGE }: { previewPage?: boolean }) {
  const label = bridgeLabel(useBridge(), previewPage);
  if (!label) return null;
  return (
    <Tip label={label.title} className="min-w-0">
      <span role="status" data-slot="bridge-label" className={`${label.warn ? "bg-geist-warning-bg text-geist-warning-fg" : "bg-muted text-muted-foreground"} inline-flex h-6 min-w-0 items-center gap-1 rounded-full px-2 text-xs font-medium`}>
        <Server className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate max-md:sr-only">{label.text}</span>
      </span>
    </Tip>
  );
}

/** "Updated 3 min ago" — and a button: a click is "Refresh everything" (lib/refresh.ts): stuck requests
 *  aborted, every poll on the page re-run at once, the icon spinning until all have answered (a hard
 *  reload if they never do). It stays shown while refreshing, even once the fresh answer clears the age. */
export function StaleIndicator() {
  const last = useLastSync();
  const refreshing = useRefreshing();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  const age = staleAge(last, Math.max(now, last));
  if (age === null && !refreshing) return null;
  return (
    <button type="button" data-slot="stale-indicator" aria-busy={refreshing} disabled={refreshing}
      onClick={() => void refreshEverything().then(() => setNow(Date.now()))}
      className="bg-geist-warning-bg text-geist-warning-fg inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium hover:opacity-80 disabled:cursor-progress max-md:h-8 max-md:px-2.5">
      {refreshing
        ? <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
        : <CloudOff className="size-3.5" aria-hidden="true" />}
      <span role="status" className="max-md:sr-only">{refreshing ? "Refreshing…" : `Updated ${ago(last, now)}`}</span>
    </button>
  );
}

/** Checks `/version.json` once a minute (paused while hidden, like every poll) and, when a newer build
 *  is being served, shows a bar with Refresh. A dev server has no build id and never asks.
 *  The look is branch-demo's floating bars: `FloatingSelectionActions`'s shape (the content on one
 *  line, equal padding all round instead of its fixed `h-12`) and `LicenseBanner`'s icon-plus-text —
 *  but on `bg-primary`, the house's one inverted surface (Merge's button, the offline screen's "Try
 *  again"), not a translucent one: against the page's own background the bar read as part of the page,
 *  not an alert over it. `bg-primary` is also the server's theme colour (`lib/identity.ts`), so it
 *  still reads as Orca's own voice, and `shadow-modal` — the house's stronger of its two shadow tokens
 *  — gives it real lift. It FLOATS: the Shell mounts it in the page column, in a zero-height sticky slot, so
 *  it sits at the top centre of the page (never over the nav or the docked panel) and nothing in the
 *  layout moves when it shows or hides. It slides down and fades in, and on Refresh it slides up and
 *  fades out while the new build loads (none under reduced motion).
 *  `?update-banner` in the URL shows it at once (screenshots, a check of the layout). */
export function UpdateBanner({ build = RUNNING_BUILD, every = 60_000, forced = forceUpdateBanner() }: { build?: string; every?: number; forced?: boolean }) {
  const [stale, setStale] = useState(forced);
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!build || build === "dev" || stale) return;
    return poll(() => fetch("/version.json", { cache: "no-store" }).then((r) => r.json()).then((v: unknown) => { if (newerBuild(build, v)) setStale(true); }), every);
  }, [build, stale, every]);
  if (!stale || gone) return null;
  return (
    <div data-slot="update-banner-frame" className="pointer-events-none sticky top-0 z-40 h-0 overflow-visible">
      <div className="flex justify-center px-2 pt-2 max-md:pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div role="status" data-slot="update-banner" data-state={leaving ? "closed" : "open"}
          onAnimationEnd={() => { if (leaving) setGone(true); }}
          className={cn(
            "bg-primary text-primary-foreground pointer-events-auto flex max-w-full min-w-0 items-center gap-3 rounded-lg p-1.5 pl-3 shadow-modal",
            "animate-in fade-in slide-in-from-top-4 duration-200 ease-out data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:slide-out-to-top-4 data-[state=closed]:fill-mode-forwards data-[state=closed]:ease-in motion-reduce:animate-none",
          )}>
          <span className="min-w-0 truncate text-sm font-medium">A new version of Orca is ready.</span>
          <Button variant="secondary" size="xs" disabled={leaving} onClick={() => { setLeaving(true); void applyUpdate(); }} className="text-card-foreground shrink-0">
            <RefreshCw aria-hidden="true" />Refresh
          </Button>
        </div>
      </div>
    </div>
  );
}

function forceUpdateBanner(): boolean {
  return typeof location !== "undefined" && new URLSearchParams(location.search).has("update-banner");
}

/** ONE bar while the bridge's database is unreachable (it keeps serving the cached config, this
 *  machine's worktrees and journaled turns, and retries by itself). Driven by the `x-orca-database`
 *  header on every answer (lib/refresh.ts), so it goes away on its own with the first answer after
 *  the database is back. Never a toast: a failing poll each tick would stack one per tick. */
export function DatabaseBanner({ now }: { now?: number }) {
  const since = useDatabaseDown();
  if (since === null) return null;
  return (
    <div role="status" data-slot="database-banner" className="bg-geist-warning-bg text-geist-warning-fg flex items-center justify-center gap-2 border-b px-4 py-2 text-sm">
      <DatabaseZap className="size-4 shrink-0" aria-hidden="true" />
      <span>{databaseBannerText(since, now ?? Date.now())}</span>
    </div>
  );
}

/** The page when the bridge can't be reached at all (the installed app opened offline from its cache). */
export function OfflineScreen() {
  return (
    <div role="alert" data-slot="offline-screen" className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 text-center">
      <WifiOff className="text-muted-foreground size-8" aria-hidden="true" />
      <h1 className="text-base font-semibold">Orca is offline</h1>
      <p className="text-muted-foreground max-w-sm text-sm">This device can't reach the Orca bridge. Check the network or the tailnet, then try again.</p>
      <button type="button" onClick={() => window.location.reload()} className="bg-primary text-primary-foreground inline-flex min-h-11 items-center gap-1.5 rounded-md px-4 text-sm font-medium">
        <RefreshCw className="size-4" aria-hidden="true" />Try again
      </button>
    </div>
  );
}
