// The quick-ask launcher: a small pill fixed at the bottom centre of every page (desktop; below md
// the phone's bottom bar has the orchestrator instead). Click it, or press A, and the pill MORPHS
// into a compact box — one surface whose width, height and radius animate (instant under
// prefers-reduced-motion) — for messages to the orchestrator with no history. The input IS the shared
// ChatComposer (`variant="quick"`), so @ mentions, attachments, paste, Enter to send / Shift, ⌘ or
// Ctrl+Enter for a newline and focus behave as in every other box — and so is its toolbar: the
// orchestrator's model picker and context ring (`useOrchestratorState`, the side panel's own source),
// attach, Send. Only the look differs: no border of its own, the agent icon, the morph. It opens three lines tall and
// grows with what you type up to a cap. The shape is Linear's / Raycast's
// quick capture: fire a line without leaving what you're looking at, open the conversation only when
// you want to read. It carries no activity dot: that lives only on the orchestrator's own entry points
// (the top bar's button, the phone's bottom bar), the things that open the conversation.
//
// Sending is OPTIMISTIC: the box clears and stays open for the next task at once, a subtle "Sent"
// confirms, and the message goes to the orchestrator in the background. A busy orchestrator is not an
// error — the bridge queues the message behind its wake (the same queue busy agents use) — and quick
// successive sends are chained so they reach it in the order they were typed. It goes through the
// shared outbox (lib/orchestratorOutbox), so the panel shows it at once, opened now or later.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { Bot, Check } from "lucide-react";
import { quickAskOpenAtom } from "@/lib/atoms";
import { sendToOrchestrator } from "@/lib/orchestratorOutbox";
import { useOrchestrator, useOrchestratorState } from "@/components/Terminal";
import { ChatComposer } from "@/components/ChatComposer";
import { ChatControls } from "@/components/ChatControls";
import { Shortcut } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { isMobile } from "@/lib/viewport";

/** How long the "Sent" confirmation shows after a send (ms). The box itself stays open. */
export const SENT_FLASH_MS = 2500;
export const QUICK_ASK_PLACEHOLDER = "Ask Orca...";
/** The pill ↔ box morph (ms) — the surface's `duration-200`. */
export const MORPH_MS = 200;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function QuickAsk() {
  const [open, setOpen] = useAtom(quickAskOpenAtom);
  const { ask } = useOrchestrator();
  // The same toolbar as every other composer — the orchestrator's model and its context ring — fed
  // from the same status poll the side panel uses, running only while the box is open.
  const { controls, compact } = useOrchestratorState(open);
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
  const input = () => content.current?.querySelector("textarea");
  // Open: focus the box in the commit that opens it, before the next keystroke. Closed: the text is
  // kept (the composer's persisted draft) until it is sent — a half-typed line survives an Esc.
  // Skipped on a coarse-pointer device wide enough that this pill isn't CSS-hidden (max-md:hidden
  // only hides it below the mobile breakpoint): a tablet shouldn't have the keyboard popped over the
  // page just because the pill opened.
  useLayoutEffect(() => {
    if (open && !isMobile()) input()?.focus();
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
    if (!isMobile()) input()?.focus();
    try { await sendToOrchestrator(message, files); }
    catch (e) { setFlash(0); throw e; }
  };
  return (
    // Below the sticky top bar and menus (z-30 / z-50) but above the page; clear of the toasts in the
    // corner. Centred on the page CARD: the strip is absolute in Shell's `shell-card`, so the card's own
    // layout places it. An open or a close of the dock, the nav turning into its rail and a resize drag
    // or key all move the card edge, and the strip moves with it in the SAME frames — no transition of
    // its own to start late or snap ahead (PR 328's fixed strip did both).
    <div data-slot="quick-ask"
      className="pointer-events-none absolute inset-x-0 bottom-5 z-30 flex justify-center max-md:hidden">
      {/* ONE surface for both states, so the pill grows into the box rather than being swapped for it.
          `interpolate-size` lets the height animate to `auto` (Chromium; elsewhere it snaps). One
          solid card fill in every state — no hover fill, open or closed. */}
      {/* One look open and closed (Finn: the open box stands out more): an overlay surface — card fill,
          hairline, modal shadow. Only the size and radius change (docs/design/surfaces.md). */}
      <div data-slot="quick-ask-surface" data-state={open ? "open" : "closed"}
        className={cn(
          // Hover over the pill shows on the hairline, never as a fill: the fill stays the open box's.
          "[interpolate-size:allow-keywords] bg-card text-foreground pointer-events-auto overflow-hidden border shadow-modal transition-[width,height,border-radius,border-color] duration-200 ease-out motion-reduce:transition-none has-[[data-slot=quick-ask-pill]:hover]:border-border-dark",
          open ? "h-auto w-[min(560px,calc(100%-2rem))] rounded-xl" : "h-8 w-[6.5rem] rounded-[16px]",
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
            {/* The agent at the top left; the text takes the whole width beside it. The row below is
                every composer's toolbar: model and context on the left (then the receipt), attach
                and Send (with its key) on the right. */}
            <ChatComposer variant="quick" persistKey="orca.quickAsk" onSubmit={send} placeholder={QUICK_ASK_PLACEHOLDER}
              inputLabel="Message the orchestrator" icon={<Bot className="text-muted-foreground mt-1 size-4 shrink-0" />}
              leading={
                <div className="flex min-w-0 items-center gap-1">
                  <ChatControls {...controls} compact={compact} />
                  {/* The receipt: subtle, and it goes on its own. The box is already clear for the next. */}
                  <span role="status" aria-live="polite" data-slot="quick-ask-sent" className="text-muted-foreground flex min-w-0 items-center gap-1.5 pl-1 text-xs whitespace-nowrap">
                    {flash > 0 && <>
                      <Check className="text-geist-blue size-3.5" />Sent
                      <button type="button" className="text-link hover:underline" onClick={() => { setOpen(false); ask(); }}>Open chat</button>
                    </>}
                  </span>
                </div>
              } />
          </div>
        ) : (
          <button type="button" data-slot="quick-ask-pill" onClick={() => setOpen(true)} aria-label="Ask Orca (quick)"
            className="animate-in fade-in-0 hover:[&>svg]:text-foreground flex size-full items-center justify-center gap-2 px-3 text-sm whitespace-nowrap transition-colors duration-150 motion-reduce:animate-none">
            <Bot className="text-muted-foreground size-3.5" />
            <span>Ask</span>
            <Shortcut id="quickAsk" />
          </button>
        )}
      </div>
    </div>
  );
}
