import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn, PortalContainer } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal container={React.useContext(PortalContainer)}>
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn("bg-card text-card-foreground fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border p-5 shadow-modal outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95", className)}
        {...props}
      >
        {children}
        <DialogPrimitive.Close aria-label="Close" className="text-muted-foreground hover:text-foreground absolute top-3 right-3 rounded-md p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 max-md:p-2.5">
          <X className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

const DialogHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div data-slot="dialog-header" className={cn("flex flex-col gap-1.5 pr-6", className)} {...props} />
);

const DialogFooter = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div data-slot="dialog-footer" className={cn("flex flex-row justify-end gap-2 max-md:flex-col-reverse max-md:[&>button]:h-11 max-md:[&>button]:w-full", className)} {...props} />
);

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-[15px] font-semibold", className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn("text-muted-foreground text-[13px]", className)} {...props} />;
}

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription };
