// Agent rooms (docs/design/agent-rooms.md, shared/rooms.ts): who sent each turn and to whom (the
// route, recorded at the start and read off old rows by the same rule), which turns leave your chat
// for the room of an agent pair, the room's entries, the pills in your chat, and the read across the
// agents' chats against a real database.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import { roomEntries } from "../server/rooms";
import { freshSchema, type TestDb } from "./pg";
import { AUTOFIX_MARKER } from "../shared/agent";
import { agentMessage } from "../shared/agents";
import { scheduledWakeMessage } from "../shared/scheduledWake";
import {
  PERSON, agentSide, chatOwner, entryPill, inMainChat, mergePills, messageSender, orcaSide, reportWorker, roomId, roomUnseen, roomsOf,
  rememberAgentNames, routeLabel, routeOf, sideLabel, stripAgentWrapper, turnPeer, turnRoomEntry, turnRoute, workerSide, type RoomPill, type RoomTurn,
} from "../shared/rooms";
import { joinMessages, turnOrigin, workerEvent } from "../web/src/workstream";

const CHIEF = agentSide("chief"), ASSISTANT = agentSide("assistant");
const WORKER = workerSide("orca", "feat/cache");
const report = workerEvent({ repo: "orca", branch: "feat/cache", title: "Cache", runId: "run-w1", status: "done", response: "Added the cache." });
const turn = (id: string, instruction: string, extra: Partial<RoomTurn> = {}): RoomTurn =>
  ({ id, instruction, prompt: "", response: `reply to ${id}`, startedAt: 1000, finishedAt: 2000, ...extra });

