// Agent rooms (docs/design/agent-rooms.md, shared/rooms.ts): which turns leave your chat for a room
// between two agents, who sent each message and to whom, and the unread count. Old turns carry no new
// field: they classify off the text markers and `origin` alone.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import { roomMessages } from "../server/rooms";
import { freshSchema, type TestDb } from "./pg";
import { agentMessage } from "../shared/agents";
import { scheduledWakeMessage } from "../shared/scheduledWake";
import {
  agentParty, chatOwner, inMainChat, messageSender, partyLabel, reportWorker, roomId, roomUnread, roomsOf, routeLabel,
  turnPeer, turnRoomMessages, workerParty, type RoomTurn,
} from "../shared/rooms";
import { joinMessages, turnOrigin, workerEvent } from "../web/src/workstream";

const CHIEF = agentParty("chief"), ASSISTANT = agentParty("assistant");
const WORKER = workerParty("orca", "feat/cache");
const report = workerEvent({ repo: "orca", branch: "feat/cache", title: "Cache", runId: "run-w1", status: "done", response: "Added the cache." });
const turn = (id: string, instruction: string, extra: Partial<RoomTurn> = {}): RoomTurn =>
  ({ id, instruction, prompt: "", response: `reply to ${id}`, startedAt: 1000, finishedAt: 2000, ...extra });

test("a chat's owner: an @orca branch is a named agent, any other branch a worker", () => {
  expect(chatOwner("@orca", "orchestrator")).toBe(CHIEF);
  expect(chatOwner("@orca", "assistant")).toBe(ASSISTANT);
  expect(chatOwner("orca", "feat/cache")).toBe(WORKER);
  expect(roomId(CHIEF, ASSISTANT)).toBe(roomId(ASSISTANT, CHIEF));
});

test("a message's sender comes from its marker; yours and Orca's have none", () => {
  expect(messageSender(agentMessage("chief", "Check the inbox"))).toEqual({ from: CHIEF, kind: "ask" });
  expect(messageSender(scheduledWakeMessage({ id: 4, note: "read its answer", on: "agent:assistant", event: "orca.agent.replied" })))
    .toEqual({ from: ASSISTANT, kind: "wake" });
  expect(messageSender(scheduledWakeMessage({ id: 5, note: "standup", at: Date.UTC(2026, 9, 27, 9) }))).toBeUndefined();
  expect(reportWorker(report)).toBe(WORKER);
  expect(messageSender(report)).toEqual({ from: WORKER, kind: "report" });
  expect(messageSender("Please tidy the board")).toBeUndefined();
});

test("a named agent's turn goes to a room only when every message is from ONE other agent", () => {
  expect(turnPeer(ASSISTANT, turn("a", agentMessage("chief", "Summarise #general")))).toBe(CHIEF);
  expect(turnPeer(ASSISTANT, turn("b", joinMessages([agentMessage("chief", "one"), agentMessage("chief", "two")])))).toBe(CHIEF);
  // A fired `orca wake --on agent:assistant` in the Chief of Staff's chat: the Assistant's reply arrived.
  expect(turnPeer(CHIEF, turn("c", scheduledWakeMessage({ id: 4, note: "read it", on: "agent:assistant" })))).toBe(ASSISTANT);
  // Your words in the same wake: it stays yours.
  expect(turnPeer(ASSISTANT, turn("d", joinMessages(["hi", agentMessage("chief", "one")])))).toBeUndefined();
  // Worker reports keep their folded block in the agent's chat.
  expect(turnPeer(CHIEF, turn("e", report))).toBeUndefined();
  // Unknown (an old row with plain text): the main chat.
  expect(inMainChat(CHIEF, turn("f", "What runs today?"))).toBe(true);
});

test("a worker's turn goes to the briefing agent's room by its origin; an old origin is the Chief of Staff's", () => {
  const old = turnOrigin({ runId: "wake-1", messages: ["do it"], ids: [7] });
  expect(old.agent).toBeUndefined();
  expect(turnPeer(WORKER, turn("w1", "## Objective\nAdd a cache", { origin: old }))).toBe(CHIEF);
  expect(turnPeer(WORKER, turn("w2", "brief", { origin: turnOrigin({ runId: "wake-2", messages: [], ids: [], agent: "assistant" }) }))).toBe(ASSISTANT);
  // Your own follow-up to the worker: no origin, your chat.
  expect(turnPeer(WORKER, turn("w3", "also fix the typo"))).toBeUndefined();
});

test("room messages name both ends: the ask, then the reply back", () => {
  const msgs = turnRoomMessages(ASSISTANT, turn("a1", agentMessage("chief", "Summarise #general")), ASSISTANT);
  expect(msgs.map((m) => [m.from, m.to, m.kind, m.text])).toEqual([
    [CHIEF, ASSISTANT, "ask", "Summarise #general"],
    [ASSISTANT, CHIEF, "reply", "reply to a1"],
  ]);
  expect(msgs[0]!.room).toBe(roomId(CHIEF, ASSISTANT));
  // A brief carries its origin, so the room shows who asked for it.
  const origin = turnOrigin({ runId: "wake-1", messages: ["do it"], ids: [7], agent: "chief" });
  const brief = turnRoomMessages(WORKER, turn("w1", "## Objective\nAdd a cache", { origin }), WORKER);
  expect(brief.map((m) => [m.from, m.to, m.kind])).toEqual([[CHIEF, WORKER, "brief"], [WORKER, CHIEF, "reply"]]);
  expect(brief[0]!.origin).toEqual(origin);
  // A turn still running has no reply yet.
  expect(turnRoomMessages(ASSISTANT, turn("a2", agentMessage("chief", "x"), { finishedAt: undefined }), ASSISTANT)).toHaveLength(1);
});

