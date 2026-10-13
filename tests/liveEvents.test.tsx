// The tab's ONE live stream (web/src/lib/events.ts). A browser gets six HTTP/1.1 connections per host
// across all its tabs; an EventSource per chat used them up and the PR page's fetches queued behind
// them forever. So every open chat shares one stream, routed by repo/branch, and a hidden tab gives
// its connection back — catching up from its cursor when shown again.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

type FakeSource = EventTarget & { url: string };
const opened = () => (globalThis as unknown as { EventSource: { opened: FakeSource[] } }).EventSource.opened;
const flush = () => new Promise((r) => setTimeout(r, 0));
const row = (branch: string): Row => ({ repo: "r", hasRemote: false, branch, title: branch, prompt: "", lane: "LOCAL", worktreePath: `/wt/${branch}`, agentProvider: "claude" });
const emit = (s: FakeSource, name: string, data: unknown) => s.dispatchEvent(Object.assign(new Event(name), { data: JSON.stringify(data) }));
let visibility: DocumentVisibilityState = "visible";
const setVisibility = async (v: DocumentVisibilityState) => {
  visibility = v;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await flush(); await flush(); });
};

let root: Root | undefined;
let container: HTMLElement | undefined;
beforeEach(() => {
  apiFake.reset();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  await setVisibility("visible");
});

test("two open chats share ONE stream; each hears only its own branch; hidden tab releases it and catches up on return", async () => {
  apiFake.turnsData.set("r::a", [{ id: "run-a", provider: "claude", prompt: "job a", response: "" }]);
  apiFake.turnsData.set("r::b", [{ id: "run-b", provider: "claude", prompt: "job b", response: "" }]);
  const before = opened().length;
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<><ChatPanel row={row("a")} /><ChatPanel row={row("b")} /></>);
    await flush(); await flush();
  });

  // One connection for both chats (it used to be one per chat — and per card, orchestrator, tab…).
  expect(opened().length).toBe(before + 1);
  const stream = opened().at(-1)!;
  expect(stream.url).toBe("/api/events");
  await act(async () => { emit(stream, "ready", {}); await flush(); });

  // Routed by repo/branch: a step for `a` shows in a's log only.
  await act(async () => {
    emit(stream, "step", { repo: "r", branch: "a", runId: "run-a", steps: [{ at: 1, kind: "text", text: "ONLY_IN_A" }] });
    await flush();
  });
  const [a, b] = [container.children[0]!, container.children[1]!]; // each ChatPanel's root
  expect(a!.textContent).toContain("ONLY_IN_A");
  expect(b!.textContent).not.toContain("ONLY_IN_A");

  // Tab hidden → the connection goes back to the browser's pool.
  await setVisibility("hidden");
  expect(opened().length).toBe(before);

  // While away, `b` recorded a step. Shown again → one fresh stream, and its `ready` makes each chat
  // catch up from its cursor (the steps endpoint), so nothing recorded meanwhile is missing.
  apiFake.turnStepsData.set("run-b", [{ seq: 1, step: { at: 2, kind: "text", text: "WHILE_HIDDEN" } }]);
  await setVisibility("visible");
  expect(opened().length).toBe(before + 1);
  await act(async () => { emit(opened().at(-1)!, "ready", {}); await flush(); await flush(); });
  expect(b!.textContent).toContain("WHILE_HIDDEN");

  // Last chat closed → no stream at all.
  await act(async () => { root!.unmount(); root = undefined; });
  expect(opened().length).toBe(before);
});

// "The reply only shows once I send another message": a finished turn must render from the stream
// alone — no send, no reload — however the fetches it triggers interleave, and after any gap in the
// feed (hidden tab, dropped connection, a stream that died for good).
const pending = (id: string, instruction: string) => ({ id, provider: "claude", instruction, prompt: "", response: "", startedAt: 10 });
const finished = (id: string, instruction: string, response: string) => ({ ...pending(id, instruction), response, finishedAt: 20 });
async function mountOne(branch: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<ChatPanel row={row(branch)} />); await flush(); await flush(); });
}

test("L2: a stale page fetched while the run was running can't overwrite the finished reply that landed first", async () => {
  apiFake.turnsData.set("r::race", [pending("run-1", "do it")]);
  await mountOne("race");
  const stream = opened().at(-1)!;
  await act(async () => { emit(stream, "ready", {}); await flush(); });
  // A `turn` event (say, the run's start) fetches the page — slowly; the run finishes meanwhile and
  // its `turn` event fetches again, which answers FIRST.
  apiFake.holdTurnPages = true;
  await act(async () => { emit(stream, "turn", { repo: "r", branch: "race", runId: "run-1" }); await flush(); });
  apiFake.turnsData.set("r::race", [finished("run-1", "do it", "THE_REPLY")]);
  await act(async () => { emit(stream, "turn", { repo: "r", branch: "race", runId: "run-1" }); await flush(); });
  const [slow, fast] = apiFake.heldTurnPages;
  await act(async () => { fast!(); await flush(); await flush(); });
  expect(container!.textContent).toContain("THE_REPLY");
  await act(async () => { slow!(); await flush(); await flush(); });
  expect(container!.textContent).toContain("THE_REPLY");
  expect(container!.textContent).not.toContain("working…");
});

