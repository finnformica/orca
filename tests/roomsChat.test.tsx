// Agent rooms in the chat (docs/design/agent-rooms.md): another agent's message leaves your chat; a pill
// "N messages with <agent>" sits where they happened (directly above the reply, which stays in your
// chat: it is for the person) and opens the room IN THE SAME PANE, drawn by the
// same transcript (ChatTurn) with each side named, read only (no composer, no Quote), with a Back
// button. No `[from …]` wrapper shows anywhere. A worker chat keeps every turn, a brief included,
// and tags each with its source.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";
import type { AgentTurn } from "../shared/agent";
import { agentMessage } from "../shared/agents";
import { scheduledWakeMessage } from "../shared/scheduledWake";
import { chatOwner, orcaSide, turnRoomEntry, workerSide } from "../shared/rooms";
import { joinMessages, turnOrigin } from "../web/src/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  apiFake.reset();
});

const NOW = Date.now();
const t = (id: string, instruction: string, at: number, extra: Partial<AgentTurn> = {}): AgentTurn =>
  ({ id, provider: "claude", instruction, prompt: "", response: `reply ${id}`, startedAt: NOW - at, finishedAt: NOW - at + 5_000, ...extra });

/** The bridge's /api/rooms for a chat, built by the same rules from the fake's turns. */
function serveRooms(repo: string, branch: string, others: { repo: string; branch: string; turns: AgentTurn[] }[] = []) {
  const viewer = chatOwner(repo, branch);
  const own = (apiFake.turnsData.get(`${repo}::${branch}`) ?? []) as AgentTurn[];
  apiFake.roomsData.set(`${repo}::${branch}`, [
    ...own.flatMap((x) => turnRoomEntry(viewer, x, viewer) ?? []),
    ...others.flatMap((o) => o.turns.flatMap((x) => turnRoomEntry(chatOwner(o.repo, o.branch), x, viewer) ?? [])),
  ]);
}

async function mount(row: Row) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<ChatPanel row={row} author="Assistant" />); await flush(); await flush(); await flush(); });
  return container!;
}
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); await flush(); }); };
const runIds = (el: Element) => [...el.querySelectorAll('[data-slot="chat-turn"]')].map((e) => e.getAttribute("data-run-id"));
const assistantRow: Row = { repo: "@orca", hasRemote: false, branch: "assistant", title: "Assistant", prompt: "", lane: "LOCAL", agentProvider: "claude" };

