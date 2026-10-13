// The PR page's Overview cards for CI and the conversation (Finn: a PR with many comments was hard
// to scroll, and the checks were a separate tab of unsorted badges). Both are thin renderers over
// pure derivations in workstream.ts — `checkGroups` and `prConversation` — so the folding rules are
// tested without a DOM.
import { useState } from "react";
import { Bot, ChevronDown, ChevronRight, CircleCheck, CircleSlash, CircleX, ExternalLink, Loader2 } from "lucide-react";
import { Pill, VCard } from "@/components/console";
import { Button } from "@/components/ui/button";
import { useReviewThreads } from "../store";
import {
  ago, checkDuration, checkGroups, checkSummary, conversationSummary, foldedChecksLabel, formatDuration, prConversation,
  type CheckRow, type ConversationEntry, type PrComment, type PrReview,
} from "../workstream";
import { Markdown } from "./PrDetail";

// ---- checks ----

function CheckIcon({ c }: { c: CheckRow }) {
  if (c.status === "failing") return <CircleX aria-label="failing" className="text-geist-red size-4 shrink-0" />;
  if (c.status === "pending" || c.status === "none") return <Loader2 aria-label="running" className="text-geist-amber size-4 shrink-0 animate-spin" />;
  if (c.skipped) return <CircleSlash aria-label="skipped" className="text-muted-foreground size-4 shrink-0" />;
  return <CircleCheck aria-label="passing" className="text-geist-green size-4 shrink-0" />;
}

function CheckLine({ c }: { c: CheckRow }) {
  const ms = checkDuration(c);
  return (
    <li data-slot="check" data-status={c.skipped ? "skipped" : c.status} className="flex h-9 items-center gap-2.5 px-4 text-sm">
      <CheckIcon c={c} />
      <span className={`min-w-0 flex-1 truncate ${c.skipped ? "text-muted-foreground" : ""}`} title={c.name}>{c.name}</span>
      {ms !== undefined && <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatDuration(ms)}</span>}
      {c.url
        ? <a href={c.url} target="_blank" rel="noreferrer" aria-label={`Logs for ${c.name}`} className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 text-xs">Logs <ExternalLink className="size-3" /></a>
        : <span className="w-[2.6rem] shrink-0" />}
    </li>
  );
}

/** Failing first, then running / pending, each a compact row; passing and skipped / neutral fold
 *  into ONE line ("24 passing, 3 skipped") that expands in place. */
export function ChecksCard({ checks }: { checks: CheckRow[] }) {
  const [open, setOpen] = useState(false);
  const g = checkGroups(checks);
  const folded = [...g.passing, ...g.skipped];
  return (
    <VCard slot="pr-checks" title="Checks" aside={<span data-slot="checks-summary" className="text-muted-foreground text-xs">{checkSummary(g)}</span>}>
      {checks.length === 0 ? <p className="text-muted-foreground px-4 py-3 text-sm">No checks.</p> : (
        <ul className="divide-y">
          {[...g.failing, ...g.running].map((c, i) => <CheckLine key={`a${i}`} c={c} />)}
          {folded.length > 0 && (
            <li>
              <button type="button" data-slot="checks-folded" aria-expanded={open} onClick={() => setOpen(!open)}
                className="text-muted-foreground hover:bg-accent/40 hover:text-foreground flex h-9 w-full items-center gap-2.5 px-4 text-left text-sm">
                {g.passing.length ? <CircleCheck className="text-geist-green size-4 shrink-0" /> : <CircleSlash className="size-4 shrink-0" />}
                <span className="flex-1">{foldedChecksLabel(g)}</span>
                {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              </button>
            </li>
          )}
          {open && folded.map((c, i) => <CheckLine key={`f${i}`} c={c} />)}
        </ul>
      )}
    </VCard>
  );
}

// ---- conversation ----

const REVIEW_VERB: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", DISMISSED: "review dismissed", COMMENTED: "reviewed" };
const firstLine = (body: string) => body.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "";
const when = (iso?: string) => (iso && Date.parse(iso) > 0 ? ago(Date.parse(iso)) : undefined);

function Meta({ e, children }: { e: ConversationEntry; children?: React.ReactNode }) {
  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
      <span className="text-foreground shrink-0 font-medium">{e.author || "unknown"}</span>
      {children}
      {when(e.createdAt) && <span className="shrink-0">{when(e.createdAt)}</span>}
      {e.url && <a href={e.url} target="_blank" rel="noreferrer" aria-label="Open on GitHub" className="hover:text-foreground shrink-0" onClick={(ev) => ev.stopPropagation()}><ExternalLink className="size-3" /></a>}
    </span>
  );
}

