// A fenced code block in agent markdown, as a snippet card: a header (the title, else the
// language) with a Copy button that writes the block's raw source exactly. ```plan / ```md /
// ```markdown show the source rendered (a plan reads well) but still copy it as markdown; any
// other language is monospace, coloured by prism-react-renderer where it knows the grammar. A long
// snippet scrolls inside a capped body, so the header and its Copy button stay in view.
import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Highlight, themes } from "prism-react-renderer";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import { copyText } from "@/lib/dialogs";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { snippetCopyText, snippetInfo } from "../workstream";

/** The hast nodes react-markdown hands a `pre` override: just the parts the card reads. */
type HastNode = { type: string; tagName?: string; value?: string; children?: HastNode[]; properties?: { className?: unknown }; data?: { meta?: string | null } };
const textOf = (n: HastNode): string => n.type === "text" ? n.value ?? "" : (n.children ?? []).map(textOf).join("");

export function SnippetBlock({ lang, title, markdown, source, components }: {
  lang: string; title: string | null; markdown: boolean; source: string;
  /** The surrounding renderer's element overrides (images, tables), so a rendered plan matches it. */
  components?: Record<string, unknown>;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (await copyText(source, title ?? "snippet")) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
  };
  return (
    <div data-slot="snippet" className="my-2 overflow-hidden rounded-md border bg-card text-card-foreground">
      <div data-slot="snippet-header" className="not-prose flex h-8 items-center gap-2 border-b bg-muted/60 pr-1 pl-3">
        <span className={cn("min-w-0 flex-1 truncate text-xs", title ? "font-medium text-foreground" : "font-mono text-muted-foreground")}>
          {title ?? (lang || "text")}
        </span>
        {title && lang && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{lang}</span>}
        <Tip label={copied ? "Copied" : "Copy"}>
          <Button type="button" size="icon" variant="ghost" className="size-6 text-muted-foreground hover:text-foreground" aria-label="Copy snippet" onClick={() => void onCopy()}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </Tip>
      </div>
      <div data-slot="snippet-body" className="max-h-96 overflow-auto">
        {markdown
          ? <div className="px-3 py-1 [&>:first-child]:mt-1 [&>:last-child]:mb-1"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{source}</ReactMarkdown></div>
          : <SnippetCode lang={lang} source={source} />}
      </div>
    </div>
  );
}

function SnippetCode({ lang, source }: { lang: string; source: string }) {
  // prism-react-renderer paints token colours inline: a dark syntax theme under `.dark` (useTheme
  // re-renders on a toggle). The root style is dropped so the card keeps the theme's background.
  useTheme();
  const dark = document.documentElement.classList.contains("dark");
  return (
    <Highlight theme={dark ? themes.vsDark : themes.github} code={source} language={lang || "text"}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre data-slot="snippet-code" className="not-prose m-0 min-w-max bg-transparent px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre">
          <code className="block">
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>{line.map((token, k) => <span key={k} {...getTokenProps({ token })} />)}</div>
            ))}
          </code>
        </pre>
      )}
    </Highlight>
  );
}

/** A react-markdown `pre` override: a fenced block becomes a SnippetBlock. `components` are the
 *  renderer's own overrides, reused for a rendered plan / md snippet. */
export const snippetPre = (components?: Record<string, unknown>) =>
  ({ node, children }: { node?: HastNode; children?: ReactNode }) => {
    const code = node?.children?.find((c) => c.type === "element" && c.tagName === "code");
    if (!code) return <pre>{children}</pre>;
    const cls = code.properties?.className;
    const info = snippetInfo(Array.isArray(cls) ? cls.join(" ") : typeof cls === "string" ? cls : undefined, code.data?.meta);
    return <SnippetBlock {...info} source={snippetCopyText(textOf(code))} components={components} />;
  };
