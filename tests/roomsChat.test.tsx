// Agent rooms in the chat (docs/design/agent-rooms.md): a turn of agent-to-agent traffic leaves your
// chat for a room tab beside it, with an unread count; each room message names its sender and its
// recipient; an agent's message mixed into your wake is a card, never your bubble; and a turn the
// rooms read did not return stays in your chat.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";
import type { AgentTurn } from "../shared/agent";
import { agentMessage } from "../shared/agents";
import { chatOwner, turnRoomMessages } from "../shared/rooms";
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
const t = (id: string, instruction: string, extra: Partial<AgentTurn> = {}): AgentTurn =>
  ({ id, provider: "claude", instruction, prompt: "", response: `reply ${id}`, startedAt: NOW - 60_000, finishedAt: NOW - 50_000, ...extra });

/** The bridge's /api/rooms for a chat, built by the same rules from the fake's turns. */
function serveRooms(repo: string, branch: string, others: { repo: string; branch: string; turns: AgentTurn[] }[] = []) {
  const viewer = chatOwner(repo, branch);
  const own = (apiFake.turnsData.get(`${repo}::${branch}`) ?? []) as AgentTurn[];
  apiFake.roomsData.set(`${repo}::${branch}`, [
    ...own.flatMap((x) => turnRoomMessages(viewer, x, viewer)),
    ...others.flatMap((o) => o.turns.flatMap((x) => turnRoomMessages(chatOwner(o.repo, o.branch), x, viewer))),
  ]);
}

async function mount(row: Row) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<ChatPanel row={row} author="Assistant" />); await flush(); await flush(); await flush(); });
  return container!;
}
const click = async (el: Element) => {
  await act(async () => {
    // Radix Tabs switch on mousedown (the default activation is on focus + mousedown).
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    (el as HTMLElement).click();
    await flush();
  });
};
const assistantRow: Row = { repo: "@orca", hasRemote: false, branch: "assistant", title: "Assistant", prompt: "", lane: "LOCAL", agentProvider: "claude" };

test("the Assistant's chat: your messages stay, the Chief of Staff's asks go to its room with an unread count", async () => {
  apiFake.turnsData.set("@orca::assistant", [
    t("you-1", "What is new in #general?"),
    t("ask-1", agentMessage("chief", "Summarise the inbox for Finn")),
    t("mix-1", joinMessages(["Also check Slack", agentMessage("chief", "and the Discord thread")])),
  ]);
  // The Assistant escalated once: that turn is in the Chief of Staff's chat.
  serveRooms("@orca", "assistant", [{ repo: "@orca", branch: "orchestrator", turns: [t("esc-1", agentMessage("assistant", "Please merge #12"), { startedAt: NOW - 30_000, finishedAt: NOW - 20_000 })] }]);
  const c = await mount(assistantRow);

  // The main chat: your turn and the mixed one; the pure ask is gone from it.
  const log = c.querySelector('[data-slot="chat-log"]')!;
  expect([...log.querySelectorAll('[data-slot="chat-turn"]')].map((e) => e.getAttribute("data-run-id"))).toEqual(["you-1", "mix-1"]);
  // The mixed wake: your words in a bubble, the Chief of Staff's message as a card with both ends.
  const bubbles = [...log.querySelectorAll('[data-slot="chat-user-text"]')].map((e) => e.textContent);
  expect(bubbles).toContain("Also check Slack");
  expect(bubbles.some((b) => b?.includes("Discord thread"))).toBe(false);
  expect(log.querySelector('[data-slot="agent-ask-route"]')!.textContent).toContain("Chief of Staff → Assistant");

  // The room bar: Chat, then the Chief of Staff's room with 4 unread (ask, reply, escalation, reply).
  const tabs = [...c.querySelectorAll('[data-slot="room-tab"]')];
  expect(tabs.map((e) => e.textContent)).toEqual(["Chat", "Chief of Staff4"]);
  await click(tabs[1]!);

  const room = c.querySelector('[data-slot="room-log"]')!;
  expect(room).toBeTruthy();
  expect(c.querySelector<HTMLElement>('[data-slot="chat-log"]')!.hidden).toBe(true);
  expect([...room.querySelectorAll('[data-slot="room-route"]')].map((e) => e.textContent)).toEqual([
    "Chief of Staff → Assistant", "Assistant → Chief of Staff", "Assistant → Chief of Staff", "Chief of Staff → Assistant",
  ]);
  expect([...room.querySelectorAll('[data-slot="room-message"]')].map((e) => e.getAttribute("data-kind"))).toEqual(["ask", "reply", "ask", "reply"]);
  expect(room.textContent).toContain("Summarise the inbox for Finn");
  expect(room.textContent).not.toContain("[from chief]");
  // Opened: read. Back on Chat, the badge is gone, and it stays gone on the next mount.
  await click(c.querySelector('[data-room="chat"]')!);
  expect(c.querySelector('[data-slot="room-unread"]')).toBeNull();
  await act(async () => { root?.unmount(); });
  container?.remove();
  const again = await mount(assistantRow);
  expect(again.querySelector('[data-slot="room-unread"]')).toBeNull();
});

test("a workstream's chat: the orchestrator's brief and the report go to its room, your follow-up stays", async () => {
  const origin = turnOrigin({ runId: "wake-1", messages: ["add a cache"], ids: [3], agent: "chief" });
  apiFake.turnsData.set("r::feat", [
    t("brief-1", "## Objective\nAdd a cache", { origin, originMessages: [{ id: 3, at: NOW - 70_000, text: "add a cache" }] }),
    t("you-1", "Also fix the typo", { startedAt: NOW - 40_000, finishedAt: NOW - 30_000 }),
  ]);
  const report = ["[worker finished] r/feat \"Feat\" — done", "Response: Added the cache.", "Full turn: orca read --run brief-1"].join("\n");
  serveRooms("r", "feat", [{ repo: "@orca", branch: "orchestrator", turns: [t("wake-2", report, { startedAt: NOW - 45_000, finishedAt: NOW - 44_000, response: "" })] }]);
  const c = await mount({ repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat", agentProvider: "claude" });

  expect([...c.querySelectorAll('[data-slot="chat-log"] [data-slot="chat-turn"]')].map((e) => e.getAttribute("data-run-id"))).toEqual(["you-1"]);
  await click(c.querySelectorAll('[data-slot="room-tab"]')[1]!);
  const room = c.querySelector('[data-slot="room-log"]')!;
  expect([...room.querySelectorAll('[data-slot="room-message"]')].map((e) => `${e.getAttribute("data-kind")}: ${e.querySelector('[data-slot="room-route"]')!.textContent}`)).toEqual([
    "brief: Chief of Staff → Worker feat",
    "reply: Worker feat → Chief of Staff",
    "report: Worker feat → Chief of Staff",
  ]);
  // The brief keeps who asked the orchestrator for it.
  expect(room.querySelector('[data-slot="turn-origin"]')).toBeTruthy();
});

test("a room turn the rooms read did not return stays in your chat", async () => {
  apiFake.turnsData.set("@orca::assistant", [t("ask-1", agentMessage("chief", "Summarise"))]);
  // No rooms answered (an older bridge, or the turn is past the read's bound).
  const c = await mount(assistantRow);
  expect(c.querySelector('[data-slot="room-bar"]')).toBeNull();
  expect(c.querySelector('[data-slot="chat-turn"]')!.getAttribute("data-run-id")).toBe("ask-1");
});
