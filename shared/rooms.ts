// Agent rooms (docs/design/agent-rooms.md): the traffic between two agents, kept out of your chat.
// Pure rules only — the server read is server/rooms.ts, the view is web/src/views/Chat.tsx.
//
// Every turn records who sent it and to whom (`structured.route`, written by db.startTurn through
// `turnRoute`). A turn from another agent is in the room of that pair. Nothing else is stored: a
// row from before the route (old traffic) goes through the SAME rule at read time, off the
// `[from <agent>]` / `[scheduled wake] … on agent:<x>` / `[worker finished] <repo>/<branch>` markers
// and the turn's `origin` (#456). A turn that matches no rule is the person's: the main chat.
import type { OriginMessage, TurnOrigin } from "./agent";
import { isAutofix, isBackgroundResume } from "./agent";
import { AGENTS_REPO, CHIEF, FALLBACK_CHIEF, agentMessageFrom, agentOfBranch, isAgentMessage } from "./agents";
import { isScheduledWake, parseScheduledWake } from "./scheduledWake";
import { isReflection } from "./memory";
import { isOrcaEvent } from "./integrations";
import { MESSAGE_BREAK, WORKER_EVENT_MARKER, isWorkerEvent, promptInstruction, splitMessages } from "../web/src/workstream";

/** One end of a message. `id`: "user" for the person, an agent's name, a worker's `<repo>/<branch>`,
 *  or what Orca did on its own ("autofix", "upkeep", "event", …). */
export type SideKind = "person" | "agent" | "worker" | "orca";
export type Side = { kind: SideKind; id: string };
/** Who sent a turn, and whose chat it is in. Stored in `turn.structured.route`. */
export type TurnRoute = { sender: Side; recipient: Side };

export const PERSON: Side = { kind: "person", id: "user" };
export const agentSide = (name: string): Side => ({ kind: "agent", id: name });
export const workerSide = (repo: string, branch: string): Side => ({ kind: "worker", id: `${repo}/${branch}` });
export const orcaSide = (what: string): Side => ({ kind: "orca", id: what });
export const sameSide = (a: Side, b: Side): boolean => a.kind === b.kind && a.id === b.id;
export const sideKey = (s: Side): string => `${s.kind}:${s.id}`;
/** The side a chat belongs to: an `@orca` branch is a named agent, any other branch a worker. */
export const chatOwner = (repo: string, branch: string): Side =>
  repo === AGENTS_REPO ? agentSide(agentOfBranch(branch)) : workerSide(repo, branch);

/** A room is an unordered pair: the same id from either end. */
export const roomId = (a: Side, b: Side): string => `room:${[sideKey(a), sideKey(b)].sort().join("+")}`;

const messagesIn = (instruction: string): string[] => splitMessages(instruction);
const instructionOf = (t: { instruction?: string; prompt?: string }): string => t.instruction ?? promptInstruction(t.prompt ?? "");

/** `[worker finished] <repo>/<branch> ["title"] — <status>` → the worker. A repo name has no slash;
 *  a branch may. */
