// The console shell, Vercel's: a left sidebar (the server button, Find, the nav, you at the bottom)
// that collapses to icons on desktop, and a top bar with the repo
// context switcher, a breadcrumb and, on the right, a compact Claude usage meter then "Ask the
// orchestrator" (on every page). It also
// hosts the ⌘K palette, the ? shortcuts sheet and the one keyboard-shortcut listener. On a phone
// (below md) the sidebar is hidden entirely — the top bar carries the sidebar's server button (else the
// round mark), and a bottom
// bar within thumb reach holds Overview, Agents, New agent, the orchestrator and Settings (New agent
// centred); every inset clears the notch and the home indicator. What the sidebar alone carried
// (Previews, Repos, Usage, Find, the instance switcher) is reachable from Settings on a phone — see
// MobileNav in views/Pages.tsx.
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Boxes, Check, ChevronsLeft, ChevronsRight, ChevronsUpDown, CircleUser, FolderSync, LayoutGrid, Loader2,
  Bot, Command, Keyboard, Monitor, MonitorPlay, Moon, Plus, RefreshCw, Search, Settings, Sun, X,
  Package, Plug, Inbox, Columns3, Brain,
} from "lucide-react";
import { navigate, useRoute, type Route } from "@/lib/route";
import { addNewOpenAtom, agentQueryAtom, instanceScopeAtom, paletteOpenAtom, repoFilterAtom, shortcutsHelpOpenAtom } from "@/lib/atoms";
import { pageShortcut, shortcutKeys } from "@/lib/shortcuts";
import { CommandPalette, Shortcuts, ShortcutsHelp } from "@/components/CommandPalette";
import { ActivityDot, AskOrchestrator, useOrchestrator, useOrchestratorActivity } from "@/components/Terminal";
import { QuickAsk } from "@/components/QuickAsk";
import { SLIDE_MS } from "@/components/SidePanel";
import { dockClipElementAtom, dockElementAtom, dockWidthAtom, noteDockMotion, useNavToggle } from "@/lib/dock";
import { HeaderUsageMeter } from "@/views/Vitals";
import { CountBadge } from "@/components/console";
import { BridgeLabel, DatabaseBanner, OfflineScreen, StaleIndicator, UpdateBanner } from "@/components/Freshness";
import { useTheme, type Theme } from "@/lib/theme";
import { cn, PortalContainer } from "@/lib/utils";
import { validChoice } from "@/lib/persisted";
import { useSwipeToDismiss } from "@/lib/gestures";
import { isMobile, useNarrow } from "@/lib/viewport";
import { api } from "../api";
import { instanceChoices, thisInstance, undoDraft, useConfigFailed, useRepos, useShowBoard, type OptimisticDraft } from "../store";
import { PANEL_MIN_W, SHELL_GAP, repoLabel, summarizeSync } from "../workstream";
import { PreviewsBadge } from "@/views/PreviewControl";
import { useInboxUnread } from "@/lib/inboxUnread";
import { useHandoffBadge } from "@/lib/handoffBadge";
import { AddServerDialog, Dot, healthText, ServerMenu, ServerOffline, useServerProblem, useServers } from "@/components/ServerMenu";
import { currentServer, type ServerHealth } from "@/lib/server";
import { loadIdentity, profileInitials, useServerIdentity } from "@/lib/identity";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { poll } from "@/lib/poll";
import { NotificationBell, footIcon } from "@/components/Notifications";
import { notifyLocal } from "@/lib/notificationStore";
import { Button } from "@/components/ui/button";
import { MenuShortcut, Shortcut } from "@/components/ui/kbd";
import { Tip } from "@/components/ui/tip";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** One row of the nav: the same height, padding, icon size and hover, ghost on the lower surface
 *  (branch-demo's sidebar). Collapsed, an icon centred in the rail. */
export const navRow = (collapsed: boolean, active = false) => cn(
  "relative flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-sm transition-colors",
  active ? "bg-sidebar-active text-sidebar-active-foreground font-medium" : "text-muted-foreground hover:bg-accent hover:text-foreground",
  collapsed && "md:justify-center md:px-0",
);
export const NAV: { to: string; label: string; Icon: typeof LayoutGrid; match: (r: Route) => boolean; badge?: (compact: boolean) => ReactNode }[] = [
  { to: "/", label: "Overview", Icon: LayoutGrid, match: (r) => r.name === "overview" },
  // An agent's own page (PR or local detail) is "inside" Agents, as a deployment is inside Deployments.
  { to: "/agents", label: "Agents", Icon: Boxes, match: (r) => r.name === "agents" || r.name === "pr" || r.name === "local" },
  // The five lanes of cards (views/Board.tsx). Settings can hide it (`ui.showBoard`, navShown).
  { to: "/board", label: "Board", Icon: Columns3, match: (r) => r.name === "board" },
  // Every integration's inbound messages and events, one timeline (views/Inbox.tsx).
  // Orca's own notifications are rows here too; its count is the bell's (lib/inboxUnread.ts).
  { to: "/inbox", label: "Inbox", Icon: Inbox, match: (r) => r.name === "inbox", badge: (compact) => <InboxBadge compact={compact} /> },
  // What the agents keep across resets (views/Memory.tsx): read, edit, pin, revert.
  { to: "/memory", label: "Memory", Icon: Brain, match: (r) => r.name === "memory" },
  // The previews (and Test master) page; its badges are what the two header buttons used to carry.
  { to: "/previews", label: "Previews", Icon: MonitorPlay, match: (r) => r.name === "previews", badge: (compact) => <PreviewsBadge compact={compact} /> },
  { to: "/integrations", label: "Integrations", Icon: Plug, match: (r) => r.name === "integrations" },
  // Its count is outgoing packs waiting for the user to send them (lib/handoffBadge.ts).
  { to: "/handoffs", label: "Handoffs", Icon: Package, match: (r) => r.name === "handoffs", badge: (compact) => <HandoffsBadge compact={compact} /> },
  // Repos and GitHub are sections of Settings.
  { to: "/settings", label: "Settings", Icon: Settings, match: (r) => r.name === "settings" },
];

/** Whether a nav entry shows: the Board's only while the config's `ui.showBoard` is on. */
export const navShown = (to: string, showBoard: boolean) => to !== "/board" || showBoard;

/** The docked right column (desktop): its OWN card beside the page card, as branch-demo's right panel
 *  — the shell's gutter between them, no shared hairline. The open side panel renders INTO it
 *  (SidePanel's portal) at its full width; only the width and the start margin animate (branch-demo's
 *  150ms ease-out; the min-width tweens with the width, so an open never pops to it) and the card clips the panel, so the panel slides and never
 *  reflows. Closed, a negative start margin cancels the gutter (a 0-wide flex item still takes the gap). The card's
 *  surface stays until the close has finished (`painted`), so its edge does not vanish mid-slide.
 *  The clip is an inner element, not the dock: the resize handle hangs in the gutter, outside the card. */
export function Dock() {
  const dock = useAtomValue(dockWidthAtom);
  const setDockElement = useSetAtom(dockElementAtom);
  const setDockClip = useSetAtom(dockClipElementAtom);
  const [painted, setPainted] = useState(dock > 0);
  if (dock > 0 && !painted) setPainted(true);
  useEffect(() => {
    if (dock > 0 || !painted) return;
    const t = setTimeout(() => setPainted(false), SLIDE_MS + 150); // no transition ran (reduced motion)
    return () => clearTimeout(t);
  }, [dock, painted]);
  return (
    <div data-slot="dock" ref={setDockElement}
      onTransitionEnd={(e) => { if (e.target === e.currentTarget && e.propertyName === "width" && dock === 0) setPainted(false); }}
      // Its `class` NEVER changes: Tailwind Typography's prose rules end in
      // `:not(:where([class~="not-prose"], [class~="not-prose"] *))`, so a class change on ANY ancestor
      // of the chat restyles its whole subtree (measured: ~4000 elements, 100–150ms each at 4× CPU, twice
      // per open / close). The margin is an inline style; the card's surface rides `data-painted`.
      data-painted={painted ? "" : undefined}
      className="relative shrink-0 transition-[width,min-width,margin-inline-start] ease-out data-[resizing]:transition-none motion-reduce:transition-none max-md:hidden md:data-[painted]:rounded-[10px] md:data-[painted]:bg-background md:data-[painted]:shadow-shell"
      style={{ width: dock, minWidth: dock > 0 ? Math.min(PANEL_MIN_W, dock) : 0, marginInlineStart: dock > 0 ? 0 : -SHELL_GAP, transitionDuration: `${SLIDE_MS}ms` }}>
      <div data-slot="dock-clip" ref={setDockClip} className="absolute inset-0 overflow-hidden rounded-[inherit]" />
    </div>
  );
}

/** Feeds lib/dock's motion flag from the shell's own width transitions (the dock, the nav's rail). */
function useDockMotion(shell: HTMLElement | null) {
  useEffect(() => {
    if (!shell) return;
    const ours = (e: TransitionEvent) => e.propertyName === "width" && e.target instanceof HTMLElement
      && (e.target.dataset.slot === "dock" || e.target.dataset.slot === "sidebar");
    const run = (e: TransitionEvent) => { if (ours(e)) noteDockMotion(1); };
    const end = (e: TransitionEvent) => { if (ours(e)) noteDockMotion(-1); };
    shell.addEventListener("transitionrun", run);
    shell.addEventListener("transitionend", end);
    shell.addEventListener("transitioncancel", end);
    return () => { shell.removeEventListener("transitionrun", run); shell.removeEventListener("transitionend", end); shell.removeEventListener("transitioncancel", end); };
  }, [shell]);
}

/** `sidebarActions` renders the last of the sidebar's actions (Add New), above the divider and you;
 *  it is told whether the sidebar is collapsed, so it can drop to an icon. */
export function Shell({ crumbs, sidebarActions, children }: {
  crumbs: ReactNode; sidebarActions?: (collapsed: boolean) => ReactNode; children: ReactNode;
}) {
  // The nav renders as its icon rail by your choice OR while the docked right column needs the room
  // (lib/dock.ts); either way the page column keeps at least DOCK_PAGE_MIN_W.
  const { rail: collapsed, setRail } = useNavToggle();
  const offline = useConfigFailed();
  const serverProblem = useServerProblem(offline); // another server chosen, and it is offline or refuses us
  useShellFallbacks();
  const activity = useOrchestratorActivity(); // the ONE subscriber feeding every launcher's indicator
  const route = useRoute();
  const identity = useServerIdentity(); // the ACTIVE server's name and colour (lib/identity.ts applies them)
  const { visible: serverMenu } = useServers();
  const narrow = useNarrow();
  const [shellEl, setShellEl] = useState<HTMLElement | null>(null);
  useDockMotion(shellEl);
  useEffect(() => poll(loadIdentity, 60_000), []);
  return (
    // Desktop: branch-demo's app shell. The nav sits on the LOWER surface — the canvas, in the
    // server's theme colour — and the page and the docked panel float together in ONE rounded card
    // (`data-slot="shell-card"`, a 6px gutter, a 10px corner, `shadow-shell`), so the nav reads as
    // behind the content. A phone has no card: the page is the whole screen.
    <div data-slot="shell" ref={setShellEl} className="md:bg-sidebar flex min-h-screen w-full flex-col md:h-screen md:overflow-hidden">
      {/* The row on the canvas: the nav, then the page card and the panel card, the shell's gutter
          between the cards and round them (branch-demo's p-shell / gap-shell). */}
      <div data-slot="shell-row" className="flex min-h-0 w-full flex-1 md:gap-1.5 md:py-1.5 md:pr-1.5">
      {/* Desktop only: a phone's nav is the bottom bar + Settings (see MobileNav in views/Pages.tsx) —
          there is no off-canvas drawer any more. */}
      <aside
        data-slot="sidebar" data-chrome="" data-collapsed={collapsed}
        className={cn(
          "z-50 max-md:hidden md:flex md:shrink-0 md:flex-col md:overflow-hidden md:transition-[width] md:duration-150 md:ease-out motion-reduce:transition-none",
          collapsed ? "md:w-14" : "md:w-60",
        )}
      >
        <Sidebar collapsed={collapsed} onToggle={() => setRail(!collapsed)} actions={sidebarActions} />
      </aside>
      <div data-slot="shell-card" className="relative flex min-w-0 flex-1 md:overflow-hidden md:rounded-[10px] md:bg-background md:shadow-shell">
      {/* The page column scrolls on its own on a desktop (md:h-screen + overflow), as each column of an
          app shell does: the docked panel then sits flush against the window's edge, with no page
          scrollbar outside it (the gutter is reserved here, not on <html>; its children never shrink to
          fit the column's height — the top bar did). A phone keeps the window's own scroll (its keyboard and pull-to-refresh
          code read window.scrollY). Inside it, the page FRAME is the `@container/page` the pages'
          layouts query, so they respond to the room the dock leaves, not to the window. While the dock
          or the nav animates, the frame follows the card edge in every frame — no hold at an end width
          (Finn: the content must move WITH the edge). Only CSS moves: no React state per frame. */}
      {/* `contain: layout paint` on a desktop: while the dock or the nav animates, the page's reflow and
          repaint stay inside this column. (A `fixed` descendant would now be placed against this box —
          the page has none; the Agents row's right-click anchor is portaled to <body>.) */}
      <div data-slot="page-scroll" className="flex min-w-0 flex-1 flex-col md:h-full md:overflow-x-hidden md:overflow-y-auto md:[scrollbar-gutter:stable] md:[contain:layout_paint]">
      <div data-slot="page-frame" className="@container/page flex min-w-0 flex-1 shrink-0 flex-col md:*:shrink-0 md:[contain:layout_paint]">
        {/* The update bar floats at the top centre of the page column (zero height, sticky), so it covers
            neither the nav nor the docked panel and never moves the layout. */}
        <UpdateBanner />
        {/* Opaque, not a translucent blur: scrolled content (a long diff, the PR comments) showed through it.
            The header always clears the notch: the update bar floats over it. */}
        {/* On a desktop the top bar is part of the card (neutral); on a phone it is the themed frame. */}
        {/* A phone's conversation pages (the orchestrator, an agent's page) have no top bar: the chat
            gets its 56px, and each page's own header carries Back (Finn: the chat got too little of
            the screen). The bottom bar stays, so every page is still one tap away. */}
        <header
          data-slot="topbar" data-chrome={narrow ? "" : undefined}
          className={cn(
            "bg-background sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 md:px-6 max-md:gap-2 max-md:px-[max(1rem,env(safe-area-inset-left))]",
            "max-md:h-[calc(3.5rem+env(safe-area-inset-top))] max-md:pt-[env(safe-area-inset-top)]",
            phoneBarePage(route) && "max-md:hidden",
          )}
        >
          {/* The phone has no sidebar: the sidebar's own server button stands in for the mark when
              there is a server to switch to or add; else the mark and the server's name. */}
          {narrow && serverMenu ? <ServerButton collapsed={false} place="header" /> : <>
            <button type="button" data-slot="topbar-mark" onClick={() => navigate("/")} aria-label="Orca — go to overview" className="flex size-8 shrink-0 items-center justify-center md:hidden"><RoundMark /></button>
            {identity && <span data-slot="topbar-identity" className="text-server-fg truncate text-sm font-medium md:hidden">{identity.label}</span>}
          </>}
          <RepoSwitcher />
          {/* A phone keeps the page name: the crumbs never shrink under 4.5rem (they truncate), and the
              server and repo menus shrink first. */}
          <nav aria-label="Breadcrumb" className="text-muted-foreground flex min-w-0 items-center gap-2 text-sm max-md:min-w-[4.5rem]">{crumbs}</nav>
          <span className="contents max-md:ml-auto max-md:flex max-md:shrink-0 max-md:items-center max-md:gap-2"><BridgeLabel /><StaleIndicator /></span>
          {/* A reserved slot, not a margin on whichever of these happens to render first: the usage
              meter is absent while loading or with nothing signed in, and ml-auto on it alone left
              "Ask the orchestrator" stuck against the breadcrumbs until the meter appeared. */}
          <div className="ml-auto flex shrink-0 items-center gap-3 max-md:hidden">
            <HeaderUsageMeter />
            <AskOrchestrator />
          </div>
        </header>
        <DatabaseBanner />
        <main className="w-full flex-1 px-4 py-6 md:px-6 max-md:min-w-0 max-md:px-[max(1rem,env(safe-area-inset-left))] max-md:pb-[calc(5.5rem+env(safe-area-inset-bottom))]">
          {serverProblem && <ServerOffline configFailed={offline} />}
          {offline ? (serverProblem ? null : <OfflineScreen />) : children}
        </main>
      </div>
      </div>
      {/* The quick-ask pill, bottom centre of the page CARD on every page but an agent's Chat tab
          (desktop; the phone's bottom bar has the orchestrator). Placed by the card, not by a copy of
          the dock's transition: it moves with the card edge in the same frames — an open, a close, the
          nav's rail, a resize drag or key. */}
      {!chatTab(route) && <QuickAsk />}
      </div>
      <Dock />
      </div>
      <BottomBar activity={activity} />
      <Shortcuts />
      <CommandPalette />
      <ShortcutsHelp />
      <AddServerDialog />
    </div>
  );
}

/** An agent page's Chat tab: its composer fills the viewport's foot, so the quick-ask pill (which
 *  floats there) would sit on top of it — the tab is a conversation already, the pill is hidden. */
export const chatTab = (route: Route) => (route.name === "pr" || route.name === "local") && route.sub === "chat";

/** The pages a phone shows WITHOUT the top bar: the orchestrator and an agent's page. Each has its
 *  own header with a Back button, and the bottom bar keeps the navigation. Desktop never reads it. */
export const phoneBarePage = (route: Route) => route.name === "orchestrator" || route.name === "pr" || route.name === "local";

/** "/" then a page name, Vercel's top-bar breadcrumb. */
export const Crumb = ({ children, to }: { children: ReactNode; to?: string }) => (
  <>
    <span className="text-border select-none" aria-hidden="true">/</span>
    {to ? <button type="button" onClick={() => navigate(to)} className="hover:text-foreground truncate max-md:py-1.5">{children}</button>
      : <span className="text-foreground truncate" aria-current="page">{children}</span>}
  </>
);

function Sidebar({ collapsed, onToggle, actions }: {
  collapsed: boolean; onToggle: () => void; actions?: (collapsed: boolean) => ReactNode;
}) {
  const route = useRoute();
  const narrow = useNarrow();
  const showBoard = useShowBoard();
  return (
    <>
      <div className="flex h-14 items-center gap-2 px-3">
        <ServerButton collapsed={collapsed} />
      </div>
      {!collapsed && <div className="px-3 pb-2"><FindBox /></div>}
      <nav aria-label="Main" className="flex flex-col gap-0.5 px-2 py-1">
        {NAV.filter((n) => navShown(n.to, showBoard)).map(({ to, label, Icon, match, badge }) => {
          const active = match(route);
          const shortcut = pageShortcut(to);
          const item = (
            <button key={to} type="button" onClick={() => navigate(to)} aria-current={active ? "page" : undefined}
              aria-keyshortcuts={shortcut ? shortcutKeys(shortcut).join(" ") : undefined}
              className={navRow(collapsed, active)}>
              <Icon className="size-4 shrink-0" />
              <span data-slot="nav-label" className={cn(collapsed && "md:hidden")}>{label}</span>
              {badge?.(collapsed)}
              {/* G then a letter: always-visible muted keycaps, like Find / Add New. Never on a phone
                  or a touch screen (no keyboard to press them with); collapsed, the tooltip carries them. */}
              {shortcut && !collapsed && (
                <Shortcut id={shortcut} className={cn("max-md:hidden [@media(pointer:coarse)]:hidden", !badge && "ml-auto")} />
              )}
            </button>
          );
          // Collapsed to icons: the label and its keycaps as the tooltip, to the icon's right.
          return collapsed && !narrow ? <Tip key={to} label={label} shortcut={shortcut} side="right" className="flex">{item}</Tip> : item;
        })}
      </nav>
      {/* Add New is the last of the actions — pushed to the bottom, just above you. An outline button,
          full width, on the lower surface: it stands apart from the nav rows above it. */}
      <div data-slot="sidebar-actions" className="mt-auto px-2 pb-2">
        {actions?.(collapsed)}
      </div>
      {/* The foot, like branch-demo's: you (a ghost row with a chevron, it opens a menu) and the bell and
          the collapse toggle as ghost icons — no divider above it. Collapsed, one centred column with
          the toggle on top, so nothing overlaps. */}
      <div data-slot="sidebar-foot" className="px-2 pb-2">
        <div data-slot="sidebar-you" className={cn("flex items-center gap-0.5", collapsed && "md:flex-col-reverse md:gap-1")}>
          <ProfileMenu collapsed={collapsed} />
          <NotificationBell collapsed={collapsed} />
          <Tip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} shortcut="sidebar" className="hidden md:inline-flex">
            <button type="button" onClick={onToggle} className={footIcon}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
              {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
            </button>
          </Tip>
        </div>
      </div>
    </>
  );
}

// The mark: a geometric orca silhouette (single-fill, currentColor, eye punched out via evenodd). The
// "Soft" mark: a same-colour round stroke rounds every join. The transform is favicon.svg's, scaled
// 1.5× about the centre, so inside RoundMark (16px in 24px) it sits exactly as it does in the favicon.
export function OrcaMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={0.9} strokeLinejoin="round" fillRule="evenodd" className={className} aria-hidden="true">
      <path transform="translate(-0.78 0.375) scale(1.05)" d="M2.6 12.1C2.6 9.7 5.5 8 9 8L11.4 3L13.8 8C16.6 8 18.7 8.6 20.3 9.5L22.6 6.3L21 11L22.6 15.7L20.3 12.5C17.5 13.6 10.5 14.2 4.4 13.5C3.3 13.37 2.6 12.9 2.6 12.1ZM5.9 9.25a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0 -3Z" />
    </svg>
  );
}

