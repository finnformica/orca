import { useState, type ReactNode } from "react";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { actionFailed } from "@/lib/toast";
import { firstLine, type ActionFailure } from "../workstream";

type Variant = "default" | "outline" | "ghost" | "secondary" | "destructive";
type State = "idle" | "loading" | "done" | "error";

/** Button that runs an async action with inline feedback: spinner → ✓/✗ (reverts after 2s).
 *  Disabled while running so it can't be double-fired. A failure's message goes to a toast (with
 *  Copy + Ask the orchestrator) when `failure` names the action and workstream; the button itself
 *  keeps only the ✗, with the message's first line as its tooltip. */
export function ActionButton({
  onRun,
  children,
  size = "sm",
  variant = "outline",
  disabled,
  confirm,
  failure,
}: {
  onRun: () => Promise<unknown>;
  children: ReactNode;
  size?: "sm" | "default";
  variant?: Variant;
  disabled?: boolean;
  confirm?: string;
  failure?: Omit<ActionFailure, "error">;
}) {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState("");

  const run = async () => {
    if (state === "loading") return;
    if (confirm && !window.confirm(confirm)) return;
    setState("loading");
    try {
      await onRun();
      setState("done");
    } catch (e) {
      setError(firstLine(e instanceof Error ? e.message : String(e)));
      setState("error");
      if (failure) actionFailed(failure, e);
    }
    setTimeout(() => setState("idle"), 2000);
  };

  return (
    <Button size={size} variant={state === "error" ? "destructive" : variant} disabled={disabled || state === "loading"} title={state === "error" ? error : undefined} onClick={() => void run()}>
      {state === "loading" && <Loader2 className="animate-spin" />}
      {state === "done" && <Check />}
      {state === "error" && <X />}
      {children}
    </Button>
  );
}
