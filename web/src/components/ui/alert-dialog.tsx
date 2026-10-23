import * as React from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn, PortalContainer } from "@/lib/utils";

const AlertDialog = AlertDialogPrimitive.Root;
const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

// forwardRef: Radix's Presence sets a ref on the overlay to watch its exit animation.
const AlertDialogOverlay = React.forwardRef<HTMLDivElement, React.ComponentProps<typeof AlertDialogPrimitive.Overlay>>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Overlay
    ref={ref}
    data-slot="alert-dialog-overlay"
    className={cn("fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0", className)}
    {...props}
  />
));
AlertDialogOverlay.displayName = "AlertDialogOverlay";

// Centred on every width; below md the footer's buttons stack full width (thumb-sized), like the
// phone's bottom sheets.
// Radix focuses AlertDialogCancel on open by default (its recommendation for a destructive
// action) — so Enter right after opening just closes the dialog. Finn asked for the primary
// action focused instead, for every confirm, destructive or not: Enter then runs it once.
function AlertDialogContent({ className, onOpenAutoFocus, onKeyDown, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal container={React.useContext(PortalContainer)}>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event);
          if (event.defaultPrevented) return;
          const action = (event.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-slot="alert-dialog-action"]');
          if (!action) return;
          event.preventDefault();
          action.focus();
        }}
        // A focused native <button> already activates on Enter — belt and suspenders for a browser
        // that doesn't, and the one thing that makes this behaviour testable.
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented || event.key !== "Enter") return;
          const target = event.target as HTMLElement;
          if (target.tagName !== "BUTTON") return;
          event.preventDefault();
          target.click();
        }}
        className={cn("bg-card text-card-foreground fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border p-5 shadow-modal outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95", className)}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

const AlertDialogHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div data-slot="alert-dialog-header" className={cn("flex flex-col gap-1.5", className)} {...props} />
);

const AlertDialogFooter = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div data-slot="alert-dialog-footer" className={cn("flex flex-row justify-end gap-2 max-md:flex-col-reverse max-md:[&>button]:h-11 max-md:[&>button]:w-full", className)} {...props} />
);

function AlertDialogTitle({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return <AlertDialogPrimitive.Title data-slot="alert-dialog-title" className={cn("text-[15px] font-semibold", className)} {...props} />;
}

function AlertDialogDescription({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return <AlertDialogPrimitive.Description data-slot="alert-dialog-description" className={cn("text-muted-foreground text-[13px] break-words", className)} {...props} />;
}

function AlertDialogAction({ className, variant, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Action> & { variant?: "default" | "destructive" }) {
  return <AlertDialogPrimitive.Action data-slot="alert-dialog-action" className={cn(buttonVariants({ variant, size: "sm" }), className)} {...props} />;
}

function AlertDialogCancel({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return <AlertDialogPrimitive.Cancel data-slot="alert-dialog-cancel" className={cn(buttonVariants({ variant: "outline", size: "sm" }), className)} {...props} />;
}

export {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
};
