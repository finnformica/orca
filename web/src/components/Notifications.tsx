// The notification centre's two surfaces, in Geist: the toast stack in the bottom-right corner and
// the bell at the sidebar's foot that opens the centre — a
// popover listing every notification by day. Modelled on branch-demo's inbox toasts (a stack that
// collapses with a count, Clear all, per-toast dismiss) but flat and restyled: hairlines, 8px cards,
// the menu shadow only, black/white primary, blue accent. The decisions (what pops, what persists,
// the stack's cut) are pure in shared/notifications.ts; the state is lib/notificationStore.ts.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  AlertTriangle, Bell, BellOff, Check, CheckCheck, CircleX, GitPullRequestArrow, MessageCircleQuestion, MonitorCheck, MonitorX, OctagonPause, ShieldX, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { navigate } from "@/lib/route";
import { notifyDndAtom, orchestratorOpenAtom } from "@/lib/atoms";
import { clearToasts, dismiss, dismissToast, markRead, start, useNotifications } from "@/lib/notificationStore";
import { groupByDay, KIND_META, NOTIFICATION_KINDS, notificationPath, toastStack, unreadCount, type Notification, type NotificationKind } from "../../../shared/notifications";
import { useWorkstreams } from "../store";
import { ago } from "../workstream";
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

/** Where a notification opens, resolved against the live rows (its PR page once it has a PR). */
function useOpener() {
  const rows = useWorkstreams();
  const openOrchestrator = useSetAtom(orchestratorOpenAtom);
  return (n: Notification) => {
    void markRead([n.id]);
    if (n.link?.orchestrator) return void openOrchestrator(true);
    if (n.link?.url) return void window.open(n.link.url, "_blank", "noopener");
    const row = rows.find((r) => r.repo === n.repo && r.branch === n.branch);
    const path = notificationPath(n, row ? detailPath(row) : undefined);
    if (path) navigate(path);
  };
}

// ---- the toast stack ----

/** Bottom-right (the orchestrator's window, when open, paints over it — it is what you are looking
 *  at then, and the bell keeps the count). Newest on top; more than one collapses to the
 *  top few with a count bar (hover or click expands); Clear all; a toast for a finished run or a
 *  ready preview hides itself, a problem or a question stays until dismissed. */
export function ToastHost() {
  const { toasts } = useNotifications();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { start(); }, []);
  useEffect(() => { if (toasts.length <= 1) setExpanded(false); }, [toasts.length]);
  const stack = useMemo(() => toastStack(toasts, expanded), [toasts, expanded]);
  const open = useOpener();
  if (!toasts.length) return null;
  return (
    <div data-slot="toast-host" data-expanded={expanded || undefined} role="region" aria-label="Notifications"
      className="fixed right-4 bottom-4 z-40 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col items-stretch gap-2"
      onMouseEnter={() => setExpanded(true)} onMouseLeave={() => setExpanded(false)}>
      {stack.visible.map((n, i) => (stack.collapsed && i > 0
        ? <div key={n.id} data-slot="toast-peek" aria-hidden="true" className={cn("bg-card -mt-1 h-1.5 rounded-b-lg border border-t-0", i === 1 ? "mx-2" : "mx-4")} />
        : <Toast key={n.id} n={n} onOpen={() => { dismissToast(n.id); open(n); }} />
      ))}
      {toasts.length > 1 && (
        <div data-slot="toast-count" className="bg-card flex h-8 items-center justify-between rounded-lg border pl-3 pr-1 text-xs shadow-menu">
          <button type="button" className="text-muted-foreground hover:text-foreground" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
            {toasts.length} notifications{stack.hidden ? ` · ${stack.hidden} more` : ""}
          </button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={clearToasts}>Clear all</Button>
        </div>
      )}
    </div>
  );
}

function Toast({ n, onOpen }: { n: Notification; onOpen: () => void }) {
  const meta = KIND_META[n.kind];
  return (
    <div data-slot="toast" data-kind={n.kind} role="status" className="bg-card text-foreground flex flex-col gap-2 rounded-lg border p-3 shadow-menu">
      <div className="flex items-start gap-2">
        <KindIcon kind={n.kind} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 text-sm leading-5">
            <span className="truncate font-medium">{n.title}</span>
            <span className={cn("shrink-0 text-xs", TONE_TEXT[meta.tone])}>{meta.label}</span>
          </div>
          {n.body && <div className="text-muted-foreground truncate text-xs leading-5">{n.body}</div>}
        </div>
        <Button variant="ghost" size="icon" className="-mt-1 -mr-1 size-6" aria-label="Dismiss" onClick={() => dismissToast(n.id)}><X className="size-3.5" /></Button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span data-slot="toast-time" className="text-muted-foreground text-xs">{ago(n.createdAt)}{n.instance ? ` · ${n.instance}` : ""}</span>
        <Button size="sm" className="h-7 px-2.5 text-xs" onClick={onOpen}>{meta.action}</Button>
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
  const open = useOpener();
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
                <li key={n.id}>
                  <button type="button" data-slot="notification-row" data-kind={n.kind} data-unread={n.readAt ? undefined : ""} onClick={() => open(n)}
                    className={cn("hover:bg-accent/40 flex w-full items-start gap-2.5 px-3 py-2.5 text-left", n.readAt && "opacity-70")}>
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
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
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