export function reportWorker(text: string): Side | undefined {
  if (!isWorkerEvent(text)) return undefined;
  const head = text.split("\n")[0]!.slice(WORKER_EVENT_MARKER.length).trim();
  const m = head.match(/^([^/\s]+)\/(\S+?)(?= "| — |$)/);
  return m ? workerSide(m[1]!, m[2]!) : undefined;
}

export type RoomKind = "ask" | "reply" | "brief" | "report" | "wake";

/** Who sent one message of an agent's wake, and what kind it is. Undefined: the person's words. */
export function messageSender(text: string): { sender: Side; kind: RoomKind | "event" } | undefined {
  const from = agentMessageFrom(text);
  if (from) return { sender: agentSide(from), kind: "ask" };
  if (isScheduledWake(text)) {
    const on = parseScheduledWake(text)?.on?.trim();
    return on?.startsWith("agent:") ? { sender: agentSide(on.slice("agent:".length)), kind: "wake" } : { sender: orcaSide("wake"), kind: "event" };
  }
  const worker = reportWorker(text);
  if (worker) return { sender: worker, kind: "report" };
  if (isReflection(text)) return { sender: orcaSide("reflection"), kind: "event" };
  if (isOrcaEvent(text)) return { sender: orcaSide("event"), kind: "event" };
  return undefined;
}

/** THE rule: who sent a turn in `recipient`'s chat. `sender` is an explicit record from the caller
 *  (the upkeep tick); otherwise it is read off the turn.
 *  - A worker's turn: its origin's agent (an orchestrator brief, `send` or `address`; an older
 *    origin has no agent and is the Chief of Staff's, the only agent that may brief); Orca for an
 *    autofix or a background resume; else the person.
 *  - An agent's wake: the one sender of all its messages; several workers' reports are Orca's; any
 *    word of the person's makes it the person's. */
export function turnRoute(recipient: Side, t: { instruction?: string; prompt?: string; origin?: TurnOrigin; sender?: Side }): TurnRoute {
  const text = instructionOf(t);
  if (t.sender) return { sender: t.sender, recipient };
  if (recipient.kind !== "agent") {
    if (t.origin) return { sender: agentSide(t.origin.agent ?? CHIEF), recipient };
    if (isAutofix(text)) return { sender: orcaSide("autofix"), recipient };
    if (isBackgroundResume(text)) return { sender: orcaSide("background"), recipient };
    return { sender: PERSON, recipient };
  }
  const senders = messagesIn(text).map((m) => messageSender(m)?.sender);
  if (!senders.length || senders.some((s) => !s)) return { sender: PERSON, recipient };
  const first = senders[0]!;
  if (senders.every((s) => sameSide(s!, first))) return { sender: first, recipient };
  return { sender: senders.every((s) => s!.kind === "worker" || s!.kind === "orca") ? orcaSide("reports") : PERSON, recipient };
}

/** The route of a loaded turn: the recorded one, else the rule (a row from before the record). */
export const routeOf = (owner: Side, t: { instruction?: string; prompt?: string; origin?: TurnOrigin; route?: TurnRoute }): TurnRoute =>
  t.route ?? turnRoute(owner, t);

/** The room a turn of `owner`'s chat goes to — the other agent — or undefined for the main chat.
 *  Only a named agent's chat sends turns to rooms. A worker chat keeps every turn (a brief, a `send`,
 *  an `address`), named by its sender: there the person reads the work at a glance (Finn, after #472).
 *  Worker reports keep their folded block in an agent's chat; each shows in that worker's room too. */
export function turnPeer(owner: Side, t: { instruction?: string; prompt?: string; origin?: TurnOrigin; route?: TurnRoute }): Side | undefined {
  if (owner.kind !== "agent") return undefined;
  const { sender } = routeOf(owner, t);
  return sender.kind === "agent" && !sameSide(sender, owner) ? sender : undefined;
}
export const inMainChat = (owner: Side, t: Parameters<typeof turnPeer>[1]): boolean => !turnPeer(owner, t);

/** The wrapper Orca puts on an agent's message for the model (`[from chief] …`): never shown. The
 *  raw text stays in the turn, for the model only. */
export const stripAgentWrapper = (text: string): string => text.replace(/^\[from [a-z][a-z0-9-]*\] /, "");

/** One turn of a room, as the chat transcript draws it: the sender's messages (wrapper stripped),
 *  then the recipient's reply. Both ends are explicit. */
export type RoomEntry = {
  id: string; room: string; sender: Side; recipient: Side; kind: RoomKind;
  messages: string[]; reply?: string;
  startedAt?: number; finishedAt?: number; failed?: boolean; stopped?: boolean;
  /** The chat that recorded it. */
  chat: Side;
  /** A brief's origin: the wake and the person's words that caused it (server-joined, #456). */
  origin?: TurnOrigin; originMessages?: OriginMessage[];
};

/** The fields of a turn the rules read (an AgentTurn fits). */
export type RoomTurn = {
  id: string; instruction?: string; prompt?: string; response?: string;
  startedAt?: number; finishedAt?: number; failed?: boolean; stopped?: boolean;
  origin?: TurnOrigin; originMessages?: OriginMessage[]; route?: TurnRoute;
};

/** The room entry a turn holds for `viewer`, or undefined. `chat` is the chat that recorded it: the
 *  viewer's own (a turn another agent sent it), or another agent's (the viewer's asks there, or
 *  reports about the viewer). There the reply is the viewer's only when the turn held nothing else. */
export function turnRoomEntry(chat: Side, t: RoomTurn, viewer: Side): RoomEntry | undefined {
  const base = {
    id: t.id, chat,
    ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}), ...(t.finishedAt !== undefined ? { finishedAt: t.finishedAt } : {}),
    ...(t.failed ? { failed: true } : {}), ...(t.stopped ? { stopped: true } : {}),
  };
  const reply = t.finishedAt && t.response?.trim() ? { reply: t.response } : {};
  if (sameSide(chat, viewer)) {
    const peer = turnPeer(chat, t);
    if (!peer) return undefined;
    const msgs = messagesIn(instructionOf(t));
    const kind = (messageSender(msgs[0]!)?.kind ?? "ask") as RoomKind;
    return { ...base, room: roomId(peer, chat), sender: peer, recipient: chat, kind, messages: msgs.map(stripAgentWrapper), ...reply };
  }
  const msgs = messagesIn(instructionOf(t));
  const mine = msgs.map((m) => ({ m, s: messageSender(m) })).filter((x) => x.s && sameSide(x.s.sender, viewer));
  if (!mine.length) return undefined;
  return {
    ...base, room: roomId(viewer, chat), sender: viewer, recipient: chat, kind: mine[0]!.s!.kind as RoomKind,
    messages: mine.map((x) => stripAgentWrapper(x.m)), ...(mine.length === msgs.length ? reply : {}),
  };
}

