// Every image the app shows — a chat attachment thumbnail, a markdown image inside a reply (a
// worker's `/api/screenshots/<id>` link), a composer attachment preview — gets the same two
// behaviours: click to open a full-size lightbox, and a hover (always-visible on touch) corner
// button that copies the image to the clipboard. One shared component so neither behaviour drifts
// per call site. The lightbox reuses the native-<dialog> modal pattern (Terminal.tsx's
// TerminalDialog): showModal()/close() for free Esc + backdrop + focus trap, toggled from React
// state rather than conditionally rendered, so Esc/backdrop-click fire the same onClose path a
// button would.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Download, X } from "lucide-react";
import { cn, PortalContainer } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import { useSwipeToClose } from "@/lib/gestures";
import { useNarrow } from "@/lib/viewport";

/** `navigator.clipboard.write` wants an explicit-mime `ClipboardItem`, and most browsers only
 *  reliably accept `image/png` for it — a fetched jpeg/webp screenshot needs converting first. A
 *  PNG blob (the common case: every `/api/screenshots/<id>` and `/api/attachments/<id>` upload we
 *  render through this component) passes straight through with no canvas round-trip. */
async function toPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image decode failed"));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Copy the image at `src` to the clipboard as a PNG. A browser that refuses — Safari outside a
 *  direct user-gesture tick, Firefox without the clipboard-write flag, or a `src` the page can't
 *  fetch — falls back to copying the absolute URL as text instead, so the click still does
 *  something useful. Exported for the fallback path's own test coverage. */
export async function copyImage(src: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("clipboard.write unavailable");
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const blob = await toPngBlob(await res.blob());
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(new URL(src, location.origin).toString());
      return true;
    } catch {
      return false;
    }
  }
}

