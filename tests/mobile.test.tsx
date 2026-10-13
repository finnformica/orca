// The phone layout and the PWA. Pure decisions first (Enter on touch, preview links seen from a phone,
// staleness, a newer build), then the installable-app files, then the App rendered as a 390px touch
// screen (window.matchMedia answering the phone's media queries) against the fake api — and the same
// App as a desktop, which must show none of it.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import { getDefaultStore } from "jotai";
import { orchestratorOpenAtom } from "@/lib/atoms";
import { COARSE_QUERY, NARROW_QUERY, enterSends, expandTruncatedOnTap, trackVisualViewport } from "@/lib/viewport";
import { poll } from "@/lib/poll";
import { PULL_REFRESH_PX, pullState, swipeDecision, STALE_AFTER_MS, launchOverlay, newerBuild, previewHref, previewLabel, staleAge } from "@/workstream";
import { themeColor } from "@/lib/theme";
import { UpdateBanner } from "@/components/Freshness";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

describe("phone decisions (pure)", () => {
  test("Enter sends with a keyboard; on a touch screen it is a newline and the button sends", () => {
    const plain = { shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };
    expect(enterSends(plain, false)).toBe(true);
    expect(enterSends({ ...plain, shiftKey: true }, false)).toBe(false);
    expect(enterSends({ ...plain, isComposing: true }, false)).toBe(false);
    expect(enterSends(plain, true)).toBe(false);
  });

  test("a preview link never points a phone at its own localhost", () => {
    // An owner with no ORCA_PREVIEW_HOST hands out localhost; seen over the tailnet, the page's host wins.
    expect(previewHref({ url: "http://localhost:5199" }, "orca-box.tail622bd5.ts.net")).toBe("http://orca-box.tail622bd5.ts.net:5199");
    expect(previewHref({ url: "http://127.0.0.1:5199/app/" }, "100.64.0.7")).toBe("http://100.64.0.7:5199/app/");
    // Unchanged: the tailnet url stays; the laptop's own page still opens its loopback.
    expect(previewHref({ url: "http://orca-box:9001" }, "orca-box")).toBe("http://orca-box:9001");
    expect(previewHref({ url: "http://orca-box:9001", localUrl: "http://localhost:9001" }, "localhost")).toBe("http://localhost:9001");
    expect(previewLabel("http://orca-box.tail622bd5.ts.net:5199")).toBe("orca-box.tail622bd5.ts.net:5199");
  });

  test("stale: only once the board has loaded and gone unanswered past the threshold", () => {
    expect(staleAge(0, 10_000_000)).toBeNull(); // nothing loaded yet is "loading", not stale
    expect(staleAge(1_000, 1_000 + STALE_AFTER_MS)).toBeNull();
    expect(staleAge(1_000, 1_000 + STALE_AFTER_MS + 5)).toBe(STALE_AFTER_MS + 5);
  });

  test("a newer build: a different served id; never in dev or on a garbled answer", () => {
    expect(newerBuild("2026-10-13T07:00:00Z", { build: "2026-10-13T08:00:00Z" })).toBe(true);
    expect(newerBuild("2026-10-13T07:00:00Z", { build: "2026-10-13T07:00:00Z" })).toBe(false);
    expect(newerBuild("dev", { build: "x" })).toBe(false);
    expect(newerBuild(undefined, { build: "x" })).toBe(false);
    expect(newerBuild("a", "<html>")).toBe(false);
  });
});

