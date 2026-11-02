import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ExternalLink, MessageSquare } from "lucide-react";
import { StatusDot, VCard } from "@/components/console";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useReviewDigest, type Row } from "../store";
import { ago, type Reviewer, type ReviewerStatus, type ReviewItem } from "../workstream";

// The review SIGNAL on a PR, not just its state: who approved, how many review threads still ask
// for a change, and whether an AI reviewer flagged something severe (list row), plus the human and
// severe comments themselves (PR page). All of it is workstream.reviewDigest over one lazily
// fetched gh.reviewSignal per PR (store.useReviewDigest).

/** What makes the cached digest stale: the PR's review state or its feedback count moved. */
export const reviewSig = (row: Pick<Row, "reviewStatus" | "feedback">) => `${row.reviewStatus ?? ""}|${row.feedback?.length ?? 0}`;

const initials = (login: string) => login.replace(/\[bot\]$/, "").split(/[-_.]/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";

/** The account's GitHub profile picture: `LOGIN.png` needs no token and no API call (same formula
 *  as server/repos.ts's avatarUrl, kept separate since the web bundle must not import server code). */
const avatarUrl = (login: string) => `https://github.com/${login}.png?size=40`;

const STATUS_LABEL: Record<ReviewerStatus, string> = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", COMMENTED: "Commented" };
const STATUS_RANK: Record<ReviewerStatus, number> = { CHANGES_REQUESTED: 0, APPROVED: 1, COMMENTED: 2 };
const STATUS_RING: Record<ReviewerStatus, string> = { APPROVED: "ring-geist-green/60", CHANGES_REQUESTED: "ring-geist-red/60", COMMENTED: "ring-border" };
const STATUS_FALLBACK: Record<ReviewerStatus, string> = {
  APPROVED: "bg-geist-green/15 text-geist-green", CHANGES_REQUESTED: "bg-geist-red/15 text-geist-red", COMMENTED: "bg-muted text-muted-foreground",
};

/** Changes requested first (it is what blocks progress most, same priority as elsewhere), then
 *  approved, then a plain comment. */
const byStatus = (list: Reviewer[]) => [...list].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);

function ReviewerAvatar({ reviewer }: { reviewer: Reviewer }) {
  return (
    <Avatar data-slot="reviewer-avatar" data-status={reviewer.status} className={`ring-card size-5 ring-2 ${STATUS_RING[reviewer.status]}`}>
      <AvatarImage src={avatarUrl(reviewer.login)} alt="" />
      <AvatarFallback className={`text-[9px] font-semibold ${STATUS_FALLBACK[reviewer.status]}`}>{initials(reviewer.login)}</AvatarFallback>
    </Avatar>
  );
}

/** One reviewer row inside the hover card: picture, login, and their state — grouped by state via
 *  `byStatus`, so changes-requested reviewers lead. */
function ReviewerRow({ reviewer }: { reviewer: Reviewer }) {
  return (
    <li data-slot="reviewer-row" data-status={reviewer.status} className="flex items-center gap-2 px-3 py-2 text-sm">
      <ReviewerAvatar reviewer={reviewer} />
      <span className="min-w-0 flex-1 truncate font-medium">{reviewer.login}</span>
      <span className="text-muted-foreground text-xs whitespace-nowrap">{STATUS_LABEL[reviewer.status]}</span>
    </li>
  );
}

/** The overlapping avatar stack for the people who approved, requested changes or commented on a
 *  PR. Hovering or focusing the GROUP opens a `HoverCard` listing every reviewer with their state,
 *  grouped by state. A `HoverCard` ignores touch by design (it must not fight a tap meant for
 *  something else) — there is nothing else to tap here, so a tap on a touch screen opens or closes
 *  it itself (the same `lastPointer` trick the Agents list uses for its own touch/mouse split). The
 *  open/closed decision is read in `onPointerDown`, BEFORE the click: a second tap lands outside the
 *  content from the DismissableLayer's own point of view, which closes the card first — reading
 *  `open` again inside `onClick` would see that already-closed state and reopen it. */
function ReviewerAvatars({ reviewers: list }: { reviewers: Reviewer[] }) {
  const [open, setOpen] = useState(false);
  const lastPointer = useRef("mouse");
  const wasOpen = useRef(false);
  const sorted = byStatus(list);
  const shown = sorted.slice(0, 3);
  const extra = sorted.length - shown.length;
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>
        <span data-slot="reviewer-avatars" tabIndex={0} aria-label={`${sorted.length} reviewer${sorted.length === 1 ? "" : "s"}`}
          onPointerDown={(e: ReactPointerEvent) => { lastPointer.current = e.pointerType; wasOpen.current = open; }}
          onClick={(e) => {
            // Never opens the row — same rule as the subline's own "+N" chip. On a mouse the
            // hover already opens/closes the card; on touch (ignored by a HoverCard by design)
            // a tap is the only way in, so it opens or closes the card itself.
            e.stopPropagation();
            if (lastPointer.current !== "mouse") setOpen(!wasOpen.current);
          }}
          className="inline-flex shrink-0 items-center outline-none">
          <span className="flex -space-x-1">{shown.map((r) => <ReviewerAvatar key={r.login} reviewer={r} />)}</span>
          {extra > 0 && <span className="text-muted-foreground ml-1 text-[10px]">+{extra}</span>}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-56 p-0">
        <ul data-slot="reviewer-list" className="divide-y">{sorted.map((r) => <ReviewerRow key={r.login} reviewer={r} />)}</ul>
      </HoverCardContent>
    </HoverCard>
  );
}

const SEVERITY_CLASS: Record<string, string> = {
  critical: "border-geist-red/40 text-geist-red",
  warning: "border-geist-warning-fg/40 text-geist-warning-fg",
};

/** The list row's compact cluster: the reviewer avatar group, then a count-then-icon `MessageSquare`
 *  chip for unresolved threads — coloured by the AI reviewer's worst severity when it flagged
 *  anything, muted otherwise — and a separate plain `MessageSquare` count for human comments (the
 *  colour is what tells the two apart, not the icon). Hovering (or focusing) the unresolved chip
 *  opens a `HoverCard` showing the same `ReviewPanel` as the agent page's Review card, rather than
 *  a plain title tooltip. Renders nothing until the digest has loaded. */
export function ReviewCluster({ row }: { row: Row }) {
  const d = useReviewDigest(row.repo, row.prNumber, reviewSig(row));
  if (!d) return null;
  const { count } = d.unresolved;
  if (!d.reviewers.length && !count && !d.worst && !d.human.length) return null;
  return (
    <span data-slot="review-cluster" className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
      {d.reviewers.length > 0 && <ReviewerAvatars reviewers={d.reviewers} />}
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
