import type { ReactNode } from "react";
import { Wrench } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { ActionButton } from "@/components/ActionButton";
import { StatusDot } from "@/components/console";
import { cn } from "@/lib/utils";
import { addressPr, modelFor, useCachedReviewDigest, type Row } from "../store";
import { modelBadge, rowStatus } from "../workstream";
import { TONE_DOT, TONE_LABEL } from "./Agents";

/** The agent status chip's hover card (Agents list, board card, agent page): WHY the status is what
 *  it is, line by line from `rowStatus` — the same derivation the label comes from — plus the one
 *  obvious next step. Same generic `HoverCard` as the review cluster's unresolved chip. The thread
 *  count is the review digest's cached value only, so a list of N rows fires no extra fetch. */
export function StatusHoverCard({ row, children, className = "gap-2" }: { row: Row; children: ReactNode; className?: string }) {
  const digest = useCachedReviewDigest(row.repo, row.prNumber);
  const model = modelBadge(row.agentMeta?.model, row.worktreePath || row.prNumber ? modelFor(row) : undefined)?.label;
  const s = rowStatus(row, { unresolved: digest?.unresolved.count, model });
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <span data-slot="status-trigger" tabIndex={0} aria-label={`Status: ${TONE_LABEL[s.tone]}. Show why.`} className={cn("inline-flex min-w-0 items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50", className)}>
          {children}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0" onClick={(e) => e.stopPropagation()}>
        <div data-slot="status-card" data-tone={s.tone}>
          <div className="flex items-center gap-2 border-b px-4 py-2.5 text-sm font-medium">
            <StatusDot tone={TONE_DOT[s.tone]} />{TONE_LABEL[s.tone]}
          </div>
          <ul className="space-y-1.5 px-4 py-3 text-[13px]">
            {s.reasons.map((r) => <li key={r} data-slot="status-reason" className="text-muted-foreground break-words">{r}</li>)}
          </ul>
          {s.action === "address" && (
            <div className="border-t px-4 py-2.5">
              <ActionButton size="sm" variant="default" onRun={() => addressPr(row)} label="Address PR"
                failure={{ action: "Address PR", title: row.title, repo: row.repo, branch: row.branch, prNumber: row.prNumber }}>
                <Wrench />Address PR
              </ActionButton>
            </div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
