// An icon-only button's tooltip: the label (and its shortcut's keycaps, from the one table) shown
// on hover — after the provider's delay — or keyboard focus. The shadcn Tooltip (Radix), so it is
// positioned and flipped/shifted against the viewport: the icon rows that use it sit at the right
// of a card or a row inside a scroller, so top/bottom tips are aligned to the button's END edge, as
// the old CSS-only tip was. The button carries the same text as its aria-label; the tip is for the
// eye. `side="bottom"` for a control near the top of the page, under the sticky top bar;
// `side="right"` for the collapsed sidebar's icons, whose tip opens beside them.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Shortcut } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ShortcutId } from "@/lib/shortcuts";

export function Tip({ label, shortcut, children, className, side = "top" }: { label: string; shortcut?: ShortcutId; children: ReactNode; className?: string; side?: "top" | "bottom" | "right" }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-slot="tip" className={cn("relative inline-flex", className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent data-slot="tip-content" side={side} align={side === "right" ? "center" : "end"}
        className="flex items-center gap-1.5 whitespace-nowrap">
        {label}
        {shortcut && <Shortcut id={shortcut} keyClassName="text-background/70 border-background/30" />}
      </TooltipContent>
    </Tooltip>
  );
}
