// The chat log stays pinned to its tail when content grows after it rendered (lib/stickToTail): a
// form card that loads its form under the newest reply once pushed the tail below the fold. happy-dom
// lays out nothing, so a fake ResizeObserver stands in for the browser's and the test fires it.
import { expect, test } from "bun:test";
import { stickToTail } from "@/lib/stickToTail";

class FakeResize {
  static last: FakeResize | undefined;
  observed = new Set<Element>();
  disconnected = false;
  constructor(readonly fire: () => void) { FakeResize.last = this; }
  observe(el: Element) { this.observed.add(el); }
  unobserve(el: Element) { this.observed.delete(el); }
  disconnect() { this.disconnected = true; this.observed.clear(); }
}

function log(children = 2) {
  const el = document.createElement("div");
  for (let i = 0; i < children; i++) el.appendChild(document.createElement("div"));
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 1200 });
  const scrolls: number[] = [];
  el.scrollTo = ((o: ScrollToOptions) => { scrolls.push(o.top ?? -1); }) as typeof el.scrollTo;
  return { el, scrolls };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test("a resize of the log or of a turn in it pins a reader at the tail to the end; a reader who scrolled up stays", () => {
  const { el, scrolls } = log();
  let following = true;
  const stop = stickToTail(el, () => following, FakeResize as unknown as typeof ResizeObserver);
  const ro = FakeResize.last!;
  expect([...ro.observed]).toEqual([el, ...Array.from(el.children)]);
  ro.fire(); // a form card in the last turn finished loading: its turn grew
  expect(scrolls).toEqual([1200]);
  following = false; // the reader scrolled up to read
  ro.fire();
  expect(scrolls).toEqual([1200]);
  stop();
  expect(ro.disconnected).toBe(true);
});

test("a turn mounted later is watched too, and a removed one is let go", async () => {
  const { el } = log(1);
  const stop = stickToTail(el, () => true, FakeResize as unknown as typeof ResizeObserver);
  const ro = FakeResize.last!;
  const first = el.children[0]!;
  const added = document.createElement("div");
  el.appendChild(added);
  first.remove();
  await flush(); // the MutationObserver's callback is a microtask
  expect(ro.observed.has(added)).toBe(true);
  expect(ro.observed.has(first)).toBe(false);
  expect(ro.observed.has(el)).toBe(true);
  stop();
});

test("no ResizeObserver (an old browser): nothing to do, and the cleanup is safe", () => {
  const { el, scrolls } = log();
  stickToTail(el, () => true, undefined)();
  expect(scrolls).toEqual([]);
});
