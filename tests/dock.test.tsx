// The desktop's docked right column (lib/dock.ts, components/SidePanel.tsx, components/Shell.tsx):
// the orchestrator's panel is a column of the shell, not an overlay. Opened, the shell reserves its
// width (`data-slot="dock"`) so the page reflows beside it; the top-bar button and O toggle it; on a
// narrow desktop the nav gives way to its icon rail so the page keeps DOCK_PAGE_MIN_W — without
// changing the collapse you saved. The whole App, in a real DOM, against the fake api.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { afterDockMotion, dockMoving, noteDockMotion, resetAppStartingForTests } from "@/lib/dock";
import { summarizeSlide } from "@/lib/motionProbe";
import { SHELL_GAP } from "@/workstream";
import { SLIDE_MS } from "@/components/SidePanel";
import { orchestratorOpenAtom, quickAskOpenAtom, sidebarCollapsedAtom } from "@/lib/atoms";
import { navExpandedOverrideAtom } from "@/lib/dock";
import { DOCK_PAGE_MIN_W, NAV_W, PANEL_MIN_W, clampPanelWidth, navRail } from "@/workstream";
import { RESIZE_STEP } from "@/components/SidePanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
const prevWidth = window.innerWidth;
const setViewport = async (w: number) => {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  await act(async () => { window.dispatchEvent(new Event("resize")); await flush(); });
};
async function mount(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });
}
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  apiFake.reset();
  localStorage.clear();
  const s = getDefaultStore();
  s.set(orchestratorOpenAtom, false);
  // The reload test's "a" keystroke (it ends the page-load window) opens the quick-ask box: close it,
  // or a later file in the same process starts with the box open.
  s.set(quickAskOpenAtom, false);
  s.set(sidebarCollapsedAtom, false);
  s.set(navExpandedOverrideAtom, false);
  Object.defineProperty(window, "innerWidth", { value: prevWidth, configurable: true });
});
const $ = <T extends Element = HTMLElement>(sel: string) => container!.querySelector<T>(sel);
const dock = () => $('[data-slot="dock"]')!;
const sidebar = () => $('[data-slot="sidebar"]')!;
const askButton = () => $<HTMLButtonElement>('button[data-slot="ask-orchestrator"]')!;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
/** The dock's width transition, as the browser reports it: transitionrun, then transitionend. */
const transition = (type: "transitionrun" | "transitionend") => {
  const e = new Event(type, { bubbles: true });
  Object.defineProperty(e, "propertyName", { value: "width" });
  dock().dispatchEvent(e);
};
const slide = async () => { await act(async () => { transition("transitionrun"); transition("transitionend"); await flush(); }); };
const key = async (k: string) => { await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); await flush(); }); };

test("navRail: your choice, else the rail only while the dock leaves the page under its floor", () => {
  expect(navRail(true, 1440, 0)).toBe(true); // you collapsed it
  expect(navRail(false, 1280, 0)).toBe(false); // nothing docked
  expect(navRail(false, 1440, 460)).toBe(false); // 1440 − 240 − 460 = 740: room enough
  expect(1280 - NAV_W - 460).toBeLessThan(DOCK_PAGE_MIN_W);
  expect(navRail(false, 1280, 460)).toBe(true); // 580: the nav gives way
  expect(navRail(false, 1280, 460, true)).toBe(false); // …unless you expanded it again
});

