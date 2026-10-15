import { createContext } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Where Radix popovers/menus portal to. Unset = the page's body; the orchestrator's Picture-in-Picture
 *  window sets its own body, or a menu opened there would appear back in the tab. */
export const PortalContainer = createContext<HTMLElement | undefined>(undefined);

/** True inside the orchestrator's popped-out Picture-in-Picture window (Terminal.tsx). Tailwind's
 *  `max-md:` utilities are real `@media (max-width: 767px)` rules, evaluated against whatever
 *  document they render in — the docked side panel reads the main (desktop-width) window, but the
 *  PiP window is its own, often narrower document, so the SAME composer read itself as "phone" there.
 *  Components that switch composer sizing on `max-md:` read this instead of trusting the viewport. */
export const PipContext = createContext(false);

/** Every raised surface's (popover, dropdown, select, hover card) Radix `collisionPadding` — keeps
 *  it off the viewport edge when its trigger sits near one, instead of flush against it. */
export const POPPER_EDGE_PADDING = 8;
