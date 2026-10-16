// Touch gestures for the phone layout. Every drawer and sheet dismisses by a swipe toward the edge it
// came from, through ONE hook (useSwipeToDismiss): a bottom sheet down, a left drawer left, a right
// drawer right. Its handle (the header) follows the finger at once; its scrolling body, when given,
// joins in only when the move is mostly along that axis and the content is at its start (a bottom
// sheet scrolled to the top), so it never fights the list scrolling inside it. Pull down from the top
// of the Agents list to refresh. Thresholds are pure (workstream.ts swipeDecision / swipeArm /
// swipeOffset / pullState); here is only the pointer and touch plumbing.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { pullState, swipeArm, swipeDecision, swipeOffset, SWIPE_SLOP_PX, type SwipeEdge } from "../workstream";

export type { SwipeEdge };

const CONTROLS = "button, a, input, textarea, select, [role=combobox]";

// A sheet's spring: the drag snaps back (and BottomSheet slides in and out) on this curve.
export const SHEET_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

const vertical = (edge: SwipeEdge) => edge === "bottom";
/** Follow the finger: the drawer sits `d` px toward its edge, with no transition lag. */
function dragTo(el: HTMLElement, edge: SwipeEdge, d: number) {
  el.style.transition = "none";
  el.style.transform = !d ? "" : vertical(edge) ? `translateY(${d}px)` : `translateX(${edge === "left" ? -d : d}px)`;
}
/** Let go: spring back, or close. `hold` leaves the drawer where the finger left it, so a drawer that
 *  animates its own close (BottomSheet, the side panel) slides on from there instead of jumping back. */
function release(el: HTMLElement, close: boolean, onClose: () => void, hold: boolean) {
  if (close && hold) { onClose(); return; }
  el.style.transition = `transform 300ms ${SHEET_EASE}`;
  el.style.transform = "";
  setTimeout(() => { if (!el.style.transform) el.style.transition = ""; }, 300); // leave no inline transition behind
  if (close) onClose();
}
/** Close or spring back, from the distance along the dismiss axis and the drawer's size on it. */
const decide = (el: HTMLElement, edge: SwipeEdge, d: number, ms: number) => {
  const r = el.getBoundingClientRect();
  const size = (vertical(edge) ? r.height : r.width) || (vertical(edge) ? window.innerHeight : window.innerWidth);
  return swipeDecision({ dy: d, ms, height: size }) === "close";
};
/** Whether `body`'s content is at the start of its scroll for this edge: a swipe there is a dismiss. */
function atStart(body: HTMLElement, edge: SwipeEdge) {
  if (edge === "bottom") return body.scrollTop <= 0;
  if (edge === "right") return body.scrollLeft <= 0;
  return body.scrollLeft + body.clientWidth >= body.scrollWidth;
}

export type SwipeOptions = {
  /** Off (e.g. a desktop window, which keeps its own drag): no props, no listeners. Default on. */
  enabled?: boolean;
  /** The drawer animates its own close from where the finger left it. */
  hold?: boolean;
  /** The drawer's scrolling body: a swipe from it dismisses too, under the axis and scroll rules. */
  body?: HTMLElement | null;
};

/** Swipe a drawer toward `edge` to dismiss it. Returns the props for its handle (its header): a drag
 *  there moves `drawer()` with the finger, and past the threshold (or on a flick) calls `onClose`;
 *  otherwise it springs back. With `body`, a swipe on the scrolling body works too — touch events,
 *  not pointer events, because the body must keep its pan to scroll and the browser cancels a pointer
 *  the moment it takes the pan; a non-passive touchmove can claim the gesture instead. */
