// The quick-ask launcher: a small pill fixed at the bottom centre of every page (desktop; below md
// the phone's bottom bar has the orchestrator instead). Click it, or press A, and the pill MORPHS
// into a compact box — one surface whose width, height and radius animate (instant under
// prefers-reduced-motion) — for messages to the orchestrator with no history. The input IS the shared
// ChatComposer (`variant="quick"`), so @ mentions, attachments, paste, Enter to send / Shift, ⌘ or
// Ctrl+Enter for a newline and focus behave as in every other box; it opens three lines tall and
// grows with what you type up to a cap. The shape is Linear's / Raycast's
// quick capture: fire a line without leaving what you're looking at, open the conversation only when
// you want to read. It carries no activity dot: that lives only on the orchestrator's own entry points
// (the top bar's button, the phone's bottom bar), the things that open the conversation.
//
// Sending is OPTIMISTIC: the box clears and stays open for the next task at once, a subtle "Sent"
// confirms, and the message goes to the orchestrator in the background. A busy orchestrator is not an
// error — the bridge queues the message behind its wake (the same queue busy agents use) — and quick
// successive sends are chained so they reach it in the order they were typed.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { Bot, Check } from "lucide-react";
import { quickAskOpenAtom, sidebarCollapsedAtom } from "@/lib/atoms";
import { shortcutLabel } from "@/lib/shortcuts";
import { api } from "../api";
import { useOrchestrator } from "@/components/Terminal";
import { ChatComposer } from "@/components/ChatComposer";
import { Shortcut } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

/** How long the "Sent" confirmation shows after a send (ms). The box itself stays open. */
export const SENT_FLASH_MS = 2500;
export const QUICK_ASK_PLACEHOLDER = "Ask the orchestrator...";
/** The pill ↔ box morph (ms) — the surface's `duration-200`. */
export const MORPH_MS = 200;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// One chain for the whole tab: each POST starts only once the previous one has answered, so three
// quick sends arrive as typed (in parallel, the second could reach the bridge first). A failure does
// not break the chain for the messages behind it.
let chain: Promise<unknown> = Promise.resolve();
export function queueOrchestratorMessage(text: string, files: File[] = []): Promise<{ status: "running" | "queued" }> {
  const sent = chain.then(async () => api.orchestratorMessage(text, files.length ? await api.uploadAttachments(files) : []));
  chain = sent.catch(() => {});
  return sent;
}

