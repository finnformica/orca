// Every form control in the web app is a shadcn component (web/src/components/ui) — Finn's rule. This
// check fails on a raw <input>, <select> or <textarea>, a createElement of one, or a native picker
// type (date, time, color, range…) anywhere in web/src outside components/ui.
//
// A justified case (a hidden file input behind a shadcn Button, the clipboard's off-screen textarea)
// carries an allow-comment with a reason, on its line or the line above:
//   {/* native-input-ok: hidden file input behind the attach Button */}
//
// Run by `bun run check`. `bun run scripts/check-native-inputs.ts` prints each hit and exits 1.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const ALLOW = "native-input-ok:";

const RULES: { re: RegExp; what: string }[] = [
  { re: /<(input|select|textarea)(?=[\s>/]|$)/g, what: "raw <$1>; use the shadcn component in components/ui" },
  { re: /createElement\(\s*["'](input|select|textarea)["']/g, what: "createElement(\"$1\"); use the shadcn component in components/ui" },
  { re: /["'](date|time|datetime-local|month|week|color|range|radio|checkbox|file)["']/g, what: "native \"$1\" input type; use a shadcn picker" },
];

/** Lines that are comments only: their text is prose, never a control. */
const COMMENT = /^\s*(\/\/|\/\*|\*|\{\/\*)/;

export type Hit = { file: string; line: number; what: string; text: string };

/** The native controls in one file's source. A rule for a type literal looks only at `type=…` uses. */
export function findNativeInputs(file: string, source: string): Hit[] {
  const lines = source.split("\n");
  const hits: Hit[] = [];
  lines.forEach((text, i) => {
    if (COMMENT.test(text)) return;
    if (text.includes(ALLOW) || lines[i - 1]?.includes(ALLOW)) {
      const reason = (text.includes(ALLOW) ? text : lines[i - 1]!).split(ALLOW)[1]?.replace(/\*\/\}?|\*\//, "").trim();
      if (reason) return;
      hits.push({ file, line: i + 1, what: `"${ALLOW}" needs a reason`, text: text.trim() });
      return;
    }
    for (const [n, { re, what }] of RULES.entries()) {
      for (const m of text.matchAll(re)) {
        // A type literal counts only where it sets an input's type: `type="date"`, `type={x ? "date" : …}`.
        if (n === 2 && !/\btype\s*=\s*(\{[^}]*)?$/.test(text.slice(0, m.index))) continue;
        hits.push({ file, line: i + 1, what: what.replace("$1", m[1]!), text: text.trim() });
      }
    }
  });
  return hits;
}

/** Every .ts / .tsx file under `dir`, minus components/ui (the one place a native control belongs). */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return p.endsWith(join("components", "ui")) ? [] : sources(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** The hits in the whole of `root` (web/src by default). */
export function scan(root = join(import.meta.dir, "..", "web", "src")): Hit[] {
  return sources(root).flatMap((f) => findNativeInputs(relative(join(root, "..", ".."), f), readFileSync(f, "utf8")));
}

if (import.meta.main) {
  const hits = scan();
  for (const h of hits) console.error(`${h.file}:${h.line}: ${h.what}\n    ${h.text}`);
  if (hits.length) {
    console.error(`\ncheck-native-inputs: ${hits.length} native control(s). Use components/ui, or add "${ALLOW} <reason>" for a justified case.`);
    process.exit(1);
  }
  console.log("check-native-inputs: no native controls outside components/ui");
}
