import { useState, type ReactNode } from "react";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import { actionFailed } from "@/lib/notificationStore";
import { confirmDialog, type ConfirmOptions } from "@/lib/dialogs";
import { firstLine, type ActionFailure } from "../workstream";

type Variant = "default" | "outline" | "ghost" | "secondary" | "destructive";
type State = "idle" | "loading" | "done" | "error";

/** Button that runs an async action with inline feedback: spinner → ✓/✗ (reverts after 2s).
 *  Disabled while running so it can't be double-fired. A failure's message goes to the notification
 *  toasts (an `action_failed` with Copy + Ask the orchestrator) when `failure` names the action and workstream; the button itself
 *  keeps only the ✗, with the message's first line as its tooltip. `size="icon"` is an icon-only
 *  button (its `label` the aria-label): the spinner / ✓ / ✗ stand in for the icon while they show.
 *  `confirm` asks first, in the in-app AlertDialog (lib/dialogs). */
export function ActionButton({
  onRun,
  children,
  size = "sm",
  variant = "outline",
  disabled,
  confirm,
  failure,
  className,
  label,
}: {
  onRun: () => Promise<unknown>;
  children: ReactNode;
  size?: "sm" | "default" | "icon";
  variant?: Variant;
  disabled?: boolean;
  confirm?: ConfirmOptions;
  failure?: Omit<ActionFailure, "error">;
  className?: string;
  label?: string;
}) {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState("");

  const run = async () => {
    if (state === "loading") return;
    if (confirm && !(await confirmDialog(confirm))) return;
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

  const button = (
    <Button size={size} className={className} variant={state === "error" ? "destructive" : variant} disabled={disabled || state === "loading"} aria-label={label} onClick={() => void run()}>
      {state === "loading" && <Loader2 className="animate-spin" />}
      {state === "done" && <Check />}
      {state === "error" && <X />}
      {(size !== "icon" || state === "idle") && children}
    </Button>
  );
  return state === "error" ? <Tip label={error}>{button}</Tip> : button;
}