describe("rules", () => {
  test("sides: an @orca branch is a named agent, any other branch a worker; a room is the same from both ends", () => {
    expect(chatOwner("@orca", "orchestrator")).toEqual(CHIEF);
    expect(chatOwner("@orca", "assistant")).toEqual(ASSISTANT);
    expect(chatOwner("orca", "feat/cache")).toEqual({ kind: "worker", id: "orca/feat/cache" });
    expect(roomId(CHIEF, ASSISTANT)).toBe(roomId(ASSISTANT, CHIEF));
  });

  test("a message's sender comes from its marker; the person's words have none", () => {
    expect(messageSender(agentMessage("chief", "Check the inbox"))).toEqual({ sender: CHIEF, kind: "ask" });
    expect(messageSender(scheduledWakeMessage({ id: 4, note: "read its answer", on: "agent:assistant", event: "orca.agent.replied" })))
      .toEqual({ sender: ASSISTANT, kind: "wake" });
    expect(messageSender(scheduledWakeMessage({ id: 5, note: "standup", at: Date.UTC(2026, 9, 27, 9) }))!.sender).toEqual(orcaSide("wake"));
    expect(reportWorker(report)).toEqual(WORKER);
    expect(messageSender(report)).toEqual({ sender: WORKER, kind: "report" });
    expect(messageSender("Please tidy the board")).toBeUndefined();
  });

  test("the route of an agent's wake: its one sender; any word of the person's makes it the person's", () => {
    expect(turnRoute(ASSISTANT, turn("a", agentMessage("chief", "Summarise #general")))).toEqual({ sender: CHIEF, recipient: ASSISTANT });
    expect(turnRoute(ASSISTANT, turn("b", joinMessages([agentMessage("chief", "one"), agentMessage("chief", "two")]))).sender).toEqual(CHIEF);
    expect(turnRoute(CHIEF, turn("c", scheduledWakeMessage({ id: 4, note: "read it", on: "agent:assistant" }))).sender).toEqual(ASSISTANT);
    expect(turnRoute(ASSISTANT, turn("d", joinMessages(["hi", agentMessage("chief", "one")]))).sender).toEqual(PERSON);
    expect(turnRoute(CHIEF, turn("e", report)).sender).toEqual(WORKER);
    expect(turnRoute(CHIEF, turn("f", joinMessages([report, workerEvent({ repo: "orca", branch: "x", runId: "r", status: "done" })]))).sender).toEqual(orcaSide("reports"));
    expect(turnRoute(CHIEF, turn("g", "What runs today?")).sender).toEqual(PERSON);
  });

  test("the route of a worker's turn: the origin's agent (old origin = Chief of Staff), Orca's own runs, else the person", () => {
    const old = turnOrigin({ runId: "wake-1", messages: ["do it"], ids: [7] });
    expect(old.agent).toBeUndefined();
    expect(turnRoute(WORKER, turn("w1", "## Objective\nAdd a cache", { origin: old })).sender).toEqual(CHIEF);
    expect(turnRoute(WORKER, turn("w2", "brief", { origin: turnOrigin({ runId: "wake-2", messages: [], ids: [], agent: "assistant" }) })).sender).toEqual(ASSISTANT);
    expect(turnRoute(WORKER, turn("w3", `${AUTOFIX_MARKER} Fix it.`)).sender).toEqual(orcaSide("autofix"));
    // The upkeep tick records itself: its text is the same as the Address PR button's.
    expect(turnRoute(WORKER, { instruction: "Address the PR: conflicts, CI, review", sender: orcaSide("upkeep") }).sender).toEqual(orcaSide("upkeep"));
    expect(turnRoute(WORKER, turn("w4", "Address the PR: conflicts, CI, review")).sender).toEqual(PERSON);
  });

  test("a recorded route wins over the text; a room turn is one another agent sent", () => {
    const t = turn("r", "plain text", { route: { sender: CHIEF, recipient: ASSISTANT } });
    expect(routeOf(ASSISTANT, t).sender).toEqual(CHIEF);
    expect(turnPeer(ASSISTANT, t)).toEqual(CHIEF);
    expect(inMainChat(ASSISTANT, turn("p", "What is new?"))).toBe(true);
    expect(inMainChat(CHIEF, turn("rep", report))).toBe(true); // reports keep their folded block there
  });

  test("a worker chat keeps every turn: a Chief of Staff brief, a send and Orca's own runs, each named by its sender", () => {
    const origin = turnOrigin({ runId: "wake-1", messages: ["add a cache"], ids: [7], agent: "chief" });
    const brief = turn("w1", "## Objective\nAdd a cache", { origin });
    expect(inMainChat(WORKER, brief)).toBe(true);
    expect(turnPeer(WORKER, brief)).toBeUndefined();
    expect(turnRoomEntry(WORKER, brief, WORKER)).toBeUndefined();
    // The sender stays on the turn, so the chat names it.
    expect(sideLabel(routeOf(WORKER, brief).sender)).toBe("Chief of Staff");
    // A recorded route from another agent (a send by the Assistant) stays too.
    const sent = turn("w2", "Also fix the typo", { route: { sender: ASSISTANT, recipient: WORKER } });
    expect(inMainChat(WORKER, sent)).toBe(true);
    expect(routeOf(WORKER, sent).sender).toEqual(ASSISTANT);
    // Orca's own runs: an autofix, an upkeep address.
    expect(inMainChat(WORKER, turn("w3", `${AUTOFIX_MARKER} Fix it.`))).toBe(true);
    expect(inMainChat(WORKER, turn("w4", "Address the PR", { route: { sender: orcaSide("upkeep"), recipient: WORKER } }))).toBe(true);
  });

  test("an orca ask between two agents still goes to their room", () => {
    const ask = turn("a1", agentMessage("chief", "Summarise #general"));
    expect(inMainChat(ASSISTANT, ask)).toBe(false);
    expect(turnPeer(ASSISTANT, ask)).toEqual(CHIEF);
    expect(turnRoomEntry(ASSISTANT, ask, ASSISTANT)!.room).toBe(roomId(CHIEF, ASSISTANT));
  });

  test("an entry names both ends, with the wrapper stripped; the reply goes back", () => {
    const e = turnRoomEntry(ASSISTANT, turn("a1", agentMessage("chief", "Summarise #general")), ASSISTANT)!;
    expect([e.sender, e.recipient, e.kind, e.messages, e.reply]).toEqual([CHIEF, ASSISTANT, "ask", ["Summarise #general"], "reply to a1"]);
    expect(e.room).toBe(roomId(CHIEF, ASSISTANT));
    expect(stripAgentWrapper("[from assistant] hi")).toBe("hi");
    expect(turnRoomEntry(ASSISTANT, turn("a2", agentMessage("chief", "x"), { finishedAt: undefined }), ASSISTANT)!.reply).toBeUndefined();
    expect(turnRoomEntry(ASSISTANT, turn("a3", "What is new?"), ASSISTANT)).toBeUndefined();
  });

  test("another chat holds the viewer's side: its asks there, and reports about a worker", () => {
    const esc = turnRoomEntry(CHIEF, turn("c1", agentMessage("assistant", "Please merge #12")), ASSISTANT)!;
    expect([esc.sender, esc.recipient, esc.messages, esc.reply]).toEqual([ASSISTANT, CHIEF, ["Please merge #12"], "reply to c1"]);
    // A wake that was also yours: the ask only, never the Chief of Staff's reply to you.
    const mixed = turnRoomEntry(CHIEF, turn("c2", joinMessages(["hello", agentMessage("assistant", "FYI")])), ASSISTANT)!;
    expect([mixed.messages, mixed.reply]).toEqual([["FYI"], undefined]);
    const rep = turnRoomEntry(CHIEF, turn("c3", report), WORKER)!;
    expect([rep.sender, rep.recipient, rep.kind, rep.reply]).toEqual([WORKER, CHIEF, "report", "reply to c3"]);
    expect(turnRoomEntry(CHIEF, turn("c4", report), workerSide("orca", "feat/other"))).toBeUndefined();
  });

  test("rooms group by peer; pills count messages, merge when adjacent, and carry the person's words", () => {
    const a = turnRoomEntry(ASSISTANT, turn("a1", agentMessage("chief", "one"), { startedAt: 10, finishedAt: 20 }), ASSISTANT)!;
    const b = turnRoomEntry(CHIEF, turn("c1", agentMessage("assistant", "two"), { startedAt: 30, finishedAt: 40 }), ASSISTANT)!;
    const rooms = roomsOf(ASSISTANT, [b, a, a]);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.peer).toEqual(CHIEF);
    expect(rooms[0]!.entries.map((e) => e.id)).toEqual(["a1", "c1"]);
    expect(rooms[0]!.lastAt).toBe(40);
    type It = { pill?: RoomPill; text?: string };
    const items: It[] = [{ pill: entryPill(ASSISTANT, a) }, { pill: entryPill(ASSISTANT, b) }, { text: "yours" }, { pill: entryPill(ASSISTANT, a) }];
    const merged = mergePills(items, (i) => i.pill, (pill) => ({ pill }));
    expect(merged.map((i) => i.pill?.count ?? i.text)).toEqual([4, "yours", 2]);
    const origin = turnOrigin({ runId: "w", messages: ["fix it"], ids: [3], agent: "chief" });
    const brief = { ...a, id: "w1", origin, originMessages: [{ id: 3, text: "fix it" }, { id: 4, missing: true as const }] };
    expect(entryPill(ASSISTANT, brief).person).toEqual([{ id: 3, text: "fix it" }]);
    expect(roomUnseen(40, 20)).toBe(true);
    expect(roomUnseen(40, 40)).toBe(false);
    expect(roomUnseen(40, undefined, 40 + 24 * 3600_000 + 1)).toBe(false); // never opened: the last day only
  });

  test("labels: agents by display name, a worker by its branch, Orca by what it did", () => {
    expect(routeLabel(CHIEF, ASSISTANT)).toBe("Chief of Staff → Assistant");
    expect(sideLabel(WORKER)).toBe("Worker feat/cache");
    expect(sideLabel(agentSide("scout"), { scout: "Scout Bot" })).toBe("Scout Bot");
    // The agents list teaches the labels (api.orchestratorAgents); before it, the name, capitalised.
    expect(sideLabel(agentSide("night-watch"))).toBe("Night-watch");
    rememberAgentNames([{ agent: "night-watch", displayName: "Night Watch" }]);
    expect(sideLabel(agentSide("night-watch"))).toBe("Night Watch");
    expect(sideLabel(orcaSide("upkeep"))).toBe("Orca · PR upkeep");
    expect(sideLabel(PERSON)).toBe("You");
  });
});

