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
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAtom, useAtomValue, useSetAtom, type WritableAtom } from "jotai";
import { ArrowLeft } from "lucide-react";
import { PANEL_MIN_W, SHELL_GAP, clampPanelWidth } from "../workstream";
import { Button } from "@/components/ui/button";
import { useSwipeToDismiss } from "@/lib/gestures";
import { cn } from "@/lib/utils";
import { useNarrow } from "@/lib/viewport";
import { appStarting, dockClipElementAtom, dockElementAtom, dockWidthsAtom } from "@/lib/dock";

/** The dock's open / close: branch-demo's `transition-all` (150ms, Tailwind's default ease). */
export const SLIDE_MS = 150;
/** One arrow key on the focused resize edge (Shift: three times as far). */
export const RESIZE_STEP = 40;
/** The resize handle: branch-demo's `ResizableHandle` (ui/src/components/resizable.tsx). A 1px line
 *  with a 17px hit area (`before:-inset-2`); on hover the line darkens with a faint ring, and while
 *  it drags (`data-resizing`) or has keyboard focus it is the accent. */
export const RESIZE_HANDLE_CLASS =
  "group absolute z-50 flex w-px cursor-ew-resize justify-center outline-none before:absolute before:-inset-2 hover:bg-border-dark hover:ring-2 hover:ring-foreground/5 data-[resizing]:bg-geist-blue data-[resizing]:ring-2 data-[resizing]:ring-geist-blue/5 focus-visible:bg-geist-blue focus-visible:ring-2 focus-visible:ring-geist-blue/5";

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

/** `open`, but true only once the slide has finished: work an open panel starts (a status poll, a
 *  fetch) lands after the slide, not in its frames. Closing is at once. */
