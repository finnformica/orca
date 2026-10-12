// The console shell, Vercel's: a left sidebar (instance switcher, Find, the nav, you at the bottom)
// that collapses to icons and goes off-canvas on a narrow screen, and a top bar with the repo
// context switcher, a breadcrumb and the page's controls. The orchestrator's floating launcher is
// not part of it — it stays on every route, untouched.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAtom } from "jotai";
import {
  Boxes, Check, ChevronsLeft, ChevronsRight, ChevronsUpDown, CircleUser, FolderGit2, FolderSync, Gauge, LayoutGrid, Loader2, Menu,
  Monitor, MonitorPlay, Moon, Plus, RefreshCw, Search, Settings, Sun, X,
} from "lucide-react";
import { navigate, useRoute, type Route } from "@/lib/route";
import { agentQueryAtom, instanceScopeAtom, repoFilterAtom, sidebarCollapsedAtom } from "@/lib/atoms";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { api } from "../api";
import { instanceChoices, thisInstance, useRepos } from "../store";
import { summarizeSync } from "../workstream";
import { PreviewsBadge } from "@/views/PreviewControl";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const NAV: { to: string; label: string; Icon: typeof LayoutGrid; match: (r: Route) => boolean; badge?: (compact: boolean) => ReactNode }[] = [
  { to: "/", label: "Overview", Icon: LayoutGrid, match: (r) => r.name === "board" },
  // An agent's own page (PR or local detail) is "inside" Agents, as a deployment is inside Deployments.
  { to: "/agents", label: "Agents", Icon: Boxes, match: (r) => r.name === "agents" || r.name === "pr" || r.name === "local" },
  // The previews (and Test master) page; its badges are what the two header buttons used to carry.
  { to: "/previews", label: "Previews", Icon: MonitorPlay, match: (r) => r.name === "previews", badge: (compact) => <PreviewsBadge compact={compact} /> },
  { to: "/repos", label: "Repos", Icon: FolderGit2, match: (r) => r.name === "repos" },
  { to: "/usage", label: "Usage", Icon: Gauge, match: (r) => r.name === "usage" },
  { to: "/settings", label: "Settings", Icon: Settings, match: (r) => r.name === "settings" },
];

/** `sidebarActions` renders the last of the sidebar's actions (Add New), above the divider and you;
 *  it is told whether the sidebar is collapsed, so it can drop to an icon. */
export function Shell({ crumbs, sidebarActions, children }: {
  crumbs: ReactNode; sidebarActions?: (collapsed: boolean) => ReactNode; children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom);
  const [open, setOpen] = useState(false); // off-canvas sidebar on a narrow screen
  const route = useRoute();
  useEffect(() => setOpen(false), [route]); // navigating closes the off-canvas sidebar
  return (
    <div className="flex min-h-screen w-full">
      {/* Off-canvas backdrop (narrow screens). */}
      {open && <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setOpen(false)} aria-hidden="true" />}
      <aside
        data-slot="sidebar" data-collapsed={collapsed}
        className={cn(
          "bg-sidebar fixed inset-y-0 left-0 z-50 flex flex-col border-r transition-[width,transform] md:sticky md:top-0 md:h-screen md:translate-x-0",
          collapsed ? "md:w-14" : "md:w-60", "w-60", open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} onClose={() => setOpen(false)} actions={sidebarActions} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header data-slot="topbar" className="bg-background/80 sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 backdrop-blur md:px-6">
          <button type="button" className="text-muted-foreground hover:text-foreground md:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="size-5" /></button>
          <RepoSwitcher />
          <nav aria-label="Breadcrumb" className="text-muted-foreground flex min-w-0 items-center gap-2 text-sm">{crumbs}</nav>
        </header>
        <main className="w-full flex-1 px-4 py-6 md:px-6">{children}</main>
      </div>
    </div>
  );
}

/** "/" then a page name, Vercel's top-bar breadcrumb. */
export const Crumb = ({ children, to }: { children: ReactNode; to?: string }) => (
  <>
    <span className="text-border select-none" aria-hidden="true">/</span>
    {to ? <button type="button" onClick={() => navigate(to)} className="hover:text-foreground truncate">{children}</button>
      : <span className="text-foreground truncate" aria-current="page">{children}</span>}
  </>
);

