# Cloudflare

The Cloudflare adapter (`server/integrations/adapters/cloudflare.ts`) connects one Cloudflare
account to Orca. It follows the adapter contract in [ADAPTERS.md](ADAPTERS.md).

- Inbound: a poll of the Cloudflare API. No webhook and no public URL: the bridge is not reachable
  from the internet.
- Outbound: none. The adapter takes no posts. `orca post` to its link is refused.
- `orca cloudflare …` gives the orchestrator read commands and a small set of write commands
  (`server/cloudflare.ts`). They use the token and the account id of the connected integration.
- The token is in Orca's encrypted secret store, or in an environment variable. No agent run sees
  it. The orca repo is public, so never put the token or the account id in a file in the repo.

## 1. Create the token

Make ONE account API token. Start from the "Read all resources" template, then add the Edit
permissions that the write commands need.

1. In the Cloudflare dashboard, open **Manage Account → Account API Tokens**.
2. Select **Create Token**. Select the **Read all resources** template.
3. Add these three rows with **+ Add more**:

   | Scope | Permission | Access | Commands that need it |
   |---|---|---|---|
   | Account | Workers Scripts | Edit | `rollback`, `delete`, `domain add`, `domain remove` |
   | Zone | Workers Routes | Edit | `route add`, `route remove` |
   | Zone | DNS | Edit | `dns add`, `dns remove` |

4. Under **Zone Resources**, select **Specific zone** for each zone that Orca may change. The zone
   list applies to every zone permission of the token, so Orca reads only these zones too.
5. Create the token. Copy it once.

If the account token page has no "Read all resources" template, select **Custom token** and add each
Read row from the table in section 8.

Worker custom domains need only **Account · Workers Scripts · Edit**. The Cloudflare API names it
`Workers Scripts Write` for `PUT` and `DELETE /accounts/{account_id}/workers/domains`. Cloudflare
then makes the DNS record and the certificate of the domain itself.

The watcher needs only Read permissions: Account Settings, Account Audit Logs, Workers Scripts and
Account Analytics. All four are in "Read all resources".

If a call is refused, the error names the permission. Add that permission to the token. Do not give
Orca a wider token.

## 2. Store the token

Use one of the two paths. The integration's secret_ref names the one it uses: `secret:<name>` for
path A, a variable name for path B. Every integration takes both forms
([ADAPTERS.md](ADAPTERS.md) section 13).

### Path A: Orca's secret store (recommended)

1. In the orchestrator's chat, type `/secret`.
2. Enter a name, for example `cloudflare-token`, and paste the token as the value.
3. Save. The chat shows the name only.

- The store keeps the value as AES-256-GCM ciphertext in the database ([docs/secrets.md](../secrets.md)).
- The registry decrypts it when it starts the adapter, and `orca cloudflare` decrypts it for each
  command. Both keep it in memory only. Orca never writes it to `.env`, a log or an agent's environment.
- Each read writes one audit row: action `integration`, command `cloudflare`. A poll or a health
  check reads memory, not the store.
- To rotate the token, store a new value under the same name. The next sync (at most one minute)
  starts the adapter again with it.
- The secret store's key is on the orchestrator's instance. Only a bridge with the same key can
  decrypt the token: set the same `ORCA_SECRETS_KEY` on each instance, or pin the integration to the
  orchestrator's instance (Runs on).
- An `ask-form` secret field stores its value in the same store. You can choose that name too.

### Path B: an environment variable

1. Add the token to the `.env` of each bridge that can run the integration. Also add it to the
   bridge of the orchestrator (`orchestratorOn`), because `orca cloudflare` runs there:

   ```bash title=.env
   ORCA_SECRET_CLOUDFLARE=<the token>
   ```

2. Restart the bridge, so that it reads the variable:

   ```bash
   sudo systemctl restart orca
   ```

Agents never see an `ORCA_SECRET_*` variable (`server/env.ts`).

## 3. Connect in Settings

1. In Orca, open **Integrations**. Click **Connect**, and select **Cloudflare**.
2. Fill in the form:
   - Name: `Cloudflare`. Id: `cloudflare`.
   - Runs on: Automatic.
   - Path A: under **Stored secret**, choose the name you stored. The secret variable becomes
     `secret:<name>`.
   - Path B: leave **Secret variable** empty for `ORCA_SECRET_CLOUDFLARE`.
   - Account id: the 32-character id on the account home page in the dashboard. It is not a secret.
   - The other fields: empty for the defaults (section 7).
3. Save. Wait for the next sync (at most one minute).
4. Click **Test** on the Cloudflare card. The result is `OK · connected to <account name>`.

The first Connect also makes:

- one link, `<id>-account`: place `*` (the whole account), level Viewer (`ask`), Require mention off;
- one subscription to the orchestrator for each topic in section 4.

A later edit does not make them again. A link or a subscription that you remove stays removed.

The card shows the last poll, the last event and the health. With path B it also shows the variable
(`ORCA_SECRET_CLOUDFLARE · set` or `not set`). A bad token, a stored secret that is gone or a missing
permission does not start the adapter. The card shows the error, for example
`the stored secret "cloudflare-token": no secret "cloudflare-token"`.

