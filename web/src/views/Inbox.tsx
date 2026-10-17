// The unified inbox and timeline (docs/research/integrations.md §6.2): every inbound message and
// event from every integration, newest first — its source, its sender, the workstream it belongs to
// and the state of Orca's reply — filtered by source and person, with the whole conversation (in and
// out) in a thread view. The rows are built on the server (shared/inbox.ts over the core's event,
// delivery and thread_link rows); this page only draws them. The filters and the open thread live in
// the URL (?source= &person= &thread=), so a view is a link. On a desktop the thread opens beside the
// list; on a phone it replaces the list, with Back.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Inbox as InboxIcon, X } from "lucide-react";
import { navigate, useSearch } from "@/lib/route";
import { poll } from "@/lib/poll";
import { cn } from "@/lib/utils";
import { useNarrow } from "@/lib/viewport";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Empty, RowSkeleton, StatusDot, VCard, type DotTone } from "@/components/console";
import { SourceChip } from "@/components/SourceChip";
import { api, type InboxPage, type InboxThread } from "../api";
import { useWorkstreams } from "../store";
import { ago } from "../workstream";
import { detailPath } from "./Agents";
import { deliveryLabel, parseConversation, sourceLabel, type InboxRow, type ReplyState, type ThreadItem } from "../../../shared/inbox";
import type { DeliveryState } from "../../../shared/integrations";

const EVERYONE = "*";

export function InboxPage() {
  const search = useSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const source = params.get("source") ?? "", person = params.get("person") ?? "", thread = params.get("thread") ?? "";
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) if (v) next.set(k, v); else next.delete(k);
    const qs = next.toString();
    navigate(`/inbox${qs ? `?${qs}` : ""}`);
  };
  const [page, setPage] = useState<InboxPage | null>(null);
  const [older, setOlder] = useState<InboxRow[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setPage(null); setOlder([]); setOlderCursor(undefined);
    return poll(() => api.inbox({ source, person }).then((p) => { setPage(p); setError(undefined); }, (e) => setError(e instanceof Error ? e.message : String(e))), 15_000);
  }, [source, person]);
  const cursor = olderCursor === undefined ? page?.older ?? null : olderCursor;
  const loadOlder = async () => {
    if (!cursor) return;
    const p = await api.inbox({ before: cursor, source, person });
    setOlder((o) => [...o, ...p.rows]);
    setOlderCursor(p.older);
  };
  const rows = page ? [...page.rows, ...older] : null;
  const narrow = useNarrow();
  const open = parseConversation(thread) ? thread : "";
  const list = (
    <div className="space-y-3">
      <Filters page={page} source={source} person={person} set={set} />
      <VCard slot="inbox-list" bodyClass="divide-y">
        {error && !page ? <Empty>Could not load the inbox: {error}</Empty>
          : rows === null ? <><RowSkeleton /><RowSkeleton /><RowSkeleton /></>
          : rows.length === 0 ? (
            <Empty icon={<InboxIcon />}>
              {source || person ? "No messages match these filters." : "No messages yet. Messages and events from linked integrations show here."}
            </Empty>
          )
          : rows.map((r) => <InboxRowView key={r.id} row={r} selected={open === r.conversation} onOpen={() => set({ thread: r.conversation })} />)}
        {cursor && rows && (
          <div className="flex justify-center px-4 py-2">
            <Button variant="ghost" size="sm" onClick={() => void loadOlder()}>Load older</Button>
          </div>
        )}
      </VCard>
    </div>
  );
  if (open && narrow) return <ThreadView conversation={open} onClose={() => set({ thread: "" })} back />;
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
      {open ? (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          {list}
          <div className="lg:sticky lg:top-16"><ThreadView conversation={open} onClose={() => set({ thread: "" })} /></div>
        </div>
      ) : list}
    </div>
  );
}

const chipClass = (on: boolean) => cn(
  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition-colors",
  on ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:text-foreground hover:border-foreground/30",
);

