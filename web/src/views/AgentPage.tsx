// The agent page — Vercel's single-deployment page, adapted, shared by the PR page and the local-
// session page. A Details card (the failure box where Vercel shows "Build Failed", else the agent's
// last outcome; then Created / Status / Duration / State, Model / Instance / PR / Preview, and the
// Source: branch → base and the latest commit), and the CHAT where Vercel puts Build Logs: the
// conversation (ChatPanel) in a card with turn / error / warning counters, Find in chat, and the
// composer at its foot.
import type { ReactNode } from "react";
import { AlertTriangle, ExternalLink, GitBranch, GitCommitHorizontal, GitPullRequest } from "lucide-react";
import type { ChangeSummary } from "../../../server/git";
import { baseBranch, instanceChoices, modelFor, thisInstance, type Row } from "../store";
import { LANE_LABELS, agentFailure, ago, formatDuration, rowDuration, rowInstance, rowTone } from "../workstream";
import { modelLabel } from "../../../shared/models";
import { Detail, Pill, StatusDot, VCard } from "@/components/console";
import { ChatPanel } from "./Chat";
import { TONE_DOT, TONE_LABEL } from "./Agents";
import { Markdown } from "./PrDetail";

export function DetailsCard({ row, summary, actions, extra }: { row: Row; summary: ChangeSummary | null; actions?: ReactNode; extra?: ReactNode }) {
  const failure = agentFailure(row);
  const tone = rowTone(row);
  const created = row.transcript?.[0]?.startedAt ?? row.agentStartedAt;
  const duration = rowDuration(row);
  const last = summary?.commits[0];
  const instance = rowInstance(row, thisInstance());
  const model = row.agentMeta?.model ?? modelLabel(modelFor(row));
  const outcome = row.agentOutcome?.outcome || row.agentResult;
  return (
    <VCard slot="agent-details" title="Agent details" aside={actions}>
      <div className="grid gap-6 p-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        {failure ? (
          <div data-slot="failure-box" className="border-geist-red min-h-32 rounded-lg border">
            <div className="flex items-center gap-2 border-b border-inherit px-3 py-2.5 text-sm font-medium"><AlertTriangle className="text-geist-red size-4" />{failure.title}</div>
            <pre className="text-muted-foreground max-h-64 overflow-auto px-3 py-3 font-mono text-xs whitespace-pre-wrap">{failure.detail}</pre>
          </div>
        ) : (
          <div data-slot="outcome-box" className="bg-background min-h-32 rounded-lg border">
            <div className="text-muted-foreground border-b px-3 py-2.5 text-xs">{row.agentCheck?.ok ? "Verified · " : ""}Latest outcome</div>
            <div className="max-h-64 overflow-auto px-3 py-3 text-sm">{outcome ? <Markdown>{outcome}</Markdown> : <span className="text-muted-foreground">No finished run yet.</span>}</div>
          </div>
        )}
        <div className="min-w-0 space-y-5">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
            <Detail label="Created" slot="detail-created">{created ? ago(created) : "—"}</Detail>
            <Detail label="Status" slot="detail-status"><StatusDot tone={TONE_DOT[tone]} />{TONE_LABEL[tone]}{row.agentCheck && <span className="text-muted-foreground">· {row.agentCheck.ok ? "check passed" : "check failed"}</span>}</Detail>
            <Detail label="Duration">{duration !== undefined ? formatDuration(duration) : "—"}</Detail>
            <Detail label="State"><Pill tone={row.lane === "MERGEABLE" ? "blue" : row.lane === "DONE" ? "green" : "default"}>{row.lane === "DONE" ? "Merged" : LANE_LABELS[row.lane]}</Pill></Detail>
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

/** The conversation in Build Logs' place: a card, the log bar, the terminal log, the composer. */
export function ChatCard({ row, tall = false }: { row: Row; tall?: boolean }) {
  return (
    <VCard slot="agent-chat" title="Conversation" aside={row.agentStatus === "running" ? <span className="flex items-center gap-1.5 text-xs"><StatusDot tone="building" className="size-2" />working</span> : undefined}>
      <div className={`p-4 ${tall ? "h-[calc(100vh-14rem)] min-h-[28rem]" : "h-[36rem]"}`}>
        <ChatPanel row={row} logBar />
      </div>
    </VCard>
  );
}
