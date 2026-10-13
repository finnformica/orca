// An icon-only button's tooltip: the label (and its shortcut's keycaps, from the one table) shown
// above the button on hover or keyboard focus. CSS only — no positioning dependency — and anchored
// to the button's right edge, since the icon rows that use it sit at the right of a card or a row
// inside a scroller, where a centred tip would overflow sideways. The button carries the same text as
// its aria-label; the tip is for the eye.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Shortcut } from "@/components/ui/kbd";
import type { ShortcutId } from "@/lib/shortcuts";

export function Tip({ label, shortcut, children, className }: { label: string; shortcut?: ShortcutId; children: ReactNode; className?: string }) {
  return (
    <span data-slot="tip" className={cn("group/tip relative inline-flex", className)}>
      {children}
      <span role="tooltip" data-slot="tip-content"
        className="bg-foreground text-background pointer-events-none absolute right-0 bottom-full z-10 mb-1.5 hidden items-center gap-1.5 rounded-md px-2 py-1 text-xs whitespace-nowrap group-focus-within/tip:flex group-hover/tip:flex">
        {label}
        {shortcut && <Shortcut id={shortcut} keyClassName="text-background/70 border-background/30" />}
      </span>
    </span>
  );
}
