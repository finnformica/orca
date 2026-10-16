import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Highlight, themes } from "prism-react-renderer";
import { ArrowLeft, Check, Clock, ExternalLink, GitMerge, X } from "lucide-react";
import { api } from "../api";
import type { PrDetail as PrDetailData } from "../../../server/gh";
import { addPreviewLabel, useWorkstreams, type Row } from "../store";
import { navigate, type PrTab } from "@/lib/route";
import { useTheme } from "@/lib/theme";
import { WorkstreamActions } from "./WorkstreamActions";
import { PreviewCell, PreviewPanel } from "./PreviewControl";
import { ActionButton } from "@/components/ActionButton";
import { ScreenshotsCard } from "@/components/Screenshots";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReviewPanel, reviewSig } from "./Review";
import { AGENT_TABS, AgentHeader, ChatCard, DetailsCard, HeaderSource, RowStatus } from "./AgentPage";
import { useNarrow } from "@/lib/viewport";
import { ChecksCard, ConversationCard } from "./PrPanels";
import { Detail, VCard } from "@/components/console";
import { useSummary } from "./Board";

/** Both detail pages pin their header — title / status / actions / tabs stay reachable while a long
 *  diff scrolls under them. Opaque + full-bleed (negative margins) so nothing peeks past the page
 *  padding, and pulled up over `main`'s top padding (-mt-6) so it sits flush under the top bar — every
 *  rem it doesn't take is the Chat tab's (`CHAT_FILL_HEIGHT`). Shared so the PR page and the
 *  local-session page can't drift apart. */
export const STICKY_HEADER = "bg-background sticky top-14 z-20 -mx-4 -mt-6 flex flex-col gap-1 border-b px-4 py-2 md:-mx-6 md:px-6";

/** The tab row under the header: shorter than the default, and pulled left by a trigger's own
 *  padding and border (px-3 + 1px) so the "Overview" label lines up with the repo name above it. */
export const HEADER_TABS = "-ml-[13px] h-8";

/** Ref for that header plus the wrapper style publishing its LIVE height as --stick, so the diff's
 *  own sticky file headers park below it instead of sliding underneath. `ready` flips once the page
 *  has data (both pages return a placeholder before that, with no header to measure). */
