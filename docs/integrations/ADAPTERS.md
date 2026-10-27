# How to write an Orca adapter

This guide is for the branches that stack on the integrations core: Slack two-way, Discord, email,
the Settings page, the GitHub poller, Linear and Cloudflare. The design is
[docs/research/integrations.md](../research/integrations.md) section 3. Read this guide first. Do not
change the core to add an adapter. If an adapter needs a core change, change the core in its own
commit and update this guide.

## 1. What the core does, and what an adapter does

The core does these tasks. An adapter never does them:

- It removes duplicate events (`event.key` is unique).
- It checks the sender against the link and the person (the gate).
- It records the event and plans the deliveries in one transaction.
- It retries a failed send with backoff and marks the delivery dead after 6 attempts.
- It stores thread links and passes the thread back to the adapter.
- It paces outbound sends per target (from `caps.rate`) and inbound messages per sender.
- It starts the adapter on one primary bridge only. Section 6.1 tells which one.
- It applies the account policy: what Orca may do with the account (`access`) and what its events
  do (`events`). Section 13 and [POLICY.md](POLICY.md) tell how.

An adapter does only these tasks:

- It talks to one platform (a socket, a poll loop, or an HTTP route).
- It turns each platform event into an envelope and calls `ctx.ingest`.
- It sends one message in `send` and returns a `SendResult`.
- It declares the class (read or write) of each `orca <kind>` CLI verb it has (section 13).

## 2. Files

| File | Content |
|---|---|
| `shared/integrations.ts` | The envelope, topics, grants, `Capabilities`, `Target`, `OutboundMessage`, `SendResult`, `InboundMessage`, `ConversationRef`, and the pure decisions. |
| `server/integrations/adapter.ts` | The `Adapter` interface, `AdapterContext`, `Connection`, `AdapterFactory`. |
| `server/integrations/registry.ts` | `register(kind, factory, meta)`, `registerVerbs()`, `verbsFor()`, `sync()`, `handle()`, `health()`. |
| `server/integrations/policy.ts` | `useAccount(kind, verb, account)`: the CLI door of the account policy (section 13). |
| `server/integrations/router.ts` | `ingest` (the gate) and `publish`. |
| `server/integrations/dispatcher.ts` | The delivery loop. |
| `server/integrations/inbox.ts` | The orchestrator and workstream targets. |
| `server/integrations/store.ts` | All SQL. |
| `server/integrations/adapters/` | `web.ts`, `webhook.ts`, `slack.ts` (setup: [slack.md](slack.md)), `gmail.ts` (setup: [gmail.md](gmail.md)), `granola.ts` (setup: [granola.md](granola.md)). Put a new adapter here. |

## 3. The interface

This is the exact contract (`server/integrations/adapter.ts`):

```ts
export type Connection = {
  id: string;
  kind: AdapterKind;            // "slack" | "discord" | "gmail" | "github" | "linear" | "cloudflare" | "webhook" | "web" | string
  name: string;
  instance: string;             // the ONE instance that runs it, or "*" (Automatic)
  auto?: AutoLease;             // Automatic only: the lease holder and its end time
  config: Record<string, unknown>; // non-secret settings
  secretRef?: string;           // an environment variable NAME, never a value
  enabled: boolean;
  access?: "read" | "read-write";          // the account policy (section 13); the core enforces it
  events?: "trigger" | "record" | "off";
};

export type AdapterContext = {
  connection: Connection;
  secret(): string | undefined;
  ingest(e: InboundEnvelope): Promise<"new" | "noted" | "duplicate" | "rejected">; // noted: recorded, no agent answers
  cursor: { get(): Promise<string | undefined>; set(v: string): Promise<void> };
  status(s: { ok: boolean; detail?: string; lastEventAt?: number }): Promise<void>;
  log(msg: string): void;
  signal: AbortSignal;          // aborted at stop
};

export interface Adapter {
  readonly kind: AdapterKind;
  readonly caps: Capabilities;
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  send(target: Target, msg: OutboundMessage, idempotencyKey: string): Promise<SendResult>;
  health(): Promise<{ ok: boolean; detail?: string; lastEventAt?: number }>;
  resolveUser?(externalId: string): Promise<{ id: string; name: string } | undefined>;
  handle?(req: Request, body: string): Promise<Response>;
}

export type AdapterFactory = (connection: Connection) => Adapter;
```

