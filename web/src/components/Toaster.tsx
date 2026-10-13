import { useState } from "react";
import { Bot, Check, CircleAlert, Copy, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOrchestrator } from "@/components/Terminal";
import { Tip } from "@/components/ui/tip";
import { dismissToast, useToasts, type Toast } from "@/lib/toast";

/** The toast stack (lib/toast), mounted once in App: bottom-right, above the orchestrator's window
 *  (z-40), newest at the bottom. Geist's toast: card, hairline border, 8px radius, the menu shadow; its
 *  actions are size-7 ghost icon buttons with tooltips, like the notification toasts' quick actions. */
export function Toaster() {
  const toasts = useToasts();
  if (!toasts.length) return null;
  return (
    <div data-slot="toaster" role="region" aria-label="Notifications" className="fixed right-4 bottom-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => <ToastItem key={t.id} t={t} />)}
    </div>
  );
}

function ToastItem({ t }: { t: Toast }) {
  const { ask } = useOrchestrator();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(t.copy!); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { window.prompt("Copy the error:", t.copy); }
  };
  return (
    <div data-slot="toast" data-kind={t.kind} role={t.kind === "error" ? "alert" : "status"} className="bg-card text-foreground shadow-menu rounded-lg border p-3">
      <div className="flex items-start gap-2">
        {t.kind === "error" && <CircleAlert className="text-destructive mt-0.5 size-4 shrink-0" />}
        <div className="min-w-0 flex-1 text-[13px] font-medium break-words">{t.title}</div>
        <Button size="icon" variant="ghost" className="-mt-1 -mr-1 size-6" onClick={() => dismissToast(t.id)} aria-label="Dismiss"><X className="size-3.5" /></Button>
      </div>
      {t.body && <pre data-slot="toast-body" className="text-muted-foreground mt-1.5 max-h-40 overflow-auto font-mono text-xs break-words whitespace-pre-wrap">{t.body}</pre>}
      {(t.copy || t.ask) && (
        <div data-slot="toast-actions" className="mt-1.5 flex justify-end gap-1">
          {t.copy && (
            <Tip label={copied ? "Copied" : "Copy"}>
              <Button size="icon" variant="ghost" className="text-muted-foreground hover:text-foreground size-7" aria-label="Copy" onClick={() => void copy()}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</Button>
            </Tip>
          )}
          {t.ask && (
            <Tip label="Ask the orchestrator">
              <Button size="icon" variant="ghost" className="text-foreground size-7" aria-label="Ask the orchestrator" onClick={() => { ask(t.ask); dismissToast(t.id); }}><Bot className="size-3.5" /></Button>
            </Tip>
          )}
        </div>
      )}
    </div>
  );
}
