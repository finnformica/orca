import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { createPortal } from "react-dom";
import { ArrowLeft, Bot, PictureInPicture2, PanelBottomClose, X } from "lucide-react";
import { subscribeTurns, syncEvents } from "@/lib/events";
import { ChatPanel } from "@/views/Chat";
import type { ChatControlsProps, CompactControl } from "@/components/ChatControls";
import { api } from "../api";
import { useWorkstreams, type Row } from "../store";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, PANEL_MIN_W, clampPanelWidth, orchestratorStatus } from "../workstream";
import { PipContext, PortalContainer, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Shortcut } from "@/components/ui/kbd";
import { poll } from "@/lib/poll";
import { type OrchestratorPrefill, orchestratorActivityAtom, orchestratorOpenAtom, orchestratorPrefillAtom, orchestratorWidthAtom } from "@/lib/atoms";
import { shortcutLabel } from "@/lib/shortcuts";
import { useNarrow } from "@/lib/viewport";
import { openOrchestrator } from "@/lib/orchestratorOpen";
import { sendToOrchestrator } from "@/lib/orchestratorOutbox";
import { useSwipeToClose } from "@/lib/gestures";
import { useRoute } from "@/lib/route";

// The card's terminal: a modal you open in place (no navigating to the detail page) showing the
// branch's conversation — the same ChatPanel as the Agent page and the orchestrator — with the follow-up
// composer to send the next message. It is NOT a live shell; it renders GET /api/turns, so nothing
// tmux is involved. The native <dialog> gives the backdrop, ESC-close and focus trap for free, and
// ChatPanel mounts ONLY while open so its poll/composer aren't running behind a closed dialog.
export function TerminalDialog({ row, open, onClose }: { row: Row; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const swipe = useSwipeToClose(() => ref.current, onClose, useNarrow()); // a phone's sheet: swipe its header down
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }} // click the backdrop → close
      // No `display` utility (flex/grid/…) on the <dialog> itself: an author display rule beats the
      // UA `dialog:not([open]) { display: none }` (UA origin loses to author regardless of
      // specificity), so a closed dialog would render inline in the swimlane. Layout goes on the
      // inner wrapper instead; the dialog stays hidden until showModal().
      // On a phone it is a full-screen sheet sized to the visible viewport, so the composer at its foot
      // stays above the on-screen keyboard (styles.css `sheet`).
      className="bg-card text-foreground m-auto h-[80vh] w-[90vw] max-w-4xl rounded-lg border p-0 shadow-modal backdrop:bg-black/50 max-md:sheet"
    >
      <div className="flex h-full flex-col">
        <div {...swipe} className="flex items-center justify-between gap-2 border-b px-3 py-2 max-md:touch-none">
          <div className="truncate text-sm font-medium">Terminal · {row.title}</div>
          <Button size="icon" variant="ghost" className="size-7 shrink-0 max-md:size-11" title="Close" aria-label="Close terminal" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1">{open && <ChatPanel row={row} />}</div>
      </div>
    </dialog>
  );
}

// The orchestrator: the one conversation you talk to, which starts and steers workstreams itself.
// It opens as a RIGHT-HAND SIDE PANEL that slides over the page — an overlay, so nothing reflows and
// the board it is moving stays visible and usable (not a modal: no backdrop, clicks outside still
// land). This is the shape Cursor, Copilot, Linear and Vercel's v0 give their assistant: a rail you
// can keep open while you work, resizable from its inner edge, dismissed with Esc or its ✕. The chat
// inside is the same ChatPanel a card's terminal uses (its turns are recorded like any other
// conversation, under a reserved repo/branch), in its "chat" styling, with the composer pointed at
// the orchestrator's own route. Polled only while open: whether it is running drives Stop and the
// composer's placeholder. What opens it is `orchestratorOpenAtom`: the top bar's button, the O key,
// the palette, the quick-ask box's "Open chat" and a failed action's "Ask the orchestrator".
// (History: it was a draggable, resizable corner window first — one more thing to place and keep
// out of the way — and before that a modal.)

export { newAskSession } from "@/lib/orchestratorOpen";
/** Open the orchestrator and focus its composer, with `text` after its draft. On a narrow screen
 *  (phones) this NAVIGATES to its routed page (`/orchestrator`) instead of opening the side panel —
 *  an overlay sheet scrolled the page behind it rather than the chat, so the page is now a real route
 *  with its own scroll container. Every entry point (the bottom bar, the O key, the palette, a
 *  notification's Open, quick-ask's Open) goes through `openOrchestrator` (lib/orchestratorOpen), so
 *  they all redirect, focus and catch early keystrokes the same way; desktop is untouched. */
