// An agent reply's markdown image of an Orca file (`![a](/…/attachments/shots/shot-….png)`) is not a
// URL the browser can load: it showed as a broken image. The reply carries that file as an attachment
// (`replyAttachments`, drawn under the reply like the user's own), so this remark plugin puts the
// image's alt text in its place. Only `image` nodes change: a path in code is another node type.
import type { Parent, Root, RootContent } from "mdast";
import { orcaFile } from "../workstream";

function walk(node: Parent): void {
  node.children = (node.children as RootContent[]).map((child): RootContent => {
    if (child.type === "image") {
      const file = orcaFile(child.url);
      return file ? { type: "text", value: child.alt || file.name } : child;
    }
    if ("children" in child) walk(child);
    return child;
  }) as Parent["children"];
}

/** The remark plugin: `remarkPlugins={[remarkGfm, remarkOrcaImages]}`. */
export function remarkOrcaImages() {
  return (tree: Root) => walk(tree);
}
