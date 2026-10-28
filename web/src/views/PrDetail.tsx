import { useEffect, useRef, useState } from "react";
import { afterDockMotion } from "@/lib/dock";
import { ExternalLink, GitMerge } from "lucide-react";
import { api } from "../api";
import type { PrDetail as PrDetailData } from "../../../server/gh";
import { addPreviewLabel, useWorkstreams, useWorkstreamsLoaded, type Row } from "../store";
import { navigate, type PrTab } from "@/lib/route";
import { WorkstreamActions } from "./WorkstreamActions";
import { PreviewCell, PreviewPanel } from "./PreviewControl";
import { VerifiedButton } from "./VerifiedButton";
import { ActionButton } from "@/components/ActionButton";
import { ScreenshotsCard } from "@/components/Screenshots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReviewPanel, reviewSig } from "./Review";
import { AGENT_TABS, AgentHeader, ChatCard, DetailsCard, HeaderSource, RowStatus } from "./AgentPage";
import { useNarrow } from "@/lib/viewport";
import { ChecksCard, CiChip, ConversationCard } from "./PrPanels";
import { Detail, VCard } from "@/components/console";
import { useSummary } from "@/lib/workstreamHooks";
import { Markdown } from "@/components/Markdown";
import { FilesChanged } from "./FilesChanged";

/** Both detail pages pin their header — title / status / actions / tabs stay reachable while a long
 *  diff scrolls under them. Opaque + full-bleed (negative margins) so nothing peeks past the page
 *  padding, and pulled up over `main`'s top padding (-mt-6) so it sits flush under the top bar — every
 *  rem it doesn't take is the Chat tab's (`CHAT_FILL_HEIGHT`). Shared so the PR page and the
 *  local-session page can't drift apart. */
// A phone has no top bar on this page (Shell's `phoneBarePage`): the header sticks at the screen's
// top and pads itself clear of the notch; --stick then carries that inset for the tabs' content.
export const STICKY_HEADER = "bg-background sticky top-14 z-20 -mx-4 -mt-6 flex flex-col gap-1 border-b px-4 py-2 md:-mx-6 md:px-6 max-md:top-0 max-md:pt-[calc(0.5rem+env(safe-area-inset-top))]";

/** The tab row under the header: shorter than the default, and pulled left by a trigger's own
 *  padding and border (px-3 + 1px) so the "Overview" label lines up with the repo name above it. */
export const HEADER_TABS = "-ml-[13px] h-8";

/** Ref for that header plus the wrapper style publishing its LIVE height as --stick, so the diff's
 *  own sticky file headers park below it instead of sliding underneath. `ready` flips once the page
 *  has data (the local page returns a placeholder before that, with no header to measure; the PR
 *  page renders its header at once). */
export function useStickyHeader(ready: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Not per frame while the dock or the nav animates the page's width: once, when it has settled.
    const update = () => setHeight(el.offsetHeight);
    const ro = new ResizeObserver(() => afterDockMotion(update));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);
  return { ref, style: { "--stick": `${height}px` } as React.CSSProperties };
}

