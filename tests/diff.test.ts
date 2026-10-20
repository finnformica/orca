// The Files changed page's pure logic (web/src/diff.ts) against real diffs from orca's own PRs
// (tests/fixtures/diffs, excerpts of GitHub's `application/vnd.github.diff`): a 54-file PR with
// deep folders (#351), a rename (#161), a deleted file (#333), a binary image (#135), a lockfile
// (#192), a long new markdown file (#289) and an edited one with very long lines.
import { describe, expect, test } from "bun:test";
import {
  LARGE_DIFF_LINES, buildFileTree, collapseReason, diffTotals, fileAnchor, fileSig, filterFiles, gutterDigits,
  isGenerated, markdownPreview, parseDiff, splitRows, treeDirs, treeOrder, type FileDiff, type TreeDir,
} from "@/diff";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/diffs/${name}`, import.meta.url)).text();
/** The first file of a diff (each sample here has at least one). */
const first = (text: string): FileDiff => { const f = parseDiff(text)[0]; if (!f) throw new Error("no file"); return f; };

describe("parseDiff", () => {
  test("a one-line change: status, counts and line numbers on both sides", () => {
    const f = first("diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +10,3 @@ function x() {\n ctx\n-old\n+new\n ctx2\n");
    expect(f).toMatchObject({ path: "a.ts", status: "modified", additions: 1, deletions: 1, binary: false, lang: "tsx" });
    expect(f.hunks[0]!.section).toBe("function x() {");
    expect(f.hunks[0]!.lines).toEqual([
      { type: "ctx", text: "ctx", old: 10, new: 10 },
      { type: "del", text: "old", old: 11 },
      { type: "add", text: "new", new: 11 },
      { type: "ctx", text: "ctx2", old: 12, new: 12 },
    ]);
  });

  test("a deleted line that reads like a header stays code (hunk counts decide)", () => {
    const f = first("diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n--- a/heading\n+++ b/heading\n");
    expect(f.path).toBe("x.md");
    expect(f.hunks[0]!.lines.map((l) => l.type)).toEqual(["del", "add"]);
    expect(f.hunks[0]!.lines[0]!.text).toBe("-- a/heading");
  });

  test("a path with a space", () => {
    const f = first("diff --git a/docs/my file.md b/docs/my file.md\n--- a/docs/my file.md\n+++ b/docs/my file.md\n@@ -1 +1 @@\n-a\n+b\n");
    expect(f.path).toBe("docs/my file.md");
    expect(f.status).toBe("modified");
  });

  test("a rename keeps the old path (#161)", async () => {
    const f = first(await fixture("pr161-rename.diff"));
    expect(f).toMatchObject({ status: "renamed", oldPath: "tests/queuedActionToast.test.tsx", path: "tests/queuedAction.test.tsx" });
    expect(f.additions).toBeGreaterThan(0);
  });

  test("a deleted file (#333)", async () => {
    const f = first(await fixture("pr333-deleted.diff"));
    expect(f).toMatchObject({ status: "deleted", path: "tests/agentStatus.test.tsx", additions: 0, deletions: 73 });
    expect(f.hunks[0]!.lines.every((l) => l.type === "del" && l.new === undefined)).toBe(true);
  });

  test("a binary image has no hunks (#135)", async () => {
    const f = first(await fixture("pr135-binary.diff"));
    expect(f).toMatchObject({ status: "added", binary: true, path: "web/public/icon-192.png", hunks: [] });
  });

  test("a symlink's '\\ No newline' marks the line, never becomes one (#351)", async () => {
    const files = parseDiff(await fixture("pr351-big.diff"));
    const bun = files.find((f) => f.path === "bin/worker/bun")!;
    expect(bun.status).toBe("added");
    expect(bun.hunks[0]!.lines).toEqual([{ type: "add", text: ".heavy-shim", new: 1, noNewline: true }]);
  });

  test("54 files; totals match the parsed counts", async () => {
    const files = parseDiff(await fixture("pr351-big.diff"));
    expect(files.length).toBe(54);
    const t = diffTotals(files);
    expect(t.files).toBe(54);
    expect(t.additions).toBe(files.reduce((s, f) => s + f.additions, 0));
    expect(t.additions).toBeGreaterThan(1000);
  });
});

describe("file tree", () => {
  test("folders first, A–Z; single-folder chains join on one row", () => {
    const files = parseDiff([
      "diff --git a/web/src/views/A.tsx b/web/src/views/A.tsx\n@@ -1 +1 @@\n-a\n+b",
      "diff --git a/web/src/views/B.tsx b/web/src/views/B.tsx\n@@ -1 +1 @@\n-a\n+b",
      "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-a\n+b",
      "diff --git a/server/x.ts b/server/x.ts\n@@ -1 +1 @@\n-a\n+b",
    ].join("\n"));
    const tree = buildFileTree(files);
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual(["dir:server", "dir:web/src/views", "file:README.md"]);
    const views = tree[1] as TreeDir;
    expect(views.path).toBe("web/src/views");
    expect(views.children.map((n) => n.name)).toEqual(["A.tsx", "B.tsx"]);
    expect(treeOrder(tree).map((f) => f.path)).toEqual(["server/x.ts", "web/src/views/A.tsx", "web/src/views/B.tsx", "README.md"]);
  });

  test("the big PR: every file once, in tree order; deep folders", async () => {
    const files = parseDiff(await fixture("pr351-big.diff"));
    const tree = buildFileTree(files);
    const ordered = treeOrder(tree);
    expect(ordered.length).toBe(54);
    expect(new Set(ordered.map((f) => f.path))).toEqual(new Set(files.map((f) => f.path)));
    const dirs = treeDirs(tree);
    expect(dirs).toContain("bin/worker");
    expect(dirs).toContain("server");
    // the root's top level: folders before CLAUDE.md
    const top = tree.map((n) => n.kind);
    expect(top.indexOf("file")).toBeGreaterThan(top.lastIndexOf("dir"));
  });

  test("filter: every word must match, any case; the old path of a rename counts", async () => {
    const files = parseDiff(await fixture("pr351-big.diff"));
    expect(filterFiles(files, "").length).toBe(54);
    expect(filterFiles(files, "WORKER esl").map((f) => f.path)).toEqual(["bin/worker/eslint"]);
    const renamed = parseDiff(await fixture("pr161-rename.diff"));
    expect(filterFiles(renamed, "Toast").length).toBe(1);
  });

  test("anchors are DOM-safe and distinct", () => {
    expect(fileAnchor("web/src/a b.tsx")).toBe("diff-web_src_a_b_tsx");
  });
});

describe("collapsed by default", () => {
  test("a lockfile is generated (#192)", async () => {
    const f = first(await fixture("pr192-lockfile.diff"));
    expect(isGenerated(f.path)).toBe(true);
    expect(collapseReason(f)).toBe("generated");
    expect(isGenerated("web/package-lock.json")).toBe(true);
    expect(isGenerated("web/src/lock.ts")).toBe(false);
  });

  test("a large diff, a deleted file; a small file and a binary stay open", async () => {
    const lines = Array.from({ length: LARGE_DIFF_LINES }, (_, i) => `+l${i}`).join("\n");
    const big = first(`diff --git a/big.ts b/big.ts\nnew file mode 100644\n--- /dev/null\n+++ b/big.ts\n@@ -0,0 +1,${LARGE_DIFF_LINES} @@\n${lines}\n`);
    expect(big.additions).toBe(LARGE_DIFF_LINES);
    expect(collapseReason(big)).toBe("large");
    expect(collapseReason(first(await fixture("pr333-deleted.diff")))).toBe("deleted");
    expect(collapseReason(first(await fixture("pr161-rename.diff")))).toBeNull();
    expect(collapseReason(first(await fixture("pr135-binary.diff")))).toBeNull();
  });
});

describe("split view", () => {
  test("deletions pair with additions; the longer side gets empty partners; context on both", () => {
    const f = first("diff --git a/a b/a\n@@ -1,5 +1,3 @@\n c\n-d1\n-d2\n+a1\n c2\n-d3\n");
    const rows = splitRows(f.hunks[0]!);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["c", "c"], ["d1", "a1"], ["d2", null], ["c2", "c2"], ["d3", null],
    ]);
    expect(rows[1]).toMatchObject({ leftIndex: 1, rightIndex: 3 });
  });
});

describe("markdown rendered view", () => {
  test("a new markdown file is complete (#289's ADAPTERS.md)", async () => {
    const f = first(await fixture("pr289-markdown.diff"));
    expect(f.status).toBe("added");
    const p = markdownPreview(f)!;
    expect(p.complete).toBe(true);
    expect(p.sections.length).toBe(1);
    expect(p.sections[0]!.split("\n").length).toBe(f.additions);
  });

  test("an edited file renders its changed sections only, without deleted lines", async () => {
    const f = first(await fixture("pr289-claude-md.diff"));
    const p = markdownPreview(f)!;
    expect(p.complete).toBe(false);
    expect(p.sections.length).toBe(f.hunks.length);
    const deleted = f.hunks.flatMap((h) => h.lines).filter((l) => l.type === "del").map((l) => l.text);
    for (const d of deleted) if (d.trim()) expect(p.sections.join("\n").split("\n")).not.toContain(d);
  });

  test("no rendered view for a deleted or a non-markdown file", async () => {
    expect(markdownPreview(first(await fixture("pr333-deleted.diff")))).toBeNull();
    const deletedMd = first("diff --git a/x.md b/x.md\ndeleted file mode 100644\n--- a/x.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n");
    expect(markdownPreview(deletedMd)).toBeNull();
  });
});

test("gutter width and Viewed signature", async () => {
  const files = parseDiff(await fixture("pr289-claude-md.diff"));
  expect(gutterDigits(files[0]!)).toBe(3); // CLAUDE.md's hunk ends at line 206
  const a = first("diff --git a/a b/a\n@@ -1 +1 @@\n-x\n+y\n");
  const b = first("diff --git a/a b/a\n@@ -1 +1 @@\n-x\n+z\n");
  expect(fileSig(a)).not.toBe(fileSig(b));
  expect(fileSig(a)).toBe(fileSig(first("diff --git a/a b/a\n@@ -1 +1 @@\n-x\n+y\n")));
});
