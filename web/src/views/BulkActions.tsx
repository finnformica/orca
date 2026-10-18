// The Agents list's bulk verbs for the lane its chips narrow to, and Copy for today's merged work.
import { useState } from "react";
import { Check, Copy, Loader2, MoreHorizontal } from "lucide-react";
import {
  addPreviewLabel, addressPr, autoMerge, closePr, convertToDraft, disableAutoMerge, discardDraft, markReady, merge, promote,
  resolveConflicts, sendSlack, staleHours, testLocally, toggleFollow, type Lane, type Row,
} from "../store";
import { BULK_GROUPS, BULK_IRREVERSIBLE, BULK_LABELS, bulkActions, bulkCopyText, type BulkAction } from "../workstream";
import { confirmDialog, copyText } from "@/lib/dialogs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tip";

// Copies today's completed work as a shareable markdown list (scoped by the active repo filter,
// since `cards` is already filtered). Handy for standups / status posts.
export function CopyDone({ cards }: { cards: Row[] }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = cards.map((c) => `- ${c.title}${c.prNumber ? ` (#${c.prNumber})` : ""}${c.prUrl ? ` — ${c.prUrl}` : ""}`).join("\n");
    if (await copyText(`Completed today:\n${text}`, "completed work")) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <Tip label="Copy completed work (respects the repo filter)">
      <button type="button" onClick={copy} className="hover:text-foreground ml-auto inline-flex items-center gap-1 normal-case">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </Tip>
  );
}

// Every bulk verb is literally the per-card action, applied to each eligible card — no bulk-specific
// server path, so a lane action behaves exactly like running it on each card one by one.
// `copyLink` is the exception: it's aggregate (one clipboard write for the whole lane), so it has no
// per-card runner and is handled in `run` below.
const BULK_RUN: Record<Exclude<BulkAction, "copyLink">, (row: Row) => Promise<unknown>> = {
  testLocally,
  promote: (row) => promote(row),
  promoteDraft: (row) => promote(row, { draft: true }),
  promoteReady: (row) => promote(row, { draft: false }),
  markReady,
  moveToDraft: convertToDraft,
  resolveConflicts, // LOCAL lane only
  addressPr: (row) => addressPr(row),
  slackNotify: (row) => sendSlack(row, "notify"),
  slackBump: (row) => sendSlack(row, "bump"),
  autoMerge,
  disableAutoMerge,
  // Eligibility already picked the rows facing the right way, so the per-card toggle is the verb.
  follow: async (row) => toggleFollow(row),
  unfollow: async (row) => toggleFollow(row),
  addPreview: async (row) => addPreviewLabel(row),
  merge,
  closePr,
  discard: discardDraft,
};

// The lane's ⋯ menu: run one action across every card in the lane that can take it. The menu is
// state-gated (workstream.bulkActions), so it only lists work that actually exists and each item
// says how many cards it will hit.
export function LaneActions({ lane, cards }: { lane: Lane; cards: Row[] }) {
  const [busy, setBusy] = useState<BulkAction | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const groups = bulkActions(lane, cards, { nowMs: Date.now(), staleHours: staleHours() });
  if (groups.length === 0) return null;

  const run = async (action: BulkAction, rows: Row[]) => {
    const label = BULK_LABELS[action];
    // Copy is a clipboard read-out, not a fleet of mutations — no confirm, nothing to fail per card.
    if (action === "copyLink") {
      const text = bulkCopyText(rows);
      await copyText(text, "PR links"); setErr(null);
      return;
    }
    const irreversible = BULK_IRREVERSIBLE.includes(action);
    const cards = `${rows.length} card${rows.length === 1 ? "" : "s"}`;
    if (!(await confirmDialog({
      title: `${label} on ${cards}?`,
      description: `Run ${label.toLowerCase()} on ${cards} in ${lane.replace("_", " ").toLowerCase()}.${irreversible ? " You cannot undo this." : ""}`,
      confirmLabel: label, destructive: action === "closePr" || action === "discard",
    }))) return;
    setBusy(action); setErr(null);
    // Sequential on purpose: each action shells out to git/gh (and may adopt a worktree or launch an
    // agent), so firing a whole lane at once would race on adoption and hammer the API.
    const failed: string[] = [];
    for (const row of rows) {
      try { await BULK_RUN[action](row); } catch { failed.push(row.branch); }
    }
    setBusy(null);
    setErr(failed.length ? `${label} failed on ${failed.join(", ")}` : null);
  };

  const item = ({ action, rows }: { action: BulkAction; rows: Row[] }) => (
    <DropdownMenuItem key={action} disabled={Boolean(busy)} onSelect={() => void run(action, rows)} className="normal-case">
      {BULK_LABELS[action]} <span className="text-muted-foreground ml-auto pl-2">{rows.length}</span>
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu>
      <Tip label={err ?? "Bulk actions for this lane"}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Bulk actions"
            className={`ml-auto ${err ? "text-destructive" : "hover:text-foreground"}`}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-3.5" />}
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end">
        {/* Grouped verbs (PR / Agent / Slack) collapse into one submenu, rendered where the first of
            the group falls in the lane's order; everything else is a flat item. */}
        {groups.map((group) => {
          const name = BULK_GROUPS[group.action];
          if (!name) return item(group);
          const members = groups.filter((g) => BULK_GROUPS[g.action] === name);
          if (group !== members[0]) return null;
          return (
            <DropdownMenuSub key={name}>
              <DropdownMenuSubTrigger className="normal-case">{name}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>{members.map(item)}</DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
