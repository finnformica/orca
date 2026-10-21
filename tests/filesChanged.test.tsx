// E2E for the Files changed tab (views/FilesChanged.tsx), rendered over real diffs from orca's own
// PRs (tests/fixtures/diffs): the 54-file #351 plus a lockfile, a long new markdown file, a deleted
// file, a rename and a binary image. GitHub's page is the model: a file tree beside the list, sticky
// file headers, Load diff for a lockfile, a folded deleted file, Viewed, a rendered markdown view.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FilesChanged } from "@/views/FilesChanged";
import { Markdown } from "@/components/Markdown";
import { buildFileTree, parseDiff, treeOrder } from "@/diff";
import { persistedKey } from "@/lib/persisted";
import { NARROW_QUERY } from "@/lib/viewport";
import { RESIZE_STEP } from "@/components/SidePanel";
import { clampTreeWidth, TREE_DEFAULT_W, TREE_MIN_W } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = () => new Promise((r) => setTimeout(r, 0));
const fixture = (name: string) => Bun.file(new URL(`./fixtures/diffs/${name}`, import.meta.url)).text();

let root: Root | undefined;
let container: HTMLElement | undefined;
let text = "";
const prevInnerWidth = window.innerWidth;

beforeEach(async () => {
  localStorage.clear();
  text = (await Promise.all(["pr351-big.diff", "pr192-lockfile.diff", "pr289-markdown.diff", "pr333-deleted.diff", "pr161-rename.diff", "pr135-binary.diff"].map(fixture))).join("\n");
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  // A test below sets window.innerWidth for the resize-clamp math; restore it so a later FILE in the
  // same bun test process (the whole suite runs in one process) doesn't inherit it.
  Object.defineProperty(window, "innerWidth", { value: prevInnerWidth, configurable: true });
});

async function mount(node = <FilesChanged text={text} scope="orca#1" />) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); });
}
const q = <T extends HTMLElement = HTMLElement>(sel: string) => container!.querySelector<T>(sel);
const qa = <T extends HTMLElement = HTMLElement>(sel: string) => [...container!.querySelectorAll<T>(sel)];
const section = (path: string) => q(`[data-slot=diff-file][data-path="${path}"]`)!;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); }); };

