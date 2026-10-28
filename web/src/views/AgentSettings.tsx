// Settings > Agents (`/settings#agents`): every named agent's row (server/agents.ts, table `agent`).
// The user edits each agent's display name, role text, model, shell flag and verbs here, adds and
// archives agents (any agent but the last one), and picks the default agent: the one that gets what
// names no agent. This is the ONLY editor: no `orca` verb edits a row, so no agent widens its own or
// another agent's tools. An edit applies at once (the server reads the row on every call).
import { useEffect, useState, type ReactNode } from "react";
import { Bot, Plus } from "lucide-react";
import { api } from "../api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Empty, Pill, SectionTitle, VCard } from "@/components/console";
import { MODELS, modelLabel } from "../../../shared/models";
import type { AgentDef } from "../../../shared/agents";
import { agentDraftOf, agentDraftPatch, agentToolsLabel, toggleAgentVerb, type AgentDraft } from "../workstream";

/** The Select's value for "no pin": the server's default model. */
const DEFAULT_MODEL = "default";
/** The default-agent Select's value for "no setting": the first active agent. */
const FIRST = "+first";

export function AgentsSettings() {
  const [defs, setDefs] = useState<AgentDef[] | null>(null);
  const [verbs, setVerbs] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string | null>(null); // the agent being edited, or "+new"
  const [archive, setArchive] = useState<AgentDef | null>(null);
  const [def, setDef] = useState<{ current?: string; setting: string }>({ setting: "" });
  const load = () => api.agentDefs().then((r) => { setDefs(r.agents); setVerbs(r.verbs); setDef({ current: r.defaultAgent, setting: r.defaultSetting ?? "" }); setError(undefined); })
    .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => { void load(); }, []);
  return (
    <div id="agents" data-slot="settings-agents" className="scroll-mt-20">
      <SectionTitle aside={<Button size="sm" variant="secondary" data-slot="agent-add" disabled={!defs || open === "+new"} onClick={() => setOpen("+new")}><Plus />Add agent</Button>}>Agents</SectionTitle>
      <VCard slot="agents-list">
        {error && <p className="text-geist-red px-4 py-3 text-sm">{error}</p>}
        {defs && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 text-sm" data-slot="agent-default">
            <div>
              <Label htmlFor="agent-default">Default agent</Label>
              <p className="text-muted-foreground text-xs">Gets what names no agent: the main chat, problem worker reports, a link with no agent.</p>
            </div>
            <Select value={def.setting || FIRST} onValueChange={(v) => {
              const name = v === FIRST ? "" : v;
              api.setDefaultAgent(name).then(load).catch((e) => setError(e instanceof Error ? e.message : String(e)));
            }}>
              <SelectTrigger id="agent-default" data-slot="agent-default-select" size="sm" className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={FIRST}>First agent ({defs[0]?.displayName ?? "none"})</SelectItem>
                {defs.map((d) => <SelectItem key={d.name} value={d.name}>{d.displayName}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
        {!defs ? <Empty>Loading agents…</Empty> : (
          <ul className="divide-y">
            {open === "+new" && (
              <li className="px-4 py-4"><AgentEditor verbs={verbs} onCancel={() => setOpen(null)} onSaved={() => { setOpen(null); void load(); }} /></li>
            )}
            {defs.map((d) => (
              <li key={d.name} data-slot="agent-row" data-agent={d.name}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                  <span className="bg-muted inline-flex size-8 shrink-0 items-center justify-center rounded-md border"><Bot className="size-4" /></span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{d.displayName}</span>
                    <span className="text-muted-foreground block font-mono text-xs">{d.name}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {d.name === def.current && <Pill tone="blue">default</Pill>}
                    <Pill>{d.model ? modelLabel(d.model) : "default model"}</Pill>
                    <Pill tone={d.tools.shell ? "amber" : "default"}>{d.tools.shell ? "shell" : "no shell"}</Pill>
                    <Pill tone={d.tools.verbs === "all" ? "amber" : "default"}>{agentToolsLabel(d.tools)}</Pill>
                  </span>
                  <span className="ml-auto flex items-center gap-1">
                    {defs.length > 1 && <Button size="sm" variant="ghost" data-slot="agent-archive" onClick={() => setArchive(d)}>Archive</Button>}
                    <Button size="sm" variant="secondary" data-slot="agent-edit" onClick={() => setOpen(open === d.name ? null : d.name)}>{open === d.name ? "Close" : "Edit"}</Button>
                  </span>
                </div>
                {open === d.name && (
                  <div className="border-t px-4 py-4"><AgentEditor def={d} verbs={verbs} onCancel={() => setOpen(null)} onSaved={() => { setOpen(null); void load(); }} /></div>
                )}
              </li>
            ))}
          </ul>
        )}
      </VCard>
      <AlertDialog open={!!archive} onOpenChange={(o) => { if (!o) setArchive(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {archive?.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>Its tab goes away and it takes no more messages. Its chat, memories and queue stay.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
              const d = archive; setArchive(null);
              if (d) api.archiveAgentDef(d.name).then(load).catch((e) => setError(e instanceof Error ? e.message : String(e)));
            }}>Archive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

/** One agent's form: edit a row (`def`), or add one (no `def`). */
function AgentEditor({ def, verbs, onCancel, onSaved }: { def?: AgentDef; verbs: string[]; onCancel: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<AgentDraft>(() => agentDraftOf(def));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = (f: string) => `agent-${def?.name ?? "new"}-${f}`;
  const claude = MODELS.filter((m) => m.provider === "claude");
  const models = draft.model && !claude.some((m) => m.id === draft.model) ? [...claude, { id: draft.model, label: draft.model, provider: "claude" as const }] : claude;
  const save = async () => {
    setBusy(true); setError(undefined);
    try {
      const tools = { shell: draft.shell, verbs: draft.verbs };
      if (def) await api.editAgentDef(def.name, agentDraftPatch(def, draft));
      else await api.addAgentDef({ name: draft.name, displayName: draft.displayName, role: draft.role, ...(draft.model ? { model: draft.model } : {}), tools });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const all = draft.verbs === "all";
  return (
    <form data-slot="agent-editor" className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="grid gap-4 sm:grid-cols-3">
        {!def && (
          <Field id={id("name")} label="Name" hint="A slug: a-z, 0-9 and -. Also its chat's branch.">
            <Input id={id("name")} data-slot="agent-name" className="font-mono" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="scout" />
          </Field>
        )}
        <Field id={id("display")} label="Display name">
          <Input id={id("display")} data-slot="agent-display" value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} placeholder="Scout" />
        </Field>
        <Field id={id("model")} label="Model">
          <Select value={draft.model || DEFAULT_MODEL} onValueChange={(v) => setDraft({ ...draft, model: v === DEFAULT_MODEL ? "" : v })}>
            <SelectTrigger id={id("model")} data-slot="agent-model" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_MODEL}>Default (Opus 5.5)</SelectItem>
              {models.map((m) => <SelectItem key={m.id} value={m.id}>{modelLabel(m.id)}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field id={id("role")} label="Role text" hint="Sent when a session starts. A running session sees a new role after its next context reset.">
        <Textarea id={id("role")} data-slot="agent-role" className="min-h-40 font-mono text-xs" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} />
      </Field>
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor={id("shell")}>Shell</Label>
          <p className="text-muted-foreground text-xs">Claude Code's full terminal toolset. Off: the <code>orca</code> verbs below and reading only.</p>
        </div>
        <Switch id={id("shell")} data-slot="agent-shell" checked={draft.shell} onCheckedChange={(v) => setDraft({ ...draft, shell: v })} />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Verbs</legend>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox data-slot="agent-verbs-all" checked={all} onCheckedChange={(v) => setDraft({ ...draft, verbs: v === true ? "all" : [] })} />
          All verbs <span className="text-muted-foreground text-xs">(every <code>orca</code> verb, now and later)</span>
        </label>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4" data-slot="agent-verbs">
          {verbs.map((v) => (
            <label key={v} className={`flex items-center gap-2 font-mono text-xs ${all ? "opacity-50" : ""}`}>
              <Checkbox data-slot="agent-verb" data-verb={v} disabled={all} checked={all || (draft.verbs as string[]).includes(v)}
                onCheckedChange={(on) => setDraft({ ...draft, verbs: toggleAgentVerb(draft.verbs, v, on === true) })} />
              {v}
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p className="text-geist-red text-sm" data-slot="agent-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" data-slot="agent-save" disabled={busy}>{def ? "Save" : "Add agent"}</Button>
      </div>
    </form>
  );
}
