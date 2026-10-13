// The notification centre's two surfaces, in Geist: the toast stack bottom-left, growing up from
// just above the bell, and the bell at the sidebar's foot that opens the centre — a popover listing
// every notification by day. The stack copies branch-demo's inbox toasts (sonner's bottom-left
// stack: collapsed cards that spread on hover, slide-in / drop-out, swipe to dismiss, the count bar
// with Clear all, auto-hide paused while you look) with CSS transitions instead of the dependency,
// and is restyled flat: hairlines, 8px cards, the menu shadow only, black/white primary, blue
// accent. Every toast and centre row carries quick actions on hover (always, on a touch screen): its
// kind's one or two (Address PR, Fix, Reply, Retry, …) and Read — chosen by the pure
// `notificationActions` (workstream.ts), run by the store's existing verbs. The decisions (what pops,
// what persists, the stack's layout and motion) are pure in shared/notifications.ts; the state is
// lib/notificationStore.ts.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  AlertTriangle, Bell, BellOff, Check, CheckCheck, CircleX, GitPullRequestArrow, MessageCircleQuestion, MonitorCheck, MonitorX, OctagonPause, ShieldX, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { navigate } from "@/lib/route";
import { notifyDndAtom, orchestratorOpenAtom } from "@/lib/atoms";
import { clearToasts, dismiss, dismissToast, markRead, pauseToasts, resumeToasts, start, useNotifications } from "@/lib/notificationStore";
import { useCoarse, useNarrow } from "@/lib/viewport";
import {
  COUNT_BAR_HEIGHT, COUNT_BAR_SPACE, groupByDay, KIND_META, NOTIFICATION_KINDS, notificationPath, stackAnchor, stackLayout, swipeAmount, swipeOut,
  TOAST_EXIT_MS, TOAST_WIDTH, toastMotion, toastStack, unreadCount, type Notification, type NotificationKind, type StackAnchor, type SwipeDir, type ToastPlace,
} from "../../../shared/notifications";
import { addressPr, followUp, previewKeyOf, stopPreview, testLocally, useWorkstreams, type Row } from "../store";
import { ago, notificationActions, RETRY_INSTRUCTION, type NotificationActionId, type NotificationActionSpec } from "../workstream";
import { autofixInstruction } from "../../../shared/agent";
import { ActionButton } from "@/components/ActionButton";
import { detailPath } from "@/views/Agents";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const ICON: Record<NotificationKind, typeof Bell> = {
  needs_input: MessageCircleQuestion, finished: Check, failed: CircleX, stopped: OctagonPause, check_failed: ShieldX,
  pr_ci_failed: AlertTriangle, pr_conflicts: GitPullRequestArrow, preview_ready: MonitorCheck, preview_failed: MonitorX,
};
const TONE_TEXT = { ready: "text-geist-green", error: "text-geist-red", warning: "text-geist-warning-fg", queued: "text-geist-blue", neutral: "text-muted-foreground" } as const;

const KindIcon = ({ kind, className }: { kind: NotificationKind; className?: string }) => {
  const Icon = ICON[kind];
  return <Icon className={cn("size-4 shrink-0", TONE_TEXT[KIND_META[kind].tone], className)} aria-hidden="true" />;
};

/** Where a notification opens and what its quick actions do, resolved against the live rows (its
 *  PR page once it has a PR). Every handler is the store's own verb; nothing is re-implemented. */
