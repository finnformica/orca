// The hover marquee's pure decisions (web/src/lib/marquee.ts, used by components/ui/marquee-text.tsx
// on the notification cards): whether a title is really truncated, and how fast it should scroll.
import { describe, expect, test } from "bun:test";
import { isTruncated, marqueeDuration } from "../web/src/lib/marquee";

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
