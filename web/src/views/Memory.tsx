// The Memory page (docs/design/named-agents-and-memory.md §9): every memory the agents keep, with its
// source and date, and the user's controls — edit, pin, mark trusted, archive, forget, restore, revert.
// Every change here is a new revision by "user" (server/memoryRoutes.ts). The view lives in the URL
// (shared/memory.ts parseMemoryQuery), so a filtered view is a link; `?m=<id>` opens one memory and
// `?tab=activity|core` the other tabs.
import { useEffect, useId, useState, type ReactNode } from "react";
import { Brain, ChevronDown, Pin, Plus, X } from "lucide-react";
import { api, type MemoryActivityRow, type MemoryCore, type MemoryDetail, type MemoryList } from "../api";
import { ago } from "../workstream";
import {
  MEMORY_STATES, SOURCE_KINDS, lineDiff, memoryQueryString, parseMemoryQuery, sourceKind, type Memory, type MemoryQuery, type MemoryRevision, type MemorySort,
} from "../../../shared/memory";
import { Empty, Pill, RowSkeleton, VCard } from "@/components/console";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { confirmDialog } from "@/lib/dialogs";
import { notifyLocal } from "@/lib/notificationStore";
import { navigate, useSearch } from "@/lib/route";
import { cn } from "@/lib/utils";

type Tab = "memories" | "activity" | "core";
const SORT_LABELS: Record<MemorySort, string> = { updated: "Last updated", importance: "Importance", recalls: "Most recalled", core: "Core score" };
const IMPORTANCE = Array.from({ length: 10 }, (_, i) => String(i + 1));

const failed = (label: string, e: unknown) => {
  const error = e instanceof Error ? e.message : String(e);
  notifyLocal({ kind: "action_failed", repo: "", title: `Memory · ${label}`, label, body: error, copy: `Action: ${label}\nError:\n${error}`, ask: `${label} on the Memory page failed: ${error}. Please investigate.` });
};

/** Where to go: the page with this view, tab and open memory. */
function pathOf(q: MemoryQuery, tab: Tab, open?: number): string {
  return `/memory${memoryQueryString(q, { tab: tab === "memories" ? undefined : tab, m: open ? String(open) : undefined })}`;
}

export function MemoryPage() {
  const search = useSearch();
  const q = parseMemoryQuery(search);
  const params = new URLSearchParams(search);
  const tab = (["activity", "core"].includes(params.get("tab") ?? "") ? params.get("tab") : "memories") as Tab;
  const open = Number(params.get("m")) || undefined;
  const go = (next: Partial<MemoryQuery>, t: Tab = tab, m: number | undefined = open) => navigate(pathOf({ ...q, ...next }, t, m), true);
  const [reload, setReload] = useState(0);
  const refresh = () => setReload((n) => n + 1);
  const [creating, setCreating] = useState(false);
  const [data, setData] = useState<MemoryList | null>(null);
  const listQuery = memoryQueryString(q);
  useEffect(() => {
    let live = true;
    api.memories(listQuery).then((d) => { if (live) setData(d); }).catch((e) => failed("Load memories", e));
    return () => { live = false; };
  }, [listQuery, reload]);
  const heavy = data ? Object.entries(data.today).filter(([, n]) => n >= data.limits.perDay) : [];
  return (
    <div className="space-y-5" data-slot="memory-page">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-heading text-2xl font-semibold tracking-tight">Memory</h1>
          <p className="text-muted-foreground mt-1 text-sm">What the agents keep across resets, in their own words. Every change is a revision you can revert.</p>
        </div>
        <Button size="sm" data-slot="memory-new" onClick={() => setCreating(true)}><Plus className="size-4" /> New memory</Button>
      </div>
      {heavy.length > 0 && (
        <div data-slot="memory-rate-warning" className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          {heavy.map(([agent, n]) => `${agent} made ${n} memory changes in 24 hours, the limit`).join("; ")}. Orca refuses more until the day rolls over.
        </div>
      )}
      <Tabs value={tab} onValueChange={(v) => go({}, v as Tab, undefined)}>
        <TabsList>
          <TabsTrigger value="memories">Memories</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="core">Core</TabsTrigger>
        </TabsList>
        <TabsContent value="memories" className="space-y-3 pt-3">
          <FilterBar q={q} owners={data?.owners ?? []} go={go} />
          <VCard slot="memory-list" bodyClass="divide-y">
            {data === null ? <RowSkeleton /> : data.memories.length === 0
              ? <Empty icon={<Brain />}>{q.q || listQuery ? "No memory matches this view." : "No memories yet. The agents write them as they work."}</Empty>
              : data.memories.map((m) => <MemoryRow key={m.id} m={m} onOpen={() => go({}, tab, m.id)} onTag={(tag) => go({ tag })} />)}
          </VCard>
        </TabsContent>
        <TabsContent value="activity" className="pt-3">{tab === "activity" && <Activity reload={reload} onOpen={(id) => go({}, tab, id)} />}</TabsContent>
        <TabsContent value="core" className="pt-3">{tab === "core" && <Core reload={reload} onOpen={(id) => go({}, tab, id)} />}</TabsContent>
      </Tabs>
      {open !== undefined && <MemoryDialog id={open} onClose={() => go({}, tab, undefined)} onOpen={(id) => go({}, tab, id)} onChanged={refresh} />}
      {creating && <NewMemory owners={data?.owners ?? ["shared", "chief"]} onClose={() => setCreating(false)} onCreated={(m) => { setCreating(false); refresh(); go({}, "memories", m.id); }} />}
    </div>
  );
}

