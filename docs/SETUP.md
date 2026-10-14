# Setting up your own Orca

This guide takes you from nothing to a working Orca: one EC2 box running the bridge, the web UI and
the orchestrator, reached only over Tailscale, and optionally your laptop as a second instance.
For what Orca does once it's running, see [WORKFLOW.md](WORKFLOW.md).

Every command here comes from `deploy/`, `bin/`, `scripts/` and `server/`. Values in `<angle
brackets>` are yours to fill in. **Never commit them.**

1. [Prerequisites](#1-prerequisites)
2. [Provision the box](#2-provision-the-box)
3. [Sign in on the box](#3-sign-in-on-the-box)
4. [Bootstrap: build, `.env`, systemd](#4-bootstrap-build-env-systemd)
5. [Environment variables (`.env`)](#5-environment-variables-env)
6. [The config document](#6-the-config-document)
7. [Adding a repo](#7-adding-a-repo)
8. [Claude Code trust settings](#8-claude-code-trust-settings)
9. [Previews and the template database](#9-previews-and-the-template-database)
10. [Adding a laptop instance](#10-adding-a-laptop-instance)
11. [Memory ceilings](#11-memory-ceilings)
12. [Verify it works](#12-verify-it-works)
13. [Upgrading and auto-deploy](#13-upgrading-and-auto-deploy)
14. [Troubleshooting and known pitfalls](#14-troubleshooting-and-known-pitfalls)

---

## 1. Prerequisites

| You need | Why / notes |
| --- | --- |
| **An AWS account** and the `aws` CLI on your laptop, signed in with rights to use SSM Parameter Store, create a security group, `run-instances`, and pass the instance role | `deploy/provision.sh` runs from your laptop. |
| **The `AmazonSSMRoleForInstancesQuickSetup` instance profile** | `provision.sh` attaches it by that exact name. Systems Manager's *Quick Setup* creates it. If it's missing, create a role with `AmazonSSMManagedInstanceCore` and an instance profile with that name. The box also reads its Tailscale key from Parameter Store (`ssm get-parameter --with-decryption`) through this role, so the role must be allowed to read that parameter. |
| **An instance size** | The default is **`m7i.xlarge`** (4 vCPU, 16 GB RAM) with a **150 GB gp3** root disk in **`eu-west-2`**, on Ubuntu 24.04 amd64. That's about $0.2331 per hour on-demand. `deploy/orca.service`'s `MemoryMax=13G` is sized for 16 GB, so change it if you pick a different size. Worktrees, preview databases and test containers are what fill the disk. |
| **A Tailscale tailnet** and a **pre-auth key** (`tskey-auth-…`) | The box has **no inbound security-group rules**: it's reached only over the tailnet (and SSM for emergency access). The API has no auth of its own, so never expose it publicly or bind it to `0.0.0.0`. |
| **A GitHub account for the box** (a bot account works well) with write access to every repo Orca manages | The box signs in once with `gh auth login`. Note: the board's PR lanes are `gh pr list --author @me`, i.e. PRs **authored by the account `gh` is signed in as**. With a bot account, workers' PRs show on the board but your own hand-made PRs don't. |
| **A Claude subscription login** (one or more) | Orca runs `claude -p` with the CLI's own login, so **no API key** is needed. Several logins are optional: [claude-hydra](https://github.com/finnformica/claude-hydra) routes each launch to the one with the most headroom. |
| Optional: `codex` / `cursor-agent` signed in | Only for repos that list them in `providers`. |
| Optional: a Slack **user** token (`xoxp-…`) | For posting notify/bump messages. Keep it on the laptop (see [§10](#10-adding-a-laptop-instance)). |

Bun, Postgres, `gh`, the Claude CLI and hydra are installed **on the box** by cloud-init. You don't
install them yourself there.

---

## 2. Provision the box

From a checkout of Orca **on your laptop**:

```sh
# 1. Store the Tailscale auth key in Parameter Store (the box reads it at first boot; it never
#    appears in user-data or on disk in this repo).
aws ssm put-parameter --region eu-west-2 --name /orca/tailscale-authkey --type SecureString --value <tskey-auth-…>

# 2. Launch. Both arguments are optional: instance type (default m7i.xlarge), disk GB (default 150).
#    AWS_REGION overrides eu-west-2. VANTA_OWNER sets the owner tag. Set it to your own email, or the
#    script's built-in default is used.
VANTA_OWNER=<you@example.com> deploy/provision.sh m7i.xlarge 150
```

What `provision.sh` does:

- refuses to run until `/orca/tailscale-authkey` exists;
- looks up the current Ubuntu 24.04 amd64 AMI from SSM, and the **default VPC**;
- reuses (or creates) a security group named `orca-server` with **no ingress**;
- runs the instance named `orca-server` with the SSM instance profile, a gp3 root volume, IMDS
  `HttpTokens=optional`, `deploy/cloud-init.yaml` as user-data, and the tags `Project=orca`,
  `VantaOwner`, `VantaNonProd=true`, `VantaContainsUserData=false` and `VantaDescription`;
- waits for `instance-running` and prints the SSM command to get in.

**What cloud-init does unattended** (it takes about 5 minutes; the log is
`/var/log/cloud-init-output.log` on the box):

- sets the hostname to `orca-box` and installs `git jq curl unzip postgresql postgresql-contrib
  build-essential`, plus the `aws-cli` snap;
- creates the user **`orca`** (sudo, `NOPASSWD:ALL`, bash);
- installs Tailscale and runs `tailscale up --authkey=… --hostname=orca-box --ssh`;
- sets up Postgres: role `orca` with password `orca`, database `orca` owned by it,
  `listen_addresses='*'`, and a `pg_hba.conf` line allowing `100.64.0.0/10` (the tailnet range only)
  with `scram-sha-256`;
- installs `gh` from GitHub's apt repo;
- installs, for the `orca` user: **Bun** (`bun.sh/install`), the **Claude CLI**
  (`claude.ai/install.sh`), and **claude-hydra** with its shim (`install.sh --shim`, pointed at
  `~/.bashrc`), with `~/.local/bin` and `~/.bun/bin` added to `PATH` in `.bashrc`;
- creates `/opt/orca`, owned by `orca`, and writes an MOTD saying the box is ready for sign-in.

> **Change the database password.** cloud-init uses `orca`/`orca`. Only tailnet addresses can reach
> it, but if you change it (`sudo -u postgres psql -c "ALTER ROLE orca PASSWORD '<new>'"`), update
> `ORCA_DATABASE_URL` / `ORCA_TEST_DATABASE_URL` in `.env` on every instance.

---

## 3. Sign in on the box

Sign-ins can't be done unattended. Open a session and become `orca`:

```sh
aws ssm start-session --region eu-west-2 --target <instance-id>
sudo -iu orca
```

(Once the box is on your tailnet, `tailscale ssh orca@orca-box` also works, because cloud-init
enabled Tailscale SSH. Whether it's allowed depends on your tailnet's ACLs.)

Then:

```sh
# GitHub: sign in as the box's account (a bot account, say), and let git push over HTTPS with it.
gh auth login
gh auth setup-git

# Claude: one hydra profile per Claude login. The shim (in ~/.hydra/bin, first on the service's PATH)
# routes every `claude -p` to the login with the most headroom.
hydra add <name>                 # signs a login in (paste-the-code flow works over SSM/SSH)
#   or, if you already ran `claude login`:  hydra add <name> --existing
hydra status                     # every login's 5-hour, weekly and Fable windows

# Optional providers
codex login --device-auth        # only if a repo lists "codex" in providers

# Orca itself
git clone <your-orca-repo-url> /opt/orca

# Each repo Orca will manage, next to it (ORCA_DEV_ROOT=/opt below)
git clone <repo-url> /opt/<repo-name>
```

**Pin the Claude Code version on the box.** Check `claude --version` and read the release notes
before upgrading. `--bare` is slated to become the default for `-p`, and bare mode never reads OAuth
credentials, which would silently break every subscription-login launch.

---

## 4. Bootstrap: build, `.env`, systemd

Still as `orca` on the box:

```sh
/opt/orca/deploy/bootstrap.sh
```

`deploy/bootstrap.sh`, step by step:

1. reads the box's tailnet IPv4 (`tailscale ip -4`) and MagicDNS name
   (`tailscale status --json | jq -r .Self.DNSName`);
2. `bun install --frozen-lockfile`, then `bun run build` (the production UI build);
3. `sudo loginctl enable-linger orca`, which gives the service account a user systemd manager at
   boot. This is what makes the per-worker memory ceiling work (see [§11](#11-memory-ceilings));
4. writes `/opt/orca/.env`, **only if it doesn't exist yet**:

   ```sh
   ORCA_DEV_ROOT=/opt
   ORCA_INSTANCE=cloud
   ORCA_BIND=127.0.0.1,<tailnet-ip>
   ORCA_PREVIEW_HOST=<box-name>.<tailnet>.ts.net
   ORCA_DATABASE_URL=postgres://orca:orca@localhost:5432/orca
   ORCA_TEST_DATABASE_URL=postgres://orca:orca@localhost:5432/postgres
   ```

5. installs and starts the bridge: `deploy/orca.service` → `/etc/systemd/system/orca.service`,
   `daemon-reload`, `enable --now orca`;
6. installs auto-deploy: `orca-autodeploy.service` and `.timer` into `/etc/systemd/system/`,
   `orca-autodeploy.sudoers` → `/etc/sudoers.d/orca-autodeploy` (mode 440), checks it with
   `visudo -c`, then `enable --now orca-autodeploy.timer`;
7. prints the UI URL (`http://<box-name>.<tailnet>.ts.net:8787`) and the database URL your laptop
   should use.

**Then add `ORCA_PREVIEW_BIND` yourself.** `bootstrap.sh` doesn't write it, and its default is
`127.0.0.1`, so preview services on the box would be reachable from nowhere but the box:

```sh
echo "ORCA_PREVIEW_BIND=<tailnet-ip>" >> /opt/orca/.env
sudo systemctl restart orca
```

### The systemd units

| Unit | What it is |
| --- | --- |
| `orca.service` | The bridge: `User=orca`, `WorkingDirectory=/opt/orca`, `ExecStart=/home/orca/.bun/bin/bun run server/index.ts`, `Restart=always` (3 s). `PATH` lists `~/.hydra/bin` **first** (hydra's `claude` shim), then `~/.bun/bin` and `~/.local/bin`. `MemoryMax=13G` (about 85% of 16 GB, for the bridge and anything it runs directly, such as previews and git/gh, but **not** agent runs, which each get their own scope). `OOMScoreAdjust=-500`, `KillSignal=SIGTERM`, `TimeoutStopSec=15` (the bridge drains its history writes, and leaves agents and previews running). Bun auto-loads `/opt/orca/.env`. |
| `orca-autodeploy.service` | Oneshot, `User=orca`, runs `deploy/autodeploy.sh` (same `PATH`). |
| `orca-autodeploy.timer` | `OnBootSec=2min`, `OnUnitActiveSec=1min`. |
| `/etc/sudoers.d/orca-autodeploy` | `orca ALL=(root) NOPASSWD: /usr/bin/systemctl restart orca`, the one privileged step auto-deploy needs. (cloud-init's blanket `NOPASSWD:ALL` already covers it. The rule keeps auto-deploy working if that blanket grant is ever tightened.) |

Postgres and Tailscale are separate units, never children of `orca.service`, so neither memory
limit applies to them.

---

## 5. Environment variables (`.env`)

`.env` sits at the checkout root. It's gitignored and auto-loaded by Bun, and it's per machine.
Start from `.env.example`. Every variable:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORCA_DEV_ROOT` | **required** | The directory holding the managed repos. Stored config paths are templates like `${ORCA_DEV_ROOT}/<repo>`, expanded per machine. `/opt` on the box. The bridge fails at startup if it's unset. |
| `ORCA_DATABASE_URL` | none | Postgres holding everything shared: turns, enrichment, config, notifications, metrics, attachments. All instances point at **one** database. |
| `ORCA_TEST_DATABASE_URL` | none | Postgres for `bun test`. Each test file gets a throwaway schema, and the tests refuse any database that isn't one. |
| `ORCA_INSTANCE` | the hostname | This process's instance name (`cloud`, `local`). Matched against a repo's `runsOn`, `orchestratorOn` and `instances`. |
| `ORCA_BIND` | `127.0.0.1` | Listen addresses, comma-separated. A machine another instance must reach binds `127.0.0.1,<tailnet-ip>`. Loopback is **not** optional: `bin/orca` and an Orca preview's Vite proxy use it. Never `0.0.0.0`. |
| `ORCA_PREVIEW_HOST` | `localhost` | The host name preview links use (`{host}` in a preview command). On the box, its tailnet name. |
| `ORCA_PREVIEW_BIND` | `127.0.0.1` | The address preview services listen on (`{bind}`). On the box, its tailnet IP. |
| `ORCA_API_PORT` | `8787` | The bridge's port. |
| `ORCA_UI_PORT` | `8788` | The Vite dev UI port (`bun run dev` only). |
| `ORCA_STATE_DIR` | `~/.orca` | Per-host operational files: run leases, the run ledger, the orchestrator's working directory, handoff files, attachment cache, env backups, `autodeploy.log`. Kept out of every worktree. |
| `ORCA_USER` | `me` | The row owner in the database, until real auth exists. |
| `ORCA_IMDS_URL` | `http://169.254.169.254` | The EC2 metadata service, used for the machine-cost estimate. |
| `SLACK_TOKEN` | none | A Slack user token (`xoxp-…`). Messages are posted verbatim from your identity. Without it, a send fails clearly and the message is copied to your clipboard. |
| `ORCA_ALLOW_WORKTREE_MIGRATIONS` | unset | A bridge run from a git **worktree** refuses to apply migrations, because a worktree's copied `.env` usually names the shared database. Set it to `1` only when that worktree's database is its own. |
| `ORCA_PREVIEW_BRIDGE` | unset | Set only by `scripts/preview-orca.sh`: this bridge is an Orca preview's read-only `/api`. |
| `ORCA_SHOT_BROWSER` | the newest Playwright `chrome-headless-shell` in `~/.cache/ms-playwright`, else one on `PATH` | The browser the screenshot service (`orca-shot`) drives. |
| `ORCA_URL` | `http://127.0.0.1:$ORCA_API_PORT` | For `bin/orca` and `orca-shot`: which bridge to call. |

Agents never see Orca's own secrets: `SLACK_TOKEN`, `ORCA_DATABASE_URL` and `ORCA_TEST_DATABASE_URL`
are removed from every agent's environment (`agentEnv` in `server/agent.ts`).

`deploy/autodeploy.sh` also reads `ORCA_REPO` (default `/opt/orca`), `ORCA_SERVICE_NAME` (`orca`),
`ORCA_BRIDGE_URL` (`http://127.0.0.1:8787`) and `ORCA_STATE_DIR`.

---

## 6. The config document

**The live configuration is in Postgres**, not in a file, so every instance sharing the database
reads the same config. Changes take effect within about 5 seconds without a restart.

- **First boot:** if the database has no repos, Orca **seeds** it once from the checkout's
  `orca.config.ts`, storing paths as `${ORCA_DEV_ROOT}/…` templates. After that, the file is
  ignored. The checked-in file names the original author's repos, so plan to replace them (see
  below).
- **Settings → config** in the UI is **read-only**. The one thing you can edit there is the
  **Machine cost** rate (`POST /api/config/instance-rate`).
- **Editing:** read the document, edit it, and write it back. **The document is the unit: a repo
  missing from what you PUT is removed.** Invalid input is rejected with every problem listed, and
  nothing is half-applied.

```sh
# On the box (or anywhere on the tailnet, using the box's address).
# 1. Back it up first, always.
curl -s http://127.0.0.1:8787/api/config/document > ~/orca-config.$(date +%F-%H%M).json
cp ~/orca-config.<stamp>.json ~/orca-config.new.json
$EDITOR ~/orca-config.new.json

# 2. Write it back. The answer is {"ok":true,"repos":[…]} or {"errors":[…]}.
curl -s -X PUT -H 'content-type: application/json' \
  --data @$HOME/orca-config.new.json http://127.0.0.1:8787/api/config/document
```

Don't edit `orca.config.ts` in `/opt/orca` on the box to change config. It isn't read once the
database is seeded, and a local change can make auto-deploy's `git pull --ff-only` fail.

### Top-level settings

| Key | Default | Meaning |
| --- | --- | --- |
| `repos` | **required**, non-empty | The managed repos; the first is the default. See below. |
| `portRange` | `[30000, 40000]` | The inclusive port range preview services are picked from. |
| `staleHours` | `24` | How long before a PR's Slack message may be bumped. |
| `agentTimeoutMinutes` | none | The hard ceiling for one agent run. The seed config sets `45`, and a run killed by it ends with SIGTERM (exit 143). |
| `agentModel` | the CLI's default | The default `--model` for every repo's Claude runs. |
| `instances` | none | `{ "<name>": "http://<tailnet-ip>:8787" }` for every instance, so either one can forward to the other. |
| `instanceHourlyUsd` | none | `{ "<name>": <usd per hour> }`. Without it: an EC2 on-demand estimate from instance metadata, else 0. |
| `orchestratorOn` | wherever it's spoken to | The instance the orchestrator lives on. **Set it when you have more than one instance**, so only one process ever wakes it. |
| `orchestratorShell` | `true` | `false` limits the orchestrator to `orca`, reading, the web and read-only subagents. Worth it on a shared box. |
| `orchestratorWakeBudgetUsd` | none (no cap) | `--max-budget-usd` for one orchestrator wake. |
| `agentCpuWeight` | `50` | systemd `CPUWeight` for each agent run's scope (1–10000), so workers yield to the bridge. |

### Per-repo settings

| Key | Default | Meaning |
| --- | --- | --- |
| `name` | **required** | A slug (letters, digits, dashes), used in URLs and as `--repo`. |
| `repoPath` | **required** | `${ORCA_DEV_ROOT}/<name>`. |
| `worktreeRoot` | **required** | `${ORCA_DEV_ROOT}/<name>/.worktrees` by convention. |
| `baseBranch` | **required** | The branch PRs target, e.g. `main` or `master`. |
| `providers` | **none** | Which CLIs may run here: `["claude"]`, plus `"codex"` / `"cursor"` if wanted. **Empty means no agent can launch.** |
| `agentPermissionMode` | **`ask`** | `"bypass"` runs agents with `--permission-mode bypassPermissions`. `ask` runs them with `default`, under which a headless run can't approve tools. |
| `features` | **all off** | `slack`, `followAutomation` (new PR feedback and failed checks trigger agent runs), `aiPrDescription`, `autoMerge`, `previews`, `aiTitles`, each `true`/`false`. Unknown keys are rejected. |
| `checkCommand` | none | The verification gate, run in the worktree after every run that committed, e.g. `bun run check`. |
| `agentModel` | the top-level `agentModel` | This repo's Claude model. |
| `agentMaxBudgetUsd` | none | `--max-budget-usd` per run (stop reason `budget_reached`). |
| `agentMemoryMaxGb` | `4` | The per-run memory ceiling. See [§11](#11-memory-ceilings). |
| `runsOn` | any instance | The instance new workstreams go to by default. |
| `mergePolicy` | never merge, never open PRs | `{ whenGreen: "never"\|"small"\|"any", denyPaths: [globs], autoPr: bool }`. See [WORKFLOW.md](WORKFLOW.md#from-finished-run-to-merged-pr). |
| `modelEscalation` | `suggest` | `"apply"` re-pins a worker to the next model up after two failures in a row. |
| `previewServices` | `[]` | `[{ name, command, open?, onStop? }]`. See [§9](#9-previews-and-the-template-database). |
| `previewSecureContext` | `false` | The app needs a secure context (e.g. `crypto.randomUUID`), so a laptop page on localhost gets the box's preview forwarded to `http://localhost:<port>`. |
| `previewLabel` | `preview` | The PR label the "Add preview" action adds. |
| `prLabels` | none | Labels offered in the Promote menu: `[{ name, default? }]`. |
| `slackChannel` | none | The channel the notify/bump message names. |
| `copyToWorktree` | none | Gitignored files copied from the main checkout into each worktree (e.g. `backend/.env`). The `.env` among them is also what `--push-to-template` writes back to. |
| `linkToWorktree` | none | Heavy directories provisioned into each worktree: `node_modules` is copy-on-write cloned, other paths are symlinked. |
| `changelogFiles` | `["**/CHANGELOG.md"]` | A conflict only in these is merged by Orca itself (`git merge-file --union`). `[]` turns this off. |
| `testContainerPrefix` | none | The prefix of the repo's test Docker containers. The hourly reaper removes ones older than 3 hours. |

---

## 7. Adding a repo

1. **Check it out on the instance that will run it**, as `orca`, under `ORCA_DEV_ROOT`:
   `git clone <repo-url> /opt/<repo-name>`. Make sure the `gh` account can push to it.
2. **Trust it in Claude Code** ([§8](#8-claude-code-trust-settings)).
3. **Add it to the document** ([§6](#6-the-config-document)): back up, add an entry, PUT. A minimal
   entry that actually runs agents:

   ```json
   {
     "name": "<repo-name>",
     "repoPath": "${ORCA_DEV_ROOT}/<repo-name>",
     "worktreeRoot": "${ORCA_DEV_ROOT}/<repo-name>/.worktrees",
     "baseBranch": "main",
     "providers": ["claude"],
     "agentPermissionMode": "bypass",
     "runsOn": "cloud",
     "checkCommand": "<the repo's own check, e.g. bun run check>",
     "agentMemoryMaxGb": 8,
     "features": { "aiTitles": true, "aiPrDescription": true, "followAutomation": true },
     "mergePolicy": { "whenGreen": "small", "denyPaths": ["<migrations dir>/", "deploy/"], "autoPr": true },
     "previewServices": []
   }
   ```

4. If you're replacing the seeded repos (`branch-demo`, `orca`), leave them out of the document.
   They're then removed from the config, but their history stays in the database.
5. Open the UI. The repo appears in the repo switcher and on the **Repos** page.

---

## 8. Claude Code trust settings

Claude Code keeps a per-directory "do you trust this folder?" flag, and a headless worker started in
an untrusted repo fails with an untrusted-workspace error. Orca doesn't set this flag for you. Set
`projects["<repo path>"].hasTrustDialogAccepted = true` for each repo path in **`~/.claude.json`**
**and** in **every hydra profile's `.claude.json`**, because hydra may route a run to any of them:

```sh
# as orca, for each repo path
for f in ~/.claude.json "$(hydra dir <profile>)/.claude.json"; do   # repeat for every profile (`hydra list`)
  tmp=$(mktemp) && jq --arg p /opt/<repo-name> '.projects[$p].hasTrustDialogAccepted = true' "$f" > "$tmp" && mv "$tmp" "$f"
done
```

Or start `claude` interactively once in the repo directory, under each profile, and accept the
prompt.

---

## 9. Previews and the template database

Turn previews on per repo: `"features": { "previews": true }` and at least one `previewServices`
entry. In a command:

- `{port}`: this service's assigned port. `{svc:<name>}`: another service's port.
- `{bind}`: `ORCA_PREVIEW_BIND`, the address to listen on. `{host}`: `ORCA_PREVIEW_HOST`, for any URL
  handed to the browser.
- `{db}`: a per-worktree database name (`orca_…`). `onStop` runs on teardown, typically to drop it.
- `open: true` marks the service the **Open** button opens.

**Vite apps need to allow the tailnet Host header**, or they answer 403 "Blocked request". Vite 5 has
no environment variable for this. The app's own `vite.config.ts` must read one into
`server.allowedHosts`, as Orca's `web/vite.config.ts` does with `ORCA_PREVIEW_HOST` and
`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`. Orca's own preview command is:

```sh
cd web && export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS={host} && bunx --bun vite --host {bind} --port {port}
```

**A database per preview, cloned from a template** (the branch-demo pattern, in the seed
`orca.config.ts`):

```sh
export DB_NAME={db} && cd backend && bash '${ORCA_DEV_ROOT}/orca/scripts/preview-db.sh' create {db} && …   # command
cd backend && bash '${ORCA_DEV_ROOT}/orca/scripts/preview-db.sh' drop {db}                                  # onStop
```

`scripts/preview-db.sh create <db>` clones `PREVIEW_TEMPLATE_DB` (default `branch_demo`) with
`CREATE DATABASE … WITH TEMPLATE`, then runs the worktree's own `scripts/migrate-local.sh`. It reads
`DB_HOST`, `DB_PORT`, `DB_MASTER_USER` and `PGPASSWORD` from the worktree's `.env` (so list that file
in `copyToWorktree`), and it only ever touches databases named `orca_*`. Cloning briefly
disconnects the template, so anything connected to it has to reconnect.

To make a configured preview the new template, use `orca preview --repo <r> --branch <b>
--push-to-template` (a dry run), then add `--confirm`. See [WORKFLOW.md](WORKFLOW.md#previews).

**Screenshots** for workers come from the bridge's one capped browser (`orca-shot`), which needs a
`chrome-headless-shell` on the box: Playwright's, under `~/.cache/ms-playwright`, or one named by
`ORCA_SHOT_BROWSER`. cloud-init doesn't install one.

---

## 10. Adding a laptop instance

The laptop runs its own bridge against the box's database and shows the same board.

1. **On the laptop:** install Bun, `git`, `gh` (`gh auth login`, `gh auth setup-git`), the Claude CLI
   (plus hydra if you use several logins), and Tailscale, joined to the same tailnet.
2. Clone Orca and the repos you want to run locally under one directory (your `ORCA_DEV_ROOT`), then
   `bun install`.
3. `cp .env.example .env` and set:

   ```sh
   ORCA_DEV_ROOT=$HOME/<dev-dir>
   ORCA_INSTANCE=local
   ORCA_BIND=127.0.0.1,<laptop-tailnet-ip>          # the box must reach the laptop
   ORCA_DATABASE_URL=postgres://orca:<db-password>@<box-name>.<tailnet>.ts.net:5432/orca   # bootstrap.sh printed this
   ORCA_TEST_DATABASE_URL=postgres://localhost:5432/postgres                               # a local Postgres for tests
   SLACK_TOKEN=xoxp-…                               # Slack posts go from the instance you click on
   ```

4. Name both instances in the config document, and pin the orchestrator to the box:

   ```json
   "instances": { "cloud": "http://<box-tailnet-ip>:8787", "local": "http://<laptop-tailnet-ip>:8787" },
   "orchestratorOn": "cloud",
   "instanceHourlyUsd": { "local": 0 }
   ```

   A repo's `runsOn` sets its default instance. Any workstream can still be placed with the Add New
   box's "run on" picker or `orca spawn --on local`, and moved with **Move to …** / `orca move`.

5. Run it: `bun run dev` (bridge on `:8787`, UI on `http://localhost:8788`), or `bun run build`
   then `bun run server`.

Notes:

- Run the laptop's bridge from its **main checkout**, not a worktree. A bridge in a worktree refuses
  to migrate the shared database.
- On macOS, agent runs aren't memory-capped (there's no `systemd-run`).
- A repo with `previewSecureContext: true` gets the box's preview forwarded to `localhost` for a page
  served from localhost. Other repos open the box's tailnet URL.
- A laptop that's asleep is "down" for anything placed on it. Requests forwarded to it fail until it
  wakes.

---

## 11. Memory ceilings

A 16 GB box once ran 4–5 builds at once. The kernel OOM killer then fired system-wide, and Postgres,
Tailscale and SSM were unreachable for 12 minutes. Since then:

- **Every agent run gets its own scope:** `systemd-run --user --scope -p MemoryMax=<agentMemoryMaxGb>G
  -p MemorySwapMax=0 -p CPUWeight=<agentCpuWeight>` (`server/cgroup.ts`). A runaway build is killed
  inside its own scope, and the rest of the box carries on. The run's turn says `out of memory (<N> GB
  ceiling)`, its stop reason is `error`, and the ledger records `errorKind: "oom"`. The Memory chart
  on the Overview marks each OOM kill.
- The default is **4 GB**, and it can't be turned off, only raised. On the original box, 4 GB
  OOM-killed a large frontend type-check and a whole-project `tsc`, so those repos use
  `agentMemoryMaxGb: 8`.
- This needs a reachable user bus. `bootstrap.sh` runs `loginctl enable-linger orca` for that.
  Without it, runs go un-capped rather than failing, because `cgroup.available()` checks for the bus
  socket.
- **There's no cap on how many workers run at once.** The fix is bounding each one, not limiting the
  count. Keep workers to their affected test files, and keep headless browsers out of them (use
  `orca-shot`).
- `orca.service` holds the bridge and everything it runs directly to `MemoryMax=13G`, with
  `OOMScoreAdjust=-500`.

To check for OOM kills:

```sh
journalctl --user | grep -i oom-kill        # as orca: per-run scopes are user scopes
curl -s 'http://127.0.0.1:8787/api/diagnostics?format=text'
```

---

## 12. Verify it works

On the box, as `orca`:

```sh
systemctl status orca                                   # active (running)
journalctl -u orca -f                                   # bridge log
curl -s http://127.0.0.1:8787/api/config | jq '.repos[].name'
curl -s http://127.0.0.1:8787/api/health | jq           # CPU, memory, disk, rate, month cost
curl -s 'http://127.0.0.1:8787/api/diagnostics?format=text'   # run ledger, hydra routing, last reap, migrations
curl -s http://127.0.0.1:8787/api/usage | jq '.routing' # shim: true means hydra is routing launches
bun run db:check                                        # the migration ledger (read-only)
orca board                                              # bin/orca on PATH, or /opt/orca/bin/orca board
systemctl list-timers orca-autodeploy.timer
tail -n 20 ~/.orca/autodeploy.log
```

From your laptop, open `http://<box-name>.<tailnet>.ts.net:8787` (or `http://<box-tailnet-ip>:8787`).
Then do a first end-to-end run:

1. Press `C`, choose your repo, leave the model on **Auto**, and describe a tiny change. The
   orchestrator should spawn one workstream.
2. Watch the card go from running to done. The Chat tab shows the worker's reply, and the card shows
   **Verified** if `checkCommand` is set.
3. With `mergePolicy.autoPr`, the PR opens on its own. Mark it with **Merge when green** and watch
   the queue merge it once CI passes.

`QA.md` has the manual runbook against real GitHub and Slack.

---

## 13. Upgrading and auto-deploy

**Auto-deploy** (`deploy/autodeploy.sh`, every minute):

1. `git fetch origin main`. If `HEAD` already matches, it logs `up to date at <sha>` and stops.
2. **If anything is busy, it defers.** If the orchestrator is mid-wake (`GET /api/orchestrator` →
   `"running":true`) or any lease in `~/.orca/leases` has a live pid, it logs `deferred: busy` and
   tries again next tick. A worker survives a bridge restart, but an orchestrator wake doesn't. On a
   busy evening this can hold a deploy back for a long time (about 40 minutes once).
3. `git pull --ff-only`. If that fails, it logs `error: git pull --ff-only failed (local changes in
   /opt/orca?)`.
4. `bun run build`. **A failed build never restarts the service.** The old build keeps serving, and
   the log gets the build's tail.
5. `sudo -n systemctl restart orca`, then polls `/api/config` for up to 30 s and logs `deployed
   <sha>`.

Everything is logged one line per tick to `~/.orca/autodeploy.log`.

```sh
sudo systemctl stop orca-autodeploy.timer     # pause auto-deploy
sudo systemctl start orca-autodeploy.timer    # resume
```

**Manual deploy** (for example while auto-deploy keeps deferring). Check first that nothing important
is mid-run (`curl -s http://127.0.0.1:8787/api/orchestrator`, the board), because a restart cuts off
an orchestrator wake:

```sh
cd /opt/orca && git pull --ff-only && bun run build && sudo systemctl restart orca
```

**Migrations** run at bridge startup. Steps are append-only, and new ones are named
(`YYYYMMDD-slug`) and idempotent. A step name is reserved only by merging to `main`, so never point
a test or a worktree's bridge at the shared database. `bun run db:check` prints the ledger.

**Claude Code and hydra.** Upgrade the Claude CLI deliberately (see the `--bare` note in
[§3](#3-sign-in-on-the-box)). If `/api/usage` reports `routing.shim: false`, the hydra shim has gone
missing. Re-run `~/.local/share/claude-hydra/install.sh --shim` (with `HYDRA_RC=~/.bashrc` on the
box).

---

## 14. Troubleshooting and known pitfalls

| Symptom | Cause / fix |
| --- | --- |
| Bridge exits at startup: `ORCA_DEV_ROOT is not set` | Set it in `.env`. |
| A repo shows, but nothing launches, or the provider picker is empty | `providers` is empty by default. Add `["claude"]`, and check that the CLI is on the **service's** `PATH` (`Executable not found in $PATH` means it isn't). |
| Agents can't run tools / stall in `ask` mode | `agentPermissionMode` defaults to `ask`. Set `"bypass"` for repos you trust. |
| Worker fails with an untrusted-workspace error | [§8](#8-claude-code-trust-settings): trust the repo path in `~/.claude.json` **and** every hydra profile. |
| `Previews are not enabled for <repo>` | Set `features.previews: true` and add `previewServices`. |
| Preview opens `localhost` or is unreachable from the laptop | Set `ORCA_PREVIEW_HOST` (the tailnet name) and `ORCA_PREVIEW_BIND` (the tailnet IP) in the box's `.env`. `bootstrap.sh` doesn't set the second one. |
| Preview answers 403 "Blocked request" | The app's Vite config doesn't allow the tailnet host. See [§9](#9-previews-and-the-template-database). |
| Run ends with exit 143 | SIGTERM: usually `agentTimeoutMinutes` (45 in the seed config). Workers should commit and push early. |
| `out of memory (4 GB ceiling)` | Raise that repo's `agentMemoryMaxGb`. Run fewer and narrower tests. |
| Box unresponsive, load average very high | Make sure the per-run cgroups are active (`loginctl show-user orca -p Linger` → `yes`) and nothing is running headless browsers. |
| `deferred: busy` in `autodeploy.log` for a long time | Expected while agents or the orchestrator run. Wait, or deploy manually when it's safe ([§13](#13-upgrading-and-auto-deploy)). |
| `build failed, not restarting` | `main` doesn't build. The old build is still serving. Fix `main`. |
| `git pull --ff-only failed` | Someone edited `/opt/orca` directly. Work in a worktree and a PR instead. Restore the checkout to `origin/main`. |
| Every run lands on one Claude login | The hydra shim is missing from the service `PATH` (`routing.shim: false`). See [§13](#13-upgrading-and-auto-deploy). |
| Laptop can't reach the database | Postgres must listen on `*` and `pg_hba.conf` must allow `100.64.0.0/10` (cloud-init does both). Use the box's tailnet name or IP. |
| `bun run check` fails its database tests on the box | The tests create schemas in `ORCA_TEST_DATABASE_URL`, and the `orca` role may lack permission there. GitHub CI (`.github/workflows/check.yml`) is the authoritative gate. |
| A worktree's bridge refuses to migrate | Intended. Use your own database plus `ORCA_ALLOW_WORKTREE_MIGRATIONS=1`, or don't run a bridge from a worktree. |
| PWA won't install, or there's no offline page | The service worker needs HTTPS, and a plain-`http` tailnet URL isn't a secure context. |
| Home-screen icon didn't update on iOS | iOS caches it. Remove and re-add the shortcut. |
| Orchestrator seems to have forgotten something | Read `orca notes`. Its session is disposable, and its notes are what carries over. |
| Your own PRs don't appear on the board | The PR lanes show PRs authored by the `gh` account on the box ([§1](#1-prerequisites)). |
