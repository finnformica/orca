# Slack

The Slack adapter (`server/integrations/adapters/slack.ts`) connects Orca to Slack AS YOU. It uses
ONE token, your user token `SLACK_TOKEN` (`xoxp-`). Every post from Orca is in your name. Orca reads
Slack as you each minute, so a message to you can wake the orchestrator. The integrations core does
the permission checks. See [ADAPTERS.md](ADAPTERS.md).

- **In.** A message from another person reaches Orca when it is one of these:
  - a message that @-mentions you, in a public or private channel that you are in;
  - a DM to you;
  - a message in a group DM that you are in;
  - a reply in a thread where Orca already talks (a mention came there, or Orca posted there).
- **Out.** Orca posts only when the orchestrator tells it to: `orca post --reply`, `orca post
  --link …`, or `orca slack post`. Nothing posts by itself. There are no automatic replies and no
  read receipts. An unknown sender's message is read-only (section 6).
- **Read.** The orchestrator reads history and searches messages with `orca slack` (section 7).

Your own messages never reach Orca. A post that Orca makes as you does not come back in.

The box only calls the Slack Web API. Slack needs no public URL, no app-level token and no Socket
Mode. Socket Mode stays as an option (section 9).

## 1. The token

| Token | Prefix | Variable | Use |
|---|---|---|---|
| User token | `xoxp-` | `SLACK_TOKEN` | Every call: the poll, posts, reads, search, `auth.test`, `conversations.open`. |

- `SLACK_TOKEN` is in `ORCA_SECRETS` (`server/env.ts`). Orca removes it from the environment of
  agents, checks and previews, so a prompt injection cannot read it.
- Orca never logs the token and never stores it. A database row holds only the variable NAME.
- The card's Slack button (`POST /api/slack`) also uses `SLACK_TOKEN`. It does not change (section 8).

## 2. Set up the Slack app

The only setup: add user scopes to the app that gave you `SLACK_TOKEN`, then reinstall it.

1. Open <https://api.slack.com/apps> and select the app.
2. Open **OAuth & Permissions**.
3. Under **User Token Scopes**, add each new scope in the table below.
4. Open **Install App** and click **Reinstall to Workspace**. Accept the scopes.
5. Copy the **User OAuth Token** (`xoxp-`). This is `SLACK_TOKEN`. It can be the same value as before.

User token scopes (new ones first):

| Scope | New | Why |
|---|---|---|
| `channels:history` | yes | Read public channels: thread replies, `orca slack read`. |
| `groups:history` | yes | Read private channels. |
| `im:history` | yes | Read your DMs: the DM poll. |
| `mpim:history` | yes | Read your group DMs. |
| `im:read`, `mpim:read` | yes | List your DMs and group DMs: the DM poll. |
| `im:write`, `mpim:write` | yes | Open a DM or group DM before a post to a person (`conversations.open`). |
| `search:read` | yes | Find mentions of you: the mention poll, `orca slack search`. |
| `identify` | no | `auth.test`: who you are. |
| `channels:read`, `groups:read` | no | List channels: `orca slack conversations`, `#name` targets. |
| `users:read` | no | Names: the sender's name, `@name` targets. |
| `chat:write` | no | Post as you. |

Do not turn on Event Subscriptions or Socket Mode for this setup.

## 3. Put the token on the box

The bridge reads `/opt/orca/.env` at start. Do these steps on the instance that runs Slack.

1. Open a shell on the box as the `orca` user (SSM, or Settings > Instances > Open terminal).
2. Put the line in `/opt/orca/.env` (replace the old value if the token changed):

   ```sh
   SLACK_TOKEN=xoxp-...
   ```

3. Make sure only `orca` can read the file: `chmod 600 /opt/orca/.env`.
4. Restart the bridge: `sudo systemctl restart orca`.

Never put a token in `orca.config.ts`, in a database row, or in a commit.

## 4. Add the rows

Add the rows in Settings > Integrations. The values:

- **Integration.** Kind Slack. Secret variable `SLACK_TOKEN`. Instance: the box with the tokens, or
  Automatic. Only one bridge polls.
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
| `pollSeconds` | `60` | The time between two polls. The minimum is 15. |
| `historyBudget` | `20` | At most this many DM reads and thread reads in each poll. |
| `inbound` | `poll` | `off`: the adapter only posts. `socket`: Socket Mode (section 9). Unset: Socket Mode when `SLACK_APP_TOKEN` is set, else `poll`. |
| `appTokenRef` | `"SLACK_APP_TOKEN"` | Socket Mode only: the variable of the app-level token. |