## 4. What comes in

Every `pollMinutes` (default 5), the adapter reads the account and compares it with the last poll.

| Topic | What it reports | Read command on each line |
|---|---|---|
| `ext.cloudflare.audit` | Audit-log entries since the cursor (not DNS). | `orca cloudflare audit --resource <id> --since <time>` |
| `ext.cloudflare.dns` | Audit-log entries for DNS records. | the same |
| `ext.cloudflare.deploy` | Each new Worker deployment. | `orca cloudflare deployments <worker>` |
| `ext.cloudflare.worker` | A new Worker, a deleted Worker, a rollback. | `deployments <worker>` or `audit` |
| `ext.cloudflare.domain` | A Worker custom domain added, removed or moved. | `orca cloudflare domains` |
| `ext.cloudflare.errors` | A Worker over the error-rate threshold in the last window. | `orca cloudflare analytics --worker <w> --since 1h` |

- One poll gives ONE event for each topic and place. Each line has the time, the actor, the action,
  the resource and a read command.
- The place is `zone:<name>` for a change in a zone, else `account`. The core tries the zone link,
  then `account`, then the `*` link.
- An event has no `actor`. A poller is a machine sender, so the grant is the link's level.
- The first poll reads from now. It records the Workers and domains as they are, and reports
  nothing.
- The state is one JSON value in `integration_cursor`: the audit cursor, the audit ids at the
  cursor, the Workers, the domains and the Workers over the threshold. A restart replays nothing and
  misses nothing.
- The key of an event is a hash of its lines. The same batch twice is one event.
- A Worker over the threshold alerts once. It alerts again only after it goes below the threshold.
- The error window is the time since the last poll, at least 5 minutes. A Worker with fewer than
  `minRequests` requests in the window gives no alert.

These changes do not come in:

- Orca's own confirmed writes. Each `orca cloudflare … --confirm` records its names and ids in the
  database (`integration_cursor` row `cloudflare:own-writes`). The adapter skips a change to one of
  them within 15 minutes.
- Audit-log entries of a deploy actor. A deploy actor is a text in the entry's actor or metadata,
  from `deployActors` (default `github`, for the GitHub Actions deploy token). Its deploys still
  come in on `ext.cloudflare.deploy`.
- Changes in a zone that is not in `zones`, when `zones` is set.

## 5. Links and subscriptions

- The Viewer level lets the orchestrator run the `orca cloudflare` read commands on a Cloudflare
  event. Orca refuses every write command on such a wake: a write needs your own chat.
- Each topic has its own subscription to the orchestrator. `ext.cloudflare.deploy` is a digest of
  one hour, so routine deploys come as one summary.
- To stop a topic, remove its subscription.
- For quiet mode, turn off **Notify agent** on the link. The events then show only in the Inbox.
  Turn off **Notify me** to keep them out of the Inbox.
- To treat one zone differently, add a link with place `zone:<name>`. It wins over `*`.
- To send a topic to a channel, add a subscription with a link target, for example
  `ext.cloudflare.errors` to a Discord channel link.

## 6. In the orchestrator's chat

An event comes in as an outside message from the Cloudflare integration, with the Viewer grant. Its
prompt says that there is no sender to answer. The orchestrator decides whether a change needs a
look, uses the read commands, and tells you what matters.

## 7. Configuration

| Form field (`config` key) | Default | Meaning |
|---|---|---|
| Account id (`accountId`) | `ORCA_CLOUDFLARE_ACCOUNT_ID` | The account to watch and to act on. |
| Poll every (`pollMinutes`) | 5 | Minutes between two polls. The minimum is 1. |
| Error-rate threshold (`errorRatePct`) | 5 | The error rate in percent that alerts. |
| Fewest requests (`minRequests`) | 100 | Fewer requests in the window give no error alert. |
| Zones to watch (`zones`) | all | Comma-separated zone names. Zone changes outside them do not come in. |
| Deploy actors (`deployActors`) | `github` | Comma-separated texts. An audit-log entry whose actor or metadata has one of them does not come in. |

Environment variables:

| Variable | Use |
|---|---|
| `ORCA_SECRET_CLOUDFLARE` | The token for path B. The default secret variable of the integration. |
| `ORCA_CLOUDFLARE_ACCOUNT_ID` | Fallback account id, when no integration gives one. |
| `ORCA_CLOUDFLARE_API` | Another API base URL. Only for tests. |

`orca cloudflare` reads the token of the first enabled Cloudflare integration: the stored secret or
the variable that its secret_ref names. It reads the account id from the integration's config. With no
integration, it reads `ORCA_SECRET_CLOUDFLARE` and `ORCA_CLOUDFLARE_ACCOUNT_ID`, so a setup with only
the variables still works. If the stored secret cannot be read, the command stops and says why. It
does not try another token.

## 8. Read commands

