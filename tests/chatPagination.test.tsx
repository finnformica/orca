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
import { catchAllLabels, fenceExternal, integrationMessage, integrationMetaLine, shownPlace } from "../shared/integrations";
import { reloadCatchAllLabels } from "@/lib/catchAllLabels";
import * as store from "@/store";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";
import { integrationState, integrationTurn, composerHistory, CHAT_WINDOW, TAIL_WINDOW, TURN_PAGE_SIZE, agentsMarker, anchoredScrollTop, asTurnPage, atBottom, MESSAGE_BREAK, capWindow, chatItems, longMessage, newestMessages, longReply, splitMessages, mergeLatestPage, prependOlderPage, revealAbove, revealBelow, sourceOf, anchorShift, eagerFrom, estimateItemHeight, turnSource, windowRange, WORKER_EVENT_MARKER, type ChatItem } from "@/workstream";

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
/** happy-dom lays nothing out: give the scroller a height that grows with its items (20px each — a
 *  turn, or the box that stands in for one not mounted yet) and a settable scrollTop, so anchoring can
 *  be checked arithmetically. */
function layout(el: HTMLElement, clientHeight = 400) {
  let top = 0;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => el.querySelectorAll('[data-slot="chat-item"]').length * 20 });
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

test("P6: the orchestrator's chat is one stream — a reply with something to say stays open like yours; only reports, and a reply with nothing to say, fold into tinted blocks; older replies render compact", async () => {
  const long = (i: number) => Array.from({ length: 8 }, (_, l) => `reply ${i} line ${l}`).join("\n");
  // Some carry the recorded source, some (rows from before it) are read off their instruction. A
  // wake that finished with nothing to say for itself (`reply` left out: no text, no structured
  // outcome) folds; one with a real reply does not, however many come after it.
  const wake = (i: number, opts: { source?: "agents"; reply?: string } = {}) => ({ id: `run-${i}`, provider: "claude", instruction: `${WORKER_EVENT_MARKER} r/feat-${i} — done\nOutcome: done`, prompt: "", response: opts.reply ?? "", startedAt: 1000 + i, finishedAt: 1001 + i, source: opts.source });
  const mixed = { ...turn(6), instruction: `${WORKER_EVENT_MARKER} r/feat-x — done\nOutcome: ok\n\nask 6`, response: long(6), source: "human" as const };
  apiFake.turnsData.set("r::long", [
    { ...turn(0), instruction: Array.from({ length: 12 }, (_, l) => `ask 0 line ${l}`).join("\n"), response: long(0), source: "human" }, wake(1, { source: "agents" }), wake(2), wake(3, { source: "agents", reply: "noted 3" }), { ...turn(4), instruction: `ask 4a${MESSAGE_BREAK}ask 4b\n\nwith a paragraph${MESSAGE_BREAK}ask 4c`, response: long(4) },
    wake(5), mixed, { ...turn(7), instruction: Array.from({ length: 12 }, (_, l) => `ask 7 line ${l}`).join("\n"), response: long(7) }, wake(8, { source: "agents", reply: "noted 8" }),
  ]);
  apiFake.queuedData.set("long", [
    { id: 1, instruction: `${WORKER_EVENT_MARKER} r/held — done\nOutcome: ok`, attachments: [] },
    { id: 2, instruction: "and then this", attachments: [] },
  ]);
  await mount(<ChatPanel row={row} />);
  const c = container!;
  // No channel toggle: your turns, and each run of wakes with nothing to say between them as ONE
  // collapsed block, its turns unmounted until opened — wakes 1, 2 and 5. Wakes 3 and 8 have real
  // replies, so each renders as its own turn, open, its report folded above the reply.
  const markers = () => [...c.querySelectorAll<HTMLElement>('[data-slot="agents-marker"]')];
  expect(markers().map((m) => m.querySelector('[data-slot="worker-block-label"]')!.textContent!.replace(/ · \d\d:\d\d.*$/, ""))).toEqual(["2 worker reports · 2 replies", "1 worker report · 1 reply"]);
  for (const m of markers()) {
    expect(m.className).toContain("bg-geist-blue/5"); // a style of its own, apart from your bubbles
    expect(m.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
  }
  expect(c.textContent).toContain("noted 3"); // open on its own, between the two folded runs
  expect(c.textContent).toContain("noted 8");
  for (const n of [1, 2, 5]) expect(c.textContent).not.toContain(`r/feat-${n} — done`); // folded: unmounted until opened
  await act(async () => { markers()[0]!.querySelector("button")!.click(); await flush(); });
  expect(c.textContent).toContain("r/feat-2 — done"); // expanded inline
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
  // An older long message of yours is cut too, with its own Show more; a short one is not, and your
  // NEWEST message (7) is always in full however long.
  const bubble = (n: number) => [...c.querySelectorAll<HTMLElement>('[data-slot="chat-turn"]')].find((t) => t.textContent!.includes(`reply ${n} line 0`))!.querySelector<HTMLElement>('[data-slot="chat-user"]')!;
  expect(bubble(6).querySelector('[data-slot="turn-clamp"]')).toBeNull();
  expect(bubble(7).querySelector('[data-slot="turn-clamp"]')).toBeNull();
  expect(bubble(7).textContent).toContain("ask 7 line 11");
  const cut = bubble(0).querySelector<HTMLElement>('[data-slot="turn-clamp"]')!;
  expect(cut.firstElementChild!.className).toContain("max-h-[9rem]");
  await act(async () => { cut.querySelector("button")!.click(); await flush(); });
  expect(bubble(0).querySelector<HTMLElement>('[data-slot="turn-clamp"]')!.dataset.open).toBe("true");
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
  const kinds = <T extends { id: string }>(items: ChatItem<T>[]) => items.map((i) => (i.kind === "turn" ? i.turn.id : i.kind === "integration" ? `@${i.turn.id}` : `[${i.turns.map((t) => t.id).join(",")}]`));
  // Your turns, each run of agent turns between them as one block — even a single one, even the newest.
  expect(kinds(chatItems([u("a"), w("b"), w("c"), u("d"), w("e"), w("f")]))).toEqual(["a", "[b,c]", "d", "[e,f]"]);
  expect(kinds(chatItems([w("a"), u("b")]))).toEqual(["[a]", "b"]);
  // The newest answer (keepOut) never folds; the agent turns around it still do.
  const turns = [u("a"), w("b"), w("c"), w("d")];
  expect(kinds(chatItems(turns, turns[2]))).toEqual(["a", "[b]", "c", "[d]"]);
  // newestMessages: the newest turn you spoke in, and the newest finished turn — a live one is not an answer.
  const live = { id: "e", instruction: "hi" };
  expect(newestMessages([...turns, live])).toEqual({ said: live, answer: turns[3] });
  expect(newestMessages([w("x")])).toEqual({ said: undefined, answer: expect.objectContaining({ id: "x" }) });
  // The recorded source wins over the text.
  expect(kinds(chatItems([u("a"), w("b"), { ...w("c"), source: "human" as const }, { ...u("d"), source: "agents" as const }]))).toEqual(["a", "[b]", "c", "[d]"]);
  expect(turnSource([`${WORKER_EVENT_MARKER} a`, `${WORKER_EVENT_MARKER} b`])).toBe("agents");
  expect(turnSource([`${WORKER_EVENT_MARKER} a`, "carry on"])).toBe("human");
  expect(turnSource(["[new draft] repo: r\n\nbuild it"])).toBe("human");
  expect(sourceOf({ instruction: `${WORKER_EVENT_MARKER} a\n\n${WORKER_EVENT_MARKER} b` })).toBe("agents");
  expect(agentsMarker([{ instruction: `${WORKER_EVENT_MARKER} a\n\n${WORKER_EVENT_MARKER} b`, finishedAt: 1 }, { instruction: `${WORKER_EVENT_MARKER} c` }])).toBe("3 worker reports · 1 reply · working");
});

// An outside message as the bridge queues it (server/integrations/inbox.ts withSource): fenced, then
// the meta line. `meta: false` is a row from before the meta line.
const outside = (text: string, sender = "Saajan", place = "#general", meta = true) => [
  fenceExternal({ text, source: { adapter: "discord", linkId: "L1" }, actor: { external: { adapter: "discord", id: "U1", name: sender } }, grant: { level: "ask", repos: [] } }),
  ...(meta ? [integrationMetaLine({ adapter: "discord", sender, place, url: "https://discord.com/channels/G/C/M" })] : []),
].join("\n");

test("the pure pieces: an outside message is read back with its source, and its wake is an activity row", () => {
  expect(integrationMessage(outside("can you ship #12?\nthanks"))).toEqual({ adapter: "discord", sender: "Saajan", place: "#general", url: "https://discord.com/channels/G/C/M", text: "can you ship #12?\nthanks" });
  // A row from before the meta line: the header still names the service and the sender.
  expect(integrationMessage(outside("hi", "Saajan", "", false))).toEqual({ adapter: "discord", sender: "Saajan", text: "hi" });
  // A name can't close the comment early.
  expect(integrationMessage(outside("hi", "a --> b"))!.sender).toBe("a --> b");
  expect(integrationMetaLine({ adapter: "discord", sender: "a --> b" })).not.toContain("-->\"");
  expect(integrationMessage("hi")).toBeUndefined();
  expect(integrationMessage(`${WORKER_EVENT_MARKER} r/x — done`)).toBeUndefined();
  const u = (id: string) => ({ id, instruction: "hi", finishedAt: 1 });
  const x = (id: string, finishedAt?: number) => ({ id, instruction: `${outside("one")}${MESSAGE_BREAK}${outside("two", "Ana", "DM")}`, finishedAt, source: "human" as const });
  expect(integrationTurn(x("a"))!.map((m) => m.sender)).toEqual(["Saajan", "Ana"]);
  expect(integrationTurn({ instruction: `${outside("one")}${MESSAGE_BREAK}carry on` })).toBeUndefined(); // your words: a normal turn
  // Its own row, even when it holds the newest answer; never "your newest message".
  const turns = [u("a"), x("b", 2), x("c", 3)];
  expect(chatItems(turns, turns[2]).map((i) => i.kind === "turn" ? i.turn.id : i.kind === "integration" ? `@${i.turn.id}` : "?")).toEqual(["a", "@b", "@c"]);
  expect(newestMessages(turns).said).toBe(turns[0]);
  expect(integrationState({})).toBe("in progress");
  expect(integrationState({ finishedAt: 1 })).toBe("answered");
  expect(integrationState({ finishedAt: 1, failed: true })).toBe("failed");
  // ↑ in the composer recalls only what you typed.
  expect(composerHistory([u("a"), x("b", 2)], [{ instruction: outside("q") }])).toEqual(["hi"]);
});

test("P8: the orchestrator's chat shows an outside message and its answer as ONE collapsed activity row, never your bubble", async () => {
  const reply = (id: string, text: string, sender: string, place: string, finished = true) => ({
    id, provider: "claude", instruction: outside(text, sender, place), prompt: "", response: finished ? `answered ${sender}` : "", startedAt: 2000, source: "human" as const,
    ...(finished ? { finishedAt: 2001 } : {}),
  });
  apiFake.turnsData.set("r::long", [turn(0), reply("d1", "can you ship #12?", "Saajan", "#general"), turn(1), reply("d2", "status of the deploy?", "Ana", "DM", false)]);
  apiFake.queuedData.set("long", [{ id: 1, instruction: outside("one more", "Saajan", "#general"), attachments: [] }]);
  await mount(<ChatPanel row={row} />);
  const c = container!;
  const rows = [...c.querySelectorAll<HTMLElement>('[data-slot="integration-activity"]')];
  expect(rows).toHaveLength(2);
  const field = (r: HTMLElement, slot: string) => r.querySelector(`[data-slot="${slot}"]`)!.textContent;
  expect(rows.map((r) => [field(r, "integration-sender"), field(r, "integration-place"), field(r, "integration-preview"), field(r, "integration-state")])).toEqual([
    ["Saajan", "#general", "can you ship #12?", "answered"], ["Ana", "DM", "status of the deploy?", "in progress"],
  ]);
  expect(rows[0]!.querySelector('[data-slot="brand-icon"]')!.getAttribute("data-kind")).toBe("discord");
  expect(rows[0]!.className).toContain("bg-geist-blue/5"); // the worker blocks' tinted card
  // Never your bubble, and the answer stays folded until opened.
  expect([...c.querySelectorAll('[data-slot="chat-user-text"]')].map((b) => b.textContent)).toEqual(["ask 0", "ask 1"]);
  expect(c.textContent).not.toContain("answered Saajan");
  expect(c.textContent).not.toContain("external message");
  await act(async () => { rows[0]!.querySelector("button")!.click(); await flush(); });
  expect(field(rows[0]!, "integration-reply")).toContain("answered Saajan");
  expect(rows[0]!.querySelector<HTMLAnchorElement>('[data-slot="integration-message"] a')!.href).toBe("https://discord.com/channels/G/C/M");
  // A queued outside message is its row too, not a queued bubble of yours.
  expect(field(c.querySelector<HTMLElement>('[data-slot="integration-queued"]')!, "integration-state")).toBe("queued");
  expect(c.querySelector('[data-slot="chat-queued"]')).toBeNull();
});

test("P9: a row stored with a catch-all link's label as its place shows no place, in the row and opened", async () => {
  // Stored before the ingest check (#329): the meta line carries "All channels and DMs" for ever.
  // The chat reads the catch-all links' labels from /api/integrations and drops that place.
  apiFake.integrationLinks = [{ id: "Lstar", externalId: "*", label: "All channels and DMs" }, { id: "L1", externalId: "C1", label: "#general" }];
  await reloadCatchAllLabels();
  const reply = (id: string, text: string, place: string) => ({
    id, provider: "claude", instruction: outside(text, "Saajan", place), prompt: "", response: "ok", startedAt: 2000, finishedAt: 2001, source: "human" as const,
  });
  apiFake.turnsData.set("r::long", [turn(0), reply("old", "knob", "All channels and DMs"), reply("chan", "ship it", "#general")]);
  apiFake.queuedData.set("long", [{ id: 1, instruction: outside("Lumino", "Saajan", "All channels and DMs"), attachments: [] }]);
  await mount(<ChatPanel row={row} />);
  const c = container!;
  const rows = [...c.querySelectorAll<HTMLElement>('[data-slot="integration-activity"]')];
  expect(rows.map((r) => r.querySelector('[data-slot="integration-place"]')?.textContent ?? null)).toEqual([null, "#general"]);
  expect(c.querySelector('[data-slot="integration-queued"] [data-slot="integration-place"]')).toBeNull();
  await act(async () => { rows[0]!.querySelector("button")!.click(); await flush(); });
  expect(rows[0]!.querySelector('[data-slot="integration-message-place"]')!.textContent).toBe("Discord");
  expect(c.textContent).not.toContain("All channels and DMs");
  apiFake.integrationLinks = [];
  await reloadCatchAllLabels();
  // The pure piece: a label is dropped only when a catch-all link has it.
  const labels = catchAllLabels([{ externalId: "*", label: " All channels and DMs " }, { externalId: "", label: "Everything" }, { externalId: "C1", label: "#general" }]);
  expect([...labels]).toEqual(["All channels and DMs", "Everything"]);
  expect(shownPlace("All channels and DMs", labels)).toBeUndefined();
  expect(shownPlace("#general", labels)).toBe("#general");
  expect(shownPlace("DM", labels)).toBe("DM");
  expect(shownPlace(undefined, labels)).toBeUndefined();
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

// ---- the lazy mount (views/Chat.tsx LazyItem): only the items near the viewport render ----
// A cold open of a 50-turn, 142k-character thread rendered every turn in one ~540ms commit. Now the
// newest items that fill about 1.5 screens mount at once and the rest are boxes of an estimated height
// until an IntersectionObserver (rooted on the scroller) says they are near; then they stay mounted.

/** An IntersectionObserver the test drives: `near(el)` reports an element as within the margin. */
class ManualObserver {
  static all: ManualObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly cb: IntersectionObserverCallback, readonly options?: IntersectionObserverInit) { ManualObserver.all.push(this); }
  observe(t: Element) { this.targets.add(t); }
  unobserve(t: Element) { this.targets.delete(t); }
  disconnect() { this.targets.clear(); }
  takeRecords() { return []; }
  near(target: Element, rect?: { top: number; bottom: number }) { this.cb([{ target, isIntersecting: true, boundingClientRect: rect } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
}
const items = () => [...container!.querySelectorAll<HTMLElement>('[data-slot="chat-item"]')];

test("P8: the pure pieces — an item's height guess, the eager tail, and the scroll shift where native anchoring is missing", () => {
  // One line per ~80 characters (21px) plus the bubble and header; compact turns cut at 8 lines.
  expect(estimateItemHeight(0)).toBe(64 + 21);
  expect(estimateItemHeight(800)).toBe(64 + 21 * 10);
  expect(estimateItemHeight(8000, { compact: true })).toBe(64 + 21 * 8);
  expect(estimateItemHeight(8000, { folded: true })).toBe(44);
  // The newest items whose guesses fill the budget mount at once — always at least the last one.
  expect(eagerFrom([100, 100, 100, 100], 250)).toBe(1);
  expect(eagerFrom([100, 100, 100, 100], 50)).toBe(3);
  expect(eagerFrom([100, 100], 1000)).toBe(0);
  // Only items wholly above the viewport's top (here 0) move the scroller, by their growth: the first
  // grew 300 and ends above the top; the second (its bottom moved down by that 300) straddles the top — you are reading it; the third is below.
  expect(anchorShift([{ bottom: -50, delta: 300 }, { bottom: 400, delta: 40 }, { bottom: 900, delta: 500 }], 0)).toBe(300);
  // Two above: both count, in any order given (the second's bottom already includes the first's growth).
  expect(anchorShift([{ bottom: -10, delta: 100 }, { bottom: -200, delta: 200 }], 0)).toBe(300);
  expect(anchorShift([], 0)).toBe(0);
});

test("P9: a cold open mounts only the newest items; older ones mount as they near the viewport and then stay", async () => {
  const g = globalThis as unknown as { IntersectionObserver: unknown };
  const visible = g.IntersectionObserver;
  g.IntersectionObserver = ManualObserver;
  ManualObserver.all = [];
  try {
    // 50 long turns: the newest 3 render in full (~590px each), the rest compact.
    apiFake.turnsData.set("r::long", Array.from({ length: 50 }, (_, i) => ({ ...turn(i), response: `reply ${i} ${"word ".repeat(400)}` })));
    await mount();
    const io = ManualObserver.all.at(-1)!;
    expect(io.options?.root).toBe(log()); // rooted on the chat's own scroller, not the page
    // Only the tail is mounted; every older item is an empty box with a height, watched by the observer.
    expect(shown()).toEqual([48, 49]);
    expect(items()).toHaveLength(50);
    const boxes = items().filter((el) => el.dataset.pending !== undefined);
    expect(boxes).toHaveLength(48);
    expect(boxes.every((el) => Number.parseFloat(el.style.height) > 0)).toBe(true);
    expect(io.targets.size).toBe(48);
    // Your newest message and the newest answer are in full.
    expect(log().textContent).toContain("ask 49");
    expect(log().textContent).toContain("reply 49");
    // Scrolling up brings the first item near: it mounts, and is no longer watched.
    await act(async () => { io.near(boxes[0]!); await flush(); });
    expect(shown()).toEqual([0, 48, 49]);
    expect(io.targets.has(items()[0]!)).toBe(false);
    // With a layout: an item near but out of view waits for the batch (LAZY_BATCH_MS) so items mount
    // together in one commit; one already in view mounts at once.
    log().getBoundingClientRect = () => ({ top: 0, bottom: 400, height: 400 }) as DOMRect;
    await act(async () => { io.near(items()[1]!, { top: -900, bottom: -700 }); await flush(); });
    expect(shown()).toEqual([0, 48, 49]);
    await act(async () => { io.near(items()[2]!, { top: -700, bottom: -500 }); await new Promise((r) => setTimeout(r, 120)); });
    expect(shown()).toEqual([0, 1, 2, 48, 49]); // both, in one go
    await act(async () => { io.near(items()[3]!, { top: 100, bottom: 300 }); await flush(); });
    expect(shown()).toEqual([0, 1, 2, 3, 48, 49]);
    // A new turn at the tail mounts at once; the items that were mounted stay mounted.
    apiFake.turnsData.get("r::long")!.push(turn(50));
    await act(async () => { emit(opened().at(-1)!, "turn", { repo: "r", branch: "long", runId: "run-50" }); await flush(); await flush(); });
    expect(shown()).toEqual([0, 1, 2, 3, 48, 49, 50]);
  } finally { g.IntersectionObserver = visible; }
});

test("P10: Jump to latest finishes the jump when items mounted on the way down moved the end", async () => {
  apiFake.turnsData.set("r::long", Array.from({ length: 10 }, (_, i) => turn(i)));
  await mount();
  const el = log();
  layout(el, 100);
  await scrollTo(el, 0);
  // A smooth scroll that stops at the end as it was when it started; meanwhile the content grows 300px.
  let extra = 0;
  el.scrollTo = ((opts: { top: number; behavior?: string }) => { el.scrollTop = opts.top; if (opts.behavior === "smooth") extra = 300; }) as typeof el.scrollTo;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 200 + extra });
  await act(async () => { container!.querySelector<HTMLButtonElement>('[data-slot="chat-jump"]')!.click(); await flush(); });
  expect(el.scrollTop).toBe(200); // where the smooth scroll stopped: short of the new end
  await act(async () => { await new Promise((r) => setTimeout(r, 1050)); });
  expect(el.scrollTop).toBe(500); // landed at the real end
});
