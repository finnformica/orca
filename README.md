# 🐳 Orca

Orca automates the work between **managing coding agents** and **managing PRs**. You talk to one
**orchestrator**: a Claude Code session that delegates each piece of work to a **headless worker**
running in its own git worktree. Orca checks what the worker committed, opens the PR, and merges it
through a policy-governed **merge queue** once CI is green. A web console (installable on your phone)
shows every workstream, PR, preview and machine.

- **[docs/WORKFLOW.md](docs/WORKFLOW.md)**: how Orca works and how you work with it.
- **[docs/SETUP.md](docs/SETUP.md)**: deploying your own Orca from scratch (AWS, Tailscale, GitHub,
  Claude, Postgres, systemd, config, previews, a laptop instance, troubleshooting).
- [`CLAUDE.md`](CLAUDE.md): the design brief and its history. [`QA.md`](QA.md): the manual QA
  runbook.

## How it works

| Concept | In one line |
| --- | --- |
| **Orchestrator** | One conversation (`O`, or **Ask the orchestrator**) that spawns and steers workers. It's woken when they finish, and it never polls. |
| **Workstream** | One branch = one worktree = one conversation. Runs headless `claude -p` (or `codex exec` / `cursor-agent -p`) with the CLI's own login, so no API key is needed. |
| **`orca` CLI** | The orchestrator's tool: `board`, `spawn`, `send`, `address`, `move`, `archive`, `sweep`, `preview`, `merge --when-green`, `status`, `notes`, `chats`, `read`. |
| **Verification gate** | After a run that commits, Orca runs the repo's `checkCommand` itself: **Verified** or **Check failed**. |
| **Auto PR + merge queue** | `mergePolicy.autoPr` opens a clean worker's PR. Marked PRs are squash-merged when every check passes and the PR is mergeable, under `whenGreen: never \| small \| any`, with `denyPaths` (e.g. migrations, deploy) always left for a human. |
| **Model ladder** | Haiku for mechanical work, Sonnet for small clear tasks, **Opus by default**, Fable only after Opus fails. Two failures in a row on one model suggest (or apply) the next one up. |
| **Status & notes** | `orca status` keeps a per-workstream plan / waiting-on / merge class. `orca notes` keeps the orchestrator's standing facts across sessions. |
| **Previews** | Per-branch app instances on assigned ports, each with its own database cloned from a template. `--push-to-template` promotes one. |
| **Instances** | A cloud box and a laptop share one Postgres. Each workstream lives where its worktree is, and requests are forwarded over Tailscale. |
| **Notifications** | One centre plus toasts, shared by every instance, each with quick actions (Address PR, Fix, Reply, Retry, Open). |
| **Phone** | Responsive below 768px and installable as a PWA (the service worker needs HTTPS). |

Details for each are in [docs/WORKFLOW.md](docs/WORKFLOW.md).

## Architecture in brief

One Bun process (`server/index.ts`) serves the built React UI and a plain-JSON API, plus one SSE
stream per browser tab. Postgres (`Bun.SQL`) holds the conversations, enrichment, config,
notifications and metrics. Git, `gh` and live worktrees are the source of truth for everything else.
**The API has no auth of its own**, so it listens on loopback plus the machine's Tailscale address,
and never on `0.0.0.0`.

## Quick start

### On a cloud box (the recommended setup)

The full walkthrough is in [docs/SETUP.md](docs/SETUP.md). In short:

```sh
# laptop: Tailscale key into SSM, then launch an m7i.xlarge (eu-west-2, 150 GB) with cloud-init
aws ssm put-parameter --region eu-west-2 --name /orca/tailscale-authkey --type SecureString --value <tskey-auth-…>
VANTA_OWNER=<you@example.com> deploy/provision.sh

# box (aws ssm start-session …; sudo -iu orca): sign in, clone, bootstrap
gh auth login && gh auth setup-git
hydra add <name>                                   # one per Claude login
git clone <your-orca-repo-url> /opt/orca
git clone <repo-url> /opt/<repo-name>              # each repo Orca will manage
/opt/orca/deploy/bootstrap.sh                      # build, .env, orca.service, auto-deploy timer
echo "ORCA_PREVIEW_BIND=<tailnet-ip>" >> /opt/orca/.env && sudo systemctl restart orca

# then: add your repos to the config document (curl GET/PUT /api/config/document — SETUP.md §6–8)
```

Open `http://<box-name>.<tailnet>.ts.net:8787` from any device on your tailnet.

### Locally, for development

```sh
bun install
cp .env.example .env     # set ORCA_DEV_ROOT (the dir holding your repos) and ORCA_DATABASE_URL
createdb orca
bun run dev              # bridge on :8787 (bun --watch), UI on http://localhost:8788
bun run build && bun run server   # production: the bridge serves the built UI on :8787
bun run check            # tsc --noEmit + bun test (needs ORCA_TEST_DATABASE_URL)
```

On first start, an empty database is seeded from `orca.config.ts`. After that, the config lives in
the database ([SETUP.md §6](docs/SETUP.md#6-the-config-document)).

## Working on Orca itself

The deployed bridge serves `/opt/orca` and restarts when it changes, so **never edit that checkout**.
Make changes in a worktree (`git worktree add .worktrees/<name>`, symlink `node_modules`, copy
`.env`) and open a PR. Auto-deploy picks up `main` within a minute once nothing is running. Every
behaviour change ships with a test, and `bun run check` is the gate (see [`CLAUDE.md`](CLAUDE.md)).
