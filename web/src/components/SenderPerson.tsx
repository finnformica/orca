// "Add to person" for a sender with no person behind them (an unknown sender's notification in the
// Inbox or the orchestrator's chat): add their identity to an existing person, or make a new person
// with it. The same routes as Settings' People card (people/save, identities/add), so a person here
// is the one there. The people list is one shared read per page (`usePeople`), refreshed after a change.
import { useEffect, useState, useSyncExternalStore } from "react";
import { UserPlus } from "lucide-react";
import { api } from "../api";
import { notifyLocal } from "@/lib/notificationStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { newPersonId, personOf, type PersonRow } from "../../../shared/integrationSettings";
import { LEVEL_LABEL, LINK_LEVELS, type LinkLevel } from "../../../shared/integrations";

export type SenderRef = { adapter: string; externalId: string; name: string };

let people: PersonRow[] | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const load = (): Promise<void> => (loading ??= api.integrations()
  .then((o) => { people = o.people; }, () => { people ??= []; })
  .finally(() => { loading = null; listeners.forEach((l) => l()); }));

/** Every person, read once per page and again after a change here. Null until the first read. */
export function usePeople(): PersonRow[] | null {
  const list = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => people);
  useEffect(() => { if (people === null) void load(); }, []);
  return list;
}

async function run(label: string, steps: [string, Record<string, unknown>][]): Promise<boolean> {
  try {
    for (const [path, body] of steps) await api.integrationPost(path, body);
    return true;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    notifyLocal({ kind: "action_failed", repo: "", title: "People", label: `${label} failed`, body: error, copy: `Action: ${label}\nError:\n${error}`, ask: `People: ${label} failed: ${error}. Please investigate and fix.` });
    return false;
  } finally {
    await load();
  }
}

const identity = (s: SenderRef) => ({ adapter: s.adapter, externalId: s.externalId, name: s.name });

/** New person…, then each person: one join each. */
function PersonItems({ sender, list, onNew, onDone }: { sender: SenderRef; list: PersonRow[]; onNew: () => void; onDone?: () => void }) {
  const join = async (p: PersonRow) => {
    if (await run(`Add ${sender.name} to ${p.name}`, [["identities/add", { principal: p.id, ...identity(sender) }]])) onDone?.();
  };
  return (
    <>
      <DropdownMenuItem data-slot="add-person-new" onSelect={onNew}>New person…</DropdownMenuItem>
      {list.length > 0 && <DropdownMenuSeparator />}
      {list.map((p) => <DropdownMenuItem key={p.id} data-slot="add-person-existing" onSelect={() => void join(p)}>{p.name}</DropdownMenuItem>)}
    </>
  );
}

/** The submenu for a ⋯ menu. Nothing when the sender has a person. */
export function AddToPersonSub({ sender, onNew, onDone }: { sender: SenderRef; onNew: () => void; onDone?: () => void }) {
  const list = usePeople();
  if (!list || personOf(list, sender.adapter, sender.externalId)) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-slot="action-add-person"><UserPlus />Add to person</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-80 overflow-y-auto"><PersonItems sender={sender} list={list} onNew={onNew} onDone={onDone} /></DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

/** A small button with the same menu, and its dialog. Nothing when the sender has a person. */
export function AddToPersonButton({ sender, onDone }: { sender: SenderRef; onDone?: () => void }) {
  const list = usePeople();
  const [dialog, setDialog] = useState(false);
  if (!list || personOf(list, sender.adapter, sender.externalId)) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" data-slot="add-person" className="h-6 px-2 text-xs"><UserPlus />Add to person</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto"><PersonItems sender={sender} list={list} onNew={() => setDialog(true)} onDone={onDone} /></DropdownMenuContent>
      </DropdownMenu>
      {dialog && <NewPersonDialog sender={sender} onClose={() => setDialog(false)} onDone={onDone} />}
    </>
  );
}

/** A new person with this sender's identity. Their level is the most a message from them can do. */
export function NewPersonDialog({ sender, onClose, onDone }: { sender: SenderRef; onClose: () => void; onDone?: () => void }) {
  const [name, setName] = useState(sender.name);
  const [maxLevel, setMaxLevel] = useState<LinkLevel>("ask");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const id = newPersonId(name, (people ?? []).map((p) => p.id));
    const ok = await run(`Add ${name.trim()}`, [["people/save", { id, name: name.trim(), maxLevel }], ["identities/add", { principal: id, ...identity(sender) }]]);
    setBusy(false);
    if (ok) { onDone?.(); onClose(); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add {sender.name} as a person</DialogTitle>
          <DialogDescription>Their {sender.adapter} identity <span className="font-mono">{sender.externalId}</span> joins the new person. Their next message gets min(link level, their level) and can wake the orchestrator.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor="sender-person-name">Name</Label><Input id="sender-person-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="space-y-1.5">
              <Label htmlFor="sender-person-level">Max level</Label>
              <Select value={maxLevel} onValueChange={(v) => setMaxLevel(v as LinkLevel)}>
                <SelectTrigger id="sender-person-level" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{LINK_LEVELS.map((l) => <SelectItem key={l} value={l}>{LEVEL_LABEL[l]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