test("the Assistant's chat: a pill where the agents talked opens the room on the same transcript", async () => {
  apiFake.turnsData.set("@orca::assistant", [
    t("you-1", "What is new in #general?", 90_000),
    t("ask-1", agentMessage("chief", "Summarise the inbox for Finn"), 80_000),
    t("mix-1", joinMessages(["Also check Slack", agentMessage("chief", "and the Discord thread")]), 40_000),
  ]);
  // The Assistant escalated once, right after: that turn is in the Chief of Staff's chat.
  serveRooms("@orca", "assistant", [{ repo: "@orca", branch: "orchestrator", turns: [t("esc-1", agentMessage("assistant", "Please merge #12"), 70_000)] }]);
  const c = await mount(assistantRow);

  const log = c.querySelector('[data-slot="chat-log"]')!;
  // The ask's reply stays in your chat (it is for you); the ask itself is behind the pill.
  expect(runIds(log)).toEqual(["you-1", "ask-1", "mix-1"]);
  expect(log.textContent).not.toContain("Summarise the inbox for Finn");
  // Each reply in the Assistant's chat is headed by its Agent pill, never the robot avatar.
  expect([...log.querySelectorAll('[data-slot="chat-reply-head"] > [data-slot="agent-pill"]')].map((e) => `${e.getAttribute("data-agent")}:${e.textContent}`))
    .toEqual(["assistant:Assistant", "assistant:Assistant", "assistant:Assistant"]);
  expect(log.querySelector('[data-slot="chat-reply"] .lucide-bot')).toBeNull();
  // A pill directly above the kept reply (the ask and its reply), then one for the escalation.
  const pills = [...log.querySelectorAll('[data-slot="room-pill"]')];
  expect(pills.map((p) => p.getAttribute("aria-label"))).toEqual(["2 messages with Chief of Staff", "2 messages with Chief of Staff"]);
  // The item: the count, then the Agent pill of the peer; no robot icon; the tint of the other
  // activity rows; a click opens the room at once (no expand step, no aria-expanded).
  expect(pills[0]!.querySelector('[data-slot="room-count"]')!.textContent).toBe("2 messages with");
  expect(pills[0]!.querySelector('[data-slot="agent-pill"]')!.getAttribute("data-agent")).toBe("chief");
  expect(pills[0]!.querySelector('[data-slot="agent-pill"]')!.textContent).toBe("Chief of Staff");
  expect(pills[0]!.querySelector(".lucide-bot")).toBeNull();
  expect(pills[0]!.className).toContain("bg-geist-blue/5");
  expect(pills[0]!.hasAttribute("aria-expanded")).toBe(false);
  expect(pills[0]!.querySelector('[data-slot="room-unseen"]')).toBeTruthy();
  const order = [...log.querySelectorAll('[data-slot="chat-turn"], [data-slot="room-pill"]')].map((e) => e.getAttribute("data-run-id") ?? "pill");
  expect(order).toEqual(["you-1", "pill", "ask-1", "pill", "mix-1"]);
  // The mixed wake: your words in a bubble; the Chief of Staff's as a card with both ends, no wrapper.
  expect([...log.querySelectorAll('[data-slot="chat-user-text"]')].map((e) => e.textContent)).toContain("Also check Slack");
  expect(log.querySelector('[data-slot="agent-ask-route"]')!.textContent).toContain("Chief of Staff → Assistant");
  expect([...log.querySelectorAll('[data-slot="agent-ask-route"] [data-slot="agent-pill"]')].map((e) => e.getAttribute("data-agent"))).toEqual(["chief", "assistant"]);
  expect(log.textContent).not.toContain("[from ");

  await click(pills[0]!);
  // The same pane: the chat log and the composer are hidden, the room is drawn by ChatTurn.
  expect(c.querySelector<HTMLElement>('[data-slot="chat-log"]')!.hidden).toBe(true);
  expect(c.querySelector<HTMLElement>('[data-slot="chat-composer-dock"]')!.hidden).toBe(true);
  // One short header row: Back (an arrow), this chat's agent ⇄ the agent it talks with.
  const title = c.querySelector('[data-slot="room-title"]')!;
  expect(title.getAttribute("aria-label")).toBe("Messages between Assistant and Chief of Staff");
  expect([...title.querySelectorAll('[data-slot="agent-pill"]')].map((e) => e.textContent)).toEqual(["Assistant", "Chief of Staff"]);
  expect(title.querySelector('[data-slot="room-swap"]')).toBeTruthy();
  const back = c.querySelector('[data-slot="room-back"]')!;
  expect(back.getAttribute("aria-label")).toBe("Back");
  expect(back.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // Back is first, at the left
  const room = c.querySelector('[data-slot="room-log"]')!;
  expect(runIds(room)).toEqual(["ask-1", "esc-1"]);
  // Each speaker is the Agent pill.
  expect([...room.querySelectorAll('[data-slot="chat-speaker"] [data-slot="agent-pill"]')].map((e) => e.textContent)).toEqual(["Chief of Staff", "Assistant"]);
  expect([...room.querySelectorAll('[data-slot="chat-reply-head"] > [data-slot="agent-pill"]')].map((e) => e.textContent)).toEqual(["Assistant", "Chief of Staff"]);
  expect(room.querySelector('[data-slot="chat-user-text"]')!.textContent).toBe("Summarise the inbox for Finn");
  expect(room.textContent).not.toContain("[from ");
  expect(room.querySelector('[aria-label="Quote message"]')).toBeNull(); // read only
  // Back: the chat again, and the room is seen (no dot), also on the next mount.
  await click(c.querySelector('[data-slot="room-back"]')!);
  expect(c.querySelector('[data-slot="room-log"]')).toBeNull();
  expect(c.querySelector<HTMLElement>('[data-slot="chat-log"]')!.hidden).toBe(false);
  expect(c.querySelector('[data-slot="room-unseen"]')).toBeNull();
  await act(async () => { root?.unmount(); });
  container?.remove();
  expect((await mount(assistantRow)).querySelector('[data-slot="room-unseen"]')).toBeNull();
});

test("a workstream's chat: the brief, Orca's runs and your words all stay in it, each named by its source", async () => {
  const origin = turnOrigin({ runId: "wake-1", messages: ["add a cache"], ids: [3], agent: "chief" });
  apiFake.turnsData.set("r::feat", [
    t("brief-1", "## Objective\nAdd a cache", 90_000, { origin, originMessages: [{ id: 3, at: NOW - 95_000, text: "add a cache" }] }),
    t("up-1", "Address the PR: conflicts, CI, review", 50_000, { route: { sender: orcaSide("upkeep"), recipient: workerSide("r", "feat") } }),
    t("you-1", "Also fix the typo", 40_000),
  ]);
  const report = ["[worker finished] r/feat \"Feat\" — done", "Response: Added the cache.", "Full turn: orca read --run brief-1"].join("\n");
  serveRooms("r", "feat", [{ repo: "@orca", branch: "orchestrator", turns: [t("wake-2", report, 80_000, { response: "" })] }]);
  const c = await mount({ repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat", agentProvider: "claude" });

  const log = c.querySelector('[data-slot="chat-log"]')!;
  // The brief and the worker's reply to it are in the main chat again (#472 sent them to a room).
  expect(runIds(log)).toEqual(["brief-1", "up-1", "you-1"]);
  expect([...log.querySelectorAll('[data-slot="chat-turn"]')].map((e) => e.getAttribute("data-source"))).toEqual(["agent", "orca", "person"]);
  // Each turn that is not yours names its sender; your own words are the only unnamed lane.
  expect(log.querySelector('[data-run-id="brief-1"] [data-slot="chat-speaker"]')!.textContent).toContain("Chief of Staff");
  expect(log.querySelector('[data-run-id="brief-1"] [data-slot="chat-reply"]')!.textContent).toContain("reply brief-1");
  expect(log.querySelector('[data-run-id="up-1"] [data-slot="chat-speaker"]')!.textContent).toBe("Orca · PR upkeep");
  expect(log.querySelector('[data-run-id="you-1"] [data-slot="chat-speaker"]')).toBeNull();
  // The brief keeps who asked the orchestrator for it.
  expect(log.querySelector('[data-run-id="brief-1"] [data-slot="turn-origin"]')).toBeTruthy();
  // A worker is not a named agent: its reply keeps the provider's name, no Agent pill.
  expect(log.querySelector('[data-run-id="you-1"] [data-slot="chat-reply-head"] [data-slot="agent-pill"]')).toBeNull();
  // The Chief of Staff's side of the report is still its room, behind a pill.
  const pill = log.querySelector('[data-slot="room-pill"]')!;
  expect(pill.getAttribute("aria-label")).toBe("1 message with Chief of Staff");

  await click(pill);
  const room = c.querySelector('[data-slot="room-log"]')!;
  expect(runIds(room)).toEqual(["wake-2"]);
  expect(room.querySelector('[data-run-id="wake-2"] [data-slot="turn-reports"]')).toBeTruthy();
  // A report with no reply draws no reply.
  expect(room.querySelector('[data-run-id="wake-2"] [data-slot="chat-reply"]')).toBeNull();
});

test("a room turn the rooms read did not return stays in your chat, named, with no wrapper", async () => {
  apiFake.turnsData.set("@orca::assistant", [t("ask-1", agentMessage("chief", "Summarise"), 10_000)]);
  const c = await mount(assistantRow);
  expect(c.querySelector('[data-slot="room-pill"]')).toBeNull();
  expect(runIds(c)).toEqual(["ask-1"]);
  expect(c.querySelector('[data-slot="agent-ask-route"]')!.textContent).toContain("Chief of Staff → Assistant");
  expect(c.textContent).not.toContain("[from ");
});

test("the Chief of Staff's chat: a reply it relays from another agent stays in the chat, under its room pill", async () => {
  apiFake.turnsData.set("@orca::orchestrator", [
    t("you-1", "Ask Research why the cache misses", 90_000),
    t("wake-1", scheduledWakeMessage({ id: 273, note: "relay the answer", on: "agent:research", event: "orca.agent.replied" }), 60_000,
      { response: "Research found the cause: the key has no repo. Here is the fix prompt." }),
    t("ask-2", agentMessage("research", "Nothing new"), 40_000, { response: "" }),
    t("ask-3", agentMessage("research", "Retry it"), 30_000, { failed: true }),
  ]);
  serveRooms("@orca", "orchestrator");
  const c = await mount({ repo: "@orca", hasRemote: false, branch: "orchestrator", title: "Chief of Staff", prompt: "", lane: "LOCAL", agentProvider: "claude" });

  const log = c.querySelector('[data-slot="chat-log"]')!;
  // The relayed reply is in the main chat; a turn with no reply and a failed turn stay in the room.
  expect(runIds(log)).toEqual(["you-1", "wake-1"]);
  const order = [...log.querySelectorAll('[data-slot="chat-turn"], [data-slot="room-pill"]')].map((e) => e.getAttribute("data-run-id") ?? e.getAttribute("aria-label"));
  expect(order).toEqual(["you-1", "2 messages with Research", "wake-1", "3 messages with Research"]);
  // The pill directly above the reply, in one block; the reply under the Chief of Staff's Agent pill.
  const kept = log.querySelector('[data-slot="room-reply"]')!;
  expect([...kept.children].map((e) => e.getAttribute("data-slot"))).toEqual(["room-pill-row", "chat-turn"]);
  const reply = kept.querySelector('[data-run-id="wake-1"]')!;
  expect(reply.getAttribute("data-source")).toBe("agent");
  expect(reply.querySelector('[data-slot="chat-reply-head"] > [data-slot="agent-pill"]')!.getAttribute("data-agent")).toBe("chief");
  expect(reply.querySelector('[data-slot="chat-reply"]')!.textContent).toContain("Research found the cause");
  // The wake that carried it is not in the main chat: no wake line, no bubble.
  expect(reply.querySelector('[data-slot="scheduled-wake"]')).toBeNull();
  expect(reply.querySelector('[data-slot="chat-user-text"]')).toBeNull();
  expect(log.textContent).not.toContain("relay the answer");

  // The room still holds the whole entry: the wake and the reply.
  await click(kept.querySelector('[data-slot="room-pill"]')!);
  const room = c.querySelector('[data-slot="room-log"]')!;
  expect(runIds(room)).toEqual(["wake-1", "ask-2", "ask-3"]);
  expect(room.querySelector('[data-run-id="wake-1"]')!.textContent).toContain("relay the answer");
  expect(room.querySelector('[data-run-id="wake-1"] [data-slot="chat-reply"]')!.textContent).toContain("Research found the cause");
});
