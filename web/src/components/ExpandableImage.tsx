// Every image the app shows — a chat attachment thumbnail, a markdown image inside a reply (a
// worker's `/api/screenshots/<id>` link), a composer attachment preview — gets the same two
// behaviours: click to open a full-size lightbox, and a hover (always-visible on touch) corner
// button that copies the image to the clipboard. One shared component so neither behaviour drifts
// per call site. The lightbox reuses the native-<dialog> modal pattern (Terminal.tsx's
// TerminalDialog): showModal()/close() for free Esc + backdrop + focus trap, toggled from React
// state rather than conditionally rendered, so Esc/backdrop-click fire the same onClose path a
// button would.
//
// The lightbox zooms (maths in lib/zoom.ts). The dialog is a full-screen stage; the image keeps its
// fit size in layout and a CSS transform zooms and pans it. Desktop: the wheel or a trackpad pinch
// zooms about the cursor, a click toggles fit and actual pixels, a drag pans, + / - / 0 and the
// bottom buttons. Phone: a two-finger pinch, a double tap (fit and 2x), a one-finger drag pans.
// Pointer events with `touch-action: none` on the stage, so the browser's own page zoom stays out.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Download, Shrink, X, ZoomIn, ZoomOut } from "lucide-react";
import { cn, PortalContainer } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import { useSwipeToDismiss } from "@/lib/gestures";
import { useNarrow } from "@/lib/viewport";
import {
  actualScale, FIT, maxScale, panBy, pinch, TAP_ZOOM, toggleScale, wheelScale, zoomAt, zoomPercent, ZOOM_STEP,
  type Point, type ZoomView,
} from "@/lib/zoom";

/** The lightbox's controls sit clear of the notch, the status bar and the home bar. The stage itself
 *  is full-bleed (a zoomed image uses the whole screen), so each control adds its own inset. The
 *  installed app draws under the status bar (`black-translucent`, `display: standalone`), where a
 *  plain `top-2` Close button was under the clock and could not be tapped. */
export const LIGHTBOX_INSET = {
  top: "top-[calc(env(safe-area-inset-top)+0.5rem)]",
  right: "right-[calc(env(safe-area-inset-right)+0.5rem)]",
  bottom: "bottom-[calc(env(safe-area-inset-bottom)+0.75rem)]",
  left: "left-[calc(env(safe-area-inset-left)+0.5rem)]",
} as const;
/** A lightbox button: 32px with a mouse, a 44px tap target on a phone. */
const LIGHTBOX_BUTTON = "size-8 max-md:size-11";