export function useSlideSettled(open: boolean): boolean {
  const [settled, setSettled] = useState(open);
  useEffect(() => {
    if (!open) { setSettled(false); return; }
    const t = setTimeout(() => setSettled(true), SLIDE_MS + 30);
    return () => clearTimeout(t);
  }, [open]);
  return open && settled;
}

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
  const dockClip = useAtomValue(dockClipElementAtom);
  const setDock = useSetAtom(dockWidthsAtom);
  // branch-demo's right panel, step by step. `expanded` drives the dock's width; it starts from
  // `open` only during the page load (`appStarting`: a panel open from the URL shows at once, with
  // no slide to replay) — a panel first mounted by a later open still slides. Opening: the panel
  // can take focus in the commit that opens it, at dock width 0, and the width flips to the target
  // on the NEXT frame — so 0 → width is a real CSS transition, and the work of a first mount lands
  // before it. Closing: the width goes to 0 in the SAME commit as the click — the dock's width is
  // published from a layout effect keyed on `open && expanded`, with no passive-effect round trip
  // (measured: that chain started the close ~450ms after the click at 4× CPU).
  const [expanded, setExpanded] = useState(() => open && appStarting());
  useEffect(() => {
    if (!open) { setExpanded(false); return; }
    const id = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(id);
  }, [open]);
  useLayoutEffect(() => {
    const w = open && expanded && docked ? width : 0;
    setDock((d) => (d[slot] ?? 0) === w ? d : { ...d, [slot]: w });
  }, [open, expanded, docked, width, slot]);
  useEffect(() => () => setDock(({ [slot]: _, ...rest }) => rest), [slot]);
  // Closed and slid out (`idle`, once the dock's width transition has ended): focus may not enter it —
  // a `focusin` there is blurred at once. NOT `inert`, and never `visibility: hidden` /
  // `content-visibility: hidden`: each of those restyles the whole chat subtree when it flips
  // (measured with a long thread: 260–350ms for visibility, ~130ms for inert, at 4× CPU). The 0-wide
  // dock clips a closed panel, so it paints nothing and takes no clicks; `aria-hidden` hides it from
  // assistive tech; its draft and scroll position stay as they are.
  const [idle, setIdle] = useState(!open);
  if (open && idle) setIdle(false);
  useEffect(() => {
    if (open || idle || !dockEl) return;
    const done = () => setIdle(true);
    const end = (e: TransitionEvent) => { if (e.target === dockEl && e.propertyName === "width") done(); };
    dockEl.addEventListener("transitionend", end);
    const t = setTimeout(done, SLIDE_MS + 150); // no transition ran (reduced motion, the dock stayed open for the other panel)
    return () => { dockEl.removeEventListener("transitionend", end); clearTimeout(t); };
  }, [open, idle, dockEl]);
  // The panel's own class transition slides it the rest of the way, from where the finger let go,
  // once the inline drag style is cleared.
  const swipe = useSwipeToDismiss("right", () => panelRef.current, onClose, { enabled: swipeOn, hold: true });
  useEffect(() => { const el = panelRef.current; if (el) el.style.transition = el.style.transform = ""; }, [open]);
  // During a drag the element's style is written DIRECTLY — a React state update per pointer move
  // re-rendered the whole panel and lagged; state (and storage) is updated once, when the pointer lets go.
  const onResizeStart = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const handle = e.currentTarget as HTMLElement;
    handle.focus(); // the arrow keys resize from here on (preventDefault below blocks the default focus)
    const el = panelRef.current;
    if (!el) return;
    const x0 = e.clientX, w0 = width;
    let last = w0;
    // The shell's dock column follows the drag at once (no transition), so the page reflows with it.
    const dock = docked ? dockEl : null;
    dock?.setAttribute("data-resizing", "");
    handle.setAttribute("data-resizing", "");
    const move = (ev: PointerEvent) => {
      last = clampPanelWidth(w0 + (x0 - ev.clientX), window.innerWidth); // the edge is on the LEFT: dragging left widens
      el.style.width = `${last}px`;
      if (dock) dock.style.width = `${last}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      dock?.removeAttribute("data-resizing");
      handle.removeAttribute("data-resizing");
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
  if (docked && (!dockEl || !dockClip)) return null;
  // The resize handle. Dragging left widens; the width is remembered. Docked, it sits in the CENTRE of
  // the gutter between the page card and the dock card (branch-demo's `placement="gutter"`): a portal
  // into the dock, outside its clip, and only while the panel is open — a closing panel leaves nothing
  // to grab in the gap. Its line spans the cards' straight edges, short of their 10px corners. As an
  // overlay it is the panel's left edge. The portal keeps it in this React tree, so its keys still
  // reach the panel's `onKeyDown` (Esc).
  const handle = (gutter: boolean) => (
    <div data-slot={`${slot}-resize`} role="separator" aria-orientation="vertical" aria-label="Resize panel" onPointerDown={onResizeStart}
      tabIndex={open ? 0 : -1} aria-valuenow={width} aria-valuemin={PANEL_MIN_W} onKeyDown={onResizeKey}
      data-resize-handle=""
      className={cn(RESIZE_HANDLE_CLASS, gutter ? "top-[10px] h-[calc(100%-20px)]" : "top-0 h-full")}
      // Half the gap, less half the 1px line, puts the line on the gutter's centre.
      style={{ left: gutter ? -(SHELL_GAP + 1) / 2 : 0 }} />
  );
  const resize = fullScreen ? null
    : docked ? (open && expanded ? createPortal(handle(true), dockEl!) : null)
    : handle(false);
  const common = {
    ref: panelRef, role: "dialog", "aria-modal": false, "aria-label": label, "aria-labelledby": labelledBy, "aria-hidden": !open,
    "data-slot": `${slot}-panel`, "data-state": open ? "open" : "closed", onKeyDown,
  } as const;
  if (docked) {
    // In the dock card: its full width from the card's left edge, so the dock's animated width slides
    // it in and out (clipped) and the content never reflows. No hairline: the card is the edge.
    // Closed, the 0-wide dock clips it (nothing painted) and a focus guard keeps focus out (see `idle`).
    // The open one is on top while the other leaves.
    return createPortal(
      <div {...common} data-docked="" data-idle={idle ? "" : undefined}
        onFocusCapture={(e) => { if (idle) (e.target as HTMLElement).blur(); }}
        // A constant `class` (see Dock in Shell.tsx: a class change here restyles the whole chat): the
        // stacking order is an inline style.
        className="bg-background text-foreground absolute inset-y-0 left-0 flex flex-col overflow-hidden"
        style={{ width, zIndex: open ? 1 : 0 }}
      >
        {resize}
        {header(swipe)}
        {children}
      </div>,
      dockClip!,
    );
  }
  return (
    // z-40: above the page and its sticky top bar (z-30), below menus and popovers (z-50), which must
    // still open over it. Slid out, it is hidden (visibility, after the transform finishes) and inert
    // to assistive tech. Opening, only the transform transitions — `visibility` flips to visible AT
    // ONCE, so a field inside can take focus in the same commit. Closing, visibility waits for the slide.
    <div
      {...common} data-full={fullScreen ? "" : undefined}
      className={cn("bg-background text-foreground flex flex-col overflow-hidden",
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
