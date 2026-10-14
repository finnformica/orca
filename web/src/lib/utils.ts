import { createContext } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Where Radix popovers/menus portal to. Unset = the page's body; the orchestrator's Picture-in-Picture
 *  window sets its own body, or a menu opened there would appear back in the tab. */
export const PortalContainer = createContext<HTMLElement | undefined>(undefined);

/** Every raised surface's (popover, dropdown, select, hover card) Radix `collisionPadding` — keeps
 *  it off the viewport edge when its trigger sits near one, instead of flush against it. */
export const POPPER_EDGE_PADDING = 8;
