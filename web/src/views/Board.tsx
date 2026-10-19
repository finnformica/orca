// The Board view: the five lanes of workstream cards (Local → Draft → In Review → Mergeable →
// Done · today). Restored from before #333; shown only while the config's `ui.showBoard` is on.
import { useState, type ReactNode } from "react";
import { ThreadChips } from "@/components/SourceChip";
import { useAtom, useAtomValue } from "jotai";
import { densityAtom, repoFilterAtom } from "@/lib/atoms";
import type { ChangeSummary } from "../../../server/git";
import {
  baseBranch, cliCommand, instanceChoices, modelFor, rerunAgent, thisInstance, setCardModel,
  useWorkstreams, useWorkstreamsLoaded, type Lane, type Row,
} from "../store";
import { copyText } from "@/lib/dialogs";
import { navigate } from "@/lib/route";
import { Bot, Check, CircleStop, Copy, ExternalLink, Eye, Loader2, Play, Rows2, Rows3, SquareTerminal, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { QuickActionButtons, WorkstreamActions } from "./WorkstreamActions";
import { GrantNote, OrchStatusNote, Skeleton, UpkeepNote } from "@/components/console";
import { PreviewControl } from "./PreviewControl";
import { StatusHoverCard } from "./StatusCard";
import { TerminalDialog } from "@/components/Terminal";
import { ModelPicker } from "@/components/ModelPicker";
import { Tip } from "@/components/ui/tip";
import { CopyDone, LaneActions } from "./BulkActions";
import { ConditionBadges } from "./ConditionBadges";
import { NewDraft } from "./NewDraft";
import { useSummary, useTerminalOpen } from "@/lib/workstreamHooks";

/** The Board page (`/board`): the heading with the density toggle, then the lanes. */
export function BoardPage() {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-heading text-2xl font-semibold tracking-tight">Board</h1>
        <DensityToggle />
      </div>
      <Board />
    </div>
  );
}

// Flip every (non-Done) card between the full card and a status-only dense one.
function DensityToggle() {
  const [density, setDensity] = useAtom(densityAtom);
  const dense = density === "dense";
  const label = dense ? "Switch to comfortable view" : "Switch to dense view";
  return (
    <Button size="icon" variant="outline" className="size-8" aria-pressed={dense} onClick={() => setDensity(dense ? "comfortable" : "dense")} aria-label={label}>
      {dense ? <Rows2 className="size-4" /> : <Rows3 className="size-4" />}
    </Button>
  );
}

const LANES: { lane: Lane; title: string }[] = [
  { lane: "LOCAL", title: "Local" },
  { lane: "DRAFT", title: "Draft" },
  { lane: "IN_REVIEW", title: "In Review" },
  { lane: "MERGEABLE", title: "Mergeable" },
  { lane: "DONE", title: "Done · today" },
];

// How many placeholder cards to show per lane while the first agents+PRs refresh is in flight.
const SKELETON_CARDS = 2;