function Filters({ page, source, person, set }: { page: InboxPage | null; source: string; person: string; set: (p: Record<string, string>) => void }) {
  const sources = page?.facets.sources ?? [], people = page?.facets.people ?? [];
  // A chip the window no longer holds still shows while it is the filter, so it can be turned off.
  const shown = source && !sources.some((s) => s.adapter === source) ? [...sources, { adapter: source, count: 0 }] : sources;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div role="group" aria-label="Source" className="flex flex-wrap items-center gap-1.5">
        <button type="button" data-slot="inbox-source" data-source="" aria-pressed={!source} onClick={() => set({ source: "" })} className={chipClass(!source)}>All sources</button>
        {shown.map((s) => (
          <button key={s.adapter} type="button" data-slot="inbox-source" data-source={s.adapter} aria-pressed={source === s.adapter}
            onClick={() => set({ source: source === s.adapter ? "" : s.adapter })} className={chipClass(source === s.adapter)}>
            {sourceLabel(s.adapter)}
            <span className="tabular-nums opacity-60">{s.count}</span>
          </button>
        ))}
      </div>
      <Select value={person || EVERYONE} onValueChange={(v) => set({ person: v === EVERYONE ? "" : v })}>
        <SelectTrigger data-slot="inbox-person" className="h-7 w-auto min-w-36 rounded-full text-[13px]" aria-label="Person">
          <span className="text-muted-foreground text-xs">From</span><SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={EVERYONE}>Everyone</SelectItem>
          {person && !people.some((p) => p.id === person) && <SelectItem value={person}>{person}</SelectItem>}
          {people.map((p) => <SelectItem key={p.id} value={p.id}>{p.name} <span className="text-muted-foreground tabular-nums">{p.count}</span></SelectItem>)}
        </SelectContent>
      </Select>
      {(source || person) && (
        <button type="button" data-slot="clear-filters" onClick={() => set({ source: "", person: "" })} className="text-muted-foreground hover:text-foreground inline-flex h-7 items-center gap-1 px-1.5 text-[13px]">
          <X className="size-3.5" /> Clear
        </button>
      )}
    </div>
  );
}

const STATE_TONE: Record<DeliveryState, DotTone> = { pending: "queued", sending: "building", sent: "ready", failed: "warning", dead: "error" };

function DeliveryBadge({ state, error, prefix }: { state: DeliveryState; error?: string; prefix?: string }) {
  const badge = (
    <span data-slot="delivery-state" data-state={state} className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs", state === "dead" ? "text-geist-red" : "text-muted-foreground")}>
      <StatusDot tone={STATE_TONE[state]} className="size-2" />{prefix ? `${prefix} ${deliveryLabel(state).toLowerCase()}` : deliveryLabel(state)}
    </span>
  );
  return error && state !== "sent" ? <Tip label={error}>{badge}</Tip> : badge;
}

const replyBadge = (r: ReplyState) => <DeliveryBadge state={r.state} error={r.error} prefix="Reply" />;

/** The workstream a row or thread belongs to, as a chip that opens its page. */
function WorkstreamChip({ repo, branch }: { repo: string; branch: string }) {
  const rows = useWorkstreams();
  const row = rows.find((r) => r.repo === repo && r.branch === branch);
  const to = (row && detailPath(row)) ?? `/${repo}/local/${encodeURIComponent(branch)}`;
  return (
    <a href={to} data-slot="workstream-chip" onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(to); }}
      className="hover:text-foreground text-muted-foreground inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-md border px-1.5 text-[11px]">
      <span className="shrink-0">{repo}</span><span aria-hidden="true">/</span><span className="min-w-0 truncate font-mono">{row?.title && row.title !== branch ? row.title : branch}</span>
    </a>
  );
}

const When = ({ at }: { at: number }) => (
  <Tip label={new Date(at).toLocaleString()}><span className="text-muted-foreground shrink-0 text-xs tabular-nums">{ago(at)}</span></Tip>
);

const KIND_LABEL: Record<InboxRow["kind"], string | undefined> = { message: undefined, question: "Question", event: "Event" };

