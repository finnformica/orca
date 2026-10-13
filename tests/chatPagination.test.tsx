// The chat is paged (views/Chat.tsx + workstream.ts's pure pieces): it opens on the newest page of
// turns, fetches the page before as you reach the top — keeping the turn you were reading where it
// was — and only follows the tail while you are at it, offering a jump back down otherwise. Before
// this the orchestrator's whole conversation (hundreds of turns, megabytes) loaded on every open.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";
import { TURN_PAGE_SIZE, anchoredScrollTop, asTurnPage, atBottom, mergeLatestPage, prependOlderPage } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

type FakeSource = EventTarget & { url: string };
const opened = () => (globalThis as unknown as { EventSource: { opened: FakeSource[] } }).EventSource.opened;
const emit = (s: FakeSource, name: string, data: unknown) => s.dispatchEvent(Object.assign(new Event(name), { data: JSON.stringify(data) }));

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
const row: Row = { repo: "r", hasRemote: false, branch: "long", title: "Long", prompt: "", lane: "LOCAL", worktreePath: "/wt/long", agentProvider: "claude" };
const turn = (i: number) => ({ id: `run-${i}`, provider: "claude", instruction: `ask ${i}`, prompt: "", response: `reply ${i}`, startedAt: 1000 + i, finishedAt: 1001 + i });

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<ChatPanel row={row} />); await flush(); await flush(); });
}
beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(async () => { await act(async () => { root?.unmount(); }); container?.remove(); apiFake.reset(); });

const log = () => container!.querySelector<HTMLElement>(".overflow-y-auto")!;
const shown = () => [...container!.querySelectorAll<HTMLElement>('[data-slot="chat-turn"]')].map((t) => t.textContent!.match(/ask (\d+)/)![1]).map(Number);
/** happy-dom lays nothing out: give the scroller a height that grows with its turns (20px each) and a
 *  settable scrollTop, so anchoring can be checked arithmetically. */
function layout(el: HTMLElement, clientHeight = 400) {
  let top = 0;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => el.querySelectorAll('[data-slot="chat-turn"]').length * 20 });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = v; } });
  el.scrollTo = ((opts: { top: number }) => { top = opts.top; }) as typeof el.scrollTo;
}
const scrollTo = async (el: HTMLElement, top: number) => act(async () => { el.scrollTop = top; el.dispatchEvent(new Event("scroll")); await flush(); await flush(); });

test("P1: opens on the newest page only, and an older page is fetched at the top with the scroll anchored", async () => {
  apiFake.turnsData.set("r::long", Array.from({ length: 120 }, (_, i) => turn(i)));
  await mount();
  expect(apiFake.turnPageCalls).toEqual([{ branch: "long", limit: TURN_PAGE_SIZE }]); // one page, not the conversation
  expect(shown()).toEqual(Array.from({ length: 50 }, (_, i) => 70 + i));
  expect(container!.querySelector('[data-slot="chat-skeleton"]')).toBeNull(); // loaded: no placeholder left
  const older = container!.querySelector<HTMLButtonElement>('[data-slot="chat-older"] button')!;
  expect(older.textContent).toContain("earlier turns"); // a click works where the page is too short to scroll
  const el = log();
  layout(el);
  // Reading something 300px down, then nearing the top: the previous 50 arrive ABOVE, and the
  // scroller moves by exactly their height (50 × 20px), so what was under the eye stays there.
  await scrollTo(el, 300);
  await scrollTo(el, 100);
  expect(apiFake.turnPageCalls[1]).toEqual({ branch: "long", limit: TURN_PAGE_SIZE, before: "70" });
  expect(shown()).toEqual(Array.from({ length: 100 }, (_, i) => 20 + i));
  expect(el.scrollTop).toBe(100 + 50 * 20);
  // Once more reaches the first turn; the affordance goes away.
  await scrollTo(el, 50);
  expect(shown()[0]).toBe(0);
  expect(shown()).toHaveLength(120);
  expect(container!.querySelector('[data-slot="chat-older"]')).toBeNull();
  expect(apiFake.turnPageCalls).toHaveLength(3);
  // At the top with nothing older, scrolling fetches nothing more.
  await scrollTo(el, 0);
  expect(apiFake.turnPageCalls).toHaveLength(3);
});

test("P2: a refresh re-fetches only the newest page and keeps the older pages you scrolled through", async () => {
  apiFake.turnsData.set("r::long", Array.from({ length: 80 }, (_, i) => turn(i)));
  await mount();
  const el = log();
  layout(el);
  await scrollTo(el, 10); // → the older 30 as well
  expect(shown()).toHaveLength(80);
  // A new turn starts (a `turn` event on the live stream): the newest page is re-read…
  apiFake.turnsData.get("r::long")!.push({ ...turn(80), finishedAt: undefined });
  await act(async () => { emit(opened().at(-1)!, "turn", { repo: "r", branch: "long", runId: "run-80" }); await flush(); await flush(); });
  expect(apiFake.turnPageCalls.at(-1)).toEqual({ branch: "long", limit: TURN_PAGE_SIZE });
  // …and the result is the whole loaded conversation plus the new turn, nothing dropped or doubled.
  expect(shown()).toEqual(Array.from({ length: 81 }, (_, i) => i));
  expect(el.textContent).toContain("▋ working…");
});

