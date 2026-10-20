// The Files changed page's pure logic: a unified diff (GitHub's `application/vnd.github.diff`, or
// `git diff base...HEAD` for a local branch) parsed into files with status, line numbers and counts;
// the file tree beside it; the order, the filter, the split-view pairs, which files start collapsed,
// and the text of a markdown file's rendered view. No React, no IO — imported by the view and tests.

export type DiffStatus = "added" | "modified" | "deleted" | "renamed";
/** One code line. `old` / `new` are its line numbers on each side (a deleted line has no `new`). */
export type DiffLine = { type: "add" | "del" | "ctx"; text: string; old?: number; new?: number; noNewline?: boolean };
/** `section`: the text git puts after the second `@@` (the enclosing function, if it found one). */
export type Hunk = { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; section: string; lines: DiffLine[] };
export type FileDiff = {
  path: string;
  /** The path before a rename. */
  oldPath?: string;
  status: DiffStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
  /** The prism grammar for its extension. */
  lang: string;
};

const LANGS: Record<string, string> = {
  ts: "tsx", tsx: "tsx", js: "jsx", jsx: "jsx", mjs: "jsx", cjs: "jsx",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
  css: "css", scss: "scss", json: "json", md: "markdown", mdx: "markdown", yml: "yaml", yaml: "yaml",
  sh: "bash", bash: "bash", sql: "sql", html: "markup", svg: "markup", xml: "markup", tf: "hcl",
};
export const langOf = (path: string): string => {
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  return LANGS[ext] ?? (ext ? "text" : "bash"); // an extensionless file is mostly a script (bin/*)
};

/** `a/x b/x` → the two paths. A path with a space splits in the middle when both halves agree
 *  (the common case, no rename); otherwise at the last ` b/`. Quoted paths lose their quotes. */
function headerPaths(rest: string): [string, string] {
  const unq = (s: string) => s.replace(/^"|"$/g, "");
  const mid = (rest.length - 1) / 2;
  if (Number.isInteger(mid) && rest[mid] === " ") {
    const a = unq(rest.slice(0, mid)), b = unq(rest.slice(mid + 1));
    if (a.slice(2) === b.slice(2)) return [a.slice(2), b.slice(2)];
  }
  const at = rest.lastIndexOf(" b/");
  if (at < 0) return [rest, rest];
  return [unq(rest.slice(0, at)).replace(/^a\//, ""), unq(rest.slice(at + 1)).replace(/^b\//, "")];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldLeft = 0, newLeft = 0, oldNo = 0, newNo = 0;
  for (const line of text.replace(/\n$/, "").split("\n")) {
    // Inside a hunk, its header's counts say how many lines belong to it — so a deleted line that
    // reads "-- x" is code, never mistaken for a `--- a/path` header.
    if (hunk && file && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === "+") { hunk.lines.push({ type: "add", text: line.slice(1), new: newNo++ }); newLeft--; file.additions++; continue; }
      if (c === "-") { hunk.lines.push({ type: "del", text: line.slice(1), old: oldNo++ }); oldLeft--; file.deletions++; continue; }
      if (c === " " || line === "") { hunk.lines.push({ type: "ctx", text: line.slice(1), old: oldNo++, new: newNo++ }); oldLeft--; newLeft--; continue; }
      if (c === "\\") { const last = hunk.lines[hunk.lines.length - 1]; if (last) last.noNewline = true; continue; }
      // anything else ends the hunk early (a malformed count): fall through to the headers
    }
    if (hunk && line.startsWith("\\")) { const last = hunk.lines[hunk.lines.length - 1]; if (last) last.noNewline = true; continue; }
    if (line.startsWith("diff --git ")) {
      const [a, b] = headerPaths(line.slice(11));
      file = { path: b, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [], lang: langOf(b) };
      if (a !== b) { file.oldPath = a; file.status = "renamed"; }
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    const m = HUNK.exec(line);
    if (m) {
      hunk = { header: line, oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), section: m[5] ?? "", lines: [] };
      oldLeft = hunk.oldLines; newLeft = hunk.newLines; oldNo = hunk.oldStart; newNo = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }
    if (hunk) continue;
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) { file.oldPath = line.slice(12); file.status = "renamed"; }
    else if (line.startsWith("rename to ")) { file.path = line.slice(10); file.lang = langOf(file.path); }
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
    else if (line === "--- /dev/null") file.status = "added";
    else if (line === "+++ /dev/null") file.status = "deleted";
    else if (line.startsWith("+++ b/")) { file.path = line.slice(6); file.lang = langOf(file.path); }
  }
  for (const f of files) if (f.status === "renamed" && f.oldPath === f.path) { f.status = "modified"; delete f.oldPath; }
  return files;
}