/** A tap or click moves less than this, in pixels. */
const TAP_SLOP = 6;
/** Two taps within this time and distance are a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 40;

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
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const narrow = useNarrow();
  // A phone: swipe the image down to close it — from anywhere on it, once the lightbox (its own
  // scroller) is scrolled to the top, so a tall image still scrolls first.
  const [dialogEl, setDialogEl] = useState<HTMLDialogElement | null>(null);
  const setDialog = useCallback((el: HTMLDialogElement | null) => { dialogRef.current = el; setDialogEl(el); }, []);
  const images = gallery?.images ?? [{ src, alt }];
  const total = images.length;
  const [activeIndex, setActiveIndex] = useState(gallery?.index ?? 0);
  const cur = images[activeIndex] ?? images[0]!;

  // --- zoom ---------------------------------------------------------------------------------------
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // `smooth`: a discrete step (a key, a button, a click) eases; a wheel, pinch or drag follows at once.
  const [zoom, setZoom] = useState<{ view: ZoomView; smooth: boolean }>({ view: FIT, smooth: false });
  const viewRef = useRef<ZoomView>(FIT);
  const setView = useCallback((view: ZoomView, smooth = false) => { viewRef.current = view; setZoom({ view, smooth }); }, []);
  const view = zoom.view;
  const zoomed = view.scale > 1;
  // Swipe down to close only at fit: zoomed, a one-finger drag pans.
  useSwipeToDismiss("bottom", () => dialogRef.current, () => setOpen(false), { enabled: narrow && !zoomed, body: dialogEl });

  /** The sizes the maths needs, read from layout (offset sizes ignore the transform). */
  const measure = () => {
    const img = imgRef.current, stage = stageRef.current;
    const fit = { w: img?.offsetWidth ?? 0, h: img?.offsetHeight ?? 0 };
    const natural = { w: img?.naturalWidth ?? 0, h: img?.naturalHeight ?? 0 };
    return { fit, stage: { w: stage?.clientWidth ?? 0, h: stage?.clientHeight ?? 0 }, max: maxScale(natural, fit), actual: actualScale(natural, fit) };
  };
  /** A screen point relative to the stage's centre, where the untransformed image is centred. */
  const fromCentre = (clientX: number, clientY: number): Point => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 } : { x: 0, y: 0 };
  };
  const zoomTo = (scale: number, at: Point = { x: 0, y: 0 }, smooth = false) => {
    const m = measure();
    setView(zoomAt(viewRef.current, scale, at, m.fit, m.stage, m.max), smooth);
  };
  const m = measure();
  const percent = zoomPercent(view.scale, m.actual);

  /** Move in the gallery: a new image starts at fit. */
  const go = (i: number) => { setActiveIndex(Math.min(total - 1, Math.max(0, i))); setView(FIT); };

  // Every open starts at fit; a resize changes the fit size, so start again there too.
  useEffect(() => { setView(FIT); }, [open, setView]);
  useEffect(() => {
    if (!open) return;
    const reset = () => setView(FIT);
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
  }, [open, setView]);

  // The wheel (and a trackpad pinch, which is a wheel event with ctrlKey) zooms about the cursor.
  // A native listener: React's onWheel is passive and cannot stop the page from zooming.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      zoomTo(wheelScale(viewRef.current.scale, e.deltaY * px, e.ctrlKey), fromCentre(e.clientX, e.clientY));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- reads only refs

  // Pointers on the stage: one pans (when zoomed), two pinch. A press that does not move is a tap.
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: ZoomView; p0: Point; d0: number; m0: Point; moved: boolean } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const begin = (moved: boolean) => {
    const [a, b] = [...pointers.current.values()];
    if (!a) { gesture.current = null; return; }
    const mid = b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a;
    gesture.current = { start: viewRef.current, p0: a, d0: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0, m0: fromCentre(mid.x, mid.y), moved };
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest("button, a") || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    begin(pointers.current.size > 1); // a second finger is a pinch, never a tap
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = [...pointers.current.values()];
    const sizes = measure();
    if (a && b) {
      const mid = fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2);
      setView(pinch(g.start, g.d0, g.m0, Math.hypot(a.x - b.x, a.y - b.y), mid, sizes.fit, sizes.stage, sizes.max));
      return;
    }
    const dx = e.clientX - g.p0.x, dy = e.clientY - g.p0.y;
    if (!g.moved && Math.hypot(dx, dy) > TAP_SLOP) g.moved = true;
    if (g.moved && g.start.scale > 1) setView(panBy(g.start, dx, dy, sizes.fit, sizes.stage));
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (pointers.current.size) { begin(true); return; } // one finger of a pinch lifted: pan from here
    gesture.current = null;
    if (!g || g.moved || e.type !== "pointerup") return;
    const at = fromCentre(e.clientX, e.clientY);
    const prev = lastTap.current;
    const second = !!prev && e.timeStamp - prev.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_TAP_PX;
    if (e.pointerType === "mouse") {
      // A click on the image toggles fit and actual pixels; on the empty stage it closes, as the
      // backdrop did. The second click of a double click does nothing: one toggle, not two.
      if (e.target !== imgRef.current) { setOpen(false); return; }
      lastTap.current = { t: e.timeStamp, x: e.clientX, y: e.clientY };
      if (!second) zoomTo(toggleScale(viewRef.current.scale, measure().actual), at, true);
      return;
    }
    if (second) {
      lastTap.current = null;
      zoomTo(toggleScale(viewRef.current.scale, TAP_ZOOM), at, true);
    } else lastTap.current = { t: e.timeStamp, x: e.clientX, y: e.clientY };
  };

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
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomTo(viewRef.current.scale * ZOOM_STEP, undefined, true); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomTo(viewRef.current.scale / ZOOM_STEP, undefined, true); return; }
    if (e.key === "0") { e.preventDefault(); setView(FIT, true); return; }
    if (total <= 1) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); go(activeIndex - 1); e.currentTarget.focus(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(activeIndex + 1); e.currentTarget.focus(); }
  };
  const zoomButton = cn(LIGHTBOX_BUTTON, "text-foreground hover:bg-background");

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
        ref={setDialog}
        onClose={() => setOpen(false)}
        onCancel={() => setOpen(false)}
        onClick={(e) => { if (e.target === dialogRef.current) setOpen(false); }} // click the backdrop → close
        onKeyDown={onKeyDown}
        tabIndex={-1}
        aria-label={alt || "Expanded image"}
        data-slot="image-lightbox"
        // A full-screen stage at every width (the `sheet` utility), so a zoomed image can use the
        // whole screen. At fit the image is as before: at most 92vw x 92vh on a desktop, the full
        // sheet on a phone; a click on the empty stage closes, as the backdrop did. `p-0` wins over
        // the sheet's safe-area padding on purpose: the controls carry the insets (LIGHTBOX_INSET).
        className="overflow-hidden bg-transparent p-0 backdrop:bg-black/70 sheet"
      >
        <PortalContainer.Provider value={dialogEl ?? undefined}>
        <div
          ref={stageRef}
          data-slot="lightbox-stage"
          className="group relative flex h-full w-full touch-none items-center justify-center overflow-hidden select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          {open && (
            <img
              ref={imgRef}
              src={cur.src}
              alt={cur.alt}
              draggable={false}
              onLoad={() => setView(FIT)}
              style={{
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                transition: zoom.smooth ? "transform 150ms ease-out" : "none",
              }}
              className={cn(
                "object-contain will-change-transform md:max-h-[92vh] md:max-w-[92vw] max-md:max-h-full max-md:max-w-full",
                zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
              )}
            />
          )}
          {total > 1 && (
            <>
              <div data-slot="lightbox-index" className={cn("absolute rounded-md", LIGHTBOX_INSET.top, LIGHTBOX_INSET.left, " bg-background/80 px-2 py-1 text-xs text-foreground")}>
                {activeIndex + 1} / {total}
              </div>
              {activeIndex > 0 && (
                <Button
                  type="button" size="icon" variant="ghost" aria-label="Previous screenshot"
                  className={cn("absolute top-1/2 -translate-y-1/2", LIGHTBOX_INSET.left, LIGHTBOX_BUTTON, "bg-background/80 text-foreground opacity-0 transition-opacity hover:bg-background group-hover:opacity-100 [@media(hover:none)]:opacity-100")}
                  onClick={(e) => { e.stopPropagation(); go(activeIndex - 1); dialogRef.current?.focus(); }}
                >
                  <ChevronLeft className="size-5" />
                </Button>
              )}
              {activeIndex < total - 1 && (
                <Button
                  type="button" size="icon" variant="ghost" aria-label="Next screenshot"
                  className={cn("absolute top-1/2 -translate-y-1/2", LIGHTBOX_INSET.right, LIGHTBOX_BUTTON, "bg-background/80 text-foreground opacity-0 transition-opacity hover:bg-background group-hover:opacity-100 [@media(hover:none)]:opacity-100")}
                  onClick={(e) => { e.stopPropagation(); go(activeIndex + 1); dialogRef.current?.focus(); }}
                >
                  <ChevronRight className="size-5" />
                </Button>
              )}
            </>
          )}
          <div data-slot="lightbox-actions" className={cn("absolute flex gap-1", LIGHTBOX_INSET.top, LIGHTBOX_INSET.right)}>
            {/* Tips portal INTO the modal dialog (the Provider above): the top layer covers anything outside it. */}
            <Tip label="Download">
              <Button asChild size="icon" variant="ghost" className={cn(LIGHTBOX_BUTTON, "bg-background/80 text-foreground hover:bg-background")}>
                <a href={cur.src} download={(gallery ? undefined : downloadName) || cur.alt || ""} aria-label="Download image" onClick={(e) => e.stopPropagation()}>
                  <Download className="size-4" />
                </a>
              </Button>
            </Tip>
            <Button type="button" size="icon" variant="ghost" className={cn(LIGHTBOX_BUTTON, "bg-background/80 text-foreground hover:bg-background")} aria-label="Close" onClick={() => setOpen(false)}>
              <X className="size-4" />
            </Button>
          </div>
          <div data-slot="lightbox-zoom" className={cn("absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-md bg-background/80 p-0.5 text-foreground", LIGHTBOX_INSET.bottom)}>
            <Tip label="Zoom out (-)">
              <Button type="button" size="icon" variant="ghost" className={zoomButton} aria-label="Zoom out" disabled={!zoomed}
                onClick={() => zoomTo(viewRef.current.scale / ZOOM_STEP, undefined, true)}>
                <ZoomOut className="size-4" />
              </Button>
            </Tip>
            <span data-slot="lightbox-zoom-level" className="min-w-11 text-center text-xs tabular-nums">{percent}%</span>
            <Tip label="Zoom in (+)">
              <Button type="button" size="icon" variant="ghost" className={zoomButton} aria-label="Zoom in" disabled={view.scale >= m.max}
                onClick={() => zoomTo(viewRef.current.scale * ZOOM_STEP, undefined, true)}>
                <ZoomIn className="size-4" />
              </Button>
            </Tip>
            <Tip label="Fit to screen (0)">
              <Button type="button" size="icon" variant="ghost" className={zoomButton} aria-label="Fit to screen" disabled={!zoomed}
                onClick={() => setView(FIT, true)}>
                <Shrink className="size-4" />
              </Button>
            </Tip>
            <Tip label="Actual size (100%)">
              <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs text-foreground hover:bg-background max-md:h-11 max-md:min-w-11" aria-label="Actual size"
                onClick={() => zoomTo(measure().actual, undefined, true)}>
                1:1
              </Button>
            </Tip>
          </div>
        </div>
        </PortalContainer.Provider>
      </dialog>
    </>
  );
}
