// The hover marquee's pure decisions (web/src/lib/marquee.ts, mounted app-wide by
// components/OverflowText.tsx): whether text is really truncated, how fast it scrolls, and where it
// is at a time. The DOM side is tests/overflowText.test.tsx.
import { describe, expect, test } from "bun:test";
import { isTruncated, MARQUEE_HOLD_END_MS, MARQUEE_HOLD_START_MS, marqueeDuration, marqueeOffset } from "../web/src/lib/marquee";

describe("isTruncated", () => {
  test("a box exactly as wide as its content is not truncated", () => {
    expect(isTruncated(200, 200)).toBe(false);
    expect(isTruncated(199, 200)).toBe(false); // content narrower than the box
  });

  test("a sub-pixel layout gap doesn't count as truncated", () => {
    expect(isTruncated(200.4, 200)).toBe(false);
  });

  test("content wider than its box is truncated", () => {
    expect(isTruncated(260, 200)).toBe(true);
  });
});

describe("marqueeDuration", () => {
  test("scales with the overflow, so it isn't the same speed regardless of length", () => {
    const short = marqueeDuration(40);
    const long = marqueeDuration(300); // below the max clamp, so the rate stays comparable
    expect(long).toBeGreaterThan(short);
    // Roughly the same px/ms rate for both — the "feel the same" requirement.
    expect(long / 300).toBeCloseTo(short / 40, 1);
  });

  test("clamps to a minimum so a tiny overflow still reads as motion", () => {
    expect(marqueeDuration(1)).toBeGreaterThanOrEqual(400);
  });

  test("clamps to a maximum so a huge overflow doesn't crawl forever", () => {
    expect(marqueeDuration(100_000)).toBeLessThanOrEqual(6000);
  });
});

describe("marqueeOffset", () => {
  const px = 180; // travel = marqueeDuration(180)
  const travel = marqueeDuration(px);
  test("holds at the start, eases to the end, holds there, eases back, and repeats", () => {
    expect(marqueeOffset(0, px)).toBe(0);
    expect(marqueeOffset(MARQUEE_HOLD_START_MS - 1, px)).toBe(0);
    const mid = marqueeOffset(MARQUEE_HOLD_START_MS + travel / 2, px);
    expect(mid).toBe(px / 2);
    expect(marqueeOffset(MARQUEE_HOLD_START_MS + travel + MARQUEE_HOLD_END_MS / 2, px)).toBe(px);
    const back = MARQUEE_HOLD_START_MS + travel + MARQUEE_HOLD_END_MS;
    expect(marqueeOffset(back + travel / 2, px)).toBe(px / 2);
    const period = back + travel;
    expect(marqueeOffset(period, px)).toBe(0);
    expect(marqueeOffset(period + MARQUEE_HOLD_START_MS + travel / 2, px)).toBe(px / 2); // the next cycle
  });

  test("smooth: no jump at the turn points, and never outside 0..overflow", () => {
    let prev = 0;
    for (let t = 0; t < 2 * (MARQUEE_HOLD_START_MS + travel + MARQUEE_HOLD_END_MS); t += 16) {
      const x = marqueeOffset(t, px);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(px);
      expect(Math.abs(x - prev)).toBeLessThanOrEqual(6); // ~one frame's step at most
      prev = x;
    }
  });

  test("no overflow, no motion", () => {
    expect(marqueeOffset(5000, 0)).toBe(0);
  });
});