export function useOrchestrator() {
  const [open, setOpen] = useAtom(orchestratorOpenAtom);
  return { open, ask: openOrchestrator, close: () => setOpen(false) };
}

/** The orchestrator's activity for the launchers' indicator: running, and whether a wake finished
 *  while it wasn't being looked at. ONE subscriber (the Shell) keeps the atom current — a status read
 *  on mount, then one per `turn` event on the tab's shared live stream (a run started or finished), so
 *  it costs no poll of its own on every page. "Being looked at" is the side panel open (desktop) OR
 *  the routed page (narrow) — either clears `unread`. */
export function useOrchestratorActivity(): { running: boolean; unread: boolean } {
  const [activity, setActivity] = useAtom(orchestratorActivityAtom);
  const open = useAtomValue(orchestratorOpenAtom);
  const route = useRoute();
  const viewing = open || route.name === "orchestrator";
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  useEffect(() => {
    let live = true;
    const read = (finished: boolean) => api.orchestrator().then((s) => {
      if (!live) return;
      setActivity((a) => ({ running: s.running, unread: a.unread || (finished && !s.running && !viewingRef.current) }));
    }).catch(() => {});
    void read(false);
    const unsubscribe = subscribeTurns(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { turn: () => void read(true), step: () => {}, resync: () => void read(false) });
    return () => { live = false; unsubscribe(); };
  }, []);
  useEffect(() => { if (viewing) setActivity((a) => (a.unread ? { ...a, unread: false } : a)); }, [viewing]);
  return activity;
}

/** The pulsing / lit dot the launchers carry: pulsing while a wake runs, solid once one finished
 *  unseen, absent otherwise. */
export function ActivityDot({ activity, className }: { activity: { running: boolean; unread: boolean }; className?: string }) {
  if (!activity.running && !activity.unread) return null;
  return (
    <span data-slot="orchestrator-activity" data-state={activity.running ? "running" : "unread"} aria-hidden="true"
      className={cn("bg-geist-blue inline-block size-2 rounded-full", activity.running && "animate-pulse", className)} />
  );
}

/** Vercel's top-right "Ask AI", as a BUTTON: it opens the side panel with the composer focused. (It was
 *  a text box whose keystrokes carried into the composer; a box in the chrome that isn't where the
 *  text ends up is one more thing to learn, and the quick-ask pill now covers "fire off a line".) */
export function AskOrchestrator() {
  const { ask } = useOrchestrator();
  const activity = useAtomValue(orchestratorActivityAtom);
  const key = shortcutLabel("orchestrator");
  return (
    <button type="button" data-slot="ask-orchestrator" onClick={() => ask()} aria-label="Ask the orchestrator"
      title={`Ask the orchestrator (${key}): it starts and steers workstreams for you`}
      // The header's usage meter (Shell.tsx) sits right before this and carries the ml-auto that
      // pushes the pair to the right — two auto margins here would split the free space BETWEEN
      // them instead of putting it before the pair.
      // Below md the bottom bar's Orchestrator button takes its place.
      className="bg-card hover:bg-accent/60 text-foreground flex h-8 shrink-0 items-center gap-2 rounded-md border px-2.5 text-sm max-md:hidden">
      <span className="relative inline-flex"><Bot className="text-muted-foreground size-3.5 shrink-0" /><ActivityDot activity={activity} className="absolute -top-1 -right-1 size-1.5" /></span>
      <span className="text-muted-foreground">Ask the orchestrator</span>
      <Shortcut id="orchestrator" />
    </button>
  );
}

/** The orchestrator's model until its status read answers (server/orchestrator.ts's default). */
const ORCHESTRATOR_DEFAULT_MODEL = "claude-opus-5-5";

/** How long the slide takes (ms); the panel is hidden from assistive tech once it has slid out. */
const SLIDE_MS = 200;

/** The header's live line under "Orchestrator", the same in the panel and the page: Idle, or Working
 *  with the wake's elapsed time, plus what's queued for it and how many of its workers are running
 *  (the board's own rows — orchestrated and running — so no endpoint of its own). The last wake's
 *  cost and the large-session advice are its tooltip; a large session shows only an amber dot. */
