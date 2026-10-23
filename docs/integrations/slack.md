# Slack

The Slack adapter (`server/integrations/adapters/slack.ts`) connects Orca to Slack AS YOU. It uses
your user token, so every post from Orca is in your name. It reads your own events, so a message to
you can wake the orchestrator. The integrations core does the permission checks. See
[ADAPTERS.md](ADAPTERS.md).

- **In.** A message from another person reaches Orca when it is one of these:
  - a message that @-mentions you, in a public or private channel that you are in;
  - a DM to you;
  - a message in a group DM that you are in;
  - a reply in a thread where Orca already talks (a mention came there, or Orca posted there).
- **Out.** Orca posts only when the orchestrator tells it to: `orca post --reply`, `orca post
  --link …`, or `orca slack post`. Nothing posts by itself. There are no automatic replies and no
  read receipts. An unknown sender gets no pairing code in Slack (section 6).
- **Read.** The orchestrator reads history and searches messages with `orca slack` (section 7).

Your own messages never reach Orca. A post that Orca makes as you does not come back in.

The adapter uses [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/). The box
opens a WebSocket to Slack, so Slack needs no public URL. The client is plain Bun WebSocket code, with
no dependency, like the Discord adapter.

## 1. Tokens

| Token | Prefix | Variable | Use |
|---|---|---|---|
| User token | `xoxp-` | `SLACK_TOKEN` | Every Web API call: posts, reads, search, `auth.test`, `conversations.open`. |
| App-level token | `xapp-` | `SLACK_APP_TOKEN` | Only `apps.connections.open`, which gives the Socket Mode URL. Scope `connections:write`. |

- Both variables are in `ORCA_SECRETS` (`server/env.ts`). Orca removes them from the environment of
  agents, checks and previews, so a prompt injection cannot read them.
- Orca never logs a token and never stores one. A database row holds only the variable NAME.
- Without `SLACK_APP_TOKEN`, inbound is off. The adapter still posts, and its card says
  `inbound off: SLACK_APP_TOKEN is not set`. This is not an error.
- The card's Slack button (`POST /api/slack`) also uses `SLACK_TOKEN`. It does not change (section 8).

## 2. Set up the Slack app

Do these steps at <https://api.slack.com/apps>, in the app that gave you `SLACK_TOKEN`.

1. Open **OAuth & Permissions**.
2. Under **User Token Scopes**, add each scope in the table below.
3. Open **Socket Mode** and turn on **Enable Socket Mode**.
4. Open **Basic Information**. Under **App-Level Tokens**, click **Generate Token and Scopes**.
5. Name the token `socket`, add the scope `connections:write`, and click **Generate**.
6. Copy the `xapp-` token. This is `SLACK_APP_TOKEN`.
7. Open **Event Subscriptions** and turn on **Enable Events**. Socket Mode needs no Request URL.
8. Under **Subscribe to events on behalf of users**, add the four user events below.
9. Click **Save Changes**.
10. Open **Install App** and click **Reinstall to Workspace**. Accept the scopes.
11. Copy the new **User OAuth Token** (`xoxp-`). This is `SLACK_TOKEN`.

User token scopes:

| Scope | Why |
|---|---|
| `channels:history` | Read messages in public channels: events and `orca slack read`. |
| `groups:history` | Read messages in private channels. |
| `im:history` | Read DMs. |
| `mpim:history` | Read group DMs. |
| `channels:read`, `groups:read` | List channels: `orca slack conversations`, `#name` targets. |
| `im:read`, `mpim:read` | List DMs and group DMs. |
| `im:write`, `mpim:write` | Open a DM or group DM before a post to a person (`conversations.open`). |
| `chat:write` | Post as you. |
| `users:read` | Find names: the sender's name, `@name` targets. |
| `search:read` | `orca slack search`. |

User events (Event Subscriptions, on behalf of users):

| Event | Messages |
|---|---|
| `message.channels` | Public channels that you are in. |
| `message.groups` | Private channels that you are in. |
| `message.im` | Your DMs. |
| `message.mpim` | Your group DMs. |

Slack sends every message in these places to the socket. The adapter keeps only the messages in the
list at the top of this page, and drops all other messages at once. Nothing else is stored.

## 3. Put the tokens on the box

The bridge reads `/opt/orca/.env` at start. Do these steps on the instance that runs Slack.

1. Open a shell on the box as the `orca` user (SSM, or Settings > Instances > Open terminal).
2. Put the two lines in `/opt/orca/.env`:

   ```sh
   SLACK_TOKEN=xoxp-...
   SLACK_APP_TOKEN=xapp-...
   ```

3. Make sure only `orca` can read the file: `chmod 600 /opt/orca/.env`.
4. Restart the bridge: `sudo systemctl restart orca`.

Never put a token in `orca.config.ts`, in a database row, or in a commit.

## 4. Add the rows

Add the rows in Settings > Integrations. The values:

- **Integration.** Kind Slack. Secret variable `SLACK_TOKEN`. Instance: the box with the tokens, or
  Automatic. Only one bridge opens the socket.
- **DMs.** A link with the place `im` takes every DM to you. Each DM has its own channel id (`D…`),
  so one link on `im` covers all of them. Set **Require mention** off.