/** The mark inside a circle — Vercel's round avatar logo: the circle a very dark shade of the active
 *  server's theme colour (`--server-mark-bg`), the orca the colour (`--server-mark`); the favicon
 *  matches it. Neutral: a black circle and a white orca. */
export const RoundMark = ({ className }: { className?: string }) => (
  <span data-slot="round-mark" className={cn("text-server-mark inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-server-mark-bg", className)}>
    <OrcaMark className="size-4" />
  </span>
);

/** "Orca | <name>" beside the mark, as the page title reads: a thin muted pipe with even space on each
 *  side. The sidebar and Settings' identity preview both use it, so they cannot differ. */
export const BrandName = ({ label, labelClass, labelSlot = "server-identity", className }: { label?: string; labelClass?: string; labelSlot?: string; className?: string }) => (
  <span data-slot="brand-name" className={cn("flex min-w-0 items-baseline gap-1.5", className)}>
    <span className="shrink-0">Orca</span>
    {label && <>
      <span aria-hidden="true" data-slot="brand-sep" className="text-muted-foreground/60 shrink-0 font-light">|</span>
      <span data-slot={labelSlot} className={cn("truncate", labelClass)}>{label}</span>
    </>}
  </span>
);

/** The phone's bottom bar (below md only; the active page and New agent in the server's theme): what a thumb needs — Overview, Agents, New agent, the
 *  orchestrator and Settings, New agent centred — at the foot of the screen, above the home indicator.
 *  Everything else the old hamburger drawer exposed (Previews, Repos, Usage, Find, the instance
 *  switcher) now lives in Settings — see MobileNav in views/Pages.tsx. */
