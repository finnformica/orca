import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Check, ChevronDown, Copy, ExternalLink, FlaskConical, Loader2, Square, TriangleAlert } from "lucide-react";
import { api, type PreviewSvc } from "../api";
import { baseBranch, instanceChoices, previewKeyOf, previewsEnabled, previewStatus, startMaster, stopMaster, stopPreview, testLocally, thisInstance, useMaster, useMasters, useRepos, useWorkstreams, type Row } from "../store";
import { previewHref, previewLabel } from "../workstream";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusDot } from "@/components/console";
import { poll } from "@/lib/poll";
import { sharedSource } from "@/lib/vitals";

// Shared preview lifecycle: start in the background, poll status, expose ready/failed/link. Driven
// by a preview `key` (the worktree path) and a `starter` that spins it up — so the same hook powers
// a branch preview (key known up front) and the "test master" preview (key learned on start).
/** The URL this page opens for a service — see `previewHref`. */
const hrefOf = (svc: PreviewSvc): string => previewHref(svc, window.location.hostname);

function usePreview(initialKey: string | undefined, starter: () => Promise<{ key: string; svcs: PreviewSvc[] }>) {
  const [key, setKey] = useState(initialKey);
  const [svcs, setSvcs] = useState<PreviewSvc[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once a service has crashed we reap the whole group and stop polling until the next start —
  // the ref dedupes the auto-reap and freezes the poll so a stale in-flight response can't revive it.
  const reaping = useRef(false);

  // Adopt the caller's key when it lands (e.g. a row gains a worktree after adoption).
  useEffect(() => { if (initialKey) setKey(initialKey); }, [initialKey]);

  useEffect(() => {
    if (!key) { setSvcs([]); return; }
    let cancelled = false;
    const tick = () => { if (reaping.current) return; return previewStatus(key).then((s) => !cancelled && setSvcs(s)).catch(() => {}); };
    const stop = poll(tick, 2500); // reflects "starting → ready" without a manual refresh
    return () => { cancelled = true; stop(); };
  }, [key]);

  const open = svcs.find((s) => s.open) ?? svcs[0];
  const crashed = svcs.find((s) => !s.running);
  const ready = svcs.length > 0 && svcs.every((s) => s.ready); // whole stack up (frontend AND backend)
  const starting = svcs.length > 0 && !ready && !crashed;
  const failed = Boolean(error) && svcs.length === 0; // a crash/start error was captured and reaped

  // Auto-reap on crash: a failed service leaves its siblings running + ports held, so the user would
  // otherwise have to hit Stop. Capture the service's log for the debug panel, drop back to the idle
  // "Retry" state immediately (no lingering Stop button), and reap procs/ports in the background.
  useEffect(() => {
    if (!crashed || !key || reaping.current) return;
    reaping.current = true;
    setError(crashed.error ?? "a service failed to start");
    setSvcs([]);
    void stopPreview(key).catch(() => {});
  }, [crashed, key]);

  const start = async (run: () => Promise<{ key: string; svcs: PreviewSvc[] }> = starter) => {
    setBusy(true); setError(null); reaping.current = false; // fresh run: re-enable polling, clear the last error
    try { const r = await run(); setKey(r.key); setSvcs(r.svcs); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } // don't revert silently
    finally { setBusy(false); }
  };
  const stop = async () => {
    if (!key) return;
    setBusy(true); reaping.current = true; // stop polling; nothing left to reflect
    try { await stopPreview(key); setSvcs([]); } finally { setBusy(false); }
  };

  // Tick once a second while starting so the elapsed timer updates (shows if a boot is hanging).
  const [, tick] = useState(0);
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [starting]);
  const startedAt = svcs.reduce((min, s) => Math.min(min, s.startedAt || Infinity), Infinity);
  const elapsed = starting && Number.isFinite(startedAt) ? Math.floor((Date.now() - startedAt) / 1000) : 0;

  return { svcs, busy, open, ready, failed, starting, elapsed, error, active: svcs.length > 0, start, stop };
}