describe("installable app (PWA files)", () => {
  const read = (p: string) => Bun.file(new URL(`../web/${p}`, import.meta.url));
  const pngSize = async (p: string) => { const b = new DataView(await read(p).arrayBuffer()); return [b.getUint32(16), b.getUint32(20)]; };

  test("manifest: standalone, themed, with home-screen icons that exist at their stated sizes", async () => {
    const m = await read("public/manifest.webmanifest").json() as { display: string; theme_color: string; start_url: string; icons: { src: string; sizes: string; purpose?: string }[] };
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    for (const icon of m.icons.filter((i) => i.src.endsWith(".png"))) {
      const [w, h] = await pngSize(`public${icon.src}`);
      expect(`${w}x${h}`).toBe(icon.sizes);
    }
    expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
    expect(await pngSize("public/apple-touch-icon.png")).toEqual([180, 180]);
  });

  test("maskable icon: its own file, full-bleed, the whole mark inside the 80% safe zone", async () => {
    const m = await read("public/manifest.webmanifest").json() as { icons: { src: string; sizes: string; purpose?: string }[] };
    const maskable = m.icons.filter((i) => i.purpose === "maskable");
    expect(maskable.map((i) => i.src)).toEqual(["/icon-maskable-512.png"]); // never the round "any" icon, which Android would crop
    expect(m.icons.filter((i) => i.purpose !== "maskable").map((i) => i.src)).not.toContain("/icon-maskable-512.png");
    expect(await pngSize("public/icon-maskable-512.png")).toEqual([512, 512]);
    const svg = await read("public/icon-maskable.svg").text();
    expect(svg).toContain('<rect width="24" height="24" fill="#000" />'); // full bleed
    const [, tx, ty, k] = svg.match(/translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)/)!.map(Number);
    // The mark's path spans x 2…22.5, y 3…15.5; every corner of that box must fall within r = 0.4 × 24.
    for (const [x, y] of [[2, 3], [22.5, 3], [2, 15.5], [22.5, 15.5]]) expect(Math.hypot(tx! + k! * x! - 12, ty! + k! * y! - 12)).toBeLessThanOrEqual(9.6);
  });

  test("manifest polish: an id, any orientation, the theme tokens' colours, shortcuts the app understands", async () => {
    const m = await read("public/manifest.webmanifest").json() as {
      id: string; orientation: string; theme_color: string; background_color: string;
      user_preferences: { color_scheme_dark: { theme_color: string; background_color: string } };
      shortcuts: { name: string; url: string }[];
    };
    expect(m.id).toBe("/");
    expect(m.orientation).toBe("any");
    expect([themeColor(false), themeColor(true)]).toEqual(["#f9f9f8", "#111111"]); // PR 134's --background tokens
    expect([m.theme_color, m.background_color]).toEqual([themeColor(false), themeColor(false)]);
    const html = await read("index.html").text();
    expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${themeColor(false)}" />`);
    expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${themeColor(true)}" />`);
    expect(m.user_preferences.color_scheme_dark).toEqual({ theme_color: themeColor(true), background_color: themeColor(true) });
    expect(m.shortcuts.map((s) => [s.name, launchOverlay(new URL(s.url, "http://x").search)])).toEqual([["New agent", "new"], ["Orchestrator", "orchestrator"]]);
    expect(launchOverlay("?open=nope")).toBeNull();
  });

  test("installed-app feel: standalone CSS stops overscroll, tap delay and highlight, chrome selection; touch gets pressed states", async () => {
    const css = await read("src/styles.css").text();
    const block = (open: string) => { const i = css.indexOf(open); expect(i).toBeGreaterThan(-1); let depth = 0, j = css.indexOf("{", i); const start = j; for (; j < css.length; j++) { if (css[j] === "{") depth++; else if (css[j] === "}" && --depth === 0) break; } return css.slice(start, j); };
    const standalone = block("@media (display-mode: standalone)");
    for (const decl of ["overscroll-behavior: none", "touch-action: manipulation", "-webkit-tap-highlight-color: transparent", "user-select: none", "-webkit-touch-callout: none"]) expect(standalone).toContain(decl);
    expect(standalone).toMatch(/:where\(input, textarea, \[contenteditable="true"\]\) \{\s*-webkit-user-select: text;\s*user-select: text;/); // fields stay editable
    expect(standalone).not.toMatch(/\bmain\b|\.prose|body \{[^}]*user-select/); // content stays selectable
    const touch = block("@media (hover: none)");
    expect(touch).toContain(":active");
    expect(touch).toContain("currentColor");
  });

  test("index.html: manifest, theme-color per scheme, Apple tags, safe-area viewport", async () => {
    const html = await read("index.html").text();
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toMatch(/<meta name="theme-color" media="\(prefers-color-scheme: light\)"/);
    expect(html).toMatch(/<meta name="theme-color" media="\(prefers-color-scheme: dark\)"/);
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain("viewport-fit=cover");
  });

  test("the logo is round, like Vercel's: favicon and home-screen icon draw the mark in a circle", async () => {
    expect(await read("public/favicon.svg").text()).toContain("<circle");
    expect(await read("public/icon.svg").text()).toContain("<circle");
  });
});