The data shapes (`shared/integrations.ts`):

```ts
export type Capabilities = {
  inbound: "socket" | "poll" | "relay" | "none";
  outbound: boolean;
  threads: boolean; edits: boolean; reactions: boolean;
  attachments: boolean;                                    // outbound files (msg.attachments)
  maxAttachments?: number; maxAttachmentBytes?: number;    // the platform's file limits
  maxTextLength: number;
  deletes?: boolean;                                       // Adapter.delete (orca post --delete)
  rate?: { perTarget: number; windowMs: number };
};

export type Target = { linkId?: string; externalId: string; threadId?: string; messageId?: string };

export type OutboundMessage = {
  text: string; title?: string; url?: string; topic?: Topic;
  replyToExternalMsgId?: string; references?: string[];   // email threading
  edit?: boolean;                                          // replace Target.messageId
  attachments?: string[];                                  // orca-attachment://<id>/<name> refs
};

export type SendResult =
  | { ok: true; externalMsgId?: string; threadId?: string }
  | { ok: false; retryable: boolean; retryAfterMs?: number; error: string };

export type ConversationRef = { adapter: string; externalId: string; messageId?: string };

export type InboundMessage = {
  adapter: string; integrationId?: string; channel?: string;
  eventId: string; from: { adapter: string; id: string; name?: string };
  text: string; thread?: ConversationRef; mentioned?: boolean;
  attachments?: string[]; at?: number; raw?: unknown;
};
```

`inboundEnvelope(m: InboundMessage)` turns a chat or email message into the envelope. Its key is
`<adapter>:<eventId>` and its topic is `ext.<adapter>.message`.

## 4. Rules for each method

### `start(ctx)`

- The registry calls it only on the one primary bridge that runs the row (section 6.1). Do not
  check this again.
- Resolve when the adapter is ready. Do not hold the promise open for the life of a socket.
- Keep a socket or a poll loop alive until `ctx.signal` aborts.
- Reconnect on your own after a drop. Call `ctx.status({ ok: false, detail })` while you are down.
- Read the token with `ctx.secret()`. Never log it. Never put it in an envelope or in `raw`.
- Throw if the adapter cannot start (for example, a bad token). The registry records the error.

### `ingest` (you call it)

- Set `key` from the platform's own event id. A retry or a reconnect then gives `"duplicate"`.
- Set `source.channel` to the external place (a Slack channel id, a mailbox, a hook name). The core
  finds the `channel_link` row for it. If there is none, it uses the integration's catch-all link
  (`external_id = '*'`), if one exists. A place with no link is `"rejected"`.
- Set `source.parents` when the place sits inside wider places, most specific first. Linear sets
  the issue's project, then its team. The core tries `channel`, then each parent, then `*`.
- Set `actor` for a person. The core finds the person through `identity`. An unknown person gets
  a read-only grant (`notify`), and `ingest` returns `"noted"` (section 10). Send them nothing.
- `ingest` returns `"noted"` when no agent will answer the message. Then do not open a thread for
  it, and do not track its thread.
- Leave `actor` empty for a machine sender (a webhook, a poller). The integration is then the
  identity, and the grant is the link's level.
- Set `mentioned: false` for a chat message that does not mention Orca. A link with
  `require_mention` drops it.
- Set `thread` for a message in a thread. The core sends a reply in a linked thread to its workstream.
- Never set `grant`. The core sets it.

### `send(target, msg, idempotencyKey)`

- `idempotencyKey` is the delivery id. The same delivery can come twice (a crash after the send).
  - Email: use it in the `Message-ID`.
  - Chat: return `externalMsgId`. The core stores it before the next attempt.
- Post in `target.threadId` when it is set. Return `threadId` for a new post. The core stores it
  as the workstream's thread on that link. The thread id is yours: the core only stores it and
  gives it back. Slack uses `channel:thread_ts`.
- Edit `target.messageId` when `msg.edit` is true and `caps.edits` is true.
- The core cuts `msg.text` to `caps.maxTextLength`.
- Never throw for a platform error. Return `{ ok: false, retryable, error }`.
  - `retryable: true` for a network error, a 5xx, or a rate limit. Add `retryAfterMs` when the
    platform gives it.
  - `retryable: false` for bad auth, a missing channel, or a bad message.
