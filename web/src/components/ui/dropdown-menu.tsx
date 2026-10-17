import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react";
import { cn, POPPER_EDGE_PADDING } from "@/lib/utils";

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const DropdownMenuLabel = ({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) => (
  <DropdownMenuPrimitive.Label className={cn("text-muted-foreground px-2 py-1 text-xs font-medium tracking-wide uppercase", className)} {...props} />
);

function DropdownMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn("focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent flex cursor-default items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({ className, sideOffset = 4, collisionPadding = POPPER_EDGE_PADDING, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn("bg-popover text-popover-foreground z-50 min-w-[10rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-lg border p-1 shadow-menu data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2", className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuContent({ className, sideOffset = 4, collisionPadding = POPPER_EDGE_PADDING, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn("bg-popover text-popover-foreground z-50 min-w-[10rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-lg border p-1 shadow-menu data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2", className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn("focus:bg-accent focus:text-accent-foreground relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none", className)}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({ className, children, checked, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      className={cn("focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center justify-between gap-4 rounded-md px-2 py-1.5 text-sm outline-none select-none", className)}
      checked={checked}
      {...props}
    >
      {children}
      <DropdownMenuPrimitive.ItemIndicator><CheckIcon className="size-4" /></DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

/** `indicator` replaces the checked dot — the server menu checks its row, as its rows carry a status dot. */
function DropdownMenuRadioItem({ className, children, indicator, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem> & { indicator?: React.ReactNode }) {
  return (
    <DropdownMenuPrimitive.RadioItem
      className={cn("focus:bg-accent focus:text-accent-foreground relative flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 pl-7 text-sm outline-none select-none", className)}
      {...props}
    >
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>{indicator ?? <CircleIcon className="size-2 fill-current" />}</DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

const DropdownMenuSeparator = ({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) => (
  <DropdownMenuPrimitive.Separator className={cn("bg-border -mx-1 my-1 h-px", className)} {...props} />
);

export {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuLabel, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
};