export const STATUS_LETTER: Record<DiffStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

// ---- which files start collapsed ----

/** A diff this many changed lines or longer starts collapsed behind Load diff (GitHub: "Large diffs
 *  are not rendered by default"). Rendering a few thousand highlighted lines stalls the page. */
export const LARGE_DIFF_LINES = 400;

const GENERATED = [
  /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|flake\.lock)$/,
  /\.min\.(js|css)$/, /\.map$/, /\.snap$/, /(^|\/)(dist|vendor)\//,
];
/** A lockfile or another machine-written file: nobody reviews it line by line. */
export const isGenerated = (path: string): boolean => GENERATED.some((r) => r.test(path));

export type CollapseReason = "generated" | "large" | "deleted" | null;
/** Why a file starts collapsed, or null. A deleted file shows only "removed" lines, so like GitHub
 *  it starts folded (`deleted`) — but it opens with the chevron, no Load diff. */
export function collapseReason(f: FileDiff): CollapseReason {
  if (f.hunks.length === 0) return null;
  if (isGenerated(f.path)) return "generated";
  if (f.additions + f.deletions >= LARGE_DIFF_LINES) return "large";
  if (f.status === "deleted") return "deleted";
  return null;
}

// ---- the file tree ----

export type TreeDir = { kind: "dir"; name: string; path: string; children: TreeNode[] };
export type TreeFile = { kind: "file"; name: string; path: string; file: FileDiff };
export type TreeNode = TreeDir | TreeFile;

/** The sidebar's tree: folders first, then files, each A–Z (GitHub's order). A folder with one
 *  folder and no files in it joins its child on one row (`web/src`), like GitHub's tree. */
export function buildFileTree(files: FileDiff[]): TreeNode[] {
  const root: TreeDir = { kind: "dir", name: "", path: "", children: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    const name = parts.pop() ?? file.path;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let next = dir.children.find((c): c is TreeDir => c.kind === "dir" && c.path === path);
      if (!next) { next = { kind: "dir", name: part, path, children: [] }; dir.children.push(next); }
      dir = next;
    });
    dir.children.push({ kind: "file", name, path: file.path, file });
  }
  const tidy = (nodes: TreeNode[]): TreeNode[] => nodes
    .map((n) => {
      if (n.kind === "file") return n;
      let d: TreeDir = { ...n, children: tidy(n.children) };
      for (let only = d.children[0]; d.children.length === 1 && only?.kind === "dir"; only = d.children[0]) {
        d = { kind: "dir", name: `${d.name}/${only.name}`, path: only.path, children: only.children };
      }
      return d;
    })
    .sort((a, b) => a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name));
  return tidy(root.children);
}

/** The files in the tree's top-to-bottom order — the diff list uses it too, so the list and the
 *  tree read the same way down. */
export function treeOrder(nodes: TreeNode[]): FileDiff[] {
  return nodes.flatMap((n) => n.kind === "file" ? [n.file] : treeOrder(n.children));
}

/** Every folder path in a tree (to open them all, or to count them). */
export function treeDirs(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => n.kind === "dir" ? [n.path, ...treeDirs(n.children)] : []);
}