- The core paces sends per target from `caps.rate`. Set it when the platform has a limit.
- Send `msg.attachments` as files on the same message. Each is an `orca-attachment://<id>/<name>`
  ref (`orca post --attach`). The delivery stores only the refs.
  - Read the bytes with `db.attachment(attachmentIdOf(ref))` at each send. A retry then sends them
    again.
  - A ref with no row: return `retryable: false`. A database error may throw: the core retries.
  - Set `caps.maxAttachments` and `caps.maxAttachmentBytes` to the platform's limits. Check the
    bytes with `attachmentRefusal` and return `retryable: false` when it refuses. Never cut the
    list or skip a file.
  - Discord sends multipart/form-data: `payload_json` and `files[0]`, `files[1]` … (10 files, 10 MiB
    a file).
- Set `caps.attachments: false` when the platform cannot take files (Slack, webhook, web, Linear
  now). The core then never calls `send` with attachments:
  - `orca post --attach` refuses before it queues: `attachments not supported: …`.
  - The dispatcher ends an old delivery with the same error (not retryable), and the user gets
    the `integration_failed` notification.
- `msg.newThread` (`orca post --new-thread "<name>"`): post as usual, then open a thread with that
  name on the post. Return the thread's id as `threadId`. If the platform refuses the thread, keep
  the post and return no new thread. Only Discord does this now.
- An inbound-only adapter (Cloudflare) sets `caps.outbound: false`. Its `send` returns
  `{ ok: false, retryable: false }`. `orca post` to its link refuses before it queues
  (`outboundRefusal`), and `fenceExternal` tells the orchestrator there is no sender to answer
  (`TAKES_NO_POSTS` in `shared/integrations.ts`).

### `delete(target, externalMsgId)` (optional)

- `orca post --delete <message id>` calls it through the delivery queue. Set `caps.deletes: true`
  and add the method. Discord is the only adapter with it now.
- Delete only a message that the bot posted. Read the message first. For a person's message,
  return `{ ok: false, retryable: false, error }` with a clear reason.
- Without the flag or the method, the core refuses: `delete not supported: …`. The verb refuses
  before it queues when it knows the kind's caps. Else the dispatcher ends the delivery.

### `handle(req, body)`

- Only for `caps.inbound === "relay"`. The route is `POST /api/integrations/<id>/inbound`.
- `body` is the raw text. Check the signature against it before you parse it.
- Answer the request yourself. Return a 2xx fast; the platform retries a slow answer.

### `stop()`

- Close sockets and timers. The registry also aborts `ctx.signal`.

## 5. Register the adapter

1. Write `server/integrations/adapters/<kind>.ts`. Export a factory `(connection) => Adapter`.
2. Add one line to `server/integrations/registry.ts`: `register("<kind>", <kind>Adapter, meta)`.
   Put the class of each CLI verb in `meta.verbs` (section 13).
3. Add the kind's topics to `Topic` in `shared/integrations.ts` only if `ext.<kind>.<event>` is not
   enough.
4. Write a test in `tests/` that drives the adapter with a stubbed `fetch` or a fake server.
5. Optional: pass `meta.secretDefault` (the variable a row names when the Connect form leaves the
   secret empty) and a fourth argument, `onConnect(connection)`. The registry runs it once, on the
   FIRST save of a row of that kind (`admin.saveIntegration`). Cloudflare uses it to make its
   catch-all link and its subscriptions to the orchestrator. A later edit does not run it, so a
   removed link or subscription stays removed.
6. Read every secret with `secretValue(ref)` (`server/integrations/secretRefs.ts`) or
   `ctx.secret()`, never `process.env` directly. Then a stored secret works for your adapter too
   (section 14).

## 6. Configure an integration

Use Settings > Integrations (`/settings/integrations`): Connect, links, people, subscriptions and Retry. A new kind shows there when it registers with `meta` (`register(kind, factory, meta)`). You can also use SQL or `store.ts` from a script:

1. Put the token in Orca's secret store (`/secret` in the chat), or in the environment (`.env` or the
   systemd unit) of each instance that can run it. Name a variable `ORCA_SECRET_<SOMETHING>`. The
   agent environment strips every `ORCA_SECRET_*` variable. The registry refuses any other name,
   except the names in `ORCA_SECRETS` (`server/env.ts`). Section 13 has the stored form.
