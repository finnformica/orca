// The orchestrator's entry points in the UI: "Ask the orchestrator" in the top bar (a button), the O
// key and the palette open a RIGHT-HAND SIDE PANEL docked as a column beside the page — the same ChatPanel a
// card's terminal uses, in its chat styling, over the orchestrator's own turns, with the composer
// sending to its route (never the branch follow-up launch). Resizable from its left edge (width
// remembered), Esc / ✕ to close, focus returned to the opener. Rendered into a real DOM against the fake api.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { getDefaultStore } from "jotai";
import { AskOrchestrator, ORCHESTRATOR_WINDOW_NAME, ORCHESTRATOR_WINDOW_URL, OrchestratorPage, OrchestratorPanel, OrchestratorWindow, isOrchestratorWindow } from "@/components/Terminal";
import { Dock } from "@/components/Shell";
import { SLIDE_MS } from "@/components/SidePanel";
import { orchestratorActivityAtom, orchestratorOpenAtom, orchestratorPrefillAtom } from "@/lib/atoms";
import { DOCK_PAGE_MIN_W, NAV_RAIL_W, ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, PANEL_MIN_W, clampPanelWidth, dayLabel } from "@/workstream";
import { openTip } from "./tip";
import { NARROW_QUERY } from "@/lib/viewport";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); await flush(); });
}
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  apiFake.reset();
  localStorage.clear();
  delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture;
  document.documentElement.classList.remove("dark");
  getDefaultStore().set(orchestratorOpenAtom, false);
  getDefaultStore().set(orchestratorPrefillAtom, null);
  getDefaultStore().set(orchestratorActivityAtom, { running: false, unread: false });
});
// The shell's dock is where a docked panel renders (a portal), so the entry carries one.
const Entry = () => <><AskOrchestrator /><Dock /><OrchestratorPanel /></>;

const panelEl = () => container!.querySelector<HTMLElement>('[data-slot="orchestrator-panel"]');
/** The open panel, or null: it stays mounted (slid out) once it has been opened. */
const panel = () => { const p = panelEl(); return p && p.dataset.state === "open" ? p : null; };
const launcher = () => container!.querySelector<HTMLButtonElement>('button[data-slot="ask-orchestrator"]')!;
const closeButton = (root: ParentNode = container!) => root.querySelector<HTMLButtonElement>('button[aria-label="Close orchestrator"]')!;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
const DAY = 86_400_000;
/** The status poll starts once the slide is over (useSlideSettled), not in its frames. */
const afterSlide = () => act(async () => { await new Promise((r) => setTimeout(r, SLIDE_MS + 60)); await flush(); await flush(); });

