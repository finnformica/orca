// The right-hand side panel's frame, shared by the orchestrator (components/Terminal.tsx) and the
// instance terminal (components/InstanceTerminal.tsx); `aria-modal=false`, so the page stays usable.
// On a desktop it is DOCKED: it renders into the shell's dock column (a portal, lib/dock.ts) at its
// full width, and the dock's width animates 0 ↔ that width and clips it — the page reflows in the
// same frame, as branch-demo's docked chat does. No shadow: a hairline edge. Below md it is a `fixed`
// overlay that slides in from the right edge (a transform). It is
// resized from its LEFT edge with the width remembered per browser, and — on a touch screen — swiped
// right to close (the edge it comes from, through the one `useSwipeToDismiss`). `fullScreen` is the
// phone's form: the whole visual viewport, no resize edge. The header (`PanelHeader`) is one row — h-14
// on a desktop, the top bar's height, so the two headers and their hairlines read as one row across
// the shell card (h-12 on a phone):
// an icon or a Back arrow, the title over a status line, then the actions.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAtom, useAtomValue, useSetAtom, type WritableAtom } from "jotai";
import { ArrowLeft } from "lucide-react";
import { PANEL_MIN_W, clampPanelWidth } from "../workstream";
import { Button } from "@/components/ui/button";
import { useSwipeToDismiss } from "@/lib/gestures";
import { cn } from "@/lib/utils";
import { useNarrow } from "@/lib/viewport";
import { dockElementAtom, dockWidthsAtom } from "@/lib/dock";

/** The dock's open / close: branch-demo's `transition-all` (150ms, Tailwind's default ease). */
export const SLIDE_MS = 150;
/** One arrow key on the focused resize edge (Shift: three times as far). */
export const RESIZE_STEP = 40;

type WidthAtom = WritableAtom<number, [number], void>;