function OrchestratorStatusLine({ state }: { state: { running: boolean; startedAt?: number; queued?: number; lastWakeUsd?: number; hint?: string } | null }) {
  const workers = useWorkstreams().filter((r) => r.orchestrated && r.agentStatus === "running").length;
  // Ticks once a second while a wake runs, so the elapsed time counts up between polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state?.running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state?.running]);
  if (!state) return null;
  const line = orchestratorStatus({ ...state, workers, now });
  return (
    <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[11px]" title={line.tooltip} data-slot="orchestrator-status">
      {line.warn && <span data-slot="orchestrator-status-warn" aria-label="Large session" className="bg-geist-amber size-1.5 shrink-0 rounded-full" />}
      <span className="truncate">{line.text}</span>
    </div>
  );
}

/** The orchestrator's status, polled every 2s while `active` (on `win`'s timers), and the composer
 *  toolbar's values built from it — ONE source for every box that talks to it (the side panel, the
 *  routed page, the quick-ask box), so a model change or a context reading is the same in each.
 *  `compact` is for a box with no turn stream of its own (quick ask): pending from the request until
 *  the status shows the orchestrator idle again. The chat panel tracks its own, by the turn. */
export type OrchestratorState = { key: string; running: boolean; paused: boolean; model: string; contextPct?: number; lastWakeUsd?: number; hint?: string; startedAt?: number; queued?: number };
export function useOrchestratorState(active: boolean, win: Window = window) {
  const [state, setState] = useState<OrchestratorState | null>(null);
  const load = () => api.orchestrator().then(setState).catch(() => {});
  useEffect(() => {
    if (!active) return;
    return poll(load, 2000, win);
  }, [active, win]);
  const controls: ChatControlsProps = {
    model: state?.model ?? ORCHESTRATOR_DEFAULT_MODEL, only: "claude", contextPct: state?.contextPct,
    onModel: (model) => { setState((s) => (s ? { ...s, model } : s)); void api.orchestratorModel(model).then(load); },
  };
  const [compacting, setCompacting] = useState<"sent" | "started" | null>(null);
  const [compactError, setCompactError] = useState<string>();
  useEffect(() => { if (compacting === "started" && state && !state.running) setCompacting(null); }, [compacting, state]);
  const compact: CompactControl | undefined = state?.contextPct === undefined && compacting === null ? undefined : {
    pending: compacting !== null, busy: !!state?.running, error: compactError,
    onCompact: async () => {
      setCompactError(undefined);
      setCompacting("sent");
      try { await api.compact(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH); setCompacting("started"); await load(); }
      catch (e) { setCompacting(null); setCompactError(e instanceof Error ? e.message : String(e)); }
    },
  };
  return { state, load, controls, compact };
}

