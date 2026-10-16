// The agent page — Vercel's single-deployment page, adapted, shared by the PR page and the local-
// session page. A Details card (the failure box where Vercel shows "Build Failed", else the agent's
// last outcome; then Created / Status / Duration / State, Model / Instance / PR / Preview, and the
// Source: branch → base and the latest commit) on Overview; the conversation lives on its own Chat
// tab — exactly the viewport below the header and tabs, no card, no page scroll.
import type { ReactNode } from "react";
import { AlertTriangle, ExternalLink, GitBranch, GitCommitHorizontal, GitPullRequest } from "lucide-react";
import type { ChangeSummary } from "../../../server/git";
import { baseBranch, instanceChoices, modelFor, thisInstance, type Row } from "../store";
import { agentFailure, ago, formatDuration, prPill, rowDuration, rowInstance, rowTone } from "../workstream";
import { modelLabel } from "../../../shared/models";
import { Detail, Pill, StatusDot, VCard } from "@/components/console";
import { Tip } from "@/components/ui/tip";
import { ChatPanel } from "./Chat";
import { TONE_DOT, TONE_LABEL } from "./Agents";
import { StatusHoverCard } from "./StatusCard";
import { Markdown } from "./PrDetail";
import { PreviewCell, PrPreviewButton } from "./PreviewControl";

export function DetailsCard({ row, summary, actions, extra }: { row: Row; summary: ChangeSummary | null; actions?: ReactNode; extra?: ReactNode }) {
  const failure = agentFailure(row);
  const tone = rowTone(row);
  const pill = prPill(row);
  const created = row.transcript?.[0]?.startedAt ?? row.agentStartedAt;
  const duration = rowDuration(row);
  const last = summary?.commits[0];
  const instance = rowInstance(row, thisInstance());
  const model = row.agentMeta?.model ?? modelLabel(modelFor(row));
  const outcome = row.agentOutcome?.outcome || row.agentResult;
  return (
    <VCard slot="agent-details" title="Agent details" aside={<><PreviewCell row={row} /><PrPreviewButton row={row} />{actions}</>}>
      <div className="grid gap-6 p-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        {failure ? (
          <div data-slot="failure-box" className="border-geist-red min-h-32 rounded-lg border">
            <div className="flex items-center gap-2 border-b border-inherit px-3 py-2.5 text-sm font-medium"><AlertTriangle className="text-geist-red size-4" />{failure.title}</div>
            <pre className="text-muted-foreground max-h-64 overflow-auto px-3 py-3 font-mono text-xs whitespace-pre-wrap">{failure.detail}</pre>
          </div>
        ) : (
          <div data-slot="outcome-box" className="bg-background min-h-32 rounded-md">
            <div className="text-muted-foreground px-3 pt-3 text-xs">{row.agentCheck?.ok ? "Verified · " : ""}Latest outcome</div>
            <div className="max-h-64 overflow-auto px-3 pt-1.5 pb-3 text-sm">{outcome ? <Markdown>{outcome}</Markdown> : <span className="text-muted-foreground">No finished run yet.</span>}</div>
          </div>
        )}
        <div className="min-w-0 space-y-5">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
            <Detail label="Created" slot="detail-created">{created ? ago(created) : "—"}</Detail>
            <Detail label="Status" slot="detail-status"><StatusHoverCard row={row} className="gap-1.5"><StatusDot tone={TONE_DOT[tone]} />{TONE_LABEL[tone]}</StatusHoverCard>{row.agentCheck && <span className="text-muted-foreground">· {row.agentCheck.ok ? "check passed" : "check failed"}</span>}</Detail>
            <Detail label="Duration">{duration !== undefined ? formatDuration(duration) : "—"}</Detail>
            <Detail label="State">{pill.tooltip ? <Tip label={pill.tooltip}><Pill tone={pill.tone}>{pill.label}</Pill></Tip> : <Pill tone={pill.tone}>{pill.label}</Pill>}</Detail>
            <Detail label="Model" slot="detail-model">{model}</Detail>
            {instanceChoices().length > 1 && <Detail label="Instance">{instance ?? "—"}</Detail>}
            <Detail label="Pull request">{row.prNumber
              ? <a href={row.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline"><GitPullRequest className="size-3.5" />#{row.prNumber}</a>
              : <span className="text-muted-foreground">not promoted</span>}</Detail>
            <Detail label="Preview">{row.previewUrl
              ? <a href={row.previewUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 truncate hover:underline">Open <ExternalLink className="size-3" /></a>
              : <span className="text-muted-foreground">—</span>}</Detail>
          </div>
          <Detail label="Source" slot="detail-source">
            <div className="min-w-0 space-y-1.5">
              <div className="flex items-center gap-1.5 font-mono text-sm"><GitBranch className="size-3.5 shrink-0" /><span className="truncate">{row.branch}</span><span className="text-muted-foreground">→ {row.prBase ?? baseBranch(row.repo)}</span></div>
              {last && <div className="flex min-w-0 items-center gap-1.5 text-sm"><GitCommitHorizontal className="size-3.5 shrink-0" /><code className="font-mono">{last.hash.slice(0, 7)}</code><span className="truncate">{last.subject}</span></div>}
              {summary && <div className="text-muted-foreground text-xs">{summary.commits.length} commit{summary.commits.length === 1 ? "" : "s"} · <span className="text-geist-green">+{summary.additions}</span> <span className="text-geist-red">−{summary.deletions}</span> across {summary.files.length} files</div>}
            </div>
          </Detail>
          {extra}
        </div>
      </div>
    </VCard>
  );
}