test("another chat holds the viewer's side: its asks there, and reports about a worker", () => {
  // In the Chief of Staff's chat, the Assistant escalated: seen from the Assistant.
  const esc = turnRoomMessages(CHIEF, turn("c1", agentMessage("assistant", "Please merge #12")), ASSISTANT);
  expect(esc.map((m) => [m.from, m.to, m.kind])).toEqual([[ASSISTANT, CHIEF, "ask"], [CHIEF, ASSISTANT, "reply"]]);
  // A mixed wake there: the ask only, not the Chief of Staff's reply to you.
  const mixed = turnRoomMessages(CHIEF, turn("c2", joinMessages(["hello", agentMessage("assistant", "FYI")])), ASSISTANT);
  expect(mixed.map((m) => m.kind)).toEqual(["ask"]);
  // A report about the worker, seen from the worker's chat.
  const rep = turnRoomMessages(CHIEF, turn("c3", report), WORKER);
  expect(rep.map((m) => [m.from, m.to, m.kind])).toEqual([[WORKER, CHIEF, "report"], [CHIEF, WORKER, "reply"]]);
  // Another worker's report is not this worker's.
  expect(turnRoomMessages(CHIEF, turn("c4", report), workerParty("orca", "feat/other"))).toEqual([]);
});

test("rooms group by peer, newest room first; unread counts what came after the last visit", () => {
  const a = turnRoomMessages(ASSISTANT, turn("a1", agentMessage("chief", "one"), { startedAt: 10, finishedAt: 20 }), ASSISTANT);
  const b = turnRoomMessages(CHIEF, turn("c1", agentMessage("assistant", "two"), { startedAt: 30, finishedAt: 40 }), ASSISTANT);
  const rooms = roomsOf(ASSISTANT, [...b, ...a, ...a]); // a message seen twice counts once
  expect(rooms).toHaveLength(1);
  expect(rooms[0]!.peer).toBe(CHIEF);
  expect(rooms[0]!.messages.map((m) => m.at)).toEqual([10, 20, 30, 40]);
  expect(roomUnread(rooms[0]!, 20)).toBe(2);
  expect(roomUnread(rooms[0]!, 40)).toBe(0);
  // Never opened: the last day only.
  expect(roomUnread(rooms[0]!, undefined, 25 + 24 * 3600_000)).toBe(2);
});

test("labels name agents by their display name and a worker by its branch", () => {
  expect(routeLabel(CHIEF, ASSISTANT)).toBe("Chief of Staff → Assistant");
  expect(partyLabel(WORKER)).toBe("Worker feat/cache");
  expect(partyLabel(agentParty("scout"), { scout: "Scout" })).toBe("Scout");
  expect(partyLabel("user")).toBe("You");
});

// ---- /api/rooms against a real database (server/rooms.ts, db.roomTurns) ----
let pg: TestDb | undefined;
let prev: Record<string, string | undefined> = {};
let state = "";
beforeEach(async () => {
  prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_STATE_DIR: process.env.ORCA_STATE_DIR };
  state = mkdtempSync(join(tmpdir(), "orca-rooms-"));
  process.env.ORCA_STATE_DIR = state;
  pg = await freshSchema("rooms");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await db.close();
  await pg?.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(state, { recursive: true, force: true });
});

const record = async (repo: string, branch: string, runId: string, instruction: string, at: number, extra: { origin?: ReturnType<typeof turnOrigin> } = {}) => {
  await db.startTurn({ repo, branch, runId, provider: "claude", instruction, prompt: instruction, startedAt: at, ...extra });
  await db.finishTurn(runId, { status: "done", response: `reply ${runId}`, finishedAt: at + 1 });
};

test("the rooms read finds both sides of a pair across chats, and a worker's briefs and reports", async () => {
  await record("@orca", "assistant", "a-ask", agentMessage("chief", "Summarise the inbox"), 100);
  await record("@orca", "assistant", "a-you", "What is new?", 110);
  await record("@orca", "orchestrator", "c-esc", agentMessage("assistant", "Please merge #12"), 120);
  await record("@orca", "orchestrator", "c-you", "Hello", 130);
  await record("@orca", "orchestrator", "c-rep", report, 140);
  await record("orca", "feat/cache", "w-brief", "## Objective\nAdd a cache", 90, { origin: turnOrigin({ runId: "c-you", messages: ["Hello"], ids: [], agent: "chief" }) });
  await record("orca", "feat/cache", "w-you", "Fix the typo", 150);

  const assistant = await roomMessages("@orca", "assistant");
  expect(assistant.map((m) => `${m.runId} ${m.kind} ${m.from}>${m.to}`)).toEqual([
    "a-ask ask agent:chief>agent:assistant", "a-ask reply agent:assistant>agent:chief",
    "c-esc ask agent:assistant>agent:chief", "c-esc reply agent:chief>agent:assistant",
  ]);
  const chief = await roomMessages("@orca", "orchestrator");
  expect(chief.map((m) => `${m.runId} ${m.kind}`)).toEqual(["c-esc ask", "c-esc reply", "a-ask ask", "a-ask reply"]);
  const worker = await roomMessages("orca", "feat/cache");
  expect(worker.map((m) => `${m.runId} ${m.kind} ${m.from}>${m.to}`)).toEqual([
    "w-brief brief agent:chief>worker:orca/feat/cache", "w-brief reply worker:orca/feat/cache>agent:chief",
    "c-rep report worker:orca/feat/cache>agent:chief", "c-rep reply agent:chief>worker:orca/feat/cache",
  ]);
  expect(worker[0]!.origin?.agent).toBe("chief");
});