// ── The list ───────────────────────────────────────────────────────────────────────────────────

function FilterBar({ q, owners, go }: { q: MemoryQuery; owners: string[]; go: (next: Partial<MemoryQuery>) => void }) {
  const [text, setText] = useState(q.q);
  useEffect(() => setText(q.q), [q.q]);
  useEffect(() => {
    if (text === q.q) return;
    const t = setTimeout(() => go({ q: text }), 300);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex flex-wrap items-center gap-2" data-slot="memory-filters">
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search memories…" aria-label="Search memories" className="h-8 w-64 max-md:w-full" />
      <Filter label="Owner" options={owners.map((o) => ({ value: o, label: o }))} on={q.owners} set={(owners) => go({ owners })} />
      <Filter label="State" options={MEMORY_STATES.map((s) => ({ value: s, label: s }))} on={q.states} set={(states) => go({ states: (states.length ? states : ["active"]) as MemoryQuery["states"] })} />
      <Filter label="Source" options={SOURCE_KINDS.map((s) => ({ value: s, label: s }))} on={q.sources} set={(sources) => go({ sources: sources as MemoryQuery["sources"] })} />
      <Filter label="Trust" options={[{ value: "trusted", label: "trusted" }, { value: "untrusted", label: "untrusted" }]} on={q.trust} set={(trust) => go({ trust: trust as MemoryQuery["trust"] })} />
      <Filter label="Pinned" options={[{ value: "1", label: "Pinned only" }]} on={q.pinned ? ["1"] : []} set={(v) => go({ pinned: v.includes("1") })} />
      {q.tag && (
        <Button variant="outline" size="sm" className="h-8 gap-1 text-[13px]" data-slot="memory-tag-filter" onClick={() => go({ tag: "" })}>
          tag: {q.tag} <X className="size-3.5" />
        </Button>
      )}
      <Select value={q.sort} onValueChange={(sort) => go({ sort: sort as MemorySort })}>
        <SelectTrigger size="sm" className="h-8 w-40 text-[13px]" aria-label="Sort"><SelectValue /></SelectTrigger>
        <SelectContent>{(Object.keys(SORT_LABELS) as MemorySort[]).map((s) => <SelectItem key={s} value={s}>{SORT_LABELS[s]}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

/** One filter family as a dropdown of checkboxes (OR within it), as on the Agents list. */
function Filter({ label, options, on, set }: { label: string; options: { value: string; label: string }[]; on: string[]; set: (v: string[]) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-slot="memory-filter" data-group={label.toLowerCase()} data-active={on.length}
          className={cn("h-8 gap-1.5 px-2.5 text-[13px] font-normal", on.length ? "border-foreground/30" : "text-muted-foreground")}>
          {label}
          {on.length > 0 && <span className="bg-foreground text-background rounded-full px-1.5 text-[11px] leading-4 tabular-nums">{on.length}</span>}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-1">
        {options.map((o) => <FilterOption key={o.value} label={o.label} checked={on.includes(o.value)} onToggle={() => set(on.includes(o.value) ? on.filter((v) => v !== o.value) : [...on, o.value])} />)}
      </PopoverContent>
    </Popover>
  );
}

function FilterOption({ label, checked, onToggle }: { label: string; checked: boolean; onToggle: () => void }) {
  const id = useId();
  return (
    <label htmlFor={id} className="hover:bg-accent flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] max-md:h-11">
      <Checkbox id={id} checked={checked} onCheckedChange={onToggle} />
      <span className="truncate">{label}</span>
    </label>
  );
}

function Meta({ m }: { m: Memory }) {
  return (
    <span className="text-muted-foreground text-xs">
      updated {ago(m.updatedAt)} by {m.updatedBy} · r{m.revision} · source {m.source}
    </span>
  );
}

function MemoryRow({ m, onOpen, onTag }: { m: Memory; onOpen: () => void; onTag: (tag: string) => void }) {
  return (
    <div role="button" tabIndex={0} data-slot="memory-row" data-id={m.id} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
      className="hover:bg-accent/50 flex cursor-pointer flex-col gap-1 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        {m.pinned && <Pin className="size-3.5 shrink-0" aria-label="pinned" />}
        <span className="truncate text-[13px] font-medium">{m.title}</span>
        <Pill>{m.owner}</Pill>
        {m.trust === "untrusted" && <Pill tone="red" slot="memory-untrusted">untrusted</Pill>}
        {m.state !== "active" && <Pill tone="amber">{m.state}</Pill>}
        <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">importance {m.importance}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {m.tags.map((t) => (
          <button key={t} type="button" className="bg-selected text-selected-foreground rounded px-1.5 text-[11px]" onClick={(e) => { e.stopPropagation(); onTag(t); }}>{t}</button>
        ))}
        <Meta m={m} />
      </div>
    </div>
  );
}

// ── Activity and core ──────────────────────────────────────────────────────────────────────────

function Activity({ reload, onOpen }: { reload: number; onOpen: (id: number) => void }) {
  const [rows, setRows] = useState<MemoryActivityRow[] | null>(null);
  useEffect(() => { api.memoryActivity().then((d) => setRows(d.revisions)).catch((e) => failed("Load activity", e)); }, [reload]);
  return (
    <VCard slot="memory-activity" title="Last 200 changes" bodyClass="divide-y">
      {rows === null ? <RowSkeleton /> : rows.length === 0 ? <Empty>No changes yet.</Empty> : rows.map((r) => (
        <div key={`${r.memoryId}:${r.revision}`} role="button" tabIndex={0} data-slot="memory-activity-row" onClick={() => onOpen(r.memoryId)}
          onKeyDown={(e) => { if (e.key === "Enter") onOpen(r.memoryId); }} className="hover:bg-accent/50 flex cursor-pointer items-center gap-2 px-4 py-2 text-[13px]">
          <span className="text-muted-foreground w-24 shrink-0 text-xs">{ago(r.at)}</span>
          <span className="truncate font-medium">m{r.memoryId} r{r.revision} · {r.title}</span>
          <span className="text-muted-foreground truncate text-xs">{r.by} — {r.reason ?? "(no reason)"}</span>
          {r.trust === "untrusted" && <Pill tone="red">untrusted</Pill>}
        </div>
      ))}
    </VCard>
  );
}

function Core({ reload, onOpen }: { reload: number; onOpen: (id: number) => void }) {
  const [core, setCore] = useState<MemoryCore | null>(null);
  useEffect(() => { api.memoryCore("chief").then(setCore).catch((e) => failed("Load core", e)); }, [reload]);
  return (
    <VCard slot="memory-core" title="What the orchestrator gets on every wake"
      aside={core && <span className="text-muted-foreground text-xs tabular-nums" data-slot="memory-core-tokens">{core.tokens} of {core.budget} tokens</span>} bodyClass="divide-y">
      {core && core.pinnedTokens > core.pinnedWarn && (
        <div data-slot="memory-pinned-warning" className="bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
          Pinned memories use {core.pinnedTokens} tokens, more than {core.pinnedWarn}. They leave less room for the rest.
        </div>
      )}
      {core === null ? <RowSkeleton /> : core.items.length === 0 ? <Empty>The core is empty.</Empty> : core.items.map(({ memory: m, cut }) => (
        <div key={m.id} role="button" tabIndex={0} onClick={() => onOpen(m.id)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(m.id); }}
          className="hover:bg-accent/50 flex cursor-pointer items-center gap-2 px-4 py-2 text-[13px]" data-slot="memory-core-row">
          {m.pinned && <Pin className="size-3.5 shrink-0" aria-label="pinned" />}
          <span className="truncate font-medium">{m.title}</span>
          <Pill>{m.owner}</Pill>
          {cut && <Pill tone="amber">cut</Pill>}
          {m.trust === "untrusted" && <Pill tone="red">untrusted</Pill>}
        </div>
      ))}
      {core && core.leftOut > 0 && <div className="text-muted-foreground px-4 py-2 text-xs">{core.leftOut} more do not fit. The agent finds them with orca memory recall.</div>}
    </VCard>
  );
}

// ── One memory ─────────────────────────────────────────────────────────────────────────────────

type Draft = { title: string; body: string; tags: string; importance: string };
const draftOf = (m: Memory): Draft => ({ title: m.title, body: m.body, tags: m.tags.join(", "), importance: String(m.importance) });

function DraftFields({ draft, set, owner }: { draft: Draft; set: (d: Draft) => void; owner?: { value: string; options: string[]; set: (v: string) => void } }) {
  return (
    <div className="space-y-3" data-slot="memory-form">
      {owner && (
        <Select value={owner.value} onValueChange={owner.set}>
          <SelectTrigger aria-label="Owner" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{owner.options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
        </Select>
      )}
      <Input aria-label="Title" placeholder="Title" value={draft.title} onChange={(e) => set({ ...draft, title: e.target.value })} />
      <Textarea aria-label="Body" placeholder="The memory, in plain words" rows={8} value={draft.body} onChange={(e) => set({ ...draft, body: e.target.value })} />
      <div className="flex gap-2">
        <Input aria-label="Tags" placeholder="tags, comma separated" value={draft.tags} onChange={(e) => set({ ...draft, tags: e.target.value })} />
        <Select value={draft.importance} onValueChange={(importance) => set({ ...draft, importance })}>
          <SelectTrigger aria-label="Importance" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>{IMPORTANCE.map((n) => <SelectItem key={n} value={n}>importance {n}</SelectItem>)}</SelectContent>
        </Select>
      </div>
    </div>
  );
}

function NewMemory({ owners, onClose, onCreated }: { owners: string[]; onClose: () => void; onCreated: (m: Memory) => void }) {
  const [draft, setDraft] = useState<Draft>({ title: "", body: "", tags: "", importance: "5" });
  const [owner, setOwner] = useState("shared");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const { memory } = await api.writeMemory({ owner, title: draft.title, body: draft.body, tags: draft.tags.split(","), importance: Number(draft.importance) });
      onCreated(memory);
    } catch (e) { failed("New memory", e); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent data-slot="memory-new-dialog">
        <DialogHeader><DialogTitle>New memory</DialogTitle><DialogDescription>You write it, so it is trusted.</DialogDescription></DialogHeader>
        <DraftFields draft={draft} set={setDraft} owner={{ value: owner, options: owners, set: setOwner }} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button data-slot="memory-create" disabled={busy || !draft.title.trim() || !draft.body.trim()} onClick={() => void save()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemoryDialog({ id, onClose, onOpen, onChanged }: { id: number; onClose: () => void; onOpen: (id: number) => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.memory(id).then(setDetail).catch((e) => failed("Load memory", e));
  useEffect(() => { setDetail(null); setEditing(null); void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (label: string, body: Parameters<typeof api.changeMemory>[1], confirm?: { title: string; description: string }) => {
    if (confirm && !(await confirmDialog({ ...confirm, confirmLabel: label, destructive: true }))) return;
    setBusy(true);
    try { await api.changeMemory(id, body); setEditing(null); await load(); onChanged(); } catch (e) { failed(label, e); } finally { setBusy(false); }
  };
  const m = detail?.memory;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-slot="memory-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{m?.pinned && <Pin className="size-4" aria-label="pinned" />}{m ? `m${m.id} · ${m.title}` : "Memory"}</DialogTitle>
          {m && <DialogDescription asChild><div className="flex flex-wrap items-center gap-1.5"><Pill>{m.owner}</Pill>{m.trust === "untrusted" && <Pill tone="red">untrusted</Pill>}{m.state !== "active" && <Pill tone="amber">{m.state}</Pill>}<Meta m={m} /></div></DialogDescription>}
        </DialogHeader>
        {!m ? <RowSkeleton /> : editing ? <DraftFields draft={editing} set={setEditing} /> : (
          <div className="space-y-4 text-[13px]">
            <Markdown>{m.body}</Markdown>
            <Facts rows={[
              ["Importance", String(m.importance)], ["Tags", m.tags.join(", ") || "—"], ["Source", `${m.source} (${sourceKind(m.source)})`],
              ["Created", `${new Date(m.createdAt).toLocaleString()} by ${m.createdBy}`], ["Recalled", `${m.recallCount} time${m.recallCount === 1 ? "" : "s"}${m.lastRecalledAt ? `, last ${ago(m.lastRecalledAt)}` : ""}`],
            ]} />
            {detail.links.length > 0 && (
              <Section title="Links">
                {detail.links.map((l) => (
                  <button key={`${l.direction}:${l.relation}:${l.id}`} type="button" className="hover:bg-accent block w-full rounded px-2 py-1 text-left" onClick={() => onOpen(l.id)}>
                    {l.direction === "out" ? "→" : "←"} {l.relation} m{l.id} “{l.title}”{l.state !== "active" ? ` (${l.state})` : ""}
                  </button>
                ))}
              </Section>
            )}
            {detail.wakes.length > 0 && (
              <Section title="Scheduled wakes">
                {detail.wakes.map((w) => <div key={w.id} className="px-2 py-1">w{w.id} [{w.state}] {w.on ? `on ${w.on}` : `at ${new Date(w.fireAt ?? 0).toLocaleString()}`} — {w.note}</div>)}
              </Section>
            )}
            <Section title="History">
              {detail.revisions.map((r, i) => <Revision key={r.revision} r={r} before={detail.revisions[i + 1]} current={r.revision === m.revision} busy={busy}
                onRevert={() => void act("Revert", { action: "revert", revision: r.revision }, { title: `Revert m${m.id} to r${r.revision}?`, description: "This writes a new revision with that content. Nothing is lost." })} />)}
            </Section>
          </div>
        )}
        {m && (
          <DialogFooter className="flex-wrap gap-2 sm:justify-start">
            {editing ? (
              <>
                <Button data-slot="memory-save" disabled={busy} onClick={() => void act("Save", { action: "edit", title: editing.title, body: editing.body, tags: editing.tags.split(","), importance: Number(editing.importance) })}>Save</Button>
                <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" data-slot="memory-edit" onClick={() => setEditing(draftOf(m))}>Edit</Button>
                <Button variant="outline" size="sm" data-slot="memory-pin" disabled={busy} onClick={() => void act(m.pinned ? "Unpin" : "Pin", { action: m.pinned ? "unpin" : "pin" })}>{m.pinned ? "Unpin" : "Pin"}</Button>
                {m.trust === "untrusted" && <Button variant="outline" size="sm" data-slot="memory-trust" disabled={busy} onClick={() => void act("Mark trusted", { action: "trust" }, { title: "Mark this memory trusted?", description: "Its text came from outside. Mark it trusted only after you checked it: an agent can then treat it as a fact." })}>Mark trusted</Button>}
                {m.state === "active" ? (
                  <>
                    <Button variant="outline" size="sm" data-slot="memory-archive" disabled={busy} onClick={() => void act("Archive", { action: "state", state: "archived" }, { title: "Archive this memory?", description: "It leaves the core and the default search. You can restore it." })}>Archive</Button>
                    <Button variant="outline" size="sm" data-slot="memory-forget" disabled={busy} onClick={() => void act("Forget", { action: "state", state: "forgotten" }, { title: "Forget this memory?", description: "No agent sees it any more. You can restore it here." })}>Forget</Button>
                  </>
                ) : <Button variant="outline" size="sm" data-slot="memory-restore" disabled={busy} onClick={() => void act("Restore", { action: "state", state: "active" })}>Restore</Button>}
              </>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
      {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>)}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <div><div className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">{title}</div><div className="divide-y rounded-md border">{children}</div></div>;
}

function Revision({ r, before, current, busy, onRevert }: { r: MemoryRevision; before?: MemoryRevision; current: boolean; busy: boolean; onRevert: () => void }) {
  const [diff, setDiff] = useState(false);
  const changes = before ? lineDiff(`${before.title}\n\n${before.body}`, `${r.title}\n\n${r.body}`) : [];
  return (
    <div className="px-2 py-1.5" data-slot="memory-revision" data-revision={r.revision}>
      <div className="flex items-center gap-2">
        <span className="font-medium tabular-nums">r{r.revision}</span>
        <span className="text-muted-foreground truncate text-xs">{new Date(r.at).toLocaleString()} · {r.by}{r.runId ? ` · run ${r.runId.slice(0, 8)}` : ""} — {r.reason ?? "(no reason)"} · {r.state}{r.pinned ? ", pinned" : ""}{r.trust === "untrusted" ? ", untrusted" : ""}</span>
        <span className="ml-auto flex shrink-0 gap-1">
          {before && <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setDiff(!diff)}>{diff ? "Hide diff" : "Diff"}</Button>}
          {!current && <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" data-slot="memory-revert" disabled={busy} onClick={onRevert}>Revert to this</Button>}
        </span>
      </div>
      {diff && (
        <pre className="bg-muted mt-1 max-h-60 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap" data-slot="memory-diff">
          {changes.map((d, i) => <div key={i} className={d.kind === "add" ? "text-green-700 dark:text-green-400" : d.kind === "del" ? "text-red-700 line-through dark:text-red-400" : "text-muted-foreground"}>{d.kind === "add" ? "+ " : d.kind === "del" ? "- " : "  "}{d.text}</div>)}
        </pre>
      )}
    </div>
  );
}