test("Ask the orchestrator opens its conversation in a side panel over the page, and the composer sends to it", async () => {
  const now = Date.now();
  apiFake.turnsData.set("@orca::orchestrator", [
    { id: "run-0", provider: "claude", instruction: "yesterday's ask", prompt: "p", response: "Done yesterday.", startedAt: now - DAY, finishedAt: now - DAY + 1 },
    { id: "run-1", provider: "claude", instruction: "ship the cache", prompt: "p", response: "Spawned r/add-cache.", startedAt: now - 1000, finishedAt: now },
  ]);
  apiFake.orchestratorState = { ...apiFake.orchestratorState, model: "claude-opus-5-5", contextPct: 42 };
  await mount(<Entry />);
  expect(panelEl()).toBeNull(); // never opened: nothing mounted
  expect(container!.querySelector("dialog")).toBeNull(); // not a modal — the board stays usable
  expect(container!.querySelector("input")).toBeNull(); // the entry is a button, not a text box

  launcher().focus(); // a real click focuses the button first
  await click(launcher());
  const p = panel()!;
  // A desktop: docked INTO the shell's dock column (no overlay, no transform, no shadow) — the
  // dock's width animates and clips it, so the page reflows in the same frame.
  expect(p.parentElement!.dataset.slot).toBe("dock-clip"); // the dock's inner clip: the resize handle hangs outside it
  expect(p.parentElement!.parentElement!.dataset.slot).toBe("dock");
  expect(p.hasAttribute("data-docked")).toBe(true);
  expect(p.className).toContain("absolute inset-y-0 left-0");
  expect(p.className).not.toContain("fixed");
  expect(p.className).not.toContain("translate-x");
  expect(p.className).not.toContain("shadow-modal");
  // Never hidden by a style (a visibility / content-visibility / inert flip restyles the whole chat):
  // open, it is on top by an inline z-index, and it can take focus at once.
  expect(p.className).not.toMatch(/invisible|visibility|inert/);
  expect(p.style.zIndex).toBe("1");
  expect(p.getAttribute("role")).toBe("dialog");
  expect(p.getAttribute("aria-modal")).toBe("false");
  expect(p.getAttribute("aria-hidden")).toBe("false");
  expect(p.querySelector("#orchestrator-title")!.textContent).toBe("Orchestrator");
  expect(document.activeElement).toBe(p.querySelector("textarea")); // focused, ready to type
  expect(p.textContent).toContain("ship the cache");
  expect(p.textContent).toContain("Spawned r/add-cache.");
  // Only the newest page of turns was asked for — not the whole conversation.
  expect(apiFake.turnPageCalls).toEqual([{ branch: ORCHESTRATOR_BRANCH, limit: 50 }]);
  // The chat styling: your message is a bubble on the right, the reply under the orchestrator's name,
  // a day divider where the day changes, times on hover (not in the flow), in the page's theme.
  const chat = p.querySelector<HTMLElement>('[data-slot="chat-panel"]')!;
  expect(chat.className).toContain("log-themed"); // follows light/dark like the rest of the console
  expect(p.querySelectorAll('[data-slot="chat-turn"]')).toHaveLength(2);
  const user = p.querySelector<HTMLElement>('[data-slot="chat-user"]')!;
  expect(user.className).toContain("justify-end");
  expect(user.firstElementChild!.firstElementChild!.className).toContain("bg-accent");
  expect(p.querySelector('[data-slot="chat-reply"]')!.textContent).toContain("Orchestrator");
  expect([...p.querySelectorAll('[data-slot="chat-day"]')].map((d) => d.textContent)).toEqual(["Yesterday", "Today"]);
  expect(p.querySelector('[data-slot="turn-time"]')!.className).toContain("group-hover:opacity-100");
  expect(p.textContent).not.toContain("❯"); // no terminal prompt glyphs here
  const log = p.querySelector<HTMLElement>(".overflow-y-auto")!;
  expect(log.className).toContain("font-sans");
  expect(log.className).not.toContain("font-mono");
  // The composer carries the orchestrator's model picker — Claude models only — and the context ring.
  const picker = p.querySelector<HTMLElement>('[aria-label="Model"]')!;
  expect(picker.textContent).toBe("Claude · Opus 5.5");
  const ring = p.querySelector<HTMLButtonElement>('button[data-slot="context-ring"]')!;
  expect(ring.getAttribute("aria-label")).toBe("Context: not measured yet"); // the status poll waits for the slide…
  await afterSlide();
  expect(ring.getAttribute("aria-label")).toBe("Context 42% full"); // …then reads it
  await act(async () => { ring.click(); await flush(); }); // the card opens on a click only
  await act(async () => { document.body.querySelector<HTMLButtonElement>('button[data-slot="context-compact"]')!.click(); await flush(); await flush(); });
  expect(apiFake.calls).toContain(`compact:${ORCHESTRATOR_REPO}:${ORCHESTRATOR_BRANCH}`);
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(); });

  const textarea = p.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "what is running?");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await flush(); await flush(); });
  expect(apiFake.orchestratorMessages).toEqual([{ text: "what is running?", attachments: [] }]);
  expect(apiFake.agentLaunches).toEqual([]); // not a branch follow-up

  // Its ✕ closes it: slid out, hidden from assistive tech, still mounted so reopening is instant —
  // and focus goes back to the button that opened it.
  await click(closeButton());
  expect(panel()).toBeNull();
  expect(panelEl()!.dataset.state).toBe("closed");
  expect(panelEl()!.getAttribute("aria-hidden")).toBe("true");
  // Closing, the dock's width slides it out and clips it; once the slide is over (no transition runs
  // here, so the fallback ends it) it is idle: focus may not enter it. Its class never changes.
  expect(panelEl()!.hasAttribute("data-idle")).toBe(false);
  await act(async () => { await new Promise((r) => setTimeout(r, SLIDE_MS + 200)); });
  expect(panelEl()!.hasAttribute("data-idle")).toBe(true);
  expect(panelEl()!.className).not.toMatch(/invisible|visibility/);
  expect(document.activeElement).toBe(launcher());
  const pagesBefore = apiFake.turnPageCalls.length;
  await click(launcher());
  expect(panel()!.textContent).toContain("Spawned r/add-cache.");
  expect(apiFake.turnPageCalls).toHaveLength(pagesBefore); // nothing refetched: it was there all along
  // Escape from inside the panel closes it too.
  await act(async () => { panel()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(); });
  expect(panel()).toBeNull();
});