export function useSwipeToDismiss(edge: SwipeEdge, drawer: () => HTMLElement | null | undefined, onClose: () => void, { enabled = true, hold = false, body = null }: SwipeOptions = {}) {
  const close = useRef(onClose), drawerOf = useRef(drawer);
  close.current = onClose; drawerOf.current = drawer;
  useEffect(() => {
    if (!enabled || !body) return;
    let x0 = 0, y0: number | null = null, t0 = 0, d = 0, dragging = false;
    const point = (e: TouchEvent) => ({ x: e.touches[0]!.clientX ?? 0, y: e.touches[0]!.clientY });
    const start = (e: TouchEvent) => {
      const t = e.target as Element | null;
      // The handle has its own (pointer) drag; a field keeps its text selection.
      y0 = e.touches.length === 1 && !t?.closest?.("input, textarea, select, [data-swipe-handle]") ? point(e).y : null;
      if (y0 !== null) x0 = point(e).x;
      t0 = e.timeStamp; d = 0; dragging = false;
    };
    const move = (e: TouchEvent) => {
      if (y0 === null) return;
      const p = point(e);
      if (!dragging) {
        const verdict = swipeArm({ edge, dx: p.x - x0, dy: p.y - y0, atStart: atStart(body, edge) });
        if (verdict === "wait") return; // a tap's wobble
        if (verdict === "scroll") { y0 = null; return; } // the content's own scroll
        dragging = true;
        // Start from here, not with a jump.
        if (vertical(edge)) y0 += SWIPE_SLOP_PX; else x0 += edge === "left" ? -SWIPE_SLOP_PX : SWIPE_SLOP_PX;
      }
      if (e.cancelable) e.preventDefault(); // no scroll, no overscroll bounce, no click on lift
      d = swipeOffset(edge, p.x - x0, p.y - y0);
      const el = drawerOf.current();
      if (el) dragTo(el, edge, d);
    };
    const end = (e: TouchEvent) => {
      const was = dragging;
      y0 = null; dragging = false;
      const el = drawerOf.current();
      if (!was || !el) return;
      release(el, e.type === "touchend" && decide(el, edge, d, e.timeStamp - t0), () => close.current(), hold);
    };
    body.addEventListener("touchstart", start, { passive: true });
    body.addEventListener("touchmove", move, { passive: false });
    body.addEventListener("touchend", end);
    body.addEventListener("touchcancel", end);
    return () => {
      body.removeEventListener("touchstart", start); body.removeEventListener("touchmove", move);
      body.removeEventListener("touchend", end); body.removeEventListener("touchcancel", end);
    };
  }, [body, edge, enabled, hold]);
  const onPointerDown = (e: ReactPointerEvent) => {
    if (!enabled || e.button !== 0 || (e.target as HTMLElement).closest(CONTROLS)) return;
    const el = drawer();
    if (!el) return;
    const x0 = e.clientX, y0 = e.clientY, t0 = e.timeStamp;
    let d = 0;
    const move = (ev: PointerEvent) => { d = swipeOffset(edge, ev.clientX - x0, ev.clientY - y0); dragTo(el, edge, d); };
    const end = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      release(el, ev.type === "pointerup" && decide(el, edge, d, ev.timeStamp - t0), onClose, hold);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  return enabled ? { onPointerDown, "data-swipe-handle": edge } : {};
}

/** Pull to refresh on `ref`'s element: armed only when the page is scrolled to the top. Returns what
 *  the indicator shows. */
export function usePullToRefresh(ref: RefObject<HTMLElement | null>, onRefresh: () => Promise<unknown>, enabled = true) {
  const [state, setState] = useState<{ phase: "idle" | "pull" | "release" | "refreshing"; offset: number }>({ phase: "idle", offset: 0 });
  const busy = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let y0: number | null = null, last = pullState(0);
    // A touch inside a dialog (the Filters sheet is a DOM child of the list) is that sheet's gesture.
    const inSheet = (e: TouchEvent) => !!(e.target as Element | null)?.closest?.("dialog, [role=dialog], [data-swipe-handle]");
    const start = (e: TouchEvent) => { y0 = !busy.current && window.scrollY <= 0 && e.touches.length === 1 && !inSheet(e) ? e.touches[0]!.clientY : null; };
    const move = (e: TouchEvent) => {
      if (y0 === null) return;
      last = pullState(e.touches[0]!.clientY - y0);
      setState(last);
    };
    const end = () => {
      if (y0 === null) return;
      y0 = null;
      if (last.phase !== "release") { last = pullState(0); setState(last); return; }
      busy.current = true;
      setState({ phase: "refreshing", offset: 48 });
      void onRefresh().catch(() => {}).finally(() => { busy.current = false; last = pullState(0); setState(last); });
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: true });
    el.addEventListener("touchend", end);
    const cancel = () => { y0 = null; last = pullState(0); setState(last); }; // the browser took the gesture
    el.addEventListener("touchcancel", cancel);
    return () => {
      el.removeEventListener("touchstart", start); el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end); el.removeEventListener("touchcancel", cancel);
    };
  }, [ref, enabled, onRefresh]);
  return state;
}
