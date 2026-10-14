import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn, PortalContainer } from "@/lib/utils";

const Select = SelectPrimitive.Root;

function SelectValue({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" className={className} {...props} />;
}

function SelectTrigger({ className, children, size = "default", ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger> & { size?: "default" | "sm" }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        // justify-between (not left-aligned by default) relied on the value growing to fill the
        // leftover space itself — true for a <SelectValue>, tagged [data-slot=select-value] below,
        // but a trigger whose label is raw children (ModelPicker's {current}) has no such element to
        // grow, and the leftover width split evenly around it instead of sitting after the label.
        // ml-auto on the chevron pins it to the right directly, so every trigger left-aligns its
        // content regardless of how that content is passed.
        "border-input focus-visible:ring-ring/40 flex min-w-0 w-fit cursor-pointer items-center overflow-hidden rounded-md border bg-card whitespace-nowrap outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:flex-1 [&_[data-slot=select-value]]:truncate [&_svg]:ml-auto [&_svg]:shrink-0",
        size === "sm" ? "h-7 gap-1 px-1.5 text-xs [&_svg]:size-3.5" : "h-8 gap-2 px-2 text-sm [&_svg]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild><ChevronDownIcon className="opacity-50" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal container={React.useContext(PortalContainer)}>
      <SelectPrimitive.Content
        data-slot="select-content"
        position="popper"
        className={cn("bg-popover text-popover-foreground relative z-50 max-h-64 min-w-[8rem] overflow-y-auto rounded-lg border p-1 shadow-menu", className)}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-0">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn("focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm outline-none select-none", className)}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator><CheckIcon className="size-4" /></SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
