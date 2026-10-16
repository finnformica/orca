# Setting up your own Orca

> This document uses ASD-STE100 Simplified Technical English (STE). Orca's agents write all
> human-facing prose in STE. The rules are in `shared/writingStyle.ts`.

This guide starts from zero and ends with a working Orca. The result is one EC2 box. The box runs
the bridge, the web UI and the orchestrator. You reach the box only over Tailscale. As an option,
your laptop can be a second instance.
For the work that Orca does when it runs, see [WORKFLOW.md](WORKFLOW.md).

All commands in this guide come from `deploy/`, `bin/`, `scripts/` and `server/`. You supply the
values in `<angle brackets>`. **Do not commit these values.**

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
15. [Server switcher](#15-server-switcher)

---

## 1. Prerequisites

| You need | Why / notes |
| --- | --- |
| **An AWS account** and the `aws` CLI on your laptop. The CLI must be signed in. It must have permission to use SSM Parameter Store, create a security group, `run-instances`, and pass the instance role. | `deploy/provision.sh` runs from your laptop. |
| **The `AmazonSSMRoleForInstancesQuickSetup` instance profile** | `provision.sh` attaches the profile with that exact name. Systems Manager's *Quick Setup* creates it. If the profile does not exist, create a role with `AmazonSSMManagedInstanceCore`. Then create an instance profile with that name. The box also uses this role to read its Tailscale key from Parameter Store (`ssm get-parameter --with-decryption`). Thus the role must have permission to read that parameter. |
| **An instance size** | The default is **`m7i.xlarge`** (4 vCPU, 16 GB RAM) with a **150 GB gp3** root disk in **`eu-west-2`**, on Ubuntu 24.04 amd64. The on-demand cost is approximately $0.2331 per hour. `deploy/orca.service` sets `MemoryMax=13G` for 16 GB. If you select a different size, change this value. Worktrees, preview databases and test containers use most of the disk. |
| **A Tailscale tailnet** and a **pre-auth key** (`tskey-auth-…`) | The box has **no inbound security-group rules**. You reach it only over the tailnet (and SSM for emergency access). The API has no authentication of its own. Thus, do not make it public, and do not bind it to `0.0.0.0`. |
| **A GitHub account for the box** with write access to all repos that Orca manages. A bot account is a good choice. | The box signs in one time with `gh auth login`. Note: the PR lanes on the board use `gh pr list --author @me`. Thus they show only PRs **that the signed-in `gh` account wrote**. With a bot account, the board shows the PRs of workers, but not the PRs that you make by hand. |
| **A Claude subscription login** (one or more) | Orca runs `claude -p` with the login of the CLI. Thus you do **not need an API key**. More than one login is optional. [claude-hydra](https://github.com/finnformica/claude-hydra) sends each launch to the login with the most headroom. |
| Optional: `codex` / `cursor-agent`, signed in | Necessary only for repos that list them in `providers`. |
| Optional: a Slack **user** token (`xoxp-…`) | Orca uses it to post notify/bump messages. Keep it on the laptop (see [§10](#10-adding-a-laptop-instance)). |

cloud-init installs Bun, Postgres, `gh`, the Claude CLI and hydra **on the box**. You do not
install them on the box yourself.

---

## 2. Provision the box

Do these steps from a checkout of Orca **on your laptop**:

```sh
# 1. Store the Tailscale auth key in Parameter Store (the box reads it at first boot; it never
#    appears in user-data or on disk in this repo).
aws ssm put-parameter --region eu-west-2 --name /orca/tailscale-authkey --type SecureString --value <tskey-auth-…>

# 2. Launch. Both arguments are optional: instance type (default m7i.xlarge), disk GB (default 150).
#    AWS_REGION overrides eu-west-2. VANTA_OWNER sets the owner tag. Set it to your own email, or the
#    script's built-in default is used.
VANTA_OWNER=<you@example.com> deploy/provision.sh m7i.xlarge 150
```

`provision.sh` does these steps:

- It does not start until `/orca/tailscale-authkey` exists.
- It finds the current Ubuntu 24.04 amd64 AMI from SSM. It also finds the **default VPC**.
- It uses again (or creates) a security group with the name `orca-server` and **no ingress**.
- It runs an instance with the name `orca-server`. The instance has the SSM instance profile, a gp3
  root volume and IMDS `HttpTokens=optional`. Its user-data is `deploy/cloud-init.yaml`. Its tags
  are `Project=orca`, `VantaOwner`, `VantaNonProd=true`, `VantaContainsUserData=false` and
  `VantaDescription`.
- It waits for `instance-running`. Then it shows the SSM command that you use to get in.

**The steps that cloud-init does without a person.** These steps take approximately 5 minutes. The
log is `/var/log/cloud-init-output.log` on the box.

- It sets the hostname to `orca-box`. It installs `git jq curl unzip postgresql postgresql-contrib
  build-essential` and the `aws-cli` snap.
- It creates the user **`orca`** (sudo, `NOPASSWD:ALL`, bash).
- It installs Tailscale and runs `tailscale up --authkey=… --hostname=orca-box --ssh`.
- It sets up Postgres. It creates the role `orca` with the password `orca`, and the database `orca`
  that this role owns. It sets `listen_addresses='*'`. It adds a `pg_hba.conf` line that permits
  only `100.64.0.0/10` (the tailnet range) with `scram-sha-256`.
- It installs `gh` from the apt repo of GitHub.
- It installs these items for the `orca` user: **Bun** (`bun.sh/install`), the **Claude CLI**
  (`claude.ai/install.sh`), and **claude-hydra** with its shim (`install.sh --shim`, set to
  `~/.bashrc`). It adds `~/.local/bin` and `~/.bun/bin` to `PATH` in `.bashrc`.
- It creates `/opt/orca`, with `orca` as the owner. It writes an MOTD that tells you that the box is
  ready for sign-in.

> **Change the database password.** cloud-init uses `orca`/`orca`. Only tailnet addresses can get
> access to the database. If you change the password
> (`sudo -u postgres psql -c "ALTER ROLE orca PASSWORD '<new>'"`), update `ORCA_DATABASE_URL` /
> `ORCA_TEST_DATABASE_URL` in `.env` on all instances.

---

## 3. Sign in on the box

A sign-in needs a person. Open a session and change to the user `orca`:

```sh
aws ssm start-session --region eu-west-2 --target <instance-id>
sudo -iu orca
```

(When the box is on your tailnet, you can also use `tailscale ssh orca@orca-box`. cloud-init
enabled Tailscale SSH. The ACLs of your tailnet control if this access is permitted.)

Then do these steps:

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

**Pin the Claude Code version on the box.** Look at `claude --version`. Read the release notes
before you upgrade. A future release will make `--bare` the default for `-p`. Bare mode does not
read OAuth credentials. Thus all launches that use a subscription login will fail, and no error
will show.

---

## 4. Bootstrap: build, `.env`, systemd

As the user `orca` on the box, run this command:

```sh
/opt/orca/deploy/bootstrap.sh
```

`deploy/bootstrap.sh` does these steps:

1. It reads the tailnet IPv4 address of the box (`tailscale ip -4`) and its MagicDNS name
   (`tailscale status --json | jq -r .Self.DNSName`).
2. It runs `bun install --frozen-lockfile`, then `bun run build` (the production UI build).
3. It runs `sudo loginctl enable-linger orca`. This gives the service account a user systemd
   manager at boot. The per-worker memory ceiling needs this manager (see
   [§11](#11-memory-ceilings)).
4. It writes `/opt/orca/.env`, **only if this file does not exist**:

   ```sh
   ORCA_DEV_ROOT=/opt
   ORCA_INSTANCE=cloud
   ORCA_BIND=127.0.0.1,<tailnet-ip>
   ORCA_PREVIEW_HOST=<box-name>.<tailnet>.ts.net
   ORCA_DATABASE_URL=postgres://orca:orca@localhost:5432/orca
   ORCA_TEST_DATABASE_URL=postgres://orca:orca@localhost:5432/postgres
   ```

5. It installs and starts the bridge: `deploy/orca.service` → `/etc/systemd/system/orca.service`,
   `daemon-reload`, `enable --now orca`.
6. It installs auto-deploy. It puts `orca-autodeploy.service` and `.timer` into
   `/etc/systemd/system/`. It puts `orca-autodeploy.sudoers` → `/etc/sudoers.d/orca-autodeploy`
   (mode 440) and checks it with `visudo -c`. Then it runs `enable --now orca-autodeploy.timer`.
7. It shows the UI URL (`http://<box-name>.<tailnet>.ts.net:8787`). It also shows the database URL
   for your laptop.

**Then add `ORCA_PREVIEW_BIND` yourself.** `bootstrap.sh` does not write it. Its default is
`127.0.0.1`. With this default, only the box can get access to the preview services on the box:

```sh
echo "ORCA_PREVIEW_BIND=<tailnet-ip>" >> /opt/orca/.env
sudo systemctl restart orca
```

### The systemd units

| Unit | Description |
| --- | --- |
| `orca.service` | The bridge: `User=orca`, `WorkingDirectory=/opt/orca`, `ExecStart=/home/orca/.bun/bin/bun run server/index.ts`, `Restart=always` (3 s). `PATH` lists `~/.hydra/bin` **first** (the `claude` shim of hydra), then `~/.bun/bin` and `~/.local/bin`. `MemoryMax=13G` is approximately 85% of 16 GB. This limit applies to the bridge and to the processes that it runs directly, for example previews and git/gh. It does **not** apply to agent runs, because each agent run gets its own scope. Other settings: `OOMScoreAdjust=-500`, `KillSignal=SIGTERM`, `TimeoutStopSec=15`. At stop, the bridge completes its history writes. It does not stop agents and previews. Bun loads `/opt/orca/.env` automatically. |
| `orca-autodeploy.service` | Oneshot, `User=orca`. It runs `deploy/autodeploy.sh` (with the same `PATH`). |
| `orca-autodeploy.timer` | `OnBootSec=2min`, `OnUnitActiveSec=1min`. |
| `/etc/sudoers.d/orca-autodeploy` | `orca ALL=(root) NOPASSWD: /usr/bin/systemctl restart orca`. This is the one privileged step that auto-deploy needs. (The general `NOPASSWD:ALL` from cloud-init already permits it. The rule keeps auto-deploy working if a person makes that general permission smaller.) |

Postgres and Tailscale are separate units. They are never children of `orca.service`. Thus the two
memory limits do not apply to them.

---

## 5. Environment variables (`.env`)

`.env` is at the root of the checkout. Git ignores it, and Bun loads it automatically. Each machine
has its own `.env`. Start from `.env.example`. This table shows all variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORCA_DEV_ROOT` | **required** | The directory that holds the managed repos. Config paths are stored as templates, for example `${ORCA_DEV_ROOT}/<repo>`. Each machine expands them. On the box, the value is `/opt`. If this variable is not set, the bridge fails at startup. |
| `ORCA_DATABASE_URL` | none | The Postgres database that holds all shared data: turns, enrichment, config, notifications, metrics, attachments. All instances use **one** database. |
| `ORCA_TEST_DATABASE_URL` | none | The Postgres database for `bun test`. Each test file gets a temporary schema. The tests refuse all other databases. |
| `ORCA_INSTANCE` | the hostname | The instance name of this process (`cloud`, `local`). Orca compares it with the `runsOn` of a repo, `orchestratorOn` and `instances`. |
| `ORCA_BIND` | `127.0.0.1` | The listen addresses, separated by commas. If another instance must get access to a machine, the machine binds `127.0.0.1,<tailnet-ip>`. Loopback is **not** optional: `bin/orca` and the Vite proxy of an Orca preview use it. Do not use `0.0.0.0`. |
| `ORCA_PREVIEW_HOST` | `localhost` | The host name in preview links (`{host}` in a preview command). On the box, use its tailnet name. |
| `ORCA_PREVIEW_BIND` | `127.0.0.1` | The address that preview services listen on (`{bind}`). On the box, use its tailnet IP. |
| `ORCA_API_PORT` | `8787` | The port of the bridge. |
| `ORCA_UI_PORT` | `8788` | The port of the Vite dev UI (only for `bun run dev`). |
| `ORCA_STATE_DIR` | `~/.orca` | The operational files of each host: run leases, the run ledger, the working directory of the orchestrator, handoff files, the attachment cache, env backups, `autodeploy.log`. Orca keeps this directory out of all worktrees. |
| `ORCA_USER` | `me` | The row owner in the database. Orca uses it until it has real authentication. |
| `ORCA_IMDS_URL` | `http://169.254.169.254` | The EC2 metadata service. Orca uses it for the machine-cost estimate. |
| `SLACK_TOKEN` | none | A Slack user token (`xoxp-…`). Orca posts messages with no changes, from your identity. If the token is not set, a send fails with a clear error, and Orca copies the message to your clipboard. |
| `ORCA_ALLOW_WORKTREE_MIGRATIONS` | unset | A bridge that runs from a git **worktree** does not apply migrations. The reason is that the copied `.env` of a worktree usually names the shared database. Set this variable to `1` only when the worktree has its own database. |
| `ORCA_PREVIEW_BRIDGE` | unset | Only `scripts/preview-orca.sh` sets it. It makes the bridge the read-only `/api` of an Orca preview. |
| `ORCA_SHOT_BROWSER` | the newest Playwright `chrome-headless-shell` in `~/.cache/ms-playwright`, else one on `PATH` | The browser that the screenshot service (`orca-shot`) controls. |
| `ORCA_URL` | `http://127.0.0.1:$ORCA_API_PORT` | The bridge that `bin/orca` and `orca-shot` call. |
| `TS_OAUTH_CLIENT_ID` | none | The Tailscale OAuth client for the server switcher ([§15](#15-server-switcher)). |
| `TS_OAUTH_CLIENT_SECRET` | none | The secret of that OAuth client. Orca sends it only to the Tailscale API. Orca does not write it to a log. |
| `ORCA_SERVER_URL` | `http://<MagicDNS name>:<port>` | The URL of this server in the server switcher. Set it only when the MagicDNS name from `tailscale status` is wrong. |
| `ORCA_TAILSCALE_BIN` | `tailscale` on `PATH`, else `/usr/bin/tailscale` | The Tailscale CLI that the server switcher uses for `whois` and `status`. |

Agents never see the secrets of Orca. Orca removes `SLACK_TOKEN`, `ORCA_DATABASE_URL`,
`ORCA_TEST_DATABASE_URL`, `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_CLIENT_SECRET` from the environment of each agent (`agentEnv` in `server/agent.ts`).

`deploy/autodeploy.sh` also reads `ORCA_REPO` (default `/opt/orca`), `ORCA_SERVICE_NAME` (`orca`),
`ORCA_BRIDGE_URL` (`http://127.0.0.1:8787`) and `ORCA_STATE_DIR`.

---

## 6. The config document

**The live configuration is in Postgres**, not in a file. Thus all instances that share the
database read the same config. Changes apply in approximately 5 seconds, without a restart.

- **First boot:** if the database has no repos, Orca **seeds** it one time from the
  `orca.config.ts` of the checkout. It stores paths as `${ORCA_DEV_ROOT}/…` templates. After that,
  Orca ignores the file. The checked-in file names the repos of the original author. Thus, plan to
  replace them (see below).
- **Settings → config** in the UI is **read-only**. There, you can edit only the **Machine cost**
  rate (`POST /api/config/instance-rate`).
- **Editing:** read the document, edit it, and write it back. **The document is the unit. If a repo
  is not in the document that you PUT, Orca removes that repo.** Orca rejects incorrect input and
  lists all problems. It applies no part of incorrect input.

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

Do not edit `orca.config.ts` in `/opt/orca` on the box to change the config. Orca does not read
this file after it seeds the database. Also, a local change can cause the `git pull --ff-only` of
auto-deploy to fail.

### Top-level settings

| Key | Default | Meaning |
| --- | --- | --- |
| `repos` | **required**, not empty | The managed repos. The first repo is the default. See below. |
| `portRange` | `[30000, 40000]` | The port range for preview services. The range includes the two limits. |
| `staleHours` | `24` | The time before Orca can bump the Slack message of a PR. |
| `agentTimeoutMinutes` | none | The maximum time for one agent run. The seed config sets `45`. When this limit stops a run, the run ends with SIGTERM (exit 143). |
| `agentModel` | the default of the CLI | The default `--model` for the Claude runs of all repos. |
| `instances` | none | `{ "<name>": "http://<tailnet-ip>:8787" }` for each instance. With this setting, each instance can forward to the other. |
| `instanceHourlyUsd` | none | `{ "<name>": <usd per hour> }`. If it is not set, Orca uses an EC2 on-demand estimate from instance metadata. If that is not available, the value is 0. |
| `orchestratorOn` | the instance that gets the message | The instance where the orchestrator lives. **Set it when you have more than one instance.** Then only one process wakes the orchestrator. |
| `orchestratorShell` | `true` | `false` limits the orchestrator to `orca`, reading, the web and read-only subagents. Use this on a shared box. |
| `orchestratorWakeBudgetUsd` | none (no limit) | `--max-budget-usd` for one orchestrator wake. |
| `agentCpuWeight` | `50` | The systemd `CPUWeight` for the scope of each agent run (1–10000). With it, workers give CPU to the bridge first. |

### Per-repo settings

| Key | Default | Meaning |
| --- | --- | --- |
| `name` | **required** | A slug (letters, digits, dashes). Orca uses it in URLs and as `--repo`. |
| `repoPath` | **required** | `${ORCA_DEV_ROOT}/<name>`. |
| `worktreeRoot` | **required** | Usually `${ORCA_DEV_ROOT}/<name>/.worktrees`. |
| `baseBranch` | **required** | The target branch of PRs, for example `main` or `master`. |
| `providers` | **none** | The CLIs that can run in this repo: `["claude"]`, and `"codex"` / `"cursor"` if necessary. **If the list is empty, no agent can launch.** |
| `agentPermissionMode` | **`ask`** | `"bypass"` runs agents with `--permission-mode bypassPermissions`. `ask` runs them with `default`. In `default` mode, a headless run cannot approve tools. |
| `features` | **all off** | `slack`, `followAutomation` (new PR feedback and failed checks start agent runs), `aiPrDescription`, `autoMerge`, `previews`, `aiTitles`. Each one is `true`/`false`. Orca rejects unknown keys. |
| `checkCommand` | none | The verification gate, for example `bun run check`. Orca runs it in the worktree after each run that committed. |
| `agentModel` | the top-level `agentModel` | The Claude model of this repo. |
| `agentMaxBudgetUsd` | none | `--max-budget-usd` for each run (stop reason `budget_reached`). |
| `agentMemoryMaxGb` | `4` | The memory ceiling for each run. See [§11](#11-memory-ceilings). |
| `runsOn` | any instance | The default instance for new workstreams. |
| `mergePolicy` | never merge, never open PRs | `{ whenGreen: "never"\|"small"\|"any", denyPaths: [globs], autoPr: bool }`. See [WORKFLOW.md](WORKFLOW.md#from-finished-run-to-merged-pr). |
| `modelEscalation` | `suggest` | `"apply"` pins a worker to the next higher model after two failures in sequence. |
| `previewServices` | `[]` | `[{ name, command, open?, onStop? }]`. See [§9](#9-previews-and-the-template-database). |
| `previewSecureContext` | `false` | Set it when the app needs a secure context (for example `crypto.randomUUID`). Then, for a laptop page on localhost, Orca forwards the preview of the box to `http://localhost:<port>`. |
| `previewLabel` | `preview` | The PR label that the "Add preview" action adds. |
| `prLabels` | none | The labels in the Promote menu: `[{ name, default? }]`. |
| `slackChannel` | none | The channel that the notify/bump message names. |
| `copyToWorktree` | none | Gitignored files that Orca copies from the main checkout into each worktree (for example `backend/.env`). `--push-to-template` writes back to the `.env` in this list. |
| `linkToWorktree` | none | Large directories that Orca supplies to each worktree. Orca makes a copy-on-write clone of `node_modules`, and makes symlinks for other paths. |
| `changelogFiles` | `["**/CHANGELOG.md"]` | If a conflict is only in these files, Orca merges it itself (`git merge-file --union`). `[]` turns this off. |
| `testContainerPrefix` | none | The prefix of the test Docker containers of the repo. The hourly reaper removes containers that are more than 3 hours old. |

---

## 7. Adding a repo

1. **Check out the repo on the instance that runs it.** Do this as `orca`, under `ORCA_DEV_ROOT`:
   `git clone <repo-url> /opt/<repo-name>`. Make sure that the `gh` account can push to it.
2. **Trust the repo in Claude Code** ([§8](#8-claude-code-trust-settings)).
3. **Add the repo to the document** ([§6](#6-the-config-document)). Make a backup, add an entry, and
   do the PUT. This is a minimal entry that runs agents:

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

4. To replace the seeded repos (`branch-demo`, `orca`), do not include them in the document. Orca
   then removes them from the config. Their history stays in the database.
5. Open the UI. The repo shows in the repo switcher and on the **Repos** page.

---

## 8. Claude Code trust settings

Claude Code keeps a "do you trust this folder?" flag for each directory. If a headless worker starts
in a repo that is not trusted, it fails with an untrusted-workspace error. Orca does not set this
flag for you. Set `projects["<repo path>"].hasTrustDialogAccepted = true` for each repo path in
these files:

- **`~/.claude.json`**.
- **The `.claude.json` of each hydra profile**. Hydra can send a run to any profile.

```sh
# as orca, for each repo path
for f in ~/.claude.json "$(hydra dir <profile>)/.claude.json"; do   # repeat for every profile (`hydra list`)
  tmp=$(mktemp) && jq --arg p /opt/<repo-name> '.projects[$p].hasTrustDialogAccepted = true' "$f" > "$tmp" && mv "$tmp" "$f"
done
```

As an alternative, start `claude` interactively one time in the repo directory, under each profile.
Then accept the prompt.

---

## 9. Previews and the template database

Turn on previews for each repo. Set `"features": { "previews": true }` and add one or more
`previewServices` entries. You can use these placeholders in a command:

- `{port}`: the assigned port of this service. `{svc:<name>}`: the port of a different service.
- `{bind}`: `ORCA_PREVIEW_BIND`, the address to listen on. `{host}`: `ORCA_PREVIEW_HOST`. Use it in
  all URLs that go to the browser.
- `{db}`: a database name for each worktree (`orca_…`). `onStop` runs at teardown. Usually it
  removes this database.
- `open: true` sets the service that the **Open** button opens.

**Vite apps must permit the tailnet Host header.** If they do not, they answer 403 "Blocked
request". Vite 5 has no environment variable for this. The `vite.config.ts` of the app must read a
variable into `server.allowedHosts`. Orca's `web/vite.config.ts` does this with `ORCA_PREVIEW_HOST`
and `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`. This is the preview command of Orca itself:

```sh
cd web && export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS={host} && bunx --bun vite --host {bind} --port {port}
```

**A database for each preview, cloned from a template.** This is the branch-demo pattern, in the
seed `orca.config.ts`:

```sh
export DB_NAME={db} && cd backend && bash '${ORCA_DEV_ROOT}/orca/scripts/preview-db.sh' create {db} && …   # command
cd backend && bash '${ORCA_DEV_ROOT}/orca/scripts/preview-db.sh' drop {db}                                  # onStop
```

`scripts/preview-db.sh create <db>` clones `PREVIEW_TEMPLATE_DB` (default `branch_demo`) with
`CREATE DATABASE … WITH TEMPLATE`. Then it runs the `scripts/migrate-local.sh` of the worktree. It
reads `DB_HOST`, `DB_PORT`, `DB_MASTER_USER` and `PGPASSWORD` from the `.env` of the worktree. Thus,
put that file in `copyToWorktree`. The script changes only databases with names that match
`orca_*`. A clone disconnects the template for a short time. Clients of the template must connect
again.

To make a configured preview the new template, run `orca preview --repo <r> --branch <b>
--push-to-template` (a dry run). Then add `--confirm`. See [WORKFLOW.md](WORKFLOW.md#previews).

**Screenshots** for workers come from the one browser of the bridge (`orca-shot`), which has
limits. This browser needs a `chrome-headless-shell` on the box. Use the Playwright browser under
`~/.cache/ms-playwright`, or set one with `ORCA_SHOT_BROWSER`. cloud-init does not install a
browser.

---

## 10. Adding a laptop instance

The laptop runs its own bridge with the database of the box. It shows the same board.

1. **On the laptop**, install these items:
   - Bun and `git`.
   - `gh`. Then run `gh auth login` and `gh auth setup-git`.
   - The Claude CLI. Add hydra if you use more than one login.
   - Tailscale. Join it to the same tailnet.
2. Clone Orca and the repos that you want to run locally under one directory. This directory is
   your `ORCA_DEV_ROOT`. Then run `bun install`.
3. Run `cp .env.example .env` and set these values:

   ```sh
   ORCA_DEV_ROOT=$HOME/<dev-dir>
   ORCA_INSTANCE=local
   ORCA_BIND=127.0.0.1,<laptop-tailnet-ip>          # the box must reach the laptop
   ORCA_DATABASE_URL=postgres://orca:<db-password>@<box-name>.<tailnet>.ts.net:5432/orca   # bootstrap.sh printed this
   ORCA_TEST_DATABASE_URL=postgres://localhost:5432/postgres                               # a local Postgres for tests
   SLACK_TOKEN=xoxp-…                               # Slack posts go from the instance you click on
   ```

4. Name the two instances in the config document. Pin the orchestrator to the box:

   ```json
   "instances": { "cloud": "http://<box-tailnet-ip>:8787", "local": "http://<laptop-tailnet-ip>:8787" },
   "orchestratorOn": "cloud",
   "instanceHourlyUsd": { "local": 0 }
   ```

   The `runsOn` of a repo sets its default instance. You can put any workstream on an instance with
   the "run on" picker of the Add New box or with `orca spawn --on local`. You can move it with
   **Move to …** / `orca move`.

5. Start it. Use `bun run dev` (bridge on `:8787`, UI on `http://localhost:8788`). Or use
   `bun run build`, then `bun run server`.

Notes:

- Run the bridge of the laptop from its **main checkout**, not from a worktree. A bridge in a
  worktree does not migrate the shared database.
- On macOS, agent runs have no memory ceiling (macOS has no `systemd-run`).
- For a repo with `previewSecureContext: true`, Orca forwards the preview of the box to `localhost`
  for a page from localhost. Other repos open the tailnet URL of the box.
- When the laptop sleeps, it is "down" for all work on it. Requests that Orca forwards to it fail
  until it wakes.

---

## 11. Memory ceilings

One time, a 16 GB box ran 4–5 builds at the same time. Then the kernel OOM killer stopped processes
across the full system. Postgres, Tailscale and SSM were not available for 12 minutes. Since then,
these rules apply:

- **Each agent run gets its own scope:** `systemd-run --user --scope -p MemoryMax=<agentMemoryMaxGb>G
  -p MemorySwapMax=0 -p CPUWeight=<agentCpuWeight>` (`server/cgroup.ts`). If a build uses too much
  memory, the kernel kills it inside its own scope. The rest of the box continues to work. The turn
  of the run says `out of memory (<N> GB ceiling)`. Its stop reason is `error`, and the ledger
  records `errorKind: "oom"`. The Memory chart on the Overview shows each OOM kill.
- The default is **4 GB**. You cannot turn it off. You can only make it larger. On the original
  box, 4 GB caused OOM kills of a large frontend type-check and of a `tsc` for the full project.
  Thus those repos use `agentMemoryMaxGb: 8`.
- This function needs a user bus that Orca can reach. `bootstrap.sh` runs
  `loginctl enable-linger orca` for this. Without the bus, runs have no memory ceiling, but they do
  not fail. The reason is that `cgroup.available()` checks for the bus socket.
- **There is no limit on the number of workers that run at the same time.** The solution is a limit
  on each worker, not a limit on the count. Keep workers to their affected test files. Do not let
  workers run headless browsers (use `orca-shot`).
- `orca.service` limits the bridge, and the processes that it runs directly, to `MemoryMax=13G`,
  with `OOMScoreAdjust=-500`.

To look for OOM kills, run these commands:

```sh
journalctl --user | grep -i oom-kill        # as orca: per-run scopes are user scopes
curl -s 'http://127.0.0.1:8787/api/diagnostics?format=text'
```

---

## 12. Verify it works

On the box, as `orca`, run these commands:

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

1. Push `C`. Select your repo. Keep the model on **Auto**. Describe a very small change. The
   orchestrator spawns one workstream.
2. Watch the card change from running to done. The Chat tab shows the reply of the worker. If
   `checkCommand` is set, the card shows **Verified**.
3. With `mergePolicy.autoPr`, Orca opens the PR automatically. Mark the PR with **Merge when
   green**. Then watch the queue merge it when CI passes.

`QA.md` has the manual procedure for real GitHub and Slack.

---

## 13. Upgrading and auto-deploy

**Auto-deploy** (`deploy/autodeploy.sh`) runs each minute and does these steps:

1. It runs `git fetch origin main`. If `HEAD` is already the same, it logs `up to date at <sha>`
   and stops.
2. **If Orca is busy, it waits.** Orca is busy when the orchestrator is in a wake
   (`GET /api/orchestrator` → `"running":true`) or when a lease in `~/.orca/leases` has a live pid.
   Then it logs `deferred: busy` and tries again at the next tick. A worker continues after a
   bridge restart, but an orchestrator wake does not. On a busy evening, this can stop a deploy for
   a long time (one time, approximately 40 minutes).
3. It runs `git pull --ff-only`. If that fails, it logs `error: git pull --ff-only failed (local
   changes in /opt/orca?)`.
4. It runs `bun run build`. **If the build fails, it does not restart the service.** The old build
   continues to serve, and the log gets the last lines of the build output.
5. It runs `sudo -n systemctl restart orca`. Then it polls `/api/config` for a maximum of 30 s and
   logs `deployed <sha>`.

Each tick writes one line to `~/.orca/autodeploy.log`.

```sh
sudo systemctl stop orca-autodeploy.timer     # pause auto-deploy
sudo systemctl start orca-autodeploy.timer    # resume
```

**Manual deploy** (for example, when auto-deploy waits for a long time). First, make sure that no
important run is active (`curl -s http://127.0.0.1:8787/api/orchestrator`, the board). A restart
stops an orchestrator wake.

```sh
cd /opt/orca && git pull --ff-only && bun run build && sudo systemctl restart orca
```

**Migrations** run when the bridge starts. Orca only adds steps and never changes them. New steps
have names (`YYYYMMDD-slug`) and are idempotent. Only a merge to `main` reserves a step name. Thus,
do not connect a test or the bridge of a worktree to the shared database. `bun run db:check` shows
the ledger.

**Claude Code and hydra.** Upgrade the Claude CLI only when you decide to (see the `--bare` note in
[§3](#3-sign-in-on-the-box)). If `/api/usage` reports `routing.shim: false`, the hydra shim is
missing. Run `~/.local/share/claude-hydra/install.sh --shim` again (with `HYDRA_RC=~/.bashrc` on
the box).

---

## 14. Troubleshooting and known pitfalls

| Symptom | Cause / fix |
| --- | --- |
| The bridge stops at startup: `ORCA_DEV_ROOT is not set` | Set it in `.env`. |
| A repo shows, but nothing launches, or the provider picker is empty | `providers` is empty by default. Add `["claude"]`. Make sure that the CLI is on the `PATH` **of the service**. `Executable not found in $PATH` tells you that it is not. |
| Agents cannot run tools / stop in `ask` mode | The default of `agentPermissionMode` is `ask`. Set `"bypass"` for repos that you trust. |
| A worker fails with an untrusted-workspace error | See [§8](#8-claude-code-trust-settings). Trust the repo path in `~/.claude.json` **and** in each hydra profile. |
| `Previews are not enabled for <repo>` | Set `features.previews: true` and add `previewServices`. |
| A preview opens `localhost`, or the laptop cannot get access to it | Set `ORCA_PREVIEW_HOST` (the tailnet name) and `ORCA_PREVIEW_BIND` (the tailnet IP) in the `.env` of the box. `bootstrap.sh` does not set the second one. |
| A preview answers 403 "Blocked request" | The Vite config of the app does not permit the tailnet host. See [§9](#9-previews-and-the-template-database). |
| A run ends with exit 143 | SIGTERM. Usually the cause is `agentTimeoutMinutes` (45 in the seed config). Workers must commit and push early. |
| `out of memory (4 GB ceiling)` | Increase the `agentMemoryMaxGb` of that repo. Run fewer tests, and run narrower tests. |
| The box does not respond, and the load average is very high | Make sure that the per-run cgroups are active (`loginctl show-user orca -p Linger` → `yes`). Make sure that no process runs a headless browser. |
| `deferred: busy` in `autodeploy.log` for a long time | This is normal while agents or the orchestrator run. Wait, or deploy manually when it is safe ([§13](#13-upgrading-and-auto-deploy)). |
| `build failed, not restarting` | The build of `main` fails. The old build continues to serve. Repair `main`. |
| `git pull --ff-only failed` | A person edited `/opt/orca` directly. Use a worktree and a PR. Restore the checkout to `origin/main`. |
| All runs go to one Claude login | The hydra shim is not on the `PATH` of the service (`routing.shim: false`). See [§13](#13-upgrading-and-auto-deploy). |
| The laptop cannot get access to the database | Postgres must listen on `*`, and `pg_hba.conf` must permit `100.64.0.0/10`. cloud-init does both. Use the tailnet name or IP of the box. |
| `bun run check` fails its database tests on the box | The tests create schemas in `ORCA_TEST_DATABASE_URL`. The `orca` role possibly does not have permission there. GitHub CI (`.github/workflows/check.yml`) is the gate that decides. |
| The bridge of a worktree does not migrate | This is intentional. Use your own database and `ORCA_ALLOW_WORKTREE_MIGRATIONS=1`, or do not run a bridge from a worktree. |
| The PWA does not install, or there is no offline page | The service worker needs HTTPS. A plain-`http` tailnet URL is not a secure context. |
| The home-screen icon did not update on iOS | iOS keeps the old icon in a cache. Remove the shortcut and add it again. |
| The orchestrator does not remember something | Read `orca notes`. Its session is temporary. Its notes are the data that continues to the next session. |
| Your own PRs do not show on the board | The PR lanes show the PRs that the `gh` account on the box wrote ([§1](#1-prerequisites)). |

---

## 15. Server switcher

The server switcher lets one browser use several Orca servers. Each server is fully separate: it has
its own database and its own config. The servers do not talk to each other. Only your browser talks
to each server. The web app changes the server that it calls.

The feature is off by default. When it is off, Orca does not change its behaviour.

### How it works

- `GET /api/servers` lists the Orca servers. The source is the Tailscale API, or the config list.
- A page from one listed server can call the `/api` and `/api/events` of another listed server
  (CORS). Other origins get no CORS headers.
- For each such cross-origin call, Orca runs `tailscale whois --json` on the caller address.
  Orca accepts only a user device. Orca refuses a tagged node, so a server cannot call another
  server. A refusal is a `403` with a JSON `error`.
- Same-origin calls and calls with no `Origin` header (the CLI, workers, other bridges) do not
  change.

Orca uses the Tailscale API and not `tailscale status`. A Tailscale ACL that blocks traffic between
the boxes also removes the other box from the local netmap.

### Set it up

1. Tag each Orca server. In the Tailscale admin console, add `tag:orca` to the `tagOwners` of the
   ACL policy:

   ```json
   "tagOwners": { "tag:orca": ["autogroup:admin"] }
   ```

2. Apply the tag to each box. Run `sudo tailscale up --advertise-tags=tag:orca` on the box, or
   edit the tags of the machine in the admin console.
3. Let your user devices reach each box on port 8787. Do not let a box reach another box.
4. Create an OAuth client. In the admin console, open **Settings → OAuth clients**. Give it the
   scope `devices:core:read`. Copy the client ID and the secret.
5. Add the two values to the `.env` of each server:

   ```sh
   TS_OAUTH_CLIENT_ID=<client id>
   TS_OAUTH_CLIENT_SECRET=<secret>
   ```

6. Restart the service: `sudo systemctl restart orca`.
7. In Settings, turn on **Server switcher**. The web app calls `POST /api/config/server-switcher`
   with `{"enabled": true}`.

### The config block

The `serverSwitcher` block of the config document ([§6](#6-the-config-document)) has these fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Turns the feature on. When it is `false`, `/api/servers` lists only this server, and no CORS or `whois` runs. |
| `tag` | `tag:orca` | The Tailscale tag of an Orca server. |
| `port` | `8787` | The port of each Orca server. Orca makes each URL as `http://<MagicDNS name>:<port>`. |
| `servers` | none | A list of `{ "name", "url" }`. Orca uses it when the OAuth client is not set or the API call fails. |
| `allowedLogins` | none | A list of Tailscale logins. When it is set, Orca accepts only these logins. |

### Caches

- Orca keeps the server list for 60 seconds.
- Orca keeps each `whois` result for 5 minutes, for each IP address. Orca does not keep a failed
  `whois`.
