import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { createPortal } from "react-dom";
import { ArrowLeft, Bot, Check, ChevronDown, PictureInPicture2, PanelBottomClose, X } from "lucide-react";
import { subscribeTurns, syncEvents } from "@/lib/events";
import { ChatPanel } from "@/views/Chat";
import type { ChatControlsProps, CompactControl } from "@/components/ChatControls";
import { api, type AgentStatus } from "../api";
import { useWorkstreams, type Row } from "../store";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, agentStateTone, agentStatusText, orchestratorStatus, type AgentMention } from "../workstream";
import { AgentPill } from "@/components/AgentPill";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { StatusDot } from "@/components/console";
import { PanelHeader, SidePanel, usePanelWidth, useSlideSettled, type SwipeProps } from "@/components/SidePanel";
import { PipContext, PortalContainer, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Shortcut } from "@/components/ui/kbd";
import { Tip } from "@/components/ui/tip";
import { poll } from "@/lib/poll";
import { type OrchestratorPrefill, orchestratorActivityAtom, orchestratorOpenAtom, orchestratorPrefillAtom, orchestratorTabAtom, orchestratorWidthAtom } from "@/lib/atoms";
import { useCoarse, useNarrow } from "@/lib/viewport";
import { openOrchestrator } from "@/lib/orchestratorOpen";
import { sendToAgents, sendToOrchestrator } from "@/lib/orchestratorOutbox";
import { useSwipeToDismiss } from "@/lib/gestures";
import { useRoute } from "@/lib/route";

// The card's terminal: a modal you open in place (no navigating to the detail page) showing the
// branch's conversation — the same ChatPanel as the Agent page and the orchestrator — with the follow-up
// composer to send the next message. It is NOT a live shell; it renders GET /api/turns, so nothing
// tmux is involved. The native <dialog> gives the backdrop, ESC-close and focus trap for free, and
// ChatPanel mounts ONLY while open so its poll/composer aren't running behind a closed dialog.
export function TerminalDialog({ row, open, onClose }: { row: Row; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const swipe = useSwipeToDismiss("bottom", () => ref.current, onClose, { enabled: useNarrow() }); // a phone's sheet: swipe its header down (the chat scrolls on its own)
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
          <Button size="icon" variant="ghost" className="size-7 shrink-0 max-md:size-11" aria-label="Close terminal" onClick={onClose}>
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
    // Every named agent (§7.6): running while any agent's wake runs; unread once any finished unseen.
    // One status read of all of them per `turn` event on any agent's conversation.
    let live = true;
    const unsubscribers: (() => void)[] = [];
    const read = (finished: boolean) => api.orchestratorAgents().then(({ agents }) => {
      if (!live) return;
      const running = agents.some((a) => a.running);
      setActivity((a) => ({ running, unread: a.unread || (finished && !running && !viewingRef.current) }));
      return agents;
    }).catch(() => undefined);
    void read(false).then((agents) => {
      if (!live) return;
      const branches = agents?.length ? agents.map((a) => a.branch ?? ORCHESTRATOR_BRANCH) : [ORCHESTRATOR_BRANCH];
      for (const branch of new Set(branches)) unsubscribers.push(subscribeTurns(ORCHESTRATOR_REPO, branch, { turn: () => void read(true), step: () => {}, resync: () => void read(false) }));
    });
    return () => { live = false; for (const u of unsubscribers) u(); };
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
  // A toggle: the panel is a docked column on a desktop, so the button that opens it also closes it.
  const { ask, open, close } = useOrchestrator();
  const activity = useAtomValue(orchestratorActivityAtom);
  return (
    <button type="button" data-slot="ask-orchestrator" onClick={() => (open ? close() : ask())} aria-label="Ask Orca" aria-expanded={open}
      // Shell.tsx wraps this with the header's usage meter in one ml-auto slot, so this button stays
      // right-aligned whether or not the meter renders (it's absent while loading or signed out).
      // Below md the bottom bar's Orchestrator button takes its place.
      // Sized to its content (min-w-fit), not a fixed rem width.
      className="bg-card hover:bg-accent text-foreground flex h-8 min-w-fit shrink-0 items-center gap-2 rounded-md border px-2.5 text-sm max-md:hidden">
      <span className="relative inline-flex shrink-0"><Bot className="text-muted-foreground size-3.5 shrink-0" /><ActivityDot activity={activity} className="absolute -top-1 -right-1 size-1.5" /></span>
      <span data-slot="ask-orchestrator-label" className="text-muted-foreground text-left">Ask Orca</span>
      <Shortcut id="orchestrator" />
    </button>
  );
}

/** The orchestrator's model until its status read answers (server/orchestrator.ts's default). */
const ORCHESTRATOR_DEFAULT_MODEL = "claude-opus-5-5";

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
  const body = (
    <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[11px]" data-slot="orchestrator-status">
      {line.warn && <span data-slot="orchestrator-status-warn" aria-label="Large session" className="bg-geist-amber size-1.5 shrink-0 rounded-full" />}
      <span className="truncate">{line.text}</span>
    </div>
  );
  return line.tooltip ? <Tip label={line.tooltip} className="w-full min-w-0">{body}</Tip> : body;
}

