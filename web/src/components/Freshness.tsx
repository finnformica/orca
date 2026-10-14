// Is what's on screen current? Two answers, both in the top bar's reach. The stale indicator: the
// board's poll hasn't been answered for a while (a phone that slept, a dropped tailnet, a bridge
// restart) — said in words, not on hover. The refresh banner: the server now serves a newer build
// than the one this tab runs (a deploy happened) — one tap hands over to the new build's service
// worker (lib/sw.ts applyUpdate) and reloads.
import { useEffect, useState } from "react";
import { CloudOff, RefreshCw, Server, WifiOff } from "lucide-react";
import { poll } from "@/lib/poll";
import { applyUpdate } from "@/lib/sw";
import { useBridge, useLastSync } from "../store";
import { ago, bridgeLabel, newerBuild, staleAge } from "../workstream";

const RUNNING_BUILD = typeof __ORCA_BUILD__ === "undefined" ? undefined : __ORCA_BUILD__;
const PREVIEW_PAGE = typeof __ORCA_PREVIEW__ === "undefined" ? false : __ORCA_PREVIEW__;

/** On a branch preview, which bridge answers its /api — the branch's own, or (warning) main's. */
export function BridgeLabel({ previewPage = PREVIEW_PAGE }: { previewPage?: boolean }) {
  const label = bridgeLabel(useBridge(), previewPage);
  if (!label) return null;
  return (
    <span role="status" data-slot="bridge-label" title={label.title} className={`${label.warn ? "bg-geist-warning-bg text-geist-warning-fg" : "bg-muted text-muted-foreground"} inline-flex h-6 shrink-0 items-center gap-1 truncate rounded-full px-2 text-xs font-medium`}>
      <Server className="size-3.5" aria-hidden="true" />{label.text}
    </span>
  );
}

export function StaleIndicator() {
  const last = useLastSync();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  const age = staleAge(last, Math.max(now, last));
  if (age === null) return null;
  return (
    <span role="status" data-slot="stale-indicator" className="bg-geist-warning-bg text-geist-warning-fg inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium">
      <CloudOff className="size-3.5" aria-hidden="true" />Updated {ago(last, now)}
    </span>
  );
}

/** Checks `/version.json` once a minute (paused while hidden, like every poll) and, when a newer build
 *  is being served, shows a bar with Refresh. A dev server has no build id and never asks. On a narrow
 *  layout it is the topmost element, so it (not the header below it) clears the status bar; `onStaleChange`
 *  lets the shell drop the header's own inset while the banner is shown, so the gap isn't reserved twice. */
export function UpdateBanner({ build = RUNNING_BUILD, every = 60_000, onStaleChange }: { build?: string; every?: number; onStaleChange?: (stale: boolean) => void }) {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!build || build === "dev" || stale) return;
    return poll(() => fetch("/version.json", { cache: "no-store" }).then((r) => r.json()).then((v: unknown) => { if (newerBuild(build, v)) setStale(true); }), every);
  }, [build, stale, every]);
  useEffect(() => { onStaleChange?.(stale); }, [stale, onStaleChange]);
  if (!stale) return null;
  return (
    <div role="status" data-slot="update-banner" className="bg-geist-blue flex items-center justify-center gap-3 px-4 py-2 text-sm text-white max-md:pt-[env(safe-area-inset-top)]">
      <span>A new version of Orca is available.</span>
      <button type="button" onClick={() => void applyUpdate()} className="inline-flex min-h-8 items-center gap-1 rounded-md bg-white/15 px-2.5 font-medium hover:bg-white/25">
        <RefreshCw className="size-3.5" aria-hidden="true" />Refresh
      </button>
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