function BottomBar({ activity }: { activity: { running: boolean; unread: boolean } }) {
  const route = useRoute();
  const [, setAddNew] = useAtom(addNewOpenAtom);
  const { ask } = useOrchestrator();
  const item = "text-muted-foreground flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium";
  const label = "truncate";
  const overview = NAV[0]!;
  const agents = NAV[1]!;
  const settings = NAV.find((n) => n.to === "/settings")!;
  return (
    <nav aria-label="Quick actions" data-slot="bottom-bar"
      className="bg-background/95 fixed inset-x-0 bottom-0 z-30 flex items-stretch gap-1 border-t px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] backdrop-blur md:hidden">
      <button type="button" className={cn(item, overview.match(route) && "text-server-fg")} aria-current={overview.match(route) ? "page" : undefined} onClick={() => navigate(overview.to)}><overview.Icon className="size-5" /><span className={label}>{overview.label}</span></button>
      <button type="button" className={cn(item, agents.match(route) && "text-server-fg")} aria-current={agents.match(route) ? "page" : undefined} onClick={() => navigate("/agents")}><Boxes className="size-5" /><span className={label}>Agents</span></button>
      <button type="button" className={cn(item, "text-foreground")} onClick={() => setAddNew(true)}>
        <span className="bg-primary text-primary-foreground inline-flex size-6 items-center justify-center rounded-full"><Plus className="size-4" /></span><span className={label}>New agent</span>
      </button>
      {/* The orchestrator, carrying the activity dot the desktop's quick-ask pill shows (there is no pill below md).
          `ask()` routes here to /orchestrator on a narrow screen rather than opening the side panel. */}
      <button type="button" className={cn(item, "relative", route.name === "orchestrator" && "text-server-fg")} aria-current={route.name === "orchestrator" ? "page" : undefined} onClick={() => ask()}>
        <Bot className="size-5" /><ActivityDot activity={activity} className="absolute top-1.5 right-[calc(50%-0.9rem)]" /><span className={label}>Orca</span>
      </button>
      <button type="button" className={cn(item, settings.match(route) && "text-server-fg")} aria-current={settings.match(route) ? "page" : undefined} onClick={() => navigate("/settings")}><Settings className="size-5" /><span className={label}>Settings</span></button>
    </nav>
  );
}

