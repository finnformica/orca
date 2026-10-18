// The console shell, Vercel's: a left sidebar (instance switcher, Find, the nav, you at the bottom)
// that collapses to icons on desktop, and a top bar with the repo
// context switcher, a breadcrumb and, on the right, a compact Claude usage meter then "Ask the
// orchestrator" (on every page). It also
// hosts the ⌘K palette, the ? shortcuts sheet and the one keyboard-shortcut listener. On a phone
// (below md) the sidebar is hidden entirely — the top bar carries only the round mark, and a bottom
// bar within thumb reach holds Overview, Agents, New agent, the orchestrator and Settings (New agent
// centred); every inset clears the notch and the home indicator. What the sidebar alone carried
// (Previews, Repos, Usage, Find, the instance switcher) is reachable from Settings on a phone — see
// MobileNav in views/Pages.tsx.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Boxes, Check, ChevronsLeft, ChevronsRight, ChevronsUpDown, CircleUser, FolderSync, LayoutGrid, Loader2,
  Bot, Command, Keyboard, Monitor, MonitorPlay, Moon, Plus, RefreshCw, Search, Settings, Sun, X,
  Package, Plug,
} from "lucide-react";
import { navigate, useRoute, type Route } from "@/lib/route";
import { addNewOpenAtom, agentQueryAtom, instanceScopeAtom, paletteOpenAtom, repoFilterAtom, shortcutsHelpOpenAtom } from "@/lib/atoms";
import { pageShortcut, shortcutKeys } from "@/lib/shortcuts";
import { CommandPalette, Shortcuts, ShortcutsHelp } from "@/components/CommandPalette";
import { ActivityDot, AskOrchestrator, useOrchestrator, useOrchestratorActivity } from "@/components/Terminal";
import { QuickAsk } from "@/components/QuickAsk";
import { SLIDE_MS } from "@/components/SidePanel";
import { dockElementAtom, dockWidthAtom, useNavToggle } from "@/lib/dock";
import { HeaderUsageMeter } from "@/views/Vitals";
import { BridgeLabel, DatabaseBanner, OfflineScreen, StaleIndicator, UpdateBanner } from "@/components/Freshness";
import { useTheme, type Theme } from "@/lib/theme";
import { cn, PortalContainer } from "@/lib/utils";
import { validChoice } from "@/lib/persisted";
import { useSwipeToDismiss } from "@/lib/gestures";
import { isMobile, useNarrow } from "@/lib/viewport";
import { api } from "../api";
import { instanceChoices, thisInstance, undoDraft, useConfigFailed, useRepos, type OptimisticDraft } from "../store";
import { repoLabel, summarizeSync } from "../workstream";
import { PreviewsBadge } from "@/views/PreviewControl";
import { AddServerDialog, ServerMenu, ServerOffline, useServerProblem, useServers } from "@/components/ServerMenu";
import { loadIdentity, useServerIdentity } from "@/lib/identity";
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

/** One row of the nav: the pages, and Add New below them — the same height, padding, icon size and
 *  hover, ghost on the lower surface (branch-demo's sidebar). Collapsed, an icon centred in the rail. */
export const navRow = (collapsed: boolean, active = false) => cn(
  "relative flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-sm transition-colors",
  active ? "bg-sidebar-active text-sidebar-active-foreground font-medium" : "text-muted-foreground hover:bg-accent hover:text-foreground",
  collapsed && "md:justify-center md:px-0",
);
export const NAV: { to: string; label: string; Icon: typeof LayoutGrid; match: (r: Route) => boolean; badge?: (compact: boolean) => ReactNode }[] = [
  { to: "/", label: "Overview", Icon: LayoutGrid, match: (r) => r.name === "board" },
  // An agent's own page (PR or local detail) is "inside" Agents, as a deployment is inside Deployments.
  { to: "/agents", label: "Agents", Icon: Boxes, match: (r) => r.name === "agents" || r.name === "pr" || r.name === "local" },
  // The previews (and Test master) page; its badges are what the two header buttons used to carry.
  { to: "/previews", label: "Previews", Icon: MonitorPlay, match: (r) => r.name === "previews", badge: (compact) => <PreviewsBadge compact={compact} /> },
  { to: "/integrations", label: "Integrations", Icon: Plug, match: (r) => r.name === "integrations" },
  { to: "/handoffs", label: "Handoffs", Icon: Package, match: (r) => r.name === "handoffs" },
  // Repos and GitHub are sections of Settings.
  { to: "/settings", label: "Settings", Icon: Settings, match: (r) => r.name === "settings" },
];