test("a message with an attachment shows it on the outbox's \"sending…\" bubble, served from the bridge like a sent message", async () => {
  // The outbox (lib/orchestratorOutbox.ts) uploads before posting; the "sending…" bubble should pick
  // up the resolved orca-attachment:// ref as soon as the upload answers, not only once the message
  // lands as a turn or a queued entry.
  const img = "77777777-7777-7777-7777-777777777777";
  apiFake.uploadAttachmentsResult = [`orca-attachment://${img}/bug.png`];
  apiFake.orchestratorMessageDelays = [100]; // hold the POST open so the "sending…" state is observable
  await mount(<Entry />);
  await click(launcher());
  const p = panel()!;

  const textarea = p.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "look at this");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files: [new File(["x"], "bug.png", { type: "image/png" })] } });
  await act(async () => { textarea.parentElement!.dispatchEvent(drop); });

  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await flush(); await flush(); });
  const thumb = p.querySelector<HTMLImageElement>('[data-slot="chat-sending"] [data-slot="expandable-image"] img');
  expect(thumb?.getAttribute("src")).toBe(`/api/attachments/${img}`);
  expect(p.textContent).toContain("look at this");

  await act(async () => { await new Promise((r) => setTimeout(r, 150)); }); // let the delayed POST settle
  expect(apiFake.orchestratorMessages).toEqual([{ text: "look at this", attachments: [`orca-attachment://${img}/bug.png`] }]);
});

test("a paused orchestrator says so", async () => {
  apiFake.orchestratorState = { ...apiFake.orchestratorState, paused: true, contextPct: 85 };
  await mount(<Entry />);
  await click(launcher());
  await afterSlide();
  expect(panel()!.textContent).toContain("Orchestrator · paused until you reply");
  const ring = panel()!.querySelector<HTMLElement>('[data-slot="context-ring"]')!;
  expect(ring.className).toContain("text-amber-400");
});

test("the header's live line — panel and page alike: working time, queued, workers; cost and advice only on hover", async () => {
  apiFake.agentsData = [
    { branch: "w1", worktreePath: "/wt/w1", agentStatus: "running" },
    { branch: "w2", worktreePath: "/wt/w2", agentStatus: "running" },
    { branch: "mine", worktreePath: "/wt/mine", agentStatus: "running" }, // not orchestrated: not its worker
    { branch: "w3", worktreePath: "/wt/w3", agentStatus: "done" },
  ];
  for (const b of ["w1", "w2", "w3"]) apiFake.enrichmentData.set(`r::${b}`, { title: b, orchestrated: true });
  apiFake.orchestratorState = {
    ...apiFake.orchestratorState, running: true, startedAt: Date.now() - 72_000, queued: 2,
    lastWakeUsd: 3.2, hint: "Large session: each wake re-reads all of it, so a fresh session would be much cheaper.",
  };
  await mount(<><Entry /><OrchestratorPage /></>);
  await act(async () => { await store.refresh(); await flush(); await flush(); });
  getDefaultStore().set(orchestratorOpenAtom, true);
  await act(async () => { await flush(); await flush(); });
  await afterSlide();
  const lines = [...container!.querySelectorAll<HTMLElement>('[data-slot="orchestrator-status"]')];
  expect(lines).toHaveLength(2); // the panel's header and the page's
  for (const line of lines) {
    expect(line.textContent).toMatch(/^Working · 1m 1[23]s · 2 queued · 2 workers running$/);
    expect(line.textContent).not.toContain("$"); // the cost is the tooltip, not the text
    expect(openTip(line).textContent).toBe("Last wake cost $3.20\nLarge session: each wake re-reads all of it, so a fresh session would be much cheaper.");
    expect(line.querySelector('[data-slot="orchestrator-status-warn"]')).not.toBeNull(); // the amber dot, nothing more
  }
  expect(lines[0]!.outerHTML.replace(/1m 1[23]s/, "T")).toBe(lines[1]!.outerHTML.replace(/1m 1[23]s/, "T")); // both places match

  apiFake.orchestratorState = { ...apiFake.orchestratorState, running: false, startedAt: undefined, queued: 0, hint: undefined, lastWakeUsd: undefined };
  apiFake.agentsData = [];
  await act(async () => { await store.refresh(); await new Promise((r) => setTimeout(r, 2100)); await flush(); });
  for (const line of container!.querySelectorAll<HTMLElement>('[data-slot="orchestrator-status"]')) {
    expect(line.textContent).toBe("Idle");
    expect(line.closest('[data-slot="tip"]')).toBeNull(); // nothing to say — no Tip at all
    expect(line.querySelector('[data-slot="orchestrator-status-warn"]')).toBeNull();
  }
});

