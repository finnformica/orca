# 🐳 Orca

Orca automates the work between **managing coding agents** and **managing PRs**. You talk to one
**orchestrator**. The orchestrator is a Claude Code session. It gives each piece of work to a
**headless worker** in its own git worktree. Orca checks what the worker committed and opens the PR.
When CI is green, Orca merges the PR through a **merge queue** that a policy controls. A web console
shows every workstream, PR, preview and machine. You can install the console on your phone.

- **[docs/WORKFLOW.md](docs/WORKFLOW.md)**: how Orca works, and how you work with it.
- **[docs/SETUP.md](docs/SETUP.md)**: how to deploy your own Orca from the start (AWS, Tailscale,
  GitHub, Claude, Postgres, systemd, config, previews, a laptop instance, troubleshooting).
- [`CLAUDE.md`](CLAUDE.md): the design brief and its history. [`QA.md`](QA.md): the manual QA
  runbook.

## Writing standard

Orca's agents write all human-facing prose in **ASD-STE100 Simplified Technical English (STE)**.
This includes replies, reports, PR descriptions and commit messages. This README and the documents
in `docs/` also use STE. The rules are in one file, `shared/writingStyle.ts`. Every prompt that Orca
sends to a model includes them. STE applies to prose only. It does not apply to code, commands,
paths or quoted text.

## How it works

| Concept | In one line |
| --- | --- |
| **Orchestrator** | One conversation (`O`, or **Ask the orchestrator**). It starts and controls workers. Orca wakes it when they finish. It does not poll. |
| **Workstream** | One branch = one worktree = one conversation. It runs headless `claude -p` (or `codex exec` / `cursor-agent -p`) with the CLI's own login. You do not need an API key. |
| **`orca` CLI** | The orchestrator's tool: `board`, `spawn`, `send`, `address`, `move`, `archive`, `sweep`, `preview`, `merge --when-green`, `status`, `notes`, `chats`, `read`. |
| **Verification gate** | After a run that commits, Orca runs the repo's `checkCommand` itself. The result is **Verified** or **Check failed**. |
| **Auto PR + merge queue** | `mergePolicy.autoPr` opens the PR of a clean worker. Orca squash-merges a marked PR when all checks pass and the PR is mergeable. `whenGreen: never \| small \| any` sets the policy. A PR that touches `denyPaths` (for example migrations or deploy) always stays for a human. |
| **Model ladder** | Haiku for mechanical work. Sonnet for small, clear tasks. **Opus by default.** Fable only after Opus fails. After two failures in a row on one model, Orca suggests (or applies) the next model up. |
| **Status & notes** | `orca status` keeps the plan, the wait and the merge class of each workstream. `orca notes` keeps the orchestrator's standing facts between sessions. |
| **Previews** | An app instance for each branch, on assigned ports. Each preview has its own database, cloned from a template. `--push-to-template` makes one preview the template. |
| **Instances** | A cloud box and a laptop share one Postgres database. Each workstream lives where its worktree is. Orca forwards requests over Tailscale. |
| **Notifications** | One centre plus toasts. All instances share them. Each has quick actions (Address PR, Fix, Reply, Retry, Open). |
| **Phone** | The layout changes below 768px. You can install it as a PWA (the service worker needs HTTPS). |

[docs/WORKFLOW.md](docs/WORKFLOW.md) gives the details of each concept.

## Architecture in brief

One Bun process (`server/index.ts`) serves the built React UI and a plain-JSON API. It also serves
one SSE stream for each browser tab. Postgres (`Bun.SQL`) holds the conversations, enrichment,
config, notifications and metrics. Git, `gh` and the live worktrees are the source of truth for all
other data. **The API has no authentication of its own.** Thus it listens on loopback and on the
machine's Tailscale address. It never listens on `0.0.0.0`.

## Quick start

### On a cloud box (the recommended setup)

[docs/SETUP.md](docs/SETUP.md) gives all the steps. In short:

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

Open `http://<box-name>.<tailnet>.ts.net:8787` from a device on your tailnet.

### Locally, for development

```sh
bun install
cp .env.example .env     # set ORCA_DEV_ROOT (the dir holding your repos) and ORCA_DATABASE_URL
createdb orca
bun run dev              # bridge on :8787 (bun --watch), UI on http://localhost:8788
bun run build && bun run server   # production: the bridge serves the built UI on :8787
bun run check            # tsc --noEmit + bun test (needs ORCA_TEST_DATABASE_URL)
```

At the first start, Orca fills an empty database from `orca.config.ts`. After that, the config is in
the database ([SETUP.md §6](docs/SETUP.md#6-the-config-document)).

## Working on Orca itself

The deployed bridge serves `/opt/orca`. It restarts when that checkout changes. Thus, **do not edit
that checkout**. Do these steps:

1. Make a worktree (`git worktree add .worktrees/<name>`).
2. Symlink `node_modules` and copy `.env` into it.
3. Make your changes there and open a PR.

Auto-deploy gets `main` in one minute. It waits while the orchestrator is in a wake. Each behaviour change must have a test.
`bun run check` is the gate (see [`CLAUDE.md`](CLAUDE.md)).

## Caveman trial (until 2026-10-22)

This is an A/B trial of [caveman](https://github.com/JuliusBrussee/caveman), binaries `bin-v4.0.1`.
The `orca` repo has `agentProxy: "caveman"`. Its Claude workers use caveman. The `branch-demo` workers are the control.
The sample runs are in `docs/research/caveman-trial-samples-2026-10-15.md`.

- **Read less:** the run sends its API calls through `caveman-proxy` on `127.0.0.1:8797`, mode `compress`.
- **Say less:** the run gets the pinned `caveman` skill as `--append-system-prompt`.
- **Recovery:** the run gets `caveman-mcp` as a per-run `--mcp-config`.
- **Off:** Auto, browse, cloud, login and telemetry. Orca changes no user-level Claude settings. The orchestrator always runs direct.
- **Logins:** the proxy forwards the run's own credential. Hydra picks the login as before.
- **Prompt cache:** the run sets `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` and `ENABLE_TOOL_SEARCH=true`. Without them, Claude Code treats the proxy as a third-party gateway. It then sends every tool schema and loses the global cache scope. This adds about 16k input tokens to each request.
- **Fallback:** when the proxy does not start, the run goes direct and Orca logs it. When a run fails on the API connection, Orca stops the proxy use for 10 minutes and queues one direct retry.

Install (once per host, already done on the box):

1. Download `caveman-proxy`, `caveman-engine`, `caveman-mcp` for your platform and `checksums.txt` from release `bin-v4.0.1`.
2. Run `sha256sum -c` on the three files against `checksums.txt`.
3. Put the binaries in `~/.caveman/bin/` without the platform suffix.
4. Put `plugins/caveman/skills/caveman/SKILL.md` at tag `v4.0.1` in `~/.caveman/skills/caveman/SKILL.md`.

A host without the install runs every worker direct. The trial log records this as a fallback.

**Turn it off:** remove the `agentProxy: "caveman"` line from the `orca` repo in the config document (Settings, or `PUT /api/config/document`).

**Report:** run `bun run trial:caveman --from 2026-10-15 --to 2026-10-22`. It reads this host's log, `~/.orca/trial/caveman.jsonl`. Add `--file <path>` once for each log to merge logs from other hosts. The report gives the trial start time. This is the time of the first caveman run on the host.
