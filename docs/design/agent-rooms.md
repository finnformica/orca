# Agent rooms: agent-to-agent traffic out of your chat

Requested by Finn, 2026-10-27.

## Problem

A chat mixes two conversations:

- Your messages to an agent, and its replies.
- Messages between agents: `orca ask` (`[from chief] …`), the replies, fired `orca wake --on agent:<name>`
  wakes, orchestrator briefs to a worker (`spawn`, `send`, `address`) and worker reports.

The second kind hides the first. In a named agent's chat, a `[from chief]` message also shows as
your bubble, so the sender is wrong.

## Goal

- Your own messages stay in the main chat.
- Each agent pair has a **room**. The room shows only the traffic between those two agents.
- Every message in a room shows its sender and its recipient.
- Routing and delivery do not change. Only the record and the view change.

## Data model

All rules are pure, in `shared/rooms.ts`. Change them there.

### Party

A party is one end of a message. It is a string:

| Party | Meaning |
| --- | --- |
| `user` | You. |
| `agent:<name>` | A named agent (`chief`, `assistant`, …). |
| `worker:<repo>/<branch>` | A workstream's agent. |

A chat has one owner party: `agent:<name>` for an `@orca` branch, else `worker:<repo>/<branch>`.

### Room

A room is an unordered pair of parties. Its id is `room:<a>+<b>`, with the two parties sorted.
A room has no table and no row. It exists when one message belongs to it.

### Room message

```ts
type RoomMessage = {
  id: string;        // `<runId>:<n>`, stable
  room: string;      // room id
  from: Party;
  to: Party;
  kind: "ask" | "reply" | "brief" | "report" | "wake";
  text: string;
  at?: number;
  runId: string;     // the turn that holds it
  chat: Party;       // the chat that recorded it
};
```

### Where sender and recipient come from

Orca already records enough. No new column and no migration.

1. **Recipient** = the owner of the chat that holds the turn. A wake runs in the recipient's chat.
2. **Sender of a message in a wake** = read off its text:
   - `[from <agent>] …` → `agent:<agent>` (`orca ask`, `shared/agents.ts agentMessage`).
   - `[scheduled wake] … on agent:<x> …` → the reply that `orca wake --on agent:<x>` waited for. The
     sender is `agent:<x>`.
   - `[worker finished] <repo>/<branch> …` → `worker:<repo>/<branch>`.
   - Anything else is yours or Orca's. It stays in the main chat.
3. **Sender of a worker turn** = `turn.origin` (#456). A turn with an origin is an orchestrator brief,
   `send` or `address`. `turn.origin.agent` names the agent. It is new in this change. An older origin
   has no `agent`, and reads as `agent:chief`, the only agent that may brief a worker.
4. **The reply** to a room turn is the turn's response, from the owner back to the sender.

### Classification of a turn (`turnRoom`)

A turn goes to a room only when **every** message in it belongs to the SAME peer:

- A named agent's turn whose messages are all `[from X]` or wakes `on agent:X` → room with `agent:X`.
- A worker's turn with `origin` → room with the briefing agent.
- Any other turn (yours, a mix, a worker report wake, an Orca event, unknown) stays in the main chat.

A mixed turn stays in the main chat. Its agent messages show with a sender line ("Chief of Staff →
Assistant"), never as your bubble.

Worker report wakes in an agent's own chat keep their folded `⚙` block in the main chat. The same
reports also show in each worker's room (below). A room for each worker in the Chief of Staff's chat
gives too many tabs.

### Old messages

Nothing is rewritten. The rules above read the stored text and `structured.origin`, so old turns
classify the same way as new turns. A turn that matches no rule stays in the main chat.

### One room, two chats

A room's messages are recorded in two chats. Example, Chief of Staff and Assistant:

- `[from chief]` asks are turns in the Assistant's chat.
- `[from assistant]` asks are turns in the Chief of Staff's chat.

`GET /api/rooms?repo=&branch=` returns every room message for the chat's owner, from its own chat
and from the `@orca` chats (database-only, newest 200 turns that match). For a worker, the other
chat is the agent chat that got its `[worker finished]` reports. Each report links to one run
(`Full turn: orca read --run <id>`).

## UI

- A room bar above the chat log: **Chat**, then one tab for each room ("Chief of Staff", "Orchestrator").
  It shows only when the chat has a room. It uses the shadcn `Tabs`.
- Each room tab has an unread count: the room messages newer than the last time you opened that
  tab. The last-open time is per browser (`orca.ui.v1.roomSeen:<chat>`, `persistedAtom`). A room
  you never opened counts the messages of the last day.
- A room view lists its messages oldest first. Each has a head line: sender → recipient, kind and time.
  The body is markdown. A report and a long reply fold behind Show more.
- A room is read only. The composer stays, and a send goes to the main chat and switches back to it.
- The main chat leaves out every turn that went to a room. A placeholder line says how many are in rooms.

## Limits

- The main chat classifies the loaded page only. `/api/rooms` reads the newest 200 matching turns.
- The rules read text markers. A message that copies a marker by hand goes to a room. Only agents
  write these markers.

## To adjust

The other Orca's handover may differ. Change these in `shared/rooms.ts` only: the party names,
the room id and the rules. The UI reads `RoomMessage` and the room list, nothing else.