describe("polling", () => {
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  afterEach(() => { visibility = "visible"; });

  test("hidden: nothing is fetched; shown again: it fetches at once, not a tick later", async () => {
    let calls = 0;
    visibility = "hidden";
    const stop = poll(() => { calls++; }, 60_000);
    await Bun.sleep(10);
    expect(calls).toBe(0);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await Bun.sleep(10);
    expect(calls).toBe(1);
    stop();
  });
});

// ---- the App on a phone and on a desktop ----

const realMatchMedia = window.matchMedia;
function emulate(phone: boolean) {
  const on = phone ? [NARROW_QUERY, COARSE_QUERY] : [];
  window.matchMedia = ((q: string) => ({ matches: on.includes(q), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(path: string, phone: boolean) {
  emulate(phone);
  apiFake.agentsData = [
    { branch: "feat-phone", worktreePath: "/wt/feat-phone", agentStatus: "error", agentError: "rate limited", agentStartedAt: Date.now() - 60_000, agentFinishedAt: Date.now() - 30_000 },
  ];
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
}
afterEach(async () => {
  window.matchMedia = realMatchMedia;
  act(() => { getDefaultStore().set(orchestratorOpenAtom, false); });
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  localStorage.clear();
  navigate("/");
});
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); await flush(); await flush(); }); };

