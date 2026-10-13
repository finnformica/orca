// The quick-ask launcher: a small pill fixed at the bottom centre of every page (desktop; below md
// the phone's bottom bar has the orchestrator instead). Click it, or press A, and a compact box
// opens for ONE message to the orchestrator — no history, no transcript: Enter sends, a brief "Sent"
// confirms, with a link to the full panel, and it closes. The shape is Linear's / Raycast's quick
// capture and Intercom's launcher: fire a line without leaving what you're looking at, and open the
// conversation only when you want to read. The pill carries the orchestrator's activity dot (pulsing
// while a wake runs, lit once one has replied unseen), so you know whether to go and look.
import { useEffect, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { Bot, Check, X } from "lucide-react";
import { orchestratorActivityAtom, quickAskOpenAtom } from "@/lib/atoms";
import { shortcutLabel } from "@/lib/shortcuts";
import { api } from "../api";
import { ActivityDot, useOrchestrator } from "@/components/Terminal";
import { Button } from "@/components/ui/button";

/** How long the sent confirmation stays before the box closes itself (ms). */
export const SENT_DWELL_MS = 4000;

export function QuickAsk() {
  const [open, setOpen] = useAtom(quickAskOpenAtom);
  const activity = useAtomValue(orchestratorActivityAtom);
  const { ask } = useOrchestrator();
  const [text, setText] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "sending" } | { kind: "sent"; text: string } | { kind: "error"; message: string }>({ kind: "idle" });
  const box = useRef<HTMLTextAreaElement>(null);
  const key = shortcutLabel("quickAsk");
  // Open: focus the box. Closed: back to idle, so the next open starts clean (the text is kept until
  // it is sent — a half-typed line survives an Esc).
  useEffect(() => {
    if (open) { setState({ kind: "idle" }); box.current?.focus(); }
  }, [open]);
  // The confirmation dwells, then the box closes on its own. A keystroke meanwhile cancels that.
  useEffect(() => {
    if (state.kind !== "sent") return;
    const t = setTimeout(() => setOpen(false), SENT_DWELL_MS);
    return () => clearTimeout(t);
  }, [state]);
  const send = async () => {
    const message = text.trim();
    if (!message || state.kind === "sending") return;
    setState({ kind: "sending" });
    try {
      await api.orchestratorMessage(message, []);
      setText("");
      setState({ kind: "sent", text: message });
    } catch (e) {
      // The text stays in the box: nothing typed is lost.
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  };
  return (
    // Below the sticky top bar and menus (z-30 / z-50) but above the page; clear of the orchestrator's
    // panel on the right and the toasts in the corner.
    <div data-slot="quick-ask" className="pointer-events-none fixed inset-x-0 bottom-5 z-30 flex justify-center max-md:hidden">
      {open ? (
        <div role="dialog" aria-label="Quick ask" data-slot="quick-ask-box" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } }}
          className="bg-card text-foreground pointer-events-auto w-[min(560px,calc(100vw-2rem))] rounded-lg border shadow-modal">
          {state.kind === "sent" ? (
            <div role="status" className="flex items-center gap-3 px-3 py-2.5 text-sm" data-slot="quick-ask-sent">
              <span className="bg-geist-blue/15 text-geist-blue inline-flex size-6 shrink-0 items-center justify-center rounded-full"><Check className="size-3.5" /></span>
              <span className="min-w-0 flex-1 truncate">Sent to the orchestrator</span>
              <button type="button" className="text-geist-blue shrink-0 text-sm hover:underline" onClick={() => { setOpen(false); ask(); }}>Open chat</button>
              <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label="Close quick ask" onClick={() => setOpen(false)}><X className="size-4" /></Button>
            </div>
          ) : (
            <div className="flex items-start gap-2 px-3 py-2">
              <span className="relative mt-1.5 inline-flex shrink-0"><Bot className="text-muted-foreground size-4" /><ActivityDot activity={activity} className="absolute -top-1 -right-1 size-1.5" /></span>
              <textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} rows={1} aria-label="Message the orchestrator"
                placeholder={activity.running ? "The orchestrator is working — queue a message…" : "Ask the orchestrator… (Enter to send)"}
                className="placeholder:text-muted-foreground max-h-32 min-h-7 min-w-0 flex-1 resize-none bg-transparent py-1 text-sm outline-none" />
              <Button size="sm" variant="default" className="h-7 shrink-0" disabled={!text.trim() || state.kind === "sending"} onClick={() => void send()}>
                {state.kind === "sending" ? "Sending…" : "Send"}
              </Button>
              <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label="Close quick ask" onClick={() => setOpen(false)}><X className="size-4" /></Button>
            </div>
          )}
          {state.kind === "error" && <div className="text-geist-red border-t px-3 py-1.5 text-xs" data-slot="quick-ask-error">{state.message} — not sent; your text is still here.</div>}
          {state.kind !== "sent" && (
            <div className="text-muted-foreground flex items-center justify-between border-t px-3 py-1 text-[11px]">
              <span>One message, no history. Shift+Enter for a new line.</span>
              <button type="button" className="hover:text-foreground" onClick={() => { setOpen(false); ask(text); setText(""); }}>Open full chat</button>
            </div>
          )}
        </div>
      ) : (
        <button type="button" data-slot="quick-ask-pill" onClick={() => setOpen(true)} aria-label="Ask the orchestrator (quick)"
          title={`Quick ask (${key}): one message to the orchestrator`}
          className="bg-card text-foreground hover:bg-accent/60 pointer-events-auto flex h-8 items-center gap-2 rounded-full border px-3 text-sm shadow-menu">
          <span className="relative inline-flex"><Bot className="text-muted-foreground size-3.5" /><ActivityDot activity={activity} className="absolute -top-1 -right-1 size-1.5" /></span>
          <span>Ask</span>
          <kbd className="text-muted-foreground rounded border px-1 font-sans text-[10px]">{key}</kbd>
        </button>
      )}
    </div>
  );
}
