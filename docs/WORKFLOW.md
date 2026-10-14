# How Orca works: the way of working

This is the day-to-day model: what you do, what Orca does, and what each piece is called. To set
up your own Orca, see [SETUP.md](SETUP.md). For the design rationale and history, see
[`CLAUDE.md`](../CLAUDE.md).

- [The model in one paragraph](#the-model-in-one-paragraph)
- [Workstreams](#workstreams)
- [The orchestrator](#the-orchestrator)
- [The `orca` command](#the-orca-command)
- [Briefs and the model ladder](#briefs-and-the-model-ladder)
- [From finished run to merged PR](#from-finished-run-to-merged-pr)
- [Status and notes](#status-and-notes)
- [Previews](#previews)
- [Instances: the cloud box and the laptop](#instances-the-cloud-box-and-the-laptop)
- [Notifications](#notifications)
- [The UI, the keyboard and the phone](#the-ui-the-keyboard-and-the-phone)
- [Rules of thumb for workers](#rules-of-thumb-for-workers)

## The model in one paragraph

You talk to **one** conversation, **the orchestrator**: a Claude Code session that acts like a
senior engineer running a team. It does not write code in your repos itself. It **delegates**:
each piece of work becomes a **workstream** (one branch, one git worktree, one conversation), and a
**headless worker** (`claude -p`, or `codex exec` / `cursor-agent -p` where a repo allows them) runs
in that worktree. When a worker finishes, Orca checks the result, opens the PR when the repo allows
it, and reports back to the orchestrator, which decides what happens next. Merges go through a
**merge queue** that squash-merges only green, clean PRs, and only those the repo's merge policy
allows. You watch it all on the board and step in when something needs you.

```
you ──► orchestrator ──spawn/send/address──► worker (headless, in its own worktree)
             ▲                                        │
             └────────── worker report (on finish) ◄──┘
                                                      │ commits, pushes
                                       Orca check ◄───┤
                                       auto PR  ◄─────┤
                                       merge queue ◄──┘ (merges on green under mergePolicy)
```

## Workstreams

A **workstream is a branch**. It has:

- a **git worktree** under the repo's `worktreeRoot` (for example `/opt/<repo>/.worktrees/...`),
  created on demand; any action on a PR with no worktree checks one out automatically;
- a **conversation**: every instruction and the agent's final response, stored in Postgres (the
  `turn` table). Nothing is deleted: finished workstreams are **archived**, not removed, so their
  history stays searchable;
- **enrichment** on top of what git and GitHub already know: title, provider and session pointer,
  model, whether the orchestrator owns it (`orchestrated`), its status record, merge mark, and so on.

Workstreams show up on the **Agents** page (a list, or a board with the lanes
Local → Draft → In Review → Mergeable → Done·today). The lanes are derived from live git/`gh` state,
not stored.

**How a follow-up keeps context** (the "handover ladder"):

1. same provider: native `--resume` of the provider's own session (lossless). Changing the Claude
   model keeps this rung;
2. another Claude login: also lossless, handled by
   [claude-hydra](https://github.com/finnformica/claude-hydra), whose `claude` shim routes every
   launch to the login with the most headroom and shares sessions between logins;
3. a provider switch, a session at 80% or more of its context, too many turns or failures, or a
   session file that's missing (for example after a move to another machine): a **portable
   transcript** of about the newest 12k tokens (instructions, activity, structured outcomes) seeds a
   new session. The worktree's files and git history count as the source of truth over this
   transcript.

**The verification gate.** After any run that **committed**, Orca runs the repo's `checkCommand`
in the worktree and records the result on the turn: the card says **Verified** or **Check failed**.
This is Orca's own check, separate from what the agent says it verified. With
`features.followAutomation` on, one failure queues one fix-up run. A failed fix-up stops there, so
the gate can never loop.

**Cleanup.** About 10 minutes after a PR is merged or closed, each instance reaps its own worktree
for it: it stops the preview, deletes the branch if the PR merged, and archives the card. A worktree
is never reaped while an agent runs in it, or when the worktree has uncommitted changes or unpushed
commits. In those cases the card is flagged instead.

## The orchestrator

Open it from **Ask the orchestrator** in the top bar, the `O` key, the command palette (`⌘K`), or
the quick-ask pill at the bottom of every page (the `A` key). It's a side panel that stays mounted,
so your draft and scroll position survive closing it.

- **It's not a separate runtime.** Each "wake" is the same headless `claude -p --resume` every board
  action uses, recorded as turns under a reserved pointer (`@orca` / `orchestrator`). Its working
  directory is `~/.orca/orchestrator`. A `CLAUDE.md` you put there is read as standing orders, and a
  `.mcp.json` there gives it MCP servers.
- **Access.** By default it has Claude Code's full toolset (`bypassPermissions`): shell, files, web,
  subagents. Set `orchestratorShell: false` in the config to limit it to the `orca` command, reading,
  the web and read-only subagents. In both modes it **can't** promote PRs or post to Slack through
  Orca, and it merges **only** through the merge queue.
- **Management by exception.** A worker's **problem** (failed, stopped, or its commit failed the
  check) wakes it straight away. A **clean finish** is held and delivered in one batch, either when
  its last running worker finishes or when you next speak, whichever comes first. It never polls
  while it waits.
- **One wake per batch.** Everything that arrived while it worked goes into one resumed run, with
  `## From the user` first and then `## Worker reports`, so it never mistakes a report for something
  you asked.
- **Loop guards.** After 12 self-wakes in a row with no message from you, it pauses until you reply.
  Each wake is capped by `orchestratorWakeBudgetUsd` (`--max-budget-usd`) when that's set.
- **A wake that dies says why** (budget, timeout, non-zero exit) and its messages are retried once,
  along with a summary of what the cut-off wake had already done.
- **New drafts.** The **Add New** box (the `C` key) defaults to the model "Auto": the prompt goes to
  the orchestrator as a `[new draft]` message, and it answers with exactly **one** spawn. If you pick
  a specific model there, Orca skips the orchestrator and launches directly.
- **Compact.** The context ring under its composer has a **Compact** button that runs `/compact` on
  its own session.

## The `orca` command

`bin/orca` is the orchestrator's only Orca tool: `orca <verb> [--flag value]… [words…]`, which posts
to the bridge's `/api/orchestrator/tool`. You can run it yourself on the box too (it talks to
`http://127.0.0.1:8787`; set `ORCA_URL` to talk to another instance). A repeated flag
(`--attach a --attach b`) collects into a list.

| Verb | What it does |
| --- | --- |
| `board` | Every workstream on every instance: branch, agent state, PR, CI, review, check, last outcome, status. |
| `spawn --repo r --model m --objective … --output … --boundaries … [--context …] [--title …] [--attach id\|path]… [--on instance]` | Create a workstream and launch a worker. `--model`, `--objective`, `--output` and `--boundaries` are **required**. `--on` places it on another instance (default: the repo's `runsOn`, else here). |
| `send --repo r --branch b [--model m] [--attach …] "message"` | Follow up on a workstream. Queued if a run is in flight. `--model` re-pins it (moves it along the ladder). |
| `address --repo r --branch b` | Address a PR in one run: merge conflicts, then failing CI, then review comments, whichever apply. A conflict that's only in changelog files is resolved by Orca itself with no agent. |
| `move --repo r --branch b --to instance` | Push the branch, remove the worktree here, adopt it there. The next run starts from the portable transcript. |
| `archive --repo r --branch b` | Archive a workstream this orchestrator owns (the worktree is removed, the history kept). |
| `sweep [--confirm]` | Report (or, with `--confirm`, remove) finished worktrees, orphaned previews and Orca branches with nothing behind them, on every instance. |
| `preview --repo r --branch b` | Start the branch's preview. `--status` shows its state and log tails. `--push-to-template [--confirm]` makes it the repo's template (see [Previews](#previews)). |
| `merge --repo r (--pr N \| --branch b) --when-green [--small]` / `--cancel` | Mark (or unmark) for the merge queue. It never merges directly. |
| `status --repo r --branch b [--plan …] [--waiting …] [--merge small\|needs-finn] [--clear]` | The workstream's short structured status (see [Status and notes](#status-and-notes)). With no flags it reads the status. |
| `chats ["terms"]` | List conversations, or full-text search every past instruction and response, archived ones included. |
| `read --chat <id>` / `read --run <runId>` | Read one conversation, or one run with its activity and check output. |
| `notes` / `notes set "…"` | Read or replace the orchestrator's own notes, which go into every wake prompt. |

## Briefs and the model ladder

A worker knows only its brief, so `spawn` refuses one without an **objective**, an **expected
output** and **boundaries**. **Context** is optional.

The orchestrator picks each worker's model from `MODEL_LADDER` (`web/src/workstream.ts`):

| Model | Use for |
| --- | --- |
| `claude-haiku-4-5-20251001` | mechanical edits, renames, one-file fixes with a clear spec |
| `claude-sonnet-5` | small, well-specified tasks in a known area |
| `claude-opus-5-5` | **the default**: features, bug fixes, refactors, debugging |
| `claude-fable-5-1` | only work that has already defeated Opus, or genuinely novel design work |

**Moving up the ladder.** When an orchestrated worker fails **twice in a row** on one model (the
run errors, or its commit fails the check; a stop counts as neither), its report gets a
`Model ladder:` line. With the repo's `modelEscalation: "suggest"` (the default), that line suggests
the next model up. With `"apply"`, Orca has already re-pinned the workstream to it. The streak is
stored on the workstream, so a restart doesn't reset it. At the top of the ladder, the line says to
stop and ask you. The orchestrator itself runs on Opus 5.5 unless you change it in its panel's model
picker.

## From finished run to merged PR

1. **Auto PR.** With the repo's `mergePolicy.autoPr: true`, a clean finish by an orchestrated worker
   opens the worker's own PR: ready (not draft), with the title from the card and a body built from
   the outcome and commits. A clean finish means the run is done, the check didn't fail, there are
   commits ahead of base, and there's no PR yet. The report then says `Orca opened PR #N`. Without
   `autoPr`, you promote the branch from the card (**Promote**: create the PR ready or as a draft,
   optionally with the preview label).
2. **Mark for merge.** `orca merge --when-green` (from the orchestrator), the PR menu's
   **Merge when green**, or `POST /api/prs/merge-when-green`. A branch with no PR yet can be marked
   too, and joins the queue once its PR exists. The mark is stored in the database, so it survives
   restarts.
3. **The merge queue** (`server/mergeQueue.ts`) runs each minute on the instance the repo runs on.
   A marked PR is squash-merged only when **every check passed** (no checks yet doesn't count as
   green) **and** GitHub reports it `MERGEABLE`. Red CI or a conflict keeps the mark and is reported
   once per head commit. For the orchestrator's own PRs, that report wakes it, and it can then
   `orca address` the PR.

**Merge policy** is per-repo config, not instructions in the orchestrator's prompt:

```jsonc
"mergePolicy": {
  "whenGreen": "small",          // "never" (the default when absent) | "small" | "any"
  "denyPaths": ["server/db.ts", "server/cgroup.ts", "deploy/"],
  "autoPr": true
}
```

- `never`: nothing is merged automatically. `small`: only PRs marked `--small`. `any`: every marked
  PR.
- A PR touching a `denyPaths` glob is **refused** when it's marked, and checked **again at merge
  time**, because a later push can add such a file. A refused PR is unmarked and you're notified
  (`merge_refused`). This is how "small UI PRs merge themselves, but migrations and infra wait for a
  human" is enforced.
- If the repo disallows GitHub auto-merge, Orca squash-merges directly once it's safe to.

## Status and notes

- **`orca status`** keeps a short structured record per workstream, owned by the orchestrator:
  `plan`, `waiting on` and a merge class (`small` or `needs-finn`), up to 300 characters per field.
  It appears on the orchestrator's board every wake and on your card and Agents row. The merge class
  is just a label for you: the queue only reads `--small` and the repo's `mergePolicy`.
- **`orca notes`** holds your preferences and standing facts. They go into every wake prompt, so the
  orchestrator's session is disposable: if a session is reset, nothing it was told to keep is lost.
  If it seems to have forgotten something, check its notes first.

## Previews

A **preview** runs a branch's app (one or more services, each command from the repo's
`previewServices`) on ports picked from `portRange`, so you can click through it before merging.

- Start one from the card or agent page (**Preview** tab), the **Previews** page, or
  `orca preview --repo r --branch b`. The **Previews** page also has **Test master** per repo,
  which previews the base branch.
- A command can use `{port}` (its own port), `{svc:name}` (another service's port), `{bind}`
  (`ORCA_PREVIEW_BIND`), `{host}` (`ORCA_PREVIEW_HOST`) and `{db}` (a per-worktree database name for
  an `onStop` drop).
- **Template database.** Repos like branch-demo give each preview its **own** Postgres database,
  cloned from `PREVIEW_TEMPLATE_DB` (`scripts/preview-db.sh create {db}`) and then migrated to the
  branch's schema. `onStop` drops it.
- **Push to template.** When you've set a preview up the way every preview should start (for
  example its integrations):

  ```sh
  orca preview --repo <repo> --branch <branch> --push-to-template            # dry run: plan + masked env diff
  orca preview --repo <repo> --branch <branch> --push-to-template --confirm  # apply
  ```

  This replaces the template database with a whole copy of the preview's database. The old template
  is kept as `<template>_bak_<timestamp>`, and the command prints the `psql` to restore it. It refuses
  while anything is connected to the template, so stop the main checkout's backend first. It needs a
  `pg_dump` at least as new as the server (`PG_DUMP` overrides which one is used). It also writes
  integration-related env vars (Linear, GitHub, Slack, `_BASE_URL`, …) back into the main checkout's
  copied `.env`, keeping a backup under `~/.orca/env-backups/`. Values are always masked in its
  output. The orchestrator is told to dry-run first and to apply only when you ask.
- **Orca's own previews** run the branch's own bridge read-only (`scripts/preview-orca.sh`,
  `ORCA_PREVIEW_BRIDGE=1`), so a branch's UI shows that branch's server. The top bar names which
  bridge answered.
- **Reaping.** An hourly pass drops orphaned `orca_*` preview databases older than 2 hours, and the
  repo's `testContainerPrefix` Docker containers older than 3 hours.

## Instances: the cloud box and the laptop

Orca can run as several **instances** sharing one Postgres database. A typical setup has two:

- **`cloud`**: an EC2 box that runs the bridge, the web UI and the orchestrator (`orchestratorOn:
  "cloud"`), with repos checked out under `/opt` and worktrees under each repo's `.worktrees`;
- **`local`**: your laptop, running its own bridge against the same database over Tailscale.

A **workstream lives on the instance holding its worktree.** New work goes to: an explicit choice
(the Add New box's "run on" picker, or `spawn --on`), else the repo's `runsOn`, else the instance you
asked. Requests for a workstream on another instance are forwarded to it over the tailnet, and the
board on either machine shows both. **Move** (on the card menu, or `orca move --to`) pushes the
branch and re-homes the workstream. History needs no moving because it's in the shared database.

The Overview shows one card per machine: CPU and memory (with OOM kills marked), running agents,
disk, and **Cost · this month** (the hourly rate from `instanceHourlyUsd`, else an EC2 on-demand
estimate from instance metadata, multiplied by the hours the instance was up). Open PR #180
("Robust instance cost") would move the month figure to a boot ledger seeded by
`instanceBillingSince`; it isn't on `main` yet.

## Notifications

There's one notification centre (the bell at the sidebar's foot) and one toast stack (bottom-left).
Both read the same `notification` table, so both instances show the same rows. Kinds include run
finished / needs input / failed / stopped, check failed, preview ready / failed, PR CI failing, PR
conflicts, merged, merge refused, and a failed button click (local to your browser).

Each notification has quick actions: CI failing or conflicts → **Address PR**; check failed →
**Fix**; finished → **Reply**; failed → **Retry**; preview ready → **Open preview**. **Open** comes
last on every one. A notification is unread or read; nothing is deleted except by the 30-day prune.
Do-not-disturb, per-kind toasts and browser notifications are in **Settings**.

## The UI, the keyboard and the phone

- **Pages:** Overview, Agents, Previews, Repos, Usage (every Claude login via hydra, plus Codex),
  and Settings (theme, density, notifications, machine cost, and the config, read-only).
- **Agent page:** Overview (details, failure box, PR review, checks, description, GitHub
  conversation) | Chat (the conversation and a composer) | Files | Preview.
- **Keys:** `⌘K` palette, `C` new agent, `O` orchestrator, `A` quick ask, `F` find, `⌘B` sidebar,
  `G` then `O/A/P/R/U/S` to jump to a page, `?` for the full sheet. In any composer, type `@` to pick
  a PR.
- **Phone / PWA.** Below 768px there's a bottom bar with Agents, New agent and Orchestrator, and
  menus open as bottom sheets. Orca installs as a PWA (the manifest has New agent and Orchestrator
  shortcuts). Its **service worker only registers in a secure context**, so over a plain-`http`
  tailnet URL it stays inert and Android won't offer to install it. HTTPS (for example Tailscale
  HTTPS certificates) is needed for that. When a new build is deployed, a "new version · Refresh"
  banner appears. iOS caches home-screen icons, so after an icon change, remove and re-add the
  shortcut.

## Rules of thumb for workers

These are learned from running Orca on one 16 GB box. Put the ones you want enforced in the
orchestrator's notes or a repo's `CLAUDE.md`.

- **Commit and push early.** A run is killed after `agentTimeoutMinutes` (45 in the seed config),
  and a SIGTERM shows up as exit 143. Work that isn't pushed by then is at risk.
- **Never wait on background jobs.** The run ends when the agent stops.
- **No headless browsers in workers.** Use `orca-shot <url> [--viewport 390x844] [--dark] …`, which
  queues on the bridge's one memory-capped browser and prints `shot: <path>`.
- **Run only the affected test files**, never the whole suite or two suites at once. Every run has a
  per-worker memory ceiling (`agentMemoryMaxGb`, 4 GB by default), and a whole-project type-check or
  test run can hit it. The run then ends as `out of memory (<N> GB ceiling)`. Raise the repo's
  ceiling (8 GB for a large TypeScript repo) rather than dropping it.
