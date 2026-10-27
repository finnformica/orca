// Agent rooms (docs/design/agent-rooms.md): the traffic between two agents, kept out of your chat.
// Pure rules only — the server read is server/rooms.ts, the view is web/src/views/Chat.tsx.
//
// Nothing here is stored. A room message is read off what Orca already records: the chat that holds
// a turn (the recipient), the `[from <agent>]` / `[scheduled wake] … on agent:<x>` /
// `[worker finished] <repo>/<branch>` markers of a wake's messages (the sender), and a worker turn's
// `origin` (an orchestrator brief). An old turn classifies the same way; one that matches no rule
// stays in the main chat.
import type { OriginMessage, TurnOrigin } from "./agent";
import { AGENTS_REPO, BUILTIN_AGENTS, CHIEF, agentMessageFrom, agentOfBranch, isAgentMessage } from "./agents";
import { isScheduledWake, parseScheduledWake } from "./scheduledWake";
import { WORKER_EVENT_MARKER, isWorkerEvent, promptInstruction, splitMessages } from "../web/src/workstream";

/** One end of a message: you, a named agent, or a workstream's agent. */
export type Party = "user" | `agent:${string}` | `worker:${string}`;
export const agentParty = (name: string): Party => `agent:${name}`;
export const workerParty = (repo: string, branch: string): Party => `worker:${repo}/${branch}`;
/** The party a chat belongs to: an `@orca` branch is a named agent, any other branch a worker. */
export const chatOwner = (repo: string, branch: string): Party =>
  repo === AGENTS_REPO ? agentParty(agentOfBranch(branch)) : workerParty(repo, branch);
const isAgentParty = (p: Party): boolean => p.startsWith("agent:");

/** A room is an unordered pair: the same id from either end. */
export const roomId = (a: Party, b: Party): string => `room:${[a, b].sort().join("+")}`;

export type RoomKind = "ask" | "reply" | "brief" | "report" | "wake";
export type RoomMessage = {
  id: string; room: string; from: Party; to: Party; kind: RoomKind; text: string;
  at?: number; runId: string; chat: Party;
  /** A brief's origin: the wake and the person's words that caused it (server-joined, #456). */
  origin?: TurnOrigin; originMessages?: OriginMessage[];
};

/** The fields of a turn the rules read (an AgentTurn fits). */
export type RoomTurn = {
  id: string; instruction?: string; prompt?: string; response?: string;
  startedAt?: number; finishedAt?: number; origin?: TurnOrigin; originMessages?: OriginMessage[];
};

const messagesOf = (t: RoomTurn): string[] => splitMessages(t.instruction ?? promptInstruction(t.prompt ?? ""));

/** `[worker finished] <repo>/<branch> ["title"] — <status>` → the worker. A repo name has no slash;
 *  a branch may. */
