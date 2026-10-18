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
import { SHELL_GAP, frozenPageWidth } from "@/workstream";
import { SLIDE_MS } from "@/components/SidePanel";
import { orchestratorOpenAtom, sidebarCollapsedAtom } from "@/lib/atoms";
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
  s.set(sidebarCollapsedAtom, false);
  s.set(navExpandedOverrideAtom, false);
  Object.defineProperty(window, "innerWidth", { value: prevWidth, configurable: true });
});
const $ = <T extends Element = HTMLElement>(sel: string) => container!.querySelector<T>(sel);
const dock = () => $('[data-slot="dock"]')!;
const sidebar = () => $('[data-slot="sidebar"]')!;
const askButton = () => $<HTMLButtonElement>('button[data-slot="ask-orchestrator"]')!;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
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
  expect(dock().className).toContain("transition-[width,margin-inline-start]"); // width and margin only
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
  expect($('[data-slot="quick-ask"]')!.style.right).toBe("460px"); // the pill centres on the page column
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
  expect(dock().className).toContain("transition-[width,margin-inline-start]");
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

test("frozenPageWidth: the page content's end width, so the content lays out once and only the card edge moves", () => {
  // Opening a 460 panel beside the full nav: the column gives the dock its width and the gutter back.
  expect(frozenPageWidth({ col: 1170, nav: 240, dock: 0, dockMargin: -SHELL_GAP }, { nav: 240, dock: 460, dockMargin: 0 })).toBe(1170 - 460 - SHELL_GAP);
  // At 1280 the nav also turns into its rail: the 184 px it gives back are the page's.
  expect(frozenPageWidth({ col: 1010, nav: 240, dock: 0, dockMargin: -SHELL_GAP }, { nav: 56, dock: 460, dockMargin: 0 })).toBe(1010 + 184 - 460 - SHELL_GAP);
  // Closing reverses it exactly; a reversal mid-slide starts from the in-flight widths.
  expect(frozenPageWidth({ col: 544, nav: 56, dock: 460, dockMargin: 0 }, { nav: 240, dock: 0, dockMargin: -SHELL_GAP })).toBe(544 - 184 + 460 + SHELL_GAP);
  expect(frozenPageWidth({ col: 700, nav: 240, dock: 230, dockMargin: -3 }, { nav: 240, dock: 0, dockMargin: -SHELL_GAP })).toBe(700 + 230 + 3);
});

test("a dock change holds the page frame at its end width during the slide, then lets it go", async () => {
  await mount(1440);
  const frame = $('[data-slot="page-frame"]')!;
  expect(frame.style.width).toBe("");
  await click(askButton());
  expect(frame.style.width).toMatch(/^\d+px$/); // held at its end width while the dock slides
  await act(async () => { await new Promise((r) => setTimeout(r, SLIDE_MS + 120)); });
  expect(frame.style.width).toBe(""); // the slide is over: it follows the column again
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

