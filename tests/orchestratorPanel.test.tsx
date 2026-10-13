// The orchestrator's entry points in the UI: "Ask the orchestrator" in the top bar (a button), the O
// key and the palette open a RIGHT-HAND SIDE PANEL that slides over the page — the same ChatPanel a
// card's terminal uses, in its chat styling, over the orchestrator's own turns, with the composer
// sending to its route (never the branch follow-up launch). Resizable from its left edge (width
// remembered), Esc / ✕ to close, focus returned to the opener. Rendered into a real DOM against the fake api.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { getDefaultStore } from "jotai";
import { AskOrchestrator, OrchestratorPanel } from "@/components/Terminal";
import { orchestratorActivityAtom, orchestratorOpenAtom, orchestratorPrefillAtom } from "@/lib/atoms";
import { WorkstreamCard } from "@/views/Board";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, PANEL_MIN_W, clampPanelWidth, dayLabel } from "@/workstream";

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
const Entry = () => <><AskOrchestrator /><OrchestratorPanel /></>;

const panelEl = () => container!.querySelector<HTMLElement>('[data-slot="orchestrator-panel"]');
/** The open panel, or null: it stays mounted (slid out) once it has been opened. */
const panel = () => { const p = panelEl(); return p && p.dataset.state === "open" ? p : null; };
const launcher = () => container!.querySelector<HTMLButtonElement>('button[data-slot="ask-orchestrator"]')!;
const closeButton = (root: ParentNode = container!) => root.querySelector<HTMLButtonElement>('button[aria-label="Close orchestrator"]')!;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
const DAY = 86_400_000;

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
  expect(p.className).toContain("fixed inset-y-0 right-0"); // a right-hand rail…
  expect(p.className).toContain("translate-x-0"); // …slid in (a transform, so the page never reflows)
  // Opening, visibility flips at once (only the transform animates): a hidden element can't take focus.
  expect(p.className).toContain("visible translate-x-0 transition-transform");
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
  const chat = p.querySelector<HTMLElement>('[data-variant="chat"]')!;
  expect(chat.className).toContain("log-themed"); // follows light/dark like the rest of the console
  expect(p.querySelectorAll('[data-slot="chat-turn"][data-style="chat"]')).toHaveLength(2);
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
  expect(ring.getAttribute("aria-label")).toBe("Context 42% full");
  await act(async () => { ring.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); await flush(); });
  await act(async () => { document.body.querySelector<HTMLButtonElement>('button[data-slot="context-compact"]')!.click(); await flush(); await flush(); });
  expect(apiFake.calls).toContain(`compact:${ORCHESTRATOR_REPO}:${ORCHESTRATOR_BRANCH}`);
  await act(async () => { ring.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })); await new Promise((r) => setTimeout(r, 200)); });

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
  expect(panelEl()!.className).toContain("translate-x-full");
  expect(panelEl()!.className).toContain("transition-[transform,visibility]"); // closing, hidden only after the slide
  expect(document.activeElement).toBe(launcher());
  const pagesBefore = apiFake.turnPageCalls.length;
  await click(launcher());
  expect(panel()!.textContent).toContain("Spawned r/add-cache.");
  expect(apiFake.turnPageCalls).toHaveLength(pagesBefore); // nothing refetched: it was there all along
  // Escape from inside the panel closes it too.
  await act(async () => { panel()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(); });
  expect(panel()).toBeNull();
});

test("a paused orchestrator says so, and an orchestrated card is marked", async () => {
  apiFake.orchestratorState = { ...apiFake.orchestratorState, paused: true, contextPct: 85 };
  await mount(<><Entry /><WorkstreamCard row={{ repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat", orchestrated: true }} /></>);
  expect(container!.querySelector('[aria-label="Orchestrated"]')).toBeTruthy();
  await click(launcher());
  expect(panel()!.textContent).toContain("Orchestrator · paused until you reply");
  const ring = panel()!.querySelector<HTMLElement>('[data-slot="context-ring"]')!;
  expect(ring.className).toContain("text-amber-400");
});

test("the panel is resized from its left edge and the width is remembered (clamped to the viewport)", async () => {
  localStorage.setItem("orca.ui.v1.orchestratorWidth", "520");
  await mount(<Entry />);
  await click(launcher());
  const p = panel()!;
  expect(p.style.width).toBe("520px");
  const handles = p.querySelectorAll<HTMLElement>('[data-slot="orchestrator-resize"]');
  expect(handles).toHaveLength(1); // one edge: the inner one
  expect(handles[0]!.className).toContain("cursor-ew-resize");
  expect(handles[0]!.getAttribute("role")).toBe("separator");
  // Dragging the edge LEFT widens; the width lands in storage when the pointer lets go.
  await act(async () => {
    handles[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 500, clientY: 0 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 440, clientY: 0 }));
    window.dispatchEvent(new PointerEvent("pointerup", {}));
    await flush();
  });
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
});

test("a remembered width from a bigger screen is pulled back in; garbage in storage reads as the default", async () => {
  localStorage.setItem("orca.ui.v1.orchestratorWidth", "3000"); // happy-dom's viewport is 1024 wide
  await mount(<Entry />);
  await click(launcher());
  expect(panel()!.style.width).toBe(`${clampPanelWidth(3000, 1024)}px`);
  expect(clampPanelWidth(3000, 1024)).toBe(1024 - 240);
  expect(clampPanelWidth(100, 1024)).toBe(PANEL_MIN_W);
  expect(clampPanelWidth(Number.NaN, 1024)).toBe(460);
  expect(clampPanelWidth(500, 320)).toBe(320); // a tiny window: the panel is the window
  await click(closeButton());
  localStorage.setItem("orca.ui.v1.orchestratorWidth", JSON.stringify("wide"));
  await act(async () => { root?.unmount(); });
  await mount(<Entry />);
  await click(launcher());
  expect(panel()!.style.width).toBe("460px");
});

test("dayLabel groups timestamps: Today, Yesterday, then the date", () => {
  const now = new Date(2026, 9, 13, 12).getTime();
  expect(dayLabel(now - 3600_000, now)).toBe("Today");
  expect(dayLabel(now - DAY, now)).toBe("Yesterday");
  expect(dayLabel(now - 3 * DAY, now)).toMatch(/10 Oct|Oct 10/);
});

test("Pop out is hidden without the Document Picture-in-Picture API", async () => {
  await mount(<Entry />);
  await click(launcher());
  expect(panel()!.querySelector('[aria-label="Pop out"]')).toBeNull();
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
    expect(pip.requests).toEqual([{ width: 460, height: 640 }]); // first time: the panel's width
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
