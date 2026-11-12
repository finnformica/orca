// The image lightbox's zoom maths (components/ExpandableImage.tsx), pure so it is testable without
// a browser. The image keeps its FIT size in layout, centred in the stage; the zoom is a CSS
// transform `translate(x, y) scale(s)` about the image's centre. `s = 1` is fit, and (x, y) is the
// pan in screen pixels from the centred position. Points are in screen pixels relative to the
// stage's centre.

export type ZoomView = { scale: number; x: number; y: number };
export type Size = { w: number; h: number };
export type Point = { x: number; y: number };

export const FIT: ZoomView = { scale: 1, x: 0, y: 0 };
/** The largest zoom, as a multiple of fit. Actual pixels win when they are larger. */
export const MAX_ZOOM = 8;
/** One +/- key press or zoom button press. */
export const ZOOM_STEP = 1.25;
/** A phone's double tap zooms to this multiple of fit. */
export const TAP_ZOOM = 2;

/** The scale at which one image pixel is one screen pixel. 1 when the size is not known yet. */
export function actualScale(natural: Size, fit: Size): number {
  return natural.w > 0 && fit.w > 0 ? natural.w / fit.w : 1;
}

/** The largest scale for this image: MAX_ZOOM, or actual pixels when the fit shrank it more. */
export function maxScale(natural: Size, fit: Size): number {
  return Math.max(MAX_ZOOM, actualScale(natural, fit));
}

export const clampScale = (s: number, max: number) => Math.min(max, Math.max(1, s));

/** Keep the image on the screen: a side smaller than the stage stays centred, a larger one may
 *  pan only until its edge meets the stage's edge. */
export function clampPan(v: ZoomView, fit: Size, stage: Size): ZoomView {
  const axis = (d: number, size: number, room: number) => {
    const max = Math.max(0, (size * v.scale - room) / 2);
    return Math.min(max, Math.max(-max, d)) || 0; // no -0
  };
  return { scale: v.scale, x: axis(v.x, fit.w, stage.w), y: axis(v.y, fit.h, stage.h) };
}

/** Zoom to `scale` and keep the image point under `at` where it is (the cursor, the fingers). */
export function zoomAt(v: ZoomView, scale: number, at: Point, fit: Size, stage: Size, max: number): ZoomView {
  const s = clampScale(scale, max);
  if (s === 1) return FIT;
  const k = s / v.scale;
  return clampPan({ scale: s, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k }, fit, stage);
}

/** Pan by (dx, dy) from `from`, clamped. */
export function panBy(from: ZoomView, dx: number, dy: number, fit: Size, stage: Size): ZoomView {
  return clampPan({ scale: from.scale, x: from.x + dx, y: from.y + dy }, fit, stage);
}

/** A two-finger pinch: `start` was the view when two fingers touched, with `d0` between them and
 *  their midpoint at `m0`. Now they are `d` apart at `m`. The image point under `m0` follows `m`. */
export function pinch(start: ZoomView, d0: number, m0: Point, d: number, m: Point, fit: Size, stage: Size, max: number): ZoomView {
  const s = clampScale(start.scale * (d0 > 0 ? d / d0 : 1), max);
  const k = s / start.scale;
  return clampPan({ scale: s, x: m.x - (m0.x - start.x) * k, y: m.y - (m0.y - start.y) * k }, fit, stage);
}

/** The scale after one wheel event. A trackpad pinch arrives as a wheel event with ctrlKey and
 *  small deltas, so it moves faster per pixel. `deltaY` is in pixels. */
export function wheelScale(scale: number, deltaY: number, ctrlKey: boolean): number {
  return scale * Math.exp(-deltaY * (ctrlKey ? 0.01 : 0.002));
}

/** Click or double tap: at fit, zoom to `target`; zoomed, go back to fit. A target that is about
 *  fit already (a small image shown at its actual size) becomes TAP_ZOOM, so the toggle does something. */
export function toggleScale(scale: number, target: number): number {
  if (scale > 1.01) return 1;
  return target > 1.2 ? target : TAP_ZOOM;
}

/** Percent of actual pixels, for the zoom label. */
export function zoomPercent(scale: number, actual: number): number {
  return Math.round((scale / actual) * 100);
}