test("L3: back from a hidden tab, the newest turn's finish is caught up even past an older unfinished turn", async () => {
  // An old turn left unfinished (an interrupted run) used to be the only one the catch-up looked at.
  apiFake.turnsData.set("r::gap", [pending("run-old", "old"), pending("run-new", "new")]);
  await mountOne("gap");
  await act(async () => { emit(opened().at(-1)!, "ready", {}); await flush(); });
  await setVisibility("hidden");
  apiFake.turnsData.set("r::gap", [pending("run-old", "old"), finished("run-new", "new", "MISSED_WHILE_HIDDEN")]);
  apiFake.turnFinished.add("run-new");
  await setVisibility("visible");
  await act(async () => { emit(opened().at(-1)!, "ready", {}); await flush(); await flush(); await flush(); });
  expect(container!.textContent).toContain("MISSED_WHILE_HIDDEN");
});

test("L4: a chat opened while the tab is hidden catches up when the stream finally opens", async () => {
  apiFake.turnsData.set("r::late", [pending("run-1", "go")]);
  await setVisibility("hidden");
  const before = opened().length;
  await mountOne("late");
  expect(opened().length).toBe(before); // hidden: no connection yet
  apiFake.turnsData.set("r::late", [finished("run-1", "go", "FINISHED_BEFORE_THE_STREAM")]);
  await setVisibility("visible");
  await act(async () => { emit(opened().at(-1)!, "ready", {}); await flush(); await flush(); });
  expect(container!.textContent).toContain("FINISHED_BEFORE_THE_STREAM");
});

test("L5: a stream the browser gave up on (an HTTP error closes an EventSource for good) is reopened and caught up", async () => {
  apiFake.turnsData.set("r::dead", [pending("run-1", "go")]);
  await mountOne("dead");
  const first = opened().at(-1)! as FakeSource & { readyState: number };
  await act(async () => { emit(first, "ready", {}); await flush(); });
  first.readyState = 2; // CLOSED: a 502 from a restarting bridge — the browser will not retry
  await act(async () => { first.dispatchEvent(new Event("error")); await flush(); });
  apiFake.turnsData.set("r::dead", [finished("run-1", "go", "AFTER_THE_OUTAGE")]);
  await act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
  const second = opened().at(-1)!;
  expect(second).not.toBe(first);
  await act(async () => { emit(second, "ready", {}); await flush(); await flush(); });
  expect(container!.textContent).toContain("AFTER_THE_OUTAGE");
});

test("L6: a claude reply types out live from `delta` events, and its whole message replaces the draft", async () => {
  apiFake.turnsData.set("r::typing", [pending("run-1", "say hi")]);
  await mountOne("typing");
  const stream = opened().at(-1)!;
  await act(async () => { emit(stream, "ready", {}); await flush(); });
  const draft = () => container!.querySelector('[data-slot="turn-draft"]')?.textContent;
  await act(async () => {
    emit(stream, "delta", { repo: "r", branch: "typing", runId: "run-1", text: "Hello, " });
    emit(stream, "delta", { repo: "r", branch: "typing", runId: "run-1", text: "wor" });
    emit(stream, "delta", { repo: "r", branch: "other", runId: "run-x", text: "NOT_MINE" });
    await flush();
  });
  expect(draft()).toBe("Hello, wor");
  expect(container!.textContent).not.toContain("NOT_MINE");
  // The whole message lands as a step: shown once, the draft gone.
  await act(async () => {
    emit(stream, "step", { repo: "r", branch: "typing", runId: "run-1", steps: [{ at: 1, kind: "text", text: "Hello, world." }] });
    await flush();
  });
  expect(draft()).toBeUndefined();
  expect(container!.textContent).toContain("Hello, world.");
  // Deltas for the next message, then the turn finishes: no draft outlives it.
  await act(async () => { emit(stream, "delta", { repo: "r", branch: "typing", runId: "run-1", text: "More" }); await flush(); });
  expect(draft()).toBe("More");
  apiFake.turnsData.set("r::typing", [finished("run-1", "say hi", "Hello, world. More.")]);
  await act(async () => { emit(stream, "turn", { repo: "r", branch: "typing", runId: "run-1" }); await flush(); await flush(); });
  expect(draft()).toBeUndefined();
  expect(container!.textContent).toContain("Hello, world. More.");
});
