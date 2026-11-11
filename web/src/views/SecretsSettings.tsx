// Settings > Secrets (`/settings#secrets`): the stored secrets (server/secrets.ts), never a value until
// the user presses Reveal. Reveal asks the owner-only route of THIS page's bridge (server/secretRoutes.ts);
// the value stays in this card's state. Public marks a value that is not secret (an OAuth client id):
// the scrub of replies, transcripts and tool output skips it, and channel posts still mask it.
import { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { api, type SecretInfo } from "../api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Empty, Pill, VCard } from "@/components/console";
import { SecretValue, useReveal } from "@/components/SecretShowCard";
import { notifyLocal } from "@/lib/notificationStore";
import { ago } from "../workstream";

const refOf = (s: Pick<SecretInfo, "scope" | "name">): string => (s.scope === "default" ? s.name : `${s.scope}/${s.name}`);

export function SecretsSettings() {
  const [rows, setRows] = useState<SecretInfo[] | null>(null);
  // Inside the chain, so a call that throws at once (an older bridge, a test's partial api) also
  // ends as an empty card: one section must never take down Settings.
  useEffect(() => { void Promise.resolve().then(() => api.secrets()).then((r) => setRows(r.secrets)).catch(() => setRows([])); }, []);
  return (
    <div id="secrets" className="scroll-mt-20">
      <VCard slot="settings-secrets" title="Secrets" aside={<span className="text-muted-foreground text-xs">values encrypted · shown only on Reveal</span>} bodyClass="divide-y">
        {rows === null ? <Empty>Loading…</Empty>
          : rows.length === 0 ? <Empty>No stored secrets. Save one with /secret in the chat, or a secret field in a form.</Empty>
          : rows.map((s) => <SecretRow key={refOf(s)} secret={s} onChange={(next) => setRows((all) => all?.map((r) => (refOf(r) === refOf(next) ? next : r)) ?? null)} />)}
      </VCard>
    </div>
  );
}

function SecretRow({ secret: s, onChange }: { secret: SecretInfo; onChange: (s: SecretInfo) => void }) {
  const ref = refOf(s);
  const { state, busy, reveal, hide } = useReveal({ ref });
  const [marking, setMarking] = useState(false);
  const mark = async (pub: boolean) => {
    setMarking(true);
    try { onChange({ ...s, public: (await api.markSecret(ref, pub)).public }); }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      notifyLocal({ kind: "action_failed", repo: "", title: `Secret · ${ref}`, label: "Mark secret failed", body: error, copy: `Action: mark ${ref} ${pub ? "public" : "private"}\nError:\n${error}`, ask: `Marking the secret ${ref} ${pub ? "public" : "private"} failed: ${error}. Please investigate and fix.` });
    } finally { setMarking(false); }
  };
  const switchId = `secret-public-${ref.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return (
    <div data-slot="secret-row" className="flex flex-col gap-2 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="bg-muted inline-flex size-8 shrink-0 items-center justify-center rounded-md border"><KeyRound className="size-4" /></span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 font-mono font-medium">{ref}{s.public && <Pill>public</Pill>}</span>
          <span className="text-muted-foreground block truncate text-xs">
            created {ago(s.createdAt)} · last used {s.lastUsedAt ? ago(s.lastUsedAt) : "never"}{s.source ? ` · from ${s.source}` : ""}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <Switch id={switchId} data-slot="secret-public" checked={s.public} disabled={marking} onCheckedChange={(v) => void mark(v)} />
          <Label htmlFor={switchId} className="text-muted-foreground text-xs">Public</Label>
        </span>
        {state?.value !== undefined
          ? <Button type="button" variant="ghost" size="sm" data-slot="secret-hide" onClick={hide}><EyeOff className="size-4" />Hide</Button>
          : <Button type="button" variant="secondary" size="sm" data-slot="secret-reveal" disabled={busy} onClick={() => void reveal()}><Eye className="size-4" />Reveal</Button>}
      </div>
      {state?.value !== undefined && <SecretValue refName={ref} value={state.value} />}
      {state?.error && <span className="text-xs text-red-400">{state.error}</span>}
    </div>
  );
}
