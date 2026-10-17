import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Check, Copy } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// The in-app replacements for window.confirm and window.prompt: a promise per question, so a call
// site stays one line (`if (!(await confirmDialog({...}))) return;`). Requests queue and ONE host
// shows them in turn; it mounts itself on the first request, so a view (or a test) needs no
// provider. Native dialogs block the page, look like the browser and, on a phone, sit oddly under
// the bottom sheets that open these actions.

export type ConfirmOptions = { title: string; description?: ReactNode; confirmLabel?: string; destructive?: boolean };

type Request =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: "copy"; title: string; text: string; resolve: () => void };

let queue: Request[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
let hosts = 0;

function push(r: Request) {
  queue = [...queue, r];
  emit();
  if (hosts === 0) {
    const el = document.createElement("div");
    el.dataset.slot = "dialog-host";
    document.body.appendChild(el);
    createRoot(el).render(<DialogHost />);
  }
}

/** Ask a yes/no question in an AlertDialog. Resolves true on the confirm button, false on Cancel,
 *  Esc or an outside click. `destructive` paints the confirm button red. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => push({ kind: "confirm", opts, resolve }));
}

/** Show text to copy by hand: a Dialog with it selected in a read-only field and a Copy button.
 *  Resolves when it closes. */
export function copyDialog(title: string, text: string): Promise<void> {
  return new Promise((resolve) => push({ kind: "copy", title, text, resolve }));
}

/** Write text to the clipboard; where that is refused (no secure context over the plain-http
 *  tailnet), show it in `copyDialog`. Resolves true when the clipboard took it. */
export async function copyText(text: string, label: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { await copyDialog(`Copy the ${label}`, text); return false; }
}

/** True once nothing that would sit over or under a new dialog is still on screen: a phone's bottom
 *  sheet (a native modal <dialog> in the top layer, which leaves the rest inert) or a closing Radix
 *  menu (its body `pointer-events: none` — the menu's layer package is another version than the
 *  dialog's, so they don't share that bookkeeping and opening early left the page unclickable). */
export function overlaysSettled(doc: Document = document): boolean {
  return !doc.querySelector("dialog[data-bottom-sheet][open]") && doc.body.style.pointerEvents !== "none";
}

const SETTLE_MAX_MS = 700;
async function whenSettled() {
  const end = Date.now() + SETTLE_MAX_MS;
  do await new Promise((r) => setTimeout(r, 16)); while (!overlaysSettled() && Date.now() < end);
}

export function DialogHost() {
  useEffect(() => { hosts++; return () => { hosts--; }; }, []);
  const head = useSyncExternalStore(subscribe, () => queue[0]);
  const [shown, setShown] = useState<Request | undefined>();
  useEffect(() => {
    if (!head) return;
    let live = true;
    void whenSettled().then(() => { if (live) setShown(head); });
    return () => { live = false; };
  }, [head]);
  const done = (r: Request, ok: boolean) => {
    if (r.kind === "confirm") r.resolve(ok); else r.resolve();
    queue = queue.filter((q) => q !== r);
    setShown(undefined);
    emit();
  };
  if (!shown) return null;
  if (shown.kind === "copy") return <CopyDialog title={shown.title} text={shown.text} onClose={() => done(shown, true)} />;
  const { title, description, confirmLabel = "Confirm", destructive } = shown.opts;
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) done(shown, false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {/* Radix warns without a description; an empty one keeps aria-describedby honest. */}
          <AlertDialogDescription className={description ? undefined : "sr-only"}>{description ?? title}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? "destructive" : "default"} onClick={() => done(shown, true)}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CopyDialog({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const multiline = text.includes("\n");
  const select = (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => e.currentTarget.select();
  // execCommand works where the async clipboard is refused (an insecure context) — the reason this
  // dialog shows at all.
  const copy = async () => {
    const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-slot="copy-text"]');
    field?.select();
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = document.execCommand?.("copy") ?? false; }
    if (ok) setCopied(true);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>The browser did not allow Orca to copy. Copy the text below.</DialogDescription>
        </DialogHeader>
        {multiline
          ? <Textarea data-slot="copy-text" readOnly value={text} rows={Math.min(8, text.split("\n").length)} onFocus={select} className="font-mono text-xs" />
          : <Input data-slot="copy-text" readOnly value={text} onFocus={select} className="font-mono text-xs" />}
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
          <Button size="sm" onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