export function PrDetail({ repo, number, sub }: { repo: string; number: number; sub: PrTab }) {
  const [pr, setPr] = useState<PrDetailData | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveRow = useWorkstreams().find((r) => r.repo === repo && r.prNumber === number); // your own PR, if tracked
  const loaded = useWorkstreamsLoaded(); // until then, no liveRow does not mean "not yours"
  const summary = useSummary(liveRow); // its commits, for the Details card's Source
  const header = useStickyHeader(true); // the header renders at once, before GitHub answers
  const narrow = useNarrow();

  // `attempt` re-runs the fetch for Retry. A load that is taking a while says so, rather than an
  // indefinite "Loading…" that looks like a hang.
  const [attempt, setAttempt] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    let live = true;
    setPr(null);
    setError(null);
    setSlow(false);
    const t = setTimeout(() => { if (live) setSlow(true); }, 8_000);
    api.prDetail(repo, number)
      .then((d) => { if (live) setPr(d); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => clearTimeout(t));
    return () => { live = false; clearTimeout(t); };
  }, [repo, number, attempt]);
  const retry = <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>;

  useEffect(() => {
    if (sub === "files" && diff === null) api.prDiff(repo, number).then((d) => setDiff(d.diff)).catch(() => setDiff(""));
  }, [sub, repo, number, diff]);

  const go = (t: PrTab) => navigate(t === "overview" ? `/${repo}/prs/${number}` : `/${repo}/prs/${number}/${t}`);

  // The page never waits on GitHub: the header, the tabs and the Chat tab render at once from the
  // live row (your workstream) or the URL (a coworker's PR). Only what needs the PR detail waits,
  // and the Overview says why with this note: loading, slow, or failed, each with Retry.
  const loadNote = !pr && (
    error ? (
      <div data-slot="pr-error" className="flex flex-wrap items-center gap-3 text-sm">
        <p className="text-destructive">Couldn't load PR #{number}: {error}</p>{retry}
      </div>
    ) : (
      <div data-slot="pr-loading" className="flex flex-wrap items-center gap-3 text-sm">
        <p className="text-muted-foreground">Loading PR #{number} from GitHub…</p>
        {slow && <><p className="text-muted-foreground">This is taking longer than usual — GitHub may be slow.</p>{retry}</>}
      </div>
    )
  );

  // For a coworker PR (not one of your workstreams) synthesise a row so Test locally + the preview
  // panel + add-label still work here — the review list itself is action-free for density.
  const row: Row | null = liveRow ?? (pr && {
    repo, hasRemote: true, branch: pr.head, title: pr.title, prompt: "", lane: "IN_REVIEW",
    prNumber: pr.number, prUrl: pr.url, previewUrl: pr.previewUrl,
    ciStatus: pr.ciStatus, reviewStatus: pr.reviewStatus, mergeable: pr.mergeable,
  });
  const url = pr?.url ?? liveRow?.prUrl;
  const branch = liveRow?.branch ?? pr?.head;

  const badges = pr && (
    <div className="flex flex-wrap gap-1">
      <Badge variant="outline">{pr.state}</Badge>
      {pr.reviewStatus === "changes_requested" && <Badge variant="destructive">Changes requested</Badge>}
      {pr.reviewStatus === "approved" && <Badge variant="success">Approved</Badge>}
      {pr.mergeable === "CONFLICTING" && <Badge variant="destructive">Conflicts</Badge>}
      <CiChip repo={repo} prNumber={pr.number} ciStatus={pr.ciStatus} checks={pr.checks} />
      {pr.autoMergeEnabled && <Badge variant="outline" className="border-transparent bg-purple-500/10 text-purple-700 dark:text-purple-400">Auto-merge <GitMerge /></Badge>}
    </div>
  );
  // The checks moved onto Overview, so an old /checks link lands there. The Chat tab stays when the
  // URL names it: on a reload the store has no rows yet, and swapping to Overview then looked like the
  // reload lost the tab. It shows a loading line until the store loads, then the conversation or why
  // there is none (a coworker's PR, or one merged before today).
  const sig = liveRow ? reviewSig(liveRow) : undefined;
  const sub2 = sub === "checks" ? "overview" : sub;
  const showChat = Boolean(liveRow) || !loaded || sub === "chat";

  return (
    <div style={header.style}>
      <Tabs value={sub2} onValueChange={(v) => go(v as PrTab)} className={AGENT_TABS}>
        <div ref={header.ref} className={STICKY_HEADER}>
          <AgentHeader repo={repo}
            title={<>{url
              ? <a href={url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground mr-1.5 font-normal hover:underline">#{number}</a>
              : <span className="text-muted-foreground mr-1.5 font-normal">#{number}</span>}{row?.title}</>}
            status={liveRow ? <RowStatus row={liveRow} /> : pr && <Badge variant="outline" className="capitalize">{(pr.state ?? "").toLowerCase()}</Badge>}
            source={branch && <HeaderSource branch={branch} prNumber={number} prUrl={url} />}
            actions={liveRow && <WorkstreamActions row={liveRow} compact={narrow} tipSide="bottom" followUp={false} leading={<PreviewCell row={liveRow} />} beforeMenu={<VerifiedButton row={liveRow} icon />} />} />
          <TabsList className={HEADER_TABS}>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            {showChat && <TabsTrigger value="chat">Chat</TabsTrigger>}
            <TabsTrigger value="files">Files changed{pr ? ` (${pr.changedFiles})` : ""}</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-6 pt-4">
          {loadNote}
          {liveRow ? (
            <DetailsCard row={liveRow} summary={summary} extra={badges && <Detail label="Pull request status">{badges}</Detail>} />
          ) : pr && row && (
            <VCard slot="pr-details" title="Pull request details" aside={!pr.previewUrl ? <ActionButton onRun={() => addPreviewLabel(row)} failure={{ action: "Add preview label", title: row.title, repo: row.repo, branch: row.branch, prNumber: row.prNumber }}>Add preview label</ActionButton> : undefined}>
              <div className="grid grid-cols-2 gap-x-6 gap-y-4 p-4 md:grid-cols-4">
                <Detail label="Author">{pr.author || "?"}</Detail>
                <Detail label="Source"><code className="truncate font-mono">{pr.head}</code><span className="text-muted-foreground">→ {pr.base}</span></Detail>
                <Detail label="Changes"><span className="text-geist-green">+{pr.additions}</span><span className="text-geist-red">−{pr.deletions}</span><span className="text-muted-foreground">in {pr.changedFiles} files</span></Detail>
                <Detail label="Status">{badges}</Detail>
                {pr.previewUrl && <Detail label="PR preview"><a className="inline-flex items-center gap-1 hover:underline" href={pr.previewUrl} target="_blank" rel="noreferrer">Open <ExternalLink className="size-3" /></a></Detail>}
              </div>
            </VCard>
          )}
          <ReviewPanel repo={repo} prNumber={number} sig={sig} />
          {/* Side by side at desktop widths — two cards that otherwise each leave half the row
              empty. `:only-child` picks up the common case (no screenshots yet) with no extra
              state: ScreenshotsCard renders nothing then, so Checks is the grid's sole child and
              spans both columns. */}
          <div className="grid gap-6 lg:grid-cols-2 lg:[&>*:only-child]:col-span-2">
            {branch && <ScreenshotsCard repo={repo} branch={branch} version={liveRow?.agentStatus} />}
            {pr && <ChecksCard checks={pr.checks} />}
          </div>
          {pr && <>
            <VCard slot="pr-description" title="Description">
              <div className="p-4">
                {pr.body ? <Markdown>{pr.body}</Markdown> : <p className="text-muted-foreground text-sm">No description.</p>}
              </div>
            </VCard>
            <ConversationCard repo={repo} prNumber={number} sig={sig} comments={pr.comments} reviews={pr.reviews} />
          </>}
        </TabsContent>

        {showChat && (
          <TabsContent value="chat">
            {liveRow ? <ChatCard row={liveRow} />
              : !loaded ? <p data-slot="chat-loading" className="text-muted-foreground pt-4 text-sm">Loading conversation…</p>
              : <p data-slot="chat-none" className="text-muted-foreground pt-4 text-sm">No agent conversation for this PR on the board. It is not an Orca workstream, or it is merged or closed.</p>}
          </TabsContent>
        )}

        <TabsContent value="files" className="pt-4">
          {diff === null ? <p className="text-muted-foreground text-sm">Loading diff…</p> : <FilesChanged text={diff} scope={`${repo}#${number}`} />}
        </TabsContent>

        <TabsContent value="preview" className="pt-4">
          {row ? <PreviewPanel row={row} /> : loadNote}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// The page-surface markdown renderer lives in components/Markdown.tsx; re-exported for its older callers.
export { Markdown } from "@/components/Markdown";