export type Room = { id: string; peer: Side; entries: RoomEntry[]; lastAt: number };

/** `viewer`'s rooms: one per other agent, entries oldest first (one per turn id), newest room first. */
export function roomsOf(viewer: Side, entries: RoomEntry[]): Room[] {
  const byRoom = new Map<string, Room>();
  const seen = new Set<string>();
  for (const e of [...entries].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const peer = sameSide(e.sender, viewer) ? e.recipient : e.sender;
    const room = byRoom.get(e.room) ?? { id: e.room, peer, entries: [], lastAt: 0 };
    room.entries.push(e);
    room.lastAt = Math.max(room.lastAt, e.finishedAt ?? e.startedAt ?? 0);
    byRoom.set(e.room, room);
  }
  return [...byRoom.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** How many messages an entry holds: the sender's, and the reply. */
export const entryCount = (e: Pick<RoomEntry, "messages" | "reply">): number => e.messages.length + (e.reply ? 1 : 0);

/** A pill in the main chat: "N messages with <agent>", where a run of one room's traffic sits. */
export type RoomPill = { id: string; at: number; room: string; peer: Side; count: number; lastAt: number;
  /** The person's own words that a brief in this run carried (its origin): shown in the person's lane. */
  person: OriginMessage[] };

/** One pill per room entry, at its time (the chat places them between its turns, like notices). */
export const entryPill = (viewer: Side, e: RoomEntry): RoomPill => ({
  id: `pill:${e.id}`, at: e.startedAt ?? 0, room: e.room, peer: sameSide(e.sender, viewer) ? e.recipient : e.sender,
  count: entryCount(e), lastAt: e.finishedAt ?? e.startedAt ?? 0, person: (e.originMessages ?? []).filter((m) => !m.missing && m.text),
});

/** Adjacent pills of one room become one: a run of agent traffic with nothing of yours between. */
export function mergePills<T>(items: T[], pillOf: (item: T) => RoomPill | undefined, make: (p: RoomPill) => T): T[] {
  const out: T[] = [];
  for (const item of items) {
    const p = pillOf(item), last = out.length ? pillOf(out[out.length - 1]!) : undefined;
    if (p && last && last.room === p.room) {
      out[out.length - 1] = make({ ...last, count: last.count + p.count, lastAt: Math.max(last.lastAt, p.lastAt), person: [...last.person, ...p.person] });
    } else out.push(item);
  }
  return out;
}

export const UNREAD_DEFAULT_MS = 24 * 3600_000;
/** Something in the room is newer than your last visit; a room never opened counts its last day. */
export const roomUnseen = (lastAt: number, seenAt: number | undefined, now = Date.now()): boolean =>
  lastAt > (seenAt ?? now - UNREAD_DEFAULT_MS);

/** The agents' display names, from their rows: the web sets them each time it reads the agents list
 *  (api.ts `orchestratorAgents`). Until then only the Chief of Staff's fallback name is known. */
const AGENT_NAMES: Record<string, string> = { [CHIEF]: FALLBACK_CHIEF.displayName };
export function rememberAgentNames(agents: { agent?: string; name?: string; displayName?: string }[]): void {
  for (const a of agents) { const n = a.agent ?? a.name; if (n && a.displayName) AGENT_NAMES[n] = a.displayName; }
}
const ORCA_NAMES: Record<string, string> = { autofix: "Orca · check failed", upkeep: "Orca · PR upkeep", background: "Orca · background tasks", reports: "Orca · worker reports" };

/** A side as the chat names it. `names` adds agents the user made (`orca agent add`). */
export function sideLabel(s: Side, names: Record<string, string> = {}): string {
  if (s.kind === "person") return "You";
  // An agent the web has not read yet: its name with a capital first letter ("assistant" → "Assistant").
  if (s.kind === "agent") return names[s.id] ?? AGENT_NAMES[s.id] ?? `${s.id.charAt(0).toUpperCase()}${s.id.slice(1)}`;
  if (s.kind === "worker") return `Worker ${s.id.replace(/^[^/]+\//, "")}`;
  return ORCA_NAMES[s.id] ?? "Orca";
}

/** "Chief of Staff → Assistant": an agent message in your chat says both ends. */
export const routeLabel = (from: Side, to: Side, names?: Record<string, string>): string =>
  `${sideLabel(from, names)} → ${sideLabel(to, names)}`;

/** The agent messages of a mixed wake in your chat (they stay there, never as your bubble). */
export const agentMessagesIn = (messages: string[]): string[] => messages.filter(isAgentMessage);

/** An entry as a turn of the shared chat transcript (ChatTurn), with its speakers. */
export const entryTurn = (e: RoomEntry) => ({
  id: e.id, provider: "claude" as const, prompt: "", instruction: e.messages.join(MESSAGE_BREAK), response: e.reply ?? "",
  ...(e.startedAt !== undefined ? { startedAt: e.startedAt } : {}), ...(e.finishedAt !== undefined ? { finishedAt: e.finishedAt } : {}),
  ...(e.failed ? { failed: true } : {}), ...(e.stopped ? { stopped: true } : {}),
  ...(e.origin ? { origin: e.origin, originMessages: e.originMessages ?? e.origin.messageIds.map((id) => ({ id, missing: true as const })) } : {}),
});

/** Who queued a workstream message: its recorded sender (`orca send` names its agent), else
 *  `turnRoute`'s rule for the turn it becomes (an origin's agent, Orca for an autofix or a background
 *  resume, else the person). So `orca send --replace` and `orca queue cancel` never take a message
 *  the person typed, or another agent's, as the caller's own. */
export const queuedSender = (m: { repo: string; branch: string; instruction: string; origin?: TurnOrigin; sender?: Side }): Side =>
  turnRoute(workerSide(m.repo, m.branch), { instruction: m.instruction, origin: m.origin, sender: m.sender }).sender;

/** A queued message's sender as an agent reads it in `orca queue`; `me` is the caller. */
export function queuedSenderText(s: Side, me?: Side): string {
  const self = me && sameSide(s, me) ? " (you)" : "";
  if (s.kind === "person") return "the user";
  if (s.kind === "agent") return `agent ${s.id}${self}`;
  if (s.kind === "worker") return `worker ${s.id}`;
  return `Orca (${s.id})`;
}

/** `orca queue`'s answer: one line per undispatched message, oldest first (the order they are sent
 *  in): id, queued time (UTC), sender and the first line of the text. Pure. */
export function queueListText(at: string, rows: { id: number; createdAt: number; repo: string; branch: string; instruction: string; origin?: TurnOrigin; sender?: Side }[], me?: Side): string {
  if (!rows.length) return `Nothing is queued for ${at}.`;
  const line = (m: (typeof rows)[number]): string => {
    const when = new Date(m.createdAt).toISOString().slice(0, 16).replace("T", " ");
    const first = m.instruction.trim().split("\n")[0]!.trim();
    return `  #${m.id}  ${when} UTC  ${queuedSenderText(queuedSender(m), me)}  ${first.length > 100 ? `${first.slice(0, 99)}…` : first}`;
  };
  return [`Queued for ${at}, oldest first (each is sent in turn when the run in flight ends):`, ...rows.map(line)].join("\n");
}
