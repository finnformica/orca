import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { isBoolean, isString, isStringArray, oneOf, persistedAtom } from "./persisted";

// New-draft composer's selected repo, persisted. The prompt + attachments are persisted by
// ChatComposer itself (see lib/composerDraft), so a reload never loses an in-progress draft.
export const draftRepoAtom = atomWithStorage("orca.draftRepo", "");

// The top bar's repo switcher ("all" or a repo name), persisted (lib/persisted; a repo no longer in
// the config reads as "all" — Shell's useShellFallbacks). Scopes the board + the Done-lane copy.
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

// Which view "/" shows, persisted: "list" is the overview (stat tiles, the workstreams table and
// recent activity), "board" the original five swimlanes of cards. List is the default.
export type BoardView = "list" | "board";
// `orca.ui.v1.agents.view`; the pre-versioned `orca.boardView` is read once if present.
export const boardViewAtom = persistedAtom<BoardView>("agents.view", "list", oneOf("list", "board"), "orca.boardView");

// The console shell. The sidebar can be collapsed to icons (persisted); the instance switcher at its
// top scopes the Overview and Agents pages to one machine ("all" or an instance name, persisted);
// the Find box and the Agents page share one search query (the Agents list saves it with its chips,
// per repo scope, and restores both when /agents is opened bare — see AgentsList).
export const sidebarCollapsedAtom = persistedAtom("sidebarCollapsed", false, isBoolean, "orca.sidebarCollapsed");
export const instanceScopeAtom = persistedAtom("instanceScope", "all", isString, "orca.instanceScope");
export const agentQueryAtom = atom("");
// The Overview's Usage card: just the fleet + Codex, or every hydra login too. Persisted.
export const usageExpandedAtom = persistedAtom("usageExpanded", false, isBoolean, "orca.usageExpanded");
// The Usage PAGE's whole "Current windows" card, independent of the above: collapsible, starts
// collapsed (it's the first thing on a page someone usually visits to read ONE number), persisted.
export const usageStatsExpandedAtom = persistedAtom("usageStatsExpanded", false, isBoolean, "orca.usageStatsExpanded");

// Overlays any key, the palette or a button can open (components/Shortcuts.tsx). The orchestrator's
// window is open or closed here, so the top bar's "Ask the orchestrator", O and the palette all drive
// the one window; `orchestratorPrefillAtom` is text for its composer. `session` groups the keystrokes
// of one ask (typed in the entry before the composer mounts) so they replace each other rather than
// stacking; `seq` makes every ask an event, even with the same text (it also refocuses the composer).
export const orchestratorOpenAtom = atom(false);
export type OrchestratorPrefill = { text: string; session: number; seq: number };
export const orchestratorPrefillAtom = atom<OrchestratorPrefill | null>(null);
export const addNewOpenAtom = atom(false);
export const paletteOpenAtom = atom(false);
export const shortcutsHelpOpenAtom = atom(false);
// The palette's recently run item ids, newest first. Persisted per browser.
export const paletteRecentAtom = persistedAtom<string[]>("palette.recent", [], isStringArray, "orca.palette.recent");