function Sidebar({ collapsed, onToggle, onClose, actions }: {
  collapsed: boolean; onToggle: () => void; onClose: () => void; actions?: (collapsed: boolean) => ReactNode;
}) {
  const route = useRoute();
  return (
    <>
      <div className="flex h-14 items-center gap-2 px-3">
        <InstanceSwitcher collapsed={collapsed} />
        <button type="button" className="text-muted-foreground hover:text-foreground ml-auto md:hidden" onClick={onClose} aria-label="Close menu"><X className="size-4" /></button>
      </div>
      {!collapsed && <div className="px-3 pb-2"><FindBox /></div>}
      <nav aria-label="Main" className="flex flex-col gap-0.5 px-2 py-1">
        {NAV.map(({ to, label, Icon, match, badge }) => {
          const active = match(route);
          return (
            <button key={to} type="button" onClick={() => navigate(to)} aria-current={active ? "page" : undefined} title={collapsed ? label : undefined}
              className={cn("relative flex h-9 items-center gap-3 rounded-md px-2.5 text-sm transition-colors", active ? "bg-accent text-foreground font-medium" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground", collapsed && "md:justify-center md:px-0")}>
              <Icon className="size-4 shrink-0" />
              <span className={cn(collapsed && "md:hidden")}>{label}</span>
              {badge?.(collapsed)}
            </button>
          );
        })}
      </nav>
      {/* Add New is the last of the actions — pushed to the bottom, just above the divider and you.
          Collapsed, it is an icon in the same column. */}
      <div data-slot="sidebar-actions" className={cn("mt-auto px-2 pb-2", collapsed && "flex flex-col md:items-center")}>
        {actions?.(collapsed)}
      </div>
      {/* The foot: you, with the collapse toggle — above you when collapsed, so nothing overlaps. */}
      <div data-slot="sidebar-foot" className={cn("flex flex-col border-t p-2", collapsed && "items-stretch md:items-center")}>
        <div data-slot="sidebar-you" className={cn("flex items-center gap-1", collapsed && "md:flex-col-reverse")}>
          <ProfileMenu collapsed={collapsed} />
          <button type="button" onClick={onToggle} className={cn("text-muted-foreground hover:text-foreground hover:bg-accent hidden size-8 shrink-0 items-center justify-center rounded-md md:inline-flex", !collapsed && "ml-auto")}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
          </button>
        </div>
      </div>
    </>
  );
}

// The mark: a geometric orca silhouette (single-fill, currentColor, eye punched out via evenodd).
export function OrcaMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" className={className} aria-hidden="true">
      <path d="M2 12.5C2 9.5 5.5 8 9 8L11 3L13.5 8C16.5 8 19 8.5 20.5 9L22.5 6L20.3 11L22.5 15.5C19 13 10 14 2 12.5ZM5.6 10a1 1 0 1 0 0 2a1 1 0 1 0 0 -2Z" />
    </svg>
  );
}

// Vercel's team switcher, as the instance scope: "All instances", or one machine. It scopes the
// Overview and Agents pages; with one instance it is just the wordmark.
function InstanceSwitcher({ collapsed }: { collapsed: boolean }) {
  const [scope, setScope] = useAtom(instanceScopeAtom);
  useRepos(); // config (and with it the instance list) lands after first paint
  const choices = instanceChoices();
  const label = scope === "all" ? (choices.length > 1 ? "All instances" : thisInstance() ?? "Orca") : scope;
  const mark = (
    <span className="bg-foreground text-background inline-flex size-6 shrink-0 items-center justify-center rounded-full">
      <OrcaMark className="size-4" />
    </span>
  );
  const body = (
    <>
      {mark}
      <span className={cn("min-w-0 flex-1 text-left", collapsed && "md:hidden")}>
        <span className="block truncate text-sm font-medium">Orca</span>
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
// outside a text field focuses it, as on Vercel.
function FindBox() {
  const [q, setQ] = useAtom(agentQueryAtom);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (e.key !== "f" || e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault();
      ref.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <label className="bg-card focus-within:ring-ring/40 flex h-8 items-center gap-2 rounded-md border px-2 focus-within:ring-2">
      <Search className="text-muted-foreground size-3.5 shrink-0" />
      <input ref={ref} value={q} aria-label="Find agents" placeholder="Find…"
        onChange={(e) => { setQ(e.target.value); if (location.pathname !== "/agents") navigate("/agents"); }}
        className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none" />
      <kbd className="text-muted-foreground rounded border px-1 font-sans text-[10px]">F</kbd>
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
          {repo === "all" ? "All repos" : repo} <ChevronsUpDown className="text-muted-foreground size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12rem]">
        <DropdownMenuRadioGroup value={repo} onValueChange={setRepo}>
          <DropdownMenuRadioItem value="all">All repos</DropdownMenuRadioItem>
          {repos.map((r) => <DropdownMenuRadioItem key={r.name} value={r.name}>{r.name}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Vercel's "Add New…": the New-draft box in a popover. It stays open after a send, so its Undo is
 *  still there; a click outside closes it. */
export function AddNew({ children, collapsed = false }: { children: ReactNode; collapsed?: boolean }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" data-slot="add-new" title="Add New" aria-label="Add New" className={cn("w-full", collapsed && "md:size-8 md:p-0")}>
          <Plus className="size-4" /><span className={cn(collapsed && "md:hidden")}>Add New</span>
        </Button>
      </PopoverTrigger>
      {/* From the sidebar's foot it opens beside the sidebar, bottom-aligned with the button. */}
      <PopoverContent side="right" align="end" sideOffset={8} className="w-[34rem] max-w-[calc(100vw-2rem)] p-2">
        <div className="text-muted-foreground px-1 pb-2 text-xs">New agent — describe a feature, pick a repo and a model (Auto lets the orchestrator brief it).</div>
        {children}
      </PopoverContent>
    </Popover>
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
      title="Fetch each repo and fast-forward every worktree to its upstream (never forces, skips dirty/diverged)"
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
  useRepos(); // the instance name arrives with config, after first paint
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-slot="profile" className={cn("hover:bg-accent/60 flex h-8 min-w-0 items-center gap-2 rounded-md px-1.5 text-sm", collapsed ? "md:size-8 md:justify-center md:p-0" : "flex-1")} title="Profile" aria-label="Profile menu">
          <CircleUser className="text-muted-foreground size-5 shrink-0" />
          {/* One line: who, then which machine — "You · local". */}
          <span className={cn("flex min-w-0 items-center gap-1.5 whitespace-nowrap", collapsed && "md:hidden")}>
            <span className="truncate">You</span>
            {thisInstance() && <><span className="bg-muted-foreground/60 size-1 shrink-0 rounded-full" aria-hidden="true" /><span data-slot="profile-instance" className="text-muted-foreground truncate">{thisInstance()}</span></>}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuItem onSelect={() => window.location.reload()} title="Reload the app (pick up rebuilt code + refetch)">
          <RefreshCw className="size-3.5" /> Refresh
        </DropdownMenuItem>
        <SyncWorktreesItem />
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