function InboxRowView({ row, selected, onOpen }: { row: InboxRow; selected: boolean; onOpen: () => void }) {
  const who = row.sender?.name ?? (row.kind === "question" ? "Orchestrator" : sourceLabel(row.adapter));
  const kind = KIND_LABEL[row.kind];
  return (
    <div role="button" tabIndex={0} data-slot="inbox-row" data-kind={row.kind} aria-current={selected || undefined}
      onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className={cn("flex cursor-pointer gap-3 px-4 py-3 text-sm outline-none", selected ? "bg-accent" : "hover:bg-accent/40 focus-visible:bg-accent/40")}>
      <SourceChip adapter={row.adapter} iconOnly className="mt-0.5 size-6 justify-center rounded-full p-0 [&>svg]:size-3.5" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span data-slot="inbox-sender" className="min-w-0 truncate font-medium">{who}</span>
          {kind && <span className="bg-muted text-muted-foreground shrink-0 rounded px-1 text-[10px] leading-4 font-medium uppercase">{kind}</span>}
          <span className="ml-auto" />
          <When at={row.at} />
        </div>
        {row.title && <div className="truncate text-[13px]">{row.title}</div>}
        <div data-slot="inbox-text" className="text-muted-foreground line-clamp-2 text-[13px] break-words">{row.text}</div>
        {(row.workstream || row.reply) && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {row.workstream && <WorkstreamChip repo={row.workstream.repo} branch={row.workstream.branch} />}
            {row.reply && replyBadge(row.reply)}
          </div>
        )}
      </div>
    </div>
  );
}

/** One conversation, oldest first: inbound on the left under the sender, Orca's deliveries on the
 *  right with their state. Polled while it is open. */
export function ThreadView({ conversation, onClose, back }: { conversation: string; onClose: () => void; back?: boolean }) {
  const [t, setT] = useState<InboxThread | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setT(null);
    return poll(() => api.inboxThread(conversation).then((r) => { setT(r); setError(undefined); }, (e) => setError(e instanceof Error ? e.message : String(e))), 10_000);
  }, [conversation]);
  const c = parseConversation(conversation)!;
  const title = (
    <span className="flex min-w-0 items-center gap-2">
      {back && <Button variant="ghost" size="icon" className="-ml-2 size-8" aria-label="Back" onClick={onClose}><ArrowLeft /></Button>}
      <SourceChip adapter={c.adapter} />
      <span className="min-w-0 truncate font-mono text-xs">{c.id.startsWith("event:") ? "Event" : c.id}</span>
    </span>
  );
  const aside = (
    <>
      {t?.workstream && <WorkstreamChip repo={t.workstream.repo} branch={t.workstream.branch} />}
      {!back && <Button variant="ghost" size="icon" className="size-7" aria-label="Close thread" onClick={onClose}><X /></Button>}
    </>
  );
  return (
    <VCard slot="inbox-thread" title={title} aside={aside} bodyClass="space-y-4 p-4">
      {error && !t ? <Empty>Could not load the thread: {error}</Empty>
        : t === null ? <><RowSkeleton /><RowSkeleton /></>
        : t.items.length === 0 ? <Empty>Nothing in this conversation.</Empty>
        : t.items.map((i) => <ThreadLine key={i.id} item={i} />)}
    </VCard>
  );
}

function ThreadLine({ item }: { item: ThreadItem }) {
  const body: ReactNode = (
    <>
      {item.title && <div className="mb-1 font-medium">{item.title}</div>}
      <div className="break-words whitespace-pre-wrap">{item.text}</div>
    </>
  );
  if (item.dir === "in") return (
    <div data-slot="thread-item" data-dir="in" className="flex max-w-[85%] flex-col items-start gap-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium">{item.sender?.name ?? sourceLabel(item.adapter)}</span>
        <When at={item.at} />
      </div>
      <div className="bg-card rounded-lg border px-3 py-2 text-[13px]">{body}</div>
      {item.url && <a href={item.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline">Open in {sourceLabel(item.adapter)}</a>}
    </div>
  );
  return (
    <div data-slot="thread-item" data-dir="out" className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
      <div className="flex items-center gap-2 text-xs">
        <When at={item.at} />
        <span className="font-medium">Orca</span>
        <span className="text-muted-foreground">to {item.to}</span>
      </div>
      <div className="bg-accent rounded-lg px-3 py-2 text-[13px]">{body}</div>
      <DeliveryBadge state={item.state} error={item.error} />
    </div>
  );
}
