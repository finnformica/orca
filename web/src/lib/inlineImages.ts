// Orca images inline in a chat message. A worker prints `shot: <path>`, writes a bare shot path or a
// markdown image of one (`![a](/…/attachments/shots/shot-….png)`); none of those is a URL the browser
// can load, so the message showed only text. This remark plugin points each at the route that serves
// it (`servedImageUrl`, pure in workstream.ts). It reads only `text` and `image` nodes: a code span
// or a fenced block is another node type, so a path in backticks stays text.
import type { Image, Parent, Root, RootContent, Text } from "mdast";
import { inlineImageParts, servedImageUrl } from "../workstream";

/** Set on an image made from a bare path: the renderer draws it as a thumbnail, not full size. */
export const THUMB_ATTR = "data-orca-thumb";

function walk(node: Parent): void {
  const out: RootContent[] = [];
  for (const child of node.children as RootContent[]) {
    if (child.type === "image") {
      const src = servedImageUrl(child.url);
      if (src) child.url = src;
      out.push(child);
    } else if (child.type === "text") {
      const parts = inlineImageParts(child.value);
      if (parts.length === 1 && typeof parts[0] === "string") { out.push(child); continue; }
      for (const p of parts) {
        out.push(typeof p === "string"
          ? ({ type: "text", value: p } satisfies Text)
          : ({ type: "image", url: p.src, alt: p.alt, title: p.path, data: { hProperties: { [THUMB_ATTR]: "" } } } satisfies Image));
      }
    } else {
      if ("children" in child) walk(child);
      out.push(child);
    }
  }
  node.children = out as Parent["children"];
}

/** The remark plugin: `remarkPlugins={[remarkGfm, remarkInlineImages]}`. */
export function remarkInlineImages() {
  return (tree: Root) => walk(tree);
}
