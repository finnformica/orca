// The image lightbox's zoom maths (web/src/lib/zoom.ts): the scale limits, the pan clamp that keeps
// the image on the screen, zoom about a point (the cursor, the fingers), the pinch, and the toggle.
import { expect, test } from "bun:test";
import {
  actualScale, clampPan, clampScale, FIT, maxScale, MAX_ZOOM, panBy, pinch, TAP_ZOOM, toggleScale, wheelScale, zoomAt, zoomPercent,
} from "@/lib/zoom";

const fit = { w: 800, h: 600 };
const stage = { w: 1000, h: 700 };

test("the scale stays between fit and the max", () => {
  expect(clampScale(0.3, 8)).toBe(1);
  expect(clampScale(20, 8)).toBe(8);
  expect(clampScale(3, 8)).toBe(3);
});

test("actual pixels and the max: MAX_ZOOM, or actual pixels when larger", () => {
  expect(actualScale({ w: 2400, h: 1800 }, fit)).toBe(3);
  expect(actualScale({ w: 0, h: 0 }, fit)).toBe(1); // not loaded yet
  expect(maxScale({ w: 2400, h: 1800 }, fit)).toBe(MAX_ZOOM);
  expect(maxScale({ w: 8000, h: 6000 }, fit)).toBe(10);
});

test("the pan clamp keeps the image on the screen", () => {
  // At fit the image is smaller than the stage: it stays centred.
  expect(clampPan({ scale: 1, x: 200, y: -50 }, fit, stage)).toEqual(FIT);
  // At 2x the image is 1600 x 1200: it pans at most 300 / 250 px each way.
  expect(clampPan({ scale: 2, x: 1000, y: -1000 }, fit, stage)).toEqual({ scale: 2, x: 300, y: -250 });
  expect(clampPan({ scale: 2, x: 120, y: 40 }, fit, stage)).toEqual({ scale: 2, x: 120, y: 40 });
  // Wide but short: x pans, y stays centred.
  expect(clampPan({ scale: 1.5, x: -999, y: 99 }, { w: 800, h: 300 }, stage)).toEqual({ scale: 1.5, x: -100, y: 0 });
});

test("zoom about a point keeps the image point under it in place", () => {
  const at = { x: 100, y: 50 };
  const v = zoomAt(FIT, 2, at, fit, stage, 8);
  expect(v.scale).toBe(2);
  // The image point under `at` at fit is (100, 50) from the centre; at 2x it is at x + 2 * 100.
  expect(v.x + 2 * 100).toBe(at.x);
  expect(v.y + 2 * 50).toBe(at.y);
  // Zoom again about the same point: still the same image point.
  const w = zoomAt(v, 4, at, fit, stage, 8);
  expect(w.x + 4 * 100).toBe(at.x);
  expect(w.y + 4 * 50).toBe(at.y);
});

test("zoom about a point near the edge is clamped, and zoom out to fit recentres", () => {
  const v = zoomAt(FIT, 2, { x: 500, y: 350 }, fit, stage, 8);
  expect(v).toEqual({ scale: 2, x: -300, y: -250 }); // the clamp, not -500 / -350
  expect(zoomAt(v, 0.5, { x: 10, y: 10 }, fit, stage, 8)).toEqual(FIT);
  expect(zoomAt(v, 50, { x: 0, y: 0 }, fit, stage, 8).scale).toBe(8);
});

test("a drag pans from where it started, clamped", () => {
  const start = { scale: 2, x: 0, y: 0 };
  expect(panBy(start, 40, -30, fit, stage)).toEqual({ scale: 2, x: 40, y: -30 });
  expect(panBy(start, 4000, 0, fit, stage)).toEqual({ scale: 2, x: 300, y: 0 });
  expect(panBy(FIT, 40, 40, fit, stage)).toEqual(FIT); // at fit there is nothing to pan
});

test("a pinch scales by the finger distance and follows the midpoint", () => {
  const v = pinch(FIT, 100, { x: 0, y: 0 }, 300, { x: 0, y: 0 }, fit, stage, 8);
  expect(v).toEqual({ scale: 3, x: 0, y: 0 });
  // The midpoint moves 20 px right: the image follows.
  expect(pinch(FIT, 100, { x: 0, y: 0 }, 300, { x: 20, y: 0 }, fit, stage, 8).x).toBe(20);
  // Pinch in past fit stops at fit.
  expect(pinch({ scale: 2, x: 50, y: 0 }, 300, { x: 0, y: 0 }, 50, { x: 0, y: 0 }, fit, stage, 8)).toEqual(FIT);
});

test("the wheel zooms in on a scroll up and out on a scroll down; a trackpad pinch is faster", () => {
  expect(wheelScale(1, -100, false)).toBeGreaterThan(1);
  expect(wheelScale(2, 100, false)).toBeLessThan(2);
  expect(wheelScale(1, -10, true)).toBeGreaterThan(wheelScale(1, -10, false));
});

test("the toggle goes from fit to the target and back; a target about fit becomes TAP_ZOOM", () => {
  expect(toggleScale(1, 3)).toBe(3);
  expect(toggleScale(3, 3)).toBe(1);
  expect(toggleScale(1, 1.05)).toBe(TAP_ZOOM);
  expect(zoomPercent(3, 3)).toBe(100);
  expect(zoomPercent(1, 1.25)).toBe(80);
});