// Collapsed-by-default log of a failed preview — the captured tail of the crashed service's output,
// so the reason (missing module, port in use, Postgres down…) is one click away without leaving Orca.
// A copy button (top-right) grabs the whole log for pasting into an agent / issue.
function ErrorLog({ error }: { error: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(error); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard unavailable */ }
  };
  return (
    <details className="text-xs">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer select-none">Preview failed — show log</summary>
      <div className="relative mt-1">
        <button onClick={copy} title="Copy log" className="text-muted-foreground hover:text-foreground bg-muted/80 absolute top-1 right-1 rounded p-1 backdrop-blur">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
        <pre className="bg-muted max-h-48 overflow-auto rounded-md p-2 pr-8 whitespace-pre-wrap">{error}</pre>
      </div>
    </details>
  );
}

/** "Test locally" action for the card footer: Test → Starting Ns → Open local (+Stop). `compact`
 *  renders it as an icon button (dense view) instead of a full-width labelled one. */
export function PreviewControl({ row, compact = false }: { row: Row; compact?: boolean }) {
  // Where to run it: the session's own instance unless you pick another (only offered with >1).
  const [where, setWhere] = useState<string | undefined>(undefined);
  const choices = instanceChoices();
  // Keyed by the server-recorded placement when there is one, so a preview starting on another
  // instance shows as Starting/Open the moment the page loads, not after a click.
  const { svcs, busy, active, error, start, stop } = usePreview(previewKeyOf(row), () => testLocally(row, where));
  const startOn = (instance: string) => { setWhere(instance); return testLocally(row, instance); };
  // The picker is joined to the Test button as one split control (same radius trim as Open·Stop).
  const split = choices.length > 1 ? "rounded-r-none" : "";
  const placeMenu = choices.length > 1 && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant={compact ? "ghost" : "outline"} className={`rounded-l-none border-l-0 ${compact ? "size-7" : "h-8 w-8"}`} title="Choose where the preview runs" aria-label="Test on…"><ChevronDown className="size-3.5" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {choices.map((i) => <DropdownMenuItem key={i} onSelect={() => void start(() => startOn(i))}>Test on {i}{i === thisInstance() ? " (here)" : ""}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Idle (incl. after a failure — the crashed preview auto-stops, so there's no Stop button here,
  // just Retry + the expandable log). Compact drops the label + log to a single icon (flip back to
  // comfortable to read the failure log).
  if (!active && !busy) {
    if (compact) {
      return (
        <span className="inline-flex">
          <Button size="icon" variant="ghost" className={`size-7 ${split}`} onClick={() => void start()} title={error ? "Preview failed — retry" : `Test on ${where ?? row.instance ?? thisInstance() ?? "local"}`} aria-label="Test locally">
            {error ? <TriangleAlert className="text-destructive size-3.5" /> : <FlaskConical className="size-3.5" />}
          </Button>
          {placeMenu}
        </span>
      );
    }
    return (
      <div className="w-full space-y-1">
        <div className="flex w-full">
          <Button size="sm" variant="outline" className={`flex-1 justify-center ${split}`} onClick={() => void start()} title={error ? "Preview failed — expand the log below" : `Spin up a preview of this branch on ${where ?? row.instance ?? thisInstance() ?? "this machine"}`}>
            {error ? <TriangleAlert className="text-destructive size-3.5" /> : <FlaskConical className="size-3.5" />}
            {error ? "Retry test" : choices.length > 1 ? `Test on ${where ?? row.instance ?? thisInstance()}` : "Test locally"}
          </Button>
          {placeMenu}
        </div>
        {error && <ErrorLog error={error} />}
      </div>
    );
  }
  // Running/starting: the state button + Stop read as one connected control.
  return <PreviewLiveControl svcs={svcs} busy={busy} onStop={() => void stop()} openLabel="Open preview" startingLabel="Starting…" compact={compact} />;
}

/** The Agents-list row's dedicated preview cell: a status dot + link once the preview is reachable,
 *  an "Add preview" button when there isn't one yet, a spinner while it boots — the same fixed
 *  size-7 slot throughout, so switching between states never shifts the Actions column. Disabled
 *  (with a tooltip) when the repo hasn't opted into RepoFeatures.previews; the bridge still enforces
 *  this, the check here only saves a round trip to a button that would just 404. Starts the preview
 *  the same way the card's own "Test locally" control does (store.testLocally). */
export function PreviewCell({ row }: { row: Row }) {
  const enabled = previewsEnabled(row.repo);
  const { busy, active, ready, failed, error, open, start } = usePreview(previewKeyOf(row), () => testLocally(row));
  const state: "disabled" | "none" | "starting" | "ready" | "failed" =
    !enabled ? "disabled" : failed ? "failed" : active && ready && open ? "ready" : busy || active ? "starting" : "none";

  const slot = "relative inline-flex size-7 shrink-0 items-center justify-center";
  if (state === "ready") {
    return (
      <span className={slot} data-slot="preview-cell" data-state={state}>
        <a href={hrefOf(open!)} target="_blank" rel="noreferrer" aria-label="Open preview" title={`Open preview on :${open!.port}`}
          className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-7 items-center justify-center rounded-md">
          <ExternalLink className="size-3.5" />
        </a>
        <StatusDot tone="ready" title="Running" className="absolute -top-0.5 -right-0.5" />
      </span>
    );
  }
  const icon = state === "failed" ? <TriangleAlert className="text-destructive size-3.5" />
    : state === "starting" ? <Loader2 className="size-3.5 animate-spin" />
    : <FlaskConical className={state === "disabled" ? "text-muted-foreground size-3.5" : "size-3.5"} />;
  const label = state === "failed" ? "Retry preview" : state === "starting" ? "Preview starting" : "Add preview";
  const title = state === "disabled" ? `Previews aren't enabled for ${row.repo}`
    : state === "failed" ? (error ? `Preview failed — ${error}` : "Preview failed — retry")
    : state === "starting" ? "Starting preview…" : "Add preview";
  return (
    <span className={slot} data-slot="preview-cell" data-state={state}>
      <Button size="icon" variant="ghost" className="size-7" disabled={state === "disabled" || state === "starting"}
        onClick={() => void start()} title={title} aria-label={label}>
        {icon}
      </Button>
      {(state === "starting" || state === "failed") && (
        <StatusDot tone={state === "failed" ? "error" : "building"} title={state === "failed" ? "Failed" : "Starting…"} className="absolute -top-0.5 -right-0.5" />
      )}
    </span>
  );
}

// The failed-preview log affordance, styled exactly like the card's ErrorLog trigger ("Preview
// failed — show log"). The menu is tight, so — unlike the card's inline <details> expand — the log
// opens in a popover floating above the row. Copy button included.
function LogPopover({ error }: { error: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(error); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard unavailable */ }
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="text-muted-foreground hover:text-foreground cursor-pointer text-xs select-none">Preview failed — show log</button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 text-xs">
        <div className="relative">
          <button onClick={() => void copy()} title="Copy log" className="text-muted-foreground hover:text-foreground bg-muted/80 absolute top-1 right-1 rounded p-1 backdrop-blur">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
          <pre className="bg-muted max-h-48 overflow-auto rounded-md p-2 pr-8 whitespace-pre-wrap">{error}</pre>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Live "Ns" counter while a preview boots (shows if it's hanging). Kept local to the row since it's
// pure display; the preview state itself lives in the store so it survives the popover closing.
function useElapsed(active: boolean, svcs: PreviewSvc[]): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  const startedAt = svcs.reduce((min, s) => Math.min(min, s.startedAt || Infinity), Infinity);
  return active && Number.isFinite(startedAt) ? Math.floor((Date.now() - startedAt) / 1000) : 0;
}

/** Running/starting state of a live preview: an Open button once the whole stack is up (else a
 *  "Starting Ns" placeholder), joined to a Stop button so the pair reads as one connected control.
 *  Shared by the card's Test-locally control, the Test-master rows, and the running-previews menu. */
function PreviewLiveControl({ svcs, busy, onStop, openLabel, startingLabel, compact = false }: {
  svcs: PreviewSvc[]; busy: boolean; onStop: () => void; openLabel: string; startingLabel: string; compact?: boolean;
}) {
  const open = svcs.find((s) => s.open) ?? svcs[0];
  const ready = svcs.length > 0 && svcs.every((s) => s.ready); // whole stack up (frontend AND backend)
  const elapsed = useElapsed(!ready, svcs);
  // Compact (dense) drops the labels to icons and squares the buttons; otherwise it's a full-width
  // labelled pair. Both keep the Open/Stop connected-control look (shared radius trim).
  const size = compact ? "icon" : "sm";
  const stateClass = compact ? "size-7 rounded-r-none" : "flex-1 justify-center rounded-r-none";
  return (
    <div className={`inline-flex ${compact ? "" : "w-full"}`}>
      {ready && open ? (
        <Button size={size} variant={compact ? "ghost" : "outline"} className={stateClass} onClick={() => window.open(hrefOf(open), "_blank", "noreferrer")} title={`Open preview on :${open.port}`} aria-label={openLabel}>
          <ExternalLink className="size-3.5" /> {!compact && openLabel}
        </Button>
      ) : (
        <Button size={size} variant={compact ? "ghost" : "outline"} className={stateClass} disabled title={compact ? `${startingLabel} ${elapsed > 0 ? `${elapsed}s` : ""}`.trim() : undefined} aria-label={startingLabel}>
          <Loader2 className="size-3.5 animate-spin" /> {!compact && <>{startingLabel} {elapsed > 0 ? `${elapsed}s` : ""}</>}
        </Button>
      )}
      <Button size={size} variant={compact ? "ghost" : "outline"} className={`rounded-l-none border-l-0 ${compact ? "size-7" : ""}`} disabled={busy} onClick={onStop} title="Stop preview" aria-label="Stop preview"><Square className="size-3.5 fill-current" /></Button>
    </div>
  );
}

/** One repo's row in the Test-master menu: its base branch + a Test/Starting/Open·Stop control
 *  (and, on failure, Retry + a Log popover). Reads the shared store lifecycle (see store.startMaster),
 *  so closing the popover mid-spin-up doesn't kill or forget the preview. */
export function TestMasterRow({ repo }: { repo: string }) {
  const base = baseBranch(repo);
  const { svcs, busy, error } = useMaster(repo);
  const active = busy || svcs.length > 0;
  const start = () => void startMaster(repo);
  const stop = () => void stopMaster(repo);

  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-xs font-medium">{repo}</div>
      {!active ? (
        <div className="w-full space-y-1">
          <Button size="sm" variant="outline" className="w-full justify-center" onClick={start} title={error ? "Preview failed — open the log" : `Spin up a preview of the latest ${base}`}>
            {error ? <TriangleAlert className="text-destructive size-3.5" /> : <FlaskConical className="size-3.5" />}
            {error ? `Retry ${base}` : `Test ${base}`}
          </Button>
          {error && <LogPopover error={error} />}
        </div>
      ) : (
        <PreviewLiveControl svcs={svcs} busy={busy} onStop={stop} openLabel={`Open ${base}`} startingLabel="Starting…" />
      )}
    </div>
  );
}

/** Every live preview across instances (`/api/previews`), polled every 2.5s while anything shows it
 *  — the sidebar's Previews badge and the Previews page share ONE loop, so they can't disagree.
 *  `unavailable`: the endpoint isn't there (Orca previewing itself through a Vite proxy whose bridge
 *  predates the route) — said so, rather than a false "nothing running". */
type PreviewList = { previews: { key: string; instance?: string; svcs: PreviewSvc[] }[]; unavailable: boolean };
let reloadPreviews: (() => void) | null = null; // set while the loop runs: re-read now (after a stop)
const previewSource = sharedSource<PreviewList>((set) => {
  let live = true;
  const load = () => api.previews().then(
    (previews) => { if (live) set({ previews, unavailable: false }); },
    () => { if (live) set({ previews: [], unavailable: true }); },
  );
  reloadPreviews = () => void load();
  const stop = poll(load, 2500);
  return () => { live = false; reloadPreviews = null; stop(); };
});
const NO_PREVIEWS: PreviewList = { previews: [], unavailable: false };
export const usePreviewList = (): PreviewList => useSyncExternalStore(previewSource.subscribe, previewSource.get) ?? NO_PREVIEWS;

/** The Previews nav item's badges — what the two header buttons used to carry: a spinner while a
 *  base-branch preview boots, a dot once one is live, and the count of running previews. */
export function PreviewsBadge({ compact = false }: { compact?: boolean }) {
  const masters = useMasters();
  const { previews, unavailable } = usePreviewList();
  const loading = masters.some((m) => m.busy || (m.svcs.length > 0 && !m.svcs.every((s) => s.ready)));
  const active = masters.some((m) => m.svcs.some((s) => s.running));
  const running = previews.filter((p) => p.svcs.some((s) => s.running)).length;
  return (
    <span data-slot="previews-badge" className={compact ? "absolute -top-0.5 -right-0.5 flex items-center" : "ml-auto flex items-center gap-1.5"}>
      {loading ? <Loader2 className="size-3 animate-spin" aria-label="a base preview is starting" />
        : active && <span className="bg-geist-blue size-1.5 rounded-full" aria-label="a base preview is running" />}
      {!unavailable && running > 0 && (
        <span className="bg-foreground text-background flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums" aria-label={`${running} running previews`}>
          {running}
        </span>
      )}
    </span>
  );
}

/** The Previews page's list: every live preview, labelled with its session title, with Open / Stop. */
export function RunningPreviews() {
  const { previews, unavailable } = usePreviewList();
  const rows = useWorkstreams();
  // Previews are keyed by worktree path; match that to a row for the session title (fall back to the
  // last path segment for adopted/base worktrees with no card).
  const titleOf = (key: string) => rows.find((r) => previewKeyOf(r) === key || r.worktreePath === key)?.title ?? key.split("/").pop() ?? key;
  const running = previews.filter((p) => p.svcs.some((s) => s.running));
  if (unavailable) return <p className="text-muted-foreground px-4 py-6 text-sm">Previews API unavailable — run the bridge on this branch.</p>;
  if (!running.length) return <p className="text-muted-foreground px-4 py-6 text-sm">No previews running.</p>;
  return (
    <ul className="divide-y">
      {running.map((p) => (
        <li key={p.key} data-slot="running-preview" className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" title={titleOf(p.key)}>{titleOf(p.key)}</div>
            <div className="text-muted-foreground truncate text-xs">
              {p.instance ? `${p.instance} · ` : ""}{p.svcs.map((s) => `${s.name} ${previewLabel(hrefOf(s))}`).join(" · ")}
            </div>
          </div>
          <div className="w-56 max-md:w-full"><PreviewLiveControl svcs={p.svcs} busy={false} onStop={() => void stopPreview(p.key, p.instance).catch(() => {}).then(() => reloadPreviews?.())} openLabel="Open" startingLabel="Starting…" /></div>
        </li>
      ))}
    </ul>
  );
}

/** The Previews page's Test master list: one row per repo, each able to preview that repo's base
 *  branch — to check whether a bug reproduces on a clean main, without a feature branch in the way. */
export function TestMaster() {
  const repos = useRepos();
  return (
    <ul className="divide-y">
      {repos.map((r) => (
        <li key={r.name} className="px-4 py-3"><div className="max-w-xs"><TestMasterRow repo={r.name} /></div></li>
      ))}
    </ul>
  );
}

/** Full panel for the detail Preview tab: embeds the running frontend once it's ready. */
export function PreviewPanel({ row }: { row: Row }) {
  const { open, active, ready, failed, busy, error, start, stop } = usePreview(previewKeyOf(row), () => testLocally(row));

  return (
    <div className="space-y-2 pt-3">
      <div className="flex items-center gap-2">
        {!active && <Button size="sm" disabled={busy} onClick={() => void start()}>{busy ? "Starting…" : failed ? "Retry preview" : "Start preview"}</Button>}
        {active && <Button size="sm" variant="outline" disabled={busy} onClick={() => void stop()}>Stop preview</Button>}
        {active && !ready && <span className="text-muted-foreground text-sm">starting the frontend + backend… (~10s)</span>}
        {failed && <span className="text-destructive text-sm">a service failed to start — expand the log for details</span>}
        {ready && open && <a className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline" href={hrefOf(open)} target="_blank" rel="noreferrer">open {previewLabel(hrefOf(open))} <ExternalLink className="size-3.5" /></a>}
      </div>
      {error && <ErrorLog error={error} />}
      {ready && open && <iframe title="preview" src={hrefOf(open)} className="h-[70vh] w-full rounded-md border" />}
    </div>
  );
}
