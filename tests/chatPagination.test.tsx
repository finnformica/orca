// The chat is paged (views/Chat.tsx + workstream.ts's pure pieces): it opens on the newest page of
// turns, fetches the page before as you reach the top — keeping the turn you were reading where it
// was — and only follows the tail while you are at it, offering a jump back down otherwise. Before
// this the orchestrator's whole conversation (hundreds of turns, megabytes) loaded on every open.
// Paging bounds what is fetched; the mounted WINDOW (CHAT_WINDOW turns) bounds the DOM as you scroll,
// and the orchestrator's older turns render compact. Its chat is one stream with the worker traffic
// split out of your conversation: collapsed, tinted blocks.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";
import { CHAT_WINDOW, TAIL_WINDOW, TURN_PAGE_SIZE, agentsMarker, anchoredScrollTop, asTurnPage, atBottom, MESSAGE_BREAK, capWindow, chatItems, longMessage, longReply, splitMessages, mergeLatestPage, prependOlderPage, revealAbove, revealBelow, sourceOf, turnSource, windowRange, WORKER_EVENT_MARKER, type ChatItem } from "@/workstream";

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

async function mount(node: React.ReactNode = <ChatPanel row={row} />) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); await flush(); });
}
beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(async () => { await act(async () => { root?.unmount(); }); container?.remove(); apiFake.reset(); });

const log = () => container!.querySelector<HTMLElement>(".overflow-y-auto")!;
// Read off the instruction's own bubble: the turn's whole text runs it straight into the timestamp
// ("ask 012:00 AM"), since a closed tooltip mounts nothing in between.
const shown = () => [...container!.querySelectorAll<HTMLElement>('[data-slot="chat-turn"]')].map((t) => t.querySelector('[data-slot="chat-user-text"]')!.textContent!.match(/^ask (\d+)$/)![1]).map(Number);
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
  // Once more reaches the first turn; the affordance goes away. Only CHAT_WINDOW stay MOUNTED: the
  // newest 20 are unmounted below (still loaded), offered as "newer turns".
  await scrollTo(el, 50);
  expect(shown()[0]).toBe(0);
  expect(shown()).toEqual(Array.from({ length: CHAT_WINDOW }, (_, i) => i));
  expect(container!.querySelector('[data-slot="chat-older"]')).toBeNull();
  expect(container!.querySelector('[data-slot="chat-newer"]')!.textContent).toContain("20 newer turns");
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

test("P5: the mounted window is bounded — far-off turns unmount as you scroll, and the turn under your eye stays put", async () => {
  apiFake.turnsData.set("r::long", Array.from({ length: 120 }, (_, i) => turn(i)));
  await mount();
  const el = log();
  layout(el);
  await scrollTo(el, 300);
  await scrollTo(el, 100); // 20…119
  await scrollTo(el, 50); // 0…99 mounted, 100…119 loaded but unmounted
  expect(shown()).toHaveLength(CHAT_WINDOW);
  expect(apiFake.turnPageCalls).toHaveLength(3);
  // Scrolling down toward the end of the window remounts the newer turns from memory (no fetch) and
  // unmounts the oldest — the window slides, still CHAT_WINDOW turns. At 1500px (20px a turn) the
  // reader looks at turn 75; with 20 turns gone from above, the scroller moves up by 400px to keep it.
  await scrollTo(el, 1500);
  expect(shown()).toEqual(Array.from({ length: CHAT_WINDOW }, (_, i) => 20 + i));
  expect(el.scrollTop).toBe(1100);
  expect(20 + el.scrollTop / 20).toBe(75); // the same turn under the eye
  expect(apiFake.turnPageCalls).toHaveLength(3);
  expect(container!.querySelector('[data-slot="chat-newer"]')).toBeNull(); // the tail is mounted again
  // And back up: the 20 above come back from memory, the newest 20 unmount, the anchor holds (turn 25).
  await scrollTo(el, 100);
  expect(shown()).toEqual(Array.from({ length: CHAT_WINDOW }, (_, i) => i));
  expect(el.scrollTop / 20).toBe(25);
  expect(apiFake.turnPageCalls).toHaveLength(3);
  // Jump to latest remounts the tail window and goes there.
  const jump = container!.querySelector<HTMLButtonElement>('[data-slot="chat-jump"]')!;
  await act(async () => { jump.click(); await flush(); await flush(); });
  expect(shown()).toEqual(Array.from({ length: CHAT_WINDOW }, (_, i) => 20 + i));
  expect(el.scrollTop).toBe(el.scrollHeight);
});

