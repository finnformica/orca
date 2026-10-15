// A Tip is a Radix tooltip: its content is mounted only while open, in a portal. Keyboard focus
// opens it at once (hover waits for the provider's delay), so tests open it the way a keyboard user
// does and read what it shows.
import { act } from "react";

/** Opens the Tip wrapping `el` and returns its `role="tooltip"` node (the label + any keycaps);
 *  `.closest('[data-slot="tip-content"]')` on it is the visible surface, with `data-side`. Opening
 *  one closes any other, as on the page. */
export function openTip(el: Element): HTMLElement {
  const trigger = el.closest('[data-slot="tip"]');
  if (!trigger) throw new Error("not inside a Tip");
  act(() => { trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
  const id = trigger.getAttribute("aria-describedby");
  const tip = id ? document.getElementById(id) : null;
  if (!tip) throw new Error("the Tip did not open");
  return tip;
}
