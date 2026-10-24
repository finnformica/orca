# Integration policy: access and events per connected account

Requested by Finn. This document gives every integration one policy. Discord, Slack, email,
Cloudflare and Gmail use it. An adapter does not make its own rules.

## 1. The model

A **connected account** is one `integration` row: one Slack user token, one Discord bot, one
mailbox, one Cloudflare account. One kind can have several rows (for example two Gmail accounts).
Each row has two settings:

| Setting | Values | What it controls |
|---|---|---|
| `access` | `read`, `read-write` | What Orca itself may do with the account. |
| `events` | `trigger`, `record`, `off` | What Orca does with an inbound event from the account. |

**Access.**

- `read`: Orca may run only the read verbs (search, read, list, a health check).
- `read-write`: Orca may also run the write verbs (post, send, reply, create, delete, provision).
- A verb that no adapter declares is a write verb. So a new verb is refused on a read account
  until its adapter declares it.

**Events.**

- `trigger`: an event shows to you and may wake an agent. This is the behaviour before this change.
- `record`: an event shows to you (the bell, the Inbox) and wakes no agent.
- `off`: the core records nothing from the account.

The two settings are independent. A read account can still trigger agents (an inbox that Orca
reads and acts on, but never answers from). A read-write account can have its events off (an
account that Orca posts from but does not listen to).

## 2. How the model maps onto what exists

Orca already has three permission layers. This policy adds one layer at the top. It does not
change the other three.

| Layer | Where | Answers the question |
|---|---|---|
| Account policy (new) | `integration.access`, `integration.events` | What may Orca do with this account? May its events wake an agent? |
| Link switches | `channel_link.notify_me`, `channel_link.notify_agent` | For this one place: show it to me? Wake an agent? |
| Link level | `channel_link.level` | The highest grant a message from this place gets. |
| Person level | `principal.max_level` | The highest grant this person gets. |

The rules between the layers:

- **Events narrow the link switches. They never widen them.** The core computes the switches of
  each inbound event as `effectiveNotify(link, events)`:
  - `notify.me = link.notifyMe && events != "off"`
  - `notify.agent = link.notifyAgent && events == "trigger"`
- A link with Notify agent off stays off on a `trigger` account. A link with Notify agent on is off
  on a `record` account.
- **Access is not a grant.** The grant (`notify` … `admin`, `full`) tells what an outside sender
  may make the orchestrator do. Access tells what Orca may do with the account, for every caller.
  This includes your own chat (the `full` grant). The core checks both. A verb must pass both.
- Cloudflare writes still need `--confirm`, and they are still yours alone (`grantRefusal`).
  `read-write` access does not remove these rules.

## 3. Where the core enforces it

There is ONE decision: `integrationAccessRefusal(account, verb, classes)` in
`shared/integrations.ts`. It is pure. The core calls it at each door where Orca uses an account:

| Door | Verb | File |
|---|---|---|
| `publish` with an explicit link delivery (`orca post`, the Inbox Reply) | `send`, or `delete` for `--delete` | `server/integrations/router.ts` |
| `publish` for a subscription to a link | `send` (the delivery is not planned) | `server/integrations/router.ts` |
| The dispatcher, before `Adapter.send` / `Adapter.delete` | `send`, `delete` | `server/integrations/dispatcher.ts` |
| A link's Test button | `send` | `server/integrations/admin.ts` |
| Every `orca <kind> <verb>` CLI verb (`orca slack`, `orca cloudflare`, later `orca gmail`) | the subcommand | `server/integrations/policy.ts` `useAccount` |

The dispatcher check is a backstop. It ends a delivery that was planned before you changed the
access. A subscription to a read account plans no delivery, so it makes no dead rows and no
`integration_failed` notifications.

The events setting has one door: `router.ingest` (the gate). It reads the account's `events` and
computes the switches with `effectiveNotify`. With both switches off, `ingest` returns
`"rejected"`. With only `notify.agent` off, it returns `"noted"`.