// The repo and instance scopes are restored from localStorage before the config lands; once it has,
// a saved repo or instance that no longer exists goes back to "all" (never a page filtered to nothing).
function useShellFallbacks() {
  const repos = useRepos();
  const [repo, setRepo] = useAtom(repoFilterAtom);
  const [scope, setScope] = useAtom(instanceScopeAtom);
  const here = thisInstance(); // set once the config has landed (useRepos re-renders on it)
  useEffect(() => {
    if (repos.length && validChoice(repo, repos.map((r) => r.name), "all") !== repo) setRepo("all");
  }, [repos, repo, setRepo]);
  useEffect(() => {
    if (here && validChoice(scope, instanceChoices(), "all") !== scope) setScope("all");
  }, [here, repos, scope, setScope]);
}

// The sidebar's top-left button: the orca mark with the active server's status dot at its corner
// (ServerMenu's `Dot`, so a server reads the same colour everywhere), "Orca | <name>" and a chevron —
// never a link to Overview (the nav's own Overview item already does that). It opens the server menu
// (ServerMenu.tsx): the servers, the current one checked, then Add server. With nothing to switch to
// or add (`showServerMenu`), it is the same mark and name with no menu. A phone's top bar renders this
// SAME button (`place="header"`) in place of its bare mark. The instance scope is not here: the
// command palette and Settings on a phone set it.
function ServerButton({ collapsed, place = "sidebar" }: { collapsed: boolean; place?: "sidebar" | "header" }) {
  const { servers, visible } = useServers();
  const identity = useServerIdentity();
  const look = cn("flex min-w-0 items-center gap-2 rounded-md p-1", place === "sidebar" ? "flex-1" : "shrink", collapsed && "md:justify-center");
  const face = (label: string | undefined, health: ServerHealth, chevron: boolean) => (
    <>
      <span className="relative inline-flex shrink-0">
        <RoundMark />
        <Dot health={health} className="absolute -right-0.5 -bottom-0.5" />
      </span>
      {!collapsed && <BrandName label={label} labelClass="text-server-fg" className="min-w-0 flex-1 text-left text-sm font-medium" />}
      {!collapsed && chevron && <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />}
    </>
  );
  const menu = (
    <ServerMenu trigger={(current) => (
      <button type="button" data-slot={place === "header" ? "topbar-server-menu" : "server-menu"} className={cn("hover:bg-accent", look)}
        aria-label={`Server: ${current.label}, ${healthText(current.health)}. Switch server`}>
        {face(current.label, current.health, true)}
      </button>
    )} />
  );
  if (visible) return menu;
  return <div data-slot="server-brand" className={look}>{face(identity?.label, currentServer(servers).health, false)}</div>;
}

