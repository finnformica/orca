# Orca integrations layer and channel system

**Status:** Research and design report. Captured 2026-10-16. No code was changed. The work is downscoped to later (see [dual-instance.md](dual-instance.md)).

**Note on Slack:** Slack moves into this integration layer as an adapter. It stops being a direct,
one-off integration. Today, `server/slack-api.ts` posts with a user token
(`chat.postMessage`, see section 1). The design below treats Slack like Discord, email, GitHub and
Linear: one `Adapter` behind the same interface, with the same permission and delivery rules.

## 0. Summary

- Build one `Adapter` interface and one event envelope. Slack, Discord, email, GitHub, Linear and webhooks plug in the same way.
- Use a small pub/sub model: topics, subscriptions and deliveries are rows in Postgres. Do not add a broker.
- Keep `bus.ts` for live UI pushes. Add a `delivery` table as the durable outbox for external sends.
- Run every long-lived connection (Socket Mode, Gateway, IMAP IDLE, pollers) on the primary bridge only.
- The server enforces permissions per channel link (repos, people, level). The orchestrator prompt does not enforce them.
- Fold the stopped Discord workstream in as the first two-way adapter, after the core lands.

## 1. What Orca has today

| Part | File | Fact | Effect on the design |
|---|---|---|---|
| In-process bus | `server/bus.ts` | Typed `BusEvent` union, no topics, no buffer, no replay. One process. | Keep it as the live fan-out to SSE. Do not make it durable. |
| SSE stream | `server/events.ts` | One stream per tab. Relays other instances with `?local=1`. | The web UI is already a subscriber. It becomes the `web` adapter. |
| Notifications | `server/notify.ts`, `db.addNotification` | One emitter. Rows dedupe on `(user_id, key)`. Kinds: `finished`, `failed`, `needs_input`, `check_failed`, `pr_ci_failed`, `pr_conflicts`, `preview_*`. | This is already an event log with idempotency keys. Extend it; do not replace it. |
| "Outbox" | `server/outbox.ts` | A file journal for DB outages (turns, enrichment). It is not a message outbox. | Name the new table `delivery`, not `outbox`, to prevent confusion. |
| Orchestrator inbox | `orchestrator.message()`, `deliverReport()`, `queued_message` table | Two entry points. A busy orchestrator queues text. Only the primary bridge wakes it. | Inbound adapters call one new function that wraps these two. |
| Remote event route | `POST /api/orchestrator/event` | Text plus optional key. No sender identity. The repo-watch script used it. | Replace with an authenticated generic-webhook adapter. |
| Slack | `server/slack-api.ts`, `POST /api/slack` | Outbound only. `chat.postMessage` with a user token (`xoxp`). Per repo `slackChannel` and `features.slack`. | Becomes the outbound half of the Slack adapter. |
| GitHub | `server/gh.ts`, `notify.prs()` | `gh` CLI. PR state is read when `/api/prs` answers. | Becomes a poller adapter on a timer. |
| Discord | worktree `orca/discord-channel-integration-88b45c` | No commits on the branch. Stopped for an architecture talk (REQUESTS.md lines 125-129). | Restart it on top of the core. |
| Multi-instance | `primary.ts`, `cfg.orchestratorOn` | One primary bridge per instance. Reports go to the orchestrator's instance over HTTP. | Adapters with sockets must run on exactly one process. |

## 2. Prior art