/** The orchestrator's status, polled every 2s while `active` (on `win`'s timers), and the composer
 *  toolbar's values built from it — ONE source for every box that talks to it (the side panel, the
 *  routed page, the quick-ask box), so a model change or a context reading is the same in each.
 *  `compact` is for a box with no turn stream of its own (quick ask): pending from the request until
 *  the status shows the orchestrator idle again. The chat panel tracks its own, by the turn. */
export type OrchestratorState = AgentStatus;
/** `agent`: a named agent's tab (none = the Chief of Staff, the orchestrator as it always was). */
export function useOrchestratorState(active: boolean, win: Window = window, agent?: string) {
  const [state, setState] = useState<OrchestratorState | null>(null);
  // Stable (useCallback / useMemo): the panel passes these to its chat, which is memoized — a new
  // object each render re-rendered the whole long thread on every open and close of the panel.
  const load = useCallback(() => api.orchestrator(agent).then(setState).catch(() => {}), [agent]);
  useEffect(() => {
    if (!active) return;
    return poll(load, 2000, win);
  }, [active, win]);
  const model = state?.model ?? ORCHESTRATOR_DEFAULT_MODEL, contextPct = state?.contextPct;
  const controls: ChatControlsProps = useMemo(() => ({
    model, only: "claude", contextPct,
    onModel: (m: string) => { setState((s) => (s ? { ...s, model: m } : s)); void api.orchestratorModel(m, agent).then(load); },
  }), [model, contextPct, load]);
  const [compacting, setCompacting] = useState<"sent" | "started" | null>(null);
  const [compactError, setCompactError] = useState<string>();
  useEffect(() => { if (compacting === "started" && state && !state.running) setCompacting(null); }, [compacting, state]);
  const compact: CompactControl | undefined = state?.contextPct === undefined && compacting === null ? undefined : {
    pending: compacting !== null, busy: !!state?.running, error: compactError,
    onCompact: async () => {
      setCompactError(undefined);
      setCompacting("sent");
      try { await api.compact(ORCHESTRATOR_REPO, state?.branch ?? ORCHESTRATOR_BRANCH); setCompacting("started"); await load(); }
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
  // `open` is now persisted (lib/atoms `orchestratorOpenAtom`), so a reload can restore it true on a
  // device that reads narrow — which must never auto-open the dock (useOrchestrator routes a phone
  // to /orchestrator instead). `initialOpen` (captured once, this component's first render only)
  // tells the restore apart from any later transition to `open`: blocked only while BOTH the restore
  // was true-on-narrow AND the device is still narrow right now — so a later resize past the
  // breakpoint lifts it, and nothing about a deliberate later open (there is none in the app itself;
  // only a test sets the atom directly) is touched.
  const [initialOpen] = useState(open);
  const [mounted, setMounted] = useState(false);
  if (open && !mounted && !(initialOpen && narrow)) setMounted(true);
  // Popped out: the chat lives in an always-on-top Document Picture-in-Picture window (Chrome/Edge
  // 116+), rendered there by a PORTAL — the same React tree, so its state, composer draft, SSE and
  // popovers carry over rather than being copied. Kept from the window days because it costs one
  // button: the portal is what makes it work. Without the API (Firefox, Safari, or any page that is
  // not a secure context — plain http on the tailnet) Pop out opens a normal popup window instead
  // (`openOrchestratorWindow`): its own page, not on top, but the chat beside your other windows.
  const [pip, setPip] = useState<Window | null>(null);
  // The poll runs on the PiP window's timers while popped out: that window is the visible one, and
  // a hidden tab's timers get throttled (to once a minute after a while).
  // It starts after the slide: its first answer re-renders the header, which must not land in the
  // slide's frames.
  const settled = useSlideSettled(open);
  const { state, load, controls } = useOrchestratorState(settled, pip ?? window);
  // The named agents (§7.6): the main chat is the DEFAULT agent (the status answer with no agent
  // names it), first in the header's agent menu. The menu shows only once there is more than one
  // agent. Another agent's chat mounts the first time it is chosen.
  const [tab, setTab] = useAtom(orchestratorTabAtom);
  const main = state?.agent ?? "chief";
  const listed = useAgentList(settled, pip ?? window);
  const team = useMemo(() => [...listed.filter((a) => a.agent === main), ...listed.filter((a) => a.agent !== main)], [listed, main]);
  const current = team.find((a) => a.agent === tab && a.agent !== main);
  const [seen, setSeen] = useState<string[]>([]);
  if (current && !seen.includes(current.agent!)) setSeen([...seen, current.agent!]);
  // The `@` picker's agents in every tab's composer. A send with recipient chips goes to those agents
  // only; the panel stays on the current tab, and the receipt's Open switches to the agent's tab.
  const agents = useAgentMentions(team);
  const mention = useMemo(() => agents && { agents, sendTo: sendToAgents, onOpen: setTab }, [agents, setTab]);
  // Closing drops the pending ask, so a later open can't re-apply it to a freshly mounted composer.
  useEffect(() => { if (!open) { pip?.close(); setPrefill(null); } }, [open]);
  // An ask while popped out lands in the PiP window's composer; bring that window forward.
  useEffect(() => { if (prefill) pip?.focus(); }, [prefill?.seq]);
  // Focus: the composer takes it on open (ChatComposer's prefill layout effect); on close it goes back
  // to where it was — the button or key that opened the panel — so a keyboard user isn't dropped on
  // <body>. The opener is read DURING the render that opens it: the composer focuses itself in a
  // layout effect, which runs before any effect of this parent's. Opened by a key (O), the opener is
  // <body>, which can't take focus: the composer is blurred instead, or the closed panel's textarea
  // kept focus and every global shortcut after it read as typing (O, Esc, then O did nothing).
  const opener = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) opener.current = document.activeElement;
  const closing = !open && wasOpen.current;
  wasOpen.current = open;
  useLayoutEffect(() => {
    if (open || !closing) return;
    const el = opener.current as HTMLElement | null;
    opener.current = null;
    if (el && el !== document.body && document.contains(el) && typeof el.focus === "function") el.focus();
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && active.closest('[data-slot="orchestrator-panel"]')) active.blur();
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
    // No Document PiP: a popup window of the chat; the tab's panel closes, as the chat moved there.
    if (!pipApi()) { openOrchestratorWindow(loadPipSize(width)); setOpen(false); return; }
    const w = await pipApi()!.requestWindow(loadPipSize(width)).catch(() => null);
    if (!w) return;
    copyStyles(document, w.document);
    // Closing it (its own ✕, Return to tab, or closing the chat) brings the chat back into the tab.
    // The tab may be hidden by now, so the shared live stream re-checks whether it is still wanted.
    w.addEventListener("pagehide", () => { savePipSize(w); setPip(null); setTimeout(syncEvents); }, { once: true });
    setPip(w);
  };
  // The default agent's branch (the status answer with no agent names it); the Chief of Staff's until it loads.
  const key = state?.key, running = !!state?.running, mainBranch = state?.branch ?? ORCHESTRATOR_BRANCH;
  const row: Row = useMemo(() => ({
    repo: ORCHESTRATOR_REPO, hasRemote: false, branch: mainBranch, title: "Orca", prompt: "", lane: "LOCAL",
    worktreePath: key, agentStatus: running ? "running" : "idle",
  }), [key, running, mainBranch]);
  // Width: dragged from the panel's left edge (SidePanel), remembered per browser, clamped to the
  // viewport. Read here too for the Pop out window's first size.
  const { width } = usePanelWidth(orchestratorWidthAtom);
  // A touch screen: swipe the header right to close it (the edge it comes from). A mouse keeps only
  // the resize edge.
  const coarse = useCoarse();
  const header = (swipe?: SwipeProps) => (
    <PanelHeader
      slot="orchestrator-handle" swipe={swipe} touch={coarse && !pip}
      // With named agents the title IS the agent menu: its pill carries the avatar, so no icon.
      icon={team.length > 1 ? undefined : <Bot className="size-3.5" />} titleId="orchestrator-title"
      title={<AgentTitle team={team} tab={current ? current.agent! : main} onTab={(t) => setTab(t === main ? "" : t)} paused={!current && !!state?.paused} />}
      status={current ? <AgentStatusLine agent={current} /> : <OrchestratorStatusLine state={state} />}
      actions={<>
        {pip ? (
          <Button size="icon" variant="ghost" className="size-7" aria-label="Return to tab" onClick={() => pip.close()}>
            <PanelBottomClose className="size-4" />
          </Button>
        ) : !narrow && (
          <Tip label={pipApi() ? "Pop out: keep it on top of every window" : "Pop out: open it in its own window"}>
            <Button size="icon" variant="ghost" className="size-7" aria-label="Pop out" onClick={() => void popOut()}>
              <PictureInPicture2 className="size-4" />
            </Button>
          </Tip>
        )}
        <Tip label="Close" shortcut="escape">
          <Button size="icon" variant="ghost" className="size-7 max-md:size-11" aria-label="Close Orca" onClick={() => setOpen(false)}>
            <X className="size-4" />
          </Button>
        </Tip>
      </>}
    />
  );
  // The conversation fills the panel edge to edge, in the chat styling that follows the page's theme.
  const chat = (
    <>
      <div className="min-h-0 flex-1" hidden={Boolean(current)}>
        {/* Mounted at once, not after the status read: the composer must exist to take focus in the
            same commit that opens the panel, or the first keystrokes go nowhere. */}
        <OrchestratorChat row={row} prefill={prefill} controls={controls} load={load} mention={mention} />
      </div>
      {team.filter((a) => a.agent !== main && seen.includes(a.agent!)).map((a) => (
        <div key={a.agent} className="min-h-0 flex-1" hidden={current?.agent !== a.agent} data-slot="agent-chat" data-agent={a.agent}>
          <AgentChat agent={a.agent!} displayName={a.displayName ?? a.agent!} branch={a.branch ?? a.agent!} active={current?.agent === a.agent} win={pip ?? window} mention={mention} />
        </div>
      ))}
    </>
  );
  const panelClass = "bg-background text-foreground flex flex-col overflow-hidden";
  const onKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Escape" && !pip) { e.stopPropagation(); setOpen(false); } };
  if (!mounted) return null;
  return (
    <div onKeyDown={onKeyDown}>
      {open && pip && createPortal(
        // Popovers and menus opened in here must portal into the PiP document, not the tab's.
        // PipContext tells the composer not to trust ITS narrow viewport for max-md: sizing.
        <PortalContainer.Provider value={pip.document.body}>
          <PipContext.Provider value={true}>
            <div role="dialog" aria-label="Orca" data-slot="orchestrator-panel" data-pip="" className={`${panelClass} h-screen w-screen`}>{header()}{chat}</div>
          </PipContext.Provider>
        </PortalContainer.Provider>,
        pip.document.body,
      )}
      {!pip && (
        <SidePanel open={open} onClose={() => setOpen(false)} slot="orchestrator" label="Orca" labelledBy="orchestrator-title"
          widthAtom={orchestratorWidthAtom} swipe={coarse && !pip} header={header}>
          {chat}
        </SidePanel>
      )}
    </div>
  );
}

/** Every named agent's status, polled every 5 s while `active` (the panel open). The Chief of Staff
 *  alone until the first answer, so a bridge without named agents shows no tab row. */
export function useAgentList(active: boolean, win: Window = window): AgentStatus[] {
  const [team, setTeam] = useState<AgentStatus[]>([]);
  useEffect(() => {
    if (!active) return;
    return poll(() => api.orchestratorAgents().then((r) => setTeam(r.agents)).catch(() => {}), 5000, win);
  }, [active, win]);
  return team;
}

/** The agents for the composer's `@` picker: every named agent, once there is more than one (as for
 *  the tab row). The same array while the names stay, so a 5 s poll does not re-render the chats. */
export function useAgentMentions(team: AgentStatus[]): AgentMention[] | undefined {
  const key = team.length > 1 ? team.map((a) => `${a.agent ?? "chief"}\t${a.displayName ?? a.agent ?? "chief"}`).join("\n") : "";
  return useMemo(() => (key ? key.split("\n").map((l) => {
    const [name, displayName] = l.split("\t") as [string, string];
    return { name, displayName };
  }) : undefined), [key]);
}

type MentionProps = { agents: AgentMention[]; sendTo: (agents: string[], text: string, images: File[]) => Promise<unknown>; onOpen: (name: string) => void };

/** The header's title: "Orca" with no named agents (an older bridge, or only the Chief of Staff);
 *  else the agent menu. Paused = it has woken itself as many times as it may without hearing from you. */
function AgentTitle({ team, tab, onTab, paused }: { team: AgentStatus[]; tab: string; onTab: (name: string) => void; paused: boolean }) {
  if (team.length < 2) return <>{paused ? "Orca · paused until you reply" : "Orca"}</>;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <AgentMenu team={team} tab={tab} onTab={onTab} />
      {paused && <span className="text-muted-foreground truncate text-[12px] font-normal">paused until you reply</span>}
    </span>
  );
}