- **Group DMs.** A link with the place `mpim` takes every group DM.
- **Channels.** A link with a channel id (`C…`) takes mentions of you in that channel. Or use a
  catch-all link (`*`) for every channel, DM and group DM. A link on `im` or `mpim` wins over `*`.
- **People.** Add each person who may wake Orca, with their Slack user id (`U…`). Find it in their
  profile: ⋯ > Copy member ID. Or let them pair (section 6).

The same rows in SQL, for reference:

```sql
INSERT INTO integration (id, user_id, kind, name, instance, config, secret_ref, created_at)
VALUES ('slack', 'me', 'slack', 'Slack (as Finn)', 'cloud', '{}', 'SLACK_TOKEN', 0);

INSERT INTO channel_link (id, user_id, integration_id, external_id, label, level, require_mention)
VALUES ('slack-dm', 'me', 'slack', 'im', 'DMs', 'ask', false),
       ('slack-group', 'me', 'slack', 'mpim', 'Group DMs', 'ask', false),
       ('slack-all', 'me', 'slack', '*', 'Mentions', 'ask', true);
```

Optional `config` keys on the integration row:

| Key | Default | Effect |
|---|---|---|
| `appTokenRef` | `"SLACK_APP_TOKEN"` | The variable of the app-level token. It must start with `ORCA_SECRET_` or be in `ORCA_SECRETS`. |
| `socket` | on | `false` turns inbound off. The adapter then only posts. |

## 5. Check it

1. Open Settings > Integrations. The Slack card must say `Socket Mode connected as <you>`.
2. Ask a person to send you a DM.
3. The orchestrator wakes with the message, fenced as an outside message with the link's grant.
4. The orchestrator answers with `orca post --reply`. The answer shows in the DM, as you.

If the card shows an error, these are the usual causes:

- `inbound off: SLACK_APP_TOKEN is not set`: add the app-level token (section 3).
- `Slack refused the user token (auth.test: invalid_auth)`: `SLACK_TOKEN` is wrong or revoked.
- `Slack refused the app-level token (invalid_auth); check SLACK_APP_TOKEN and that Socket Mode is on`.
- No events with a connected socket: check the four user events (section 2, step 8) and reinstall.

## 6. How messages map

| Slack | Orca |
|---|---|
| A channel message with `<@you>` | One event. `<@you>` becomes `@<your name>` in the text. The thread is `<channel>:<ts>`, so the answer goes in a thread on the message. |
| A channel message with no mention | Dropped in the adapter. |
| A reply in a thread Orca talks in | One event in that thread, with no mention needed. |
| A DM | One event. Source `D…`, place `im`. The thread is the DM itself, so the answer goes in the DM. |
| A group DM | One event. Source `G…`, place `mpim`. The answer goes in the group DM. |
| A message in a thread of a DM | One event in the thread `<channel>:<thread_ts>`. |
| Your own message, a bot, an edit, a delete, a join | Dropped. |

- **Key:** `slack:<team>:<channel>:<ts>`. Slack sends an envelope again when it gets no ack. The
  core sees the same key and records one event.
- **Ack:** the adapter acks every envelope at once, also one that it drops.
- **Reconnect:** on `disconnect` (Slack refreshes the link every few hours) the adapter opens a new
  socket at once. On a dropped socket or a failed `apps.connections.open` it waits 1 s, then 2 s,
  4 s … up to 60 s. A `Retry-After` from Slack wins when it is longer. A bad app token stops it.
- **Pairing:** an unknown sender gets a pairing code in the bell only. Orca does not send them the
  code, because a post on Slack is in your name. Approve the code, then ask them to send the
  message again.

## 7. The orchestrator's verbs

```
orca slack conversations [--types im,mpim,public,private] [--limit 100]
orca slack read <target> [--thread <ts>] [--limit 20]
orca slack search "<query>" [--limit 20]
orca slack post <target> [--thread <ts>] "<text>"
```

A target is one of these:

- a channel id: `C…` (public), `G…` (private or group DM), `D…` (DM);
- `#name`: a channel that you are in;
- a user id `U…` or `@name`: the DM with that person (Orca opens it);
- a comma list of users, for example `@ana,@ben` or `U1,U2`: the group DM with them.

- `read` prints messages oldest first, with the sender, the `ts` and the thread size. Use the `ts`
  with `--thread` to read the replies, or to post a reply.
- `search` takes Slack's search syntax, for example `in:#eng from:@ana deploy`.
- `post` posts as you and prints the `ts`. The bridge logs one `[slack]` line with the place and
  the `ts`. It never logs the text.
- A refusal for a missing scope names the scope.

Every `orca slack` verb works only from your own chat (the full grant). A wake from an outside
sender cannot read your Slack or post as you to another place. It answers with `orca post --reply`,
which goes back to the place and thread that the message came from.

## 8. The card's Slack button (unchanged)

The card's Actions > Slack > Send message calls `POST /api/slack`. It posts one message, as you,
to the repo's `slackChannel`, with `SLACK_TOKEN`. It does not use the queue or the adapter's DM
lookup. If the post fails, the card shows the error and copies the message to your clipboard.
