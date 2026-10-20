import { useEffect, useState } from "react";
import type { ChangeSummary } from "../../../server/git";
import { api } from "../api";
import { summary as fetchSummary, useWorkstreams, useWorkstreamsLoaded } from "../store";
import { navigate, type LocalTab } from "@/lib/route";
import { HEADER_TABS, STICKY_HEADER, useStickyHeader } from "./PrDetail";
import { AGENT_TABS, AgentHeader, ChatCard, DetailsCard, HeaderSource, RowStatus } from "./AgentPage";
import { useNarrow } from "@/lib/viewport";
import { VCard } from "@/components/console";
import { ScreenshotsCard } from "@/components/Screenshots";
import { WorkstreamActions } from "./WorkstreamActions";
import { PreviewCell, PreviewPanel } from "./PreviewControl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { poll } from "@/lib/poll";
import { FilesChanged } from "./FilesChanged";

// The agent page for a local session (a worktree + its agent, pre-PR), Vercel's deployment page:
// Overview (the Details card, then files and commits), Chat (the conversation, filling the
// viewport below the header and tabs), Files changed (branch-vs-base diff), Preview.
export function LocalDetail({ repo, branch, sub }: { repo: string; branch: string; sub: LocalTab }) {
  const row = useWorkstreams().find((r) => r.repo === repo && r.branch === branch && !r.mergedAt);
  const loaded = useWorkstreamsLoaded();
  const [summary, setSummary] = useState<ChangeSummary | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const wt = row?.worktreePath;
  const header = useStickyHeader(Boolean(row));
  const narrow = useNarrow();

  useEffect(() => {
    if (!wt) { setSummary(null); return; }
    const reload = () => fetchSummary(repo, wt).then(setSummary).catch(() => {});
    if (row?.agentStatus !== "running") return void reload();
    return poll(reload, 8000); // keep commits/size fresh only while the agent works
  }, [repo, wt, row?.agentStatus]);

  useEffect(() => {
    if (sub === "files" && wt && diff === null) api.localDiff(repo, wt).then((d) => setDiff(d.diff)).catch(() => setDiff(""));
  }, [sub, repo, wt, diff]);

  const go = (t: LocalTab) => navigate(`/${repo}/local/${encodeURIComponent(branch)}${t === "overview" ? "" : `/${t}`}`);

  // On a reload the store has no rows yet: wait, rather than say the session does not exist.
  if (!row && !loaded) return <p data-slot="local-loading" className="text-muted-foreground text-sm">Loading {branch}…</p>;
  if (!row) return <p className="text-muted-foreground text-sm">No local session for <code>{branch}</code>. <button className="underline" onClick={() => navigate("/agents")}>Back to agents</button></p>;

  const hasWork = (summary?.commits.length ?? 0) > 0;

  return (
    <div style={header.style}>
      <Tabs value={sub} onValueChange={(v) => go(v as LocalTab)} className={AGENT_TABS}>
        <div ref={header.ref} className={STICKY_HEADER}>
          <AgentHeader repo={repo} title={row.title} status={<RowStatus row={row} />} source={<HeaderSource branch={row.branch} />}
            actions={<WorkstreamActions row={row} hasWork={hasWork} compact={narrow} tipSide="bottom" followUp={false} leading={<PreviewCell row={row} />} />} />
          <TabsList className={HEADER_TABS}>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="files">Files changed{summary ? ` (${summary.files.length})` : ""}</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-6 pt-4">
          <DetailsCard row={row} summary={summary} />
          <ScreenshotsCard repo={row.repo} branch={row.branch} version={row.agentStatus} />
          <div className="grid gap-6 lg:grid-cols-2">
            <VCard title={`Files changed (${summary?.files.length ?? 0})`}>
              {summary && summary.files.length > 0 ? (
                <ul className="divide-y font-mono text-xs">
                  {summary.files.map((f) => (
                    <li key={f.path} className="flex items-center gap-2 px-4 py-2">
                      <button className="truncate text-left hover:underline" onClick={() => go("files")}>{f.path}</button>
                      <span className="ml-auto shrink-0"><span className="text-geist-green">+{f.additions}</span> <span className="text-geist-red">−{f.deletions}</span></span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-muted-foreground p-4 text-sm">No changes yet.</p>}
            </VCard>
            <VCard title={`Commits (${summary?.commits.length ?? 0})`}>
              {summary && summary.commits.length > 0 ? (
                <ul className="divide-y text-sm">
                  {summary.commits.map((c) => (
                    <li key={c.hash} className="flex gap-2 px-4 py-2"><code className="text-muted-foreground shrink-0 font-mono">{c.hash.slice(0, 7)}</code><span className="truncate">{c.subject}</span></li>
                  ))}
                </ul>
              ) : <p className="text-muted-foreground p-4 text-sm">No commits yet.</p>}
            </VCard>
          </div>
          {row.prompt && <VCard title="Prompt"><p className="p-4 text-sm whitespace-pre-wrap">{row.prompt}</p></VCard>}
        </TabsContent>

        <TabsContent value="chat">
          <ChatCard row={row} />
        </TabsContent>

        <TabsContent value="files" className="pt-4">
          {!wt ? <p className="text-muted-foreground text-sm">No worktree checked out.</p>
            : diff === null ? <p className="text-muted-foreground text-sm">Loading diff…</p>
            : <FilesChanged text={diff} scope={`${repo}:${branch}`} />}
        </TabsContent>

        <TabsContent value="preview" className="pt-4">
          <PreviewPanel row={row} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
