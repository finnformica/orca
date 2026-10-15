import * as React from "react";
import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import { cn, POPPER_EDGE_PADDING, PortalContainer } from "@/lib/utils";

/** A generic hover/focus preview surface (any trigger, any content) — the first use is the review
 *  cluster's unresolved chip, but nothing here is specific to it. Opens after a short delay so a
 *  passing cursor doesn't trigger it, closes a touch faster so it doesn't linger; touch is excluded
 *  entirely (Radix's own `excludeTouch`), so a tap always falls through to whatever the trigger's
 *  own click does instead of fighting it for the first tap. */
function HoverCard({ openDelay = 150, closeDelay = 100, ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root openDelay={openDelay} closeDelay={closeDelay} {...props} />;
}
const HoverCardTrigger = HoverCardPrimitive.Trigger;

function HoverCardContent({ className, align = "center", sideOffset = 8, collisionPadding = POPPER_EDGE_PADDING, ...props }: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal container={React.useContext(PortalContainer)}>
      <HoverCardPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "bg-popover text-popover-foreground z-50 origin-(--radix-hover-card-content-transform-origin) rounded-lg border p-0 shadow-menu outline-none",
          // A slight entry/exit, not a production: fade + a 95%→100% zoom, nudged in from
          // whichever side it opened on (tw-animate-css's data-state-driven animate-in/out).
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 duration-150",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
