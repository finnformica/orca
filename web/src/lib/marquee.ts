// The hover marquee for truncated text, app-wide (components/OverflowText.tsx mounts it once at the
// root). Every single-line truncation in the app is Tailwind's `truncate`; hovering one with a mouse
// scrolls it (its own scrollLeft — overflow:hidden still scrolls from script) from the start to the
// cut-off end, holds, and back, until the pointer leaves. Delegated from the document, so no call
// site wraps its text and a flex `truncate` with icons scrolls as one. Only text that REALLY
// overflows moves, decided off the rendered box (scrollWidth vs clientWidth), never off the string's
// length — the same text can fit or not depending on the font and the width it lands in. With
// reduced motion nothing moves: the root's Tip shows the whole value instead. Touch has no hover:
// a tap expands the text instead (lib/viewport expandTruncatedOnTap, the same selector and test).
// Speed scales with how far the text has to travel, so a long and a short title feel like the same pace.

/** A sub-pixel layout rounding gap is not a real overflow. */
const OVERFLOW_EPSILON = 1;

/** True once the content truly overflows the box it's rendered in. */
export function isTruncated(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth - clientWidth > OVERFLOW_EPSILON;
}

/** The text the marquee and tap-to-expand act on: every single-line truncation (Tailwind `truncate`). */
export const TRUNCATED_SELECTOR = ".truncate";
/** Fields scroll their own value; a marquee there would fight the caret. */
const MARQUEE_SKIP = "input, textarea, select, [contenteditable=true]";

const MARQUEE_PX_PER_MS = 1 / 18; // ~55px/s, a comfortable reading speed
const MARQUEE_MIN_MS = 400;
const MARQUEE_MAX_MS = 6000;
/** The pause at the start before it moves (a pass over a row doesn't set every title moving), and at the end. */
export const MARQUEE_HOLD_START_MS = 500;
export const MARQUEE_HOLD_END_MS = 1000;

/** How long the scroll should take to cover `overflowPx`, so a short and a long overflow travel at
 *  the same speed rather than the same duration. Clamped so a tiny overflow still reads as motion
 *  and a huge one doesn't crawl for ages. */
export function marqueeDuration(overflowPx: number): number {
  const ms = Math.round(overflowPx / MARQUEE_PX_PER_MS);
  return Math.min(MARQUEE_MAX_MS, Math.max(MARQUEE_MIN_MS, ms));
}

const ease = (p: number) => (1 - Math.cos(Math.PI * p)) / 2; // ease-in-out: no jolt at either end

/** The scroll offset `ms` after the hover began: hold at the start, ease to the end, hold, ease back,
 *  and repeat. Whole pixels between 0 and `overflowPx`. */
export function marqueeOffset(ms: number, overflowPx: number): number {
  if (overflowPx <= 0 || ms <= 0) return 0;
  const travel = marqueeDuration(overflowPx);
  const period = MARQUEE_HOLD_START_MS + travel + MARQUEE_HOLD_END_MS + travel;
  let t = ms % period;
  if ((t -= MARQUEE_HOLD_START_MS) < 0) return 0;
  if (t < travel) return Math.round(overflowPx * ease(t / travel));
  if ((t -= travel + MARQUEE_HOLD_END_MS) < 0) return overflowPx;
  return Math.round(overflowPx * (1 - ease(Math.min(1, t / travel))));
}

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** What the root shows for a truncated element under reduced motion: its full text, at its box. */
export type OverflowTipState = { el: HTMLElement; text: string } | null;

/** Install the hover marquee on a document. `onTip` gets the element to label (or null) when
 *  reduced motion is on. Returns the cleanup. */
export function marqueeTruncatedOnHover(win: Window, onTip: (tip: OverflowTipState) => void = () => {}): () => void {
  const doc = win.document;
  let active: HTMLElement | null = null;
  let frame = 0;
  const stop = () => {
    if (!active) return;
    win.cancelAnimationFrame(frame);
    const el = active;
    active = null;
    delete el.dataset.marquee;
    el.scrollLeft = 0;
    onTip(null);
  };
  const onOver = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return; // a finger taps to expand instead
    const target = e.target as Element | null;
    const el = typeof target?.closest === "function" ? target.closest<HTMLElement>(TRUNCATED_SELECTOR) : null;
    if (el === active) return;
    stop();
    if (!el || el.matches(MARQUEE_SKIP) || el.dataset.expanded === "true") return;
    if (!isTruncated(el.scrollWidth, el.clientWidth)) return; // fits: no motion, no tip
    active = el;
    el.dataset.marquee = "";
    if (win.matchMedia?.(REDUCED_MOTION_QUERY).matches) { onTip({ el, text: (el.textContent ?? "").trim() }); return; }
    const start = win.performance.now();
    const step = (now: number) => {
      if (active !== el) return;
      if (!el.isConnected) { stop(); return; }
      el.scrollLeft = marqueeOffset(now - start, el.scrollWidth - el.clientWidth);
      frame = win.requestAnimationFrame(step);
    };
    frame = win.requestAnimationFrame(step);
  };
  const onOut = (e: PointerEvent) => {
    if (active && !active.contains(e.relatedTarget as Node | null)) stop();
  };
  doc.addEventListener("pointerover", onOver);
  doc.addEventListener("pointerout", onOut);
  return () => {
    stop();
    doc.removeEventListener("pointerover", onOver);
    doc.removeEventListener("pointerout", onOut);
  };
}
