# Slack: set up the receive-only adapter

**The Slack adapter is receive-only, by rule.** The adapter reads Slack. It never sends anything
to Slack: no `chat.postMessage`, no `chat.update`, no thread reply, no reaction. Finn set this rule.

The rule is for the adapter only (the bot over Socket Mode). Two things keep their Slack features:

- **The card's Slack button.** Actions > Slack > Send message (or Send bump) calls `POST /api/slack`.
  The bridge posts the message as you, with your user token (`SLACK_TOKEN`), to the repo's
  `slackChannel` (`server/slack-api.ts`). branch-demo PRs use this. See section 9.
- **A managed repo.** A repo that Orca manages keeps its own Slack code. Do not change it for this rule.

The adapter:

- **In.** A mention of the bot or a DM to the bot becomes an `ext.slack.message` event. The core
  gates it and routes it to the orchestrator, or to the workstream that owns the thread. The message
  shows in Orca and in the inbox.
- **Out.** Nothing from the adapter. The orchestrator answers in Orca only. The sender does not see
  the answer in Slack.

The rule has four guards:

1. The core drops every delivery to a Slack link (`RECEIVE_ONLY` in `shared/integrations.ts`).
2. Settings > Integrations refuses a subscription or a Test to a Slack link.
3. `orca post --link` to Slack is refused. `orca post --reply` on a Slack event keeps the answer in Orca.
4. The adapter's `send` refuses, and `slackApi` refuses every write method before a request.

These guards stop the adapter and the core. They do not touch the card's Slack button (section 9).

The adapter uses [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/). The box
opens a WebSocket to Slack. Slack does not need a public URL, so the box stays without ingress.

The code is `server/integrations/adapters/slack.ts`. The contract is
[ADAPTERS.md](ADAPTERS.md).

## 1. Tokens

| Token | Prefix | Variable | Use |
|---|---|---|---|
| Bot token | `xoxb-` | `ORCA_SECRET_SLACK_BOT` | Read calls only: `auth.test` and `users.info`. |
| App-level token | `xapp-` | `ORCA_SECRET_SLACK_APP` | `apps.connections.open`, which gives the Socket Mode URL. Scope `connections:write`. |

The adapter does not use a user token (`xoxp-`). The card's Slack button uses one: `SLACK_TOKEN`
(section 9). The adapter never reads it.

Every `ORCA_SECRET_*` variable and `SLACK_TOKEN` is removed from the environment of agents, checks and previews
(`server/env.ts`). A prompt injection cannot read these tokens.

## 2. Create the Slack app

1. Open <https://api.slack.com/apps>.
2. Click **Create New App**, then **From an app manifest**.
3. Select the workspace.
4. Paste the manifest below. Change `name` if you want a different bot name.
5. Click **Create**.

```yaml
display_information:
  name: Orca
  description: Orca reads mentions and DMs. It never posts.
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Orca
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - groups:history
      - im:history
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

The scopes:

| Scope | Why |
|---|---|
| `app_mentions:read` | Receive `app_mention` events. |
| `channels:history`, `groups:history` | Receive channel messages in public and private channels. A link with `require_mention` keeps only mentions. |
| `im:history` | Receive DMs to the bot. |
| `users:read` | Find a person's display name for pairing (`resolveUser`). |

`messages_tab_enabled` lets a person send a DM to the bot. Do not add `chat:write`. Without it,
Slack itself refuses a post from the bot.

## 3. Get the two tokens

1. In the app, open **Basic Information**.
2. Under **App-Level Tokens**, click **Generate Token and Scopes**.
3. Name it `socket`, add the scope `connections:write`, and click **Generate**.
4. Copy the `xapp-` token. This is `ORCA_SECRET_SLACK_APP`.
5. Open **Install App** and click **Install to Workspace**. Accept the scopes.
6. Copy the **Bot User OAuth Token** (`xoxb-`). This is `ORCA_SECRET_SLACK_BOT`.
7. In each channel that Orca must read, type `/invite @Orca`.

## 4. Put the tokens on the box

The bridge reads `/opt/orca/.env` at start (the unit's `WorkingDirectory`). Do these steps on the
instance that runs Slack (the work box).

1. Open a shell on the box as the `orca` user (SSM, or the instance web terminal).
2. Add the two lines to `/opt/orca/.env`:

   ```sh
   ORCA_SECRET_SLACK_BOT=xoxb-...
   ORCA_SECRET_SLACK_APP=xapp-...
   ```

3. Make sure only `orca` can read the file: `chmod 600 /opt/orca/.env`.
4. Restart the bridge: `sudo systemctl restart orca`.

Never put a token in `orca.config.ts`, in a database row, or in a commit. The repo is public. A row
holds only the variable NAME.

## 5. Add the rows

Add the rows in Settings > Integrations, or with SQL on the Orca database. Set `instance` to the
`ORCA_INSTANCE` of the box that holds the tokens. Only the primary bridge of that instance opens the
socket. `user_id` is `db.currentUser()` (`ORCA_USER`, else `me`).

```sql
-- The connection. secret_ref names the bot token's variable.
INSERT INTO integration (id, user_id, kind, name, instance, config, secret_ref, created_at)
VALUES ('slack-work', 'me', 'slack', 'Work Slack', 'cloud', '{}', 'ORCA_SECRET_SLACK_BOT', 0);