export function OrchestratorPanel() {
  const [open, setOpen] = useAtom(orchestratorOpenAtom);
  // Never opened while narrow — useOrchestrator routes a phone to /orchestrator instead (see
  // OrchestratorPage) — but `narrow` still hides Pop out if a desktop window is resized down below
  // 768px with the panel already open.
  const narrow = useNarrow();
  const prefill = useAtomValue(orchestratorPrefillAtom);
  const setPrefill = useSetAtom(orchestratorPrefillAtom);
  // Once opened, the chat stays MOUNTED while closed (slid out, hidden): reopening is instant, with
  // the transcript, scroll position and draft exactly where you left them — the way an editor's
  // assistant rail behaves — instead of refetching and re-rendering the conversation every time.
  // Set DURING render, not in an effect: the panel and its composer must mount in the commit that
  // opens it, so the composer's layout effect can focus it before the first keystroke.
  const [mounted, setMounted] = useState(false);
  if (open && !mounted) setMounted(true);
  // Popped out: the chat lives in an always-on-top Document Picture-in-Picture window (Chrome/Edge
  // 116+), rendered there by a PORTAL — the same React tree, so its state, composer draft, SSE and
  // popovers carry over rather than being copied. Browsers without the API get no Pop out button.
  // Kept from the window days because it costs one button: the portal is what makes it work.
  const [pip, setPip] = useState<Window | null>(null);
  // The poll runs on the PiP window's timers while popped out: that window is the visible one, and
  // a hidden tab's timers get throttled (to once a minute after a while).
  const { state, load, controls } = useOrchestratorState(open, pip ?? window);
  // Closing drops the pending ask, so a later open can't re-apply it to a freshly mounted composer.
  useEffect(() => { if (!open) { pip?.close(); setPrefill(null); } }, [open]);
  // An ask while popped out lands in the PiP window's composer; bring that window forward.
  useEffect(() => { if (prefill) pip?.focus(); }, [prefill?.seq]);
  // Focus: the composer takes it on open (ChatComposer's prefill layout effect); on close it goes back
  // to where it was — the button or key that opened the panel — so a keyboard user isn't dropped on
  // <body>. The opener is read DURING the render that opens it: the composer focuses itself in a
  // layout effect, which runs before any effect of this parent's.
  const opener = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) opener.current = document.activeElement;
  wasOpen.current = open;
  useLayoutEffect(() => {
    if (open) return;
    const el = opener.current as HTMLElement | null;
    opener.current = null;
    if (el && document.contains(el) && typeof el.focus === "function") el.focus();
  }, [open]);
  useEffect(() => {
    if (!pip) return;
    // The page's theme is a class on <html> (lib/theme.ts): mirror <html>'s class and inline style
    // (CSS variables), so a theme toggle in the tab reaches the PiP too.
    const sync = () => {
      const from = document.documentElement, to = pip.document.documentElement;
      to.className = from.className;
      to.style.cssText = from.style.cssText;
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true });
    return () => { observer.disconnect(); pip.close(); };
  }, [pip]);
  const popOut = async () => {
    const w = await pipApi()!.requestWindow(loadPipSize(width)).catch(() => null);
    if (!w) return;
    copyStyles(document, w.document);
    // Closing it (its own ✕, Return to tab, or closing the chat) brings the chat back into the tab.
    // The tab may be hidden by now, so the shared live stream re-checks whether it is still wanted.
    w.addEventListener("pagehide", () => { savePipSize(w); setPip(null); setTimeout(syncEvents); }, { once: true });
    setPip(w);
  };
  const row: Row = {
    repo: ORCHESTRATOR_REPO, hasRemote: false, branch: ORCHESTRATOR_BRANCH, title: "Orchestrator", prompt: "", lane: "LOCAL",
    worktreePath: state?.key, agentStatus: state?.running ? "running" : "idle",
  };
  // Width: dragged from the panel's left edge, remembered per browser (lib/persisted), clamped to the
  // viewport on load and on browser resize. During a drag the element's style is written DIRECTLY —
  // a React state update per pointer move re-rendered the whole chat and lagged; state (and storage)
  // is updated once, when the pointer lets go.
  const [savedWidth, setSavedWidth] = useAtom(orchestratorWidthAtom);
  const [vw, setVw] = useState(() => window.innerWidth);
  useEffect(() => {
    const fit = () => setVw(window.innerWidth);
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  const width = clampPanelWidth(savedWidth, vw);
  const panelRef = useRef<HTMLDivElement>(null);
  const onResizeStart = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const el = panelRef.current;
    if (!el) return;
    const x0 = e.clientX, w0 = width;
    let last = w0;
    const move = (ev: PointerEvent) => {
      last = clampPanelWidth(w0 + (x0 - ev.clientX), window.innerWidth); // the edge is on the LEFT: dragging left widens
      el.style.width = `${last}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      setSavedWidth(last);
    };
    document.body.style.cursor = "ew-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };
  const header = (
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3 select-none" data-slot="orchestrator-handle">
      <div className="flex min-w-0 items-center gap-2">
        <span className="bg-accent text-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-full"><Bot className="size-3.5" /></span>
        <div className="min-w-0">
          {/* Paused = it has woken itself as many times as it may without hearing from you. */}
          <div className="truncate text-sm font-medium" id="orchestrator-title">{state?.paused ? "Orchestrator · paused until you reply" : "Orchestrator"}</div>
          <OrchestratorStatusLine state={state} />
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        {pip ? (
          <Button size="icon" variant="ghost" className="size-7" title="Return to tab" aria-label="Return to tab" onClick={() => pip.close()}>
            <PanelBottomClose className="size-4" />
          </Button>
        ) : pipApi() && !narrow && (
          <Button size="icon" variant="ghost" className="size-7" title="Pop out: keep it on top of every window" aria-label="Pop out" onClick={() => void popOut()}>
            <PictureInPicture2 className="size-4" />
          </Button>
        )}
        <Button size="icon" variant="ghost" className="size-7 max-md:size-11" title={`Close (${shortcutLabel("escape")})`} aria-label="Close orchestrator" onClick={() => setOpen(false)}>
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
  // The conversation fills the panel edge to edge, in the chat styling that follows the page's theme.
  const chat = (
    <div className="min-h-0 flex-1">
      {/* Mounted at once, not after the status read: the composer must exist to take focus in the
          same commit that opens the panel, or the first keystrokes go nowhere. */}
      <OrchestratorChat row={row} prefill={prefill} controls={controls} load={load} />
    </div>
  );
  const panelClass = "bg-card text-foreground flex flex-col overflow-hidden";
  const onKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Escape" && !pip) { e.stopPropagation(); setOpen(false); } };
  if (!mounted) return null;
  return (
    <div onKeyDown={onKeyDown}>
      {open && pip && createPortal(
        // Popovers and menus opened in here must portal into the PiP document, not the tab's.
        // PipContext tells the composer not to trust ITS narrow viewport for max-md: sizing.
        <PortalContainer.Provider value={pip.document.body}>
          <PipContext.Provider value={true}>
            <div role="dialog" aria-label="Orchestrator" data-slot="orchestrator-panel" data-pip="" className={`${panelClass} h-screen w-screen`}>{header}{chat}</div>
          </PipContext.Provider>
        </PortalContainer.Provider>,
        pip.document.body,
      )}
      {!pip && (
        // z-40: above the page and its sticky top bar (z-30), below menus and popovers (z-50), which
        // must still open over it. `aria-modal=false`: the page behind stays usable. Slid out, it is
        // hidden (visibility, after the transform finishes) and inert to assistive tech.
        <div
          ref={panelRef}
          role="dialog" aria-modal="false" aria-label="Orchestrator" aria-labelledby="orchestrator-title" aria-hidden={!open}
          data-slot="orchestrator-panel" data-state={open ? "open" : "closed"}
          // Opening, only the transform transitions — `visibility` flips to visible AT ONCE, so the
          // composer can take focus in the same commit (a hidden element refuses focus, and a
          // visibility transition starts at its old value). Closing, visibility waits for the slide.
          className={cn(panelClass, "fixed inset-y-0 right-0 z-40 border-l shadow-modal ease-out motion-reduce:transition-none",
            open ? "visible translate-x-0 transition-transform" : "invisible translate-x-full transition-[transform,visibility]")}
          style={{ width, maxWidth: "100vw", minWidth: Math.min(PANEL_MIN_W, vw), transitionDuration: `${SLIDE_MS}ms` }}
        >
          {/* The resize handle: the panel's left edge. Dragging left widens; the width is remembered. */}
          <div data-slot="orchestrator-resize" role="separator" aria-orientation="vertical" aria-label="Resize panel" onPointerDown={onResizeStart}
            className="hover:bg-geist-blue/40 absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize transition-colors" />
          {header}
          {chat}
        </div>
      )}
    </div>
  );
}

// Desktop (where the route still works if visited directly): the viewport below the top bar, this
// page's own h-12 header and the shell's main padding. Narrow: the WHOLE page (header + chat) bleeds
// out of <main>'s padding — so its dividers run edge to edge — and ends exactly at the bottom bar's
// top edge (Shell's BottomBar: 1px border + 6px + a 44px row + max(6px, the safe-area inset)), so the
// bar alone accounts for the home indicator and the composer gets no stray gap under it. Both in
// `--vvh`/safe-area terms like the Agent page's Chat tab (`CHAT_FILL_HEIGHT` in views/AgentPage.tsx),
// so the chat's OWN scroller (inside ChatPanel) is what scrolls, never the page.
// With the phone's keyboard up it is pinned to the visible area instead (`data-keyboard-fill`, styles.css).
const ORCHESTRATOR_PAGE_HEIGHT = "md:h-[calc(var(--vvh,100dvh)-9.5rem)]";
const ORCHESTRATOR_PAGE_NARROW =
  "max-md:-mx-[max(1rem,env(safe-area-inset-left))] max-md:-mt-6 max-md:-mb-[calc(5.5rem+env(safe-area-inset-bottom))] " +
  "max-md:h-[calc(var(--vvh,100dvh)-3.5rem-env(safe-area-inset-top)-3.1875rem-max(0.375rem,env(safe-area-inset-bottom)))]";

/** The orchestrator as a routed page (`/orchestrator`): the phone destination every narrow-screen
 *  entry point (the bottom bar, O, the palette, a notification's Open, quick-ask's Open — all via
 *  `useOrchestrator`'s `ask`) navigates to instead of opening the side panel. Same conversation, same
 *  turns, in the page's own scroll container — scrolling an overlay sheet used to scroll the page
 *  behind it instead of the chat. Back (the header's arrow, or the browser/gesture back) returns to
 *  wherever you were, because the route was PUSHED onto history rather than replacing it. No resize,
 *  pop-out or pause-on-close bookkeeping: a page doesn't need any of that, it just mounts and polls
 *  while it's the current route. */
export function OrchestratorPage() {
  const prefill = useAtomValue(orchestratorPrefillAtom);
  const { state, load, controls } = useOrchestratorState(true);
  const row: Row = {
    repo: ORCHESTRATOR_REPO, hasRemote: false, branch: ORCHESTRATOR_BRANCH, title: "Orchestrator", prompt: "", lane: "LOCAL",
    worktreePath: state?.key, agentStatus: state?.running ? "running" : "idle",
  };
  return (
    <div data-slot="orchestrator-page" data-keyboard-fill className={cn("flex flex-col", ORCHESTRATOR_PAGE_NARROW)}>
      {/* Narrow: the same 12px on every side as the conversation's and the composer's padding. */}
      <div data-slot="orchestrator-page-header" className="flex h-12 shrink-0 items-center gap-2 border-b max-md:h-auto max-md:p-3">
        <Button size="icon" variant="ghost" className="-ml-2 size-9 shrink-0 max-md:-my-1.5" title="Back" aria-label="Back" onClick={() => history.back()}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0">
          {/* Paused = it has woken itself as many times as it may without hearing from you. */}
          <div className="truncate text-sm font-medium">{state?.paused ? "Orchestrator · paused until you reply" : "Orchestrator"}</div>
          <OrchestratorStatusLine state={state} />
        </div>
      </div>
      <div className={cn("min-h-0 max-md:flex-1", ORCHESTRATOR_PAGE_HEIGHT)}>
        <OrchestratorChat row={row} prefill={prefill} controls={controls} load={load} />
      </div>
    </div>
  );
}

/** The orchestrator's conversation — the panel's and the page's — is the one ChatPanel every chat
 *  uses, with its replies under "Orchestrator", its messages through the shared outbox, and the
 *  composer's toolbar (Claude models only; changing the model keeps the session) fed its own values. */
function OrchestratorChat({ row, prefill, controls, load }: { row: Row; prefill: OrchestratorPrefill | null; controls: ChatControlsProps; load: () => Promise<unknown> }) {
  return (
    <ChatPanel
      row={row} author="Orchestrator" prefill={prefill} outbox controls={controls}
      send={async (text, images) => {
        await sendToOrchestrator(text, images);
        await load();
      }}
    />
  );
}

type DocumentPip = { requestWindow(size: { width: number; height: number }): Promise<Window> };
const pipApi = () => (window as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;
// The PiP window's size, remembered like the width (the browser lets you resize it, not place it).
const PIP_KEY = "orca.orchestrator.pip";
function loadPipSize(width: number): { width: number; height: number } {
  try {
    const s = JSON.parse(localStorage.getItem(PIP_KEY) ?? "null") as { width?: unknown; height?: unknown } | null;
    if (typeof s?.width === "number" && typeof s.height === "number") return { width: s.width, height: s.height };
  } catch { /* fall through */ }
  return { width, height: Math.min(640, window.innerHeight - 96) };
}
function savePipSize(w: Window): void {
  try { localStorage.setItem(PIP_KEY, JSON.stringify({ width: w.innerWidth, height: w.innerHeight })); } catch { /* private window */ }
}
/** A PiP document starts empty: give it the page's stylesheets (Tailwind, the theme's CSS variables). */
function copyStyles(from: Document, to: Document): void {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const style = to.createElement("style");
      style.textContent = Array.from(sheet.cssRules, (r) => r.cssText).join("\n");
      to.head.append(style);
    } catch {
      // A cross-origin sheet can't be read; link it instead.
      if (!sheet.href) continue;
      const link = to.createElement("link");
      link.rel = "stylesheet"; link.href = sheet.href;
      to.head.append(link);
    }
  }
}
