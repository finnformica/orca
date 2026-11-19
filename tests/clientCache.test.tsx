// The app's one read cache is TanStack Query (web/src/lib/queryClient.ts): a view opened again paints
// its last data at once and fetches again in the background; a live update (the chat's SSE steps) is
// written into the chat's query with setQueryData, so the next open starts from it. Before this,
// every page change on the phone showed "Loading…" for one round trip, because each view kept its
// data in its own component state.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useQuery } from "@tanstack/react-query";
import { persistQueryClientRestore, persistQueryClientSave } from "@tanstack/react-query-persist-client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import type { Row } from "@/store";
import { ChatPanel, chatQueryKey, chatToDisk, type ChatCache } from "@/views/Chat";
import { CACHE_SCHEMA, PERSIST_MAX, afterFirstRender, capPersisted, createPersister, firstRenderDone, queryClient, shouldPersist, startPersistence, type KeyValue } from "@/lib/queryClient";
import { TURN_PAGE_SIZE } from "@/workstream";
import type { AgentTurn } from "../shared/agent";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

type FakeSource = EventTarget & { url: string };
const opened = () => (globalThis as unknown as { EventSource: { opened: FakeSource[] } }).EventSource.opened;
const emit = (s: FakeSource, name: string, data: unknown) => s.dispatchEvent(Object.assign(new Event(name), { data: JSON.stringify(data) }));
const flush = () => new Promise((r) => setTimeout(r, 0));

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); await flush(); });
}
async function unmount() {
  await act(async () => { root?.unmount(); });
  container?.remove();
  root = undefined;
}
beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(async () => { await unmount(); apiFake.reset(); });

const row: Row = { repo: "r", hasRemote: false, branch: "cached", title: "Cached", prompt: "", lane: "LOCAL", worktreePath: "/wt/cached", agentProvider: "claude" };
const turn = (i: number, extra: Partial<AgentTurn> = {}) => ({ id: `run-${i}`, provider: "claude", instruction: `ask ${i}`, prompt: "", response: `reply ${i}`, startedAt: 1000 + i, finishedAt: 1001 + i, ...extra });
const asked = () => [...container!.querySelectorAll('[data-slot="chat-user-text"]')].map((e) => e.textContent);

