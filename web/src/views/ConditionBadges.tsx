// A PR's condition badges: auto-merge, changes requested, conflicts, mergeability and CI.
import { GitMerge } from "lucide-react";
import type { Row } from "../store";
import { Badge } from "@/components/ui/badge";
import { CiChip } from "./PrPanels";

export function ConditionBadges({ row }: { row: Row }) {
  return (
    <>
      {row.autoMergeEnabled && <Badge variant="outline" className="border-transparent bg-purple-500/10 text-purple-700 dark:text-purple-400">Auto-merge <GitMerge /></Badge>}
      {row.reviewStatus === "changes_requested" && <Badge variant="destructive">Changes requested</Badge>}
      {row.mergeable === "CONFLICTING" && <Badge variant="destructive">Conflicts</Badge>}
      {row.mergeable === "UNKNOWN" && <Badge variant="outline">Checking…</Badge>}
      <CiChip repo={row.repo} prNumber={row.prNumber} ciStatus={row.ciStatus} />
    </>
  );
}