// ---- the record and /api/rooms against a real database (db.startTurn, server/rooms.ts) ----
describe("database", () => {
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

  const record = async (repo: string, branch: string, runId: string, instruction: string, at: number, extra: Partial<Parameters<typeof db.startTurn>[0]> = {}) => {
    await db.startTurn({ repo, branch, runId, provider: "claude", instruction, prompt: instruction, startedAt: at, ...extra });
    await db.finishTurn(runId, { status: "done", response: `reply ${runId}`, structured: { outcome: "ok" } as never, finishedAt: at + 1 });
  };

  test("each turn records its route at the start, and the finish keeps it beside the outcome", async () => {
    await record("@orca", "assistant", "a-ask", agentMessage("chief", "Summarise"), 100);
    await record("orca", "feat/cache", "w-up", "Address the PR: conflicts, CI, review", 110, { sender: orcaSide("upkeep") });
    await record("orca", "feat/cache", "w-you", "Fix the typo", 120);
    const [ask] = await db.turns("@orca", "assistant");
    expect(ask!.route).toEqual({ sender: CHIEF, recipient: ASSISTANT });
    expect(ask!.structured).toEqual({ outcome: "ok" } as never); // the route is not part of the outcome
    const [up, you] = await db.turns("orca", "feat/cache");
    expect(up!.route!.sender).toEqual(orcaSide("upkeep"));
    expect(you!.route!.sender).toEqual(PERSON);
  });

  test("the rooms read finds both sides of a pair across chats, and the reports about a worker", async () => {
    await record("@orca", "assistant", "a-ask", agentMessage("chief", "Summarise the inbox"), 100);
    await record("@orca", "assistant", "a-you", "What is new?", 110);
    await record("@orca", "orchestrator", "c-esc", agentMessage("assistant", "Please merge #12"), 120);
    await record("@orca", "orchestrator", "c-mix", joinMessages(["Hello", agentMessage("assistant", "FYI")]), 125);
    await record("@orca", "orchestrator", "c-you", "Hello", 130);
    await record("@orca", "orchestrator", "c-rep", report, 140);
    await record("orca", "feat/cache", "w-brief", "## Objective\nAdd a cache", 90, { origin: turnOrigin({ runId: "c-you", messages: ["Hello"], ids: [], agent: "chief" }) });
    await record("orca", "feat/cache", "w-you", "Fix the typo", 150);

    const show = (es: Awaited<ReturnType<typeof roomEntries>>) => es.map((e) => `${e.id} ${e.kind} ${e.sender.id}>${e.recipient.id}${e.reply ? " +reply" : ""}`);
    expect(show(await roomEntries("@orca", "assistant"))).toEqual([
      "a-ask ask chief>assistant +reply", "c-esc ask assistant>chief +reply", "c-mix ask assistant>chief",
    ]);
    expect(show(await roomEntries("@orca", "orchestrator"))).toEqual(["a-ask ask chief>assistant +reply", "c-esc ask assistant>chief +reply"]);
    const worker = await roomEntries("orca", "feat/cache");
    // The brief stays in the worker's own chat; only the Chief of Staff's side of the report is a room.
    expect(show(worker)).toEqual(["c-rep report orca/feat/cache>chief +reply"]);
    // No wrapper text reaches the view.
    expect(JSON.stringify(await roomEntries("@orca", "assistant"))).not.toContain("[from ");
  });
});
