// Is what's on screen current? Two answers, both in the top bar's reach. The stale indicator: the
// board's poll hasn't been answered for a while (a phone that slept, a dropped tailnet, a bridge
// restart) — said in words, not on hover. The refresh banner: the server now serves a newer build
// than the one this tab runs (a deploy happened) — one tap reloads.
import { useEffect, useState } from "react";
import { CloudOff, RefreshCw } from "lucide-react";
import { poll } from "@/lib/poll";
import { useLastSync } from "../store";
import { ago, newerBuild, staleAge } from "../workstream";

const RUNNING_BUILD = typeof __ORCA_BUILD__ === "undefined" ? undefined : __ORCA_BUILD__;

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
 *  is being served, shows a bar with Refresh. A dev server has no build id and never asks. */
export function UpdateBanner({ build = RUNNING_BUILD, every = 60_000 }: { build?: string; every?: number }) {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!build || build === "dev" || stale) return;
    return poll(() => fetch("/version.json", { cache: "no-store" }).then((r) => r.json()).then((v: unknown) => { if (newerBuild(build, v)) setStale(true); }), every);
  }, [build, stale, every]);
  if (!stale) return null;
  return (
    <div role="status" data-slot="update-banner" className="bg-geist-blue flex items-center justify-center gap-3 px-4 py-2 text-sm text-white">
      <span>A new version of Orca is available.</span>
      <button type="button" onClick={() => window.location.reload()} className="inline-flex min-h-8 items-center gap-1 rounded-md bg-white/15 px-2.5 font-medium hover:bg-white/25">
        <RefreshCw className="size-3.5" aria-hidden="true" />Refresh
      </button>
    </div>
  );
}