test("the panel is resized from its left edge and the width is remembered (clamped to the viewport)", async () => {
  // A 1440 desktop: the docked panel may grow until the page column beside it is DOCK_PAGE_MIN_W.
  const prevWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  try {
  localStorage.setItem("orca.ui.v1.orchestratorWidth", "520");
  await mount(<Entry />);
  await click(launcher());
  const p = panel()!;
  expect(p.style.width).toBe("520px");
  const handles = document.querySelectorAll<HTMLElement>('[data-slot="orchestrator-resize"]');
  expect(handles).toHaveLength(1); // one handle
  expect(handles[0]!.className).toContain("cursor-ew-resize");
  // branch-demo's gutter handle: in the dock, outside the panel and its clip, centred in the 6px gap.
  expect(p.contains(handles[0]!)).toBe(false);
  expect(handles[0]!.parentElement!.dataset.slot).toBe("dock");
  expect(handles[0]!.style.left).toBe("-3.5px"); // half the 6px gap, less half the 1px line
  expect(handles[0]!.className).toContain("before:-inset-2"); // the 17px hit area around the 1px line
  expect(handles[0]!.getAttribute("role")).toBe("separator");
  // Dragging the edge LEFT widens; the width lands in storage when the pointer lets go.
  await act(async () => {
    handles[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 500, clientY: 0 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 440, clientY: 0 }));
  });
  // Mid-drag: the handle shows its active look and the dock drops its width transition.
  expect(handles[0]!.hasAttribute("data-resizing")).toBe(true);
  expect(handles[0]!.parentElement!.hasAttribute("data-resizing")).toBe(true);
  expect(handles[0]!.parentElement!.className).toContain("data-[resizing]:transition-none");
  await act(async () => {
    window.dispatchEvent(new PointerEvent("pointerup", {}));
    await flush();
  });
  expect(handles[0]!.hasAttribute("data-resizing")).toBe(false);
  expect(handles[0]!.parentElement!.hasAttribute("data-resizing")).toBe(false);
  expect(p.style.width).toBe("580px");
  expect(JSON.parse(localStorage.getItem("orca.ui.v1.orchestratorWidth")!)).toBe(580);
  // Dragged far right: never narrower than the minimum.
  await act(async () => {
    handles[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 500, clientY: 0 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 2000, clientY: 0 }));
    window.dispatchEvent(new PointerEvent("pointerup", {}));
    await flush();
  });
  expect(p.style.width).toBe(`${PANEL_MIN_W}px`);
  expect(JSON.parse(localStorage.getItem("orca.ui.v1.orchestratorWidth")!)).toBe(PANEL_MIN_W);
  } finally { Object.defineProperty(window, "innerWidth", { value: prevWidth, configurable: true }); }
});

