// Touch gestures for the phone layout. Swipe down on a sheet's header (its handle) to close it; a
// BottomSheet's body swipes too, but only from the top of its scroll, so it never fights the list
// scrolling inside it (the terminal's log keeps the handle-only swipe). Pull
// down from the top of the Agents list to refresh. Thresholds are pure (workstream.ts swipeDecision /
// pullState); here is only the pointer and touch plumbing.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { pullState, swipeDecision } from "../workstream";

const CONTROLS = "button, a, input, textarea, select, [role=combobox]";

// A sheet's spring: the drag snaps back (and BottomSheet slides in and out) on this curve.
export const SHEET_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

/** Follow the finger: the sheet sits `dy` px below its resting place, with no transition lag. */
function dragTo(el: HTMLElement, dy: number) {
  el.style.transition = "none";
  el.style.transform = dy ? `translateY(${dy}px)` : "";
}
/** Let go: spring back, or close. `hold` leaves the sheet where the finger left it, so a sheet that
 *  animates its own close (BottomSheet) slides on from there instead of jumping back first. */
function release(el: HTMLElement, close: boolean, onClose: () => void, hold: boolean) {
  if (close && hold) { onClose(); return; }
  el.style.transition = `transform 300ms ${SHEET_EASE}`;
  el.style.transform = "";
  if (close) onClose();
}

/** Props for a sheet's handle (its header): dragging it down moves `sheet()` with the finger, and past
 *  the threshold (or on a flick) calls `onClose`; otherwise it springs back. Off when `enabled` is
 *  false (a desktop window keeps its own drag). */
export function useSwipeToClose(sheet: () => HTMLElement | null | undefined, onClose: () => void, enabled = true, { hold = false } = {}) {
  const onPointerDown = (e: ReactPointerEvent) => {
    if (!enabled || e.button !== 0 || (e.target as HTMLElement).closest(CONTROLS)) return;
    const el = sheet();
    if (!el) return;
    const y0 = e.clientY, t0 = e.timeStamp;
    const height = el.getBoundingClientRect().height || window.innerHeight;
    let dy = 0;
    const move = (ev: PointerEvent) => { dy = Math.max(0, ev.clientY - y0); dragTo(el, dy); };
    const end = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      release(el, ev.type === "pointerup" && swipeDecision({ dy, ms: ev.timeStamp - t0, height }) === "close", onClose, hold);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  return enabled ? { onPointerDown, "data-swipe-handle": "" } : {};
}

/** Swipe down anywhere on a sheet's scrolling BODY: armed only while `body` is scrolled to the top
 *  and the finger moves down, so scrolling the content up and back is still a scroll. Touch events,
 *  not pointer events — the body must keep `touch-action: pan-y` to scroll, and the browser cancels a
 *  pointer the moment it takes the pan; a non-passive touchmove can claim the gesture instead. */
export function useSwipeBodyToClose(body: HTMLElement | null, sheet: () => HTMLElement | null | undefined, onClose: () => void, { hold = false } = {}) {
  const close = useRef(onClose), sheetOf = useRef(sheet);
  close.current = onClose; sheetOf.current = sheet;
  useEffect(() => {
    if (!body) return;
    let y0: number | null = null, t0 = 0, dy = 0, dragging = false;
    const start = (e: TouchEvent) => {
      y0 = e.touches.length === 1 && !(e.target as Element | null)?.closest?.("input, textarea, select") ? e.touches[0]!.clientY : null;
      t0 = e.timeStamp; dy = 0; dragging = false;
    };
    const move = (e: TouchEvent) => {
      if (y0 === null) return;
      const d = e.touches[0]!.clientY - y0;
      if (!dragging) {
        if (d < 0 || body.scrollTop > 0) { y0 = null; return; } // the content's own scroll
        if (d < 8) return; // a tap's wobble
        dragging = true; y0 += 8; // start from here, not with a jump
      }
      if (e.cancelable) e.preventDefault(); // no scroll, no overscroll bounce, no click on lift
      const el = sheetOf.current();
      dy = Math.max(0, e.touches[0]!.clientY - y0);
      if (el) dragTo(el, dy);
    };
    const end = (e: TouchEvent) => {
      const was = dragging;
      y0 = null; dragging = false;
      const el = sheetOf.current();
      if (!was || !el) return;
      const height = el.getBoundingClientRect().height || window.innerHeight;
      release(el, e.type === "touchend" && swipeDecision({ dy, ms: e.timeStamp - t0, height }) === "close", () => close.current(), hold);
    };
    body.addEventListener("touchstart", start, { passive: true });
    body.addEventListener("touchmove", move, { passive: false });
    body.addEventListener("touchend", end);
    body.addEventListener("touchcancel", end);
    return () => {
      body.removeEventListener("touchstart", start); body.removeEventListener("touchmove", move);
      body.removeEventListener("touchend", end); body.removeEventListener("touchcancel", end);
    };
  }, [body]);
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