// Find: searches the agents list. Typing here filters /agents (going there if needed); "F" anywhere
// outside a text field focuses it, as on Vercel (components/CommandPalette.tsx's Shortcuts).
export function FindBox() {
  const [q, setQ] = useAtom(agentQueryAtom);
  return (
    <label className="bg-card focus-within:ring-ring/40 flex h-8 items-center gap-2 rounded-md border px-2 focus-within:ring-2">
      <Search className="text-muted-foreground size-3.5 shrink-0" />
      <Input value={q} aria-label="Find agents" placeholder="Find…"
        onChange={(e) => { setQ(e.target.value); if (location.pathname !== "/agents") navigate("/agents"); }}
        className="h-auto rounded-none border-0 bg-transparent px-0 py-0 focus-visible:ring-0 flex-1 md:text-sm" />
      <Shortcut id="find" />
    </label>
  );
}

// The top bar's context switcher (Vercel's "All Projects ▾"): the repo scope, shared with the
// Overview and the Agents filters. Hidden with a single repo.
function RepoSwitcher() {
  const repos = useRepos();
  const [repo, setRepo] = useAtom(repoFilterAtom);
  if (repos.length <= 1) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-slot="repo-switcher" className="hover:bg-accent flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium max-md:min-w-0 max-md:max-w-[8rem] max-md:shrink">
          <span className="truncate">{repo === "all" ? "All repos" : repoLabel(repos, repo)}</span> <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12rem]">
        <DropdownMenuRadioGroup value={repo} onValueChange={setRepo}>
          <DropdownMenuRadioItem value="all">All repos</DropdownMenuRadioItem>
          {repos.map((r) => <DropdownMenuRadioItem key={r.name} value={r.name}>{repoLabel(repos, r.name)}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Vercel's "Add New…": a proper dialog, not a popover — the New-draft box is a whole composer (repo,
 *  model, attachments, the # picker, New chat). Native <dialog> like Rename / New chat, so Esc and
 *  the backdrop close it, and it is the portal container for the composer's selects (a modal dialog
 *  makes the rest of the page inert — a select rendered into <body> would be unclickable). Sending
 *  closes it and raises a "Sent" side notification (the one toast surface — Notifications.tsx) with
 *  Undo and Open, instead of a bottom-centre toast of its own. `C` (and the palette's
 *  New agent, and the phone's bottom-bar New agent button) opens it from anywhere outside a text
 *  field — `addNewOpenAtom`. The typed draft persists either way (the composer's persistKey).
 *  The trigger button is rendered where `sidebarActions` places it (the sidebar, desktop only), but
 *  the <dialog> itself is portaled to `document.body`: a descendant of an ancestor with
 *  `display: none` (the sidebar's `max-md:hidden` <aside>) never promotes to the top layer, so
 *  `showModal()` opened it with nothing visible on a phone even though `.open` read true. */
export function AddNew({ children, collapsed = false }: { children: (onSent: (draft: OptimisticDraft) => void) => ReactNode; collapsed?: boolean }) {
  const [open, setOpen] = useAtom(addNewOpenAtom);
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // showModal focuses the first focusable control (the close button): start in the textarea —
      // except on mobile, where opening this dialog must not pop the on-screen keyboard on its own.
      if (!isMobile()) dialog.querySelector("textarea")?.focus();
    } else if (!open && dialog.open) dialog.close();
  }, [open, dialog]);
  const onSent = (draft: OptimisticDraft) => {
    setOpen(false);
    notifyLocal({
      kind: "draft_sent", repo: draft.repo, title: draft.title,
      body: `Sent to ${draft.repo}`,
      onUndo: () => { void undoDraft(draft); },
      onOpen: () => { if (draft.created) navigate(`/${draft.repo}/local/${encodeURIComponent(draft.created.branch)}`); },
    });
  };
  // A phone's full-screen sheet: swipe its header down, or its body once that is scrolled to the top.
  const swipe = useSwipeToDismiss("bottom", () => dialog, () => setOpen(false), { enabled: useNarrow(), body: dialog });
  return (
    <>
      <Tip label="Add New" shortcut="new" side="right" className="flex w-full">
        <Button variant="outline" data-slot="add-new" aria-label="Add New" onClick={() => setOpen(true)}
          className={cn("h-9 w-full justify-start gap-3 px-2.5 has-[>svg]:px-2.5 text-sm font-normal", collapsed && "md:justify-center md:px-0 md:has-[>svg]:px-0")}>
          <Plus className="size-4 shrink-0" /><span className={cn(collapsed && "md:hidden")}>Add New</span>
          <Shortcut id="new" className={cn("ml-auto max-md:hidden [@media(pointer:coarse)]:hidden", collapsed && "md:hidden")} />
        </Button>
      </Tip>
      {createPortal(
        <dialog
          ref={setDialog} data-slot="add-new-dialog" aria-label="New agent"
          onClose={() => setOpen(false)} onCancel={() => setOpen(false)}
          onClick={(e) => { if (e.target === dialog) setOpen(false); }} // backdrop click
          className="bg-card text-foreground m-auto mt-[12vh] w-[92vw] max-w-2xl rounded-lg border p-0 shadow-modal backdrop:bg-black/50 max-md:sheet"
        >
          <PortalContainer.Provider value={dialog ?? undefined}>
            <header {...swipe} className="flex h-12 items-center justify-between border-b px-4 max-md:touch-none">
              <h2 className="text-sm font-medium">New agent</h2>
              <Button size="icon" variant="ghost" className="size-7" onClick={() => setOpen(false)} aria-label="Close"><X className="size-4" /></Button>
            </header>
            <div className="space-y-3 p-4 [&_textarea]:min-h-32">
              <p className="text-muted-foreground text-xs">Describe a feature, pick a repo and a model — Auto lets the orchestrator write the brief and choose.</p>
              {open && children(onSent)}
            </div>
          </PortalContainer.Provider>
        </dialog>,
        document.body,
      )}
    </>
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
    >
      <Icon className={`size-3.5${state === "loading" ? " animate-spin" : ""}`} /> Sync worktrees
      {summary && <span className="text-muted-foreground ml-auto pl-3 text-xs">{summary}</span>}
    </DropdownMenuItem>
  );
}

export const THEMES: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

// The signed-in Tailscale user, at the foot of the sidebar: refresh the app, sync worktrees, the theme.
export function ProfileMenu({ collapsed = false }: { collapsed?: boolean }) {
  const [theme, setTheme] = useTheme();
  const setPalette = useSetAtom(paletteOpenAtom);
  const setHelp = useSetAtom(shortcutsHelpOpenAtom);
  const identity = useServerIdentity();
  const user = identity?.tailscaleUser;
  // Off the tailnet, a tagged device, or before the first /api/servers answer lands: "You", as before.
  const label = user?.login ?? "You";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-slot="profile" className={cn("hover:bg-accent flex h-9 min-w-0 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors", collapsed ? "md:size-9 md:justify-center md:p-0" : "flex-1")} aria-label="Profile menu">
          <Avatar className="size-5">
            {user?.picture && <AvatarImage src={user.picture} alt="" />}
            <AvatarFallback>{user ? profileInitials(user.name, user.login) : <CircleUser className="size-3.5" />}</AvatarFallback>
          </Avatar>
          <span data-slot="profile-label" className={cn("min-w-0 flex-1 truncate", collapsed && "md:hidden")}>{label}</span>
          {/* It opens a menu: the chevron at the far right, as branch-demo's user row. */}
          <ChevronsUpDown className={cn("text-muted-foreground ml-auto size-3.5 shrink-0", collapsed && "md:hidden")} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuItem onSelect={() => window.location.reload()}>
          <RefreshCw className="size-3.5" /> Refresh
        </DropdownMenuItem>
        <SyncWorktreesItem />
        <DropdownMenuSeparator />
        {/* The keyboard's two overlays, findable without knowing their keys. */}
        <DropdownMenuItem data-slot="open-palette" onSelect={() => setPalette(true)}>
          <Command className="size-3.5" /> Command palette <MenuShortcut id="palette" />
        </DropdownMenuItem>
        <DropdownMenuItem data-slot="open-shortcuts" onSelect={() => setHelp(true)}>
          <Keyboard className="size-3.5" /> Keyboard shortcuts <MenuShortcut id="help" />
        </DropdownMenuItem>
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

/** The Handoffs nav item's count: outgoing packs made here and not sent yet. The phone's Settings
 *  → Navigate link shows it too. */
export function HandoffsBadge({ compact = false }: { compact?: boolean }) {
  const count = useHandoffBadge();
  // At zero it still holds the row's right edge, so the keycap after it stays where it was.
  if (!count) return compact ? null : <span className="ml-auto" />;
  return <CountBadge count={count} placement={compact ? "compact" : "inline"} slot="handoffs-count" label="packs waiting to send" />;
}

/** The Inbox nav item's unread count: the one count the bell shows too. */
function InboxBadge({ compact = false }: { compact?: boolean }) {
  const unread = useInboxUnread();
  // At zero it still holds the row's right edge, so the keycap after it stays where it was.
  if (!unread) return compact ? null : <span className="ml-auto" />;
  return <CountBadge count={unread} placement={compact ? "compact" : "inline"} slot="inbox-unread-count" />;
}