describe("the phone layout (390px, touch)", () => {
  test("a bottom bar within thumb reach; the top bar trades its Ask box for the round mark", async () => {
    await mount("/", true);
    const bar = $('[data-slot="bottom-bar"]')!;
    expect([...bar.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Menu", "Agents", "New agent", "Orchestrator"]);
    expect(bar.className).toContain("md:hidden"); // never on a desktop-width screen
    expect(bar.className).toContain("safe-area-inset-bottom");
    expect($('[data-slot="topbar-mark"]')!.className).toContain("md:hidden");
    expect($('[data-slot="ask-orchestrator"]')!.className).toContain("max-md:hidden");
    await click([...bar.querySelectorAll("button")].find((b) => b.textContent === "Agents")!);
    expect(location.pathname).toBe("/agents");
  });

  test("Agents: rows stack with the instruction, error and branch on screen; one ⋯ per row; filters in a sheet", async () => {
    await mount("/agents", true);
    expect($('[data-slot="workstream-list-header"]')).toBeNull();
    const row = $('[data-branch="feat-phone"]')!;
    expect(row.dataset.layout).toBe("stacked");
    expect(row.style.gridTemplateColumns).toBe("");
    expect(row.querySelector('[data-slot="row-error"]')!.textContent).toBe("rate limited");
    expect(row.textContent).toContain("feat-phone"); // the branch, which desktop keeps in a hover title
    expect(row.querySelectorAll('button[aria-haspopup="menu"]')).toHaveLength(1); // every action in one menu
    expect($('[role="group"][aria-label="Quick filters"]')).toBeNull(); // the chips are in the sheet, not the page
    await click($('[data-slot="filters-button"]')!);
    const sheet = $<HTMLDialogElement>('dialog[data-slot="filter-sheet"]')!;
    expect(sheet.open).toBe(true);
    expect(sheet.querySelectorAll('[data-slot="quick-filter"]').length).toBeGreaterThan(0);
    await click(sheet.querySelector('[data-slot="quick-filter"][data-chip="status:attention"]')!);
    expect(location.search).toContain("status=attention");
    expect($('[data-slot="filters-active"]')!.textContent).toBe("1");
  });

  test("the orchestrator opens as a full-screen sheet: no drag, resize or pop out", async () => {
    await mount("/", true);
    await click([...$('[data-slot="bottom-bar"]')!.querySelectorAll("button")].find((b) => b.textContent === "Orchestrator")!);
    await act(async () => { await flush(); await flush(); });
    const panel = $('[data-slot="orchestrator-panel"]')!;
    expect(panel.hasAttribute("data-sheet")).toBe(true);
    expect(panel.className).toContain("sheet");
    expect(document.querySelectorAll('[data-slot="orchestrator-resize"]')).toHaveLength(0);
    expect($('[data-slot="orchestrator-handle"]')!.className).not.toContain("cursor-move");
    expect(document.querySelector('[aria-label="Pop out"]')).toBeNull();
  });

  test("on a touch screen Enter in the composer is a newline, not a send", async () => {
    await mount("/", true);
    act(() => { getDefaultStore().set(orchestratorOpenAtom, true); });
    await act(async () => { await flush(); await flush(); });
    const box = document.querySelector<HTMLTextAreaElement>('[data-slot="orchestrator-panel"] textarea')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(box, "line one");
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { box.dispatchEvent(enter); await flush(); });
    expect(enter.defaultPrevented).toBe(false); // left to the textarea: a newline
    expect(apiFake.orchestratorMessages).toHaveLength(0);
  });

  test("truncated text opens on tap, and closes again", async () => {
    emulate(true);
    const off = expandTruncatedOnTap();
    const el = document.createElement("span");
    el.className = "truncate";
    Object.defineProperty(el, "scrollWidth", { value: 300 });
    Object.defineProperty(el, "clientWidth", { value: 100 });
    document.body.appendChild(el);
    el.click();
    expect(el.dataset.expanded).toBe("true");
    el.click();
    expect(el.dataset.expanded).toBeUndefined();
    off(); el.remove();
  });

  test("the visible viewport's height reaches CSS (the sheets size to it, above the keyboard)", () => {
    const vv = Object.assign(new EventTarget(), { height: 512.4, offsetTop: 40 });
    const fake = { visualViewport: vv, document } as unknown as Window;
    const off = trackVisualViewport(fake);
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("512px");
    vv.height = 300;
    vv.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("300px");
    expect(document.documentElement.style.getPropertyValue("--vv-top")).toBe("40px");
    off();
  });
});

describe("gestures", () => {
  test("swipe thresholds: a quarter of the sheet (≤120px) or a flick closes; less springs back", () => {
    expect(swipeDecision({ dy: 130, ms: 800, height: 800 })).toBe("close");
    expect(swipeDecision({ dy: 100, ms: 800, height: 800 })).toBe("snap");
    expect(swipeDecision({ dy: 50, ms: 50, height: 800 })).toBe("close"); // a flick
    expect(swipeDecision({ dy: 30, ms: 10, height: 800 })).toBe("snap"); // too short to be one
    expect(swipeDecision({ dy: 50, ms: 900, height: 200 })).toBe("close"); // a short sheet's quarter
  });

  test("pull states: idle, pull, then release past the threshold; the indicator is damped and capped", () => {
    expect(pullState(5)).toEqual({ phase: "idle", offset: 0 });
    expect(pullState(60)).toEqual({ phase: "pull", offset: 30 });
    expect(pullState(PULL_REFRESH_PX * 2).phase).toBe("release");
    expect(pullState(1000).offset).toBe(96);
  });

  let clock = 0; // each event 400ms after the last: a deliberate drag, not a flick
  const pointer = (type: string, y: number, target: EventTarget = window) => {
    const e = new PointerEvent(type, { bubbles: true, button: 0, clientY: y });
    Object.defineProperty(e, "timeStamp", { value: (clock += 400) });
    target.dispatchEvent(e);
  };

  test("a bottom sheet closes on a swipe down its header, and stays on a short one", async () => {
    await mount("/agents", true);
    await click($('[data-slot="filters-button"]')!);
    const sheet = $<HTMLDialogElement>('dialog[data-slot="filter-sheet"]')!;
    const handle = sheet.querySelector<HTMLElement>("[data-swipe-handle]")!;
    await act(async () => { pointer("pointerdown", 100, handle); pointer("pointermove", 140); pointer("pointerup", 140); await flush(); });
    expect(sheet.open).toBe(true); // 40px, slowly enough: springs back
    expect(sheet.style.transform).toBe("");
    await act(async () => { pointer("pointerdown", 100, handle); pointer("pointermove", 200); expect(sheet.style.transform).toBe("translateY(100px)"); pointer("pointermove", 400); pointer("pointerup", 400); await flush(); });
    expect(sheet.open).toBe(false);
  });

  test("the orchestrator's phone sheet closes on a swipe down its header", async () => {
    await mount("/", true);
    act(() => { getDefaultStore().set(orchestratorOpenAtom, true); });
    await act(async () => { await flush(); await flush(); });
    const handle = $('[data-slot="orchestrator-handle"]')!;
    await act(async () => { pointer("pointerdown", 50, handle); pointer("pointermove", 400); pointer("pointerup", 400); await flush(); });
    expect(getDefaultStore().get(orchestratorOpenAtom)).toBe(false);
  });

  test("pull to refresh on the Agents list: the indicator follows the finger, and letting go past it refreshes", async () => {
    await mount("/agents", true);
    const list = $('section[aria-label="Agents"]')!;
    const touch = (type: string, y?: number, target: Element = list) => {
      const e = new Event(type, { bubbles: true });
      Object.defineProperty(e, "touches", { value: y === undefined ? [] : [{ clientY: y }] });
      target.dispatchEvent(e);
    };
    // A swipe on the Filters sheet (a dialog inside the list) is the sheet's, never a pull.
    const sheetHandle = list.querySelector('dialog[data-slot="filter-sheet"] [data-swipe-handle]')!;
    await act(async () => { touch("touchstart", 100, sheetHandle); touch("touchmove", 400, sheetHandle); await flush(); });
    expect($('[data-slot="pull-to-refresh"]')).toBeNull();
    await act(async () => { touch("touchend", undefined, sheetHandle); await flush(); });
    const before = store.clientPollCounts().agents;
    await act(async () => { touch("touchstart", 100); touch("touchmove", 160); await flush(); });
    expect($('[data-slot="pull-to-refresh"]')!.textContent).toBe("Pull to refresh");
    await act(async () => { touch("touchmove", 100 + PULL_REFRESH_PX * 2 + 10); await flush(); });
    expect($('[data-slot="pull-to-refresh"]')!.textContent).toBe("Release to refresh");
    await act(async () => { touch("touchend"); await flush(); await flush(); await flush(); });
    expect(store.clientPollCounts().agents).toBeGreaterThan(before);
    expect($('[data-slot="pull-to-refresh"]')).toBeNull(); // done: back to idle
  });
});

describe("home-screen shortcuts", () => {
  test("/?open=orchestrator opens the orchestrator once, and the parameter is dropped", async () => {
    await mount("/?open=orchestrator", true);
    expect(getDefaultStore().get(orchestratorOpenAtom)).toBe(true);
    expect(location.search).toBe("");
  });
});

describe("the desktop layout is untouched", () => {
  test("columns and chips as before; the orchestrator is the movable corner window", async () => {
    await mount("/agents", false);
    expect($('[data-slot="workstream-list-header"]')).not.toBeNull();
    expect($('[data-branch="feat-phone"]')!.dataset.layout).toBeUndefined();
    expect($('[role="group"][aria-label="Quick filters"]')).not.toBeNull();
    expect($('[data-slot="filters-button"]')).toBeNull();
    act(() => { getDefaultStore().set(orchestratorOpenAtom, true); });
    await act(async () => { await flush(); await flush(); });
    expect($('[data-slot="orchestrator-panel"]')!.hasAttribute("data-sheet")).toBe(false);
    expect(document.querySelectorAll('[data-slot="orchestrator-resize"]').length).toBe(8);
  });
});

describe("a newer build", () => {
  test("the banner appears when version.json names another build, and only then", async () => {
    const realFetch = globalThis.fetch;
    let served = "build-1";
    globalThis.fetch = (async (url: string) => {
      expect(url).toBe("/version.json");
      return { json: async () => ({ build: served }) };
    }) as unknown as typeof fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => { root = createRoot(container!); root.render(<UpdateBanner build="build-1" every={5} />); await flush(); });
    await act(async () => { await Bun.sleep(20); });
    expect(container.querySelector('[data-slot="update-banner"]')).toBeNull();
    served = "build-2";
    await act(async () => { await Bun.sleep(30); });
    expect(container.querySelector('[data-slot="update-banner"]')!.textContent).toContain("Refresh");
    globalThis.fetch = realFetch;
  });
});