export function reportWorker(text: string): Party | undefined {
  if (!isWorkerEvent(text)) return undefined;
  const head = text.split("\n")[0]!.slice(WORKER_EVENT_MARKER.length).trim();
  const m = head.match(/^([^/\s]+)\/(\S+?)(?= "| — |$)/);
  return m ? workerParty(m[1]!, m[2]!) : undefined;
}

/** Who sent one message of a wake, and what kind it is. Undefined: yours, Orca's or unknown — the
 *  main chat's. */
export function messageSender(text: string): { from: Party; kind: RoomKind } | undefined {
  const from = agentMessageFrom(text);
  if (from) return { from: agentParty(from), kind: "ask" };
  if (isScheduledWake(text)) {
    const on = parseScheduledWake(text)?.on?.trim();
    return on?.startsWith("agent:") ? { from: agentParty(on.slice("agent:".length)), kind: "wake" } : undefined;
  }
  const worker = reportWorker(text);
  return worker ? { from: worker, kind: "report" } : undefined;
}

/** The room a turn of `owner`'s chat goes to — its peer — or undefined for the main chat. Only when
 *  EVERY message of it is from one other agent: a mix with your words stays yours. Worker reports in
 *  an agent's chat keep their folded block there (each also shows in that worker's room). */
export function turnPeer(owner: Party, t: RoomTurn): Party | undefined {
  if (!isAgentParty(owner)) return t.origin ? agentParty(t.origin.agent ?? CHIEF) : undefined;
  const senders = messagesOf(t).map((m) => (isWorkerEvent(m) ? undefined : messageSender(m)?.from));
  const peer = senders[0];
  return peer && peer !== owner && senders.every((s) => s === peer) ? peer : undefined;
}

/** Does the main chat show this turn? */
export const inMainChat = (owner: Party, t: RoomTurn): boolean => !turnPeer(owner, t);

const ASK_PREFIX = /^\[from [a-z][a-z0-9-]*\] /;

/** The room messages a turn holds for `viewer`'s rooms. `chat` is the chat that recorded the turn:
 *  the viewer's own, or another agent's (an ask the viewer sent there, a report about the viewer). */
export function turnRoomMessages(chat: Party, t: RoomTurn, viewer: Party): RoomMessage[] {
  const out: RoomMessage[] = [];
  const add = (from: Party, to: Party, kind: RoomKind, text: string, n: string | number, at = t.startedAt) =>
    out.push({
      id: `${t.id}:${n}`, room: roomId(from, to), from, to, kind, text, ...(at !== undefined ? { at } : {}), runId: t.id, chat,
      ...(kind === "brief" && t.origin ? { origin: t.origin, ...(t.originMessages ? { originMessages: t.originMessages } : {}) } : {}),
    });
  const peer = turnPeer(chat, t);
  if (chat === viewer) {
    if (!peer) return out;
    if (!isAgentParty(chat)) add(peer, chat, "brief", t.instruction ?? promptInstruction(t.prompt ?? ""), 0);
    else messagesOf(t).forEach((m, i) => add(peer, chat, messageSender(m)!.kind, m.replace(ASK_PREFIX, ""), i));
  } else {
    // Another chat: only the messages from the viewer there (an ask, a report about it, a wake on
    // its reply). The reply is the viewer's only when the turn held nothing else.
    const msgs = messagesOf(t);
    msgs.forEach((m, i) => {
      const s = messageSender(m);
      if (s?.from === viewer) add(viewer, chat, s.kind, m.replace(ASK_PREFIX, ""), i);
    });
    if (!msgs.length || !msgs.every((m) => messageSender(m)?.from === viewer)) return out;
  }
  if (t.finishedAt && t.response?.trim()) add(chat, chat === viewer ? peer! : viewer, "reply", t.response, "reply", t.finishedAt);
  return out;
}

export type Room = { id: string; peer: Party; messages: RoomMessage[]; lastAt: number };

/** `viewer`'s rooms from its room messages: one per peer, messages oldest first (a message seen
 *  twice by id once), the room with the newest message first. */
export function roomsOf(viewer: Party, messages: RoomMessage[]): Room[] {
  const byRoom = new Map<string, Room>();
  const seen = new Set<string>();
  for (const m of [...messages].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
    if (seen.has(m.id) || (m.from !== viewer && m.to !== viewer)) continue;
    seen.add(m.id);
    const peer = m.from === viewer ? m.to : m.from;
    const room = byRoom.get(m.room) ?? { id: m.room, peer, messages: [], lastAt: 0 };
    room.messages.push(m);
    room.lastAt = Math.max(room.lastAt, m.at ?? 0);
    byRoom.set(m.room, room);
  }
  return [...byRoom.values()].sort((a, b) => b.lastAt - a.lastAt);
}

export const UNREAD_DEFAULT_MS = 24 * 3600_000;
/** Messages newer than the last time you opened the room; a room never opened counts its last day. */
export const roomUnread = (room: Pick<Room, "messages">, seenAt: number | undefined, now = Date.now()): number =>
  room.messages.filter((m) => (m.at ?? 0) > (seenAt ?? now - UNREAD_DEFAULT_MS)).length;

const AGENT_NAMES: Record<string, string> = Object.fromEntries(BUILTIN_AGENTS.map((a) => [a.name, a.displayName]));

/** A party as the chat names it. `names` adds agents the user made (`orca agent add`). */
export function partyLabel(p: Party, names: Record<string, string> = {}): string {
  if (p === "user") return "You";
  if (p.startsWith("agent:")) { const n = p.slice("agent:".length); return names[n] ?? AGENT_NAMES[n] ?? n; }
  return `Worker ${p.slice("worker:".length).replace(/^[^/]+\//, "")}`;
}

/** "Chief of Staff → Assistant": every room message, and every agent message in your chat, says both ends. */
export const routeLabel = (from: Party, to: Party, names?: Record<string, string>): string =>
  `${partyLabel(from, names)} → ${partyLabel(to, names)}`;

/** The agent messages of a mixed turn in your chat (they stay there, never as your bubble). */
export const agentMessagesIn = (messages: string[]): string[] => messages.filter(isAgentMessage);