-- A channel Orca reads. Find the id in the channel's details (C...).
INSERT INTO channel_link (id, user_id, integration_id, external_id, level, require_mention)
VALUES ('eng', 'me', 'slack-work', 'C0123456789', 'ask', true);

-- Every DM to the bot. The external id is the fixed word 'im'. (Without it, a '*' link catches DMs.)
INSERT INTO channel_link (id, user_id, integration_id, external_id, level, require_mention)
VALUES ('slack-dm', 'me', 'slack-work', 'im', 'ask', false);

-- Each person who may write to Orca, by Slack user id (U...: profile → ⋯ → Copy member ID).
INSERT INTO principal (id, user_id, name, max_level) VALUES ('finn', 'me', 'Finn', 'work');
INSERT INTO identity (user_id, principal_id, adapter, external_id) VALUES ('me', 'finn', 'slack', 'U0123456789');
```

You can also skip the `principal` and `identity` rows and pair a person instead:

1. The person mentions the bot or sends it a DM.
2. Orca drops the message. It does NOT reply in Slack (receive-only).
3. Orca shows a "Pairing request" row with a 6-character code in the bell.
4. Approve the code in Settings > Integrations, or with
   `curl -X POST localhost:8787/api/integrations/pairing/approve -d '{"code":"ABC234","maxLevel":"ask"}'`.
5. Tell the person yourself to send the message again.

`GET /api/integrations/pairing` lists the codes that wait. A code expires after 60 minutes.

The primary bridge reads the rows each minute. You do not need a restart.

Optional `config` keys on the `integration` row:

| Key | Default | Effect |
|---|---|---|
| `appTokenRef` | `"ORCA_SECRET_SLACK_APP"` | The app-level token's variable. It must start with `ORCA_SECRET_`. |
| `socket` | `true` | `false` turns inbound off. The adapter then does nothing. |

## 6. Check it

1. Open `GET /api/integrations` on the box. `running.slack-work` must show
   `ok: true` and `Socket Mode connected as U...`.
2. In a linked channel, type `@Orca what is on the board?`.
3. The orchestrator wakes with the message fenced as an outside message with the `ask` grant.
4. The answer shows in Orca: in the orchestrator's chat and, from `orca post --reply`, in the
   inbox. Nothing appears in Slack.

If the adapter does not start, `integration.status.error` holds the reason. Some examples:

- `ORCA_SECRET_SLACK_APP is not set (the app-level token, for Socket Mode)`
- `auth.test: invalid_auth`: the bot token is wrong or revoked.
- `apps.connections.open: invalid_auth`: the app-level token is wrong, or Socket Mode is off.

## 7. How events map

| Slack | Orca |
|---|---|
| `app_mention`, or a `message` that contains `<@bot>` | `mentioned: true`. The bot tag is removed from the text. |
| A `message` with `channel_type: im` | Source channel `im` (the DM link), `mentioned: true`. |
| Any other channel `message` | `mentioned: false`. A link with `require_mention` drops it. |
| A bot's post, an edit, a delete, a join | Ignored. |

- **Key:** `slack:<team>:<channel>:<ts>`. Slack sends a mention twice (`app_mention` and `message`).
  Both have one key, so the core records one event. A resent envelope is also a duplicate.
- **Thread:** `<channel>:<thread_ts>`, or `<channel>:<ts>` for a top-level message. Messages in one
  Slack thread are one conversation in Orca. `messageId` is the message's own `ts`.

## 8. Limits

- **Ack.** The adapter acks each envelope at once. Slack resends an envelope with no ack after 3 s.
- **Reconnect.** On `disconnect` or a closed socket the adapter opens a new one: 1 s, doubling to
  30 s. A `Retry-After` from Slack wins when it is longer.
- **Rate limits.** A `429` on `apps.connections.open` delays the next connect by Slack's `Retry-After`.
- **One socket.** Only the primary bridge of `integration.instance` starts the adapter. Slack allows
  up to 10 Socket Mode connections for each app, but Orca opens one.
- **No output.** `caps` say `outbound: false`, `threads: false`, `edits: false`, `reactions: false`.
  This is the rule, not a missing feature. Do not add an outbound path to the adapter.

## 9. The card's Slack button (post as you)

This path is not the adapter. It posts one message, as you, when you click.

1. Set `slackChannel` on the repo in `orca.config.ts` (for example `#eng`).
2. Turn on `features.slack` for the repo.
3. Put your user token in the `.env` of the instance that you click from: `SLACK_TOKEN=xoxp-...`.
   The token needs the user scope `chat:write`.
4. Open a PR card. Click Actions > Slack > Send message. Later, click Send bump.

- The bridge sends the text with no changes to `chat.postMessage` (`server/slack-api.ts`).
- If the post fails, the card shows the error and copies the message to your clipboard.
- A failed post does not mark the PR as announced.
- The orchestrator cannot use this path. `orca post` refuses a Slack link.
