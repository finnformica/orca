// What the chat composer gets from the clipboard, as Files or text. Pure apart from the one
// `clipboard.read()` call, so the parse is testable without a browser.
//
// Why the phone needs its own path: on iOS a plain <textarea> is not rich-editable, so WebKit offers
// the callout's Paste only when the pasteboard holds a URL or text (WKContentViewInteraction.mm,
// `supportedPlainTextPasteboardTypes`; image types are in the rich list only). A copied photo or
// screenshot holds only an image: iOS shows no Paste and fires no paste event. The composer's
// "Paste from clipboard" item reads the clipboard itself with `navigator.clipboard.read()`.

export type PasteItem = { kind: string; type: string; getAsFile(): File | null };
export type PasteData = { items?: ArrayLike<PasteItem> | null; files?: ArrayLike<File> | null };

/** The files of a paste event. Screenshots often come only through `items` (getAsFile), so read
 *  those first; an engine that fills only `.files` still attaches. Never both: a browser that fills
 *  both lists the same file twice. */
export function pastedFiles(data: PasteData | null | undefined): File[] {
  if (!data) return [];
  const fromItems = Array.from(data.items ?? [])
    .filter((it) => it.kind === "file")
    .map((it) => it.getAsFile())
    .filter((f): f is File => Boolean(f));
  return fromItems.length ? fromItems : Array.from(data.files ?? []);
}

export type ClipboardEntry = { types: readonly string[]; getType(type: string): Promise<Blob> };
export type ClipboardReader = { read?: () => Promise<readonly ClipboardEntry[]> };

const TEXT_TYPES = new Set(["text/plain", "text/html", "text/uri-list"]);
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/svg+xml": "svg", "text/markdown": "md", "application/pdf": "pdf" };

/** A name for a pasted file: `pasted-image.png`, `pasted-image-2.png`, … (`n` counts from 1). */
export function pastedFileName(type: string, n: number): string {
  const ext = EXT[type] ?? (type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin");
  const kind = type.startsWith("image/") ? "image" : "file";
  return `pasted-${kind}${n > 1 ? `-${n}` : ""}.${ext}`;
}

/** The clipboard as files (every item with a non-text type; iOS gives a photo as `image/png`) or,
 *  with none, its plain text. Call it straight from the tap: WebKit refuses a read after an `await`
 *  breaks the user gesture, so `read()` is the first thing this does. */
export async function readClipboard(clipboard: ClipboardReader | undefined): Promise<{ files: File[]; text: string }> {
  if (!clipboard?.read) throw new ClipboardUnavailable();
  const entries = await clipboard.read();
  const files: File[] = [];
  let text = "";
  for (const entry of entries) {
    const type = entry.types.find((t) => !TEXT_TYPES.has(t));
    if (type) {
      const blob = await entry.getType(type);
      files.push(new File([blob], pastedFileName(type, files.length + 1), { type }));
    } else if (!text && entry.types.includes("text/plain")) {
      text = await (await entry.getType("text/plain")).text();
    }
  }
  return { files, text };
}

/** No `navigator.clipboard.read` here: an old browser, or a page that is not a secure context
 *  (plain http on the tailnet). */
export class ClipboardUnavailable extends Error {
  constructor() { super("clipboard read unavailable"); this.name = "ClipboardUnavailable"; }
}

export const CLIPBOARD_EMPTY = "The clipboard has no image or text. Use Photo or file to attach it.";

/** The composer's error line for a failed clipboard read. */
export function clipboardError(err: unknown): string {
  const name = err instanceof Error || (typeof err === "object" && err && "name" in err) ? String((err as { name: unknown }).name) : "";
  if (name === "ClipboardUnavailable") return "This page cannot read the clipboard. Open Orca at its https address, or use Photo or file.";
  if (name === "NotAllowedError") return "Paste was not allowed. Tap Paste in the bubble that shows, or use Photo or file.";
  if (name === "DataError" || name === "NotFoundError") return CLIPBOARD_EMPTY;
  return `Paste failed: ${err instanceof Error ? err.message : String(err)}`;
}