/** The agent menu (shadcn DropdownMenu): the chosen agent's pill opens a list of every agent's pill
 *  with its state dot, the default agent (the main chat) first. It replaced a tab row under the header (Finn). */
function AgentMenu({ team, tab, onTab }: { team: AgentStatus[]; tab: string; onTab: (name: string) => void }) {
  const nameOf = (a: AgentStatus) => a.agent ?? "chief";
  const chosen = team.find((a) => nameOf(a) === tab) ?? team[0]!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" data-slot="agent-menu" data-agent={nameOf(chosen)}
          className="-ml-1 h-7 max-w-full min-w-0 gap-1 rounded-full px-1 focus-visible:ring-inset max-md:h-9">
          <AgentPill name={nameOf(chosen)} label={chosen.displayName ?? nameOf(chosen)} size="md" />
          <ChevronDown className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52" data-slot="agent-menu-content">
        <DropdownMenuRadioGroup value={tab} onValueChange={onTab}>
          {team.map((a) => (
            <DropdownMenuRadioItem key={nameOf(a)} value={nameOf(a)} data-slot="agent-option" data-agent={nameOf(a)}
              indicator={<Check className="size-3.5" />} className="max-md:min-h-11">
              <AgentPill name={nameOf(a)} label={a.displayName ?? nameOf(a)} />
              <StatusDot tone={agentStateTone(a.state)} className={cn("ml-auto size-1.5", a.state === "working" && "animate-pulse")} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The header line of another agent's tab: its state, the note it set, what is queued. */
function AgentStatusLine({ agent }: { agent: AgentStatus }) {
  return (
    <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[11px]" data-slot="agent-status">
      <span className="truncate">{agentStatusText(agent)}</span>
    </div>
  );
}

/** Another named agent's conversation: the same ChatPanel over its own workstream (`@orca`, its
 *  branch), its replies under its name, its messages to its own queue. Nothing forks the chat. */
const AgentChat = memo(function AgentChat({ agent, displayName, branch, active, win, mention }: { agent: string; displayName: string; branch: string; active: boolean; win: Window; mention?: MentionProps }) {
  const { state, load, controls } = useOrchestratorState(active, win, agent);
  const key = state?.key, running = !!state?.running;
  const row: Row = useMemo(() => ({
    repo: ORCHESTRATOR_REPO, hasRemote: false, branch, title: displayName, prompt: "", lane: "LOCAL",
    worktreePath: key, agentStatus: running ? "running" : "idle",
  }), [branch, displayName, key, running]);
  return (
    <ChatPanel
      row={row} author={displayName} controls={controls} mention={mention}
      send={async (text, images) => {
        const refs = images.length ? await api.uploadAttachments(images) : [];
        await api.orchestratorMessage(text, refs, agent);
        await load();
      }}
    />
  );
});

// Desktop (where the route still works if visited directly): the viewport below the top bar, this
// page's own h-12 header and the shell's main padding. Narrow: the shell's top bar is hidden on this
// page (Shell's `phoneBarePage`), so the WHOLE page (header + chat) starts at the screen's top — it
// pads itself clear of the notch — bleeds out of <main>'s padding, so its dividers run edge to edge,
// and ends exactly at the bottom bar's top edge (Shell's BottomBar: 1px border + 6px + a 44px row +
// max(6px, the safe-area inset)), so the bar alone accounts for the home indicator and the composer
// gets no stray gap under it. Both in `--vvh`/safe-area terms like the Agent page's Chat tab
// (`CHAT_FILL_HEIGHT` in views/AgentPage.tsx), so the chat's OWN scroller (inside ChatPanel) is what
// scrolls, never the page.
// With the phone's keyboard up it is pinned to the visible area instead (`data-keyboard-fill`, styles.css).
const ORCHESTRATOR_PAGE_HEIGHT = "md:h-[calc(var(--vvh,100dvh)-9.5rem)]";
const ORCHESTRATOR_PAGE_NARROW =
  "max-md:-mx-[max(1rem,env(safe-area-inset-left))] max-md:-mt-6 max-md:-mb-[calc(5.5rem+env(safe-area-inset-bottom))] max-md:pt-[env(safe-area-inset-top)] " +
  "max-md:h-[calc(var(--vvh,100dvh)-3.1875rem-max(0.375rem,env(safe-area-inset-bottom)))]";

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
  // The same agent menu as the side panel's header: the chosen agent's chat in this page.
  // The main chat is the DEFAULT agent (the status answer with no agent names it), first in the menu.
  const [tab, setTab] = useAtom(orchestratorTabAtom);
  const main = state?.agent ?? "chief";
  const listed = useAgentList(true);
  const team = useMemo(() => [...listed.filter((a) => a.agent === main), ...listed.filter((a) => a.agent !== main)], [listed, main]);
  const current = team.find((a) => a.agent === tab && a.agent !== main);
  // The `@` picker's agents, as in the side panel: a chip sends to that agent only, Open switches to it.
  const agents = useAgentMentions(team);
  const mention = useMemo(() => agents && { agents, sendTo: sendToAgents, onOpen: setTab }, [agents, setTab]);
  const row: Row = {
    repo: ORCHESTRATOR_REPO, hasRemote: false, branch: state?.branch ?? ORCHESTRATOR_BRANCH, title: "Orca", prompt: "", lane: "LOCAL",
    worktreePath: state?.key, agentStatus: state?.running ? "running" : "idle",
  };
  return (
    <div data-slot="orchestrator-page" data-keyboard-fill className={cn("flex flex-col", ORCHESTRATOR_PAGE_NARROW)}>
      {/* Narrow: the desktop's 48px row (it was 60px, padded 12px all round) with the conversation's
          12px at the sides; it is the phone's ONLY header here, Back included. At least 48px: the
          agent menu's 36px touch target and the status line under it may need a little more. */}
      <div data-slot="orchestrator-page-header" className="flex min-h-12 shrink-0 items-center gap-2 border-b py-1 max-md:px-3">
        <Button size="icon" variant="ghost" className="-ml-2 size-9 shrink-0" aria-label="Back" onClick={() => history.back()}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium" data-slot="orchestrator-page-title">
            <AgentTitle team={team} tab={current ? current.agent! : main} onTab={(t) => setTab(t === main ? "" : t)} paused={!current && !!state?.paused} />
          </div>
          {current ? <AgentStatusLine agent={current} /> : <OrchestratorStatusLine state={state} />}
        </div>
      </div>
      <div className={cn("min-h-0 max-md:flex-1", ORCHESTRATOR_PAGE_HEIGHT)} hidden={Boolean(current)}>
        <OrchestratorChat row={row} prefill={prefill} controls={controls} load={load} mention={mention} />
      </div>
      {current && (
        <div key={current.agent} className={cn("min-h-0 max-md:flex-1", ORCHESTRATOR_PAGE_HEIGHT)} data-slot="agent-chat" data-agent={current.agent}>
          <AgentChat agent={current.agent!} displayName={current.displayName ?? current.agent!} branch={current.branch ?? current.agent!} active win={window} mention={mention} />
        </div>
      )}
    </div>
  );
}

/** The orchestrator's conversation — the panel's and the page's — is the one ChatPanel every chat
 *  uses, with its replies under "Orchestrator", its messages through the shared outbox, and the
 *  composer's toolbar (Claude models only; changing the model keeps the session) fed its own values. */
/** Memoized: an open or close of the panel re-renders the panel, never this (its props are stable). */
const OrchestratorChat = memo(function OrchestratorChat({ row, prefill, controls, load, mention }: { row: Row; prefill: OrchestratorPrefill | null; controls: ChatControlsProps; load: () => Promise<unknown>; mention?: MentionProps }) {
  return (
    <ChatPanel
      row={row} author="Orca" prefill={prefill} outbox controls={controls} mention={mention}
      send={async (text, images) => {
        await sendToOrchestrator(text, images);
        await load();
      }}
    />
  );
});

/** The popup's name: a second Pop out finds the same window instead of opening another. */
export const ORCHESTRATOR_WINDOW_NAME = "orca-orchestrator";
/** The popup's URL: the orchestrator's route, flagged so App renders only the chat (`OrchestratorWindow`). */
export const ORCHESTRATOR_WINDOW_URL = "/orchestrator?window";
let popup: Window | null = null;
/** Pop out without Document PiP: open the orchestrator in a popup window sized like the PiP one, or
 *  bring forward the one already open (opening it again by name would reload it). */
export function openOrchestratorWindow(size: { width: number; height: number }): void {
  if (popup && !popup.closed) { popup.focus(); return; }
  popup = window.open(ORCHESTRATOR_WINDOW_URL, ORCHESTRATOR_WINDOW_NAME, `popup,width=${Math.round(size.width)},height=${Math.round(size.height)}`);
  popup?.focus();
}
/** Is this page the Pop out popup (`ORCHESTRATOR_WINDOW_URL`)? */
export const isOrchestratorWindow = (path = location.pathname, search = location.search) =>
  path === "/orchestrator" && new URLSearchParams(search).has("window");

/** The Pop out popup's whole page: the panel's header and chat, filling the window — the same layout
 *  as the PiP window. PipContext: the window is narrow, but it is not a phone. */
export function OrchestratorWindow() {
  const prefill = useAtomValue(orchestratorPrefillAtom);
  const { state, load, controls } = useOrchestratorState(true);
  // The default agent's branch (the status answer with no agent names it); the Chief of Staff's until it loads.
  const key = state?.key, running = !!state?.running, mainBranch = state?.branch ?? ORCHESTRATOR_BRANCH;
  const row: Row = useMemo(() => ({
    repo: ORCHESTRATOR_REPO, hasRemote: false, branch: mainBranch, title: "Orca", prompt: "", lane: "LOCAL",
    worktreePath: key, agentStatus: running ? "running" : "idle",
  }), [key, running, mainBranch]);
  // The size you leave it at is the next Pop out's size, as for the PiP window.
  useEffect(() => {
    const save = () => savePipSize(window);
    window.addEventListener("pagehide", save);
    return () => window.removeEventListener("pagehide", save);
  }, []);
  return (
    <PipContext.Provider value={true}>
      <div role="main" aria-label="Orca" data-slot="orchestrator-window" className="bg-background text-foreground flex h-[100dvh] w-screen flex-col overflow-hidden">
        <PanelHeader slot="orchestrator-handle" icon={<Bot className="size-3.5" />}
          title={state?.paused ? "Orca · paused until you reply" : "Orca"}
          status={<OrchestratorStatusLine state={state} />} />
        <div className="min-h-0 flex-1">
          <OrchestratorChat row={row} prefill={prefill} controls={controls} load={load} />
        </div>
      </div>
    </PipContext.Provider>
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
