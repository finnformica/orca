import { ExternalLink, MessageSquare } from "lucide-react";
import { StatusDot, VCard } from "@/components/console";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useReviewDigest, type Row } from "../store";
import { ago, type ReviewItem } from "../workstream";

// The review SIGNAL on a PR, not just its state: who approved, how many review threads still ask
// for a change, and whether an AI reviewer flagged something severe (list row), plus the human and
// severe comments themselves (PR page). All of it is workstream.reviewDigest over one lazily
// fetched gh.reviewSignal per PR (store.useReviewDigest).

/** What makes the cached digest stale: the PR's review state or its feedback count moved. */
export const reviewSig = (row: Pick<Row, "reviewStatus" | "feedback">) => `${row.reviewStatus ?? ""}|${row.feedback?.length ?? 0}`;

const initials = (login: string) => login.replace(/\[bot\]$/, "").split(/[-_.]/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";

function ApproverChip({ login }: { login: string }) {
  return (
    <span data-slot="approver" aria-label={`Approved by ${login}`}
      className="bg-geist-green/15 text-geist-green ring-card inline-flex size-5 items-center justify-center rounded-full text-[9px] font-semibold ring-2">
      {initials(login)}
    </span>
  );
}

const SEVERITY_CLASS: Record<string, string> = {
  critical: "border-geist-red/40 text-geist-red",
  warning: "border-geist-warning-fg/40 text-geist-warning-fg",
};

/** The list row's compact cluster: approver chips, then a count-then-icon `MessageSquare` chip
 *  for unresolved threads — coloured by the AI reviewer's worst severity when it flagged
 *  anything, muted otherwise — and a separate plain `MessageSquare` count for human comments (the
 *  colour is what tells the two apart, not the icon). Hovering (or focusing) the unresolved chip
 *  opens a `HoverCard` showing the same `ReviewPanel` as the agent page's Review card, rather than
 *  a plain title tooltip. Renders nothing until the digest has loaded. */
export function ReviewCluster({ row }: { row: Row }) {
  const d = useReviewDigest(row.repo, row.prNumber, reviewSig(row));
  if (!d) return null;
  const { count } = d.unresolved;
  if (!d.approvers.length && !count && !d.worst && !d.human.length) return null;
  return (
    <span data-slot="review-cluster" className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
      {d.approvers.length > 0 && <span className="flex -space-x-1">{d.approvers.slice(0, 3).map((a) => <ApproverChip key={a} login={a} />)}</span>}
      {d.approvers.length > 3 && <span className="text-muted-foreground text-[10px]">+{d.approvers.length - 3}</span>}
      {(count > 0 || d.worst) && (
        <HoverCard>
          <HoverCardTrigger asChild>
            <span data-slot="unresolved" data-severity={d.worst ?? undefined} tabIndex={0}
              aria-label={d.worst ? `AI reviewer flagged a ${d.worst}-severity comment` : `${count} unresolved review threads`}
              className={`inline-flex h-4 items-center justify-center gap-1 rounded-full border px-1.5 text-[10px] leading-4 whitespace-nowrap outline-none ${d.worst ? SEVERITY_CLASS[d.worst] : "text-muted-foreground"}`}>
              {count > 0 && count}<MessageSquare className="size-2.5 shrink-0" />
            </span>
          </HoverCardTrigger>
          <HoverCardContent align="start" className="w-[28rem] max-w-[calc(100vw-2rem)] p-0">
            <ReviewPanel repo={row.repo} prNumber={row.prNumber!} sig={reviewSig(row)} className="border-none shadow-none" bodyClass="max-h-80 overflow-y-auto" />
          </HoverCardContent>
        </HoverCard>
      )}
      {d.human.length > 0 && (
        <span data-slot="human-comments" className="text-muted-foreground inline-flex items-center gap-0.5 text-[10px]">
          <MessageSquare className="size-2.5" />{d.human.length}
        </span>
      )}
    </span>
  );
}

function ItemLine({ item }: { item: ReviewItem }) {
  const at = item.createdAt ? Date.parse(item.createdAt) : 0;
  return (
    <li data-slot="review-item" data-kind={item.kind} className="flex items-start gap-2 px-4 py-2.5 text-sm">
      {item.severity && <StatusDot tone={item.severity === "critical" ? "error" : "warning"} className="mt-1.5 size-2" />}
      <div className="min-w-0 flex-1">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span className="text-foreground font-medium">{item.author ?? "unknown"}</span>
          {item.path && <code className="truncate">{item.path}</code>}
          <span>{ago(at)}</span>
          {item.url && <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-foreground" aria-label="Open on GitHub"><ExternalLink className="size-3" /></a>}
        </div>
        <div className="truncate">{item.line}</div>
      </div>
    </li>
  );
}

/** The PR page's Review panel: approvals and the open-thread count, then the comments from people
 *  and the severe AI findings — the ones worth reading — ahead of the rest of the conversation. */
export function ReviewPanel({ repo, prNumber, sig, className, bodyClass }: { repo: string; prNumber: number; sig?: string; className?: string; bodyClass?: string }) {
  const d = useReviewDigest(repo, prNumber, sig);
  if (!d) return <p className="text-muted-foreground text-sm" data-slot="review-panel-loading">Loading review…</p>;
  const { count, nits } = d.unresolved;
  return (
    <VCard slot="review-panel" title="Review" className={className} bodyClass={bodyClass} aside={
      <span className="text-muted-foreground text-xs">
        {d.approvers.length ? <>Approved by <span className="text-foreground">{d.approvers.join(", ")}</span></> : "No approvals yet"}
        {` · ${count} unresolved${nits ? ` (${nits} nit${nits === 1 ? "" : "s"})` : ""}`}
      </span>
    }>
      {d.severe.length > 0 && <ReviewSection title="Flagged by AI reviewers" items={d.severe} />}
      {d.human.length > 0 && <ReviewSection title="From people" items={d.human} />}
      {!d.severe.length && !d.human.length && <p className="text-muted-foreground px-4 py-3 text-sm">No human comments or severe AI findings.</p>}
    </VCard>
  );
}

/** A labelled run of divided rows inside the card — Vercel's grouped list, no box of its own. */
const ReviewSection = ({ title, items }: { title: string; items: ReviewItem[] }) => (
  <div className="border-b last:border-b-0">
    <div className="text-muted-foreground px-4 py-2 text-xs font-medium">{title}</div>
    <ul className="divide-y border-t">{items.map((i) => <ItemLine key={i.id} item={i} />)}</ul>
  </div>
);