| Command | What it prints | Permission |
|---|---|---|
| `orca cloudflare account` | The account name and id. | Account Settings Read |
| `orca cloudflare workers` | Each Worker, newest change first. | Workers Scripts Read |
| `orca cloudflare deployments <worker>` | Each deployment: time, author, source, versions, message. | Workers Scripts Read |
| `orca cloudflare versions <worker>` | Each version: number, time, author, source, tag. | Workers Scripts Read |
| `orca cloudflare routes [--zone <zone>]` | Worker routes on one zone, or on every zone. | Workers Routes Read |
| `orca cloudflare domains` | Worker custom domains. | Workers Scripts Read |
| `orca cloudflare pages` | Pages projects and their latest deployment. | Cloudflare Pages Read |
| `orca cloudflare r2` | R2 buckets. | Workers R2 Storage Read |
| `orca cloudflare d1` | D1 databases. | D1 Read |
| `orca cloudflare zones` | The zones the token can read. | DNS Read |
| `orca cloudflare dns --zone <zone> [--type <t>] [--name <n>]` | DNS records of one zone. | DNS Read |
| `orca cloudflare analytics [--worker <w>] [--since 24h] [--until <t>]` | Requests, errors and CPU time for each Worker. | Account Analytics Read |
| `orca cloudflare audit [--resource <name>] [--actor <email>] [--since 7d] [--until <t>] [--limit 50]` | Audit-log entries, newest first. | Account Audit Logs Read |

- `--zone` takes a zone name (`example.com`) or a zone id.
- `--since` and `--until` take `30m`, `24h`, `7d` or an ISO time.

## 9. Write commands

| Command | What it does |
|---|---|
| `orca cloudflare rollback <worker> --version <id> [--message "…"] --confirm` | Deploys that version at 100% of traffic. |
| `orca cloudflare delete <worker> --confirm` | Deletes the Worker and all its versions. |
| `orca cloudflare route add --zone <zone> --pattern <host/path*> --worker <name> --confirm` | Adds a Worker route. |
| `orca cloudflare route remove --zone <zone> (--id <id> \| --pattern <p>) --confirm` | Removes a Worker route. |
| `orca cloudflare domain add --worker <name> --hostname <host> [--zone <zone>] --confirm` | Attaches a Worker custom domain. |
| `orca cloudflare domain remove (--hostname <host> \| --id <id>) --confirm` | Detaches a Worker custom domain. |
| `orca cloudflare dns add --zone <zone> --type <t> --name <n> --content <c> [--proxied] [--ttl <s>] [--comment …] --confirm` | Adds a DNS record. |
| `orca cloudflare dns remove --zone <zone> --id <record id> --confirm` | Removes a DNS record. |

- Without `--confirm`, a write command reads the current state, prints its plan and changes nothing.
- Each command checks its target first. These stop it:
  - an unknown version, Worker, route, domain or record;
  - a route or domain that already exists;
  - a hostname with a CNAME record (Cloudflare refuses a custom domain there);
  - a DNS record that already exists, or a CNAME that shares its name with another record.
- `domain add` finds the zone from the hostname when `--zone` is not given.
- `dns add` takes `--zone` as a zone name. `--name www` becomes `www.<zone>`, and `@` is the zone.
- Each confirmed write writes one line to the bridge log: `[cloudflare] <time> <who>: <what> → ok`,
  or `→ failed: <error>`.
- Only your own chat can run a write command. Orca refuses it for an outside sender at every level
  (`grantRefusal` in `shared/integrations.ts`).

No command uploads Worker code. A new Worker comes from its repo's deploy pipeline (for example
`sites.yml` in site-templates). The watcher then reports it.

## 10. Test it

Automatic tests use a fake Cloudflare API on loopback. They make no real Cloudflare call:

```bash
orca-run --kind test -- bun test tests/cloudflare.test.ts tests/cloudflareAdapter.test.ts
```

To test the watcher on a real account:

1. Connect the integration (section 3). Click Test: `OK · connected to <account name>`.
2. Wait for one poll. The card shows `last poll`. Nothing comes in: the first poll is the baseline.
3. In the dashboard, add a TXT record to a watched zone, for example `orca-test` with the content `hello`.
4. Wait for the next poll (at most `pollMinutes`). An activity row with the Cloudflare icon comes into
   the orchestrator's chat: `Cloudflare: 1 DNS change`. The Inbox shows it too.
5. Ask the orchestrator to remove the record:
   `orca cloudflare dns remove --zone <zone> --id <id> --confirm`. That change does not come back in:
   it is Orca's own write.
6. For a shorter test, set Poll every to 1 and click Save. The new value applies after the
   integration restarts (switch it off and on).

## 11. Limits

- A poll makes one audit-log read, one Workers read, one deployments read for each changed Worker,
  one custom-domains read and one GraphQL query.
- Route changes and DNS changes come from the audit log only. The adapter does not compare routes
  or records itself.
- A restart forgets nothing, but an own write made more than 15 minutes before its audit-log entry
  is reported.
- The watcher reads one account. Connect a second integration for a second account.
