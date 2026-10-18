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
import { afterDockMotion, dockMoving, noteDockMotion } from "@/lib/dock";
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
  // The page column scrolls on its own on a desktop (no page scrollbar outside the dock) and is the
  // container the pages' layouts query; a phone keeps the window's scroll.
  const page = $('[data-slot="page-scroll"]')!.className.split(/\s+/);
  expect(page).toEqual(expect.arrayContaining(["@container/page", "md:h-full", "md:overflow-y-auto"]));
  // branch-demo's app shell: the nav on the themed canvas, the page and the dock in ONE raised card.
  expect($('[data-slot="shell"]')!.className).toContain("md:bg-sidebar");
  expect(sidebar().className).not.toContain("border-r");
  const card = $('[data-slot="shell-card"]')!;
  expect(card.className).toEqual(expect.stringContaining("md:rounded-[10px]"));
  expect(card.className).toContain("md:shadow-shell");
  expect(page.length && $('[data-slot="page-scroll"]')!.parentElement).toBe(card);
  expect(dock().parentElement).toBe(card);
  expect(page.some((c) => c.startsWith("max-md:") && c.includes("overflow"))).toBe(false);
  await click(askButton());
  const panel = $('[data-slot="orchestrator-panel"]')!;
  expect(panel.dataset.state).toBe("open");
  expect(panel.hasAttribute("data-docked")).toBe(true);
  expect(panel.parentElement).toBe(dock()); // in the dock: its width slides the panel, no transform
  expect(panel.className).not.toContain("shadow-modal"); // a column with a hairline, not an overlay
  expect(dock().style.width).toBe("460px"); // the page's row reserves the panel's width
  expect(askButton().getAttribute("aria-expanded")).toBe("true");
  expect($('[data-slot="quick-ask"]')!.style.right).toBe("460px"); // the pill centres on the page column
  expect(sidebar().dataset.collapsed).toBe("false"); // 1440: the full nav still fits
  await click(askButton()); // the same button closes it
  expect(panel.dataset.state).toBe("closed");
  expect(dock().style.width).toBe("0px");
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
  expect(panel.className).toContain("visible"); // it can take focus now
  expect(dock().style.width).toBe("0px"); // …but the width waits a frame, so 0 → 460 is a real transition
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); await flush(); });
  expect(dock().style.width).toBe("460px");
  expect(dock().className).toContain("transition-[width]");
  expect(dock().className).toContain("data-[resizing]:transition-none");
  expect($('[data-slot="page-scroll"]')!.className).toContain("md:[contain:layout_paint]");
});

