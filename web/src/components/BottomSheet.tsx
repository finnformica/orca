// A phone's bottom sheet: a native modal <dialog> (backdrop, Esc and focus trap for free, like Add New
// and the terminal) pinned to the foot of the screen, full width, above the home indicator. It is the
// portal container for any select opened inside it, since a modal leaves the rest of the page inert.
import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { PortalContainer } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function BottomSheet({ open, onClose, title, slot, children }: { open: boolean; onClose: () => void; title: string; slot?: string; children: ReactNode }) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open, dialog]);
  return (
    <dialog
      ref={setDialog} data-slot={slot} aria-label={title}
      onClose={onClose} onCancel={onClose}
      onClick={(e) => { if (e.target === dialog) onClose(); }} // backdrop
      className="bg-card text-foreground mt-auto mb-0 max-h-[85dvh] w-screen max-w-none rounded-t-xl border-t p-0 shadow-modal backdrop:bg-black/50"
    >
      <PortalContainer.Provider value={dialog ?? undefined}>
        <header className="flex items-center justify-between border-b px-4 py-1">
          <h2 className="text-sm font-medium">{title}</h2>
          <Button size="icon" variant="ghost" className="size-11" onClick={onClose} aria-label="Close"><X className="size-4" /></Button>
        </header>
        <div className="space-y-4 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">{open && children}</div>
      </PortalContainer.Provider>
    </dialog>
  );
}
