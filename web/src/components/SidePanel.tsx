// The right-hand side panel's frame, shared by the orchestrator (components/Terminal.tsx) and the
// instance terminal (components/InstanceTerminal.tsx): a `fixed` surface that slides in from the right
// edge over the page (a transform, so nothing reflows; `aria-modal=false`, so the page stays usable),
// resized from its LEFT edge with the width remembered per browser, and — on a touch screen — swiped
// right to close (the edge it comes from, through the one `useSwipeToDismiss`). `fullScreen` is the
// phone's form: the whole visual viewport, no resize edge. The header (`PanelHeader`) is one h-12 row:
// an icon or a Back arrow, the title over a status line, then the actions.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useAtom, type WritableAtom } from "jotai";
import { ArrowLeft } from "lucide-react";
import { PANEL_MIN_W, clampPanelWidth } from "../workstream";
import { Button } from "@/components/ui/button";
import { useSwipeToDismiss } from "@/lib/gestures";
import { cn } from "@/lib/utils";

export const SLIDE_MS = 200;

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
  // The panel's own class transition slides it the rest of the way, from where the finger let go,
  // once the inline drag style is cleared.
  const swipe = useSwipeToDismiss("right", () => panelRef.current, onClose, { enabled: swipeOn, hold: true });
  useEffect(() => { const el = panelRef.current; if (el) el.style.transition = el.style.transform = ""; }, [open]);
  // During a drag the element's style is written DIRECTLY — a React state update per pointer move
  // re-rendered the whole panel and lagged; state (and storage) is updated once, when the pointer lets go.
  const onResizeStart = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const el = panelRef.current;
    if (!el) return;
    const x0 = e.clientX, w0 = width;
    let last = w0;
    const move = (ev: PointerEvent) => {
      last = clampPanelWidth(w0 + (x0 - ev.clientX), window.innerWidth); // the edge is on the LEFT: dragging left widens
      el.style.width = `${last}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      setSavedWidth(last);
    };
    document.body.style.cursor = "ew-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };
  return (
    // z-40: above the page and its sticky top bar (z-30), below menus and popovers (z-50), which must
    // still open over it. Slid out, it is hidden (visibility, after the transform finishes) and inert
    // to assistive tech. Opening, only the transform transitions — `visibility` flips to visible AT
    // ONCE, so a field inside can take focus in the same commit. Closing, visibility waits for the slide.
    <div
      ref={panelRef}
      role="dialog" aria-modal="false" aria-label={label} aria-labelledby={labelledBy} aria-hidden={!open}
      data-slot={`${slot}-panel`} data-state={open ? "open" : "closed"} data-full={fullScreen ? "" : undefined}
      onKeyDown={onKeyDown}
      className={cn("bg-card text-foreground flex flex-col overflow-hidden",
        fullScreen ? "fixed top-0 right-0 h-[var(--vvh,100dvh)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]" : "fixed inset-y-0 right-0 border-l shadow-modal",
        "z-40 ease-out motion-reduce:transition-none",
        open ? "visible translate-x-0 transition-transform" : "invisible translate-x-full transition-[transform,visibility]")}
      style={fullScreen
        ? { width: "100vw", transitionDuration: `${SLIDE_MS}ms` }
        : { width, maxWidth: "100vw", minWidth: Math.min(PANEL_MIN_W, vw), transitionDuration: `${SLIDE_MS}ms` }}
    >
      {/* The resize handle: the panel's left edge. Dragging left widens; the width is remembered. */}
      {!fullScreen && (
        <div data-slot={`${slot}-resize`} role="separator" aria-orientation="vertical" aria-label="Resize panel" onPointerDown={onResizeStart}
          className="hover:bg-geist-blue/40 absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize transition-colors" />
      )}
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
    <div {...swipe} className={cn("flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3 select-none", touch && "touch-none")} data-slot={slot}>
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