test("open, the panel is a docked column: the page reflows, the button and O toggle it", async () => {
  await mount(1440);
  expect(dock().style.width).toBe("0px"); // closed: the column takes no room
  // The page column scrolls on its own on a desktop (no page scrollbar outside the dock); its frame is
  // the container the pages' layouts query; a phone keeps the window's scroll.
  const page = $('[data-slot="page-scroll"]')!.className.split(/\s+/);
  expect(page).toEqual(expect.arrayContaining(["md:h-full", "md:overflow-y-auto", "md:overflow-x-hidden"]));
  expect($('[data-slot="page-frame"]')!.className).toContain("@container/page");
  expect($('[data-slot="page-frame"]')!.parentElement!.dataset.slot).toBe("page-scroll");
  // branch-demo's app shell: the nav on the themed canvas; the page card and, beside it with the
  // shell's gutter, the panel's own card.
  expect($('[data-slot="shell"]')!.className).toContain("md:bg-sidebar");
  expect(sidebar().className).not.toContain("border-r");
  const card = $('[data-slot="shell-card"]')!;
  expect(card.className).toEqual(expect.stringContaining("md:rounded-[10px]"));
  expect(card.className).toContain("md:shadow-shell");
  expect(page.length && $('[data-slot="page-scroll"]')!.parentElement).toBe(card);
  expect(dock().parentElement).toBe(card.parentElement); // a sibling card, not inside the page card
  expect(card.parentElement!.className).toContain("md:gap-1.5");
  expect(dock().style.marginInlineStart).toBe(`-${SHELL_GAP}px`); // closed: cancels the gutter, no empty gap
  expect(dock().hasAttribute("data-painted")).toBe(false); // no card surface while closed
  expect(dock().className).toContain("md:data-[painted]:shadow-shell"); // the surface rides an attribute, not a class change
  expect(dock().className).toContain("transition-[width,min-width,margin-inline-start]"); // width, min-width and margin only
  expect(dock().className).toContain("ease-out");
  expect(parseFloat(dock().style.minWidth)).toBe(0); // closed: no floor, so the width really reaches 0
  expect(page.some((c) => c.startsWith("max-md:") && c.includes("overflow"))).toBe(false);
  await click(askButton());
  const panel = $('[data-slot="orchestrator-panel"]')!;
  expect(panel.dataset.state).toBe("open");
  expect(panel.hasAttribute("data-docked")).toBe(true);
  // In the dock's inner clip (a boolean check: a failed toBe on two DOM nodes prints both trees).
  expect(panel.parentElement!.dataset.slot === "dock-clip" && panel.parentElement!.parentElement === dock()).toBe(true);
  expect(dock().className).not.toContain("overflow-hidden"); // the clip is inside, so the handle hangs in the gutter
  // branch-demo's gutter handle: a child of the dock, outside the clip, the line centred in the 6px gap.
  const handle = $('[data-slot="orchestrator-resize"]')!;
  expect(handle.parentElement === dock()).toBe(true);
  expect(handle.style.left).toBe("-3.5px");
  expect(handle.className).toContain("top-[10px]"); // short of the cards' 10px corners
  expect(panel.className).not.toContain("shadow-modal"); // not an overlay
  expect(panel.className).not.toContain("border-l"); // no shared hairline: the dock card is the edge
  expect(dock().style.width).toBe("460px"); // the page's row reserves the panel's width
  expect(["0", "0px"]).toContain(dock().style.marginInlineStart);
  expect(dock().hasAttribute("data-painted")).toBe(true); // its own raised card
  expect(askButton().getAttribute("aria-expanded")).toBe("true");
  expect($('[data-slot="quick-ask"]')!.parentElement!.dataset.slot).toBe("shell-card"); // the pill centres on the page card
  expect(sidebar().dataset.collapsed).toBe("false"); // 1440: the full nav still fits
  await click(askButton()); // the same button closes it
  expect(panel.dataset.state).toBe("closed");
  expect(dock().style.width).toBe("0px");
  expect($('[data-slot="orchestrator-resize"]')).toBeNull(); // nothing to grab in the gap while it closes
  await key("o"); // O opens…
  expect(panel.dataset.state).toBe("open");
  (document.activeElement as HTMLElement | null)?.blur(); // the composer took focus; O in a field is a letter
  await key("o"); // …and closes
  expect(panel.dataset.state).toBe("closed");
});

test("a narrow desktop: the open dock turns the nav into its rail, your saved choice untouched", async () => {
  await mount(1280);
  expect(sidebar().dataset.collapsed).toBe("false");
  await click(askButton());
  expect(sidebar().dataset.collapsed).toBe("true"); // the rail, so the page keeps its room
  expect(sidebar().className).toContain("md:w-14");
  expect(getDefaultStore().get(sidebarCollapsedAtom)).toBe(false); // not saved as collapsed
  await click($('button[aria-label="Expand sidebar"]')!); // you can still have the full nav
  expect(sidebar().dataset.collapsed).toBe("false");
  expect(getDefaultStore().get(sidebarCollapsedAtom)).toBe(false);
  await click($('button[aria-label="Collapse sidebar"]')!); // and back to the rail
  expect(sidebar().dataset.collapsed).toBe("true");
  expect(getDefaultStore().get(sidebarCollapsedAtom)).toBe(false);
  await click(askButton()); // closed: the nav is as you left it
  expect(sidebar().dataset.collapsed).toBe("false");
  await setViewport(1440); // wide again with the panel open: the full nav
  await click(askButton());
  expect(sidebar().dataset.collapsed).toBe("false");
});