test("a remembered width from a bigger screen is pulled back in; garbage in storage reads as the default", async () => {
  const prevWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true }); // a 1440 desktop
  try {
    localStorage.setItem("orca.ui.v1.orchestratorWidth", "3000");
    await mount(<Entry />);
    await click(launcher());
    expect(panel()!.style.width).toBe(`${clampPanelWidth(3000, 1440)}px`);
    // Docked, it never takes the page column below DOCK_PAGE_MIN_W beside the nav's rail.
    expect(clampPanelWidth(3000, 1440)).toBe(1440 - NAV_RAIL_W - DOCK_PAGE_MIN_W);
    expect(clampPanelWidth(3000, 2400)).toBe(960);
    expect(clampPanelWidth(460, 1024)).toBe(PANEL_MIN_W); // 1024 − 56 − 640 is under the minimum
    expect(clampPanelWidth(100, 1440)).toBe(PANEL_MIN_W);
    expect(clampPanelWidth(Number.NaN, 1440)).toBe(460);
    expect(clampPanelWidth(500, 320)).toBe(320); // a tiny window: the panel is the window
    await click(closeButton());
    localStorage.setItem("orca.ui.v1.orchestratorWidth", JSON.stringify("wide"));
    await act(async () => { root?.unmount(); });
    await mount(<Entry />);
    await click(launcher());
    expect(panel()!.style.width).toBe("460px");
  } finally { Object.defineProperty(window, "innerWidth", { value: prevWidth, configurable: true }); }
});

test("dayLabel groups timestamps: Today, Yesterday, then the date", () => {
  const now = new Date(2026, 9, 13, 12).getTime();
  expect(dayLabel(now - 3600_000, now)).toBe("Today");
  expect(dayLabel(now - DAY, now)).toBe("Yesterday");
  expect(dayLabel(now - 3 * DAY, now)).toMatch(/10 Oct|Oct 10/);
});

test("without the Document Picture-in-Picture API (plain http, Firefox), Pop out opens the chat in a named popup window; a second click focuses it", async () => {
  const realOpen = window.open;
  const opened: { url?: string | URL; name?: string; features?: string }[] = [];
  let focused = 0;
  const fakeWin = { closed: false, focus() { focused++; } } as unknown as Window;
  window.open = ((url?: string | URL, name?: string, features?: string) => { opened.push({ url, name, features }); return fakeWin; }) as typeof window.open;
  try {
    await mount(<Entry />);
    await click(launcher());
    const popOut = panel()!.querySelector<HTMLButtonElement>('[aria-label="Pop out"]')!;
    expect(popOut).not.toBeNull();
    await click(popOut);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.url).toBe(ORCHESTRATOR_WINDOW_URL);
    expect(opened[0]!.name).toBe(ORCHESTRATOR_WINDOW_NAME);
    expect(opened[0]!.features).toMatch(/^popup,width=\d+,height=\d+$/);
    expect(panel()).toBeNull(); // the chat moved to the window; the tab's panel closed
    // Again: the open window comes forward, no second window and no reload.
    await click(launcher());
    await click(panel()!.querySelector('[aria-label="Pop out"]')!);
    expect(opened).toHaveLength(1);
    expect(focused).toBe(2);
    // Closed by the user: the next click opens a new one.
    (fakeWin as { closed: boolean }).closed = true;
    await click(launcher());
    await click(panel()!.querySelector('[aria-label="Pop out"]')!);
    expect(opened).toHaveLength(2);
  } finally {
    window.open = realOpen;
  }
});

test("the popup window's page is the orchestrator's header and chat alone", async () => {
  expect(isOrchestratorWindow("/orchestrator", "?window")).toBe(true);
  expect(isOrchestratorWindow("/orchestrator", "")).toBe(false);
  expect(isOrchestratorWindow("/agents", "?window")).toBe(false);
  await mount(<OrchestratorWindow />);
  const win = container!.querySelector('[data-slot="orchestrator-window"]')!;
  expect(win.textContent).toContain("Orchestrator");
  expect(win.querySelector("textarea")).not.toBeNull();
  expect(win.querySelector('[aria-label="Close orchestrator"]')).toBeNull();
});

