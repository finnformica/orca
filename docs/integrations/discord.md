# Discord

The Discord adapter (`server/integrations/adapters/discord.ts`) connects Orca to one Discord bot.
People in a linked channel can @mention the bot to ask a question or to start work. Orca posts
results back to the channel. The integrations core does the permission checks. See
[ADAPTERS.md](ADAPTERS.md).

One bot token must have only one Gateway session, because two sessions give each event twice.
Orca opens it on one primary bridge only:

- **Automatic** (the default, `integration.instance = '*'`): the primary bridge that holds the
  row's lease runs it. If that server stops, another server with the token takes over within
  about three minutes. See [ADAPTERS.md section 6.1](ADAPTERS.md#61-where-it-runs-automatic-or-pinned).
- **Pinned** (an instance name, for example the personal box): only that instance runs it.

Put `ORCA_SECRET_DISCORD_BOT` in the `.env` of each server that can run it. If no primary bridge
has it, the card says which servers do not have it.

## What the adapter does

- Inbound: a Gateway WebSocket with the intents `GUILDS`, `GUILD_MESSAGES`, `DIRECT_MESSAGES` and
  `MESSAGE_CONTENT`.
  - A message in a linked channel goes to the core. A message with no mention of the bot has
    `mentioned: false`. A link with `require_mention` drops it.
  - A mention of the bot's managed role is a mention too. Discord's autocomplete offers the bot
    user and this role, with the same name. The adapter finds the role from `GUILD_CREATE` (the
    role whose `tags.bot_id` is the bot), else from one `GET /guilds/<id>/roles`. It removes
    `<@&role id>` from the text, as it removes `<@bot id>`.
  - A message in a thread uses the link of the thread's parent channel. The thread is its
    conversation.
  - A new request is a mention at the top level of a channel. By default Orca replies in place: a
    Discord reply to the mention, in the same channel. It opens no thread. See
    [Reply in place or threads](#reply-in-place-or-threads).
  - A direct message (DM) goes to the link that `config.dmLink` names. With no `dmLink`, it goes to
    the integration's catch-all link (`external_id` `*`). With neither link, the core drops it.
  - An unknown person gets a pairing code from the core. The code is a reply to their message.
  - The adapter ignores messages from bots.
- Outbound: a post to the link's channel.
  - A catch-all link (`external_id` `*`) only receives. It names no channel, so nothing posts to
    it. A reply to a message on it goes to the DM or channel that the message came from. Test, a
    subscription and `orca post --link` refuse a catch-all link at once. The dispatcher ends an
    old delivery to `*` with the same error, and does not call Discord.
  - The first post for a workstream starts its conversation. The core keeps its thread id. Later
    posts for the workstream continue there, and a reply there goes to the workstream.
  - A post with a title is an embed (a linked title and a colour). This matches the build posts in
    the same server. A reply with no title is plain text.
  - An edit replaces the message (`PATCH`).
  - Posts never ping `@everyone`, roles or users (`allowed_mentions` is empty).
  - Rate limits: the core sends at most 5 messages each 5 seconds to one channel. A `429` is retried
    after Discord's `retry_after`.

## Replies and attachments

A message that mentions the bot (or a DM) carries more than its own text:

- **A reply quotes its parent.** The parent's author, text and attachments go in the envelope's
  text before the new message's own, as `> Name wrote: ...`. The adapter reads the parent from
  Discord's own embed (`referenced_message`), or with one REST read when Discord did not embed it.
  A reply that does not mention the bot quotes nothing, and makes no extra Discord call.
- **A text attachment's content is inlined**, in a fenced block under its filename: `.txt`, `.md`,
  `.json`, `.log`, `.csv`, `.yaml` and `.yml` files, and anything with a `text/*` content type. The
  adapter downloads the file itself — Discord's attachment URLs are signed and expire, so an agent
  could not fetch one later. A file over 100 KB is cut to that size, with a note saying so. This
  applies to the new message's own attachments and to a quoted parent's.
- Any other attachment (an image, a binary file) stays a URL line, as before.

## Reply in place or threads

The integration's `config.threads` sets what Orca does with a mention at the top level of a channel.

- `false` or absent (the default): Orca replies in place.
  - The answer is a Discord reply (`message_reference`, `fail_if_not_exists: false`) in the channel.
  - The conversation is the mention's reply chain. Its thread id is `<channel id>:<root message id>`.
    The root is the top message of the chain.
  - A person continues the conversation with a Discord reply to Orca's answer. A new mention with no
    reply starts a new conversation. So several conversations in one channel stay apart.
  - Each answer replies to the newest message in the chain.
  - A first post for a workstream starts its own reply chain, `<channel id>:<post id>`.
- `true`: the behaviour before reply in place. A mention gets its own thread, on that message. A
  first post for a workstream opens a thread on that post.

A mention inside a thread gets its answer in that thread. A DM gets its answer in the DM. The flag
does not change these two. A thread that Orca opened before you change the flag stays a thread.

### A thread for one answer

With the default, the orchestrator can open a thread for one answer when a thread helps. Examples
are a long answer, a job with many steps, a workstream, or a long conversation.

```bash
orca post --reply --thread "<text>"
orca post --reply --thread --repo <repo> --branch <branch> "<text>"
```

- The adapter opens a thread on the mention. It posts the answer in that thread.
- The thread is the conversation from then on. A message in the thread reaches the orchestrator,
  or the workstream when the thread is linked to one.
- With `--repo` and `--branch`, the thread becomes that workstream's thread on the link. A thread
  opened from a reply chain that was linked to a workstream keeps that link.
- If Discord refuses the thread (for example, no **Create Public Threads** permission), the answer
  is a reply in place.
- In a thread or a DM, `--thread` changes nothing.
- `orca post --link <id> --thread "<text>"` opens a thread on the post itself.

`config.threads` stays. It is for a server where each request must get a thread. `--thread` is
for one answer when the default is in place.

The adapter keeps the newest message of each chain in memory. After a restart it reads the chain
up from the reply (at most 25 messages, `Read Message History`). The first answer after a restart
replies to the root, because Orca does not know the newest message then.

To set the flag on a box, use Settings or SQL. A running adapter keeps its config until it starts
again, so restart it after the change.

1. Open **Settings → Integrations** on the box. Edit the Discord integration.
2. Type `true` in **Threads** for a thread for each request. Clear the field to reply in place.
3. Click **Save**.
4. Turn the integration off, then on. Or restart the bridge.

With SQL, update the row, then do step 4:

```sql
-- Reply in place (the default): remove the key.
UPDATE integration SET config = config::jsonb - 'threads' WHERE id = 'discord';
-- A thread for each request.
UPDATE integration SET config = config::jsonb || '{"threads": true}' WHERE id = 'discord';
```

## Create the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application**. Give it a name, for example `Orca`.
3. Open **Bot**. Click **Reset Token**. Copy the token. Keep it secret.
4. On the same page, turn on **Message Content Intent** (under Privileged Gateway Intents).
5. Open **OAuth2 → URL Generator**. Select the scope `bot`.
6. Select these bot permissions:
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Create Public Threads (for `config.threads` true, or `orca post --thread`)
   - Read Message History
7. Open the URL that the page gives. Add the bot to the server.
8. In Discord, open **User Settings → Advanced**. Turn on **Developer Mode**.
9. Right-click each channel that Orca uses. Click **Copy Channel ID**.
10. Right-click each person who may write to Orca. Click **Copy User ID**.

If the Message Content intent is off, the Gateway closes with code `4014`. The health line then
says so. The adapter does not reconnect after that code.

## Put the token on the box

1. On `orca-personal-box`, add the token to the bridge's environment (`.env` or the systemd unit):

   ```
   ORCA_SECRET_DISCORD_BOT=<the bot token>
   ```

2. Restart the bridge.

The orca repo is public. Never put the token in a file in the repo, in a config row or in a log.
The agent environment removes every `ORCA_SECRET_*` variable, so a worker cannot read it.

## Configure the rows

Until the Settings page lands, add rows with SQL. `user_id` is `db.currentUser()` (`ORCA_USER`, else
`me`). Replace the ids with the ids that you copied.

```sql
-- The bot. '*' is Automatic: one primary bridge with the token runs it.
INSERT INTO integration (id, user_id, kind, name, instance, config, secret_ref, created_at)
VALUES ('discord', 'me', 'discord', 'Discord', '*', '{}', 'ORCA_SECRET_DISCORD_BOT', 0);

-- A channel. "work" lets the people start and steer work on the listed repos.
INSERT INTO channel_link (id, user_id, integration_id, external_id, level, repos, require_mention)
VALUES ('site-templates', 'me', 'discord', '<channel id>', 'work', '{site-templates}', true);

-- A person, and their Discord identity. The grant is min(link level, max_level).
INSERT INTO principal (id, user_id, name, max_level) VALUES ('saajan', 'me', 'Saajan', 'work');
INSERT INTO identity (user_id, principal_id, adapter, external_id) VALUES ('me', 'saajan', 'discord', '<user id>');

-- What goes out: CI failures and merges of site-templates to the channel.
INSERT INTO subscription (user_id, topic_pattern, filter, target_kind, target_id)
VALUES ('me', 'orca.pr.*', '{"repo":"site-templates"}', 'link', 'site-templates');
```

Check the columns against `server/integrations/store.ts` before you run this. The core owns the
schema.

To accept DMs, add a catch-all link (`*`). It also covers each channel that has no link of its own.
A catch-all link only receives: Settings shows no Test for it, and nothing posts to it.

```sql
INSERT INTO channel_link (id, user_id, integration_id, external_id, level) VALUES ('discord-dm', 'me', 'discord', '*', 'ask');
```

To accept DMs only, give the link another `external_id` and name it in the integration's config:

```sql
INSERT INTO channel_link (id, user_id, integration_id, external_id, level) VALUES ('discord-dm', 'me', 'discord', 'dm', 'ask');
UPDATE integration SET config = '{"dmLink":"discord-dm"}' WHERE id = 'discord';
```

To let a new person in, approve their pairing code in Orca (`POST /api/integrations/pairing/approve`).
You can also add `principal` and `identity` rows by hand.

The primary bridge reads the rows each minute. `GET /api/integrations` shows the health line:
`connected as <bot name>`, or the reason it is down.

## Levels

| Level | What a person in the channel can do |
|---|---|
| `notify` | Nothing inbound. Orca only posts. |
| `ask` | Ask questions. Orca reads the board and past chats. |
| `work` | Also start and continue workstreams on the link's repos. |

The orchestrator's tool route checks each verb against the grant of the message. A Discord message
cannot start work on a repo that its link does not list.
