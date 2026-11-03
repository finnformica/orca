// Markdown on the page surface: a PR description, a review comment, the agent's latest outcome, a
// markdown file's rendered view on Files changed. (The chat has its own `ChatMarkdown`, with the
// same wrapping rules, in views/Chat.tsx.)
//
// Nothing in it may widen the page — a long URL, a branch name, a wide table or a code block on a
// 390px phone once pushed the text past its card. So: `wrap-anywhere` breaks any unbreakable word,
// `min-w-0` lets a flex or grid parent shrink it, a table scrolls sideways inside its own box, an
// image is capped to the width, and a fenced block is a snippet card that scrolls inside itself
// (`prose-pre:wrap-normal` keeps code from breaking mid-token).
import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { snippetPre } from "@/components/Snippet";
import { ExpandableImage } from "@/components/ExpandableImage";
import { remarkInlineImages, THUMB_ATTR } from "@/lib/inlineImages";
import { apiUrl } from "@/lib/server";
import { cn } from "@/lib/utils";

const table = ({ children }: { children?: ReactNode }) => (
  <div data-slot="markdown-table" className="my-4 max-w-full overflow-x-auto">
    <table className="my-0">{children}</table>
  </div>
);
/** A floor per column, so a wrapped table never squeezes a column to one letter per line. */
const cell = (Tag: "th" | "td") => ({ children }: { children?: ReactNode }) => <Tag className="min-w-24">{children}</Tag>;
/** An Orca image (remarkInlineImages: a shot or attachment path, now `/api/…`) opens in the lightbox;
 *  any other image, a PR description's own, stays a plain `<img>`. */
const img = ({ src, alt, ...rest }: { src?: string; alt?: string; [THUMB_ATTR]?: string }) =>
  !src ? null
    : !src.startsWith("/api/") ? <img src={src} alt={alt ?? ""} loading="lazy" className="inline-block h-auto max-w-full rounded-md" />
    : rest[THUMB_ATTR] !== undefined
      ? <ExpandableImage src={apiUrl(src)} alt={alt ?? ""} className="me-2 inline-block align-top" imgClassName="my-0 h-24 w-40 rounded-md border object-cover object-top" />
      : <ExpandableImage src={apiUrl(src)} alt={alt ?? ""} imgClassName="my-0 max-h-80 max-w-full rounded-md border object-contain" />;

const elements = { table, th: cell("th"), td: cell("td"), img };
const components = { ...elements, pre: snippetPre(elements) };

export const MARKDOWN_CLASS = "prose prose-sm dark:prose-invert max-w-none min-w-0 wrap-anywhere prose-pre:wrap-normal prose-img:my-2 prose-code:before:content-none prose-code:after:content-none prose-code:font-normal";

export const Markdown = memo(({ children, className }: { children: string; className?: string }) => (
  <div data-slot="markdown" className={cn(MARKDOWN_CLASS, className)}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkInlineImages]} components={components}>{children}</ReactMarkdown>
  </div>
));
