import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

// New-draft composer's selected repo, persisted. The prompt + attachments are persisted by
// ChatComposer itself (see lib/composerDraft), so a reload never loses an in-progress draft.
export const draftRepoAtom = atomWithStorage("orca.draftRepo", "");

// Board repo filter ("all" or a repo name), persisted. Scopes the board + the Done-lane copy.
export const repoFilterAtom = atomWithStorage("orca.repoFilter", "all");

// Card density, persisted. "comfortable" is the full card; "dense" strips a card down to its
// at-a-glance status (repo, title, status/condition badges) — dropping the prompt, diffstat, and
// preview+actions footer — so many sessions fit on screen. Done cards ignore it (always compact).
export type Density = "comfortable" | "dense";
export const densityAtom = atomWithStorage<Density>("orca.density", "comfortable");

// `repo::branch` of a card whose terminal should open as soon as it renders — set by "New chat",
// which creates the worktree in the background and drops you straight into its conversation.
// The card clears it once opened, so a later re-render doesn't reopen it.
export const openTerminalAtom = atom<string | null>(null);

// Which view "/" shows, persisted: "list" is the overview (stat tiles, the workstreams table and
// recent activity), "board" the original five swimlanes of cards. List is the default.
export type BoardView = "list" | "board";
export const boardViewAtom = atomWithStorage<BoardView>("orca.boardView", "list");

// The console shell. The sidebar can be collapsed to icons (persisted); the instance switcher at its
// top scopes the Overview and Agents pages to one machine ("all" or an instance name, persisted);
// the Find box and the Agents page share one search query (not persisted — a fresh visit is unfiltered).
export const sidebarCollapsedAtom = atomWithStorage("orca.sidebarCollapsed", false);
export const instanceScopeAtom = atomWithStorage("orca.instanceScope", "all");
export const agentQueryAtom = atom("");
// The Overview's Usage card: just the fleet + Codex, or every hydra login too. Persisted.
export const usageExpandedAtom = atomWithStorage("orca.usageExpanded", false);

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
export const paletteRecentAtom = atomWithStorage<string[]>("orca.palette.recent", []);