function useNotificationActions() {
  const rows = useWorkstreams();
  const openOrchestrator = useSetAtom(orchestratorOpenAtom);
  const rowOf = (n: Notification): Row | undefined => rows.find((r) => r.repo === n.repo && r.branch === n.branch);
  const pathOf = (n: Notification, tail = ""): string | undefined => {
    const row = rowOf(n);
    const path = notificationPath(n, row ? detailPath(row) : undefined);
    return path && path + tail;
  };
  const go = (path: string | undefined) => { if (path) navigate(path); };
  /** The notification's own page: the workstream (a preview's URL, the orchestrator's window). */
  const open = (n: Notification) => {
    void markRead([n.id]);
    if (n.link?.orchestrator) return void openOrchestrator(true);
    if (n.link?.url) return void window.open(n.link.url, "_blank", "noopener");
    go(pathOf(n));
  };
  const specs = (n: Notification): NotificationActionSpec[] => {
    const row = rowOf(n);
    return notificationActions(n, {
      row: Boolean(row), prUrl: Boolean(row?.prUrl), failedCheck: Boolean(row?.agentCheck && !row.agentCheck.ok),
      previewKey: Boolean(row && previewKeyOf(row)),
    });
  };
  /** An agent or preview verb: async, so it runs in an ActionButton (spinner → ✓/✗, the error toast). */
  const verb = (id: NotificationActionId, n: Notification): (() => Promise<unknown>) | undefined => {
    const row = rowOf(n);
    if (!row) return undefined;
    switch (id) {
      case "address": return () => addressPr(row);
      case "retry": return () => followUp(row, RETRY_INSTRUCTION);
      case "fix": return row.agentCheck ? () => followUp(row, autofixInstruction(row.agentCheck!)) : undefined;
      case "stopPreview": { const key = previewKeyOf(row); return key ? () => stopPreview(key) : undefined; }
      case "retryPreview": return () => testLocally(row);
      default: return undefined;
    }
  };
  /** A link: where it goes. */
  const link = (id: NotificationActionId, n: Notification): (() => void) | undefined => {
    switch (id) {
      case "open": return () => go(pathOf(n));
      case "reply": return () => go(pathOf(n, "/chat?reply=1"));
      case "openChat": case "viewOutput": return () => go(pathOf(n, "/chat"));
      case "viewLog": return () => go(pathOf(n, "/preview"));
      case "viewPr": { const url = rowOf(n)?.prUrl; return url ? () => void window.open(url, "_blank", "noopener") : undefined; }
      case "openPreview": return n.link?.url ? () => void window.open(n.link!.url, "_blank", "noopener") : undefined;
      case "openOrchestrator": return () => openOrchestrator(true);
      default: return undefined;
    }
  };
  return { open, specs, verb, link, rowOf };
}

/** A notification's quick-action row: its kind's actions (the first primary), then Read, and — in
 *  the centre — a dismiss ×. Hidden until the card or row is hovered or focused, always shown on a
 *  touch screen. Any action marks the notification read; `done` is what the surface does after
 *  (a toast leaves the stack). A verb's failure goes to the action-error toast, as on the board. */
function QuickActions({ n, shown, done, onDismiss, className }: {
  n: Notification; shown: boolean; done: () => void; onDismiss?: () => void; className?: string;
}) {
  const actions = useNotificationActions();
  const row = actions.rowOf(n);
  const btn = "h-7 px-2 text-xs";
  const variant = (a: NotificationActionSpec) => (a.primary ? "default" : a.id === "read" ? "ghost" : "outline") as "default" | "ghost" | "outline";
  return (
    <div data-slot="notification-actions" data-shown={shown}
      className={cn("flex items-center gap-1 transition-opacity duration-150", !shown && "pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100", className)}>
      {actions.specs(n).map((a) => {
        if (a.id === "read") {
          return <Button key={a.id} size="sm" variant="ghost" className={btn} disabled={Boolean(n.readAt)} onClick={() => { void markRead([n.id]); done(); }}>{a.label}</Button>;
        }
        const run = actions.verb(a.id, n);
        if (run) {
          return (
            <ActionButton key={a.id} variant={variant(a)} className={btn}
              failure={{ action: a.label, title: n.title, repo: n.repo, branch: n.branch ?? "", prNumber: row?.prNumber }}
              onRun={async () => { await run(); void markRead([n.id]); setTimeout(done, 800); }}>
              {a.label}
            </ActionButton>
          );
        }
        const go = actions.link(a.id, n);
        return go ? <Button key={a.id} size="sm" variant={variant(a)} className={btn} onClick={() => { void markRead([n.id]); done(); go(); }}>{a.label}</Button> : null;
      })}
      {onDismiss && <Button variant="ghost" size="icon" className="size-7" aria-label="Dismiss" onClick={onDismiss}><X className="size-3.5" /></Button>}
    </div>
  );
}

// ---- the toast stack ----