export function ExpandableImage({
  src, alt, className, imgClassName, downloadName, cornerClassName = "top-1 right-1", gallery,
}: {
  src: string;
  /** Alt text, also the lightbox's accessible label and the default download name. */
  alt: string;
  /** Classes for the wrapping (relatively positioned, clickable) box — size/overflow live here. */
  className?: string;
  /** Classes for the `<img>` itself (object-fit, rounding, border, …). */
  imgClassName?: string;
  downloadName?: string;
  /** Where the copy button sits in its corner; override when a caller already has a button there
   *  (the composer's Remove ✕ takes the top-right, so its thumbnail copy button goes bottom-right). */
  cornerClassName?: string;
  /** This thumbnail's siblings in the same set (the Screenshots section's list, or one chat
   *  message/turn's images) — lets the open lightbox move between them with Left/Right instead of
   *  closing and reopening a different instance. `index` is this image's position in `images`.
   *  Omitted (the default): a single image, exactly today's behaviour. */
  gallery?: { images: { src: string; alt: string }[]; index: number };
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const narrow = useNarrow();
  const swipe = useSwipeToClose(() => dialogRef.current, () => setOpen(false), narrow);
  const images = gallery?.images ?? [{ src, alt }];
  const total = images.length;
  const [activeIndex, setActiveIndex] = useState(gallery?.index ?? 0);
  const cur = images[activeIndex] ?? images[0]!;

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    // Focus the dialog itself, not whichever chevron happens to render first: a chevron that
    // later unmounts at the end of the gallery would otherwise drop focus to <body>, outside the
    // dialog's subtree, and Left/Right (handled on the dialog, below) would stop responding.
    if (open && !d.open) { d.showModal(); d.focus(); }
    else if (!open && d.open) d.close();
  }, [open]);

  // Reset to the thumbnail that was clicked every time it (re)opens, so navigating within the
  // lightbox never leaks into the next time this particular thumbnail is opened.
  useEffect(() => {
    if (open) setActiveIndex(gallery?.index ?? 0);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyImage(cur.src);
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (total <= 1) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); setActiveIndex((i) => Math.max(0, i - 1)); e.currentTarget.focus(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); setActiveIndex((i) => Math.min(total - 1, i + 1)); e.currentTarget.focus(); }
  };

  return (
    <>
      <div
        className={cn("group relative inline-block cursor-zoom-in", className)}
        data-slot="expandable-image"
        role="button"
        tabIndex={0}
        aria-label={`Expand image${alt ? `: ${alt}` : ""}`}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); } }}
      >
        <img src={src} alt={alt} loading="lazy" className={imgClassName} />
        {/* Tip's own wrapper is itself `relative inline-flex` — the corner offset has to go on
         *  THAT box, not the button inside it, or the button only escapes Tip's own (button-sized)
         *  box and stays in normal flow next to the image instead of overlaying its corner. */}
        <Tip label={copied ? "Copied" : "Copy image"} className={cn("absolute", cornerClassName)}>
          <Button
            type="button" size="icon" variant="ghost"
            className="size-7 bg-background/80 text-foreground opacity-0 transition-opacity hover:bg-background group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            aria-label="Copy image" onClick={(e) => void onCopy(e)}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </Tip>
      </div>
      <dialog
        ref={dialogRef}
        onClose={() => setOpen(false)}
        onCancel={() => setOpen(false)}
        onClick={(e) => { if (e.target === dialogRef.current) setOpen(false); }} // click the backdrop → close
        onKeyDown={onKeyDown}
        tabIndex={-1}
        aria-label={alt || "Expanded image"}
        data-slot="image-lightbox"
        // Constrained (max-h/max-w) sizing is desktop-only (md:) and full-bleed sizing is
        // mobile-only (max-md:), rather than setting one unconditionally and trusting `sheet`'s
        // `max-height: none` / `max-width: none` to cancel it out at the same breakpoint — two
        // same-specificity declarations racing on source order is fragile; disjoint breakpoints
        // aren't.
        className="m-auto overflow-auto rounded-lg border-0 bg-transparent p-0 backdrop:bg-black/70 md:max-h-[92vh] md:max-w-[92vw] max-md:sheet"
      >
        <div {...swipe} className="group relative flex items-center justify-center md:max-h-[92vh] md:max-w-[92vw] max-md:h-full max-md:w-full">
          {open && <img src={cur.src} alt={cur.alt} className="object-contain md:max-h-[92vh] md:max-w-[92vw] max-md:max-h-full max-md:max-w-full" />}
          {total > 1 && (
            <>
              <div data-slot="lightbox-index" className="absolute top-2 left-2 rounded-md bg-background/80 px-2 py-1 text-xs text-foreground">
                {activeIndex + 1} / {total}
              </div>
              {activeIndex > 0 && (
                <Button
                  type="button" size="icon" variant="ghost" aria-label="Previous screenshot"
                  className="absolute top-1/2 left-2 size-8 -translate-y-1/2 bg-background/80 text-foreground opacity-0 transition-opacity hover:bg-background group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  onClick={(e) => { e.stopPropagation(); setActiveIndex((i) => Math.max(0, i - 1)); dialogRef.current?.focus(); }}
                >
                  <ChevronLeft className="size-5" />
                </Button>
              )}
              {activeIndex < total - 1 && (
                <Button
                  type="button" size="icon" variant="ghost" aria-label="Next screenshot"
                  className="absolute top-1/2 right-2 size-8 -translate-y-1/2 bg-background/80 text-foreground opacity-0 transition-opacity hover:bg-background group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  onClick={(e) => { e.stopPropagation(); setActiveIndex((i) => Math.min(total - 1, i + 1)); dialogRef.current?.focus(); }}
                >
                  <ChevronRight className="size-5" />
                </Button>
              )}
            </>
          )}
          <div className="absolute top-2 right-2 flex gap-1">
            {/* Its tip portals INTO the modal dialog: the top layer covers anything outside it. */}
            <PortalContainer.Provider value={dialogRef.current ?? undefined}>
              <Tip label="Download">
                <Button asChild size="icon" variant="ghost" className="size-8 bg-background/80 text-foreground hover:bg-background">
                  <a href={cur.src} download={(gallery ? undefined : downloadName) || cur.alt || ""} aria-label="Download image" onClick={(e) => e.stopPropagation()}>
                    <Download className="size-4" />
                  </a>
                </Button>
              </Tip>
            </PortalContainer.Provider>
            <Button type="button" size="icon" variant="ghost" className="size-8 bg-background/80 text-foreground hover:bg-background" aria-label="Close" onClick={() => setOpen(false)}>
              <X className="size-4" />
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
