// A stored secret's value on the user's screen, and nowhere else (server/secretRoutes.ts): Settings >
// Secrets' Reveal, and the card an `orca secret show` draws under the agent's reply. The value lives in
// this component's state only; it is never written to the chat's turns, a draft or storage.
import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff, KeyRound } from "lucide-react";
import { api } from "../api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tip";
import { copyText } from "@/lib/dialogs";
import { showFresh, type SecretShow } from "../../../shared/secretShow";

/** A revealed value: read only, mono, with Copy. */
export function SecretValue({ refName, value }: { refName: string; value: string }) {
  return (
    <span data-slot="secret-value" className="flex min-w-0 items-center gap-1.5">
      <Input readOnly aria-label={`Value of ${refName}`} value={value} onFocus={(e) => e.currentTarget.select()}
        className="bg-background h-8 min-w-0 flex-1 font-mono text-xs" />
      <Tip label="Copy">
        <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`Copy ${refName}`} onClick={() => void copyText(value, refName)}>
          <Copy className="size-4" />
        </Button>
      </Tip>
    </span>
  );
}

/** The reveal state of one secret: `null` hidden, else the value or the refusal. */
export function useReveal(by: { ref: string } | { token: string }, auto = false) {
  const [state, setState] = useState<{ value?: string; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const key = "ref" in by ? by.ref : by.token;
  const reveal = async () => {
    setBusy(true);
    try { setState({ value: (await api.revealSecret(by)).value }); }
    catch (e) { setState({ error: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (auto) void reveal(); }, [key, auto]);
  return { state, busy, reveal, hide: () => setState(null) };
}

/** The card under a reply whose tool result holds an `orca secret show` token. Fresh: the value shows
 *  at once (the user just asked for it). Older: it waits for Reveal. */
export function SecretShowCard({ show }: { show: SecretShow }) {
  const { state, busy, reveal, hide } = useReveal({ token: show.token }, showFresh(show.at, Date.now()));
  return (
    <div data-slot="secret-show" className="bg-card mt-2 flex max-w-xl flex-col gap-2 rounded-lg border px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <KeyRound className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{show.ref}</span>
        {state?.value !== undefined
          ? <Button type="button" variant="ghost" size="sm" className="h-7" onClick={hide}><EyeOff className="size-4" />Hide</Button>
          : <Button type="button" variant="secondary" size="sm" className="h-7" disabled={busy} onClick={() => void reveal()}><Eye className="size-4" />Reveal</Button>}
      </div>
      {state?.value !== undefined && <SecretValue refName={show.ref} value={state.value} />}
      {state?.error && <span className="text-xs text-red-400">{state.error}</span>}
      <span className="text-muted-foreground text-xs">Only this chat shows the value. The agent, the transcript and channel posts see [secret {show.ref}].</span>
    </div>
  );
}