/** Where the stack sits, re-measured from the bell whenever the window or the sidebar's foot
 *  changes size (collapsing the sidebar moves the bell). */
function useStackAnchor(active: boolean): StackAnchor {
  const narrow = useNarrow();
  const measure = useCallback((): StackAnchor => {
    const rect = (slot: string) => document.querySelector(`[data-slot="${slot}"]`)?.getBoundingClientRect();
    return stackAnchor(rect("notifications-bell"), rect("sidebar-foot"), { width: window.innerWidth, height: window.innerHeight }, narrow, rect("bottom-bar")?.height || undefined);
  }, [narrow]);
  const [anchor, setAnchor] = useState<StackAnchor>(measure);
  useLayoutEffect(() => {
    if (!active) return;
    const update = () => setAnchor((prev) => {
      const next = measure();
      return next.left === prev.left && next.bottom === prev.bottom && next.right === prev.right ? prev : next;
    });
    update();
    window.addEventListener("resize", update);
    const foot = document.querySelector('[data-slot="sidebar-foot"]');
    const ro = foot && typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : undefined;
    if (foot) ro?.observe(foot);
    return () => { window.removeEventListener("resize", update); ro?.disconnect(); };
  }, [active, measure]);
  return anchor;
}

const useDocumentHidden = () => {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return hidden;
};

type Gone = { n: Notification; place: ToastPlace };

/** Bottom-left, its foot just above the bell (full width above the bottom bar on a phone), so the
 *  orchestrator's window in the bottom-right corner and the action-error Toaster never share its
 *  corner. Newest in front; three show, the rest wait (the bell has them all). Past one, the cards
 *  collapse behind the front one over a count bar with Clear all; hovering spreads them, and while
 *  the stack is hovered, touched or the tab hidden, nothing auto-hides. A finished run or a ready
 *  preview hides itself; a problem or a question stays until dismissed (✕, or a swipe left/down). */