test("the edge resizes from the keyboard too: ← widens, → narrows, and the dock follows", async () => {
  await mount(1440);
  await click(askButton());
  const edge = $('[data-slot="orchestrator-resize"]')!;
  expect(edge.tabIndex).toBe(0);
  const press = async (k: string) => { await act(async () => { edge.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); await flush(); }); };
  await press("ArrowLeft");
  expect(dock().style.width).toBe(`${460 + RESIZE_STEP}px`);
  expect(JSON.parse(localStorage.getItem("orca.ui.v1.orchestratorWidth")!)).toBe(460 + RESIZE_STEP);
  await press("End"); // as wide as the page's floor allows
  expect(dock().style.width).toBe(`${clampPanelWidth(Number.MAX_SAFE_INTEGER, 1440)}px`);
  await press("ArrowRight");
  expect(dock().style.width).toBe(`${clampPanelWidth(Number.MAX_SAFE_INTEGER, 1440) - RESIZE_STEP}px`);
  await press("Home");
  expect(dock().style.width).toBe(`${PANEL_MIN_W}px`);
});

test("a resize is not a slide: an arrow key or a drag moves the dock with no width transition and never holds the page frame", async () => {
  await mount(1440);
  await click(askButton());
  await slide(); // the open slide is over
  const frame = $('[data-slot="page-frame"]')!;
  const edge = $('[data-slot="orchestrator-resize"]')!;
  expect(frame.style.width).toBe("");
  // Every write to the dock's and the frame's width, seen as it happens: the dock's width may change
  // only while `data-resizing` turns its transition off, and the frame's width is never written.
  const writes: { el: string; from: string; to: string; resizing: boolean }[] = [];
  const spy = (el: HTMLElement) => {
    const proto = Object.getPrototypeOf(el.style);
    const d = (function find(o: object | null): PropertyDescriptor | undefined { return o ? Object.getOwnPropertyDescriptor(o, "width") ?? find(Object.getPrototypeOf(o)) : undefined; })(proto)!;
    Object.defineProperty(el.style, "width", { configurable: true, get() { return d.get!.call(this); },
      set(v: string) { writes.push({ el: el.dataset.slot!, from: d.get!.call(this), to: v, resizing: el.hasAttribute("data-resizing") }); d.set!.call(this, v); } });
    return () => { delete (el.style as unknown as Record<string, unknown>).width; };
  };
  const unspy = [spy(dock()), spy(frame)];
  const press = async (k: string) => { await act(async () => { edge.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); await flush(); }); };
  await press("ArrowLeft");
  await press("ArrowRight");
  await press("ArrowRight");
  // A drag, then its release (the release saves the width, which once held the frame at width + delta).
  await act(async () => {
    edge.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 900 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 860 }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 860 }));
    await flush();
  });
  unspy.forEach((f) => f());
  let dockChanges = 0;
  for (const w of writes) {
    if (w.el === "page-frame" && w.to) throw new Error(`the page frame was held at ${w.to} by a resize`);
    if (w.el !== "dock" || w.from === w.to) continue;
    expect(w.resizing).toBe(true); // a dock width change with the transition on slides 150ms behind the handle
    dockChanges++;
  }
  expect(dockChanges).toBe(4);
  expect(dock().style.width).toBe(`${460 - RESIZE_STEP + 40}px`);
  expect(dock().hasAttribute("data-resizing")).toBe(false); // the transition is back for the next open / close
  expect(frame.style.width).toBe("");
});

