// The Files changed tab of the agent page (a PR, or a local branch against its base), copied from
// GitHub's Files changed page:
// - a wide page: the file tree on the left (folders fold, A/M/D/R, a filter box, click to jump),
//   sticky beside the diff list;
// - a narrow page (a phone, or the dock open): no tree — a Files button opens it in a bottom sheet;
// - each file: a sticky header (status, path, +/-, fold, rendered view for markdown, copy path,
//   Viewed), then the diff: unified, or split on a wide page; line numbers, hunk headers, wrap.
//   Only the code block scrolls sideways — never the page.
// - a lockfile, a generated file or a large diff waits behind Load diff; a deleted file starts
//   folded; a viewed file folds and stays folded until its diff changes.
// The decisions (parse, tree, order, split rows, what starts collapsed) are pure in `diff.ts`.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Highlight, themes, type Token } from "prism-react-renderer";
import {
  Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, FileCode, FileText, Folder, FolderOpen, ListTree, Search, WrapText,
} from "lucide-react";
import {
  buildFileTree, collapseReason, diffTotals, fileAnchor, fileSig, filterFiles, gutterDigits, markdownPreview, splitRows, STATUS_LETTER,
  rowNumbers, treeOrder, type DiffLine, type DiffStatus, type FileDiff, type Hunk, type TreeNode, parseDiff,
} from "../diff";
import { Markdown } from "@/components/Markdown";
import { BottomSheet, SHEET_CLOSE_MS } from "@/components/BottomSheet";
import { Segmented } from "@/components/console";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tip";
import { copyText } from "@/lib/dialogs";
import { isBoolean, oneOf, persistedKey, usePersisted } from "@/lib/persisted";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { isNarrow, useNarrow } from "@/lib/viewport";

type ViewMode = "unified" | "split";

/** Where a sticky thing parks: under the top bar (h-14) and the page's own sticky header (--stick). */
const STICK_TOP = "top-[calc(3.5rem+var(--stick,0px))]";

