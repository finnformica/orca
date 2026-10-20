// The phone layout's switches, in one place. "Narrow" is Tailwind's `max-md` (below 768px) — the same
// breakpoint the sidebar goes off-canvas at — so CSS (`max-md:`) and JS (`useNarrow`) agree, and the
// desktop layout (≥ 1024px, and the whole md range) never sees any of it. "Coarse" is a finger, not a
// mouse: Enter then inserts a newline (there is no Shift on a phone keyboard) and tap targets grow.
import { useSyncExternalStore } from "react";
import { isTruncated, TRUNCATED_SELECTOR } from "./marquee";

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
 *  bottom bar steps aside, the document stops scrolling, and the chat marked `data-keyboard-owner`
 *  is pinned to exactly the visible area (styles.css), composer on the keyboard.
 *
 *  The owner is the `data-keyboard-fill` holding the field that was focused, and it follows the
 *  KEYBOARD, not the focus: it is marked on focusin (so the pin lands in the same frame the keyboard's
 *  resize does) and kept through a blur until the keyboard has actually closed. Pinning on
 *  `:focus-within` jumped twice each way — a blur unpinned the chat while the keyboard was still up,
 *  then the keyboard closing moved it again. When the keyboard closes the document's scroll is put
 *  back where it was at that first focus: iOS scrolls the page to reveal the field, and with the
 *  page pinned and `overflow: hidden` nothing scrolled it back, so it came back offset.
 *  The CSS variables are written only when they change: iOS fires viewport `scroll` events
 *  continuously while the keyboard animates, and every write on <html> restyles the whole page. */
export const KEYBOARD_FILL = "[data-keyboard-fill]";
const EDITABLE = "input:not([type=button],[type=submit],[type=checkbox],[type=radio],[type=file]), textarea, select, [contenteditable]:not([contenteditable=false])";
export function trackVisualViewport(win: Window = window): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => {};
  const doc = win.document;
  const root = doc.documentElement;
  let open = false;
  let owner: Element | null = null;
  let restoreY: number | null = null;
  let vvh = "", top = "";
  const setOwner = (el: Element | null) => {
    if (owner === el) return;
    owner?.removeAttribute("data-keyboard-owner");
    owner = el;
    owner?.setAttribute("data-keyboard-owner", "");
  };
  const fillOf = (el: Element | null): Element | null =>
    el && typeof el.matches === "function" && el.matches(EDITABLE) ? el.closest(KEYBOARD_FILL) : null;
  const onFocusIn = (e: FocusEvent) => {
    const el = e.target as Element | null;
    if (!el || typeof el.matches !== "function" || !el.matches(EDITABLE)) return; // a button keeps the owner
    const fill = el.closest(KEYBOARD_FILL);
    if (fill && !open && restoreY === null) restoreY = win.scrollY ?? 0;
    setOwner(fill);
  };
  const sync = () => {
    const h = `${Math.round(vv.height)}px`, t = `${Math.round(vv.offsetTop)}px`;
    if (h !== vvh) root.style.setProperty("--vvh", (vvh = h));
    if (t !== top) root.style.setProperty("--vv-top", (top = t));
    const layoutHeight = Math.max(win.innerHeight || 0, root.clientHeight || 0);
    const now = keyboardOpen({ layoutHeight, height: vv.height, scale: vv.scale });
    if (now === open) return;
    open = now;
    if (open) {
      // Reopened over a field that kept its focus (an iPad's hide-keyboard key doesn't blur): no
      // focusin came, so the owner is read off the focus itself.
      if (!owner) setOwner(fillOf(doc.activeElement));
      root.dataset.keyboard = "open";
      return;
    }
    delete root.dataset.keyboard;
    const had = owner;
    setOwner(null);
    const y = restoreY;
    restoreY = null;
    if (had && y !== null && (win.scrollY ?? 0) !== y) win.scrollTo?.(win.scrollX ?? 0, y);
  };
  sync();
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  doc.addEventListener("focusin", onFocusIn);
  return () => {
    vv.removeEventListener("resize", sync);
    vv.removeEventListener("scroll", sync);
    doc.removeEventListener("focusin", onFocusIn);
    setOwner(null);
    delete root.dataset.keyboard;
  };
}

/** Keep a tap on a button from taking the focus off the composer on a phone (`onMouseDown`): the
 *  textarea blurring is what closes the keyboard, and the keyboard closing re-lays out the pinned
 *  chat between the tap's mousedown and its click — the button moved out from under the finger, the
 *  first tap was lost, and the keyboard dropped after every send. Claude's and iMessage's composers
 *  keep the keyboard up after a send; so does this. Desktop is left alone (focus moves as it always
 *  did). Only while a text field holds the focus — otherwise there is nothing to keep. */
export function keepComposerFocus(e: { preventDefault(): void; currentTarget: EventTarget | null }, mobile: boolean = isMobile()): void {
  if (!mobile) return;
  const active = (e.currentTarget as Element | null)?.ownerDocument?.activeElement;
  if (active && typeof active.matches === "function" && active.matches(EDITABLE)) e.preventDefault();
}

// Text cut off with an ellipsis has no hover on a phone to reveal it: a tap on it (when it really is
// cut off, and the tap isn't a control's) toggles it open — styles.css `[data-expanded]`. The same
// selector and overflow test as the mouse's hover marquee (lib/marquee), so both act on the same text.
const TAP_SKIP = "button, a, input, textarea, select, label, [role=button], [role=row], [role=menuitem], [role=tab], [role=option]";
export function expandTruncatedOnTap(win: Window = window): () => void {
  const onClick = (e: MouseEvent) => {
    if (!win.matchMedia?.(NARROW_QUERY).matches) return;
    const el = e.target as Element | null;
    const t = typeof el?.closest === "function" ? el.closest<HTMLElement>(`${TRUNCATED_SELECTOR}, [data-expanded]`) : null;
    if (!t || t.closest(TAP_SKIP)) return;
    if (t.dataset.expanded === "true") { delete t.dataset.expanded; return; }
    if (isTruncated(t.scrollWidth, t.clientWidth)) t.dataset.expanded = "true";
  };
  win.document.addEventListener("click", onClick);
  return () => win.document.removeEventListener("click", onClick);
}