/** A body, clamped to a few lines behind Show more when it is long (`isLongBody`). */
function Body({ body, long }: { body: string; long: boolean }) {
  const [more, setMore] = useState(false);
  if (!body) return null;
  return (
    <div data-slot="comment-body" data-clamped={long && !more ? "" : undefined}>
      <div className={long && !more ? "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]" : undefined}>
        <Markdown>{body}</Markdown>
      </div>
      {long && <button type="button" data-slot="show-more" onClick={() => setMore(!more)} className="text-geist-blue mt-1 text-xs hover:underline">{more ? "Show less" : "Show more"}</button>}
    </div>
  );
}

function EntryRow({ e }: { e: ConversationEntry }) {
  const [open, setOpen] = useState(false);
  const rowId = `conv-${e.id}`;
  if (e.kind === "thread" && e.collapsed && !open) {
    return (
      <li id={rowId} data-slot="conversation-entry" data-kind="thread" data-collapsed="" className="scroll-mt-36">
        <button type="button" onClick={() => setOpen(true)} className="hover:bg-accent/40 flex h-9 w-full min-w-0 items-center gap-2 px-4 text-left text-sm">
          <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
          <Pill>{e.resolved ? "Resolved" : "Outdated"}</Pill>
          <Meta e={e}>{e.path && <code className="truncate">{e.path}{e.line ? `:${e.line}` : ""}</code>}</Meta>
          <span className="text-muted-foreground min-w-0 flex-1 truncate">{firstLine(e.body)}</span>
        </button>
      </li>
    );
  }
  if (e.kind === "review" && !e.body) {
    return (
      <li id={rowId} data-slot="conversation-entry" data-kind="review" className="flex h-9 items-center gap-2 px-4 text-sm">
        <Meta e={e}><span>{REVIEW_VERB[e.state] ?? e.state.toLowerCase()}</span></Meta>
      </li>
    );
  }
  return (
    <li id={rowId} data-slot="conversation-entry" data-kind={e.kind} data-unresolved={e.kind === "thread" && !e.collapsed ? "" : undefined} className="scroll-mt-36 space-y-1.5 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        {e.kind === "thread" && e.collapsed && (
          <button type="button" aria-label="Collapse" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground"><ChevronDown className="size-3.5" /></button>
        )}
        {e.kind === "thread" && <Pill tone={e.collapsed ? "default" : "amber"}>{e.resolved ? "Resolved" : e.outdated ? "Outdated" : "Unresolved"}</Pill>}
        <Meta e={e}>
          {e.kind === "review" && <span>{REVIEW_VERB[e.state] ?? e.state.toLowerCase()}</span>}
          {e.kind === "thread" && e.path && <code className="truncate">{e.path}{e.line ? `:${e.line}` : ""}</code>}
        </Meta>
      </div>
      <Body body={e.body} long={e.long} />
    </li>
  );
}

/** Every bot comment (preview / billing notices, QA reports) as ONE folded row at the top. */
function BotGroup({ bots }: { bots: ConversationEntry[] }) {
  const [open, setOpen] = useState(false);
  const who = [...new Set(bots.map((b) => b.author.replace(/\[bot\]$/, "")))];
  return (
    <li data-slot="bot-group">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:bg-accent/40 hover:text-foreground flex h-9 w-full min-w-0 items-center gap-2 px-4 text-left text-sm">
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <Bot className="size-4 shrink-0" />
        <span className="shrink-0">{bots.length} bot comment{bots.length === 1 ? "" : "s"}</span>
        <span className="min-w-0 truncate text-xs">{who.join(", ")}</span>
      </button>
      {open && <ul className="bg-background/60 divide-y border-t">{bots.map((b) => <EntryRow key={b.id} e={b} />)}</ul>}
    </li>
  );
}

/** The PR's conversation, GitHub's order (chronological — replies and "fixed in …" read in context),
 *  with a counts line and a jump to the first open thread. Inline threads come from the review
 *  signal the Review panel already fetched (`useReviewThreads`), so they cost no extra request. */
export function ConversationCard({ repo, prNumber, sig, comments, reviews }: { repo: string; prNumber: number; sig?: string; comments: PrComment[]; reviews: PrReview[] }) {
  const threads = useReviewThreads(repo, prNumber, sig);
  const conv = prConversation({ comments, reviews, threads });
  if (!conv.entries.length && !conv.bots.length) return null;
  const jump = () => {
    const el = conv.firstUnresolved ? document.getElementById(`conv-${conv.firstUnresolved}`) : null;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <VCard slot="pr-conversation" title="Conversation">
      <div className="text-muted-foreground flex min-h-9 items-center justify-between gap-3 border-b px-4 py-1.5 text-xs">
        <span data-slot="conversation-summary">{conversationSummary(conv.counts)}</span>
        {conv.firstUnresolved && <Button size="sm" variant="ghost" className="h-7 text-xs" data-slot="jump-unresolved" onClick={jump}>Jump to unresolved</Button>}
      </div>
      <ul className="divide-y">
        {conv.bots.length > 0 && <BotGroup bots={conv.bots} />}
        {conv.entries.map((e) => <EntryRow key={e.id} e={e} />)}
      </ul>
    </VCard>
  );
}
