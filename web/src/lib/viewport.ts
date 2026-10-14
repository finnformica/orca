// The phone layout's switches, in one place. "Narrow" is Tailwind's `max-md` (below 768px) — the same
// breakpoint the sidebar goes off-canvas at — so CSS (`max-md:`) and JS (`useNarrow`) agree, and the
// desktop layout (≥ 1024px, and the whole md range) never sees any of it. "Coarse" is a finger, not a
// mouse: Enter then inserts a newline (there is no Shift on a phone keyboard) and tap targets grow.
import { useSyncExternalStore } from "react";

export const NARROW_QUERY = "(max-width: 767px)";
export const COARSE_QUERY = "(pointer: coarse)";

const matches = (query: string): boolean => typeof window !== "undefined" && !!window.matchMedia?.(query).matches;

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia?.(query);
      mq?.addEventListener?.("change", onChange);
      window.addEventListener("resize", onChange); // happy-dom / older engines don't fire `change`
      return () => { mq?.removeEventListener?.("change", onChange); window.removeEventListener("resize", onChange); };
    },
    () => matches(query),
    () => false,
  );
}

/** The phone layout: sheets instead of floating windows, stacked rows, the bottom bar. */
export const useNarrow = (): boolean => useMedia(NARROW_QUERY);
export const isNarrow = (): boolean => matches(NARROW_QUERY);
/** A touch screen as the primary pointer, live (hover-only controls show without hover). */
export const useCoarse = (): boolean => useMedia(COARSE_QUERY);
/** A touch screen as the primary pointer. */
export const isCoarse = (): boolean => matches(COARSE_QUERY);

/** A phone (or a tablet with no real keyboard to lean on): a coarse pointer, or the mobile
 *  breakpoint — the ONE test every automatic composer focus checks before calling `.focus()`, so an
 *  opened panel/page, a send, a finished run or a quick-ask/palette hand-off never pops the on-screen
 *  keyboard over the page on its own. A direct tap into the box, or the native click-to-focus
 *  handler, never goes through this — those stay a real user gesture on every device. */
export const useIsMobile = (): boolean => { const narrow = useNarrow(); const coarse = useCoarse(); return narrow || coarse; };
export const isMobile = (): boolean => isNarrow() || isCoarse();

/** Enter sends a message only with a keyboard that has a Shift to break the line instead. On a touch
 *  screen the on-screen keyboard's Return inserts a newline and the Send button sends. Pure. */
export const enterSends = (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing?: boolean }, coarse: boolean): boolean =>
  !coarse && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing;

/** How far the visible area must fall short of the layout viewport before it counts as the on-screen
 *  keyboard rather than a toolbar collapsing (Safari's bars move by well under this). */
export const KEYBOARD_MIN_PX = 120;

/** Is the on-screen keyboard up? iOS never shrinks the layout viewport (or 100dvh) for it — only the
 *  VISUAL viewport gets shorter — so a visible height well short of the layout height means a
 *  keyboard. A pinch zoom also shrinks the visual viewport, so a zoomed page never counts. Pure. */
export const keyboardOpen = (m: { layoutHeight: number; height: number; scale?: number }): boolean =>
  (m.scale ?? 1) <= 1.01 && m.layoutHeight - m.height > KEYBOARD_MIN_PX;

/** Keep `--vvh` / `--vv-top` on <html> at the VISUAL viewport's height and offset. iOS Safari doesn't
 *  shrink the layout viewport for the on-screen keyboard (100dvh still reaches under it), so a
 *  full-screen sheet sized `var(--vvh, 100dvh)` is what keeps its composer above the keyboard.
 *  While the keyboard is up <html> also carries `data-keyboard` (`keyboardOpen`): on a phone the
 *  bottom bar steps aside, the document stops scrolling, and a chat marked `data-keyboard-fill` that
 *  holds the focus is pinned to exactly the visible area (styles.css), composer on the keyboard. */
export function trackVisualViewport(win: Window = window): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => {};
  const root = win.document.documentElement;
  const sync = () => {
    root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
    root.style.setProperty("--vv-top", `${Math.round(vv.offsetTop)}px`);
    const layoutHeight = Math.max(win.innerHeight || 0, root.clientHeight || 0);
    if (keyboardOpen({ layoutHeight, height: vv.height, scale: vv.scale })) root.dataset.keyboard = "open";
    else delete root.dataset.keyboard;
  };
  sync();
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  return () => { vv.removeEventListener("resize", sync); vv.removeEventListener("scroll", sync); delete root.dataset.keyboard; };
}

// Text cut off with an ellipsis has no hover on a phone to reveal it: a tap on it (when it really is
// cut off, and the tap isn't a control's) toggles it open — styles.css `[data-expanded]`.
const TAP_SKIP = "button, a, input, textarea, select, label, [role=button], [role=row], [role=menuitem], [role=tab], [role=option]";
export function expandTruncatedOnTap(win: Window = window): () => void {
  const onClick = (e: MouseEvent) => {
    if (!win.matchMedia?.(NARROW_QUERY).matches) return;
    const el = e.target as Element | null;
    const t = typeof el?.closest === "function" ? el.closest<HTMLElement>(".truncate, [data-expanded]") : null;
    if (!t || t.closest(TAP_SKIP)) return;
    if (t.dataset.expanded === "true") { delete t.dataset.expanded; return; }
    if (t.scrollWidth > t.clientWidth) t.dataset.expanded = "true";
  };
  win.document.addEventListener("click", onClick);
  return () => win.document.removeEventListener("click", onClick);
}
