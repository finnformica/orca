# Cloudflare

`orca cloudflare` gives the orchestrator read access to one Cloudflare account. It also gives
three write commands, each behind `--confirm`. The code is `server/cloudflare.ts`.

- The bridge calls the Cloudflare API. `bin/orca` only talks to the bridge, as every other `orca` command does.
- The token is an account API token in `ORCA_SECRET_CLOUDFLARE`.
- The account id is in `ORCA_CLOUDFLARE_ACCOUNT_ID`.
- No agent run sees either variable. The `ORCA_SECRET_` prefix removes the token from every spawn.
  `ORCA_CLOUDFLARE_ACCOUNT_ID` is in `ORCA_SECRETS` (`server/env.ts`).
- The orca repo is public. Never put the token or the account id in a file in the repo.

## 1. Create the token

1. In the Cloudflare dashboard, open **Manage Account → Account API Tokens**.
2. Select **Create Token**, then **Custom token**.
3. Add the permissions in the table below. Add no other permissions.
4. Under **Zone Resources**, include the zones that the orchestrator can read.
5. Create the token. Copy it once.

| Scope | Permission | Access | Commands that need it |
|---|---|---|---|
| Account | Workers Scripts | Read | `workers`, `deployments`, `versions`, `domains`, `delete` and `rollback` (checks) |
| Account | Workers Scripts | Edit | `rollback --confirm`, `delete --confirm` |
| Zone | Workers Routes | Read | `routes`, `route add` and `route remove` (checks) |
| Zone | Workers Routes | Edit | `route add --confirm`, `route remove --confirm` |
| Account | Cloudflare Pages | Read | `pages` |
| Account | Workers R2 Storage | Read | `r2` |
| Account | D1 | Read | `d1` |
| Zone | DNS | Read | `dns`, `zones`, and the zone lookup for `--zone <name>` |
| Account | Account Analytics | Read | `analytics` |
| Account | Account Audit Logs | Read | `audit` |
| Account | Account Settings | Read | `account` |

If a call is refused, the error names the permission from this table. Add that permission to the
token. Do not give the orchestrator a wider token.

## 2. Set the variables

Put the two variables in the environment of the bridge that runs the orchestrator
(`orchestratorOn`). On the box, that is its `.env`. Restart the bridge.

```bash title=.env
ORCA_SECRET_CLOUDFLARE=<the token>
ORCA_CLOUDFLARE_ACCOUNT_ID=<the account id>
```

The account id is on the account home page in the dashboard. If a variable is missing, every
`orca cloudflare` command says which one to set.

## 3. Read commands

| Command | What it prints |
|---|---|
| `orca cloudflare account` | The account name and id. Use it to test the token. |
| `orca cloudflare workers` | Each Worker with its created and modified dates, newest change first. |
| `orca cloudflare deployments <worker>` | Each deployment: time, author, source, versions and their traffic %, message. |
| `orca cloudflare versions <worker>` | Each version: number, time, author, source, tag, message. |
| `orca cloudflare routes [--zone <zone>]` | Worker routes on one zone, or on every zone. |
| `orca cloudflare domains` | Worker custom domains. |
| `orca cloudflare pages` | Pages projects, their domains and their latest deployment. |
| `orca cloudflare r2` | R2 buckets. |
| `orca cloudflare d1` | D1 databases, their tables and size. |
| `orca cloudflare zones` | The zones the token can read. |
| `orca cloudflare dns --zone <zone> [--type <type>] [--name <name>]` | DNS records of one zone. |
| `orca cloudflare analytics [--worker <w>] [--since 24h] [--until <t>]` | Requests, errors, subrequests and CPU time for each Worker. |
| `orca cloudflare audit [--resource <name>] [--actor <email>] [--since 7d] [--until <t>] [--limit 50]` | Account audit-log entries, newest first. |

- `--zone` takes a zone name (`example.com`) or a zone id.
- `--since` and `--until` take `30m`, `24h`, `7d` or an ISO time.
- `audit --actor` is a Cloudflare filter. `audit --resource` is a text match on each entry's resource, old value, new value and metadata.

## 4. Write commands

| Command | What it does |
|---|---|
| `orca cloudflare rollback <worker> --version <id> [--message "…"] --confirm` | Deploys that version at 100% of traffic. |
| `orca cloudflare delete <worker> --confirm` | Deletes the Worker and all its versions. |
| `orca cloudflare route add --zone <zone> --pattern <host/path*> --worker <name> --confirm` | Adds a Worker route. |
| `orca cloudflare route remove --zone <zone> (--id <route id> \| --pattern <pattern>) --confirm` | Removes a Worker route. |

- Without `--confirm`, a write command reads the current state, prints its plan and changes nothing.
- Before it writes, each command checks its target. An unknown version, Worker or route stops it.
- Each confirmed write writes one line to the bridge log: `[cloudflare] <time> <who>: <what> → ok`, or `→ failed: <error>`.
- Only your own chat can run a write command. A wake from an outside sender can run the read commands
  with an `ask` grant or higher. Orca refuses its write commands at every level (`grantRefusal` in
  `shared/integrations.ts`).

## 5. Tests

`tests/cloudflare.test.ts` runs every command against a fake Cloudflare API on loopback. It makes no
real Cloudflare call.
