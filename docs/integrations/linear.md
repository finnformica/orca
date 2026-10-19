# Linear

The Linear adapter (`server/integrations/adapters/linear.ts`) connects one Linear workspace to Orca.
It is phase 7 of [the integrations design](../research/integrations.md). It follows the adapter
contract in [ADAPTERS.md](ADAPTERS.md).

- Inbound: a poll on the Linear GraphQL API. No webhook and no public URL.
- Outbound: a comment on the issue an event came from (`orca post --reply`), or on an issue that is
  linked to a workstream.
- The API key is in an environment variable. The orca repo is public, so never put the key in a file
  in the repo.

## 1. What comes in

Every `pollSeconds` (default 60), the adapter reads the issues and the comments that changed after
the cursor. The cursor is the newest `updatedAt` that it read. It is in `integration_cursor`.

| Linear change | Key |
|---|---|
| An issue is assigned to you. | `linear:<integration>:issue:<issue id>:assigned` |
| An issue description mentions you (`@name`). | `linear:<integration>:issue:<issue id>:mention` |
| Another person comments on an issue assigned to you. | `linear:<integration>:comment:<comment id>` |
| A comment mentions you. | the same |

- Every event has the topic `ext.linear.message`. The core sends it to the orchestrator with no
  subscription.
- "You" is the owner of the API key. Set `config.userId` to watch a different Linear user.
- One issue gives one event for each reason. A later edit of the issue is not a new event.
- Your own comments do not come in. Orca posts with your key, so its own comments do not come back.
- Each event has `thread = { adapter: "linear", externalId: <issue id> }`. A comment event also has
  `thread.messageId`: the top-level comment of its conversation. Linear nests one level only, so a
  reply to a reply has the same `messageId` as its parent.
- An event has no `actor`. A poller is a machine sender, so the grant is the link's level. Linear
  never gets a pairing code.
- `display` names the person and the issue (`ENG-12 Fix the login page`). Only the chat and the
  inbox read it. The gate does not read it.
- `mentioned` is true on an issue event and on a comment that mentions you. A link with
  `require_mention` takes only those.
- The first start reads from now. Set `config.lookbackMinutes` to read older changes on the first start.
- A poll reads at most 10 pages of 50 rows for each list. The cursor then stops at the newest row it
  read, and the next poll reads the rest.

## 2. In the orchestrator's chat

Each Linear event is one activity row in the orchestrator's chat, as for Discord:

- the Linear logo and the person's name (the comment's author, or the issue's creator);
- the issue key and title as the place;
- the first line of the comment (or `Assigned to <you>: <title>`) as the preview;
- "Open in Linear", which opens the comment or the issue.

The orchestrator reads the event as fenced data with its grant. The fence names the sender as
`an unpaired linear user (<name>)`.

## 3. Links: a team or a project to repos

The place of an event is the issue's project, then its team:

- `project:<project id>` when the issue is in a project.
- `team:<team key>` (for example `team:ENG`).

The core tries the project link first, then the team link, then the catch-all link (`*`). A place
with no link is rejected. The link's `repos` and `level` set what Orca may do for the event
([ADAPTERS.md](ADAPTERS.md) section 7).

- `ask`: the orchestrator reads and answers. It cannot start or steer work.
- `work`: the orchestrator can also `orca spawn` and `orca send` on the link's repos. The worker
  runs in scoped mode, as for Discord.
- To find a project id, open the project in Linear. Press Cmd K, and select "Copy model UUID".
- The team key is the prefix of the team's issue identifiers (`ENG` in `ENG-123`).

**Security:** a comment from any person in the workspace gets the link's level. On a shared
workspace, use `ask`, or `work` only on a team that you trust.

## 4. What goes out

### A reply on the same issue

The orchestrator answers the event that woke it with this command:

```bash
orca post --reply "On it. I opened a PR for this."
```