test("P3: the log follows the tail only while you are at it; scrolled up, new output lights a jump button", async () => {
  apiFake.turnsData.set("r::long", Array.from({ length: 10 }, (_, i) => turn(i)));
  await mount();
  const el = log();
  layout(el, 100);
  expect(container!.querySelector('[data-slot="chat-jump"]')).toBeNull(); // at the bottom: nothing to jump to
  // Scroll up to read; a turn lands below.
  await scrollTo(el, 0);
  const jump = () => container!.querySelector<HTMLButtonElement>('[data-slot="chat-jump"]');
  expect(jump()!.textContent).toBe("Jump to latest"); // offered quietly as soon as you leave the tail…
  expect(jump()!.dataset.unseen).toBeUndefined();
  apiFake.turnsData.get("r::long")!.push(turn(10));
  await act(async () => { emit(opened().at(-1)!, "turn", { repo: "r", branch: "long", runId: "run-10" }); await flush(); await flush(); });
  expect(el.scrollTop).toBe(0); // not yanked down mid-read
  expect(jump()!.textContent).toBe("New messages"); // …and lit once something arrived you haven't seen
  expect(jump()!.dataset.unseen).toBe("true");
  await act(async () => { jump()!.click(); await flush(); });
  expect(el.scrollTop).toBe(el.scrollHeight); // back at the tail…
  expect(jump()).toBeNull(); // …following again
});

test("the pure pieces: merging pages and anchoring", () => {
  const t = (id: string) => ({ id });
  // A refreshed newest page replaces the turns it covers and keeps what it doesn't.
  expect(mergeLatestPage([t("a"), t("b"), t("c")], [t("c"), t("d")]).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  expect(mergeLatestPage([], [t("a")]).map((x) => x.id)).toEqual(["a"]);
  // An older page goes in front, minus anything already loaded.
  expect(prependOlderPage([t("x"), t("a")], [t("a"), t("b")]).map((x) => x.id)).toEqual(["x", "a", "b"]);
  // The content grew by 1000px above the viewport: the reader moves down by 1000px to stay put.
  expect(anchoredScrollTop(300, 2000, 3000)).toBe(1300);
  expect(atBottom(1560, 2000, 400, 48)).toBe(true);
  expect(atBottom(1500, 2000, 400, 48)).toBe(false);
});

test("P4: a bridge from before paging answers with the whole array — the chat shows it instead of going blank", async () => {
  // A preview's Vite proxy points at the main checkout's bridge; during a deploy one side is ahead of
  // the other. Before this, `page.turns` was undefined and the panel's render crashed on `.length`.
  apiFake.turnsData.set("r::long", Array.from({ length: 3 }, (_, i) => turn(i)));
  const api = (await import("../web/src/api")).api;
  const paged = api.turnPage;
  api.turnPage = (async (repo: string, branch: string) => apiFake.turnsData.get(`${repo}::${branch}`) ?? []) as never;
  try {
    await mount();
    expect(shown()).toEqual([0, 1, 2]);
    expect(container!.querySelector('[data-slot="chat-older"]')).toBeNull(); // the whole conversation: nothing older
  } finally { api.turnPage = paged; }
  // The pure normalisation: an array is a page with nothing older; junk is an empty page, never undefined.
  expect(asTurnPage([{ id: "a" }])).toEqual({ turns: [{ id: "a" }], older: null });
  expect(asTurnPage({ turns: [{ id: "a" }], older: "5~1" })).toEqual({ turns: [{ id: "a" }], older: "5~1" });
  expect(asTurnPage({ turns: [{ id: "a" }], older: 7 })).toEqual({ turns: [{ id: "a" }], older: null });
  expect(asTurnPage(null)).toEqual({ turns: [], older: null });
  expect(asTurnPage({ error: "nope" })).toEqual({ turns: [], older: null });
});

test("P5: with the bridge's database unreachable the chat shows its journaled turns under a sync banner", async () => {
  apiFake.turnsData.set("r::long", [turn(0)]);
  apiFake.turnPageDbUnavailable = true;
  await mount();
  expect(shown()).toEqual([0]); // the journaled (live) run is still shown
  expect(container!.querySelector('[data-slot="chat-db-down"]')?.textContent).toContain("database unreachable — this conversation will sync when it is back");
});

test("P6: a page from the database carries no banner", async () => {
  apiFake.turnsData.set("r::long", [turn(0)]);
  await mount();
  expect(container!.querySelector('[data-slot="chat-db-down"]')).toBeNull();
});