/** The docked right column (desktop), inside the card beside the page: the open side panel renders
 *  INTO it (SidePanel's portal) at its full width. Only this width animates, 0 ↔ the panel's width,
 *  and it clips the panel — so the page reflows in the same frame, with no overlay. */
export function Dock() {
  const dock = useAtomValue(dockWidthAtom);
  const setDockElement = useSetAtom(dockElementAtom);
  return (
    <div data-slot="dock" ref={setDockElement}
      className="relative shrink-0 overflow-hidden transition-[width] ease-out data-[resizing]:transition-none motion-reduce:transition-none max-md:hidden"
      style={{ width: dock, transitionDuration: `${SLIDE_MS}ms` }} />
  );
}

/** `sidebarActions` renders the last of the sidebar's actions (Add New), above the divider and you;
 *  it is told whether the sidebar is collapsed, so it can drop to an icon. */
export function Shell({ crumbs, sidebarActions, children }: {
  crumbs: ReactNode; sidebarActions?: (collapsed: boolean) => ReactNode; children: ReactNode;
}) {
  // The nav renders as its icon rail by your choice OR while the docked right column needs the room
  // (lib/dock.ts); either way the page column keeps at least DOCK_PAGE_MIN_W.
  const { rail: collapsed, setRail } = useNavToggle();
  const [updateAvailable, setUpdateAvailable] = useState(false); // the banner, when shown, is topmost and clears the notch itself
  const offline = useConfigFailed();
  const serverProblem = useServerProblem(offline); // another server chosen, and it is offline or refuses us
  useShellFallbacks();
  const activity = useOrchestratorActivity(); // the ONE subscriber feeding every launcher's indicator
  const route = useRoute();
  const identity = useServerIdentity(); // the ACTIVE server's name and colour (lib/identity.ts applies them)
  const { visible: serverMenu } = useServers();
  const narrow = useNarrow();
  useEffect(() => poll(loadIdentity, 60_000), []);
  return (
    // Desktop: branch-demo's app shell. The nav sits on the LOWER surface — the canvas, in the
    // server's theme colour — and the page and the docked panel float together in ONE rounded card
    // (`data-slot="shell-card"`, a 6px gutter, a 10px corner, `shadow-shell`), so the nav reads as
    // behind the content. A phone has no card: the page is the whole screen.
    <div data-slot="shell" className="md:bg-sidebar flex min-h-screen w-full flex-col md:h-screen md:overflow-hidden">
      {/* The update banner: on the lower surface, above the nav and the card (branch-demo's app-level banner). */}
      <UpdateBanner onStaleChange={setUpdateAvailable} />
      <div data-slot="shell-row" className="flex min-h-0 w-full flex-1">
      {/* Desktop only: a phone's nav is the bottom bar + Settings (see MobileNav in views/Pages.tsx) —
          there is no off-canvas drawer any more. */}
      <aside
        data-slot="sidebar" data-chrome="" data-collapsed={collapsed}
        className={cn(
          "z-50 max-md:hidden md:flex md:shrink-0 md:flex-col md:overflow-hidden md:transition-[width] md:duration-200 md:ease-out motion-reduce:transition-none",
          collapsed ? "md:w-14" : "md:w-60",
        )}
      >
        <Sidebar collapsed={collapsed} onToggle={() => setRail(!collapsed)} actions={sidebarActions} />
      </aside>
      <div data-slot="shell-card" className="flex min-w-0 flex-1 md:my-1.5 md:mr-1.5 md:overflow-hidden md:rounded-[10px] md:bg-background md:shadow-shell">
      {/* The page column scrolls on its own on a desktop (md:h-screen + overflow), as each column of an
          app shell does: the docked panel then sits flush against the window's edge, with no page
          scrollbar outside it (the gutter is reserved here, not on <html>; its children never shrink to
          fit the column's height — the top bar did). A phone keeps the window's own scroll (its keyboard and pull-to-refresh
          code read window.scrollY). The column is the `@container/page` the pages' layouts query, so
          they respond to the room the dock leaves, not to the window. */}
      <div data-slot="page-scroll" className="@container/page flex min-w-0 flex-1 flex-col md:h-full md:overflow-y-auto md:[scrollbar-gutter:stable] md:*:shrink-0">
        {/* Opaque, not a translucent blur: scrolled content (a long diff, the PR comments) showed through it.
            The notch inset goes to whichever is topmost: the banner when it's shown, else the header. */}
        {/* On a desktop the top bar is part of the card (neutral); on a phone it is the themed frame. */}
        <header
          data-slot="topbar" data-chrome={narrow ? "" : undefined}
          className={cn(
            "bg-background sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 md:px-6 max-md:gap-2 max-md:px-[max(1rem,env(safe-area-inset-left))]",
            !updateAvailable && "max-md:h-[calc(3.5rem+env(safe-area-inset-top))] max-md:pt-[env(safe-area-inset-top)]",
          )}
        >
          <button type="button" data-slot="topbar-mark" onClick={() => navigate("/")} aria-label="Orca — go to overview" className="shrink-0 md:hidden"><RoundMark /></button>
          {/* The phone has no sidebar: the server's name goes beside the mark — the server menu
              carries it when it shows. */}
          {!serverMenu && identity && <span data-slot="topbar-identity" className="text-server-fg truncate text-sm font-medium md:hidden">{identity.label}</span>}
          <ServerMenu />
          <RepoSwitcher />
          <nav aria-label="Breadcrumb" className="text-muted-foreground flex min-w-0 items-center gap-2 text-sm">{crumbs}</nav>
          <span className="contents max-md:ml-auto max-md:flex"><BridgeLabel /><StaleIndicator /></span>
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
      <Dock />
      </div>
      </div>
      <BottomBar activity={activity} />
      {/* The quick-ask pill, bottom centre of every page but an agent's Chat tab (desktop; the phone's bottom bar has the orchestrator). */}
      {!chatTab(route) && <QuickAsk />}
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

/** "/" then a page name, Vercel's top-bar breadcrumb. */
export const Crumb = ({ children, to }: { children: ReactNode; to?: string }) => (
  <>
    <span className="text-border select-none" aria-hidden="true">/</span>
    {to ? <button type="button" onClick={() => navigate(to)} className="hover:text-foreground truncate">{children}</button>
      : <span className="text-foreground truncate" aria-current="page">{children}</span>}
  </>
);

function Sidebar({ collapsed, onToggle, actions }: {
  collapsed: boolean; onToggle: () => void; actions?: (collapsed: boolean) => ReactNode;
}) {
  const route = useRoute();
  const narrow = useNarrow();
  return (
    <>
      <div className="flex h-14 items-center gap-2 px-3">
        <InstanceSwitcher collapsed={collapsed} />
      </div>
      {!collapsed && <div className="px-3 pb-2"><FindBox /></div>}
      <nav aria-label="Main" className="flex flex-col gap-0.5 px-2 py-1">
        {NAV.map(({ to, label, Icon, match, badge }) => {
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
      {/* Add New is the last of the actions — pushed to the bottom, just above the divider and you. It
          is a nav row (navRow), not a boxed button, so the lower surface reads as one column. */}
      <div data-slot="sidebar-actions" className="mt-auto px-2 pb-2">
        {actions?.(collapsed)}
      </div>
      {/* The foot, like branch-demo's: a hairline, then you (a ghost row with a chevron, it opens a
          menu) and the bell and the collapse toggle as ghost icons. Collapsed, one centred column with
          the toggle on top, so nothing overlaps. */}
      <div data-slot="sidebar-foot" className="border-t px-2 py-2">
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
        <Bot className="size-5" /><ActivityDot activity={activity} className="absolute top-1.5 right-[calc(50%-0.9rem)]" /><span className={label}>Orchestrator</span>
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

// Vercel's team switcher, as the instance scope: "All instances", or one machine. It scopes the
// Overview and Agents pages; with one instance it is just the wordmark.
function InstanceSwitcher({ collapsed }: { collapsed: boolean }) {
  const [scope, setScope] = useAtom(instanceScopeAtom);
  useRepos(); // config (and with it the instance list) lands after first paint
  const choices = instanceChoices();
  const label = scope === "all" ? (choices.length > 1 ? "All instances" : thisInstance() ?? "Orca") : scope;
  const identity = useServerIdentity();
  const mark = <RoundMark />;
  const body = (
    <>
      {mark}
      <span className={cn("min-w-0 flex-1 text-left", collapsed && "md:hidden")}>
        <span className="flex min-w-0 items-baseline gap-1.5 text-sm font-medium">
          <span className="shrink-0">Orca</span>
          {identity && <span data-slot="server-identity" className="text-server-fg truncate">{identity.label}</span>}
        </span>
        <span data-slot="instance-scope" className="text-muted-foreground block truncate text-xs">{label}</span>
      </span>
    </>
  );
  if (choices.length < 2) return <button type="button" onClick={() => navigate("/")} className="flex min-w-0 flex-1 items-center gap-2" aria-label="Orca — go to overview">{body}</button>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="hover:bg-accent/60 flex min-w-0 flex-1 items-center gap-2 rounded-md p-1" aria-label="Switch instance">
          {body}
          <ChevronsUpDown className={cn("text-muted-foreground size-3.5 shrink-0", collapsed && "md:hidden")} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12rem]">
        <DropdownMenuLabel>Instance</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={scope} onValueChange={setScope}>
          <DropdownMenuRadioItem value="all">All instances</DropdownMenuRadioItem>
          {choices.map((i) => <DropdownMenuRadioItem key={i} value={i}>{i}{i === thisInstance() ? " (this machine)" : ""}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
// Board view and the Agents filters. Hidden with a single repo.
function RepoSwitcher() {
  const repos = useRepos();
  const [repo, setRepo] = useAtom(repoFilterAtom);
  if (repos.length <= 1) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-slot="repo-switcher" className="hover:bg-accent/60 flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium">
          {repo === "all" ? "All repos" : repoLabel(repos, repo)} <ChevronsUpDown className="text-muted-foreground size-3.5" />
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
        <button type="button" data-slot="add-new" aria-label="Add New" onClick={() => setOpen(true)} className={navRow(collapsed)}>
          <Plus className="size-4 shrink-0" /><span className={cn(collapsed && "md:hidden")}>Add New</span>
          <Shortcut id="new" className={cn("ml-auto max-md:hidden [@media(pointer:coarse)]:hidden", collapsed && "md:hidden")} />
        </button>
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

// You, at the foot of the sidebar: refresh the app, sync worktrees, the theme.
export function ProfileMenu({ collapsed = false }: { collapsed?: boolean }) {
  const [theme, setTheme] = useTheme();
  const setPalette = useSetAtom(paletteOpenAtom);
  const setHelp = useSetAtom(shortcutsHelpOpenAtom);
  useRepos(); // the instance name arrives with config, after first paint
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-slot="profile" className={cn("hover:bg-accent flex h-9 min-w-0 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors", collapsed ? "md:size-9 md:justify-center md:p-0" : "flex-1")} aria-label="Profile menu">
          <CircleUser className="text-muted-foreground size-4 shrink-0" />
          {/* One line: who, then which machine — "You · local". */}
          <span className={cn("flex min-w-0 items-center gap-1.5 whitespace-nowrap", collapsed && "md:hidden")}>
            <span className="truncate">You</span>
            {thisInstance() && <><span className="bg-muted-foreground/60 size-1 shrink-0 rounded-full" aria-hidden="true" /><span data-slot="profile-instance" className="text-muted-foreground truncate">{thisInstance()}</span></>}
          </span>
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
