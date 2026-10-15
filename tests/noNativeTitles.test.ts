// Guard against native hover-box `title=` attributes creeping back into web/src: Finn finds the
// browser's native title tooltip ugly and distracting (#125) and had every instance outside
// components/ui removed, in favour of either nothing or the Tip component. This walks the real
// TSX/TS AST (not a text regex, so an `=>` arrow or a `>` comparison inside a tag's attributes can't
// fool it) looking for a JSX attribute named `title` on a lowercase-leading (native DOM) element —
// a custom component's own `title` prop (VCard, AgentHeader, BottomSheet, Facet, ReviewSection, …)
// is a visible heading, not a hover attribute, and is always capitalized, so it never matches.
import { expect, test } from "bun:test";
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = join(import.meta.dir, "..", "web", "src");

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (relative(ROOT, path) === "components/ui") continue; // Tip itself, and shadcn's own primitives
      out.push(...listFiles(path));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

// The one SVG <title> rule 4 keeps: a chart mark's only way to say which (possibly overlapping)
// event it is — console.tsx's LineChart `marks`, the Memory chart's OOM-kill lines.
const ALLOWED_SVG_TITLE = new Set(["components/console.tsx"]);

test("no native title= hover attributes in web/src outside components/ui", () => {
  const offenders: string[] = [];
  for (const file of listFiles(ROOT)) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && node.name.getText(source) === "title") {
        const el = node.parent.parent; // JsxAttributes -> JsxOpeningElement | JsxSelfClosingElement
        const tagName = (ts.isJsxOpeningElement(el) || ts.isJsxSelfClosingElement(el)) ? el.tagName.getText(source) : "";
        if (/^[a-z]/.test(tagName)) offenders.push(`${rel}:${lineOf(node)} <${tagName} title=…>`);
      }
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "title" && !ALLOWED_SVG_TITLE.has(rel)) {
        offenders.push(`${rel}:${lineOf(node)} <title> element`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(offenders).toEqual([]);
});
