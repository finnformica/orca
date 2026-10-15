// A phone's bottom sheet: a native modal <dialog> (backdrop, Esc and focus trap for free, like Add New
// and the terminal) pinned to the foot of the screen, full width, above the home indicator. It is the
// portal container for any select opened inside it, since a modal leaves the rest of the page inert.
// Swipe its header (the grabber) down to close it — or its body, once that is scrolled to the top
// (lib/gestures.ts). It slides up on the sheet spring with the backdrop fading in (styles.css), and
// slides back down before the dialog really closes — from wherever a swipe left it; reduced motion
// skips both. A light haptic tick on open, where the device has one (iOS has none; a no-op there).
import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { PortalContainer } from "@/lib/utils";
import { SHEET_EASE, useSwipeBodyToClose, useSwipeToClose } from "@/lib/gestures";
import { Button } from "@/components/ui/button";

/** How long the slide down takes before the dialog closes. */
export const SHEET_CLOSE_MS = 220;
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function BottomSheet({ open, onClose, title, slot, children }: { open: boolean; onClose: () => void; title: string; slot?: string; children: ReactNode }) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  // The content stays mounted while the sheet slides out, so it doesn't collapse mid-slide.
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (!dialog) return;
    if (open) {
      setShown(true);
      dialog.removeAttribute("data-closing");
      dialog.style.transform = ""; // reopened mid-slide: spring back up
      if (!dialog.open) {
        dialog.style.transition = "";
        dialog.showModal();
        try { navigator.vibrate?.(10); } catch { /* not allowed without a gesture: fine */ }
      }
      return;
    }
    if (!dialog.open) return;
    const finish = () => {
      dialog.close();
      dialog.removeAttribute("data-closing");
      dialog.style.transition = dialog.style.transform = "";
      setShown(false);
    };
    if (reducedMotion()) { finish(); return; }
    dialog.setAttribute("data-closing", ""); // the backdrop fades (styles.css)
    dialog.style.transition = `transform ${SHEET_CLOSE_MS}ms ${SHEET_EASE}`;
    dialog.style.transform = "translateY(100%)";
    const t = setTimeout(finish, SHEET_CLOSE_MS);
    return () => clearTimeout(t);
  }, [open, dialog]);
  const swipe = useSwipeToClose(() => dialog, onClose, true, { hold: true });
  useSwipeBodyToClose(body, () => dialog, onClose, { hold: true });
  return (
    <dialog
      ref={setDialog} data-slot={slot} data-bottom-sheet="" aria-label={title}
      onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }} // Esc slides it out too
      onClick={(e) => { if (e.target === dialog) onClose(); }} // backdrop
      className="bg-card text-foreground mt-auto mb-0 max-h-[85dvh] w-screen max-w-none flex-col rounded-t-xl border-t p-0 shadow-modal backdrop:bg-black/50 open:flex"
    >
      <PortalContainer.Provider value={dialog ?? undefined}>
        <header {...swipe} className="relative flex shrink-0 touch-none items-center justify-between border-b px-4 py-1">
          <span aria-hidden="true" className="bg-muted-foreground/40 absolute top-1.5 left-1/2 h-1 w-9 -translate-x-1/2 rounded-full" />
          <h2 className="min-w-0 truncate text-sm font-medium">{title}</h2>
          <Button size="icon" variant="ghost" className="size-11" onClick={onClose} aria-label="Close"><X className="size-4" /></Button>
        </header>
        <div ref={setBody} data-slot="sheet-body" className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">{(open || shown) && children}</div>
      </PortalContainer.Provider>
    </dialog>
  );
}
