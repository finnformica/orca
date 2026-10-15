import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn, POPPER_EDGE_PADDING, PortalContainer } from "@/lib/utils";

/** How long a pointer rests on a trigger before its tooltip opens, and the window after one closes
 *  in which the next opens at once (moving along a row of icon buttons). */
export const TOOLTIP_DELAY_MS = 500;
export const TOOLTIP_SKIP_DELAY_MS = 300;

const HasProvider = React.createContext(false);

/** ONE at the app root, so the skip-delay window spans every tooltip on the page. */
function TooltipProvider({ delayDuration = TOOLTIP_DELAY_MS, skipDelayDuration = TOOLTIP_SKIP_DELAY_MS, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <HasProvider.Provider value={true}>
      <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props} />
    </HasProvider.Provider>
  );
}

/** A tooltip mounted outside the root provider (a component rendered on its own) brings its own. */
function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const root = <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
  return React.useContext(HasProvider) ? root : <TooltipProvider>{root}</TooltipProvider>;
}

function TooltipTrigger(props: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({ className, sideOffset = 6, collisionPadding = POPPER_EDGE_PADDING, ...props }: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal container={React.useContext(PortalContainer)}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "bg-foreground text-background z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-2 py-1 text-xs",
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