export function ToastHost() {
  const { toasts } = useNotifications();
  useEffect(() => { start(); }, []);
  const [expanded, setExpanded] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const hidden = useDocumentHidden();
  const [heights, setHeights] = useState<Map<number, number>>(() => new Map());
  const [gone, setGone] = useState<Gone[]>([]);
  const stack = useMemo(() => toastStack(toasts), [toasts]);
  const layout = useMemo(() => stackLayout(stack.ordered.map((n) => heights.get(n.id) ?? 0), expanded), [stack, heights, expanded]);
  const anchor = useStackAnchor(toasts.length + gone.length > 0);
  const { open } = useNotificationActions();

  // A card that leaves the store stays rendered where it was, for its exit — noticed during render
  // (not in an effect), so the same element carries on and keeps its swipe-out.
  const [seen, setSeen] = useState<{ ordered: Notification[]; layout: ToastPlace[] }>({ ordered: [], layout: [] });
  if (seen.ordered !== stack.ordered || seen.layout !== layout) {
    const live = new Set(stack.ordered.map((n) => n.id));
    const leaving = seen.ordered.flatMap((n, i) => (live.has(n.id) || !seen.layout[i] ? [] : [{ n, place: seen.layout[i]! }]));
    setSeen({ ordered: stack.ordered, layout });
    if (leaving.length) setGone((g) => [...g.filter((x) => !leaving.some((l) => l.n.id === x.n.id)), ...leaving]);
  }
  const scheduled = useRef(new Set<number>());
  useEffect(() => {
    for (const { n } of gone) {
      if (scheduled.current.has(n.id)) continue;
      scheduled.current.add(n.id);
      setTimeout(() => {
        scheduled.current.delete(n.id);
        setGone((g) => g.filter((x) => x.n.id !== n.id));
        setHeights((h) => { const m = new Map(h); m.delete(n.id); return m; });
      }, TOAST_EXIT_MS);
    }
  }, [gone]);
  const leaving = gone.filter((g) => !stack.ordered.some((n) => n.id === g.n.id));

  useEffect(() => { if (toasts.length <= 1) setExpanded(false); }, [toasts.length]);
  const paused = expanded || interacting || hidden;
  useEffect(() => { if (paused) pauseToasts(); else resumeToasts(); }, [paused]);
  useEffect(() => () => resumeToasts(), []);

  const onHeight = useCallback((id: number, h: number) => setHeights((m) => (m.get(id) === h ? m : new Map(m).set(id, h))), []);
  if (!toasts.length && !leaving.length) return null;
  const showCount = toasts.length > 1;
  const width: CSSProperties = anchor.right !== undefined ? { right: anchor.right } : { width: TOAST_WIDTH };
  return (
    <>
      <div data-slot="notification-host" data-expanded={expanded || undefined} role="region" aria-label="Notification centre"
        // z-[60]: above the sidebar (z-50 — a toast anchored above the bell would otherwise paint
        // underneath it) and the orchestrator's side panel (z-40), still under native <dialog>s
        // (the command palette, Add New) and the action-error Toaster's own corner (z-50).
        className="fixed z-[60]" style={{ left: anchor.left, bottom: anchor.bottom + (showCount ? COUNT_BAR_SPACE : 0), ...width }}
        onMouseEnter={() => setExpanded(true)} onMouseMove={() => setExpanded(true)}
        onMouseLeave={() => { if (!interacting) setExpanded(false); }}
        onPointerDown={() => setInteracting(true)} onPointerUp={() => setInteracting(false)}
        onKeyDown={(e) => { if (e.key === "Escape") setExpanded(false); }}>
        {[
          ...stack.ordered.map((n, i) => (
            <Toast key={n.id} n={n} place={layout[i]!} expanded={expanded} count={stack.ordered.length} onHeight={onHeight}
              onOpen={() => { dismissToast(n.id); open(n); }} />
          )),
          ...leaving.map(({ n, place }) => (
            <Toast key={n.id} n={n} place={place} expanded={expanded} count={stack.ordered.length} removed onHeight={onHeight} onOpen={() => open(n)} />
          )),
        ]}
      </div>
      {showCount && (
        <div data-slot="notification-count" className="bg-card fixed z-[60] flex items-center justify-between rounded-lg border pl-3 pr-1 text-xs shadow-menu"
          style={{ left: anchor.left, bottom: anchor.bottom, height: COUNT_BAR_HEIGHT, ...width }}>
          <button type="button" className="text-muted-foreground hover:text-foreground" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
            {toasts.length} notifications
          </button>
          <Button variant="ghost" size="sm" className="h-5 px-2 text-xs" onClick={clearToasts}>Clear all</Button>
        </div>
      )}
    </>
  );
}