test("Pop out shows at tablet width and up; it hides only below the app's own phone breakpoint (not lg)", async () => {
  // The same breakpoint the sidebar/bottom-bar switch on (lib/viewport's NARROW_QUERY, max-width:
  // 767px) — not Tailwind's `lg` (1024px), which would also hide it at a merely half-sized desktop
  // window (e.g. ~900px, still well above a phone).
  const pip = fakePip();
  const realMatchMedia = window.matchMedia;
  const emulateWidth = (narrow: boolean) => {
    window.matchMedia = ((q: string) => ({ matches: narrow && q === NARROW_QUERY, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  };
  try {
    emulateWidth(false); // a tablet-ish / half-desktop width, e.g. ~900px — not a phone
    await mount(<Entry />);
    await click(launcher());
    expect(panel()!.querySelector('[aria-label="Pop out"]')).not.toBeNull();

    // Resized down to a phone width while the panel is already open: Pop out disappears.
    emulateWidth(true);
    await act(async () => { window.dispatchEvent(new Event("resize")); await flush(); });
    expect(panel()!.querySelector('[aria-label="Pop out"]')).toBeNull();

    // Back above the phone breakpoint: it returns.
    emulateWidth(false);
    await act(async () => { window.dispatchEvent(new Event("resize")); await flush(); });
    expect(panel()!.querySelector('[aria-label="Pop out"]')).not.toBeNull();
  } finally {
    window.matchMedia = realMatchMedia;
    void pip;
  }
});

/** A stand-in for documentPictureInPicture: each window is a second document, closed via pagehide. */
function fakePip() {
  const requests: { width: number; height: number }[] = [];
  const windows: (EventTarget & { document: Document; innerWidth: number; innerHeight: number; close(): void })[] = [];
  (window as unknown as { documentPictureInPicture: unknown }).documentPictureInPicture = {
    requestWindow: async (size: { width: number; height: number }) => {
      requests.push(size);
      const w = Object.assign(new EventTarget(), {
        document: document.implementation.createHTMLDocument("pip"), innerWidth: size.width, innerHeight: size.height,
        setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
        close() { w.dispatchEvent(new Event("pagehide")); },
      });
      windows.push(w);
      return w;
    },
  };
  return { requests, win: (i: number) => windows[i]! };
}

test("Pop out (kept: one button) moves the live chat into a Picture-in-Picture window and back", async () => {
  apiFake.turnsData.set("@orca::orchestrator", [
    { id: "run-1", provider: "claude", instruction: "ship the cache", prompt: "p", response: "Spawned r/add-cache.", finishedAt: 2 },
  ]);
  const style = document.createElement("style");
  style.textContent = ":root { --background: white; }";
  document.head.append(style);
  const pip = fakePip();
  try {
    await mount(<Entry />);
    await click(launcher());
    // A draft typed in the tab survives the move: the same React tree, portalled, not a copy.
    const typed = panel()!.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(typed, "half a thought");
      typed.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    document.documentElement.classList.add("dark");
    await click(panel()!.querySelector('[aria-label="Pop out"]')!);
    expect(pip.requests).toEqual([{ width: PANEL_MIN_W, height: 640 }]); // first time: the panel's width (docked at 1024: the minimum)
    const doc = pip.win(0).document;
    const inPip = () => doc.querySelector<HTMLElement>('[data-slot="orchestrator-panel"]');
    expect(panelEl()).toBeNull(); // gone from the tab…
    expect(inPip()!.textContent).toContain("Spawned r/add-cache."); // …and live in the PiP window
    expect(inPip()!.querySelector("textarea")!.value).toBe("half a thought");
    expect(doc.head.textContent).toContain("--background: white"); // the page's styles came along
    expect(inPip()!.querySelector('[data-slot="orchestrator-resize"]')).toBeNull(); // the OS window sizes it
    expect(doc.documentElement.classList.contains("dark")).toBe(true);
    const textarea = inPip()!.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "from the pip");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await flush(); await flush(); });
    expect(apiFake.orchestratorMessages).toEqual([{ text: "from the pip", attachments: [] }]);
    // Escape there doesn't drop the always-on-top window.
    await act(async () => { inPip()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(); });
    expect(inPip()).not.toBeNull();
    // Return to tab: back in the page, and the PiP size is remembered for next time.
    pip.win(0).innerWidth = 380; pip.win(0).innerHeight = 520;
    await click(inPip()!.querySelector('[aria-label="Return to tab"]')!);
    expect(inPip()).toBeNull();
    expect(panel()!.textContent).toContain("Spawned r/add-cache.");
    expect(JSON.parse(localStorage.getItem("orca.orchestrator.pip")!)).toEqual({ width: 380, height: 520 });
    await click(panel()!.querySelector('[aria-label="Pop out"]')!);
    expect(pip.requests[1]).toEqual({ width: 380, height: 520 });
    await act(async () => { pip.win(1).close(); await flush(); });
    expect(panel()!.textContent).toContain("Spawned r/add-cache.");
    // And closing the chat (its ✕, in the PiP window) closes the popped-out window with it.
    await click(panel()!.querySelector('[aria-label="Pop out"]')!);
    let closed = false;
    pip.win(2).addEventListener("pagehide", () => { closed = true; });
    await click(closeButton(pip.win(2).document));
    expect(closed).toBe(true);
    expect(panel()).toBeNull();
  } finally { style.remove(); }
});

