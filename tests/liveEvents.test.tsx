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
