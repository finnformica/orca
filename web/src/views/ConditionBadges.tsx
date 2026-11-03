// A PR's condition badges: changes requested, conflicts, mergeability and CI — plus, where asked
// for, auto-merge. `showAutoMerge` defaults to on (Board.tsx's card has no other auto-merge
// indicator); Agents.tsx turns it off, because the row's state pill right beside this already reads
// "Auto-merge" (Finn: it was shown twice).
import { Clock, GitMerge } from "lucide-react";
import type { Row } from "../store";
import { Badge } from "@/components/ui/badge";
import { Tip } from "@/components/ui/tip";
import { ago } from "../workstream";
import { CiChip } from "./PrPanels";

// `h-6` on every badge here: Badge's own height (border + py-0.5 + text-xs's line-height, ~22px) is
// 2px short of the state-pill beside it (console.tsx Pill, a fixed h-6/24px) — invisible until the
// two sit in the same row, where it reads as a size mismatch and a 1px vertical misalignment
// (border-box sizing keeps the border and padding; only the outer box grows to match).
export function ConditionBadges({ row, showAutoMerge = true }: { row: Row; showAutoMerge?: boolean }) {
  return (
    <>
      {row.prStaleAt !== undefined && <StaleBadge at={row.prStaleAt} />}
      {showAutoMerge && row.autoMergeEnabled && <Badge variant="outline" className="h-6 border-transparent bg-purple-500/10 text-purple-700 dark:text-purple-400">Auto-merge <GitMerge /></Badge>}
      {row.reviewStatus === "changes_requested" && <Badge variant="destructive" className="h-6">Changes requested</Badge>}
      {row.mergeable === "CONFLICTING" && <Badge variant="destructive" className="h-6">Conflicts</Badge>}
      {row.mergeable === "UNKNOWN" && <Badge variant="outline" className="h-6">Checking…</Badge>}
      <CiChip repo={row.repo} prNumber={row.prNumber} ciStatus={row.ciStatus} />
    </>
  );
}

/** The PR state's last sync is older than the normal interval (GitHub rate limited or down): its age. */
export function StaleBadge({ at, now = Date.now() }: { at: number; now?: number }) {
  return (
    <Tip label={`Orca last synced this PR from GitHub at ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`} wrap>
      <Badge variant="outline" data-testid="pr-stale" className="h-6 border-transparent bg-amber-500/10 text-amber-700 dark:text-amber-400"><Clock />Synced {ago(at, now)}</Badge>
    </Tip>
  );
}
