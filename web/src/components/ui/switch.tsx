import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

/** `children` render inside the thumb (the usage row's ✕ on a failed toggle). */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & { size?: "sm" | "default" }
>(({ className, size = "default", children, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    data-slot="switch"
    data-size={size}
    className={cn(
      "peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:ring-ring/40 inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent outline-none transition-all focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50",
      size === "sm" ? "h-4 w-7" : "h-[1.15rem] w-8",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      data-slot="switch-thumb"
      className={cn(
        "bg-background pointer-events-none flex items-center justify-center rounded-full ring-0 transition-transform data-[state=unchecked]:translate-x-0",
        size === "sm" ? "size-3 data-[state=checked]:translate-x-3.5 data-[state=unchecked]:translate-x-0.5" : "size-4 data-[state=checked]:translate-x-[calc(100%-2px)]",
      )}
    >
      {children}
    </SwitchPrimitive.Thumb>
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

export { Switch };