const STATUS_TONE: Record<DiffStatus, string> = {
  added: "text-geist-green", modified: "text-geist-amber", deleted: "text-geist-red", renamed: "text-geist-blue",
};
const STATUS_LABEL: Record<DiffStatus, string> = { added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed" };

/** Scroll to a file's section, below the sticky headers (its `scroll-mt`). */
function jumpTo(path: string) {
  requestAnimationFrame(() => document.getElementById(fileAnchor(path))?.scrollIntoView({ block: "start" }));
}

/** Collapsing a file you've scrolled deep into deletes all that height from *above* the viewport, so
 *  the page lurches upward and lands past the files below. Pin the clicked header to the screen
 *  position it was already at: measure it, let the toggle lay out, then take the difference back out
 *  of the scroll. Also keeps expanding from jumping. */
export function keepInPlace(e: React.MouseEvent<HTMLElement> | { currentTarget: HTMLElement }) {
  const el = e.currentTarget;
  const before = el.getBoundingClientRect().top;
  // The scroller is the shell's page column on a desktop (Shell's `page-scroll`), the window on a phone.
  const box = el.closest<HTMLElement>('[data-slot="page-scroll"]');
  const scroller = box && box.scrollHeight > box.clientHeight ? box : window;
  requestAnimationFrame(() => scroller.scrollBy(0, el.getBoundingClientRect().top - before));
}

export function FilesChanged({ text, scope }: { text: string; scope: string }) {
  const narrow = useNarrow();
  const all = useMemo(() => parseDiff(text), [text]);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterFiles(all, query), [all, query]);
  const tree = useMemo(() => buildFileTree(shown), [shown]);
  const ordered = useMemo(() => treeOrder(tree), [tree]);
  const totals = useMemo(() => diffTotals(all), [all]);

  const [mode, setMode] = usePersisted<ViewMode>(persistedKey("diffView"), "unified", oneOf("unified", "split"));
  const [wrap, setWrap] = usePersisted<boolean>(persistedKey("diffWrap"), isNarrow(), isBoolean);
  const view: ViewMode = narrow ? "unified" : mode;

  // Viewed: path → the file's diff signature when you ticked it, per PR / branch.
  const [viewedMap, setViewedMap] = usePersisted<Record<string, string>>(persistedKey("diffViewed", scope), {}, (v): v is Record<string, string> => !!v && typeof v === "object");
  const isViewed = useCallback((f: FileDiff) => viewedMap[f.path] === fileSig(f), [viewedMap]);
  // Your folds override the default (folded when viewed, deleted; Load diff for generated / large).
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const isOpen = (f: FileDiff) => open[f.path] ?? !(isViewed(f) || collapseReason(f) === "deleted");
  const [active, setActive] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);

  const reveal = (path: string) => {
    setActive(path);
    setOpen((o) => ({ ...o, [path]: true }));
    jumpTo(path);
  };
  const pick = (path: string) => {
    if (!sheet) return reveal(path);
    setSheet(false);
    setTimeout(() => reveal(path), SHEET_CLOSE_MS + 20); // the sheet slides away first
  };
  const toggleViewed = (f: FileDiff, on: boolean, header: HTMLElement) => {
    const next = { ...viewedMap };
    if (on) next[f.path] = fileSig(f); else delete next[f.path];
    setViewedMap(next);
    keepInPlace({ currentTarget: header });
    setOpen((o) => ({ ...o, [f.path]: !on }));
  };
  const allOpen = ordered.length > 0 && ordered.every(isOpen);
  const setAll = (value: boolean) => setOpen(Object.fromEntries(ordered.map((f) => [f.path, value])));
  const viewedCount = all.filter(isViewed).length;

  // The tree marks the file you are reading: the topmost section under the sticky headers.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit) setActive((hit.target as HTMLElement).dataset.path ?? null);
    }, { rootMargin: "-140px 0px -70% 0px" });
    list.querySelectorAll("[data-slot=diff-file]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ordered]);

  if (all.length === 0) return <p className="text-muted-foreground text-sm">No changes.</p>;

  const treePanel = (
    <FileTree tree={tree} query={query} setQuery={setQuery} active={active} onPick={pick} isViewed={isViewed} total={all.length} />
  );

  return (
    <div data-slot="files-changed" className="min-w-0">
      <div data-slot="diff-toolbar" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <Button variant="outline" size="sm" className="@4xl/page:hidden" onClick={() => setSheet(true)} aria-label="Show file tree">
          <ListTree /> Files
        </Button>
        <span className="text-muted-foreground tabular-nums">
          <span className="text-foreground font-medium">{totals.files}</span> {totals.files === 1 ? "file" : "files"}
          {" "}<span className="text-geist-green">+{totals.additions}</span> <span className="text-geist-red">−{totals.deletions}</span>
        </span>
        <span data-slot="diff-viewed-count" className="text-muted-foreground tabular-nums">{viewedCount} / {totals.files} viewed</span>
        <div className="ml-auto flex items-center gap-1">
          <Tip label={allOpen ? "Collapse all" : "Expand all"}>
            <Button variant="ghost" size="icon" className="size-7" aria-label={allOpen ? "Collapse all" : "Expand all"} onClick={() => setAll(!allOpen)}>
              {allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
            </Button>
          </Tip>
          <Tip label={wrap ? "Do not wrap lines" : "Wrap lines"}>
            <Button variant="ghost" size="icon" className={cn("size-7", wrap && "bg-accent text-foreground")} aria-label="Wrap lines" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
              <WrapText />
            </Button>
          </Tip>
          {!narrow && (
            <span className="hidden @3xl/page:inline-flex">
              <Segmented label="Diff view" size="sm" value={mode} onChange={setMode} options={[{ value: "unified", label: "Unified" }, { value: "split", label: "Split" }]} />
            </span>
          )}
        </div>
      </div>

      <div className="grid min-w-0 gap-4 @4xl/page:grid-cols-[16rem_minmax(0,1fr)] @6xl/page:grid-cols-[18rem_minmax(0,1fr)]">
        <aside data-slot="diff-tree-sidebar" className={cn("sticky hidden max-h-[calc(100dvh-3.5rem-var(--stick,0px)-2rem)] min-h-0 flex-col self-start @4xl/page:flex", "top-[calc(3.5rem+var(--stick,0px)+0.75rem)]")}>
          {treePanel}
        </aside>
        <div ref={listRef} data-slot="diff-list" className="min-w-0 space-y-3">
          {ordered.length === 0 && <p className="text-muted-foreground text-sm">No files match “{query}”.</p>}
          {ordered.map((f) => (
            <FileSection key={f.path} file={f} open={isOpen(f)} loaded={!!loaded[f.path]} viewed={isViewed(f)} view={view} wrap={wrap} compact={narrow}
              onToggle={(e) => { keepInPlace(e); setOpen((o) => ({ ...o, [f.path]: !isOpen(f) })); }}
              onLoad={() => setLoaded((l) => ({ ...l, [f.path]: true }))}
              onViewed={toggleViewed} />
          ))}
        </div>
      </div>

      <BottomSheet open={sheet} onClose={() => setSheet(false)} title={`Files (${all.length})`} slot="diff-tree-sheet">
        <div className="flex max-h-[70vh] min-h-0 flex-col">{treePanel}</div>
      </BottomSheet>
    </div>
  );
}

// ---- the tree ----

function FileTree({ tree, query, setQuery, active, onPick, isViewed, total }: {
  tree: TreeNode[]; query: string; setQuery: (q: string) => void; active: string | null; onPick: (path: string) => void;
  isViewed: (f: FileDiff) => boolean; total: number;
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const toggle = (path: string) => setClosed((c) => ({ ...c, [path]: !c[path] }));
  return (
    <div data-slot="diff-tree" className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="relative shrink-0">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Filter ${total} files…`} aria-label="Filter files" className="h-8 pl-8 text-xs max-md:text-base" />
      </div>
      <ul role="tree" aria-label="Changed files" className="min-h-0 flex-1 overflow-y-auto pb-2 text-[13px]">
        {tree.length === 0 ? <li className="text-muted-foreground px-2 py-1 text-xs">No files match.</li>
          : <TreeRows nodes={tree} depth={0} closed={query ? {} : closed} toggle={toggle} active={active} onPick={onPick} isViewed={isViewed} />}
      </ul>
    </div>
  );
}

function TreeRows({ nodes, depth, closed, toggle, active, onPick, isViewed }: {
  nodes: TreeNode[]; depth: number; closed: Record<string, boolean>; toggle: (p: string) => void; active: string | null;
  onPick: (path: string) => void; isViewed: (f: FileDiff) => boolean;
}) {
  const pad = { paddingLeft: `${0.375 + depth * 0.875}rem` };
  return (
    <>
      {nodes.map((n) => n.kind === "dir" ? (
        <li key={`d:${n.path}`} role="treeitem" aria-expanded={!closed[n.path]}>
          <button type="button" style={pad} onClick={() => toggle(n.path)} data-slot="diff-tree-dir"
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full min-w-0 items-center gap-1 rounded-md py-1 pr-2 text-left max-md:py-2">
            {closed[n.path] ? <ChevronRight className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
            {closed[n.path] ? <Folder className="size-3.5 shrink-0" /> : <FolderOpen className="size-3.5 shrink-0" />}
            <span className="truncate">{n.name}</span>
          </button>
          {!closed[n.path] && (
            <ul role="group">
              <TreeRows nodes={n.children} depth={depth + 1} closed={closed} toggle={toggle} active={active} onPick={onPick} isViewed={isViewed} />
            </ul>
          )}
        </li>
      ) : (
        <li key={`f:${n.path}`} role="treeitem" aria-selected={active === n.path}>
          <button type="button" style={{ paddingLeft: `${0.375 + depth * 0.875 + 1.125}rem` }} onClick={() => onPick(n.path)} data-slot="diff-tree-file" data-path={n.path}
            className={cn("hover:bg-accent flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left max-md:py-2", active === n.path && "bg-accent text-foreground font-medium")}>
            <FileText className="text-muted-foreground size-3.5 shrink-0" />
            <span className={cn("min-w-0 flex-1 truncate", isViewed(n.file) && "text-muted-foreground")}>{n.name}</span>
            {isViewed(n.file) && <Check className="text-muted-foreground size-3 shrink-0" aria-label="Viewed" />}
            <StatusLetter status={n.file.status} />
          </button>
        </li>
      ))}
    </>
  );
}

const StatusLetter = ({ status }: { status: DiffStatus }) => (
  <Tip label={STATUS_LABEL[status]}>
    <span data-slot="diff-status" data-status={status} className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-semibold", STATUS_TONE[status])}>{STATUS_LETTER[status]}</span>
  </Tip>
);

// ---- one file ----

/** A path with the folders muted and the name strong; it truncates from the START, so the file name
 *  stays visible on a phone. */
function PathLabel({ file }: { file: FileDiff }) {
  const split = (p: string) => { const i = p.lastIndexOf("/"); return [p.slice(0, i + 1), p.slice(i + 1)]; };
  const [dir, name] = split(file.path);
  return (
    <span data-slot="diff-file-path" className="min-w-0 flex-1 truncate text-left font-mono text-xs [direction:rtl]">
      <bdi>
        {file.oldPath && <span className="text-muted-foreground">{file.oldPath} → </span>}
        <span className="text-muted-foreground">{dir}</span><span className="text-foreground font-medium">{name}</span>
      </bdi>
    </span>
  );
}

function FileSection({ file, open, loaded, viewed, view, wrap, compact, onToggle, onLoad, onViewed }: {
  file: FileDiff; open: boolean; loaded: boolean; viewed: boolean; view: ViewMode; wrap: boolean; compact: boolean;
  onToggle: (e: React.MouseEvent<HTMLElement>) => void; onLoad: () => void; onViewed: (f: FileDiff, on: boolean, header: HTMLElement) => void;
}) {
  const headerRef = useRef<HTMLDivElement>(null);
  const preview = useMemo(() => markdownPreview(file), [file]);
  // A new markdown file is a document to read: it opens rendered. An edit opens as code.
  const [rendered, setRendered] = useState(() => !!preview?.complete);
  const [copied, setCopied] = useState(false);
  const reason = collapseReason(file);
  const waiting = (reason === "generated" || reason === "large") && !loaded;

  return (
    <section id={fileAnchor(file.path)} data-slot="diff-file" data-path={file.path} data-open={open}
      className="bg-card min-w-0 scroll-mt-[calc(3.5rem+var(--stick,0px)+0.5rem)] rounded-lg border">
      {/* The sticky wrapper is a scroll-state container; styles.css squares the header's corners
          while it is stuck, so code scrolling under it can't peek through. No overflow clip on the
          section: a clipping ancestor kills sticky. */}
      <div className={cn("sticky z-10 [container-type:scroll-state]", STICK_TOP)}>
        <div ref={headerRef} data-slot="diff-file-header"
          className={cn("bg-card flex min-h-10 min-w-0 items-center gap-1.5 px-1.5 py-1", open ? "rounded-t-lg border-b" : "rounded-lg")}>
          <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={open ? "Collapse file" : "Expand file"} aria-expanded={open} onClick={onToggle}>
            {open ? <ChevronDown /> : <ChevronRight />}
          </Button>
          <StatusLetter status={file.status} />
          <PathLabel file={file} />
          <span className="shrink-0 font-mono text-xs tabular-nums">
            <span className="text-geist-green">+{file.additions}</span> <span className="text-geist-red">−{file.deletions}</span>
          </span>
          {preview && (
            <span className="hidden shrink-0 items-center sm:inline-flex">
              <Tip label="Show the code"><Button variant="ghost" size="icon" className={cn("size-7", !rendered && "bg-accent text-foreground")} aria-label="Show the code" aria-pressed={!rendered} onClick={() => setRendered(false)}><FileCode /></Button></Tip>
              <Tip label="Show the rendered file"><Button variant="ghost" size="icon" className={cn("size-7", rendered && "bg-accent text-foreground")} aria-label="Show the rendered file" aria-pressed={rendered} onClick={() => setRendered(true)}><FileText /></Button></Tip>
            </span>
          )}
          <Tip label={copied ? "Copied" : "Copy path"}>
            <Button variant="ghost" size="icon" className="size-7 shrink-0 max-sm:hidden" aria-label="Copy path"
              onClick={async () => { if (await copyText(file.path, "path")) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}>
              {copied ? <Check /> : <Copy />}
            </Button>
          </Tip>
          <label className="hover:bg-accent flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-xs">
            <Checkbox checked={viewed} aria-label="Viewed" onCheckedChange={(v) => headerRef.current && onViewed(file, v === true, headerRef.current)} />
            <span className="max-sm:sr-only">Viewed</span>
          </label>
        </div>
      </div>
      {open && (
        <div data-slot="diff-file-body" className="min-w-0">
          {preview && (
            // On a phone the header has no room for the toggle: it sits on top of the body.
            <div className="flex items-center gap-2 border-b px-3 py-1.5 sm:hidden">
              <Segmented label="File view" size="sm" value={rendered ? "rendered" : "code"} onChange={(v) => setRendered(v === "rendered")}
                options={[{ value: "code", label: "Code" }, { value: "rendered", label: "Rendered" }]} />
            </div>
          )}
          {file.binary ? <Note>Binary file not shown.</Note>
            : file.hunks.length === 0 ? <Note>{emptyNote(file)}</Note>
            : waiting ? (
              <div data-slot="diff-load" className="flex flex-col items-center gap-2 px-4 py-6 text-center">
                <p className="text-muted-foreground text-xs">{reason === "generated" ? "This is a generated file. Its diff is hidden by default." : `This diff is large (${file.additions + file.deletions} lines). It is hidden by default.`}</p>
                <Button variant="outline" size="sm" onClick={onLoad}>Load diff</Button>
              </div>
            )
            : rendered && preview ? <MarkdownPreview sections={preview.sections} complete={preview.complete} />
            : <DiffBody file={file} view={view} wrap={wrap} compact={compact} />}
        </div>
      )}
    </section>
  );
}

const emptyNote = (f: FileDiff) =>
  f.status === "renamed" ? "File renamed without changes." : f.status === "added" ? "Empty file added." : f.status === "deleted" ? "Empty file deleted." : "File mode changed.";

const Note = ({ children }: { children: ReactNode }) => <p data-slot="diff-note" className="text-muted-foreground px-4 py-3 text-xs">{children}</p>;

function MarkdownPreview({ sections, complete }: { sections: string[]; complete: boolean }) {
  return (
    <div data-slot="diff-markdown" className="min-w-0 px-4 py-3 max-sm:px-3">
      {!complete && <p className="text-muted-foreground mb-3 text-xs">This shows the changed sections of the file only.</p>}
      {sections.map((s, i) => (
        <div key={i} className={cn("min-w-0", i > 0 && "mt-4 border-t border-dashed pt-4")}><Markdown>{s}</Markdown></div>
      ))}
    </div>
  );
}

// ---- the code ----

const ROW_TONE = { add: "bg-emerald-500/10 dark:bg-emerald-500/15", del: "bg-red-500/10 dark:bg-red-500/15", ctx: "" };
const GUTTER_TONE = { add: "bg-emerald-500/15 dark:bg-emerald-500/20", del: "bg-red-500/15 dark:bg-red-500/20", ctx: "" };
const SIGN = { add: "+", del: "−", ctx: " " };

/** One prism pass per hunk — the lines in order, so `tokens[i]` is `hunk.lines[i]` in both views. */
function useCodeTheme() {
  useTheme(); // prism paints colours inline: a dark grammar theme under `.dark`
  return document.documentElement.classList.contains("dark") ? themes.vsDark : themes.github;
}

/** `compact`: a phone — one narrow line-number column (`rowNumbers`), so the code gets the width. */
const DiffBody = memo(({ file, view, wrap, compact }: { file: FileDiff; view: ViewMode; wrap: boolean; compact: boolean }) => {
  const theme = useCodeTheme();
  const digits = gutterDigits(file);
  // The code box is a size container, so a hunk header can be as wide as the box (100cqw) and stay
  // put while long lines scroll sideways under it.
  return (
    <div data-slot="diff-code" className="overflow-x-auto rounded-b-lg font-mono text-xs leading-5 [container-type:inline-size]">
      <div className={cn(!wrap && view === "unified" && "w-max min-w-full")}>
        {file.hunks.map((h, j) => (
          <Highlight key={j} theme={theme} code={h.lines.map((l) => l.text).join("\n")} language={file.lang}>
            {({ tokens, getTokenProps }) => {
              // Only the inline colour, never prism's class names: a markdown table's tokens are
              // `token table`, and Tailwind's `.table` (display: table) put every cell on its own line.
              const code = (i: number | undefined) => i === undefined ? null : (tokens[i] ?? []).map((t, k) => {
                const { children, style } = getTokenProps({ token: t as Token });
                return <span key={k} style={style}>{children}</span>;
              });
              return (
                <div data-slot="diff-hunk">
                  <div data-slot="diff-hunk-header" className="bg-geist-blue/5 text-muted-foreground sticky left-0 w-[100cqw] truncate px-3 py-1">
                    {hunkLabel(h)}
                  </div>
                  {view === "unified"
                    ? h.lines.map((l, i) => <UnifiedRow key={i} line={l} numbers={rowNumbers(l, file.status, compact)} digits={digits} compact={compact} wrap={wrap}>{code(i)}</UnifiedRow>)
                    : splitRows(h).map((r, i) => (
                      <div key={i} data-slot="diff-split-row" className="grid grid-cols-2">
                        <SplitHalf line={r.left} side="old" digits={digits}>{code(r.leftIndex)}</SplitHalf>
                        <SplitHalf line={r.right} side="new" digits={digits}>{code(r.rightIndex)}</SplitHalf>
                      </div>
                    ))}
                </div>
              );
            }}
          </Highlight>
        ))}
      </div>
    </div>
  );
});

/** `@@ -12,7 +12,9 @@ function x()` → the numbers, then the section git found. */
const hunkLabel = (h: Hunk) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? ` ${h.section}` : ""}`;

const Num = ({ n, digits, tone, compact }: { n?: number; digits: number; tone: string; compact?: boolean }) => (
  <span data-slot="diff-num" className={cn("text-muted-foreground/70 shrink-0 text-right select-none", compact ? "px-1" : "px-2", tone)}
    style={{ width: `calc(${digits}ch + ${compact ? "0.5rem" : "1rem"})` }}>{n ?? ""}</span>
);

function UnifiedRow({ line, numbers, digits, compact, wrap, children }: { line: DiffLine; numbers: (number | undefined)[]; digits: number; compact: boolean; wrap: boolean; children: ReactNode }) {
  return (
    <div data-slot="diff-line" data-type={line.type} className={cn("flex", ROW_TONE[line.type])}>
      {numbers.map((n, i) => <Num key={i} n={n} digits={digits} compact={compact} tone={GUTTER_TONE[line.type]} />)}
      <span className={cn(compact ? "w-4" : "w-5", "shrink-0 text-center select-none", line.type === "add" ? "text-geist-green" : line.type === "del" ? "text-geist-red" : "text-muted-foreground")}>{SIGN[line.type]}</span>
      <span className={cn("pr-4", wrap ? "min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere" : "flex-1 whitespace-pre")}>{children}{line.noNewline && <NoNewline />}</span>
    </div>
  );
}

/** Split view always wraps: two columns of half the width side by side, never wider than the box. */
function SplitHalf({ line, side, digits, children }: { line?: DiffLine; side: "old" | "new"; digits: number; children: ReactNode }) {
  if (!line) return <div className={cn("bg-muted/40", side === "new" && "border-l")} />;
  const type = line.type;
  return (
    <div data-slot="diff-line" data-type={type} className={cn("flex min-w-0", ROW_TONE[type], side === "new" && "border-l")}>
      <Num n={side === "old" ? line.old : line.new} digits={digits} tone={GUTTER_TONE[type]} />
      <span className={cn("w-4 shrink-0 text-center select-none", type === "add" ? "text-geist-green" : type === "del" ? "text-geist-red" : "text-muted-foreground")}>{SIGN[type]}</span>
      <span className="min-w-0 flex-1 pr-3 whitespace-pre-wrap wrap-anywhere">{children}{line.noNewline && <NoNewline />}</span>
    </div>
  );
}

const NoNewline = () => <span className="text-geist-red ml-1 select-none" aria-label="No newline at end of file">⊘</span>;