/** The panel's width: saved per browser, clamped to the viewport on load and on a browser resize. */
export function usePanelWidth(widthAtom: WidthAtom) {
  const [savedWidth, setSavedWidth] = useAtom(widthAtom);
  const [vw, setVw] = useState(() => window.innerWidth);
  useEffect(() => {
    const fit = () => setVw(window.innerWidth);
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return { width: clampPanelWidth(savedWidth, vw), vw, setSavedWidth };
}

export type SwipeProps = ReturnType<typeof useSwipeToDismiss>;

export function SidePanel({ open, onClose, slot, label, labelledBy, widthAtom, swipe: swipeOn, fullScreen = false, header, children, onKeyDown }: {
  open: boolean; onClose: () => void;
  /** `data-slot` prefix: `<slot>-panel` on the surface, `<slot>-resize` on its edge. */
  slot: string; label: string; labelledBy?: string;
  widthAtom: WidthAtom;
  /** Swipe the header right to close (a touch screen). */
  swipe: boolean;
  fullScreen?: boolean;
  header: (swipe: SwipeProps) => ReactNode;
  children: ReactNode;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  const { width, vw, setSavedWidth } = usePanelWidth(widthAtom);
  const panelRef = useRef<HTMLDivElement>(null);
  // Docked: a desktop width. Below md (a desktop window resized down, or a phone) it stays an overlay.
  const docked = !fullScreen && !useNarrow();
  const dockEl = useAtomValue(dockElementAtom);
  const setDock = useSetAtom(dockWidthsAtom);
  // branch-demo's right panel, step by step. `expanded` drives the dock's width; it starts from
  // `open`, so a panel open at mount (a persisted flag) shows at once with no slide. Opening: the
  // panel is shown (and can take focus) in the commit that opens it, at dock width 0, and the width
  // flips to the target on the NEXT frame — so 0 → width is a real CSS transition, and the work of
  // a first mount (the chat's first render) lands before it, not inside it. Closing: the width goes
  // to 0 now; the panel stays painted (`shown`) until the dock's `width` transition ends.
  const [expanded, setExpanded] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setShown(true);
      const id = requestAnimationFrame(() => setExpanded(true));
      return () => cancelAnimationFrame(id);
    }
    setExpanded(false);
  }, [open]);
  useEffect(() => {
    if (open || expanded || !shown) return;
    const hide = () => setShown(false);
    const end = (e: TransitionEvent) => { if (e.target === dockEl && e.propertyName === "width") hide(); };
    dockEl?.addEventListener("transitionend", end);
    const t = setTimeout(hide, SLIDE_MS + 150); // no transition ran (reduced motion, the dock stayed open for the other panel)
    return () => { dockEl?.removeEventListener("transitionend", end); clearTimeout(t); };
  }, [open, expanded, shown, dockEl]);
  useEffect(() => {
    const w = expanded && docked ? width : 0;
    setDock((d) => (d[slot] ?? 0) === w ? d : { ...d, [slot]: w });
  }, [expanded, docked, width, slot]);
  useEffect(() => () => setDock(({ [slot]: _, ...rest }) => rest), [slot]);
  // The panel's own class transition slides it the rest of the way, from where the finger let go,
  // once the inline drag style is cleared.
  const swipe = useSwipeToDismiss("right", () => panelRef.current, onClose, { enabled: swipeOn, hold: true });
  useEffect(() => { const el = panelRef.current; if (el) el.style.transition = el.style.transform = ""; }, [open]);
  // During a drag the element's style is written DIRECTLY — a React state update per pointer move
  // re-rendered the whole panel and lagged; state (and storage) is updated once, when the pointer lets go.
  const onResizeStart = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).focus(); // the arrow keys resize from here on (preventDefault below blocks the default focus)
    const el = panelRef.current;
    if (!el) return;
    const x0 = e.clientX, w0 = width;
    let last = w0;
    // The shell's dock column follows the drag at once (no transition), so the page reflows with it.
    const dock = docked ? dockEl : null;
    dock?.setAttribute("data-resizing", "");
    const move = (ev: PointerEvent) => {
      last = clampPanelWidth(w0 + (x0 - ev.clientX), window.innerWidth); // the edge is on the LEFT: dragging left widens
      el.style.width = `${last}px`;
      if (dock) dock.style.width = `${last}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      dock?.removeAttribute("data-resizing");
      setSavedWidth(last);
    };
    document.body.style.cursor = "ew-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };
  // The keyboard's resize: focus the edge, then ← widens and → narrows (Home / End: the limits).
  const onResizeKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 120 : RESIZE_STEP;
    const next = e.key === "ArrowLeft" ? width + step : e.key === "ArrowRight" ? width - step
      : e.key === "Home" ? PANEL_MIN_W : e.key === "End" ? Number.MAX_SAFE_INTEGER : null;
    if (next === null) return;
    e.preventDefault();
    setSavedWidth(clampPanelWidth(next, window.innerWidth));
  };
  // Docked, it waits for the shell's dock to exist rather than flash as an overlay first.
  if (docked && !dockEl) return null;
  const resize = !fullScreen && (
    // The resize handle: the panel's left edge. Dragging left widens; the width is remembered.
    <div data-slot={`${slot}-resize`} role="separator" aria-orientation="vertical" aria-label="Resize panel" onPointerDown={onResizeStart}
      tabIndex={open ? 0 : -1} aria-valuenow={width} aria-valuemin={PANEL_MIN_W} onKeyDown={onResizeKey}
      className="hover:bg-geist-blue/40 active:bg-geist-blue/60 focus-visible:bg-geist-blue/60 outline-none absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize transition-colors" />
  );
  const common = {
    ref: panelRef, role: "dialog", "aria-modal": false, "aria-label": label, "aria-labelledby": labelledBy, "aria-hidden": !open,
    "data-slot": `${slot}-panel`, "data-state": open ? "open" : "closed", onKeyDown,
  } as const;
  if (docked) {
    // In the dock: its full width from the dock's left edge, so the dock's animated width slides it
    // in and out (clipped) and the content never reflows. Closed, it stays painted until the dock's
    // width transition has ended, then `invisible` (still mounted: the draft and the scroll stay).
    // The open one is on top while the other leaves.
    return createPortal(
      <div {...common} data-docked="" data-shown={open || shown ? "" : undefined}
        className={cn("bg-card text-foreground absolute inset-y-0 left-0 flex flex-col overflow-hidden border-l",
          open || shown ? "visible" : "invisible", open ? "z-10" : "z-0")}
        style={{ width }}
      >
        {resize}
        {header(swipe)}
        {children}
      </div>,
      dockEl!,
    );
  }
  return (
    // z-40: above the page and its sticky top bar (z-30), below menus and popovers (z-50), which must
    // still open over it. Slid out, it is hidden (visibility, after the transform finishes) and inert
    // to assistive tech. Opening, only the transform transitions — `visibility` flips to visible AT
    // ONCE, so a field inside can take focus in the same commit. Closing, visibility waits for the slide.
    <div
      {...common} data-full={fullScreen ? "" : undefined}
      className={cn("bg-card text-foreground flex flex-col overflow-hidden",
        fullScreen ? "fixed top-0 right-0 h-[var(--vvh,100dvh)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]" : "fixed inset-y-0 right-0 border-l shadow-modal",
        "z-40 ease-out motion-reduce:transition-none",
        open ? "visible translate-x-0 transition-transform" : "invisible translate-x-full transition-[transform,visibility]")}
      style={fullScreen
        ? { width: "100vw", transitionDuration: `${SLIDE_MS}ms` }
        : { width, maxWidth: "100vw", minWidth: Math.min(PANEL_MIN_W, vw), transitionDuration: `${SLIDE_MS}ms` }}
    >
      {resize}
      {header(swipe)}
      {children}
    </div>
  );
}

/** The panel's header row: an icon (or, as a phone's page, a Back arrow), the title over a status
 *  line, and the actions at the right. The swipe props make it the handle a finger drags. */
export function PanelHeader({ slot, swipe, touch, icon, onBack, title, titleId, status, actions }: {
  slot: string; swipe?: SwipeProps; touch?: boolean;
  icon?: ReactNode; onBack?: () => void;
  title: ReactNode; titleId?: string; status?: ReactNode; actions?: ReactNode;
}) {
  return (
    <div {...swipe} className={cn("flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3 select-none md:h-14", touch && "touch-none")} data-slot={slot}>
      <div className="flex min-w-0 items-center gap-2">
        {onBack ? (
          <Button size="icon" variant="ghost" className="-ml-2 size-9 shrink-0" aria-label="Back" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
        ) : icon && <span className="bg-accent text-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-full">{icon}</span>}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium" id={titleId}>{title}</div>
          {status}
        </div>
      </div>
      <div className="flex shrink-0 items-center">{actions}</div>
    </div>
  );
}