export function QuickAsk() {
  const [open, setOpen] = useAtom(quickAskOpenAtom);
  const collapsed = useAtomValue(sidebarCollapsedAtom);
  const { ask } = useOrchestrator();
  const [flash, setFlash] = useState(0); // >0 while "Sent" shows; bumped per send to restart its timer
  // The box's contents stay mounted through the collapse (`leaving`): faded out, pinned at the width
  // they had, while the surface shrinks around them — then the pill fades in. Swapping them for the
  // pill in the commit that closed it was the jank: a blank box shrinking around a popped-in pill.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  if (!open && mounted && reducedMotion()) setMounted(false);
  const leaving = mounted && !open;
  const content = useRef<HTMLDivElement>(null);
  const [leaveWidth, setLeaveWidth] = useState<number>();
  useLayoutEffect(() => {
    if (!leaving) { setLeaveWidth(undefined); return; }
    setLeaveWidth(content.current?.offsetWidth); // mid-transition this is still the open width
    const t = setTimeout(() => setMounted(false), MORPH_MS);
    return () => clearTimeout(t);
  }, [leaving]);
  const key = shortcutLabel("quickAsk");
  const input = () => content.current?.querySelector("textarea");
  // Open: focus the box in the commit that opens it, before the next keystroke. Closed: the text is
  // kept (the composer's persisted draft) until it is sent — a half-typed line survives an Esc.
  useLayoutEffect(() => {
    if (open) input()?.focus();
  }, [open]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(0), SENT_FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);
  // A pointerdown outside the open box closes it like Esc — but not a click on the box itself (the
  // Send button included), on a popover/portal the box opened (Radix's own popper wrapper, the
  // composer's @ picker, which is portaled out of the clipping surface), or while
  // the "Sent" receipt is still showing (closing would cut it short before its own timer does).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (content.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-radix-popper-content-wrapper], [data-slot="chat-composer-mentions"]')) return;
      if (flash > 0) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, flash, setOpen]);
  // The composer clears the box at once and, if this throws, gives the text back (into the box if it
  // is still empty, else quoted in its error line). Busy is queued by the bridge, not refused.
  const send = async (message: string, files: File[]) => {
    setFlash((n) => n + 1);
    input()?.focus();
    try { await queueOrchestratorMessage(message, files); }
    catch (e) { setFlash(0); throw e; }
  };
  return (
    // Below the sticky top bar and menus (z-30 / z-50) but above the page; clear of the orchestrator's
    // panel on the right and the toasts in the corner. Centred on the MAIN column, not the viewport:
    // the fixed strip starts where the sidebar ends (Shell's md:w-14 collapsed / md:w-60 expanded).
    <div data-slot="quick-ask" data-collapsed={collapsed}
      className={cn("pointer-events-none fixed right-0 bottom-5 z-30 flex justify-center max-md:hidden", collapsed ? "left-14" : "left-60")}>
      {/* ONE surface for both states, so the pill grows into the box rather than being swapped for it.
          `interpolate-size` lets the height animate to `auto` (Chromium; elsewhere it snaps). Solid
          card / accent fills — never a translucent hover, which let the page show through. */}
      <div data-slot="quick-ask-surface" data-state={open ? "open" : "closed"}
        className={cn(
          "[interpolate-size:allow-keywords] bg-card text-foreground pointer-events-auto overflow-hidden border transition-[width,height,border-radius,box-shadow,background-color] duration-200 ease-out motion-reduce:transition-none",
          open ? "h-auto w-[min(560px,calc(100%-2rem))] rounded-xl shadow-modal" : "h-8 w-[6.5rem] rounded-[16px] shadow-menu",
          !mounted && "hover:bg-accent",
        )}>
        {mounted ? (
          // While leaving it is the same tree, faded, inert and out of the accessibility tree — no
          // longer "the box" to anything that looks for it.
          <div ref={content} role={leaving ? undefined : "dialog"} aria-label={leaving ? undefined : "Quick ask"} aria-hidden={leaving || undefined}
            data-slot={leaving ? "quick-ask-leaving" : "quick-ask-box"}
            {...(leaving ? { inert: "" } : {}) as React.HTMLAttributes<HTMLDivElement>}
            style={leaving && leaveWidth ? { width: leaveWidth } : undefined}
            className={cn(leaving && "pointer-events-none opacity-0 transition-opacity duration-100")}
            onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); } }}>
            {/* The agent at the top left; the text takes the whole width beside it. The row below holds
                the actions: the receipt on the left, Send (with its key) on the right. */}
            <ChatComposer variant="quick" persistKey="orca.quickAsk" onSubmit={send} placeholder={QUICK_ASK_PLACEHOLDER}
              inputLabel="Message the orchestrator" icon={<Bot className="text-muted-foreground mt-1 size-4 shrink-0" />}
              leading={
                // The receipt: subtle, and it goes on its own. The box is already clear for the next.
                <span role="status" aria-live="polite" data-slot="quick-ask-sent" className="text-muted-foreground flex items-center gap-1.5 pl-1 text-xs">
                  {flash > 0 && <>
                    <Check className="text-geist-blue size-3.5" />Sent
                    <button type="button" className="text-geist-blue hover:underline" onClick={() => { setOpen(false); ask(); }}>Open chat</button>
                  </>}
                </span>
              } />
          </div>
        ) : (
          <button type="button" data-slot="quick-ask-pill" onClick={() => setOpen(true)} aria-label="Ask the orchestrator (quick)"
            title={`Quick ask (${key}): a message to the orchestrator`}
            className="animate-in fade-in-0 flex size-full items-center justify-center gap-2 px-3 text-sm whitespace-nowrap duration-150 motion-reduce:animate-none">
            <Bot className="text-muted-foreground size-3.5" />
            <span>Ask</span>
            <Shortcut id="quickAsk" />
          </button>
        )}
      </div>
    </div>
  );
}
