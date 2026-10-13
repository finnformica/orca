// The quick-ask launcher: a small pill fixed at the bottom centre of every page (desktop; below md
// the phone's bottom bar has the orchestrator instead). Click it, or press A, and the pill MORPHS
// into a compact box — one surface whose width, height and radius animate (instant under
// prefers-reduced-motion) — for messages to the orchestrator with no history: Enter sends, Shift+Enter
// breaks the line, and the box opens three lines tall and grows with what you type up to a cap. The shape is Linear's / Raycast's
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
import { ArrowUp, Bot, Check } from "lucide-react";
import { quickAskOpenAtom, sidebarCollapsedAtom } from "@/lib/atoms";
import { shortcutLabel } from "@/lib/shortcuts";
import { api } from "../api";
import { useOrchestrator } from "@/components/Terminal";
import { Button } from "@/components/ui/button";
import { Shortcut } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

/** How long the "Sent" confirmation shows after a send (ms). The box itself stays open. */
export const SENT_FLASH_MS = 2500;
export const QUICK_ASK_PLACEHOLDER = "Ask the orchestrator...";

// One chain for the whole tab: each POST starts only once the previous one has answered, so three
// quick sends arrive as typed (in parallel, the second could reach the bridge first). A failure does
// not break the chain for the messages behind it.
let chain: Promise<unknown> = Promise.resolve();
export function queueOrchestratorMessage(text: string): Promise<{ status: "running" | "queued" }> {
  const sent = chain.then(() => api.orchestratorMessage(text, []));
  chain = sent.catch(() => {});
  return sent;
}

export function QuickAsk() {
  const [open, setOpen] = useAtom(quickAskOpenAtom);
  const collapsed = useAtomValue(sidebarCollapsedAtom);
  const { ask } = useOrchestrator();
  const [text, setRaw] = useState("");
  // What the box holds as of the last edit, rendered or not: a send that fails fast can land before
  // React has rendered the clear (as in ChatComposer).
  const latest = useRef(text);
  const setText = (v: string) => { latest.current = v; setRaw(v); };
  const [flash, setFlash] = useState(0); // >0 while "Sent" shows; bumped per send to restart its timer
  const [failed, setFailed] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const key = shortcutLabel("quickAsk");
  // Open: focus the box in the commit that opens it, before the next keystroke. Closed: the text is
  // kept until it is sent — a half-typed line survives an Esc.
  useLayoutEffect(() => {
    if (open) { setFailed(null); box.current?.focus(); }
  }, [open]);
  // Grow with the text where `field-sizing: content` isn't supported (Safari, Firefox): there the box
  // stayed one scrolling line. The CSS min / max heights still bound it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content"))) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text, open]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(0), SENT_FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);
  const send = () => {
    const message = text.trim();
    if (!message) return;
    setText("");
    setFailed(null);
    setFlash((n) => n + 1);
    box.current?.focus();
    queueOrchestratorMessage(message).catch((e) => {
      // Only a bridge that could not take it lands here (busy is queued, not refused). Nothing typed
      // is lost: back into the box if it is still empty, else quoted in the error line.
      const reason = e instanceof Error ? e.message : String(e);
      setFlash(0);
      if (!latest.current.trim()) { setText(message); setFailed(`${reason} — not sent; your text is back in the box.`); }
      else setFailed(`${reason} — not sent: “${message}”`);
    });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
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
          "[interpolate-size:allow-keywords] bg-card text-foreground pointer-events-auto overflow-hidden border transition-[width,height,border-radius,box-shadow] duration-200 ease-out motion-reduce:transition-none",
          open ? "h-auto w-[min(560px,calc(100%-2rem))] rounded-xl shadow-modal" : "hover:bg-accent h-8 w-[6.5rem] rounded-[16px] shadow-menu",
        )}>
        {open ? (
          <div role="dialog" aria-label="Quick ask" data-slot="quick-ask-box" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } }}>
            <div className="flex items-end gap-2 px-3 py-2">
              <Bot className="text-muted-foreground mb-1.5 size-4 shrink-0" />
              {/* Opens at three lines and grows with its content (field-sizing, else the effect above),
                  up to max-h, then scrolls. */}
              <textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} rows={3} aria-label="Message the orchestrator"
                placeholder={QUICK_ASK_PLACEHOLDER} data-slot="quick-ask-input"
                className="placeholder:text-muted-foreground field-sizing-content max-h-40 min-h-[4.5rem] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-1 text-sm outline-none" />
              <span className="mb-0.5 flex shrink-0 items-center gap-1.5">
                {/* The receipt: subtle, and it goes on its own. The box is already clear for the next. */}
                <span role="status" aria-live="polite" data-slot="quick-ask-sent" className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  {flash > 0 && <>
                    <Check className="text-geist-blue size-3.5" />Sent
                    <button type="button" className="text-geist-blue hover:underline" onClick={() => { setOpen(false); ask(); }}>Open chat</button>
                  </>}
                </span>
                <Shortcut id="send" />
                <Button size="icon" variant="ghost" className="size-7" aria-label="Send" title="Send (Enter)" disabled={!text.trim()} onClick={send}>
                  <ArrowUp className="size-4" />
                </Button>
              </span>
            </div>
            {failed && <div className="text-geist-red border-t px-3 py-1.5 text-xs" data-slot="quick-ask-error">{failed}</div>}
          </div>
        ) : (
          <button type="button" data-slot="quick-ask-pill" onClick={() => setOpen(true)} aria-label="Ask the orchestrator (quick)"
            title={`Quick ask (${key}): a message to the orchestrator`}
            className="flex size-full items-center justify-center gap-2 px-3 text-sm whitespace-nowrap">
            <Bot className="text-muted-foreground size-3.5" />
            <span>Ask</span>
            <Shortcut id="quickAsk" />
          </button>
        )}
      </div>
    </div>
  );
}