test("the pill's strip is placed by the page card: no transition or offset of its own, so it moves with the card edge in every frame of an open, a close and a resize", async () => {
  await mount(1440);
  const strip = () => $('[data-slot="quick-ask"]')!;
  const card = $('[data-slot="shell-card"]')!;
  // Absolute in the card, full width, content centred: where the card's edge is, the strip's edge is.
  // PR 328's fixed strip ran its own `right` transition off `--dock-w`, apart from the dock's — Finn
  // saw the pill snap to its end place before the card had finished.
  const placedByCard = () => {
    const s = strip();
    expect(s.parentElement === card).toBe(true);
    expect(card.className.split(/\s+/)).toContain("relative");
    expect(s.className.split(/\s+/)).toEqual(expect.arrayContaining(["absolute", "inset-x-0", "justify-center"]));
    expect(s.className).not.toMatch(/\bfixed\b|transition|\bleft-|\bright-/);
    expect(s.getAttribute("style")).toBeNull();
  };
  placedByCard();
  await click(askButton()); // an open: the dock's width changes, the card shrinks, the strip with it
  transition("transitionrun");
  placedByCard();
  await act(async () => { transition("transitionend"); await flush(); });
  const edge = $('[data-slot="orchestrator-resize"]')!;
  await act(async () => {
    edge.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 900 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 860 }));
  });
  // Mid-drag, before pointerup: the dock already has the new width with its transition off, so the
  // card (and the strip in it) reflows in the pointer move's own frame.
  expect(dock().style.width).toBe("500px");
  expect(dock().hasAttribute("data-resizing")).toBe(true);
  placedByCard();
  await act(async () => { window.dispatchEvent(new PointerEvent("pointerup", { clientX: 860 })); await flush(); });
  act(() => { edge.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
  expect(dock().style.width).toBe(`${500 + RESIZE_STEP}px`);
  placedByCard();
  await click(askButton()); // a close
  placedByCard();
  expect(document.documentElement.style.getPropertyValue("--dock-w")).toBe(""); // no second source of truth
});

test("the motion flag: work that measures the page waits while the dock or the nav animates its width, then runs once", () => {
  const calls: string[] = [];
  const measure = () => calls.push("measure");
  afterDockMotion(measure);
  expect(calls).toEqual(["measure"]); // nothing moving: at once
  noteDockMotion(1); // the dock's width transition started
  expect(dockMoving()).toBe(true);
  afterDockMotion(measure);
  afterDockMotion(measure); // a ResizeObserver firing every frame queues it once
  noteDockMotion(1); // the nav's rail transition too
  noteDockMotion(-1);
  expect(calls).toEqual(["measure"]); // still moving: no React state per frame
  noteDockMotion(-1);
  expect(dockMoving()).toBe(false);
  expect(calls).toEqual(["measure", "measure"]); // settled: once
});

test("opening: the panel shows in the commit that opens it at dock width 0, and the width opens on the next frame", async () => {
  await mount(1440);
  act(() => { askButton().dispatchEvent(new MouseEvent("click", { bubbles: true })); }); // the commit, before any frame
  const panel = $('[data-slot="orchestrator-panel"]')!;
  expect(panel.dataset.state).toBe("open");
  expect(panel.className).not.toMatch(/invisible|visibility/); // it can take focus now
  expect(dock().style.width).toBe("0px"); // …but the width waits a frame, so 0 → 460 is a real transition
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); await flush(); });
  expect(dock().style.width).toBe("460px");
  expect(dock().style.minWidth).toBe("360px"); // open: the floor tweens with the width
  expect(dock().className).toContain("data-[resizing]:transition-none");
  expect($('[data-slot="page-scroll"]')!.className).toContain("md:[contain:layout_paint]");
});

test("a reload with the panel's open state persisted true shows it at its full width at once — no 0 → width slide to replay", async () => {
  localStorage.setItem("orca.ui.v1.orchestratorOpen", "true");
  resetAppStartingForTests(); // a real reload re-arms the page-load window; this test process shares it across files
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => { root = createRoot(container!); root.render(<App />); }); // the commit a reload's first paint is
  expect($('[data-slot="orchestrator-panel"]')!.dataset.state).toBe("open");
  expect(dock().style.width).toBe("460px"); // never 0px first: `appStarting` skipped the slide
  await act(async () => { await flush(); await flush(); });
  expect(dock().style.width).toBe("460px"); // settles unchanged
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })); // end the page-load window, as a real keystroke would
});

