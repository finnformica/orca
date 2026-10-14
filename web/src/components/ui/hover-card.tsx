import * as React from "react";
import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import { cn, PortalContainer } from "@/lib/utils";

const HoverCard = HoverCardPrimitive.Root;
const HoverCardTrigger = HoverCardPrimitive.Trigger;

function HoverCardContent({ className, align = "center", sideOffset = 4, ...props }: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal container={React.useContext(PortalContainer)}>
      <HoverCardPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn("bg-popover text-popover-foreground z-50 rounded-lg border p-0 shadow-menu outline-none", className)}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
