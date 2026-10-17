# Linear

The Linear adapter (`server/integrations/adapters/linear.ts`) connects one Linear workspace to Orca.
It is phase 7 of [the integrations design](../research/integrations.md). It follows the adapter
contract in [ADAPTERS.md](ADAPTERS.md).

- Inbound: a poll on the Linear GraphQL API. No webhook and no public URL.
- Outbound: a comment on the Linear issue that is linked to a workstream.
- The API key is in an environment variable. The orca repo is public, so never put the key in a file
  in the repo.

## 1. What comes in

Every `pollSeconds` (default 60), the adapter reads the issues and the comments that changed after
the cursor. The cursor is the newest `updatedAt` that it read. It is in `integration_cursor`.

| Linear change | Event | Key |
|---|---|---|
| An issue is assigned to the user. | `ext.linear.issue` | `linear:<integration>:issue:<issue id>:assigned` |
| An issue description mentions the user (`@name`). | `ext.linear.issue` | `linear:<integration>:issue:<issue id>:mention` |
| Another person comments on an issue assigned to the user. | `ext.linear.message` | `linear:<integration>:comment:<comment id>` |
| A comment mentions the user. | `ext.linear.message` | the same |

- The user is the owner of the API key. Set `config.userId` to watch a different Linear user.
- One issue gives one event for each reason. A later edit of the issue is not a new event.
- The user's own comments do not come in. Orca posts with the same key, so its own comments do not
  come back.
- Each event has `thread = { adapter: "linear", externalId: <issue id> }`. A comment event also has
  `thread.messageId = <comment id>`.
- An event has no `actor`. A poller is a machine sender, so the grant is the link's level. Linear
  never gets a pairing code.
- `mentioned` is true on a comment that mentions the user. A link with `require_mention` takes only
  those comments.
- The first start reads from now. Set `config.lookbackMinutes` to read older changes on the first start.
- A poll reads at most 10 pages of 50 rows for each list. The cursor then stops at the newest row it
  read, and the next poll reads the rest.

## 2. Links: a team or a project to repos

The place of an event is the issue's project, then its team:

- `project:<project id>` when the issue is in a project.
- `team:<team key>` (for example `team:ENG`).

The core tries the project link first, then the team link, then the catch-all link (`*`). A place
with no link is rejected. The link's `repos` and `level` set what Orca may do for the event
([ADAPTERS.md](ADAPTERS.md) section 7).

- To find a project id, open the project in Linear. Press Cmd K, and select "Copy model UUID".
- The team key is the prefix of the team's issue identifiers (`ENG` in `ENG-123`).

## 3. Where events go

- `ext.linear.message` (a comment) goes to the orchestrator by default. If its issue is linked to a
  workstream and the grant is `work` on that repo, it goes to the workstream as a follow-up.
- `ext.linear.issue` goes only where a subscription sends it. Add a subscription to the orchestrator
  (section 5, step 5).

**Security:** a comment from any person in the workspace gets the link's level. A `work` link lets a
comment on a linked issue start a run on its workstream. Use `ask` when only the orchestrator must
read Linear.

## 4. What goes out

Link an issue to a workstream. The orchestrator does it with this verb:

```
orca thread link linear <issue id> --repo <repo> --branch <branch> --link <link id>
```

- `<issue id>` is the issue's UUID. Every Linear event prints it (`Linear issue id …`).
- `--link` is required for outbound. The core finds a workstream's thread by its link.

Then a subscription to that link sends the workstream's events to the issue as comments. For
example, `orca.pr.*` posts the PR state: CI failed, conflicts, merged.

- The comment is markdown: the title as a bold link, then the text.
- The comment id comes from the delivery id. A second send of the same delivery does not make a
  second comment.
- An event of a workstream with no linked issue is skipped. It is not an error.
- `caps.edits` is true: an edit uses `commentUpdate`.

## 5. Setup

Linear is not connected to a box yet. Do these steps on the instance that runs the adapter.

1. In Linear, open Settings > Account > Security & access. Create a personal API key.
2. Put the key in the instance's environment as `ORCA_SECRET_LINEAR`. Use `.env` or the systemd unit.
   Agents never see an `ORCA_SECRET_*` variable.
3. Restart the bridge, so that it reads the new variable.
4. Add the rows. Replace `cloud`, `ENG`, `orca` and the ids with your values:

```sql
INSERT INTO integration (id, user_id, kind, name, instance, config, secret_ref, created_at)
VALUES ('linear', 'me', 'linear', 'Linear', 'cloud', '{"pollSeconds": 60}', 'ORCA_SECRET_LINEAR', 0);
-- the ENG team works on the orca repo
INSERT INTO channel_link (id, user_id, integration_id, external_id, level, repos, require_mention)
VALUES ('linear-eng', 'me', 'linear', 'team:ENG', 'work', '{orca}', false);
```

5. Send assigned and mentioning issues to the orchestrator:

```sql
INSERT INTO subscription (user_id, topic_pattern, filter, target_kind)
VALUES ('me', 'ext.linear.issue', '{}', 'orchestrator');
```

6. Send PR state to linked issues:

```sql
INSERT INTO subscription (user_id, topic_pattern, filter, target_kind, target_id)
VALUES ('me', 'orca.pr.*', '{"repo":"orca"}', 'link', 'linear-eng');
```

7. Wait one minute. The primary bridge starts the adapter on its next sync.
8. Open `GET /api/integrations`. Make sure that `linear` runs and its status is ok.

A bad key does not start the adapter. The status of the `integration` row shows the error.

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
- The adapter does not post a comment on an issue that is not linked.

## 8. Not in this adapter: agent-app mode

Linear [agent sessions](https://linear.app/developers/agents) let a person assign an issue to an app
or mention the app (`actor=app`, the `app:assignable` and `app:mentionable` scopes). Linear sends
those events only by webhook. Orca has no public URL, so this mode needs a relay (for example
Hookdeck) and an adapter with `inbound: "relay"`. It is a later branch. The poll adapter acts as
your own user, not as an app.
