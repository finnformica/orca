# Agent rooms: agent-to-agent traffic out of your chat

Requested by Finn, 2026-10-27. Revised the same day after the handover from the work Orca, which
built rooms in Flow (`theengineeringco/branch-demo`, PRs #6662, #6697, #6658).

## Problem

A chat mixes two conversations:

- Your messages to an agent, and its replies.
- Messages between agents: `orca ask` (`[from chief] …`), the replies, fired `orca wake --on agent:<name>`
  wakes, orchestrator briefs to a worker (`spawn`, `send`, `address`) and worker reports.

The second kind hides the first. In a named agent's chat, a `[from chief]` message also showed as
your bubble, so the sender was wrong.

## Goal

- Your own messages stay in the main chat.
- Each agent pair has a **room**. The room shows only the traffic between those two agents.
- Every message shows its sender and its recipient. No view shows the `[from …]` wrapper.
- Routing and delivery do not change. Only the record and the view change.

## Learnings applied (from the Flow handover)

1. The room is drawn by the SAME chat transcript (`ChatTurn`), with speaker names. It has no copied
   markup, no composer and no Quote. A pill opens it, and a Back button closes it. Flow's first room
   view had its own markup, and Finn rejected it.
2. A room is a read view over data that exists. There is no migration, and old traffic shows at once.
3. Each turn records its sender and recipient as `{ kind, id }`, so the room query is simple.
4. The wrapper text is stripped in every view. The raw text stays in the turn, for the model only.
5. A room follows the read access of the chats it reads from.
6. A worker chat tags each turn with its source. A brief keeps the person's words as its origin
   quote (#456, `server/origin.ts`).

## Data model

All rules are pure, in `shared/rooms.ts`. Change them there.

### Side

A side is one end of a message: `{ kind, id }`.

| kind | id | Meaning |
| --- | --- | --- |
| `person` | `user` | You. |
| `agent` | `chief`, `assistant`, … | A named agent. |
| `worker` | `<repo>/<branch>` | A workstream's agent. |
| `orca` | `autofix`, `upkeep`, `background`, `reports`, `event`, `wake`, `reflection` | Orca, on its own. |

A chat has one owner side: `agent` for an `@orca` branch, else `worker`.

### Route (recorded)

Each turn records `structured.route = { sender, recipient }`. `db.startTurn` writes it for every write
path, through ONE rule (`turnRoute`). `finishTurn` keeps it beside the outcome, as it keeps `origin`.
It is JSONB in an existing column, so there is no migration.

`turnRoute(recipient, turn)`:

- An explicit `sender` from the caller wins. The upkeep tick passes `orca/upkeep`, because its text
  is the same as the Address PR button's.
- A worker's turn: the origin's agent (`turn.origin.agent`). An origin from before this change has no
  agent, and reads as the Chief of Staff, the only agent that may brief a worker. Then `orca/autofix`
  and `orca/background` by their markers. Else the person.
- An agent's wake: the one sender of all its messages (`[from X]` → agent X, a wake `on agent:X` →
  agent X, `[worker finished] r/b` → worker r/b). Several workers' reports → `orca/reports`. Any word
  of the person's → the person.

A row from before the route (old traffic) has no record. `routeOf` then runs the same rule on its text
and origin, so old turns classify the same way as new ones.

### Room

A room is an unordered pair of sides. Its id is `room:<kind:id>+<kind:id>`, sorted. A room has no
table and no row. It exists when one entry belongs to it.

A turn is in a room when it is in a named agent's chat and its sender is ANOTHER agent (`turnPeer`).
A worker chat keeps ALL its turns in the main chat: a brief, a `send`, an `address`, an autofix, an
upkeep run and a background resume. Each turn names its sender ("Chief of Staff", "Orca · PR upkeep").
The route is still recorded on the turn. (History: #472 sent each brief to the Chief of Staff's room,
so Finn did not see a worker's results in its chat. He asked for them back.)
Worker reports in an agent's chat keep their folded `⚙` block there. The same reports show in each
worker's room, behind a pill in the worker chat.

### Room entry

One entry for each source turn. The view gets nothing else.

```ts
type RoomEntry = {
  id: string;          // the turn's run id
  room: string;
  sender: Side; recipient: Side;
  kind: "ask" | "brief" | "report" | "wake";
  messages: string[];  // the sender's messages, wrapper stripped
  reply?: string;      // the recipient's reply
  startedAt?: number; finishedAt?: number; failed?: boolean; stopped?: boolean;
  chat: Side;          // the chat that recorded it
  origin?: TurnOrigin; originMessages?: OriginMessage[];  // a brief's origin (#456)
};
```

### One room, two chats

A room's turns are in two chats. Example, Chief of Staff and Assistant:

- `[from chief]` asks are turns in the Assistant's chat.
- `[from assistant]` asks are turns in the Chief of Staff's chat.

`GET /api/rooms?repo=&branch=` returns every entry for the chat's owner (`server/rooms.ts`,
`db.roomTurns`, newest 200 of each kind):

- The chat's own turns with `route.sender.kind = 'agent'`. A row with no route matches by its markers.
  For a worker chat these give no entry (`turnRoomEntry`): its briefs stay in its main chat.
- The other `@orca` chats' turns with `route.sender` = the owner, or the owner's needle in the text.
  The needle is `[from <name>] `, or `[worker finished] <repo>/<branch>`. It also finds an ask inside
  a wake that was also yours.

### Visibility

A room is a view of chats you can read. `/api/rooms` reads with the same `user_id` scope as
`/api/turns`, and only the `@orca` chats of that user. It is a database-only route, like `/api/turns`.
Orca has one user today. When it gets more, a person's chats are private to that person, and their
rooms follow (Flow's #6658 rule).

## UI

- **Pill:** in the main chat, at the time the agents talked, "N messages with <Agent pill>", one row in
  the tint of the other activity rows, with the time and a blue dot when it has news. A click opens
  the room at once. N counts the sender's messages and the replies. Adjacent pills of one room merge.
  The pills are placed by time between the turns, by the same pass as notices (`withNotices`).
- **The person's lane:** a pill shows the origin messages its entries carry as your bubbles. In a
  worker chat, the brief is a turn of the main chat, so its origin quote shows above it there.
- **Room:** the pill opens the room in the same pane. One short header row has a Back arrow, this
  chat's agent ⇄ the peer (two Agent pills and a swap arrow) and "read only". The log is the same `ChatTurn` as the chat, with `saidBy` / `replyBy` speaker names. No
  composer, no Quote. A report keeps its folded block, and a brief keeps its origin quote.
- **Source tags:** every turn carries `data-source` (person, agent, worker, orca). A turn that is not
  the person's names its sender over its messages (`Orca · PR upkeep`). Your own words are the only
  unnamed lane.
- **Agent replies:** in a named agent's chat, the agent's Agent pill heads each of its replies. This
  includes the answer to an outside message and to a fired wake. A worker's reply keeps its provider name.
- **Seen:** the last-open time per room is per browser (`orca.ui.v1.roomSeen:<repo>::<branch>`,
  `usePersisted`). A room you never opened counts its last day.
- **No turn is lost:** the main chat leaves out a room turn only when the `/api/rooms` answer holds it,
  or while that answer loads. When the read fails, or the turn is past its bound, the turn stays.

## Limits

- The main chat classifies the loaded page only. `/api/rooms` reads the newest 200 matching turns of
  each kind.
- Old rows classify by text markers. A message that copies a marker by hand goes to a room. Only
  agents write these markers.
- `failTurn` clears `structured`, so a failed wake's route falls back to the rule.
