// Keep a chat log pinned to its tail while the reader is at the tail. Two things move the end:
// - the scroller itself shrinks (a phone's keyboard opens, the composer grows);
// - content inside it grows after it rendered: a form card or a handoff pack that loads its data,
//   an image that decodes. The new-turn effect does not see these, so the newest turn ended up below
//   the fold under a form card that had just loaded.
// So one ResizeObserver watches the scroller AND each of its direct children (any growth inside a
// turn changes the size of the child that holds it), and a MutationObserver keeps that list current.
// A reader who scrolled up (`following()` false) is never moved.

type RO = typeof ResizeObserver;
type MO = typeof MutationObserver;

/** Start pinning `el` to its tail; returns the cleanup. The observers are arguments for the tests. */
export function stickToTail(
  el: HTMLElement,
  following: () => boolean,
  Resize: RO | undefined = globalThis.ResizeObserver,
  Mutation: MO | undefined = globalThis.MutationObserver,
): () => void {
  if (!Resize) return () => {};
  const pin = () => { if (following()) el.scrollTo({ top: el.scrollHeight }); };
  const ro = new Resize(pin);
  ro.observe(el);
  const watched = new Set<Element>();
  const sync = () => {
    for (const child of Array.from(el.children)) if (!watched.has(child)) { watched.add(child); ro.observe(child); }
    for (const child of Array.from(watched)) if (child.parentElement !== el) { watched.delete(child); ro.unobserve(child); }
  };
  sync();
  const mo = Mutation ? new Mutation(sync) : undefined;
  mo?.observe(el, { childList: true });
  return () => { ro.disconnect(); mo?.disconnect(); };
}