/** The real styles.css, with the Tailwind-only at-rules it opens with stripped out (`@import`,
 *  `@plugin`, `@custom-variant`, and `@theme inline` reduced to a plain `:root` block) so a plain CSS
 *  engine — happy-dom's, here — can parse it directly. This is the actual shipped stylesheet, not a
 *  hand-copied stand-in, so a later edit to the real rule is what this test exercises. */
async function loadRealStylesheet(): Promise<HTMLStyleElement> {
  let css = await Bun.file(new URL("../web/src/styles.css", import.meta.url)).text();
  css = css
    .replace(/^@import .*;$/gm, "")
    .replace(/^@plugin .*;$/gm, "")
    .replace(/^@custom-variant .*;$/gm, "")
    .replace("@theme inline {", ":root {");
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  return style;
}

test("the PiP document's own narrow width never forces the phone's 16px zoom-guard font onto its composer", async () => {
  // Real-browser mechanics being verified: `@media (max-width: 767px)` is evaluated against the
  // DOCUMENT it renders in. The orchestrator's popped-out Picture-in-Picture window (Terminal.tsx's
  // `copyStyles` copies this very stylesheet into it) is its own document, often narrower than 768px
  // even though documentPictureInPicture is a Chrome/Edge desktop-only feature with no iOS keyboard
  // to guard against. `[data-pip]` (set on the PiP root) must win its fields back to desktop sizing —
  // a REAL phone, with no such ancestor, keeps the 16px guard.
  const style = await loadRealStylesheet();
  const prevWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 420, configurable: true });
  window.dispatchEvent(new Event("resize"));
  try {
    const pipWrap = document.createElement("div");
    pipWrap.setAttribute("data-pip", "");
    const pipField = document.createElement("textarea");
    pipWrap.append(pipField);
    const phoneField = document.createElement("textarea");
    document.body.append(pipWrap, phoneField);
    expect(getComputedStyle(phoneField).fontSize).toBe("16px"); // a real phone: still guarded
    expect(getComputedStyle(pipField).fontSize).toBe("13px"); // --text-sm (0.8125rem): desktop sizing
    pipWrap.remove(); phoneField.remove();
  } finally {
    style.remove();
    Object.defineProperty(window, "innerWidth", { value: prevWidth, configurable: true });
    window.dispatchEvent(new Event("resize"));
  }
});

test("the PiP window never reads its own narrow width as a phone for the composer's max-md: sizing", async () => {
  // Same root cause as the font-size test above, but for the Tailwind utilities a CSS override
  // can't cheaply restate (the Send button's mobile "chip" look pulls in several classes, and the
  // composer dock's padding) — Chat.tsx and ChatComposer.tsx read PipContext (lib/utils.ts) instead
  // of trusting `max-md:`, which would otherwise fire against the PiP document's own width rather
  // than the main window's — the thing the docked side panel (reading the main window) never does.
  const pip = fakePip();
  try {
    await mount(<Entry />);
    await click(launcher());
    const dockInTab = panel()!.querySelector<HTMLElement>('[data-slot="chat-composer-dock"]')!;
    const sendInTab = panel()!.querySelector<HTMLElement>('button[aria-label="Send"]')!;
    expect(dockInTab.className).toContain("max-md:p-3");
    expect(sendInTab.className).toContain("max-md:bg-transparent");
    expect(sendInTab.querySelector("span")!.className).toContain("max-md:bg-primary");

    await click(panel()!.querySelector('[aria-label="Pop out"]')!);
    const doc = pip.win(0).document;
    const dockInPip = doc.querySelector<HTMLElement>('[data-slot="chat-composer-dock"]')!;
    const sendInPip = doc.querySelector<HTMLElement>('button[aria-label="Send"]')!;
    expect(dockInPip.className).not.toContain("max-md:");
    expect(dockInPip.className).toContain("p-2"); // still the panel's own padding, just not swapped for the phone's
    expect(sendInPip.className).not.toContain("max-md:");
    expect(sendInPip.querySelector("span")!.className).not.toContain("max-md:");
  } finally { void pip; }
});
