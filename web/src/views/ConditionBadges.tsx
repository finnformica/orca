// A PR's condition badges: auto-merge, changes requested, conflicts, mergeability and CI.
import { GitMerge } from "lucide-react";
import type { Row } from "../store";
import { Badge } from "@/components/ui/badge";
import { CiChip } from "./PrPanels";

// `h-6` on every badge here: Badge's own height (border + py-0.5 + text-xs's line-height, ~22px) is
// 2px short of the state-pill beside it (console.tsx Pill, a fixed h-6/24px) — invisible until the
// two sit in the same row, where it reads as a size mismatch and a 1px vertical misalignment
// (border-box sizing keeps the border and padding; only the outer box grows to match).
export function ConditionBadges({ row }: { row: Row }) {
  return (
    <>
      {row.autoMergeEnabled && <Badge variant="outline" className="h-6 border-transparent bg-purple-500/10 text-purple-700 dark:text-purple-400">Auto-merge <GitMerge /></Badge>}
      {row.reviewStatus === "changes_requested" && <Badge variant="destructive" className="h-6">Changes requested</Badge>}
      {row.mergeable === "CONFLICTING" && <Badge variant="destructive" className="h-6">Conflicts</Badge>}
      {row.mergeable === "UNKNOWN" && <Badge variant="outline" className="h-6">Checking…</Badge>}
      <CiChip repo={row.repo} prNumber={row.prNumber} ciStatus={row.ciStatus} />
    </>
  );
}