/** The tree's filter box: each space-separated word must appear in the path (any case). */
export function filterFiles(files: FileDiff[], query: string): FileDiff[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return files;
  return files.filter((f) => {
    const hay = `${f.oldPath ?? ""} ${f.path}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Totals for the toolbar. */
export function diffTotals(files: FileDiff[]): { files: number; additions: number; deletions: number } {
  return { files: files.length, additions: files.reduce((s, f) => s + f.additions, 0), deletions: files.reduce((s, f) => s + f.deletions, 0) };
}

/** A stable DOM id for a file's section, for the tree's jump links. */
export const fileAnchor = (path: string): string => `diff-${path.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** What "Viewed" remembers about a file: a change to its diff after you marked it clears the mark
 *  (GitHub does the same). A short hash of the diff text. */
export function fileSig(f: FileDiff): string {
  let h = 5381;
  for (const hk of f.hunks) for (const l of hk.lines) {
    const s = l.type[0] + l.text;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return `${f.additions}.${f.deletions}.${(h >>> 0).toString(36)}`;
}

// ---- split view ----

/** One split-view row: the old line on the left, the new one on the right. */
export type SplitRow = { left?: DiffLine; right?: DiffLine; leftIndex?: number; rightIndex?: number };

/** A hunk as split rows. A run of deletions followed by additions pairs up line by line (a change);
 *  the longer side's extra lines get an empty partner. Context sits on both sides. The indexes
 *  point back into `hunk.lines`, so the view reuses the hunk's one highlight pass. */
export function splitRows(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const ls = hunk.lines;
  let i = 0;
  while (i < ls.length) {
    const line = ls[i]!;
    if (line.type === "ctx") { rows.push({ left: line, right: line, leftIndex: i, rightIndex: i }); i++; continue; }
    const dels: number[] = [], adds: number[] = [];
    while (ls[i]?.type === "del") dels.push(i++);
    while (ls[i]?.type === "add") adds.push(i++);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const d = dels[k], a = adds[k];
      rows.push({ left: d === undefined ? undefined : ls[d], leftIndex: d, right: a === undefined ? undefined : ls[a], rightIndex: a });
    }
  }
  return rows;
}

// ---- markdown rendered view ----

export const isMarkdown = (path: string): boolean => /\.(md|mdx|markdown)$/i.test(path);

/** The text a markdown file's rendered view shows: the new side of each hunk (context + added
 *  lines). A new file's diff holds the whole file, so `complete` is true; an edited file's diff holds
 *  only the changed sections — the view renders those one by one and says so. A deleted file has
 *  no new side: null. */
export function markdownPreview(f: FileDiff): { sections: string[]; complete: boolean } | null {
  if (!isMarkdown(f.path) || f.status === "deleted" || f.binary || f.hunks.length === 0) return null;
  const sections = f.hunks.map((h) => h.lines.filter((l) => l.type !== "del").map((l) => l.text).join("\n"));
  const only = f.hunks.length === 1 ? f.hunks[0] : undefined;
  const complete = f.status === "added" || (!!only && only.newStart <= 1 && only.oldLines === 0);
  return { sections, complete };
}

/** The widest line number in a file, in digits — the gutter's width. */
export function gutterDigits(f: FileDiff): number {
  let max = 1;
  for (const h of f.hunks) max = Math.max(max, h.oldStart + h.oldLines, h.newStart + h.newLines);
  return String(max).length;
}

/** The line numbers a unified row shows, left to right. A wide page: old and new, minus the side an
 *  added or a deleted file does not have. A narrow page (`compact`, a phone) has no width for two
 *  columns: ONE — the new number, or the old one for a deleted line (its red row says which side). */
export function rowNumbers(line: DiffLine, status: DiffStatus, compact: boolean): (number | undefined)[] {
  if (compact) return [line.type === "del" ? line.old : line.new];
  if (status === "added") return [line.new];
  if (status === "deleted") return [line.old];
  return [line.old, line.new];
}
