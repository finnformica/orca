// The desktop's docked right column. A side panel (components/SidePanel.tsx — the orchestrator, the
// instance terminal) is a column of the shell, not an overlay: it renders INTO the shell's dock
// (`data-slot="dock"` in components/Shell.tsx, a portal into `dockElementAtom`), beside the page in
// the one shell card. Only the dock's width animates, between 0 and the open width, and it clips the
// panel, which keeps its full width — so the page reflows in the same frame and nothing jumps
// (branch-demo's docked AI chat). Each panel publishes its open width here by slot; the dock is the
// widest one (only one is open at a time, but one closing and one opening land in the same commit).
// While a drag resizes a panel, the dock's element is written directly, as the panel's own width is.
import { atom, useAtom, useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { sidebarCollapsedAtom } from "./atoms";
import { navRail } from "../workstream";

export const dockWidthsAtom = atom<Record<string, number>>({});
export const dockWidthAtom = atom((get) => Math.max(0, ...Object.values(get(dockWidthsAtom))));
/** You expanded the nav while a docked panel had made it a rail; cleared when the dock closes. */
export const navExpandedOverrideAtom = atom(false);

/** The shell's dock element, the portal target of a docked panel (null on a phone, before the shell mounts). */
export const dockElementAtom = atom<HTMLElement | null>(null);
/** The clip inside the dock: a docked panel renders here. The dock itself does not clip, so the
 *  resize handle can hang in the gutter outside it (branch-demo's gutter handle). */
export const dockClipElementAtom = atom<HTMLElement | null>(null);

export function useViewportWidth(): number {
  const [vw, setVw] = useState(() => window.innerWidth);
  useEffect(() => {
    const fit = () => setVw(window.innerWidth);
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return vw;
}

/** The nav as it renders: an icon rail by your choice, or because the open dock needs the room. */
export function useNavRail(): boolean {
  const collapsed = useAtomValue(sidebarCollapsedAtom);
  const dock = useAtomValue(dockWidthAtom);
  const override = useAtomValue(navExpandedOverrideAtom);
  return navRail(collapsed, useViewportWidth(), dock, override);
}

/** The nav's rail state and the one way to change it (the foot's toggle, ⌘B, the palette, Find).
 *  Asking for the rail while the dock made it one just drops your override; asking for the full nav
 *  while the dock needs the room sets the override, so your saved choice stays as it was. */
export function useNavToggle(): { rail: boolean; setRail: (rail: boolean) => void } {
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom);
  const dock = useAtomValue(dockWidthAtom);
  const [override, setOverride] = useAtom(navExpandedOverrideAtom);
  const vw = useViewportWidth();
  useEffect(() => { if (dock <= 0 && override) setOverride(false); }, [dock, override]);
  const auto = navRail(false, vw, dock);
  return {
    rail: navRail(collapsed, vw, dock, override),
    setRail: (rail) => {
      if (rail) { setOverride(false); if (!auto) setCollapsed(true); }
      else { setCollapsed(false); if (auto) setOverride(true); }
    },
  };
}

// ── motion ──────────────────────────────────────────────────────────────────────────────────────────
// While the dock (or the nav, as it turns into its rail) animates its width, the page column changes
// width on EVERY frame. Work that measures the page and sets React state (a sticky header's height, a
// marquee's overflow, the toast stack's anchor) waits until the width has settled, so no React state
// changes per animation frame — the page only reflows in CSS. The flag is set by the shell's
// `transitionrun` / `transitionend` events on a `width` transition (Shell's `useDockMotion`).
let moving = 0;
let fallback: ReturnType<typeof setTimeout> | undefined;
const settled = new Set<() => void>();

const settle = () => {
  moving = 0;
  clearTimeout(fallback);
  const fns = [...settled];
  settled.clear();
  for (const fn of fns) fn();
};

/** A width transition of the dock or the nav started (+1) or ended (−1). A missed end (the element
 *  left the page mid-motion) settles after a short fallback, so deferred work always runs. */
export function noteDockMotion(delta: 1 | -1) {
  moving = Math.max(0, moving + delta);
  clearTimeout(fallback);
  if (moving === 0) settle();
  else fallback = setTimeout(settle, 600);
}

export const dockMoving = () => moving > 0;

/** Run `fn` now — or, while the dock or the nav is animating its width, once, when it has settled.
 *  Pass a stable function: a repeated call while moving queues it once. */
export function afterDockMotion(fn: () => void) {
  if (moving > 0) settled.add(fn);
  else fn();
}

/** True during the page load — until the first input, or one second: a panel open from the start
 *  (`?open=orchestrator`, or the orchestrator panel's own persisted open state) shows at its width
 *  at once, with no slide to replay. Any open you cause (a click, a key) slides from 0. */
let starting = true;
function armPageLoadWindow() {
  starting = true;
  const done = () => { starting = false; for (const t of ["pointerdown", "keydown", "click"]) window.removeEventListener(t, done, true); };
  for (const t of ["pointerdown", "keydown", "click"]) window.addEventListener(t, done, true);
  setTimeout(done, 1000);
}
if (typeof window !== "undefined") armPageLoadWindow();
export const appStarting = () => starting;
/** Test support: a real reload re-arms this (fresh module state); a shared test process does not,
 *  since an earlier file's click can only flip it false once for the whole run. */
export const resetAppStartingForTests = (): void => { if (typeof window !== "undefined") armPageLoadWindow(); };
