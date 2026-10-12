// ⌘K (Ctrl+K): the command palette — every workstream, PR, page and action behind one fuzzy box —
// plus the ? shortcuts sheet and the ONE keydown listener every console shortcut goes through. The
// matching and ranking are pure (lib/shortcuts.ts, lib/palette.ts); this file builds the commands
// and runs them. Both overlays are native modal <dialog>s like Add New: Esc and the backdrop close
// them, and they carry Geist's modal shadow.
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useAtom, useSetAtom } from "jotai";
import { Search } from "lucide-react";
import {
  addNewOpenAtom, instanceScopeAtom, paletteOpenAtom, paletteRecentAtom, repoFilterAtom, shortcutsHelpOpenAtom, sidebarCollapsedAtom,
} from "@/lib/atoms";
import { moveSelection, pushRecent, rankPalette, type PaletteItem } from "@/lib/palette";
import { SHORTCUTS, isTypingTarget, matchShortcut, shortcutLabel, type ShortcutId } from "@/lib/shortcuts";
import { navigate, useRoute, type Route } from "@/lib/route";
import { cn } from "@/lib/utils";
import { instanceChoices, testLocally, useRepos, useWorkstreams, type Row } from "../store";
import { detailPath } from "@/views/Agents";
import { useOrchestrator } from "@/components/Terminal";

type Command = PaletteItem & { run: () => void };

const PAGES: [string, string][] = [["/", "Overview"], ["/agents", "Agents"], ["/previews", "Previews"], ["/repos", "Repos"], ["/usage", "Usage"], ["/settings", "Settings"]];

/** The workstream whose page you are on — the palette's "selected" one. */
function routeRow(route: Route, rows: Row[]): Row | undefined {
  if (route.name === "pr") return rows.find((r) => r.repo === route.repo && r.prNumber === route.number);
  if (route.name === "local") return rows.find((r) => r.repo === route.repo && r.branch === route.branch);
  return undefined;
}

function useCommands(query: string): Command[] {
  const rows = useWorkstreams();
  const repos = useRepos();
  const route = useRoute();
  const setAddNew = useSetAtom(addNewOpenAtom);
  const setHelp = useSetAtom(shortcutsHelpOpenAtom);
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom);
  const setRepo = useSetAtom(repoFilterAtom);
  const setScope = useSetAtom(instanceScopeAtom);
  const { ask } = useOrchestrator();
  const out: Command[] = [];
  for (const row of rows) {
    const to = detailPath(row);
    if (!to) continue;
    out.push({ id: `ws:${row.repo}::${row.branch}`, group: "Workstreams", label: row.title || row.branch, hint: `${row.repo} · ${row.branch}`, keywords: `${row.repo} ${row.branch}`, run: () => navigate(to) });
  }
  for (const row of rows) {
    if (!row.prNumber) continue;
    out.push({ id: `pr:${row.repo}#${row.prNumber}`, group: "Pull requests", label: `#${row.prNumber} ${row.title || row.branch}`, hint: row.repo, keywords: `${row.repo}#${row.prNumber} ${row.branch}`, run: () => navigate(`/${row.repo}/prs/${row.prNumber}`) });
  }
  for (const [to, label] of PAGES) out.push({ id: `page:${to}`, group: "Pages", label, hint: "Page", run: () => navigate(to) });
  const action = (id: string, label: string, run: () => void, shortcut?: ShortcutId, keywords?: string) =>
    out.push({ id: `action:${id}`, group: "Actions", label, hint: shortcut && shortcutLabel(shortcut), keywords, run });
  action("new", "New agent", () => setAddNew(true), "new", "add draft create");
  action("orchestrator", "Open orchestrator", () => ask(), "orchestrator", "ask chat");
  action("sidebar", collapsed ? "Expand sidebar" : "Collapse sidebar", () => setCollapsed(!collapsed), "sidebar", "toggle sidebar");
  action("help", "Keyboard shortcuts", () => setHelp(true), "help", "keys help");
  const here = routeRow(route, rows);
  if (here) action("preview", `Start preview: ${here.title || here.branch}`, () => {
    const to = detailPath(here);
    void testLocally(here).catch(() => {}); // the Preview tab shows Starting… / the failure
    if (to) navigate(`${to}/preview`);
  }, undefined, "test locally");
  if (repos.length > 1) {
    action("repo:all", "Switch repo: All repos", () => setRepo("all"));
    for (const r of repos) action(`repo:${r.name}`, `Switch repo: ${r.name}`, () => setRepo(r.name));
  }
  const instances = instanceChoices();
  if (instances.length > 1) {
    action("instance:all", "Switch instance: All instances", () => setScope("all"));
    for (const i of instances) action(`instance:${i}`, `Switch instance: ${i}`, () => setScope(i));
  }
  // Nothing you typed is wasted: it can always go to the orchestrator as a message to start from.
  if (query.trim()) out.push({ id: "action:ask", group: "Actions", label: `Ask the orchestrator: “${query.trim()}”`, keywords: query, run: () => ask(query.trim()) });
  return out;
}

