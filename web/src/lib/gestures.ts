// Touch gestures for the phone layout. Swipe down on a sheet's header (its handle) to close it — the
// handle, not the sheet's body, so the gesture never fights the log or list scrolling inside it. Pull
// down from the top of the Agents list to refresh. Thresholds are pure (workstream.ts swipeDecision /
// pullState); here is only the pointer and touch plumbing.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { pullState, swipeDecision } from "../workstream";

const CONTROLS = "button, a, input, textarea, select, [role=combobox]";

/** Props for a sheet's handle (its header): dragging it down moves `sheet()` with the finger, and past
 *  the threshold (or on a flick) calls `onClose`; otherwise it springs back. Off when `enabled` is
 *  false (a desktop window keeps its own drag). */
export function useSwipeToClose(sheet: () => HTMLElement | null | undefined, onClose: () => void, enabled = true) {
  const onPointerDown = (e: ReactPointerEvent) => {
    if (!enabled || e.button !== 0 || (e.target as HTMLElement).closest(CONTROLS)) return;
    const el = sheet();
    if (!el) return;
    const y0 = e.clientY, t0 = e.timeStamp;
    const height = el.getBoundingClientRect().height || window.innerHeight;
    let dy = 0;
    const move = (ev: PointerEvent) => {
      dy = Math.max(0, ev.clientY - y0);
      el.style.transition = "none";
      el.style.transform = dy ? `translateY(${dy}px)` : "";
    };
    const end = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const close = ev.type === "pointerup" && swipeDecision({ dy, ms: ev.timeStamp - t0, height }) === "close";
      el.style.transition = "transform 150ms ease-out";
      el.style.transform = "";
      if (close) onClose();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  return enabled ? { onPointerDown, "data-swipe-handle": "" } : {};
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
