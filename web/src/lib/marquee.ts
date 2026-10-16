// The hover marquee for a truncated title (components/ui/marquee-text.tsx): only a title that is
// REALLY truncated should move, decided off the rendered box (scrollWidth vs clientWidth), never off
// the string's length — the same text can fit or not depending on the font and the width it lands in.
// Speed scales with how far the text has to travel, so a long title and a short one feel like the
// same pace instead of the short one finishing in a blink or the long one crawling.

/** A sub-pixel layout rounding gap is not a real overflow. */
const OVERFLOW_EPSILON = 1;

/** True once the content truly overflows the box it's rendered in. */
export function isTruncated(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth - clientWidth > OVERFLOW_EPSILON;
}

const MARQUEE_PX_PER_MS = 1 / 18; // ~55px/s, a comfortable reading speed
const MARQUEE_MIN_MS = 400;
const MARQUEE_MAX_MS = 6000;

/** How long the scroll should take to cover `overflowPx`, so a short and a long overflow travel at
 *  the same speed rather than the same duration. Clamped so a tiny overflow still reads as motion
 *  and a huge one doesn't crawl for ages. */
export function marqueeDuration(overflowPx: number): number {
  const ms = Math.round(overflowPx / MARQUEE_PX_PER_MS);
  return Math.min(MARQUEE_MAX_MS, Math.max(MARQUEE_MIN_MS, ms));
}