| System | Model | What it gets right for Orca |
|---|---|---|
| [Claude Code channels](https://code.claude.com/docs/en/channels-reference) | An MCP server pushes `notifications/claude/channel` with `content` and `meta`. A `reply` tool sends back. Optional permission relay. | Sender gating on user id, not room id. Pairing codes to grow the allowlist. Approve tool use from chat with a 5-letter id. Meta attributes carry routing ids (`chat_id`). |
| Same, limits | Research preview. Needs `--channels` or the dev flag. The flag is ignored in `-p` mode. | Orca workers are headless one-shot runs. So Orca cannot use channels directly. Orca must be the channel layer itself. |
| [Discord channel plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord) | Bun, Gateway, `access.json` with `dmPolicy`, group opt-in per channel, `requireMention`. | A good access model to copy for every chat adapter. |
| [Vercel Chat SDK](https://chat-sdk.dev/docs) | One `Chat` core, one adapter package per platform (Slack, Teams, Discord, GitHub, Linear, Telegram). State in Redis or Postgres for subscriptions, locks, dedupe. | Thread is the main unit. Adapters normalize messages. Dedupe and locks live in a state store. Webhook-first, so inbound needs a URL. |
| [Matrix application services](https://spec.matrix.org/latest/application-service-api/) | Bridges map remote users and rooms to virtual Matrix users and rooms. Transactions have ids; the homeserver retries. | Identity mapping (remote user to local user) and room mapping (remote thread to local room). Transaction ids give idempotent inbound. |
| [Chatwoot](https://github.com/chatwoot/chatwoot) | "Inbox" per channel (email, API, WhatsApp, Slack). One conversation model for all. | One unified inbox UI. One conversation record whatever the source. |
| Mattermost / Rocket.Chat | Incoming and outgoing webhooks, slash commands, bot accounts. | A generic webhook with a per-hook secret is enough for many sources. |
| [Novu](https://docs.novu.co/platform/how-novu-works), [Knock](https://docs.knock.app/), [Courier](https://www.courier.com/docs/) | Workflow triggered by an event. Subscribers have per-channel addresses. Topics for fan-out. Digest and delay steps. Preferences per subscriber. | Separate "what happened" (event) from "who hears it, where" (subscription) from "how it renders" (template per channel). Digest is useful for noisy CI events. |
| [Apprise](https://github.com/caronc/apprise) | One URL string per target (`slack://`, `discord://`, `mailto://`). | A target is one string. Good for config and a test button. Outbound only. |
| [n8n](https://docs.n8n.io/), [Node-RED](https://nodered.org/), [Huginn](https://github.com/huginn/huginn) | Trigger nodes (webhook or poll), action nodes. Credentials stored apart from flows. | Poll triggers keep a cursor per source. Credentials are a separate object from routing. |
| [Hubot adapters](https://hubot.github.com/docs/adapters/), [Errbot backends](https://errbot.readthedocs.io/en/latest/user_guide/backend_development/), [Bot Framework](https://learn.microsoft.com/en-us/azure/bot-service/) | Small adapter contract: `send`, `reply`, `receive`, user and room objects. Bot Framework normalizes to an `Activity` with a `conversation` reference. | A tiny adapter contract survives many platforms. A stored conversation reference lets you reply later (proactive messages). |
| [OpenClaw channels](https://documentation.openclaw.ai/channels/slack) | Self-hosted agent gateway. Slack over Socket Mode, Discord over Gateway, pairing and allowlists. | Proof that outbound-only connections cover the main chat apps for a self-hosted agent. |
| MCP servers as adapters | Agents call third-party MCP tools (Slack, Linear, GitHub). | Good for agent read/write tools. Not good as the routing core: no durable inbound, no server-side permission check. Keep MCP as an optional worker tool. |
| [Svix](https://www.svix.com/), [Hookdeck CLI](https://hookdeck.com/docs/cli), [smee.io](https://smee.io/), [`gh webhook forward`](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing) | A public relay receives the webhook. The box pulls it over an outbound connection. | Gives webhooks without a public inbound URL. `gh webhook forward` is "not supported in production". smee.io has no auth and no durability. Hookdeck has retries and replay. |

Common lessons:

1. Normalize to one envelope early. Keep the raw payload for debug.
2. Store a conversation reference per thread, so replies go back to the same place.
3. Gate on sender identity. Group membership is not enough.
4. Make inbound idempotent with the platform's own event id.
5. Keep credentials, routing and templates in separate objects.

## 3. Recommended architecture

### 3.1 Shape

```
 external app ─► Adapter.start() (primary bridge only)
                    │ inbound Envelope
                    ▼
             ingest(): dedupe ─► gate (sender, link) ─► event row ─► router
                                                                     │
 Orca itself (notify.emit, worker done, PR, CI, question) ──────────►│
                                                                     ▼
                                      subscriptions match topic ─► delivery rows
                                                                     │
                     ┌───────────────────────────┬───────────────────┤
                     ▼                           ▼                   ▼
          orchestrator inbox          worker follow-up       Adapter.send() (Slack,
          (queued_message)            (verbs.followup)       Discord, email, web bus)
```

### 3.2 Event envelope

```ts
// shared/integrations.ts
export type Topic =
  | `orca.run.${"finished" | "failed" | "needs_input" | "stopped"}`
  | `orca.pr.${"opened" | "ci_failed" | "conflicts" | "merged"}`
  | `orca.preview.${"ready" | "failed"}`
  | `orca.question`                 // the orchestrator asks the user
  | `ext.${string}.message`         // a chat or email message from outside
  | `ext.${string}.${string}`;      // other external events: ext.github.push, ext.linear.issue

export type Envelope = {
  id: string;                 // ULID, Orca's own id
  key: string;                // idempotency key, e.g. "slack:T1:Ev123" or the notification key
  topic: Topic;
  at: number;
  source: { adapter: string; connectionId?: string; linkId?: string };
  actor?: { principalId?: string; external: { adapter: string; id: string; name?: string } };
  scope?: { repo?: string; branch?: string };   // set when known (PR, worker, thread link)
  thread?: { adapter: string; externalId: string }; // Slack thread_ts, Discord thread id, Message-ID
  text: string;               // plain text the agent will read
  attachments?: string[];     // orca-attachment:// refs (server/attachments.ts)
  link?: { url?: string; orchestrator?: boolean };
  raw?: unknown;              // original payload, kept 7 days for debug
};
```

`notify.emit()` keeps its job. It also writes one `Envelope` with the same `key`. The `notification` row stays the web UI's read model.

### 3.3 Adapter interface

```ts
// server/integrations/adapter.ts
export type Capabilities = {
  inbound: "socket" | "poll" | "relay" | "none";
  outbound: boolean;
  threads: boolean; edits: boolean; reactions: boolean; attachments: boolean;
  maxTextLength: number;
};

export type Target = { linkId: string; externalId: string; threadId?: string };

export interface Adapter {
  readonly kind: "slack" | "discord" | "email" | "github" | "linear" | "webhook" | "web";
  readonly caps: Capabilities;
  /** Open sockets or start pollers. Called on the primary bridge only. Resolve when ready. */
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  /** Render and send one delivery. Must be safe to call twice with the same key. */
  send(target: Target, msg: OutboundMessage, idempotencyKey: string): Promise<SendResult>;
  /** Cheap live check for the settings card and the Test button. */
  health(): Promise<{ ok: boolean; detail?: string; lastEventAt?: number }>;
  /** Map a platform user to a display name and stable id (for pairing). */
  resolveUser?(externalId: string): Promise<{ id: string; name: string } | undefined>;
}

export type AdapterContext = {
  connection: Connection;                     // row, with decrypted secrets
  ingest(e: Omit<Envelope, "id">): Promise<"new" | "duplicate" | "rejected">;
  cursor: { get(): Promise<string | undefined>; set(v: string): Promise<void> }; // pollers
  log(msg: string): void;
};

export type OutboundMessage = { text: string; title?: string; url?: string; replyToExternalMsgId?: string };
export type SendResult =
  | { ok: true; externalMsgId?: string; threadId?: string }
  | { ok: false; retryable: boolean; retryAfterMs?: number; error: string };
```

### 3.4 Tables

```sql
-- one row per account/bot/mailbox
CREATE TABLE integration (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
  instance TEXT NOT NULL,          -- which instance runs it (keeps Discord off the work box)
  config JSONB NOT NULL DEFAULT '{}', secret_ref TEXT,  -- env var name or encrypted blob
  enabled BOOLEAN NOT NULL DEFAULT true, status JSONB);

-- one row per external place: a Slack channel, Discord channel, mailbox, repo, Linear team
CREATE TABLE channel_link (
  id TEXT PRIMARY KEY, integration_id TEXT NOT NULL REFERENCES integration,
  external_id TEXT NOT NULL, label TEXT,
  level TEXT NOT NULL CHECK (level IN ('notify','ask','work')),
  repos TEXT[] NOT NULL DEFAULT '{}',          -- empty = none for 'work'
  require_mention BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (integration_id, external_id));

-- people: you plus collaborators, with external ids per adapter
CREATE TABLE principal (id TEXT PRIMARY KEY, name TEXT NOT NULL, max_level TEXT NOT NULL);
CREATE TABLE identity (adapter TEXT, external_id TEXT, principal_id TEXT REFERENCES principal,
  PRIMARY KEY (adapter, external_id));

-- who hears what
CREATE TABLE subscription (
  id BIGSERIAL PRIMARY KEY, topic_pattern TEXT NOT NULL,   -- 'orca.pr.*', 'ext.discord.message'
  filter JSONB NOT NULL DEFAULT '{}',                      -- {"repo":"orca"}
  target_kind TEXT NOT NULL CHECK (target_kind IN ('link','orchestrator','workstream','web')),
  target_id TEXT, digest_seconds INT);

-- external thread <-> Orca conversation
CREATE TABLE thread_link (
  adapter TEXT, external_thread_id TEXT, link_id TEXT,
  repo TEXT NOT NULL, branch TEXT NOT NULL, created_at BIGINT NOT NULL,
  PRIMARY KEY (adapter, external_thread_id));

-- the event log and the durable outbox
CREATE TABLE event (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, topic TEXT NOT NULL,
  envelope JSONB NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE delivery (
  id BIGSERIAL PRIMARY KEY, event_id TEXT REFERENCES event, subscription_id BIGINT,
  target JSONB NOT NULL, state TEXT NOT NULL DEFAULT 'pending',  -- pending|sent|failed|dead
  attempts INT NOT NULL DEFAULT 0, next_at BIGINT NOT NULL, last_error TEXT,
  external_msg_id TEXT, UNIQUE (event_id, subscription_id));
```

### 3.5 Routing and delivery rules

1. `ingest()` inserts into `event` with `ON CONFLICT (key) DO NOTHING`. A duplicate returns `"duplicate"`. This handles Slack retries, Gateway resumes and poll overlaps.
2. The router matches `subscription.topic_pattern` and `filter`. It inserts one `delivery` row per match, in the same transaction.
3. A dispatcher on the primary bridge claims due rows with `SELECT ... FOR UPDATE SKIP LOCKED`. It calls `send()`.
4. Retry: exponential backoff (5 s, 30 s, 2 min, 10 min, 1 h). Respect `retryAfterMs`. After 6 attempts, set `dead` and emit `orca.integration.failed` to the web UI.
5. Idempotency on send: pass `delivery.id` as the key. Email uses it as `Message-ID`. Chat adapters store `external_msg_id` before the next attempt.
6. Kick the dispatcher in-process after each insert. Also poll every 5 s as a safety net. No `LISTEN/NOTIFY` is needed while one process dispatches.

Target kinds:

| `target_kind` | Action |
|---|---|
| `orchestrator` | `inbox.toOrchestrator(envelope)`. Wraps `orchestrator.message()` for people and `deliverReport()` for machine events. |
| `workstream` | Queue a follow-up on `(repo, branch)` through `verbs`. Use `thread_link` to find the branch. |
| `link` | `adapter.send()` to a Slack/Discord channel, a mailbox or a Linear issue. |
| `web` | `notify.emit()` then `bus.publish()`. This is what happens today. |

### 3.6 Threading

| Source | External thread id | Rule |
|---|---|---|
| Slack | `channel:thread_ts` | First Orca post about a workstream starts a thread. Store it. Replies in that thread go to that workstream. |
| Discord | thread channel id | Create a thread per workstream from the link channel. |
| Email | root `Message-ID` | Read `In-Reply-To` and `References`. Put `[orca:<branch>]` in the subject as a fallback. |
| GitHub | `owner/repo#PR` | Already mapped by PR head branch. |
| Linear | issue id | Link an issue to a workstream on spawn. |

A message with no thread link goes to the orchestrator. The orchestrator can call a new verb, `orca thread link <adapter> <thread> <branch>`, to bind it.

### 3.7 Permissions (server-enforced)

Levels, from low to high:

| Level | The person can | Orca can |
|---|---|---|
| `notify` | Nothing inbound. Orca drops their messages. | Post to the link. |
| `ask` | Ask questions. Get answers about status, PRs, board. | Read only. No spawn, send, merge or push. |
| `work` | Ask, and start or steer work on the link's `repos`. | Spawn and follow up on those repos only. |
| `admin` | A trusted person. Added later, see `docs/integrations/ADAPTERS.md` section 7. | Every verb on those repos, plus move, sweep and repo add. Never the owner's verbs. |

Effective grant = min(`channel_link.level`, `principal.max_level`), repos = `channel_link.repos`. Unknown senders get a pairing code (as in the Discord plugin). You approve them in the UI.

Enforcement point: the `orca` CLI calls `POST /api/orchestrator/tool`. The server records the grant of the wake in the orchestrator blob (next to `handling`). The tool route rejects a verb outside the grant. Rules:

- Do not batch messages from different grants into one wake. Queue them in separate `queued_message` groups.
- A wake from your own web chat has the full grant.
- External text goes into the prompt in a fenced block with source, sender and grant. It is data, not instructions. This lowers prompt-injection risk. The server check is the real control.
- Workers spawned from an `ask` or `work` wake inherit the repo limit and `agentPermissionMode: "ask"`.

### 3.8 Rate limits

- Outbound: an in-memory token bucket per integration and per target. Slack about 1 message per second per channel. Discord: obey `429 retry_after`. Email: cap per hour.
- Inbound: per principal, for example 20 messages per 10 min. Over the cap, Orca reacts with a "slow down" note and drops.
- Digest: a subscription with `digest_seconds` collects events and sends one message. Use it for CI noise.

### 3.9 How agents publish and subscribe

- The orchestrator publishes with new verbs: `orca post <link|thread> "<text>"` and `orca ask-user "<question>"` (topic `orca.question`). Both go through `delivery`, so the server checks grants and retries.
- Workers do not get chat tokens. A worker publishes by its structured outcome (already parsed into `run.structured`). `notify.onRunFinished` turns it into `orca.run.*` events.
- Subscriptions are config, not agent state. The UI edits them. The orchestrator can list them with `orca channels`.

## 4. Is pub/sub overkill?

The concept is not overkill. Topics plus subscription rows are the simplest way to say "CI failures for repo X go to Discord #dev and the web UI". The infrastructure is overkill. A broker adds a process, memory and a second source of truth.

| Option | Durable | Extra process | Fits one small box | When it is right |
|---|---|---|---|---|
| In-process `bus.ts` + Postgres `event`/`delivery` tables | Yes (Postgres) | No | Yes | Now. Hundreds of events per hour. One dispatcher. |
| + Postgres [`LISTEN/NOTIFY`](https://www.postgresql.org/docs/16/sql-notify.html) | Signal only, not durable. Payload under 8000 bytes. | No | Yes | When a second process must react at once (for example a separate adapter worker). Send the row id only. |
| Job library on Postgres ([pg-boss](https://github.com/timgit/pg-boss), graphile-worker) | Yes | No | Yes | If retry, cron and dead-letter code grows past about 200 lines. |
| [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/) | Yes, with AOF | Yes | Yes, about 10-50 MB | Many consumer processes, high rates. Not Orca's case. |
| [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream) | Yes | Yes | Yes | Many instances share events across hosts. Possible later for cross-instance routing. |
| Hosted queue (SQS, Cloudflare Queues, Upstash) | Yes | No local | Yes | Inbound relay for webhooks when no public URL exists. Use only as a relay, not as the core. |

Recommendation: in-process bus plus Postgres tables. This is the [transactional outbox pattern](https://microservices.io/patterns/data/transactional-outbox.html) on the database Orca already has. Move up when one of these is true:

- More than one process must dispatch at once: add `LISTEN/NOTIFY` as a wake-up signal.
- Events cross instances often (laptop and box): add NATS, or keep today's HTTP relay.
- Volume passes about 50 events per second: unlikely for one user.

## 5. Per-source notes

| Source | Inbound without public URL | Outbound | Identity | Effort |
|---|---|---|---|---|
| Slack | [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/): app-level token `xapp-` with [`connections:write`](https://api.slack.com/scopes/connections:write), call [`apps.connections.open`](https://docs.slack.dev/reference/methods/apps.connections.open), then a WebSocket. Ack each envelope. Reconnect on `disconnect`. | `chat.postMessage` with a bot token (`xoxb-`), `thread_ts` for threads. | Slack user id `U...`, team id. | 2 days |
| Discord | [Gateway](https://discord.com/developers/docs/events/gateway) WebSocket with intents `GUILDS`, `GUILD_MESSAGES`, `DIRECT_MESSAGES`, `MESSAGE_CONTENT` (privileged; enable in the portal and in code). | REST `POST /channels/{id}/messages`, threads, reactions. | User snowflake. | 2-3 days |
| Email | IMAP IDLE ([RFC 2177](https://www.rfc-editor.org/rfc/rfc2177)) with [ImapFlow](https://imapflow.com/), on a dedicated mailbox. Fallback: poll every 60 s. Alternatives: Gmail API watch with a Pub/Sub pull subscription; [Cloudflare Email Workers](https://developers.cloudflare.com/email-routing/email-workers/) that store mail for Orca to pull. | SMTP (nodemailer) or [Resend](https://resend.com/docs) / [Postmark](https://postmarkapp.com/developer) API. | `From` address, verified by SPF/DKIM result (`Authentication-Results`). | 2-3 days |
| GitHub | Polling (today's `gh`), with ETag conditional requests (a 304 does not count against the [rate limit](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)). Webhooks only through a relay (Hookdeck, a small Cloudflare Worker queue). | `gh pr comment`, `gh api`. Already in `gh.ts`. | GitHub login. | 1-2 days (refactor) |
| Linear | Poll GraphQL `issues(filter: {updatedAt: {gt: cursor}})` every 60 s. For [agent sessions](https://linear.app/developers/agents) (`actor=app`, `app:mentionable`, `app:assignable`) Linear needs a webhook, so use a relay. | GraphQL `commentCreate`, `issueUpdate`. | Linear user id. | 2 days (poll), +1 day (agent app via relay) |
| Generic webhook | A tailnet-only `POST /api/integrations/<id>/inbound` with an HMAC secret. Public senders: [Hookdeck CLI](https://hookdeck.com/docs/cli) or [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) on that one path. | `POST` to a URL with HMAC signature. | Secret per hook. | 0.5 day |
| Web UI | `/api/orchestrator/message` (today). | `bus.publish` + `notification` row (today). | You. | 0.5 day (wrap) |

Notes:

- Slack: use a bot token for the two-way adapter. A bot identity shows clearly who posts. Keep the user token path (`SLACK_TOKEN`) for "post as me". Bot scopes: `chat:write`, `app_mentions:read`, `channels:history`, `groups:history`, `im:history`, `users:read`. One Socket Mode connection per app per instance.
- Discord: run one Gateway session per bot token. Two sessions give duplicate events. REQUESTS.md line 129 asks to keep Discord traffic off the work AWS box. `integration.instance` solves this: run the Discord adapter on the SMF instance only.
- Email: do not trust the `From` header alone. Require a DKIM pass for the sender domain, plus the allowlist.
- GitHub: the repo-watch script becomes the GitHub adapter's poller. Retire the raw `/api/orchestrator/event` calls from scripts.

## 6. UI

### 6.1 Settings > Integrations

One page. One card per `integration` row.

| Card part | Content |
|---|---|
| Header | Icon, name, kind, instance it runs on, enabled switch. |
| Health | Green, amber or red dot. "Connected 2 h", "Last event 3 min ago", last error. From `adapter.health()` and `integration.status`. |
| Credentials | Secret status (set or not set). Never show the value. A "Replace" button. |
| Links | Table: external place, level (`notify`/`ask`/`work`), repos, mention required, Test button. |
| People | Paired identities, max level, pending pairing codes with Approve and Deny. |
| Subscriptions | Rows "topic pattern + filter → target". Presets: "PR events", "Worker done", "Questions for me", "CI failures (digest 10 min)". |
| Test | Sends "Orca test message" through the real `delivery` path. Shows the result inline. |
| Dead letters | Count and a "Retry all" button. |

Add a "+ Add integration" flow per kind, with the token or OAuth step and a guide.

### 6.2 Unified inbox and timeline

- A new "Inbox" view: every inbound `ext.*.message` and every `orca.question`, newest first. Filters: source, person, repo, unread.
- Each row shows source icon, sender, text, linked workstream and delivery status of the reply.
- Actions: "Open thread", "Link to workstream", "Reply" (goes out through the source adapter), "Mute sender".
- On a workstream card, show a small chip per thread link (Slack, Discord, email). The chat panel shows inbound external messages as turns with a source badge.
- The notification centre stays. It reads the same `event` rows filtered to `target_kind = web`.

## 7. Phased plan

| Phase | Work | Effort | Result |
|---|---|---|---|
| 0. Envelope | `shared/integrations.ts` types. `event` table. `notify.emit()` also writes the event. No behaviour change. | 0.5 day | Every Orca event is a durable, keyed envelope. |
| 1. Core | Tables. `Adapter` interface and registry (starts adapters on `primary.held()` and on the configured instance). Router and `delivery` dispatcher with retry. `inbox.toOrchestrator` with grants. Grant check in `/api/orchestrator/tool`. Adapters: `web` (wrap today), `webhook` (replaces `/api/orchestrator/event` for scripts), `slack` outbound (move `slack-api.ts`). | 3-4 days | One path in, one path out. Today's features still work. |
| 2. Discord | Resume `orca/discord-channel-integration-88b45c` on top of phase 1. Gateway inbound, pairing, link levels, thread per workstream, outbound posts. Run on the SMF instance only. | 2-3 days | First two-way chat adapter. Saajan can @orca and get replies. |
| 3. Settings UI | Integrations page, cards, links, people, Test, health. | 2-3 days | No JSON editing to connect a source. |
| 4. Slack two-way | Socket Mode, bot token, threads. Keep user-token "post as me". | 2 days | Slack matches Discord. |
| 5. GitHub adapter | Move PR/CI polling and repo-watch into a poller adapter with ETags and a cursor. | 1-2 days | `orca.pr.*` events from one place. |
| 6. Email | IMAP IDLE in, SMTP or Resend out, DKIM gate, Message-ID threading. | 2-3 days | Email in and out. |
| 7. Linear | Poll adapter. Agent-app mode later through a relay. | 2 days | Issues link to workstreams. |
| 8. Inbox view | Unified inbox and thread chips. | 2 days | One timeline for all sources. |

Total: about 17-22 working days. Phases 0-2 (6-8 days) give the main value.

Discord workstream decision: yes, fold it in. Keep the branch stopped and unmerged. Start phase 0 and 1 as a new workstream. Then rebase or restart the Discord branch as phase 2. Its Settings-page part moves to phase 3. This keeps Discord-specific code out of the core and makes Discord the proof that the interface works.

## 8. Risks

| Risk | Control |
|---|---|
| Prompt injection from external text | Sender allowlist and pairing. Grant check on every verb. External text fenced as data. |
| Duplicate inbound on reconnect | Platform event id as `event.key`, unique index. |
| Two processes open the same socket | Adapters start only on the primary bridge of the configured instance. |
| Token leak | Secrets in env or encrypted column. Never sent to agents. Never shown in UI. |
| Noise | Digest subscriptions. Per-kind toast preferences already exist in `shared/notifications.ts`. |
| Claude Code channels change | Orca does not depend on them. Only the access model is copied. |
