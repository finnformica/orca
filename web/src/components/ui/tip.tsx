// An icon-only button's tooltip: the label (and its shortcut's keycaps, from the one table) shown
// above the button on hover or keyboard focus. CSS only — no positioning dependency — and anchored
// to the button's right edge, since the icon rows that use it sit at the right of a card or a row
// inside a scroller, where a centred tip would overflow sideways. The button carries the same text as
// its aria-label; the tip is for the eye. `side="bottom"` for a control near the top of the page,
// where a tip above it would slide under the sticky top bar (z-30).
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Shortcut } from "@/components/ui/kbd";
import type { ShortcutId } from "@/lib/shortcuts";

export function Tip({ label, shortcut, children, className, side = "top" }: { label: string; shortcut?: ShortcutId; children: ReactNode; className?: string; side?: "top" | "bottom" }) {
  return (
    <span data-slot="tip" className={cn("group/tip relative inline-flex", className)}>
      {children}
      <span role="tooltip" data-slot="tip-content" data-side={side}
        className={cn("bg-foreground text-background pointer-events-none absolute right-0 z-10 hidden items-center gap-1.5 rounded-md px-2 py-1 text-xs whitespace-nowrap group-focus-within/tip:flex group-hover/tip:flex",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5")}>
        {label}
        {shortcut && <Shortcut id={shortcut} keyClassName="text-background/70 border-background/30" />}
      </span>
    </span>
  );
}