test("P7: the chat's scroller keeps the gesture — reaching its end never scrolls the page behind it", async () => {
  apiFake.turnsData.set("r::long", [turn(0)]);
  await mount();
  expect(log().className).toContain("overscroll-contain");
  await act(async () => { root!.render(<ChatPanel row={row} />); await flush(); });
  expect(log().className).toContain("overscroll-contain");
});

test("P6: the orchestrator's chat is one stream — worker traffic split out as collapsed, tinted blocks; older replies render compact", async () => {
  const long = (i: number) => Array.from({ length: 8 }, (_, l) => `reply ${i} line ${l}`).join("\n");
  // Some carry the recorded source, some (rows from before it) are read off their instruction.
  const wake = (i: number, source?: "agents") => ({ id: `run-${i}`, provider: "claude", instruction: `${WORKER_EVENT_MARKER} r/feat-${i} — done\nOutcome: done`, prompt: "", response: `noted ${i}`, startedAt: 1000 + i, finishedAt: 1001 + i, source });
  const mixed = { ...turn(6), instruction: `${WORKER_EVENT_MARKER} r/feat-x — done\nOutcome: ok\n\nask 6`, response: long(6), source: "human" as const };
  apiFake.turnsData.set("r::long", [
    { ...turn(0), response: long(0), source: "human" }, wake(1, "agents"), wake(2), wake(3, "agents"), { ...turn(4), instruction: `ask 4a${MESSAGE_BREAK}ask 4b\n\nwith a paragraph${MESSAGE_BREAK}ask 4c`, response: long(4) },
    wake(5), mixed, { ...turn(7), instruction: Array.from({ length: 12 }, (_, l) => `ask 7 line ${l}`).join("\n"), response: long(7) }, wake(8, "agents"),
  ]);
  apiFake.queuedData.set("long", [
    { id: 1, instruction: `${WORKER_EVENT_MARKER} r/held — done\nOutcome: ok`, attachments: [] },
    { id: 2, instruction: "and then this", attachments: [] },
  ]);
  await mount(<ChatPanel row={row} />);
  const c = container!;
  // No channel toggle: your turns, and each run of agent turns between them as ONE collapsed block,
  // its turns unmounted until opened — wakes 1–3, 5 and 8, the newest included.
  const markers = () => [...c.querySelectorAll<HTMLElement>('[data-slot="agents-marker"]')];
  expect(markers().map((m) => m.querySelector('[data-slot="worker-block-label"]')!.textContent!.replace(/ · \d\d:\d\d.*$/, ""))).toEqual(["3 worker reports · 3 replies", "1 worker report · 1 reply", "1 worker report · 1 reply"]);
  for (const m of markers()) {
    expect(m.className).toContain("bg-geist-blue/5"); // a style of its own, apart from your bubbles
    expect(m.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
  }
  for (const n of [1, 2, 3, 5, 8]) expect(c.textContent).not.toContain(`noted ${n}`);
  await act(async () => { markers()[0]!.querySelector("button")!.click(); await flush(); });
  expect(c.textContent).toContain("noted 2"); // expanded inline
  // A wake that carried your message AND a report: your words in the bubble, the report split out
  // above it as its own collapsed block.
  const sixth = [...c.querySelectorAll<HTMLElement>('[data-slot="chat-turn"]')].find((t) => t.textContent!.includes("reply 6 line 0"))!;
  expect(sixth.querySelector('[data-slot="chat-user"]')!.textContent).toStartWith("ask 6");
  const reports = sixth.querySelector<HTMLElement>('[data-slot="turn-reports"]')!;
  expect(reports.querySelector('[data-slot="worker-block-label"]')!.textContent).toBe("Worker report · r/feat-x — done");
  expect(reports.querySelector('[data-slot="worker-reports"]')).toBeNull(); // collapsed by default
  expect(sixth.querySelector('[data-slot="chat-user"]')!.textContent).not.toContain("r/feat-x");
  await act(async () => { reports.querySelector("button")!.click(); await flush(); });
  expect(reports.querySelector('[data-slot="worker-reports"]')!.textContent).toContain("r/feat-x — done");
  // Three messages one wake drained: three bubbles, in order — a paragraph inside one stays in it.
  const fourth = [...c.querySelectorAll<HTMLElement>('[data-slot="chat-turn"]')].find((t) => t.textContent!.includes("reply 4 line 0"))!;
  expect([...fourth.querySelectorAll('[data-slot="chat-user-text"]')].map((b) => b.textContent)).toEqual(["ask 4a", "ask 4b\n\nwith a paragraph", "ask 4c"]);
  // Queued: your message and the held report, both in the one stream.
  expect(c.textContent).toContain("and then this");
  expect(c.querySelector('[data-slot="worker-report-held"]')).not.toBeNull();
  // Old long replies are clamped with a Show more; the newest RECENT_FULL (6, 7, 8) are in full.
  const clampOf = (n: number) => [...c.querySelectorAll<HTMLElement>('[data-slot="chat-turn"]')].find((t) => t.textContent!.includes(`reply ${n} line 0`))!.querySelector<HTMLElement>('[data-slot="chat-reply"] [data-slot="turn-clamp"]');
  expect(clampOf(0)).not.toBeNull();
  expect(clampOf(4)).not.toBeNull();
  expect(clampOf(6)).toBeNull();
  expect(clampOf(7)).toBeNull();
  const more = clampOf(0)!.querySelector("button")!;
  expect(more.textContent).toBe("Show more");
  expect(clampOf(0)!.firstElementChild!.className).toContain("max-h-[4.5rem]");
  await act(async () => { more.click(); await flush(); });
  expect(clampOf(0)!.dataset.open).toBe("true");
  expect(clampOf(0)!.querySelector("button")!.textContent).toBe("Show less");
  // A long message of yours is cut too, at any age (the newest here), with its own Show more; a short one is not.
  const bubble = (n: number) => [...c.querySelectorAll<HTMLElement>('[data-slot="chat-turn"]')].find((t) => t.textContent!.includes(`reply ${n} line 0`))!.querySelector<HTMLElement>('[data-slot="chat-user"]')!;
  expect(bubble(6).querySelector('[data-slot="turn-clamp"]')).toBeNull();
  const cut = bubble(7).querySelector<HTMLElement>('[data-slot="turn-clamp"]')!;
  expect(cut.firstElementChild!.className).toContain("max-h-[9rem]");
  await act(async () => { cut.querySelector("button")!.click(); await flush(); });
  expect(bubble(7).querySelector<HTMLElement>('[data-slot="turn-clamp"]')!.dataset.open).toBe("true");
});

test("the pure pieces: the window, compact replies and the worker blocks", () => {
  const ts = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` }));
  expect(windowRange(ts, TAIL_WINDOW)).toEqual({ start: 0, end: 10 });
  expect(windowRange(ts, { first: "t3", last: "t6", dir: "up" })).toEqual({ start: 3, end: 7 });
  expect(windowRange(ts, { first: "gone", last: null, dir: "down" })).toEqual({ start: 0, end: 10 }); // an id no longer loaded reads as open
  expect(capWindow(ts, TAIL_WINDOW, 10)).toBeNull();
  expect(capWindow(ts, TAIL_WINDOW, 4)).toEqual({ first: "t6", last: null, dir: "down" }); // following: drop the oldest
  expect(capWindow(ts, { first: null, last: null, dir: "up" }, 4)).toEqual({ first: null, last: "t3", dir: "up" }); // reading back: drop the newest
  expect(revealAbove(ts, { first: "t6", last: null, dir: "down" }, 4)).toEqual({ first: "t2", last: null, dir: "up" });
  expect(revealAbove(ts, { first: "t2", last: null, dir: "down" }, 4)).toEqual({ first: null, last: null, dir: "up" });
  expect(revealBelow(ts, { first: null, last: "t3", dir: "up" }, 4)).toEqual({ first: null, last: "t7", dir: "down" });
  expect(revealBelow(ts, { first: null, last: "t7", dir: "up" }, 4)).toEqual({ first: null, last: null, dir: "down" });
  expect(longReply({ response: "one\ntwo" })).toBe(false);
  expect(longReply({ response: "a\nb\nc\nd\ne" })).toBe(true);
  expect(longReply({ response: "x".repeat(400) })).toBe(true);
  expect(longReply({ response: "short", structured: {} })).toBe(true);
  expect(longMessage("a\nb\nc")).toBe(false);
  // A wake's messages: split at the break; an old row (blank-line joined) splits only to find reports.
  expect(splitMessages(`a${MESSAGE_BREAK}b\n\nc`)).toEqual(["a", "b\n\nc"]);
  expect(splitMessages("one\n\nparagraph")).toEqual(["one\n\nparagraph"]);
  expect(splitMessages(`${WORKER_EVENT_MARKER} x\n\nsaid`)).toEqual([`${WORKER_EVENT_MARKER} x`, "said"]);
  expect(longMessage(Array.from({ length: 9 }, () => "l").join("\n"))).toBe(true);
  expect(longMessage("x".repeat(601))).toBe(true);
  const w = (id: string, startedAt = 1) => ({ id, instruction: `${WORKER_EVENT_MARKER} x`, finishedAt: 1, startedAt });
  const u = (id: string) => ({ id, instruction: "hi", finishedAt: 1 });
  const kinds = <T extends { id: string }>(items: ChatItem<T>[]) => items.map((i) => (i.kind === "turn" ? i.turn.id : `[${i.turns.map((t) => t.id).join(",")}]`));
  // Your turns, each run of agent turns between them as one block — even a single one, even the newest.
  expect(kinds(chatItems([u("a"), w("b"), w("c"), u("d"), w("e"), w("f")]))).toEqual(["a", "[b,c]", "d", "[e,f]"]);
  expect(kinds(chatItems([w("a"), u("b")]))).toEqual(["[a]", "b"]);
  // The recorded source wins over the text.
  expect(kinds(chatItems([u("a"), w("b"), { ...w("c"), source: "human" as const }, { ...u("d"), source: "agents" as const }]))).toEqual(["a", "[b]", "c", "[d]"]);
  expect(turnSource([`${WORKER_EVENT_MARKER} a`, `${WORKER_EVENT_MARKER} b`])).toBe("agents");
  expect(turnSource([`${WORKER_EVENT_MARKER} a`, "carry on"])).toBe("human");
  expect(turnSource(["[new draft] repo: r\n\nbuild it"])).toBe("human");
  expect(sourceOf({ instruction: `${WORKER_EVENT_MARKER} a\n\n${WORKER_EVENT_MARKER} b` })).toBe("agents");
  expect(agentsMarker([{ instruction: `${WORKER_EVENT_MARKER} a\n\n${WORKER_EVENT_MARKER} b`, finishedAt: 1 }, { instruction: `${WORKER_EVENT_MARKER} c` }])).toBe("3 worker reports · 1 reply · working");
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