function Toast({ n, place, expanded, count, removed = false, onHeight, onOpen }: {
  n: Notification; place: ToastPlace; expanded: boolean; count: number; removed?: boolean;
  onHeight: (id: number, h: number) => void; onOpen: () => void;
}) {
  const meta = KIND_META[n.kind];
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [swiping, setSwiping] = useState(false);
  const [out, setOut] = useState<SwipeDir>();
  const drag = useRef<{ x: number; y: number; at: number; axis?: "x" | "y"; amount: number }>();
  const [hover, setHover] = useState(false);
  const coarse = useCoarse();
  useEffect(() => { setMounted(true); }, []);
  // The natural height (not the clipped one a collapsed card behind is given), kept current.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || removed) return;
    const was = el.style.height;
    el.style.height = "auto";
    onHeight(n.id, el.getBoundingClientRect().height);
    el.style.height = was;
  }, [mounted, n.id, n.title, n.body, removed, onHeight]);

  const setSwipe = (x: number, y: number) => {
    ref.current?.style.setProperty("--swipe-x", `${x}px`);
    ref.current?.style.setProperty("--swipe-y", `${y}px`);
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button === 2 || removed || (e.target as HTMLElement).closest("button")) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, at: Date.now(), amount: 0 };
    setSwiping(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || (window.getSelection()?.toString().length ?? 0) > 0) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.axis && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) d.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    if (!d.axis) return;
    d.amount = swipeAmount(d.axis, d.axis === "x" ? dx : dy);
    setSwipe(d.axis === "x" ? d.amount : 0, d.axis === "y" ? d.amount : 0);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = undefined;
    setSwiping(false);
    if (!d?.axis) return;
    const dir = swipeOut(d.axis, d.amount, Date.now() - d.at);
    if (dir) { setOut(dir); dismissToast(n.id); } else setSwipe(0, 0);
  };

  const motion = toastMotion(place, { mounted, removed, expanded });
  // A swiped-out card keeps its place; its keyframes carry it off.
  const y = out ? place.transform : motion.transform;
  const style = {
    "--y": y, opacity: out ? 1 : motion.opacity, zIndex: count - place.index + (removed ? 1 : 0),
    height: !removed && place.height !== undefined && place.height > 0 && (expanded || !place.front) ? place.height : undefined,
  } as CSSProperties;
  return (
    <div ref={ref} data-slot="notification-toast" data-kind={n.kind} role="status" tabIndex={0}
      data-front={place.front} data-index={place.index} data-visible={place.visible} data-expanded={expanded} data-mounted={mounted}
      data-removed={removed} data-swiping={swiping} data-swipe-out={out} data-slow={(motion.slow && !out) || undefined}
      aria-hidden={!place.visible || undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onMouseEnter={() => setHover(true)} onMouseMove={() => setHover(true)} onMouseLeave={() => setHover(false)}
      className="group bg-card text-foreground absolute bottom-0 left-0 flex w-full flex-col gap-2 rounded-lg border p-3 shadow-menu outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50"
      style={style}>
      <div className="flex items-start gap-2">
        <KindIcon kind={n.kind} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 text-sm leading-5">
            <button type="button" data-slot="notification-title" className="truncate font-medium hover:underline" onClick={onOpen}>{n.title}</button>
            <span className={cn("shrink-0 text-xs", TONE_TEXT[meta.tone])}>{meta.label}</span>
          </div>
          {n.body && <div className="text-muted-foreground line-clamp-2 text-xs leading-5 break-words">{n.body}</div>}
        </div>
        <Button variant="ghost" size="icon" className="-mt-1 -mr-1 size-6" aria-label="Dismiss" onClick={() => dismissToast(n.id)}><X className="size-3.5" /></Button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span data-slot="notification-time" className="text-muted-foreground shrink-0 text-xs">{ago(n.createdAt)}{n.instance ? ` · ${n.instance}` : ""}</span>
        {!removed && <QuickActions n={n} shown={hover || coarse} done={() => dismissToast(n.id)} />}
      </div>
    </div>
  );
}

// ---- the bell and the centre ----

