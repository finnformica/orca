import { ExternalLink, MessageSquare, MessagesSquare } from "lucide-react";
import { StatusDot, VCard } from "@/components/console";
import { useReviewDigest, type Row } from "../store";
import { ago, type ReviewDigest, type ReviewItem } from "../workstream";

// The review SIGNAL on a PR, not just its state: who approved, how many review threads still ask
// for a change, and whether an AI reviewer flagged something severe (list row), plus the human and
// severe comments themselves (PR page). All of it is workstream.reviewDigest over one lazily
// fetched gh.reviewSignal per PR (store.useReviewDigest).

/** What makes the cached digest stale: the PR's review state or its feedback count moved. */
export const reviewSig = (row: Pick<Row, "reviewStatus" | "feedback">) => `${row.reviewStatus ?? ""}|${row.feedback?.length ?? 0}`;

const initials = (login: string) => login.replace(/\[bot\]$/, "").split(/[-_.]/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";

function ApproverChip({ login }: { login: string }) {
  return (
    <span data-slot="approver" title={`Approved by ${login}`} aria-label={`Approved by ${login}`}
      className="bg-geist-green/15 text-geist-green ring-card inline-flex size-5 items-center justify-center rounded-full text-[9px] font-semibold ring-2">
      {initials(login)}
    </span>
  );
}

const severeTitle = (d: ReviewDigest) =>
  `AI reviewer flagged:\n${d.severe.map((i) => `${i.author ?? "bot"}: ${i.line}${i.kind !== "thread" ? " (summary comment)" : ""}`).join("\n")}`;

/** The unresolved chip's tooltip: the thread/nit count when there are any, the AI reviewer's
 *  findings when it flagged something severe (either, both, or — given the caller's guard — one). */
const unresolvedTitle = (d: ReviewDigest) => {
  const { count, nits } = d.unresolved;
  const parts: string[] = [];
  if (count > 0) parts.push(nits ? `${count} unresolved review threads (${nits} nit${nits === 1 ? "" : "s"})` : `${count} unresolved review threads`);
  if (d.worst) parts.push(severeTitle(d));
  return parts.join("\n\n");
};

const SEVERITY_CLASS: Record<string, string> = {
  critical: "border-geist-red/40 text-geist-red",
  warning: "border-geist-warning-fg/40 text-geist-warning-fg",
};

/** The list row's compact cluster: approver chips, then a `MessagesSquare` chip for unresolved
 *  threads — coloured by the AI reviewer's worst severity when it flagged anything, muted
 *  otherwise — and a separate plain `MessageSquare` count for human comments. Renders nothing
 *  until the digest has loaded. */
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
        <span data-slot="unresolved" data-severity={d.worst ?? undefined} title={unresolvedTitle(d)}
          aria-label={d.worst ? `AI reviewer flagged a ${d.worst}-severity comment` : `${count} unresolved review threads`}
          className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 text-[10px] leading-4 whitespace-nowrap ${d.worst ? SEVERITY_CLASS[d.worst] : "text-muted-foreground"}`}>
          <MessagesSquare className="size-2.5" />{count > 0 && count}
        </span>
      )}
      {d.human.length > 0 && (
        <span data-slot="human-comments" title={`${d.human.length} comment${d.human.length === 1 ? "" : "s"} from people`} className="text-muted-foreground inline-flex items-center gap-0.5 text-[10px]">
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
      {item.severity && <StatusDot tone={item.severity === "critical" ? "error" : "warning"} className="mt-1.5 size-2" title={item.severity} />}
      <div className="min-w-0 flex-1">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span className="text-foreground font-medium">{item.author ?? "unknown"}</span>
          {item.path && <code className="truncate">{item.path}</code>}
          <span>{ago(at)}</span>
          {item.url && <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-foreground" aria-label="Open on GitHub"><ExternalLink className="size-3" /></a>}
        </div>
        <div className="truncate" title={item.body}>{item.line}</div>
      </div>
    </li>
  );
}

/** The PR page's Review panel: approvals and the open-thread count, then the comments from people
 *  and the severe AI findings — the ones worth reading — ahead of the rest of the conversation. */
export function ReviewPanel({ repo, prNumber, sig }: { repo: string; prNumber: number; sig?: string }) {
  const d = useReviewDigest(repo, prNumber, sig);
  if (!d) return <p className="text-muted-foreground text-sm" data-slot="review-panel-loading">Loading review…</p>;
  const { count, nits } = d.unresolved;
  return (
    <VCard slot="review-panel" title="Review" aside={
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
    <div className="text-muted-foreground bg-background/60 px-4 py-2 text-xs font-medium">{title}</div>
    <ul className="divide-y border-t">{items.map((i) => <ItemLine key={i.id} item={i} />)}</ul>
  </div>
);