export function CommandPalette() {
  const [open, setOpen] = useAtom(paletteOpenAtom);
  const [recent, setRecent] = useAtom(paletteRecentAtom);
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const commands = useCommands(query);
  const ranked = rankPalette(commands, query, recent.filter((id) => id !== "action:ask")) as Command[];
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery(""); setSel(0);
      dialog.showModal();
      dialog.querySelector("input")?.focus();
    } else if (!open && dialog.open) dialog.close();
  }, [open, dialog]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [sel, query]);
  const index = Math.min(sel, Math.max(0, ranked.length - 1));
  const run = (cmd: Command | undefined) => {
    if (!cmd) return;
    setRecent(pushRecent(recent, cmd.id));
    setOpen(false);
    cmd.run();
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setSel(moveSelection(index, e.key === "ArrowDown" ? 1 : -1, ranked.length)); }
    else if (e.key === "Enter") { e.preventDefault(); run(ranked[index]); }
  };
  const recentIds = new Set(query.trim() ? [] : recent);
  return (
    <dialog
      ref={setDialog} data-slot="command-palette" aria-label="Command palette"
      onClose={() => setOpen(false)} onCancel={() => setOpen(false)}
      onClick={(e) => { if (e.target === dialog) setOpen(false); }}
      className="bg-card text-foreground m-auto mt-[12vh] w-[92vw] max-w-xl rounded-lg border p-0 shadow-modal backdrop:bg-black/50"
    >
      <div className="flex h-12 items-center gap-2 border-b px-3">
        <Search className="text-muted-foreground size-4 shrink-0" />
        <input
          value={query} onChange={(e) => { setQuery(e.target.value); setSel(0); }} onKeyDown={onKey}
          placeholder="Search workstreams, PRs, pages and actions…" aria-label="Search commands"
          role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={ranked[index] ? `${listId}-${index}` : undefined}
          className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
        <kbd className="text-muted-foreground rounded border px-1 font-sans text-[10px]">Esc</kbd>
      </div>
      <div ref={listRef} id={listId} role="listbox" data-slot="palette-list" aria-label="Commands" className="max-h-[50vh] overflow-y-auto p-1">
        {ranked.length === 0 && <p className="text-muted-foreground px-2 py-6 text-center text-sm">No results</p>}
        {ranked.map((cmd, i) => {
          const group = recentIds.has(cmd.id) ? "Recent" : cmd.group;
          const prev = i > 0 ? (recentIds.has(ranked[i - 1]!.id) ? "Recent" : ranked[i - 1]!.group) : null;
          return (
            <div key={cmd.id}>
              {group !== prev && <div className="text-muted-foreground px-2 pt-2 pb-1 text-xs">{group}</div>}
              <div
                id={`${listId}-${i}`} role="option" aria-selected={i === index} data-id={cmd.id}
                onMouseMove={() => { if (i !== index) setSel(i); }} onClick={() => run(cmd)}
                className={cn("flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm", i === index && "bg-accent")}
              >
                <span className="min-w-0 truncate">{cmd.label}</span>
                {cmd.hint && <span className="text-muted-foreground ml-auto shrink-0 truncate pl-3 text-xs">{cmd.hint}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </dialog>
  );
}

/** ? : every shortcut, from the same table the listener matches against. */
export function ShortcutsHelp() {
  const [open, setOpen] = useAtom(shortcutsHelpOpenAtom);
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open, dialog]);
  return (
    <dialog
      ref={setDialog} data-slot="shortcuts-help" aria-label="Keyboard shortcuts"
      onClose={() => setOpen(false)} onCancel={() => setOpen(false)}
      onClick={(e) => { if (e.target === dialog) setOpen(false); }}
      className="bg-card text-foreground m-auto mt-[12vh] w-[92vw] max-w-sm rounded-lg border p-0 shadow-modal backdrop:bg-black/50"
    >
      <header className="flex h-12 items-center border-b px-4"><h2 className="text-sm font-medium">Keyboard shortcuts</h2></header>
      <ul className="divide-y px-4 py-1 text-sm">
        {SHORTCUTS.map((s) => (
          <li key={s.id} className="flex h-9 items-center justify-between">
            <span>{s.label}</span>
            <kbd className="text-muted-foreground rounded border px-1.5 font-sans text-xs">{shortcutLabel(s.id)}</kbd>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground border-t px-4 py-2 text-xs">Letters don't fire while you type in a field; {shortcutLabel("palette")} and Esc always do.</p>
    </dialog>
  );
}

/** The one keydown listener. Native dialogs close themselves on Esc; this closes the orchestrator's
 *  window (not a dialog — a popout) when Esc isn't meant for a dialog or an open menu. */
export function Shortcuts() {
  const [palette, setPalette] = useAtom(paletteOpenAtom);
  const setAddNew = useSetAtom(addNewOpenAtom);
  const setHelp = useSetAtom(shortcutsHelpOpenAtom);
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom);
  const { open: orchestrator, ask, close } = useOrchestrator();
  const state = useRef({ palette, collapsed, orchestrator });
  state.current = { palette, collapsed, orchestrator };
  const actions = useRef({ ask, close });
  actions.current = { ask, close };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const id = matchShortcut(e, isTypingTarget(e.target));
      if (!id) return;
      const s = state.current;
      if (id === "escape") {
        const t = e.target instanceof Element ? e.target : null;
        if (s.orchestrator && !t?.closest("dialog") && !document.querySelector('[role="menu"], [role="listbox"]:not([data-slot])')) actions.current.close();
        return;
      }
      e.preventDefault();
      if (id === "palette") setPalette(!s.palette);
      else if (id === "new") setAddNew(true);
      else if (id === "orchestrator") actions.current.ask();
      else if (id === "help") setHelp(true);
      else if (id === "sidebar") setCollapsed(!s.collapsed);
      else if (id === "find") {
        // The Find box only exists in the expanded sidebar.
        if (s.collapsed) setCollapsed(false);
        setTimeout(() => document.querySelector<HTMLInputElement>('input[aria-label="Find agents"]')?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