test("the page frame follows the card edge through an open and a close: nothing writes its width (PR 328 held it at the end width)", async () => {
  await mount(1440);
  const frame = $('[data-slot="page-frame"]')!;
  expect(frame.className).toContain("md:[contain:layout_paint]"); // the reflow per frame stays inside it
  expect(frame.parentElement!.className).toContain("md:[contain:layout_paint]"); // and inside the column
  const writes: string[] = [];
  const proto = Object.getPrototypeOf(frame.style);
  const d = (function find(o: object | null): PropertyDescriptor | undefined { return o ? Object.getOwnPropertyDescriptor(o, "width") ?? find(Object.getPrototypeOf(o)) : undefined; })(proto)!;
  Object.defineProperty(frame.style, "width", { configurable: true, get() { return d.get!.call(this); },
    set(v: string) { writes.push(v); d.set!.call(this, v); } });
  try {
    for (let i = 0; i < 2; i++) { // open, then close
      await click(askButton());
      transition("transitionrun");
      expect(frame.style.width).toBe(""); // mid-slide: the frame is the column's width, which the card's edge sets
      await act(async () => { await new Promise((r) => setTimeout(r, SLIDE_MS + 60)); });
      await act(async () => { transition("transitionend"); await flush(); });
    }
    expect(dock().style.width).toBe("0px");
    expect(writes).toEqual([]);
    expect(frame.getAttribute("style")).toBeNull();
  } finally {
    delete (frame.style as unknown as Record<string, unknown>).width;
  }
});

test("summarizeSlide: the motion probe's line — frames, the longest frame, and how far the page and the pill were from the card", () => {
  const line = summarizeSlide([
    { t: 0, dock: 0, frameGap: 0, pillGap: 0 },
    { t: 16, dock: 200, frameGap: 0, pillGap: 0 },
    { t: 50, dock: 460, frameGap: -2, pillGap: 1 },
  ], 150);
  expect(line).toBe("slide 0→460 150ms · 3 frames, 3 widths · frame max 34ms mean 25ms · page≠col max 2px · pill≠card max 1px");
  expect(summarizeSlide([], 10)).toBe("slide 10ms, no frames");
});

test("open and close change NO class on the chat's ancestors (a class change there restyles the whole prose chat)", async () => {
  // Measured: Tailwind Typography's `:not(:where([class~=not-prose] *))` makes any class change on an
  // ancestor of the chat restyle all of it — ~4000 elements, 100–150ms each at 4× CPU.
  await mount(1440);
  await click(askButton());
  const panel = $('[data-slot="orchestrator-panel"]')!;
  const classes = () => [dock().className, panel.className];
  const open = classes();
  await click(askButton());
  expect(classes()).toEqual(open); // closing
  await act(async () => { await new Promise((r) => setTimeout(r, SLIDE_MS + 200)); });
  expect(classes()).toEqual(open); // closed and idle
  expect(dock().hasAttribute("data-painted")).toBe(false); // the card's surface went with it, by attribute
  await click(askButton());
  expect(classes()).toEqual(open); // open again
});

test("a close moves the dock's width in the click's own commit: no frame, no effect round trip", async () => {
  await mount(1440);
  await click(askButton());
  expect(dock().style.width).toBe("460px");
  act(() => { askButton().dispatchEvent(new MouseEvent("click", { bubbles: true })); }); // the commit, before any frame
  expect(dock().style.width).toBe("0px");
});

test("a closed, idle panel keeps focus out (no inert: that restyles the chat), and keeps its draft", async () => {
  await mount(1440);
  await click(askButton());
  const panel = $('[data-slot="orchestrator-panel"]')!;
  const box = panel.querySelector("textarea")!;
  await click(askButton());
  await act(async () => { await new Promise((r) => setTimeout(r, SLIDE_MS + 200)); });
  expect(panel.hasAttribute("data-idle")).toBe(true);
  expect(panel.hasAttribute("inert")).toBe(false);
  act(() => { box.focus(); });
  expect(document.activeElement).not.toBe(box); // blurred at once
  expect(panel.contains(box)).toBe(true); // still mounted: the draft and the scroll stay
});

