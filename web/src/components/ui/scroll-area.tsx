import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "@/lib/utils";

/** shadcn's ScrollArea: a native scroll viewport with thin overlay scrollbars. Give it a height cap
 *  (`max-h-…` in `viewportClassName`) and it scrolls inside its card, by touch too. Radix wraps the
 *  content in a `display: table` div that grows to its widest line, so `truncate` never applies; a
 *  vertical-only area makes it a block, and its rows take the area's width. */
function ScrollArea({ className, viewportClassName, children, horizontal = false, ...props }: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & { viewportClassName?: string; horizontal?: boolean }) {
  return (
    <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn("relative overflow-hidden", className)} {...props}>
      <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className={cn("size-full rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring/50", !horizontal && "[&>div]:!block", viewportClassName)}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      {horizontal && <ScrollBar orientation="horizontal" />}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({ className, orientation = "vertical", ...props }: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar data-slot="scroll-area-scrollbar" orientation={orientation}
      className={cn("flex touch-none p-px transition-colors select-none",
        orientation === "vertical" ? "h-full w-2.5 border-l border-l-transparent" : "h-2.5 flex-col border-t border-t-transparent", className)}
      {...props}>
      <ScrollAreaPrimitive.ScrollAreaThumb data-slot="scroll-area-thumb" className="bg-border relative flex-1 rounded-full" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