describe("Files changed", () => {
  test("the tree lists every file once, with its status; the list follows the tree's order", async () => {
    await mount();
    const files = parseDiff(text);
    expect(files.length).toBe(59);
    const tree = q("[data-slot=diff-tree-sidebar]")!;
    const rows = [...tree.querySelectorAll<HTMLElement>("[data-slot=diff-tree-file]")];
    expect(rows.length).toBe(59);
    expect(tree.textContent).toContain("bin/worker"); // a folder row, joined onto one line
    const order = treeOrder(buildFileTree(files)).map((f) => f.path);
    expect(rows.map((r) => r.dataset.path)).toEqual(order);
    expect(qa("[data-slot=diff-file]").map((s) => s.dataset.path)).toEqual(order);
    const status = (path: string) => tree.querySelector(`[data-path="${path}"] [data-slot=diff-status]`)!.textContent;
    expect(status("tests/agentStatus.test.tsx")).toBe("D");
    expect(status("tests/queuedAction.test.tsx")).toBe("R");
    expect(status("CLAUDE.md")).toBe("M");
    expect(status("web/public/icon-192.png")).toBe("A");
    expect(q("[data-slot=diff-toolbar]")!.textContent).toContain("59 files");
  });

  test("a folder folds in the tree", async () => {
    await mount();
    const tree = q("[data-slot=diff-tree-sidebar]")!;
    const dir = [...tree.querySelectorAll<HTMLElement>("[data-slot=diff-tree-dir]")].find((d) => d.textContent === "bin/worker")!;
    expect(tree.querySelector('[data-path="bin/worker/eslint"]')).not.toBeNull();
    await click(dir);
    expect(tree.querySelector('[data-path="bin/worker/eslint"]')).toBeNull();
  });

  test("a lockfile waits behind Load diff; a deleted file starts folded", async () => {
    await mount();
    const lock = section("bun.lock");
    expect(lock.querySelector("[data-slot=diff-line]")).toBeNull();
    expect(lock.textContent).toContain("generated file");
    await click([...lock.querySelectorAll("button")].find((b) => b.textContent === "Load diff")!);
    expect(section("bun.lock").querySelector("[data-slot=diff-line]")).not.toBeNull();

    const del = section("tests/agentStatus.test.tsx");
    expect(del.dataset.open).toBe("false");
    await click(del.querySelector("[aria-label='Expand file']")!);
    expect(section("tests/agentStatus.test.tsx").querySelectorAll("[data-slot=diff-line][data-type=del]").length).toBe(73);
  });

  test("line numbers, the hunk header, the binary note and the rename's old path", async () => {
    await mount();
    const rename = section("tests/queuedAction.test.tsx");
    expect(rename.querySelector("[data-slot=diff-file-path]")!.textContent).toContain("tests/queuedActionToast.test.tsx → tests/queuedAction.test.tsx");
    const hunk = rename.querySelector("[data-slot=diff-hunk-header]")!;
    expect(hunk.textContent).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/);
    const first = rename.querySelector<HTMLElement>("[data-slot=diff-line]")!;
    const nums = [...first.children].slice(0, 2).map((c) => c.textContent);
    const [h] = parseDiff(await fixture("pr161-rename.diff"))[0]!.hunks;
    expect(nums).toEqual([String(h!.lines[0]!.old ?? ""), String(h!.lines[0]!.new ?? "")]);
    expect(section("web/public/icon-192.png").textContent).toContain("Binary file not shown.");
    // An added file has no old side: one number column (new), the sign, the code.
    const added = section("bin/worker/bun").querySelector<HTMLElement>("[data-slot=diff-line]")!;
    expect([...added.children].map((c) => c.textContent)).toEqual(["1", "+", ".heavy-shim⊘"]);
  });

  test("a new markdown file opens rendered, wraps, and toggles to code", async () => {
    await mount();
    const md = section("docs/integrations/ADAPTERS.md");
    const rendered = md.querySelector("[data-slot=diff-markdown]")!;
    expect(rendered).not.toBeNull();
    const prose = rendered.querySelector<HTMLElement>("[data-slot=markdown]")!;
    expect(prose.className).toContain("wrap-anywhere");
    expect(prose.className).toContain("min-w-0");
    expect(rendered.querySelector("h1, h2")).not.toBeNull();
    expect(md.querySelector("[data-slot=diff-line]")).toBeNull();
    await click(md.querySelector("[aria-label='Show the code']")!);
    expect(section("docs/integrations/ADAPTERS.md").querySelector("[data-slot=diff-line]")).not.toBeNull();
    // An edited markdown file opens as code.
    expect(section("CLAUDE.md").querySelector("[data-slot=diff-markdown]")).toBeNull();
  });

  test("the filter narrows the tree and the list", async () => {
    await mount();
    const input = q<HTMLInputElement>("[data-slot=diff-tree-sidebar] input")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "worker esl");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    expect(qa("[data-slot=diff-tree-sidebar] [data-slot=diff-tree-file]").map((r) => r.dataset.path)).toEqual(["bin/worker/eslint"]);
    expect(qa("[data-slot=diff-file]").map((s) => s.dataset.path)).toEqual(["bin/worker/eslint"]);
  });

  test("Viewed folds the file, counts it and is remembered per PR", async () => {
    await mount();
    const s = section("CLAUDE.md");
    await click(s.querySelector("[data-slot=checkbox]")!);
    expect(section("CLAUDE.md").dataset.open).toBe("false");
    expect(q("[data-slot=diff-viewed-count]")!.textContent).toBe("1 / 59 viewed");
    expect(localStorage.getItem(persistedKey("diffViewed", "orca#1"))).toContain("CLAUDE.md");
  });

  test("a click in the tree opens the file and scrolls to it", async () => {
    await mount();
    const scrolled: string[] = [];
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.id); };
    await click(q("[data-slot=diff-tree-sidebar] [data-path='tests/agentStatus.test.tsx']")!);
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    expect(section("tests/agentStatus.test.tsx").dataset.open).toBe("true");
    expect(scrolled).toEqual(["diff-tests_agentStatus_test_tsx"]);
    expect(q("[data-slot=diff-tree-sidebar] [data-path='tests/agentStatus.test.tsx']")!.className).toContain("bg-accent");
  });

  test("split view pairs the two sides; unified scrolls inside the code box only", async () => {
    await mount();
    const code = section("tests/queuedAction.test.tsx").querySelector<HTMLElement>("[data-slot=diff-code]")!;
    expect(code.className).toContain("overflow-x-auto");
    expect(code.querySelector("[data-slot=diff-split-row]")).toBeNull();
    await click(q("[aria-label='Diff view'] button:last-child")!);
    expect(section("tests/queuedAction.test.tsx").querySelector("[data-slot=diff-split-row]")).not.toBeNull();
    expect(localStorage.getItem(persistedKey("diffView"))).toBe('"split"');
  });

  test("an empty diff says so", async () => {
    await mount(<FilesChanged text="" scope="x" />);
    expect(container!.textContent).toBe("No changes.");
  });
});

