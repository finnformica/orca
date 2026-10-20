// The app-wide hover marquee for truncated text (lib/marquee marqueeTruncatedOnHover, mounted once by
// components/OverflowText.tsx): a mouse over a `truncate` element that really overflows scrolls it
// start → end → start; text that fits never moves; a finger never starts it (a tap expands instead);
// leaving resets it. With reduced motion nothing scrolls and the project's Tip shows the full text.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MARQUEE_HOLD_START_MS, marqueeTruncatedOnHover, REDUCED_MOTION_QUERY, type OverflowTipState } from "@/lib/marquee";
import { OverflowText } from "@/components/OverflowText";
import { TooltipProvider } from "@/components/ui/tooltip";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const realMatchMedia = window.matchMedia;
const reducedMotion = (on: boolean) => {
  window.matchMedia = ((q: string) => ({ matches: on && q === REDUCED_MOTION_QUERY, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A `truncate` span whose box is `client` px wide around `scroll` px of text (happy-dom has no layout). */
function truncated(text: string, scroll: number, client: number): HTMLElement {
  const el = document.createElement("span");
  el.className = "min-w-0 truncate";
  el.innerHTML = `<b>${text}</b>`;
  Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => scroll });
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => client });
  document.body.appendChild(el);
  return el;
}
const over = (el: Element, pointerType = "mouse") => el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType }));
const out = (el: Element) => el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body }));

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  window.matchMedia = realMatchMedia;
  document.body.innerHTML = "";
});

describe("marqueeTruncatedOnHover", () => {
  test("a mouse over truncated text scrolls it toward its end; leaving puts it back at the start", async () => {
    reducedMotion(false);
    const el = truncated("feat: a very long workstream title that does not fit", 400, 200);
    cleanups.push(marqueeTruncatedOnHover(window));
    over(el.firstElementChild!); // the pointer lands on the text inside: the `truncate` box is found
    expect(el.dataset.marquee).toBe("");
    await sleep(MARQUEE_HOLD_START_MS + 400);
    expect(el.scrollLeft).toBeGreaterThan(0);
    expect(el.scrollLeft).toBeLessThanOrEqual(200);
    out(el);
    expect(el.scrollLeft).toBe(0);
    expect(el.dataset.marquee).toBeUndefined();
  });

  test("text that fits never moves; a touch pointer never starts it", async () => {
    reducedMotion(false);
    const fits = truncated("short", 200, 200);
    const long = truncated("a long title", 400, 200);
    cleanups.push(marqueeTruncatedOnHover(window));
    over(fits);
    over(long, "touch");
    await sleep(MARQUEE_HOLD_START_MS + 300);
    expect(fits.dataset.marquee).toBeUndefined();
    expect(fits.scrollLeft).toBe(0);
    expect(long.dataset.marquee).toBeUndefined();
    expect(long.scrollLeft).toBe(0);
  });

  test("reduced motion: no scroll, the full text goes to the tip; leaving clears it", async () => {
    reducedMotion(true);
    const el = truncated("the whole branch name", 400, 200);
    const tips: OverflowTipState[] = [];
    cleanups.push(marqueeTruncatedOnHover(window, (t) => tips.push(t)));
    over(el);
    await sleep(MARQUEE_HOLD_START_MS + 300);
    expect(el.scrollLeft).toBe(0);
    expect(tips).toEqual([{ el, text: "the whole branch name" }]);
    out(el);
    expect(tips[tips.length - 1]).toBeNull();
  });
});

describe("OverflowText (root)", () => {
  let root: Root | undefined;
  afterEach(() => { act(() => root?.unmount()); root = undefined; });

  test("reduced motion: the project's Tip opens with the full text over the truncated element", async () => {
    reducedMotion(true);
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<TooltipProvider><OverflowText /></TooltipProvider>));
    const el = truncated("orca/overflow-scroll-and-timer-2d1b17", 400, 120);
    await act(async () => { over(el); await sleep(50); });
    const tip = document.querySelector("[data-slot=tip-content]");
    expect(tip?.textContent).toContain("orca/overflow-scroll-and-timer-2d1b17");
    expect(document.querySelector("[title]")).toBeNull(); // never a native title attribute
    await act(async () => { out(el); await sleep(50); });
    expect(document.querySelector("[data-slot=overflow-tip-anchor]")).toBeNull();
  });
});