## 5. Check it

1. Open Settings > Integrations. The Slack card must say `polling every 60s as <you>` and `last poll`.
2. Ask a person to send you a DM.
3. In one minute or less, the orchestrator wakes with the message. It is fenced as an outside
   message with the link's grant.
4. The orchestrator answers with `orca post --reply`. The answer shows in the DM, as you.

If the card shows an error, these are the usual causes:

- `Slack refused the user token (auth.test: invalid_auth)`: `SLACK_TOKEN` is wrong or revoked.
- `poll: search.messages: missing_scope`, or another method: add the scope (section 2) and reinstall.
- `poll: … ratelimited`: Slack limits the calls. The next poll waits for Slack's `Retry-After`.

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

- **Key:** `slack:<team>:<channel>:<ts>`. A message that Orca reads two times has one key, so the
  core records one event.
- **Unknown senders:** a message from a person who is not paired is read-only. It shows in the
  bell, the Inbox and the chat (Notify me). It wakes the orchestrator to tell you about it (Notify
  agent). The orchestrator does not act on it and does not reply in your name. Add the sender as
  a person to give them a grant.

## 6a. How the poll works

Each poll (every `pollSeconds`) does three reads:

1. **DMs and group DMs.** `conversations.list` (types `im,mpim`, kept for 5 minutes) gives your
   conversations. `conversations.history` reads each one from its last-seen `ts`.
   - Slack does not tell a user token which DM has a new message. So a DM with a message in the
     last 24 hours is read on every poll. The other DMs are read in turns.
   - Each poll makes at most `historyBudget` DM reads. A message in a quiet DM can come some minutes
     late. It is never lost, because each DM keeps its own `ts`.
2. **Mentions.** `search.messages` for `<@you>`, sorted by time, newest first. It reads back to the
   last-seen mention less 5 minutes, because search finds a new message late. A mention that it
   reads again has the same key, so the core drops it. A mention in a DM is left to step 1.
3. **Threads.** `conversations.replies` for each thread where Orca talks, from its last-seen `ts`.
   A thread with no activity for 7 days drops out. At most 200 threads are kept.

The **cursor** holds every last-seen `ts` and the threads. It is one JSON value in
`integration_cursor`, so a restart does not read a message again and does not miss one. The first
start begins at that moment and reads no history.

**Rate limits.** A poll makes one list call (each 5 minutes), one to three search calls and at most
two times `historyBudget` read calls. This is below Slack's limits for these methods (Tier 2 and
Tier 3). If Slack answers 429, the poll stops at once. The next poll waits for Slack's `Retry-After`.
Nothing moves the cursor past a message that was not read.

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

## 9. Optional: Socket Mode

Polling needs only `SLACK_TOKEN`. Socket Mode gives events at once instead of each minute. It needs
more setup, so it is off unless you set `SLACK_APP_TOKEN`.

1. In the app, open **Socket Mode** and turn on **Enable Socket Mode**.
2. Open **Basic Information**. Under **App-Level Tokens**, click **Generate Token and Scopes**.
3. Add the scope `connections:write` and click **Generate**. Copy the `xapp-` token.
4. Open **Event Subscriptions** and turn on **Enable Events**.
5. Under **Subscribe to events on behalf of users**, add `message.channels`, `message.groups`,
   `message.im` and `message.mpim`. Click **Save Changes**.
6. Reinstall the app.
7. Put `SLACK_APP_TOKEN=xapp-...` in `/opt/orca/.env` and restart the bridge.

- The card then says `Socket Mode connected as <you>`.
- The adapter acks every envelope at once, also one that it drops.
- On `disconnect` it opens a new socket at once. On a drop it waits 1 s, then 2 s, up to 60 s.
- A bad app token stops it: `Slack refused the app-level token`.
- `SLACK_APP_TOKEN` is in `ORCA_SECRETS` too.
- Set `inbound: "poll"` on the row to poll even when `SLACK_APP_TOKEN` is set.