/** The page's ONE header row on desktop (Finn: the old repo line + 2xl title + links + a separate
 *  tab row ate the Chat tab's height): repo / title, the status, the branch or PR link, then the
 *  key actions at the right — the tabs sit directly under it, in the same sticky block. Below md,
 *  it splits into two rows instead — the title alone (squeezed beside the status dot and every
 *  action icon, it wrapped one word per line on a phone), then status + actions. Everything else
 *  (created, model, instance, source, preview) lives on the Overview tab's Details card. */
export function AgentHeader({ repo, title, status, source, actions }: { repo: string; title: ReactNode; status?: ReactNode; source?: ReactNode; actions?: ReactNode }) {
  return (
    <div data-slot="agent-header" className="flex min-w-0 flex-col gap-1 md:min-h-9 md:flex-row md:items-center md:gap-x-3 md:gap-y-0">
      <h1 className="flex min-w-0 items-center gap-1.5 text-base font-semibold tracking-tight">
        <span className="text-muted-foreground hidden shrink-0 font-normal sm:inline">{repo} /</span>
        <span className="min-w-0 truncate">{title}</span>
      </h1>
      <div className="flex min-w-0 items-center gap-x-3 md:contents">
        {status && <span data-slot="agent-header-status" className="flex shrink-0 items-center gap-1.5 text-xs">{status}</span>}
        {source && <span data-slot="agent-header-source" className="text-muted-foreground hidden min-w-0 items-center gap-1 text-xs md:flex">{source}</span>}
        {actions && <span className="ml-auto flex shrink-0 items-center gap-2">{actions}</span>}
      </div>
    </div>
  );
}

/** The header's status: the row's tone dot and label (Running / Error / Needs you / Ready / Idle). */
export function RowStatus({ row }: { row: Row }) {
  const tone = rowTone(row);
  return <StatusHoverCard row={row} className="gap-1.5"><StatusDot tone={TONE_DOT[tone]} />{TONE_LABEL[tone]}</StatusHoverCard>;
}

/** The header's source: the branch, mono, or a PR's link to GitHub. */
export const HeaderSource = ({ branch, prNumber, prUrl }: { branch: string; prNumber?: number; prUrl?: string }) => (
  <>
    <GitBranch className="size-3 shrink-0" /><span className="truncate font-mono">{branch}</span>
    {prNumber && prUrl && (
      <a href={prUrl} target="_blank" rel="noreferrer" className="hover:text-foreground ml-1 inline-flex shrink-0 items-center gap-1">
        <GitPullRequest className="size-3" />#{prNumber}<ExternalLink className="size-3" />
      </a>
    )}
  </>
);

/** The Chat tab's content: no card, no title row, no toolbar, no page-level scroll — a flex column
 *  sized to exactly the viewport below the page's sticky header (`CHAT_FILL_HEIGHT`, 100dvh-based so
 *  it also works on a phone and clears the PWA safe areas). The transcript scrolls inside it; the
 *  composer stays pinned at its foot. Full-bleed like the header (-mx), so the log's and composer's
 *  divider lines run to the column's edges, and on desktop it takes `main`'s bottom padding too
 *  (-mb-6), so the composer sits near the bottom of the viewport.
 *
 *  What it subtracts: the top bar (3.5rem) — plus, on a phone, `main`'s 5.5rem bottom padding (the
 *  bottom bar) — and the sticky header's live height (--stick). `main`'s top padding is NOT
 *  subtracted: `STICKY_HEADER` pulls itself up over it (-mt-6), and the Tabs root's gap is zeroed
 *  (`AGENT_TABS`), so the header sits flush under the top bar and the conversation right under it. */
const CHAT_FILL_HEIGHT =
  "h-[calc(var(--vvh,100dvh)-9rem-env(safe-area-inset-top)-env(safe-area-inset-bottom)-var(--stick,0px))] " +
  "md:h-[calc(var(--vvh,100dvh)-3.5rem-env(safe-area-inset-top)-var(--stick,0px))]";

/** The agent page's Tabs root: no gap — the header's own padding and each tab's top padding space it. */
export const AGENT_TABS = "gap-0";

export function ChatCard({ row }: { row: Row }) {
  return (
    <div data-slot="agent-chat" data-keyboard-fill className={`-mx-4 md:-mx-6 md:-mb-6 ${CHAT_FILL_HEIGHT}`}>
      <ChatPanel row={row} size="page" autoFocus />
    </div>
  );
}