2. Add an `integration` row: `id`, `kind`, `name`, `instance` (`*` for Automatic, or the one
   instance that runs it, section 6.1), `config`, `secret_ref` (the variable name, or
   `secret:<stored name>`).
3. Add a `channel_link` row for each external place: `level` (`notify`, `ask`, `work` or `admin`),
   `repos` (for `work` and `admin`), `require_mention`.
4. Add `principal` and `identity` rows for each person who may act through Orca. Use the People
   section of the Integrations page, or Add to person on their message (section 10).
5. Add `subscription` rows for what goes out: `topic_pattern`, `filter` (for example
   `{"repo":"orca"}`), `target_kind` (`link`, `orchestrator`, `workstream`, `web`), `target_id`
   (the link id, or `repo::branch`). Set `digest_seconds` for a digest (section 12).
6. For DMs, add a catch-all link with `external_id = '*'`. A place with no link of its own uses it.
7. To let a poller's events through on a `notify` link, set `"machineEventsOnNotify": true` in the
   integration's `config` (section 7).

The primary bridge syncs the rows each minute. You do not need a restart.
`GET /api/integrations` shows the rows, what runs on this bridge, its health and the dead deliveries.

### 6.1 Where it runs: Automatic or pinned

`integration.instance` selects the bridge that opens the connection. Only a primary bridge runs
an adapter (`primary.held()`), so one row has one connection.

- **Automatic** (`*`, `AUTO_INSTANCE` in `shared/integrations.ts`) is the default for a new row.
  Each instance's primary bridge that has the secret tries to take the row's lease on each sync.
  The lease is `status.auto` (`{ holder, until }`) on the row. One conditional `UPDATE` takes it,
  so only one bridge wins. The holder renews it each minute. A lease lasts `AUTO_LEASE_MS` (150 s).
- **Failover.** When the holder stops (down, asleep, no longer primary), it does not renew. When the
  lease ends, the next primary with the secret takes it and starts the adapter. A bridge that stops
  an adapter cleanly (shutdown, the row disabled) releases the lease, so the next one starts at once.
  A holder that comes back finds another live lease, and on its next sync it stops its adapter.
- **Secrets.** A primary without the secret does not take the lease. It records itself in
  `status.secretMissing`. When no bridge runs the row, the card says
  `ORCA_SECRET_X is not set on <server>`, with each server that lacks it.
- **Pinned** (an instance name) runs only on that instance's primary bridge. Use it for an account
  that must stay on one machine. Automatic also gives one session for Discord, so Discord does not
  need a pin.

`*` is a reserved value, not NULL: the column is `NOT NULL` and needs no migration. Settings shows
each instance by the server's display name and its Tailscale host (`Flow / orca-flow-box`). The
server's home is the `orchestratorOn` instance. Another instance shows its Tailscale host only.

Example: CI failures for repo `orca` go to the Slack channel `C123`.

`user_id` is `db.currentUser()` (`ORCA_USER`, else `me`).

```sql
INSERT INTO integration (id, user_id, kind, name, instance, config, secret_ref, created_at)
VALUES ('slack-work', 'me', 'slack', 'Work Slack', '*', '{}', 'ORCA_SECRET_SLACK_BOT', 0);
INSERT INTO channel_link (id, user_id, integration_id, external_id, level)
VALUES ('eng', 'me', 'slack-work', 'C123', 'notify');
INSERT INTO subscription (user_id, topic_pattern, filter, target_kind, target_id)
VALUES ('me', 'orca.pr.ci_failed', '{"repo":"orca"}', 'link', 'eng');
```

### 6.2 OAuth kinds (Gmail)

A kind whose user signs in at the provider registers `meta.oauth` (`{ provider, label }`). The card
then shows the provider's Connect button, and the account and scopes from the row's `status.oauth`
(never a token). `meta.switches` maps config keys to the value the adapter takes while unset. The
Connect form shows those keys as a Switch, stored as `"true"` / `"false"`.

The flow for Gmail is in `server/integrations/adapters/gmail/oauth.ts`:

