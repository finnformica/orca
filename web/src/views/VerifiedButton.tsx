// The user's hand-set Verified marker on an open PR: "I tested it, ask a coworker to approve".
// Only a marker on the board (store.setVerified) — it merges nothing and posts nothing to GitHub.
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { setVerified, type Row } from "../store";
import { verifiedState, verifiedTip } from "../workstream";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/utils";

/** Where the button can show: an open PR that is ready for review. */
export const canVerify = (row: Pick<Row, "prNumber" | "isDraft" | "lane">) => Boolean(row.prNumber) && !row.isDraft && row.lane !== "DONE";

/** One toggle. No mark: "Verify". A fresh mark: "Verified", a click clears it. A mark on an older
 *  head: "Changed since verified", a click verifies the new head. `icon` draws it icon-only (the
 *  agent page header), its state in the tooltip. */
export function VerifiedButton({ row, icon = false, className }: { row: Row; icon?: boolean; className?: string }) {
  if (!canVerify(row)) return null;
  const state = verifiedState(row.verified, row.prHead, row.prNumber);
  const label = state === "verified" ? "Verified" : state === "changed" ? "Changed since verified" : "Verify";
  const tip = row.verified && state
    ? `${verifiedTip(row.verified, state, row.prHead)} ${state === "verified" ? "Click to clear." : "Click to verify the new head."}`
    : "Mark verified: you tested this PR yourself. Only a marker on your board.";
  const Icon = state === "changed" ? ShieldAlert : ShieldCheck;
  const tone = state === "verified" ? "bg-geist-teal/20 text-teal-700 hover:bg-geist-teal/30 dark:text-teal-300"
    : state === "changed" ? "bg-geist-amber/15 text-geist-warning-fg hover:bg-geist-amber/25" : "";
  return (
    <Tip label={tip}>
      <Button type="button" variant={state ? "ghost" : "outline"} size={icon ? "icon" : "sm"} data-slot="verified-button" data-state={state ?? "none"}
        aria-pressed={state === "verified"} aria-label={label}
        className={cn(icon ? "size-8" : "h-6 gap-1 px-2 text-xs", tone, className)}
        onClick={() => setVerified(row, state !== "verified")}>
        <Icon className={icon ? "size-4" : "size-3"} />
        {!icon && label}
      </Button>
    </Tip>
  );
}

/** The read-only marker beside a workstream's title (the Agents rows, the Board cards): only an open
 *  PR marked verified on its current head. Icon only, sized to sit inline with the title text; the
 *  tooltip (who and when) and the aria-label carry what the dropped label text used to show. Set and
 *  clear it with VerifiedButton or the ⋯ menu. */
export function VerifiedBadge({ row }: { row: Row }) {
  if (!canVerify(row) || !row.verified || verifiedState(row.verified, row.prHead, row.prNumber) !== "verified") return null;
  return (
    <Tip label={verifiedTip(row.verified, "verified", row.prHead)} className="shrink-0">
      <ShieldCheck data-slot="verified-badge" aria-label="Verified" className="size-3.5 shrink-0 text-teal-700 dark:text-teal-300" />
    </Tip>
  );
}