/** A deferred fetch the test answers by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function Probe({ k, fetcher, onData }: { k: string; fetcher: () => Promise<string>; onData: (d: string | undefined) => void }) {
  const { data, error } = useQuery({ queryKey: ["probe", k], queryFn: fetcher }, queryClient);
  if (error) return <span data-slot="probe">{`${data ?? "none"} (${error.message})`}</span>;
  onData(data);
  return <span data-slot="probe">{data ?? "loading"}</span>;
}

test("C1 hit: a second reader of a key paints the cached value at once, then the background fetch's", async () => {
  let calls = 0;
  const first = deferred<string>();
  const seen: (string | undefined)[] = [];
  await mount(<Probe k="k" fetcher={() => { calls++; return first.promise; }} onData={(d) => seen.push(d)} />);
  expect(container!.textContent).toBe("loading"); // nothing cached the first time
  await act(async () => { first.resolve("v1"); await flush(); });
  expect(container!.textContent).toBe("v1");
  await unmount();

  // Back to the page: the cached value is the FIRST render, and a revalidation is in flight.
  const second = deferred<string>();
  const seen2: (string | undefined)[] = [];
  await mount(<Probe k="k" fetcher={() => { calls++; return second.promise; }} onData={(d) => seen2.push(d)} />);
  expect(seen2[0]).toBe("v1");
  expect(container!.textContent).toBe("v1");
  expect(calls).toBe(2);
  await act(async () => { second.resolve("v2"); await flush(); });
  expect(container!.textContent).toBe("v2"); // the background refresh lands
});

test("C2 a failed refresh keeps the last good data and says why", async () => {
  queryClient.setQueryData(["probe", "k"], "good");
  await mount(<Probe k="k" fetcher={() => Promise.reject(new Error("offline"))} onData={() => {}} />);
  expect(container!.textContent).toBe("good (offline)");
  expect(queryClient.getQueryData<string>(["probe", "k"])).toBe("good");
});

test("C3 a chat opened again paints its cached turns at once, then merges the newest page", async () => {
  apiFake.turnsData.set("r::cached", [turn(1), turn(2)]);
  await mount(<ChatPanel row={row} />);
  expect(asked()).toEqual(["ask 1", "ask 2"]);
  await unmount();

  // Away from the chat a third turn landed. On return the cached two show in the FIRST commit (no
  // skeleton), while the page read is held; then the third merges in.
  apiFake.turnsData.set("r::cached", [turn(1), turn(2), turn(3)]);
  apiFake.holdTurnPages = true;
  await mount(<ChatPanel row={row} />);
  expect(container!.querySelector('[data-slot="chat-skeleton"]')).toBeNull();
  expect(asked()).toEqual(["ask 1", "ask 2"]);
  await act(async () => { apiFake.heldTurnPages.splice(0).forEach((r) => r()); await flush(); await flush(); });
  expect(asked()).toEqual(["ask 1", "ask 2", "ask 3"]);
  expect(queryClient.getQueryData<ChatCache>(chatQueryKey("r", "cached"))!.turns.map((t) => t.id)).toEqual(["run-1", "run-2", "run-3"]);
});

test("C4 a live step from the stream is written through to the cache, so the next open starts with it", async () => {
  apiFake.turnsData.set("r::cached", [turn(1), turn(2, { finishedAt: undefined })]);
  await mount(<ChatPanel row={{ ...row, agentStatus: "running" }} />);
  const s = opened().at(-1)!;
  await act(async () => { emit(s, "step", { repo: "r", branch: "cached", runId: "run-2", steps: [{ kind: "text", text: "live words", at: 5 }] }); await flush(); });
  const cached = queryClient.getQueryData<ChatCache>(chatQueryKey("r", "cached"))!;
  expect(cached.turns.find((t) => t.id === "run-2")!.steps).toEqual([{ kind: "text", text: "live words", at: 5 }] as AgentTurn["steps"]);
  await unmount();

  // Reopened with the page read held: the live step is there from the cache before any fetch answers.
  apiFake.holdTurnPages = true;
  await mount(<ChatPanel row={{ ...row, agentStatus: "running" }} />);
  expect(container!.textContent).toContain("live words");
  // A `turn` event (the run finished) still re-reads the newest page: live updates are not cached away.
  const calls = apiFake.turnPageCalls.length;
  await act(async () => { emit(opened().at(-1)!, "turn", { repo: "r", branch: "cached", runId: "run-2" }); await flush(); });
  expect(apiFake.turnPageCalls.length).toBeGreaterThan(calls);
  await act(async () => { apiFake.heldTurnPages.splice(0).forEach((r) => r()); await flush(); await flush(); });
});

test("C5 each conversation starts from its own entry: a panel switched to another chat never shows the last one's turns", async () => {
  apiFake.turnsData.set("r::cached", [turn(1)]);
  apiFake.turnsData.set("r::other", [turn(9)]);
  await mount(<ChatPanel row={row} />);
  expect(asked()).toEqual(["ask 1"]);
  apiFake.holdTurnPages = true;
  await act(async () => { root!.render(<ChatPanel row={{ ...row, branch: "other" }} />); await flush(); });
  expect(asked()).toEqual([]); // not "ask 1": the other chat has no cache entry yet
  await act(async () => { apiFake.heldTurnPages.splice(0).forEach((r) => r()); await flush(); await flush(); });
  expect(asked()).toEqual(["ask 9"]);
});

test("C6 persistence: only chat and Inbox queries go to disk, shrunk, newest PERSIST_MAX; a restart reads them back", async () => {
  const disk = new Map<string, unknown>();
  const kv: KeyValue = { get: async (k) => disk.get(k), set: async (k, v) => { disk.set(k, v); }, del: async (k) => { disk.delete(k); } };
  const persister = createPersister(kv, () => "client:test");
  const save = () => persistQueryClientSave({ queryClient, persister, buster: CACHE_SCHEMA, dehydrateOptions: { shouldDehydrateQuery: shouldPersist } });

  queryClient.setQueryData(["pr", "r", 1], { title: "memory only" });
  const chat: ChatCache = { turns: [turn(1, { steps: [{ kind: "text", text: "big", at: 1 }] })] as AgentTurn[], older: null, dbDown: false, queued: [] };
  queryClient.setQueryData(chatQueryKey("r", "a"), chat);
  const long: ChatCache = { ...chat, turns: Array.from({ length: 2 * TURN_PAGE_SIZE + 1 }, (_, i) => turn(i)) as AgentTurn[] };
  queryClient.setQueryData(chatQueryKey("r", "long"), long); // scrolled far back: not written
  for (let i = 0; i < PERSIST_MAX + 3; i++) queryClient.setQueryData(["inbox", `${i}`], { rows: [i] }, { updatedAt: 10_000 + i });
  await save();
  await persister.flush();

  const written = disk.get("client:test") as Parameters<typeof capPersisted>[0];
  const keys = written.clientState.queries.map((q) => JSON.stringify(q.queryKey));
  expect(keys).not.toContain(JSON.stringify(["pr", "r", 1]));
  expect(keys).not.toContain(JSON.stringify(chatQueryKey("r", "long")));
  expect(keys).toContain(JSON.stringify(chatQueryKey("r", "a")));
  expect(keys.length).toBe(PERSIST_MAX);
  expect(keys).not.toContain(JSON.stringify(["inbox", "0"])); // the oldest go first
  const savedChat = written.clientState.queries.find((q) => q.queryKey[0] === "chat")!.state.data as ChatCache;
  expect(savedChat.turns[0]!.steps).toBeUndefined(); // shrunk

  // A restart (the app ended in the background) reads them back.
  queryClient.clear();
  await persistQueryClientRestore({ queryClient, persister, buster: CACHE_SCHEMA });
  expect(queryClient.getQueryData<unknown>(["inbox", `${PERSIST_MAX + 2}`])).toEqual({ rows: [PERSIST_MAX + 2] });
  expect(queryClient.getQueryData<ChatCache>(chatQueryKey("r", "a"))!.turns[0]!.id).toBe("run-1");

  // A record of another schema is ignored.
  queryClient.clear();
  await persistQueryClientRestore({ queryClient, persister, buster: "other" });
  expect(queryClient.getQueryData(["inbox", `${PERSIST_MAX + 2}`])).toBeUndefined();
});

test("C7 a persisted chat is written without steps (the newest page brings them again)", () => {
  const out = chatToDisk({ turns: [turn(1, { steps: [{ kind: "text", text: "x", at: 1 }] })] as AgentTurn[], older: "c", dbDown: false, queued: [] })!;
  expect(out.turns[0]!.steps).toBeUndefined();
  expect(out.older).toBe("c");
});

test("C8 the first fresh page replaces a cache seed: a turn the bridge no longer has does not stay", async () => {
  queryClient.setQueryData<ChatCache>(chatQueryKey("r", "cached"), { turns: [turn(1), turn(2)] as AgentTurn[], older: "stale", dbDown: false, queued: [] });
  apiFake.turnsData.set("r::cached", [turn(2), turn(3)]);
  apiFake.holdTurnPages = true;
  await mount(<ChatPanel row={row} />);
  expect(asked()).toEqual(["ask 1", "ask 2"]); // the seed, at once
  await act(async () => { apiFake.heldTurnPages.splice(0).forEach((r) => r()); await flush(); await flush(); });
  expect(asked()).toEqual(["ask 2", "ask 3"]);
  expect(queryClient.getQueryData<ChatCache>(chatQueryKey("r", "cached"))!.older).toBeNull();
});

test("C9 boot order: the board's first load waits for the first render, so a page's own fetch goes first", async () => {
  // No app booting (every other test): no wait at all.
  let done = false;
  void afterFirstRender().then(() => { done = true; });
  await Promise.resolve();
  expect(done).toBe(true);
  // main.tsx's boot arms it (startPersistence); only the mark after <App /> releases it.
  await startPersistence(0, null);
  done = false;
  const gate = afterFirstRender().then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 20));
  expect(done).toBe(false);
  firstRenderDone();
  await gate;
  expect(done).toBe(true);
  // Only a page that does not draw from the board waits; on a board page the rows ARE the page's data.
  for (const name of ["overview", "agents", "board"] as const) expect(store.boardFirst({ name })).toBe(true);
  expect(store.boardFirst({ name: "pr", repo: "r", number: 1, sub: "chat" })).toBe(true);
  expect(store.boardFirst({ name: "local", repo: "r", branch: "b", sub: "chat" })).toBe(true);
  for (const name of ["inbox", "orchestrator", "memory", "settings", "integrations"] as const) expect(store.boardFirst({ name })).toBe(false);
});