- The comment goes on the same issue, as you (the key's owner).
- An answer to a comment goes under that comment's top-level comment (`parentId`).
- An answer to an assignment or a description mention is a top-level comment.
- The inbox's Reply does the same.

### PR state on a linked issue

Link an issue to a workstream. The orchestrator does it with this command:

```bash
orca thread link linear <issue id> --repo <repo> --branch <branch> --link <link id>
```

- `<issue id>` is the issue's UUID. Every Linear event prints it (`Issue id for orca thread link linear: …`).
- `--link` is required for outbound. The core finds a workstream's thread by its link.
- After the link, a comment on the issue goes to the workstream when the grant is `work` on its repo.

Then a subscription to that link sends the workstream's events to the issue as comments. For
example, `orca.pr.*` posts the PR state: CI failed, conflicts, merged.

- The comment is markdown: the title as a bold link, then the text.
- The comment id comes from the delivery id. A second send of the same delivery does not make a
  second comment.
- An event of a workstream with no linked issue is skipped. It is not an error.
- `caps.edits` is true: an edit uses `commentUpdate`.

## 5. Setup on your box

Do these steps on the box that runs the adapter. The box needs no public URL: the adapter polls.

1. In Linear, open Settings > Account > Security & access. Create a personal API key.
2. On the box, add the key to Orca's `.env` (or the systemd unit):

   ```bash title=.env
   ORCA_SECRET_LINEAR=lin_api_...
   ```

   Agents never see an `ORCA_SECRET_*` variable. Never put the key in a file in the repo.
3. Restart the bridge, so that it reads the new variable:

   ```bash
   sudo systemctl restart orca
   ```

4. In Orca, open Settings > Integrations. Click Connect, and select Linear.
5. Fill in the form:
   - Id: `linear`. Name: `Linear`.
   - Instance: your box (or Automatic).
   - Secret variable: `ORCA_SECRET_LINEAR`.
   - Poll every (seconds): empty for 60.
6. Save. Wait for the next sync (at most one minute).
7. Click Test on the Linear card. The result is `OK · signed in as <your name>`.
8. On the card, click ⋯ > Add team or project. Add one link:
   - External id: `team:ENG` (your team key), `project:<id>`, or `*` for all of Linear.
   - Level: `ask`, or `work` with the repos that the orchestrator may change.
   - Require mention: off.
9. Optional: send PR state to linked issues. Add a subscription with the "PR events" preset on
   that link.

The card shows:

- the key: `ORCA_SECRET_LINEAR · set` or `not set`;
- `Connected 2h · last event 3m ago · last poll 1m ago`;
- the Test result.

A bad key does not start the adapter. The card shows the error.

To check, assign an issue to yourself in a linked team. In one poll, an activity row with the Linear
logo comes into the orchestrator's chat.

## 6. Configuration

| `config` key | Default | Meaning |
|---|---|---|
| `pollSeconds` | 60 | The time between two polls. The minimum is 10. |
| `userId` | the key's owner | The Linear user whose issues and mentions come in. |
| `lookbackMinutes` | 0 | On the first start only, read the changes of this many minutes before now. |
| `machineEventsOnNotify` | false | Let events through on a `notify` link. They go to subscriptions only, never to the orchestrator or a workstream ([ADAPTERS.md](ADAPTERS.md) section 7). |

## 7. Limits

- Linear allows 1,500 requests each hour for an API key. A poll uses 2 requests (more for more
  than 50 changes). A `RATELIMITED` answer makes the poll and the send wait.
- A mention is `@<display name>` or a link to the user's profile. The full name with a space does
  not match.
- An `orca post` with no issue (no `--reply`, no linked thread) is skipped. Linear has no channel to post in.

## 8. Not in this adapter: agent-app mode

Linear [agent sessions](https://linear.app/developers/agents) let a person assign an issue to an app
or mention the app (`actor=app`, the `app:assignable` and `app:mentionable` scopes). Linear sends
those events only by webhook. Orca has no public URL, so this mode needs a relay (for example
Hookdeck) and an adapter with `inbound: "relay"`. It is a later branch. The poll adapter acts as
your own user, not as an app.