1. `POST /api/integrations/oauth/google/start` `{ id }` answers Google's consent URL. The redirect
   URI is the page's `Origin` + `/api/integrations/oauth/google/callback`.
2. The PKCE verifier and the state are encrypted in the cursor row `<id>:oauth` (10 minutes, one use).
3. `GET /api/integrations/oauth/google/callback` checks the state, trades the code, stores the
   refresh token as the stored secret `integrations/gmail.<id>.refresh_token`, and sends the browser
   to `/integrations?oauth=connected|failed`.
4. `POST /api/integrations/oauth/google/disconnect` `{ id }` revokes the grant and deletes the token.

The bridge that the browser reaches answers these routes. It never forwards them. The bridge needs
no public address, because the browser makes both redirects.

## 7. Permissions

| Level | The sender can | Orca can, for that message |
|---|---|---|
| `notify` | Nothing inbound. The gate drops the message. | Post to the link. |
| `ask` | Ask questions. | `orca board`, `chats`, `read`, `notes`, `channels`, `ask-user`, `preview --status`, `repo list`, and `post` on the link the message came from. |
| `work` (Editor) | Ask, and start, steer, stop or archive work on the link's repos. | Also `spawn`, `send`, `address`, `status`, `pr-shots`, `preview`, `thread link`, `stop`, `archive` and `merge --when-green` on those repos. `archive` and `stop` act only on orchestrated workstreams. The repo's `mergePolicy` decides a merge. |
| `admin` (Admin) | A trusted person. | Every verb on the link's repos (`merge --cancel` too), plus `move`, `sweep [--confirm]`, `repo add` and `handoff list`. |
| `full` | Your own chat in Orca. | Every verb. |

- The grant is min(link level, person's max level). The link's repos limit `work` and `admin`.
- Only `full` may run `status --clear-grant`, `notes set`, `preview --push-to-template --confirm`
  and `handoff create`. No `orca` verb changes settings, secrets, pairing, levels or links.
- Settings shows the levels as Notify, Viewer, Editor and Admin. The stored values do not change.
- A `notify` link takes nothing in, as above. One exception is opt-in: set
  `"machineEventsOnNotify": true` in the integration's `config`. Then a machine event (no `actor`:
  a poller such as GitHub, or a webhook) on a `notify` link gets through.
  - The core records the event and sends it to its subscriptions (the web, other links).
  - Its grant stays `notify`, so it never reaches the orchestrator or a workstream.
  - A person on that link still gets nothing. The switch is off unless set to exactly `true`.
- The orchestrator wakes for one grant at a time. Messages of another grant wait in the queue.
- The orchestrator's tool route (`POST /api/orchestrator/tool`) checks every verb against the
  grant of the wake in flight. A prompt cannot get past it.
- A wake for an outside sender has no shell. It can act only through `orca`.
- A workstream that such a wake spawns, sends to or addresses gets `grantScope` on its enrichment.
  Every later run of that workstream uses `agentPermissionMode: "ask"`, whatever the repo says.
- The text of an outside message goes into the prompt fenced, with its source, sender and grant.

## 8. What each later adapter needs from the core

