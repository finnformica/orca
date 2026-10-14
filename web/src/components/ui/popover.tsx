import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn, POPPER_EDGE_PADDING, PortalContainer } from "@/lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

function PopoverContent({ className, align = "center", sideOffset = 4, collisionPadding = POPPER_EDGE_PADDING, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal container={React.useContext(PortalContainer)}>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn("bg-popover text-popover-foreground z-50 w-72 rounded-lg border p-3 shadow-menu outline-none", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