export function Board() {
  const all = useWorkstreams();
  const loaded = useWorkstreamsLoaded();
  const filter = useAtomValue(repoFilterAtom);
  const rows = filter === "all" ? all : all.filter((r) => r.repo === filter);
  const cardsFor = (lane: Lane) => {
    const cards = rows.filter((r) => r.lane === lane);
    if (lane === "DONE") cards.sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? "")); // recent first
    return cards;
  };

  return (
    <div className="grid grid-cols-1 gap-3 md:h-[calc(100dvh-6.5rem)] md:grid-cols-3 xl:grid-cols-5">
      {LANES.map(({ lane, title }) => {
        const cards = cardsFor(lane);
        return (
          <div key={lane} className="bg-muted/30 flex flex-col overflow-hidden rounded-lg border">
            <h3 className="text-muted-foreground flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs font-semibold tracking-wide uppercase">
              {title} {loaded ? <span className="opacity-60">{cards.length}</span> : <Skeleton className="h-3 w-3" />}
              {lane === "DONE" && cards.length > 0 && <CopyDone cards={cards} />}
              <LaneActions lane={lane} cards={cards} />
            </h3>
            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {/* Pin the new-draft box to the top of the (scrolling) Local column so it stays reachable
                  no matter how many sessions pile up below. The backdrop full-bleeds over the column's
                  p-2 (negative margins on top+sides) and `-top-2` cancels the padding gap that
                  otherwise lets a card peek above a `top-0` sticky — so cards scroll cleanly *under* the
                  bar. It must be OPAQUE to hide those cards, but the column itself is a translucent
                  `bg-muted/30`; an opaque `bg-background` base with the same `bg-muted/30` tint layered
                  on top composites to the exact column colour, so the bar is seamless instead of a
                  lighter band. `p-2` keeps equal padding around the composer on all four sides. */}
              {lane === "LOCAL" && (
                <div className="bg-background sticky -top-2 z-20 -mx-2 -mt-2">
                  <div className="bg-muted/30 p-2">
                    <NewDraft />
                  </div>
                </div>
              )}
              {!loaded
                ? Array.from({ length: SKELETON_CARDS }, (_, i) => <WorkstreamCardSkeleton key={i} />)
                : cards.map((r) => <WorkstreamCard key={r.repo + r.branch} row={r} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A `WorkstreamCard`-shaped placeholder, so the board doesn't reflow once the real cards land. */
function WorkstreamCardSkeleton() {
  return (
    <div data-slot="workstream-card-skeleton" className="bg-card flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-10" />
      </div>
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3 w-full" />
      <div className="flex items-center gap-1.5 border-t pt-2.5">
        <Skeleton className="h-7 w-7 rounded-md" />
        <Skeleton className="h-7 flex-1 rounded-md" />
      </div>
    </div>
  );
}

const Eyebrow = ({ repo }: { repo: string }) => (
  <div className="text-muted-foreground min-w-fit text-[10px] font-semibold tracking-widest uppercase">{repo}</div>
);

// External destination link (opens elsewhere) — labelled + trailing arrow so it reads as "go there",
// distinct from the action buttons in the footer.
const DestLink = ({ href, children }: { href?: string; children: ReactNode }) => (
  <a className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 text-xs" href={href} target="_blank" rel="noreferrer">
    {children} <ExternalLink className="size-3" />
  </a>
);

// Copy icon (top-right) → a small dropdown of copy-to-clipboard actions: the PR link (only once
// there's a PR), the worktree name, and "Copy CLI" — the terminal command to resume the agent's
// session in that worktree (ensures a worktree exists first). All the grab-and-go affordances live
// here, off the card face, so the header stays uncluttered.
export function CopyMenu({ row }: { row: Row }) {
  const [copied, setCopied] = useState(false);
  const flash = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const copy = (text: string, label: string) => {
    void copyText(text, label).then((ok) => { if (ok) flash(); });
  };
  // Copy CLI adopts a worktree if needed, resumes the pinned agent's session when it last ran here,
  // or (on a model switch) seeds a fresh interactive session with the portable transcript.
  const copyCli = async () => {
    const cmd = await cliCommand(row);
    if (await copyText(cmd, "CLI command")) flash();
  };
  return (
    <DropdownMenu>
      <Tip label="Copy…">
        <DropdownMenuTrigger asChild>
          <button type="button" data-slot="copy-menu-trigger" className="text-muted-foreground hover:text-foreground">
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end">
        {row.prUrl && <DropdownMenuItem onSelect={() => copy(row.prUrl!, "PR link")}>Copy PR link</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => copy(row.branch, "worktree name")}>Copy worktree name</DropdownMenuItem>
        {/* Local worktrees only: the command cds into a path that exists on the machine that RUNS
            the repo, so offering it for a session on another instance would hand you a dead path. */}
        {!row.remote && (
          <Tip label="Resume this agent's session in a terminal" side="right">
            <DropdownMenuItem onSelect={() => void copyCli()}>Copy CLI</DropdownMenuItem>
          </Tip>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Coloured diffstat: green additions, red deletions, then the file count.
function Diffstat({ summary }: { summary: ChangeSummary }) {
  return (
    <div>
      <span className="text-emerald-700 dark:text-emerald-400">+{summary.additions}</span>
      {" / "}
      <span className="text-destructive">−{summary.deletions}</span>
      {" · "}{summary.files.length} files
    </div>
  );
}

// The card's model, as a hover-reveal picker. At rest it reads as plain text ("Claude · Fable 5.1");
// choosing re-pins the card so every action — Follow up, Address PR — runs on it (store.setCardModel
// / modelFor). The tooltip names the last run's model when it differs. stopPropagation keeps a click
// from bubbling to the card's row navigation.
export function CardModelPicker({ row }: { row: Row }) {
  return <ModelPicker quiet label="Model for this card" value={modelFor(row)} ran={row.agentMeta?.model} onChange={(m) => setCardModel(row, m)} />;
}

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function elapsed(startedMs?: number): string {
  if (!startedMs) return "";
  const s = Math.floor((Date.now() - startedMs) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function AgentBadge({ row, hasWork }: { row: Row; hasWork: boolean }) {
  const s = row.agentStatus ?? "idle";
  if (s === "running") return <Badge variant="secondary">Running {elapsed(row.agentStartedAt)} <Loader2 className="animate-spin" /></Badge>;
  // Orca's own check over the run's commit beats the agent's word: "Verified" only when it passed.
  if (s === "done" && row.agentCheck) {
    return row.agentCheck.ok
      ? <Badge variant="success">Verified <Check /></Badge>
      : <Badge variant="destructive">Check failed <X /></Badge>;
  }
  if (s === "done") return <Badge variant="success">Done <Check /></Badge>;
  if (s === "error") return <Badge variant="destructive">Error <X /></Badge>;
  // idle = no live/tracked run. If it committed work it's completed; if not, it's stopped.
  return hasWork ? <Badge variant="success">Completed <Check /></Badge> : <Badge variant="destructive">Stopped <CircleStop /></Badge>;
}

// One card for every lane. Sections switch on whether the row has an open PR / is done /
// is a draft, but the shell, header, and styling are shared.
export function WorkstreamCard({ row }: { row: Row }) {
  const isDone = row.lane === "DONE";
  const isOpenPr = Boolean(row.prNumber) && !isDone;
  const isLocal = !row.prNumber && !isDone; // draft or local (no-remote) branch
  // Dense view strips the card to its at-a-glance status (kept: repo, title, smaller status/condition
  // badges) plus a single toolbar row of icon buttons (Test locally, Follow up, Merge, Actions) so it
  // stays driveable; the prompt and diffstat are dropped. Done cards stay compact — they never densify.
  const dense = useAtomValue(densityAtom) === "dense" && !isDone;

  const summary = useSummary(row);
  const hasWork = (summary?.commits.length ?? 0) > 0;

  // Card-level busy: any action (from WorkstreamActions or the Run button) dims the card and shows
  // a spinner, so a multi-second op (promote push + PR create, merge, …) doesn't look frozen.
  const [busy, setBusy] = useState(false);
  const runBusy = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };

  const [terminalOpen, setTerminalOpen] = useTerminalOpen(row);

  // The title links to this workstream's detail view (PR or local session).
  const titleTo = isOpenPr ? `/${row.repo}/prs/${row.prNumber}`
    : isLocal ? `/${row.repo}/local/${encodeURIComponent(row.branch)}`
    : row.prNumber ? `/${row.repo}/prs/${row.prNumber}` : null; // done: link to the merged PR

  return (
    <div className={`bg-card relative flex flex-col rounded-lg border ${dense ? "gap-1 p-2" : "gap-2 p-3"} ${busy ? "pointer-events-none" : ""}`} aria-busy={busy}>
      {busy && (
        <div className="bg-card/60 absolute inset-0 z-10 flex items-center justify-center rounded-lg">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      )}
      {/* Meta strip: repo (index tab) on the left, "open elsewhere" destinations on the right. */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <Eyebrow repo={row.repo} />
          {row.orchestrated && (
            <Tip label="Started or continued by the orchestrator, which hears when its agent finishes">
              <span aria-label="Orchestrated">
                <Bot className="text-muted-foreground size-3" />
              </span>
            </Tip>
          )}
          {/* One chip per integration this workstream has a thread on (Slack, Discord, email…). */}
          <ThreadChips repo={row.repo} branch={row.branch} />
          {/* Where the worktree lives, once there is more than one place it could. */}
          {instanceChoices().length > 1 && row.worktreePath && (
            <span data-slot="instance-chip" className="text-muted-foreground rounded border px-1 text-[9px] leading-4 tracking-wider uppercase">
              {row.instance ?? thisInstance()}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {row.previewUrl && <DestLink href={row.previewUrl}>Preview</DestLink>}
          {row.prNumber && <DestLink href={row.prUrl}>PR #{row.prNumber}</DestLink>}
          <CopyMenu row={row} />
        </div>
      </div>

      {/* Identity: the title anchors the card; prompt is supporting context. */}
      <div className="space-y-0.5">
        {titleTo ? (
          <button type="button" onClick={() => navigate(titleTo)} className="text-foreground block w-full truncate text-left text-sm font-medium hover:underline">
            {row.title}
          </button>
        ) : (
          <div className="truncate text-sm font-medium">{row.title}</div>
        )}
        {!dense && row.prompt && <p className="text-muted-foreground line-clamp-2 text-xs">{row.prompt}</p>}
        <OrchStatusNote status={row.orchStatus} />
        <GrantNote grant={row.grantScope} />
        <UpkeepNote upkeep={row.upkeep} running={row.agentStatus === "running"} />
      </div>

      {/* State: agent status leads (standardised across lanes), then Run, then condition badges.
          Local cards always show it (each is an agent session); PR cards only when a run is live/recent. */}
      {!isDone && (
        <div className={`flex flex-wrap items-center gap-1 ${dense ? "[&_[data-slot=badge]]:px-1.5 [&_[data-slot=badge]]:py-0 [&_[data-slot=badge]]:text-[10px] [&_[data-slot=badge]_svg]:size-2.5" : ""}`}>
          {isOpenPr && row.following && (
            <Tip label="Orca is watching this PR and auto-runs the agent to resolve conflicts, fix CI, or address review comments.">
              <Badge variant="outline" className="border-transparent bg-sky-500/10 text-sky-700 dark:text-sky-400">
                Following <Eye />
              </Badge>
            </Tip>
          )}
          {(isLocal || (row.agentStatus && row.agentStatus !== "idle")) && <StatusHoverCard row={row}><AgentBadge row={row} hasWork={hasWork} /></StatusHoverCard>}
          {isLocal && row.worktreePath && row.agentStatus !== "running" && (
            <button type="button" onClick={() => void runBusy(() => rerunAgent(row))} className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-5 items-center justify-center rounded">
              <Play className="size-3" />
            </button>
          )}
          {isOpenPr && <ConditionBadges row={row} />}
          {isLocal && row.mergeClean === "conflict" && <Badge variant="destructive">Conflicts with {baseBranch(row.repo)}</Badge>}
        </div>
      )}

      {/* The run's error text, on the card itself — the Error badge alone only surfaced it on hover,
          so a failed run (e.g. a CLI arg error) looked like a bare red badge with no way to see why.
          Clamped like the prompt above. */}
      {!isDone && row.agentStatus === "error" && row.agentError && (
        <p className="text-destructive line-clamp-2 text-xs break-words whitespace-pre-wrap">
          {row.agentError}
        </p>
      )}

      {/* Detail: file changes + the card's agent picker, justified to opposite ends. All lanes but
          Done. (The worktree/branch name is dropped as visual noise — copy it from the top-right menu.) */}
      {!isDone && !dense && (
        <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
          {summary ? (
            <Diffstat summary={summary} />
          ) : isLocal ? (
            <div>no changes yet</div>
          ) : <div />}
          {(row.agentMeta || row.agentProvider || row.worktreePath || row.prNumber) && <CardModelPicker row={row} />}
        </div>
      )}
      {isDone && <div className="text-muted-foreground text-xs">merged {timeAgo(row.mergedAt)}</div>}

      {/* Preview + actions, below a divider — separated from the session info above. Comfortable
          stacks the full-width Test-locally control over the labelled verbs; dense folds every verb
          (Test locally, Follow up, Merge, Actions) into one row of icon buttons. */}
      {!isDone && (
        <div className={`space-y-2 border-t ${dense ? "pt-1.5" : "pt-2.5"}`}>
          {dense ? (
            // Dense folds every verb into one icon row; keep the terminal button beside the (compact)
            // Test-locally control by slotting both into the leading slot.
            <WorkstreamActions
              row={row}
              hasWork={hasWork}
              onBusy={setBusy}
              compact
              leading={
                <>
                  <PreviewControl row={row} compact />
                  <Button size="icon" variant="ghost" className="size-7" onClick={() => setTerminalOpen(true)} aria-label="Open terminal">
                    <SquareTerminal className="size-3.5" />
                  </Button>
                </>
              }
            />
          ) : (
            <>
              <div className="flex items-start gap-2">
                <QuickActionButtons row={row} hasWork={hasWork} onBusy={setBusy} className="shrink-0" />
                <div className="min-w-0 flex-1"><PreviewControl row={row} /></div>
                <Button size="sm" variant="outline" className="shrink-0" onClick={() => setTerminalOpen(true)} aria-label="Open terminal">
                  <SquareTerminal className="size-3.5" />
                </Button>
              </div>
              <WorkstreamActions row={row} hasWork={hasWork} onBusy={setBusy} quick={false} />
            </>
          )}
          <TerminalDialog row={row} open={terminalOpen} onClose={() => setTerminalOpen(false)} />
        </div>
      )}
    </div>
  );
}
