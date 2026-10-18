// The desktop's docked right column. A side panel (components/SidePanel.tsx — the orchestrator, the
// instance terminal) is a column of the shell, not an overlay: while it is open, the shell reserves
// its width in the flex row (`data-slot="dock"` in components/Shell.tsx), so the page reflows beside
// it. Each panel publishes its open width here by slot; the dock is the widest one (only one is open
// at a time, but one closing and one opening land in the same commit). While a drag resizes a panel,
// the dock's element is written directly (`DOCK_SELECTOR`), as the panel's own width is.
import { atom, useAtom, useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { sidebarCollapsedAtom } from "./atoms";
import { navRail } from "../workstream";

export const dockWidthsAtom = atom<Record<string, number>>({});
export const dockWidthAtom = atom((get) => Math.max(0, ...Object.values(get(dockWidthsAtom))));
/** You expanded the nav while a docked panel had made it a rail; cleared when the dock closes. */
export const navExpandedOverrideAtom = atom(false);

export const DOCK_SELECTOR = '[data-slot="dock"]';

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