| Branch | Uses | Adds |
|---|---|---|
| Slack two-way (done: [slack.md](slack.md)) | `ingest`, `inboundEnvelope`, `thread`, `source.parents`, thread links, `caps.edits`. | A poll in `start` (`inbound: "poll"`, a JSON cursor) with your user token `SLACK_TOKEN` alone; Socket Mode only when `SLACK_APP_TOKEN` is set, so Orca posts as you and never posts by itself (`postsAsUser`). `postAsUser` keeps "post as me". |
| Discord | The same as Slack. | Gateway in `start`. Automatic or pinned: only one bridge runs it (section 6.1). |
| Gmail (done: [gmail.md](gmail.md)) | Its own MIME parse (`gmail/mime.ts`), `cursor` (a History API `historyId`), Gmail thread ids as `thread`, a stored secret it writes itself (the refresh token). | Sign in with Google (OAuth code + PKCE, `meta.oauth`; the client is a server key: ORCA_GOOGLE_OAUTH_CLIENT_ID, ORCA_SECRET_GOOGLE_OAUTH), one row per sign-in named by its address, read only (`caps.outbound: false`), the core's policy (`meta.verbs`, `meta.policyDefaults`: read, off; no poll with events `off`), the query match by Gmail itself. |
| Granola (done: [granola.md](granola.md)) | `cursor` (`from`, `since`, the seen note ids and Granola's page cursor), shared secret refs (the key as `secret:integrations/granola.<id>.api_key`). | A pasted API key (`meta.apiKey`: the save stores it, the row names it), read only (`caps.outbound: false`, in `TAKES_NO_POSTS`), the core's policy (`meta.verbs`, `meta.policyDefaults`: read, off; no poll with events `off`), one event per new finished meeting, a Viewer `*` link on the first Connect. |
| Settings UI | `store.ts` (every table), `registry.health()`, `store.retryDead()`, `GET /api/integrations`, the pairing routes (section 10). | Routes to write rows. A Test button that calls `publish` with a test key. An Approve / Deny list over `GET /api/integrations/pairing`. |
| GitHub poller | `cursor` (an ETag or a timestamp), `ingest` without `actor`, topics `orca.pr.*` or `ext.github.*`. | A poll loop in `start` (`inbound: "poll"`). |
| Linear | The same as the GitHub poller, plus thread links for issues. | GraphQL polls. |
| Cloudflare (done: [cloudflare.md](cloudflare.md)) | `cursor` (one JSON state), `ingest` without `actor`, topics `ext.cloudflare.*`, `source.parents` (`zone:<name>` in `account`). | A poll loop in `start`; no outbound (`caps.outbound: false`); `onConnect` for its link and subscriptions. |
| Unified inbox | The `event` table (`ext.*.message`, `orca.question`). | A view. |

## 9. Behaviour that stays as before

- `POST /api/slack` posts `{channel, text}` with `SLACK_TOKEN` as you. It goes through the Slack
  adapter's `send` (`postAsUser`) and answers at once. It does not use the delivery queue, so the
  card still shows a failed post at once.
- `POST /api/orchestrator/event` stays. Instances use it to send worker reports to the
  orchestrator's instance. Scripts use a webhook integration in its place.
- `notify.emit` writes the notification row as before. For a new row it also writes the event with
  the same key.

## 10. Unknown senders, the link switches and pairing

Each link has two switches. Both are on for a new link. Named step `20261023-link-switches` turned
them on for the old links.

- **Notify me:** the message shows in the bell, the Inbox and the orchestrator's chat.
- **Notify agent:** the message may wake an agent. Off, no message on the link wakes an agent.
- With both off, the core records nothing.

A known person keeps their grant: min(link level, person's max level).

An unknown person gets the `notify` grant. That grant is READ-ONLY:

1. The core records the message. `ingest` returns `"noted"`.
2. With Notify agent on, the orchestrator wakes. It may read the message and tell you about it.
3. Every `orca` verb is refused, `post` too. The wake has no reply target.
4. The core makes no pairing code and sends nothing to the sender.

To give a person a grant, add them on the People section of the Integrations page. You can also
use Add to person on their message in the Inbox or the chat.

A pairing code made before this change still shows on the People section. Approve or deny it there.

The API (the Settings page uses the same routes later):

| Route | Body | Result |
|---|---|---|
| `GET /api/integrations/pairing` | | `{ pairings }`: the pending, live codes. |
| `POST /api/integrations/pairing/approve` | `{ code, principal?, name?, maxLevel? }` | Binds the sender. `principal` names an existing person (keeps that person's name and level) or a new id. With no `principal`, the id comes from the name. A new person gets `maxLevel` or `ask`. |
| `POST /api/integrations/pairing/deny` | `{ code }` | Drops the code. |

The store functions are `pairingFor`, `pendingPairings`, `approvePairing` and `denyPairing`.

## 11. Orchestrator verbs for channels

These go through `POST /api/orchestrator/tool` like every other `orca` verb. The grant check runs
first (section 7).

| Verb | What it does |
|---|---|
| `orca channels` | Lists every link (integration, place, level, repos), every subscription and the pending pairing codes. |
| `orca post --link <id> [--thread <id> \| --repo r --branch b] "<text>"` | Publishes `orca.message` with a delivery to the link. With `--repo` and `--branch` it continues that workstream's thread on the link, or starts it. |
| `orca post --reply "<text>"` | Answers the outside message that woke the orchestrator: its link, its place (the DM for a catch-all link) and its thread. The grant check runs on that link. A wake from your own chat or a worker report has nothing to answer, so `--reply` fails there. |
| `orca post --reply --thread "<text>"` | Answers the same way, but opens a thread for the answer where the adapter can (Discord: on the mention). Use it for a long answer, a job with many steps, a workstream or a long conversation. The thread that the send returns is recorded as the workstream's thread on the link. |
| `orca post … --attach <id\|path>` | Repeatable, on every form above. Sends each file with the post (Discord: an image shows inline). The value is an attachment id (from `## Attachments`) or an absolute path on the orchestrator's machine, stored like an upload. Refused before it queues when the adapter has no file support, when there are too many files or a file is too large, or when a text file holds an obvious secret (the handoff scan). A wake from an outside message may attach only ids. |
| `orca post --link <catch-all> --channel <id> [--thread <id>] "<text>"` | Posts through a catch-all link (`external_id` `*`) to any channel or thread the bot can see. The grant is the catch-all link's grant. A wake from an outside message may name only the place that message came from. |
| `orca post … --new-thread "<name>"` | On a `--link` or `--reply` post. Posts as usual, then opens a thread with that name on the post (Discord: the name is cut to 90 characters). It works with `config.threads` off. Use it only when the user asks for a thread. Refused with `--thread`, and for an adapter with no threads. |
| `orca post --link <id> [--channel <id>] [--thread <id>] --delete <message id>` | Deletes one message that the bot posted, through the delivery queue. A person's message is refused. An adapter without `caps.deletes` refuses. It takes no text. |
| Every `orca post` | Waits for its delivery (about 15 seconds) and prints the platform's message id and thread id. A dead delivery prints its error. If the wait ends first, it prints the delivery id, and Orca still retries the send. |
| `orca post --link <catch-all>` | Refused without `--channel` or `--reply`: a catch-all link names no place to post to. `--channel` on any other link is refused too. |
| `orca thread link <adapter> <thread-id> --repo r --branch b [--link <id>]` | Binds an external thread to a workstream. Replies in it then go to the workstream (with a `work` grant on its repo). |
| `orca ask-user "<question>"` | Publishes `orca.question`. The bell shows it as `needs_input`. Subscriptions to `orca.question` also send it out (for example to your Slack DM). |

The wake knows its source event. `inbox.toOrchestrator` passes the event's `ReplyTo` (`replyToOf`:
link, place, thread, event key) with the message. The queue keeps it in `queued_message.reply_to`,
and the wake stores the newest one as `wakeReplyTo`, beside `wakeGrant`.

`publish(envelope, now, extra)` takes explicit deliveries (`extra`) beside the subscriptions'. Use
it from the core for a delivery to one known target.

## 12. Digest subscriptions

A subscription with `digest_seconds` set collects its deliveries into fixed windows of that many
seconds. At the window's end, the dispatcher sends ONE message for the window.

- The message has the title `N events` and one line per event, oldest first.
- A window with one event sends that event as it is.
- The delivery id of the first member is the idempotency key. Every member gets the same result,
  retry time and dead state.
- A digest does not apply to `web` targets. The web already shows each event.
- A digest over more than one workstream starts no thread.

## 13. The account policy: declare verb classes, get the rest free

Each `integration` row is one connected account. It has two settings (named step
`20261024-integration-access-events`; the design is [POLICY.md](POLICY.md)):

- `access`: `read` or `read-write` (the default). What Orca may do with the account.
- `events`: `trigger` (the default), `record` or `off`. What an inbound event does.

The core enforces both. An adapter does not check them.

| The core does | Where |
|---|---|
| Refuses `orca post` and the Inbox Reply to a read account (`send`, or `delete` for `--delete`). | `router.publish` |
| Plans no delivery for a subscription to a read account. | `router.publish` |
| Ends a delivery that was planned before the account became read. | the dispatcher |
| Refuses a link's Test on a read account. | `admin.testLink` |
| Narrows the link switches with `effectiveNotify(link, events)`: `record` wakes no agent, `off` records nothing. A link never widens them. | `router.ingest` |
| Picks the account of an `orca <kind>` verb (`--account`) and checks the verb. | `policy.useAccount` |

The one decision is `integrationAccessRefusal(account, verb, classes)` in `shared/integrations.ts`.

What a new adapter does:

1. Declare the class of each CLI verb in its meta. A verb that is not declared is a write, so a
   read account refuses it:

   ```ts
   export const GMAIL_VERBS: VerbClasses = { search: "read", read: "read", list: "read", send: "write", reply: "write" };
   register("gmail", gmailAdapter, { label: "Gmail", caps: GMAIL_CAPS, verbs: GMAIL_VERBS, … });
   ```

   `send` and `delete` (the delivery queue) are the core's (`CORE_VERBS`). Do not declare them.
2. In the CLI verb (`case "<kind>"` in `orchestrator.tool`), pick the account and check the verb
   before any call to the platform:

   ```ts
   const c = await policy.useAccount("gmail", sub, args.account);   // throws a clear refusal
   return gmailTool(args, { env: policy.accountEnv(c, "ORCA_SECRET_GMAIL") });
   ```

   `useAccount` returns `undefined` when no account of the kind is connected. Keep the old path then.
3. Optional: skip an inbound poll when `connection.events === "off"`. The core drops the events
   anyway, so this only saves platform calls.

A kind with a CLI but no adapter yet calls `registerVerbs(kind, verbs)`. When its adapter
registers `meta.verbs`, the meta wins. Cloudflare's adapter registers `CLOUDFLARE_VERBS`
(`shared/integrations.ts`), the same table the grant check reads.

Several accounts of one kind: each is its own row. `--account <id or name>` picks one. With one
row, it is the default. With several and no `--account`, the verb fails and lists them.

## 14. Secrets: a variable or Orca's secret store

Every secret ref of an integration has one of two forms:

| Form | Example | Where the value is |
|---|---|---|
| A variable name | `ORCA_SECRET_LINEAR` | The bridge's environment (`.env`). It must start with `ORCA_SECRET_` or be in `ORCA_SECRETS`. |
| `secret:<name>` or `secret:<scope>/<name>` | `secret:gmail-app` | Orca's encrypted secret store ([docs/secrets.md](../secrets.md)): `/secret` in the chat, or an `ask-form` secret field. |

A secret ref is the row's `secret_ref`, and each config key that ends in `Ref`, nested keys too:
for example Slack's `appTokenRef`. `secretRefRefusal` checks both forms. A plain value is refused.

How a stored secret reaches an adapter (`server/integrations/secretRefs.ts`):

1. Before `start`, the registry decrypts each stored secret that the row names (`secretRefs.load`).
   It keeps the values in the bridge's memory only. Each read writes one audit row (action
   `integration`, command = the kind, who = `integration <id>`).
2. The adapter reads it with `secretValue(ref)` or `ctx.secret()`, like a variable.
3. Each sync (every minute) compares the stored secret's `updated_at`. A changed or deleted secret
   stops the adapter, and the registry starts it again. That start loads the new value, or fails
   with the reason on the card (`no secret "gmail-app"`).
4. An Automatic row goes only to a primary whose key can decrypt every stored secret it names
   (`secretRefs.readable`). Set the same `ORCA_SECRETS_KEY` on each instance, or pin the row.

Rules:

- No value goes to a file, a log, the environment or an agent's spawn. `secrets.scrub` masks a
  stored value in tool output and posts.
- A `secret:` ref never falls back to a variable, and a variable never falls back to the store.
- The Connect form has a **Stored secret** Select for every kind with a user-side secret. It lists
  the store's names, never a value, and writes `secret:<name>` as the secret_ref. For a config ref,
  type `secret:<name>`.
- A server key is env only (`shared/serverKeys.ts`, docs/SETUP.md "Server keys"): Gmail's OAuth
  client, Discord's bot token, the webhook signing secret and Slack's `appTokenRef`. Those kinds
  have no Stored secret Select, a save of a `secret:` ref for them is refused (`serverKeyRefusal`),
  and an old one on a row reads as the kind's variable with one log line (`serverKeyRow`). The
  overview's `meta.serverKey` (`configured`, `needs`) greys out the kind in the Connect dialog.
- An `orca <kind>` verb gets the account's stored secrets from `policy.useAccount` (section 13): it
  loads any that this bridge has not loaded yet, or that changed (`secretRefs.ensureLoaded`), and
  `policy.accountEnv` reads them through `secretValue`.