// The tree sidebar's drag-to-resize handle (its right edge): same pattern as the dock's own
// (SidePanel's usePanelWidth + RESIZE_HANDLE_CLASS), a half-the-page cap instead of the dock's own.
describe("the tree sidebar's width", () => {
  test("clampTreeWidth: a sane minimum, half the page as the max, NaN reads as the default", () => {
    expect(clampTreeWidth(100, 2000)).toBe(TREE_MIN_W); // below the minimum
    expect(clampTreeWidth(300, 2000)).toBe(300); // within range, unchanged
    expect(clampTreeWidth(2000, 900)).toBe(450); // past half the page, pulled back to it
    expect(clampTreeWidth(Number.NaN, 2000)).toBe(TREE_DEFAULT_W);
    expect(clampTreeWidth(300, 200)).toBe(TREE_MIN_W); // the page itself is tiny: the minimum wins
  });

  test("a drag, the arrow keys and a double-click resize the column; the width is remembered", async () => {
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    await mount();
    const grid = q("[data-slot=diff-tree-sidebar]")!.parentElement!;
    const edge = q("[data-slot=diff-tree-resize]")!;
    expect(edge.getAttribute("role")).toBe("separator");
    expect(edge.tabIndex).toBe(0);
    expect(grid.style.getPropertyValue("--diff-tree-w")).toBe(`${TREE_DEFAULT_W}px`);

    const press = async (k: string) => { await act(async () => { edge.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); await flush(); }); };
    await press("ArrowRight"); // the edge is on the right: dragging/widening goes that way
    expect(grid.style.getPropertyValue("--diff-tree-w")).toBe(`${TREE_DEFAULT_W + RESIZE_STEP}px`);
    expect(JSON.parse(localStorage.getItem(persistedKey("diffTreeWidth"))!)).toBe(TREE_DEFAULT_W + RESIZE_STEP);
    await press("ArrowLeft");
    expect(grid.style.getPropertyValue("--diff-tree-w")).toBe(`${TREE_DEFAULT_W}px`);
    await press("Home");
    expect(grid.style.getPropertyValue("--diff-tree-w")).toBe(`${TREE_MIN_W}px`);
    await press("End");
    expect(grid.style.getPropertyValue("--diff-tree-w")).toBe(`${clampTreeWidth(Number.MAX_SAFE_INTEGER, 1440)}px`);

    await act(async () => { edge.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await flush(); });
    expect(grid.style.getPropertyValue("--diff-tree-w")).toBe(`${TREE_DEFAULT_W}px`);
    expect(JSON.parse(localStorage.getItem(persistedKey("diffTreeWidth"))!)).toBe(TREE_DEFAULT_W);
  });

  test("the phone's bottom sheet shows the tree with no resize handle to grab", async () => {
    await mount();
    await click(q("button[aria-label='Show file tree']")!);
    const sheet = q("[data-slot=diff-tree-sheet]")!;
    expect(sheet.querySelector("[data-slot=diff-tree]")).not.toBeNull();
    expect(sheet.querySelector("[data-slot=diff-tree-resize]")).toBeNull();
  });
});

describe("Markdown never widens the page", () => {
  test("wrap rules on the root; a table scrolls in its own box; an image is capped", async () => {
    await mount(<Markdown>{"A https://example.com/a-very-long-url-with-no-breaks-anywhere-at-all-0123456789 here.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n![x](/x.png)"}</Markdown>);
    const rootEl = q("[data-slot=markdown]")!;
    expect(rootEl.className).toContain("wrap-anywhere");
    expect(rootEl.className).toContain("min-w-0");
    expect(rootEl.className).toContain("prose-pre:wrap-normal");
    const box = q("[data-slot=markdown-table]")!;
    expect(box.className).toContain("overflow-x-auto");
    expect(box.querySelector("table")).not.toBeNull();
    expect(q("img")!.className).toContain("max-w-full");
  });

  // Tailwind Typography wraps inline code in literal backticks (code::before / ::after content).
  // GitHub shows none; a PR description and a rendered file get none either.
  test("inline code has no backticks", async () => {
    await mount(<Markdown>{"Each `event.key` is unique."}</Markdown>);
    const cls = q("[data-slot=markdown]")!.className;
    expect(cls).toContain("prose-code:before:content-none");
    expect(cls).toContain("prose-code:after:content-none");
    expect(q("code")!.textContent).toBe("event.key");
  });
});

// Prism names a markdown table's tokens `token table`, and Tailwind's `.table` utility is
// `display: table`: the old view put each table cell on its own line. Token spans carry no class.
test("code tokens carry only their colour, never prism's class names", async () => {
  text = await fixture("pr289-markdown.diff");
  await mount();
  const md = section("docs/integrations/ADAPTERS.md");
  await click(md.querySelector("[aria-label='Show the code']")!);
  const row = qa("[data-slot=diff-line]").find((l) => l.textContent?.includes("| File | Content |"))!;
  expect(row).toBeDefined();
  expect(row.querySelectorAll("span[class~=table], span[class*=token]").length).toBe(0);
});

// On a phone the gutter is ONE narrow number column, so the code gets the width (two full columns
// took about 75px of a 390px screen).
test("a phone shows one narrow line-number column", async () => {
  const real = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: query === NARROW_QUERY, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  try {
    text = await fixture("pr161-rename.diff");
    await mount();
    const rows = qa("[data-slot=diff-line]");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.querySelectorAll("[data-slot=diff-num]").length).toBe(1);
    const num = rows[0]!.querySelector<HTMLElement>("[data-slot=diff-num]")!;
    expect(num.style.width).toBe("calc(2ch + 0.5rem)");
    expect(num.className).toContain("px-1");
    const del = rows.find((r) => r.dataset.type === "del")!;
    expect(del.querySelector("[data-slot=diff-num]")!.textContent).not.toBe("");
  } finally {
    window.matchMedia = real;
  }
});