## 4. Verb classes: what an adapter declares

The core knows two adapter verbs: `send` and `delete` are writes, `health` is a read
(`CORE_VERBS`). A kind declares its CLI verbs in its registry meta:

```ts
register("slack", slackAdapter, { label: "Slack", caps: SLACK_CAPS, verbs: SLACK_VERBS, … });
// SLACK_VERBS = { conversations: "read", read: "read", search: "read", post: "write" }
```

A kind with a CLI verb but no adapter yet uses `registerVerbs(kind, verbs)` (Cloudflare in this
branch). When its adapter registers with `meta.verbs`, the meta wins.

## 5. Several accounts of one kind

The CLI verbs take `--account <id or name>`. `policy.useAccount(kind, verb, account)` picks the row:

1. With `--account`, it is the row whose id or name matches (case-insensitive). No match is an error
   that lists the accounts.
2. Without `--account` and with one row of the kind, it is that row.
3. Without `--account` and with several rows, it is an error that lists them. Orca never guesses.
4. With no row of the kind, the verb works as before this change: the token from the bridge's
   environment (`SLACK_TOKEN`, `ORCA_SECRET_CLOUDFLARE`) and no access rule. This keeps current
   setups working.

The row gives the token: the CLI reads the variable that the row's `secret_ref` names. A
Cloudflare row can also name its account id in `config.accountId`.

Settings shows Access and Events on each account's card. `orca channels` shows them on each link.

## 6. Finn's accounts

| Account | Access | Events | Effect |
|---|---|---|---|
| Slack (work) | `read-write` | `off` | `orca slack` reads and posts as you. No Slack message is recorded or wakes an agent. |
| Gmail (personal) | `read` | `off` | Orca may search and read. It may not send. Nothing is recorded. |
| Gmail (smfstudio.io) | `read` | `trigger` | Orca may search and read. A new mail wakes the orchestrator. Orca may not send or reply from it. |
| Discord | `read-write` | `trigger` | No change: the defaults are the behaviour before this change. |
| Cloudflare | `read-write` | `trigger` | Reads, and the writes behind `--confirm`. The adapter's events wake an agent. |

The Gmail and Cloudflare adapters come from other branches. Each adopts the policy with a small
change: register its verbs with `meta.verbs`, and call `policy.useAccount` in its CLI verb. Gmail
does this ([gmail.md](gmail.md)). It also sets `meta.policyDefaults` (`read`, `off`), so a new Gmail
row starts read only with no events, and its `access` chooses the OAuth scopes.

## 7. What changes

- Named step `20261024-integration-access-events` adds two columns to `integration`:
  `access TEXT NOT NULL DEFAULT 'read-write'` and `events TEXT NOT NULL DEFAULT 'trigger'`, each with
  a CHECK. It is two columns and two constraints, nothing more.
- Every existing row gets the defaults, so it keeps its current behaviour. Discord does not change.
- `POST /api/integrations/policy` `{ id, access?, events? }` sets one or both. A save that omits them
  keeps the stored values.
- `orca slack` and `orca cloudflare` take `--account`.

What does not change:

- The grant levels, the link switches and the person levels.
- `POST /api/slack` (your own Slack button on a card). It is your click, not Orca acting with an
  account, so it does not read the policy.
- The `ORCA_SECRET_*` rule for tokens.

## 8. Why

- **One rule, not one per adapter.** Each new adapter added its own switches. The read and write
  split was in Cloudflare's CLI, Slack's prose and nowhere else. Now it is one column and one check.
- **Per account, not per kind.** Two Gmail accounts need different settings. The row is the
  account, so the setting goes on the row.
- **Reuse the link switches.** They already decide "show me" and "wake an agent". The account
  setting is the default for all its links, and a link narrows it. This adds no second path.
- **Fail closed.** An undeclared verb is a write, so a read account stays read when a new verb
  comes.
