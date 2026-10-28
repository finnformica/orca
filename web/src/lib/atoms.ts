import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { isBoolean, isNumber, isString, isStringArray, oneOf, persistedAtom, persistedKey, writePersisted } from "./persisted";
import { HISTORY_RANGES, TERMINAL_PANEL_INITIAL, type TerminalPanelState } from "../workstream";

// New-draft composer's selected repo, persisted. The prompt + attachments are persisted by
// ChatComposer itself (see lib/composerDraft), so a reload never loses an in-progress draft.
export const draftRepoAtom = atomWithStorage("orca.draftRepo", "");

// The top bar's repo switcher ("all" or a repo name), persisted (lib/persisted; a repo no longer in
// the config reads as "all" — Shell's useShellFallbacks). Scopes the Overview, Agents and the Done-lane copy.
export const repoFilterAtom = persistedAtom("repoFilter", "all", isString, "orca.repoFilter");

// Card density, persisted. "comfortable" is the full card; "dense" strips a card down to its
// at-a-glance status (repo, title, status/condition badges) — dropping the prompt, diffstat, and
// preview+actions footer — so many sessions fit on screen. Done cards ignore it (always compact).
export type Density = "comfortable" | "dense";
// `orca.ui.v1.density` (lib/persisted); the pre-versioned `orca.density` is read once if present.
export const densityAtom = persistedAtom<Density>("density", "comfortable", oneOf("comfortable", "dense"), "orca.density");

// `repo::branch` of a card whose terminal should open as soon as it renders — set by "New chat",
// which creates the worktree in the background and drops you straight into its conversation.
// The card clears it once opened, so a later re-render doesn't reopen it.
export const openTerminalAtom = atom<string | null>(null);


// The console shell. The sidebar can be collapsed to icons (persisted); the instance switcher at its
// top scopes the Overview and Agents pages to one machine ("all" or an instance name, persisted);
// the Find box and the Agents page share one search query (the Agents list saves it with its chips,
// per repo scope, and restores both when /agents is opened bare — see AgentsList).
export const sidebarCollapsedAtom = persistedAtom("sidebarCollapsed", false, isBoolean, "orca.sidebarCollapsed");
export const instanceScopeAtom = persistedAtom("instanceScope", "all", isString, "orca.instanceScope");
export const agentQueryAtom = atom("");
// The Usage card (Overview and Usage page alike): just the fleet + Codex, or every hydra login too. Persisted.
export const usageExpandedAtom = persistedAtom("usageExpanded", false, isBoolean, "orca.usageExpanded");

const isHistoryRange = (v: unknown): v is number => HISTORY_RANGES.some((r) => r.hours === v);
// Every instance card's history-chart range (1h/6h/24h/7d), ONE choice for every machine, persisted
// and shared live across every mounted card in the tab (an atom, not per-component useState — Finn
// wants picking 6h on one card to move every other card at once). Before this, each card kept its
// own `orca.ui.v1.instanceRange:<instance>` key; an old value under one of those keys still starts
// the shared range (the first one found, alphabetically by instance) when no shared value is stored
// yet, so nobody's saved choice is silently dropped.
export const instanceRangeAtom = atomWithStorage<number>(persistedKey("instanceRange"), 24, {
  getItem: (key, init) => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const v: unknown = JSON.parse(raw);
        if (isHistoryRange(v)) return v;
      }
    } catch { /* ignore */ }
    try {
      for (const k of Object.keys(localStorage).sort()) {
        if (!k.startsWith(`${key}:`)) continue;
        try {
          const v: unknown = JSON.parse(localStorage.getItem(k) ?? "null");
          if (isHistoryRange(v)) return v;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return init;
  },
  setItem: (key, v) => writePersisted(key, v),
  removeItem: (key) => { try { localStorage.removeItem(key); } catch { /* ignore */ } },
}, { getOnInit: true });

// Overlays any key, the palette or a button can open (components/Shortcuts.tsx). The orchestrator's
// window is open or closed here, so the top bar's "Ask the orchestrator", O and the palette all drive
// the one window; `orchestratorPrefillAtom` is text for its composer. `session` groups the keystrokes
// of one ask (typed in the entry before the composer mounts) so they replace each other rather than
// stacking; `seq` makes every ask an event, even with the same text (it also refocuses the composer).
// Persisted (a reversal of #305's "always closed on reload"): a reload with it open shows the
// panel open at once, with no slide to replay (SidePanel's `appStarting`) — OrchestratorPanel still
// never auto-opens the dock on a narrow screen (phones route to `/orchestrator` instead; see its
// `mounted` guard), so a stored "open" from a desktop session stays dormant there.
export const orchestratorOpenAtom = persistedAtom("orchestratorOpen", false, isBoolean);
export type OrchestratorPrefill = { text: string; session: number; seq: number };
export const orchestratorPrefillAtom = atom<OrchestratorPrefill | null>(null);
// The side panel's width (px), remembered per browser; clamped to the viewport on use.
export const orchestratorWidthAtom = persistedAtom<number>("orchestratorWidth", 460, isNumber);
// The instance terminal's panel (components/InstanceTerminal.tsx): open or not, and its sessions as
// tabs (workstream.ts `terminal*`). Not persisted: a session is a live socket, gone with the page.
export const terminalPanelAtom = atom<TerminalPanelState>(TERMINAL_PANEL_INITIAL);
// Its width, like the orchestrator's: remembered per browser, clamped to the viewport on use.
export const terminalWidthAtom = persistedAtom<number>("terminalWidth", 460, isNumber);
// The Files-changed tab's file tree sidebar (views/FilesChanged.tsx): same pattern, its own default.
export const diffTreeWidthAtom = persistedAtom<number>("diffTreeWidth", 256, isNumber);
// The quick-ask box (the bottom-centre pill, the A key): one message to the orchestrator, no history.
export const quickAskOpenAtom = atom(false);
// What the orchestrator is up to, for the launcher's indicator: `running` while a wake is in flight,
// `unread` once a wake finished while the panel was closed (cleared when it opens). One subscriber
// (useOrchestratorActivity in components/Terminal) keeps it current from the live stream.
export const orchestratorActivityAtom = atom<{ running: boolean; unread: boolean }>({ running: false, unread: false });
// Which named agent's chat the side panel shows (docs/design/named-agents-and-memory.md §7.6). "" is
// the main chat: the default agent (Settings > Agents). Every open path (openOrchestrator) sets it
// back to ""; only a tab click or a send to another agent moves it.
export const orchestratorTabAtom = atom<string>("");
export const addNewOpenAtom = atom(false);
export const paletteOpenAtom = atom(false);
export const shortcutsHelpOpenAtom = atom(false);
// The palette's recently run item ids, newest first. Persisted per browser.
export const paletteRecentAtom = persistedAtom<string[]>("palette.recent", [], isStringArray, "orca.palette.recent");

// The notification centre (components/Notifications.tsx), per browser: do-not-disturb silences the
// toasts (the centre still fills); per-kind toasts off (a kind absent is on); browser notifications
// for the urgent kinds while the tab is hidden (needs the permission, asked for when switched on).
export const notifyDndAtom = atomWithStorage("orca.notifications.dnd", false);
// The bell's popover (the N key, the palette's Notifications action): open or closed, so a key
// press and a click drive the one Radix Popover state.
export const notificationsOpenAtom = atom(false);
export const toastPrefsAtom = atomWithStorage<Partial<Record<string, boolean>>>("orca.notifications.toasts", {});
export const browserNotifyAtom = atomWithStorage("orca.notifications.browser", false);