export function useStickyHeader(ready: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
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
  const summary = useSummary(liveRow); // its commits, for the Details card's Source
  const header = useStickyHeader(Boolean(pr));
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
  const back = "/agents";

  if (error) return (
    <div className="space-y-4" data-slot="pr-error">
      <Back to={back} />
      <p className="text-destructive text-sm">Couldn't load PR #{number}: {error}</p>
      {retry}
    </div>
  );
  if (!pr) return (
    <div className="space-y-4" data-slot="pr-loading">
      <Back to={back} />
      <p className="text-muted-foreground text-sm">Loading PR #{number}…</p>
      {slow && <div className="space-y-2"><p className="text-muted-foreground text-sm">This is taking longer than usual — GitHub may be slow.</p>{retry}</div>}
    </div>
  );

  // For a coworker PR (not one of your workstreams) synthesise a row so Test locally + the preview
  // panel + add-label still work here — the review list itself is action-free for density.
  const row: Row = liveRow ?? {
    repo, hasRemote: true, branch: pr.head, title: pr.title, prompt: "", lane: "IN_REVIEW",
    prNumber: pr.number, prUrl: pr.url, previewUrl: pr.previewUrl,
    ciStatus: pr.ciStatus, reviewStatus: pr.reviewStatus, mergeable: pr.mergeable,
  };

  const badges = (
    <div className="flex flex-wrap gap-1">
      <Badge variant="outline">{pr.state}</Badge>
      {pr.reviewStatus === "changes_requested" && <Badge variant="destructive">Changes requested</Badge>}
      {pr.reviewStatus === "approved" && <Badge variant="success">Approved</Badge>}
      {pr.mergeable === "CONFLICTING" && <Badge variant="destructive">Conflicts</Badge>}
      {pr.ciStatus === "passing" && <Badge variant="success">CI <Check /></Badge>}
      {pr.ciStatus === "failing" && <Badge variant="destructive">CI <X /></Badge>}
      {pr.ciStatus === "pending" && <Badge variant="outline">CI <Clock /></Badge>}
      {pr.autoMergeEnabled && <Badge variant="outline" className="border-transparent bg-purple-500/10 text-purple-700 dark:text-purple-400">Auto-merge <GitMerge /></Badge>}
    </div>
  );
  // A coworker's PR has no conversation here; the checks moved onto Overview, so an old /checks link lands there.
  const sig = liveRow ? reviewSig(liveRow) : undefined;
  const sub2 = (!liveRow && sub === "chat") || sub === "checks" ? "overview" : sub;

  return (
    <div style={header.style}>
      <Tabs value={sub2} onValueChange={(v) => go(v as PrTab)} className={AGENT_TABS}>
        <div ref={header.ref} className={STICKY_HEADER}>
          <AgentHeader repo={repo}
            title={<><a href={pr.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground mr-1.5 font-normal hover:underline">#{pr.number}</a>{row.title}</>}
            status={liveRow ? <RowStatus row={liveRow} /> : <Badge variant="outline" className="capitalize">{(pr.state ?? "").toLowerCase()}</Badge>}
            source={<HeaderSource branch={pr.head} prNumber={pr.number} prUrl={pr.url} />}
            actions={liveRow && <WorkstreamActions row={liveRow} compact={narrow} tipSide="bottom" leading={<PreviewCell row={liveRow} />} />} />
          <TabsList className={HEADER_TABS}>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            {liveRow && <TabsTrigger value="chat">Chat</TabsTrigger>}
            <TabsTrigger value="files">Files changed ({pr.changedFiles})</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-6 pt-4">
          {liveRow ? (
            <DetailsCard row={liveRow} summary={summary} extra={<Detail label="Pull request status">{badges}</Detail>} />
          ) : (
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
            <ScreenshotsCard repo={repo} branch={pr.head} version={liveRow?.agentStatus} />
            <ChecksCard checks={pr.checks} />
          </div>
          <VCard slot="pr-description" title="Description">
            <div className="p-4">
              {pr.body ? <Markdown>{pr.body}</Markdown> : <p className="text-muted-foreground text-sm">No description.</p>}
            </div>
          </VCard>
          <ConversationCard repo={repo} prNumber={number} sig={sig} comments={pr.comments} reviews={pr.reviews} />
        </TabsContent>

        {liveRow && (
          <TabsContent value="chat">
            <ChatCard row={liveRow} />
          </TabsContent>
        )}

        <TabsContent value="files" className="space-y-3 pt-4">
          {diff === null ? <p className="text-muted-foreground text-sm">Loading diff…</p> : <DiffView text={diff} />}
        </TabsContent>

        <TabsContent value="preview" className="pt-4">
          <PreviewPanel row={row} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const Back = ({ to }: { to: string }) => <Button variant="ghost" size="sm" onClick={() => navigate(to)}><ArrowLeft /> Back to agents</Button>;

export const Markdown = ({ children }: { children: string }) => (
  <div className="prose prose-sm dark:prose-invert max-w-none">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
  </div>
);

// ---- diff rendering with syntax highlighting ----
type DiffLine = { type: "add" | "del" | "ctx"; text: string };
type Hunk = { header: string; lines: DiffLine[] };
type FileDiff = { path: string; lang: string; hunks: Hunk[] };

const LANGS: Record<string, string> = {
  ts: "tsx", tsx: "tsx", js: "jsx", jsx: "jsx", mjs: "jsx", cjs: "jsx",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
  css: "css", scss: "scss", json: "json", md: "markdown", yml: "yaml", yaml: "yaml",
  sh: "bash", bash: "bash", sql: "sql", html: "markup", tf: "hcl",
};
const langOf = (path: string) => LANGS[path.split(".").pop() ?? ""] ?? "tsx";

function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git")) {
      file = { path: line.split(" b/").pop() ?? "", lang: "tsx", hunks: [] };
      file.lang = langOf(file.path);
      files.push(file);
      hunk = null;
    } else if (!file) {
      continue;
    } else if (line.startsWith("+++ b/")) {
      file.path = line.slice(6);
      file.lang = langOf(file.path);
    } else if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk && (line[0] === "+" || line[0] === "-" || line[0] === " ")) {
      hunk.lines.push({ type: line[0] === "+" ? "add" : line[0] === "-" ? "del" : "ctx", text: line.slice(1) });
    }
  }
  return files;
}

/** Collapsing a file you've scrolled deep into deletes all that height from *above* the viewport, so
 *  the page lurches upward and lands past the files below. Pin the clicked header to the screen
 *  position it was already at: measure it, let the toggle lay out, then take the difference back out
 *  of the scroll. Also keeps expanding from jumping. */
export function keepInPlace(e: React.MouseEvent<HTMLElement>) {
  const el = e.currentTarget;
  const before = el.getBoundingClientRect().top;
  requestAnimationFrame(() => window.scrollBy(0, el.getBoundingClientRect().top - before));
}

export function DiffView({ text }: { text: string }) {
  const files = parseDiff(text);
  if (files.length === 0) return <p className="text-muted-foreground text-sm">No diff.</p>;
  return (
    <Accordion type="multiple" defaultValue={files.map((_, i) => `f${i}`)} className="space-y-2">
      {files.map((f, i) => {
        const lines = f.hunks.flatMap((h) => h.lines);
        const adds = lines.filter((l) => l.type === "add").length;
        const dels = lines.filter((l) => l.type === "del").length;
        // The file header sticks while its diff scrolls, so you always see which file you're
        // reading. It pins to Radix's header wrapper (`>h3` — the trigger itself can't move inside
        // it), just below the page's own sticky header (--stick, 0 if nothing is pinned). No
        // `overflow-hidden` on the item: a clipping ancestor kills sticky — the content's
        // overflow-x-auto box rounds the bottom corners instead. The header is also a scroll-state
        // container, so styles.css can square its radius off while it's stuck (no peek-through).
        return (
          <AccordionItem key={i} value={`f${i}`} className="rounded-md border last:border-b [&>h3]:sticky [&>h3]:z-10 [&>h3]:[top:var(--stick,0px)] [&>h3]:[container-type:scroll-state]">
            <AccordionTrigger onClick={keepInPlace} className="bg-muted px-3 py-2 font-mono text-xs rounded-b-none hover:no-underline">
              <span className="flex flex-1 items-center gap-2 overflow-hidden">
                <span className="truncate">{f.path}</span>
                <span className="ml-auto shrink-0">
                  <span className="text-emerald-600 dark:text-emerald-400">+{adds}</span> <span className="text-red-600 dark:text-red-400">−{dels}</span>
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0">
              <div className="overflow-x-auto rounded-b-md border-t font-mono text-xs">
                {f.hunks.map((h, j) => (
                  <div key={j}>
                    <div className="bg-muted/30 px-3 py-0.5 text-cyan-700 dark:text-cyan-400">{h.header}</div>
                    <HunkView hunk={h} lang={f.lang} />
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}

function HunkView({ hunk, lang }: { hunk: Hunk; lang: string }) {
  const code = hunk.lines.map((l) => l.text).join("\n");
  // prism-react-renderer paints token colors inline, so a light theme is dark-on-dark in dark mode:
  // swap to a dark syntax theme when the `.dark` class is on (useTheme re-renders on toggle).
  useTheme();
  const dark = document.documentElement.classList.contains("dark");
  return (
    <Highlight theme={dark ? themes.vsDark : themes.github} code={code} language={lang}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <>
          {tokens.map((lineTokens, i) => {
            const type = hunk.lines[i]?.type ?? "ctx";
            const bg = type === "add" ? "bg-emerald-500/10 dark:bg-emerald-500/25" : type === "del" ? "bg-red-500/10 dark:bg-red-500/25" : "";
            const signColor = type === "add" ? "text-emerald-600 dark:text-emerald-400" : type === "del" ? "text-red-600 dark:text-red-400" : "text-muted-foreground";
            const sign = type === "add" ? "+" : type === "del" ? "−" : " ";
            return (
              <div key={i} {...getLineProps({ line: lineTokens, className: `flex px-2 ${bg}` })}>
                <span className={`${signColor} w-4 shrink-0 select-none`}>{sign}</span>
                <span className="flex-1 whitespace-pre">{lineTokens.map((token, k) => <span key={k} {...getTokenProps({ token })} />)}</span>
              </div>
            );
          })}
        </>
      )}
    </Highlight>
  );
}