/** The bell at the sidebar's foot, with the unread count; opens the centre. */
export function NotificationBell({ collapsed = false }: { collapsed?: boolean }) {
  const { list } = useNotifications();
  const [dnd] = useAtom(notifyDndAtom);
  useEffect(() => { start(); }, []);
  const unread = unreadCount(list);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-slot="notifications-bell" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`} title="Notifications"
          className={cn("text-muted-foreground hover:text-foreground hover:bg-accent relative inline-flex size-8 shrink-0 items-center justify-center rounded-md", collapsed && "md:mx-auto")}>
          {dnd ? <BellOff className="size-4" /> : <Bell className="size-4" />}
          {unread > 0 && (
            <span data-slot="notifications-unread" className="bg-geist-blue absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold text-white tabular-nums">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[24rem] max-w-[calc(100vw-2rem)] p-0">
        <NotificationPanel />
      </PopoverContent>
    </Popover>
  );
}

/** The centre: every notification by day, read / unread, a kind filter, Mark all read, Clear all,
 *  and do-not-disturb. A click marks the row read and opens it. */
export function NotificationPanel() {
  const { list } = useNotifications();
  const [dnd, setDnd] = useAtom(notifyDndAtom);
  const [kind, setKind] = useState<NotificationKind | "all">("all");
  const { open } = useNotificationActions();
  const counts = useMemo(() => {
    const c = new Map<NotificationKind, number>();
    for (const n of list) c.set(n.kind, (c.get(n.kind) ?? 0) + 1);
    return c;
  }, [list]);
  const shown = kind === "all" ? list : list.filter((n) => n.kind === kind);
  const groups = groupByDay(shown);
  const unread = unreadCount(list);
  return (
    <div data-slot="notification-centre" className="flex max-h-[70vh] flex-col">
      <header className="flex h-11 items-center gap-1 border-b px-3">
        <h3 className="text-sm font-medium">Notifications</h3>
        {unread > 0 && <span className="text-muted-foreground text-xs">{unread} unread</span>}
        <span className="flex-1" />
        <IconButton label={dnd ? "Do not disturb is on — turn off" : "Do not disturb"} pressed={dnd} onClick={() => setDnd(!dnd)}>{dnd ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}</IconButton>
        <IconButton label="Mark all read" onClick={() => void markRead("all")} disabled={!unread}><CheckCheck className="size-3.5" /></IconButton>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void dismiss("all")} disabled={!list.length}>Clear all</Button>
      </header>
      {list.length > 0 && (
        <div data-slot="notification-filter" className="flex flex-wrap gap-1 border-b px-3 py-2">
          <Chip active={kind === "all"} onClick={() => setKind("all")}>All <span className="text-muted-foreground tabular-nums">{list.length}</span></Chip>
          {NOTIFICATION_KINDS.filter((k) => counts.get(k)).map((k) => (
            <Chip key={k} active={kind === k} onClick={() => setKind(kind === k ? "all" : k)}>{KIND_META[k].label} <span className="text-muted-foreground tabular-nums">{counts.get(k)}</span></Chip>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 px-6 py-10 text-center text-sm">
            <span className="rounded-full border p-2.5"><Bell className="size-4" /></span>
            {list.length ? "Nothing of that kind." : dnd ? "No notifications. Do not disturb is on." : "No notifications yet."}
          </div>
        ) : groups.map((g) => (
          <section key={g.label} data-slot="notification-group">
            <h4 className="text-muted-foreground bg-card sticky top-0 border-b px-3 py-1.5 text-xs font-medium">{g.label}</h4>
            <ul className="divide-y">
              {g.items.map((n) => (
                <CentreRow key={n.id} n={n} onOpen={() => open(n)} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** One row of the centre: a click opens it; hovering (or a touch screen) shows its quick actions
 *  over the row's foot, beside the time — Read, its kind's verbs, and a dismiss ×. */
function CentreRow({ n, onOpen }: { n: Notification; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  const coarse = useCoarse();
  return (
    <li className="group hover:bg-accent/40 relative" onMouseEnter={() => setHover(true)} onMouseMove={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button type="button" data-slot="notification-row" data-kind={n.kind} data-unread={n.readAt ? undefined : ""} onClick={onOpen}
        className={cn("flex w-full items-start gap-2.5 px-3 pt-2.5 pb-10 text-left", n.readAt && "opacity-70")}>
        <KindIcon kind={n.kind} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5 text-sm leading-5">
            <span className="truncate font-medium">{n.title}</span>
            <span className={cn("shrink-0 text-xs", TONE_TEXT[KIND_META[n.kind].tone])}>{KIND_META[n.kind].label}</span>
          </span>
          {n.body && <span className="text-muted-foreground block truncate text-xs leading-5">{n.body}</span>}
          <span className="text-muted-foreground block text-xs">{ago(n.createdAt)}{n.repo && n.repo !== "@orca" ? ` · ${n.repo}` : ""}{n.instance ? ` · ${n.instance}` : ""}</span>
        </span>
        {!n.readAt && <span data-slot="unread-dot" className="bg-geist-blue mt-2 size-1.5 shrink-0 rounded-full" aria-label="unread" />}
      </button>
      <QuickActions n={n} shown={hover || coarse} done={() => {}} onDismiss={() => void dismiss([n.id])} className="absolute right-2 bottom-1.5 left-9 justify-end" />
    </li>
  );
}

const IconButton = ({ label, pressed, onClick, disabled, children }: { label: string; pressed?: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) => (
  <button type="button" aria-label={label} title={label} aria-pressed={pressed} onClick={onClick} disabled={disabled}
    className={cn("text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-7 items-center justify-center rounded-md disabled:opacity-50", pressed && "bg-accent text-foreground")}>
    {children}
  </button>
);

const Chip = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) => (
  <button type="button" aria-pressed={active} onClick={onClick}
    className={cn("inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs whitespace-nowrap", active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>
    {children}
  </button>
);
