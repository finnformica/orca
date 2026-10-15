# How Orca works: the way of working

> This document uses ASD-STE100 Simplified Technical English (STE). Orca's agents write all
> human-facing prose in STE. The rules are in `shared/writingStyle.ts`.

This document gives the daily model. It tells you what you do, what Orca does, and the name of each
part. To set up your own Orca, read [SETUP.md](SETUP.md). For the design reasons and the history,
read [`CLAUDE.md`](../CLAUDE.md).

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

You talk to **one** conversation, **the orchestrator**. The orchestrator is a Claude Code session.
It acts as a senior engineer who manages a team. It does not write code in your repos. It
**delegates**. Each unit of work becomes a **workstream**: one branch, one git worktree and one
conversation. A **headless worker** runs in that worktree. The worker is `claude -p`, or
`codex exec` / `cursor-agent -p` if the repo permits them. When a worker finishes, Orca does these
steps:

1. Orca checks the result.
2. Orca opens the PR, if the repo permits it.
3. Orca sends a report to the orchestrator. The orchestrator decides the next step.

All merges go through a **merge queue**. The merge queue squash-merges a PR only if the PR is green
and clean, and only if the repo's merge policy permits it. You monitor all of this on the board. You
act when a workstream needs you.

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

A **workstream is a branch**. A workstream has these parts:

- A **git worktree** under the repo's `worktreeRoot` (for example `/opt/<repo>/.worktrees/...`).
  Orca creates the worktree when it is necessary. If you do an action on a PR that has no worktree,
  Orca checks one out automatically.
- A **conversation**. The conversation contains each instruction and the agent's final response.
  Orca keeps it in Postgres (the `turn` table). Orca deletes nothing. Orca **archives** a finished
  workstream and does not remove it, so you can search its history.
- **Enrichment**. Enrichment adds data that git and GitHub do not have: the title, the provider and
  session pointer, the model, the orchestrator ownership (`orchestrated`), the status record, the
  merge mark, and other data.

The **Agents** page shows the workstreams. It shows a list, or a board with these lanes:
Local → Draft → In Review → Mergeable → Done·today. Orca calculates the lanes from the live git and
`gh` state. Orca does not store the lanes.

**How a follow-up keeps context** (the "handover ladder"):

1. Same provider: Orca uses a native `--resume` of the provider's own session. This rung loses no
   data. A change of the Claude model keeps this rung.
2. A different Claude login: this rung also loses no data.
   [claude-hydra](https://github.com/finnformica/claude-hydra) does this work. Its `claude` shim
   sends each launch to the login with the most headroom. It shares sessions between logins.
3. Orca uses this rung for a provider switch, for a session at 80% or more of its context, for too
   many turns or failures, or for a missing session file (for example, after a move to a different
   machine). A **portable transcript** starts a new session. The transcript contains approximately
   the newest 12k tokens: instructions, activity and structured outcomes. The worktree's files and
   git history are the source of truth. They have priority over this transcript.

**The verification gate.** After a run that makes a **commit**, Orca runs the repo's `checkCommand`
in the worktree. Orca records the result on the turn. The card shows **Verified** or
**Check failed**. This check is Orca's own check. It is different from the verification that the
agent reports. With `features.followAutomation` on, one failure adds one fix-up run to the queue. If
the fix-up run fails, Orca stops there. Thus the gate cannot loop.

**Cleanup.** Approximately 10 minutes after a PR merges or closes, each instance reaps its own
worktree for that PR. The instance stops the preview. It deletes the branch if the PR merged. It
archives the card. Orca does not reap a worktree in these conditions:

- An agent runs in the worktree.
- The worktree has changes that are not committed.
- The worktree has commits that are not pushed.

In these conditions, Orca puts a flag on the card.

## The orchestrator

You can open the orchestrator from these locations:

- **Ask the orchestrator** in the top bar.
- The `O` key.
- The command palette (`⌘K`).
- The quick-ask pill at the bottom of each page (the `A` key).

The orchestrator is a side panel. The panel stays mounted when you close it, so Orca keeps your draft
and your scroll position.

- **It is not a separate runtime.** Each "wake" is the same headless `claude -p --resume` that each
  board action uses. Orca records each wake as turns under a reserved pointer (`@orca` /
  `orchestrator`). The working directory is `~/.orca/orchestrator`. If you put a `CLAUDE.md` there,
  the orchestrator reads it as standing orders. A `.mcp.json` there gives it MCP servers.
- **Access.** By default, the orchestrator has the full Claude Code toolset (`bypassPermissions`):
  shell, files, web and subagents. To limit it, set `orchestratorShell: false` in the config. Then it
  can use only the `orca` command, file reads, the web and read-only subagents. In the two modes, it
  **cannot** promote PRs or post to Slack through Orca. It merges **only** through the merge queue.
- **Management by exception.** A worker **problem** wakes the orchestrator immediately. A problem is
  a failed run, a stopped run, or a commit that failed the check. Orca holds a **clean finish** and
  sends it in one batch. Orca sends the batch when the last worker that runs finishes, or when you
  send a message. The first of these two events starts the batch. The orchestrator does not poll
  while it waits.
- **One wake per batch.** All the messages that arrive during a run go into one resumed run.
  `## From the user` comes first, then `## Worker reports`. Thus the orchestrator does not mistake a
  report for an instruction from you.
- **Loop guards.** After 12 self-wakes in sequence with no message from you, the orchestrator pauses.
  It continues when you reply. If `orchestratorWakeBudgetUsd` is set, it is the limit for each wake
  (`--max-budget-usd`).
- **A wake that dies says why** (budget, timeout, non-zero exit). Orca tries its messages one more
  time. It adds a summary of the actions that the cut-off wake completed.
- **New drafts.** The **Add New** box (the `C` key) has the default model "Auto". The prompt goes to
  the orchestrator as a `[new draft]` message. The orchestrator replies with exactly **one** spawn.
  If you select a specific model there, Orca does not use the orchestrator. Orca launches the run
  directly.
- **Compact.** The context ring below the composer has a **Compact** button. This button runs
  `/compact` on the orchestrator's own session.

## The `orca` command

`bin/orca` is the orchestrator's only Orca tool: `orca <verb> [--flag value]… [words…]`. It posts to
the bridge's `/api/orchestrator/tool`. You can also run it yourself on the box. It talks to
`http://127.0.0.1:8787`. To talk to a different instance, set `ORCA_URL`. If you repeat a flag
(`--attach a --attach b`), Orca collects the values into a list.

| Verb | What it does |
| --- | --- |
| `board` | Shows each workstream on each instance: branch, agent state, PR, CI, review, check, last outcome and status. |
| `spawn --repo r --model m --objective … --output … --boundaries … [--context …] [--title …] [--attach id\|path]… [--on instance]` | Creates a workstream and launches a worker. `--model`, `--objective`, `--output` and `--boundaries` are **required**. `--on` puts the workstream on a different instance. The default is the repo's `runsOn`, else this instance. |
| `send --repo r --branch b [--model m] [--attach …] "message"` | Sends a follow-up to a workstream. If a run is in progress, Orca adds the message to the queue. `--model` re-pins the workstream (it moves it on the ladder). |
| `address --repo r --branch b` | Addresses a PR in one run. The run does these items in this sequence, if they apply: merge conflicts, failing CI, review comments. If a conflict is only in changelog files, Orca resolves it itself with no agent. |
| `move --repo r --branch b --to instance` | Pushes the branch, removes the worktree on this instance and adopts it on the target instance. The next run starts from the portable transcript. |
| `archive --repo r --branch b` | Archives a workstream that this orchestrator owns. Orca removes the worktree and keeps the history. |
| `sweep [--confirm]` | Reports finished worktrees, orphaned previews and Orca branches with nothing behind them, on each instance. With `--confirm`, it removes them. |
| `preview --repo r --branch b` | Starts the branch's preview. `--status` shows its state and the ends of its logs. `--push-to-template [--confirm]` makes it the repo's template (see [Previews](#previews)). |
| `merge --repo r (--pr N \| --branch b) --when-green [--small]` / `--cancel` | Marks the PR for the merge queue, or removes the mark. It does not merge directly. |
| `status --repo r --branch b [--plan …] [--waiting …] [--merge small\|needs-finn] [--clear]` | Sets the workstream's short structured status (see [Status and notes](#status-and-notes)). With no flags, it shows the status. |
| `chats ["terms"]` | Lists conversations. With terms, it does a full-text search of all past instructions and responses, archived ones too. |
| `read --chat <id>` / `read --run <runId>` | Shows one conversation, or one run with its activity and check output. |
| `notes` / `notes set "…"` | Shows or replaces the orchestrator's own notes. The notes go into each wake prompt. |

## Briefs and the model ladder

A worker knows only its brief. Thus `spawn` refuses a brief that does not have an **objective**, an
**expected output** and **boundaries**. **Context** is optional.

The orchestrator selects the model for each worker from `MODEL_LADDER` (`web/src/workstream.ts`):

| Model | Use for |
| --- | --- |
| `claude-haiku-4-5-20251001` | mechanical edits, renames, fixes in one file with a clear specification |
| `claude-sonnet-5` | small tasks with a clear specification in a known area |
| `claude-opus-5-5` | **the default**: features, bug fixes, refactors, debugging |
| `claude-fable-5-1` | only work that Opus did not complete, or design work that is truly new |

**Moving up the ladder.** An orchestrated worker can fail **two times in sequence** on one model. A
failure is a run error, or a commit that fails the check. A stop is not a failure. Then the worker's
report gets a `Model ladder:` line. With the repo's `modelEscalation: "suggest"` (the default), that
line recommends the next model up. With `"apply"`, Orca already re-pinned the workstream to that
model. Orca stores the failure count on the workstream, so a restart does not reset it. At the top
of the ladder, the line tells the orchestrator to stop and ask you. The orchestrator itself runs on
Opus 5.5. To change this, use the model picker in its panel.

## From finished run to merged PR

1. **Auto PR.** Set the repo's `mergePolicy.autoPr: true`. Then a clean finish by an orchestrated
   worker opens the PR for that worker. The PR is ready, not draft. The title comes from the card.
   The body comes from the outcome and the commits. A clean finish has these conditions: the run is
   done, the check did not fail, there are commits ahead of base, and there is no PR. The report then
   shows `Orca opened PR #N`. Without `autoPr`, promote the branch from the card. **Promote** creates
   the PR as ready or as a draft. It can also add the preview label.
2. **Mark for merge.** Use `orca merge --when-green` (from the orchestrator), **Merge when green** in
   the PR menu, or `POST /api/prs/merge-when-green`. You can also mark a branch that has no PR. The
   branch goes into the queue when its PR exists. Orca stores the mark in the database, so the mark
   stays after a restart.
3. **The merge queue** (`server/mergeQueue.ts`) runs each minute on the instance of the repo. Orca
   squash-merges a marked PR only when these two conditions are true:
   - **Each check passed.** A PR with no checks is not green.
   - GitHub reports the PR as `MERGEABLE`.

   Red CI or a conflict does not remove the mark. Orca reports it one time for each head commit. For
   the orchestrator's own PRs, that report wakes the orchestrator. The orchestrator can then use
   `orca address` on the PR.

**Merge policy** is a configuration for each repo. It is not an instruction in the orchestrator's
prompt:

```jsonc
"mergePolicy": {
  "whenGreen": "small",          // "never" (the default when absent) | "small" | "any"
  "denyPaths": ["server/db.ts", "server/cgroup.ts", "deploy/"],
  "autoPr": true
}
```

- `never`: Orca merges nothing automatically. `small`: Orca merges only PRs marked `--small`. `any`:
  Orca merges each marked PR.
- Orca **refuses** a PR that changes a file in a `denyPaths` glob when you mark it. Orca checks the PR
  **again at merge time**, because a later push can add such a file. Orca removes the mark from a
  refused PR and sends you a notification (`merge_refused`). With this rule, "small UI PRs merge
  themselves, but migrations and infra wait for a human".
- If the repo does not permit GitHub auto-merge, Orca squash-merges directly when it is safe.

### Automatic PR upkeep

You do not have to push **Address PR** on the PR of an orchestrated workstream. One time each minute
(`server/upkeep.ts`, next to the merge queue), the instance that holds the worktree examines each
**open, non-draft** PR of an **orchestrated** workstream. It runs the same Address PR as the button
and `orca address` if the PR has one or more of these conditions:

- **Conflicts** with its base.
- A **required** check failed on the current head. Orca uses the same filter for required checks as
  the board's CI badge.
- **Actionable unresolved review threads** that Orca did not give to an agent before. A thread from
  an earlier Address PR stays unresolved on GitHub until a person resolves it. That thread does not
  start a new address.

Guards:

- **Never** while the workstream's agent runs or has messages in the queue.
- **Never** while the orchestrator's `orca status --waiting` says that it waits for you ("user",
  "Finn", "you", "input", "decision", …). A wait for CI or for a teammate does not count.
- **Maximum one** automatic address for each PR, head commit and reason. A new reason on the same
  head (a review thread after a CI fix) gets its own address.
- **Backoff:** Orca stops in these conditions:
  - Two automatic addresses on one head.
  - One address whose reason stays, with nothing new to try.
  - Four addresses in sequence across heads, with no healthy result between them. This catches a fix
    that goes red on each push.

  When Orca stops, you get an `upkeep_gave_up` notification (with **Address PR**). Orca then does
  not touch that head again. A new push starts the count again.
- **Maximum `autoUpkeepConcurrency`** (app config, default 2) automatic runs at the same time on each
  instance. Each run is a full agent run that uses the shared memory of the box. `0` stops upkeep.
- **Opt out:** for a repo, set `"autoUpkeep": false` (the default is on). For a branch, set
  `upkeepOff: true` on its enrichment.

Orca stores the last attempt on the branch's enrichment (`upkeep`: head, reasons tried, attempts,
streak, given-up reason). Orca writes it **before** the launch, so a restart does not start one
address two times. Each start is an `auto_address` notification. The card and the Agents row show
`auto-addressing: conflicts, CI` during the run, or `auto-upkeep gave up: …`. The run is a usual
orchestrated follow-up, so the orchestrator gets its report as for all workers.

## Status and notes

- **`orca status`** keeps a short structured record for each workstream. The orchestrator owns the
  record. The fields are `plan`, `waiting on` and a merge class (`small` or `needs-finn`). Each field
  has a maximum of 300 characters. The record shows on the orchestrator's board at each wake, and on
  your card and Agents row. The merge class is only a label for you. The queue reads only `--small`
  and the repo's `mergePolicy`.
- **`orca notes`** keeps your preferences and standing facts. They go into each wake prompt. Thus
  the orchestrator's session is disposable. If Orca resets a session, the orchestrator loses nothing
  that you told it to keep. If the orchestrator does not remember something, examine its notes first.

## Previews

A **preview** runs the app of a branch on ports from `portRange`. The app has one or more services.
Each service runs a command from the repo's `previewServices`. You can use the preview to test the
branch before the merge.

- To start a preview, use one of these: the card or the agent page (**Preview** tab), the
  **Previews** page, or `orca preview --repo r --branch b`. The **Previews** page also has
  **Test master** for each repo. **Test master** starts a preview of the base branch.
- A command can contain these placeholders:
  - `{port}`: the port of the service.
  - `{svc:name}`: the port of a different service.
  - `{bind}`: `ORCA_PREVIEW_BIND`.
  - `{host}`: `ORCA_PREVIEW_HOST`.
  - `{db}`: a database name for each worktree, for an `onStop` drop.
- **Template database.** Some repos, for example branch-demo, give each preview its **own** Postgres
  database. Orca clones that database from `PREVIEW_TEMPLATE_DB` (`scripts/preview-db.sh create {db}`).
  Then Orca migrates it to the branch's schema. `onStop` drops it.
- **Push to template.** Use this when a preview has the setup that each preview must start with (for
  example, its integrations):

  ```sh
  orca preview --repo <repo> --branch <branch> --push-to-template            # dry run: plan + masked env diff
  orca preview --repo <repo> --branch <branch> --push-to-template --confirm  # apply
  ```

  This command replaces the template database with a full copy of the preview's database. Orca keeps
  the old template as `<template>_bak_<timestamp>`. The command prints the `psql` command to restore
  it. The command refuses to run while a client is connected to the template. Thus, stop the main
  checkout's backend first. The command needs a `pg_dump` that is the same version as the server or
  newer. `PG_DUMP` sets which `pg_dump` Orca uses. The command also writes env vars for integrations
  (Linear, GitHub, Slack, `_BASE_URL`, …) back into the main checkout's copied `.env`. It keeps a
  backup under `~/.orca/env-backups/`. Its output always masks the values. The orchestrator has the
  instruction to do a dry run first, and to apply only when you tell it to.
- **Orca's own previews** run the branch's own bridge in read-only mode (`scripts/preview-orca.sh`,
  `ORCA_PREVIEW_BRIDGE=1`). Thus the UI of a branch shows the server of that branch. The top bar
  shows the name of the bridge that answered.
- **Reaping.** One time each hour, Orca drops orphaned `orca_*` preview databases that are older than
  2 hours. It also removes the repo's `testContainerPrefix` Docker containers that are older than 3
  hours.

## Instances: the cloud box and the laptop

Orca can run as many **instances** that share one Postgres database. A usual setup has two
instances:

- **`cloud`**: an EC2 box that runs the bridge, the web UI and the orchestrator (`orchestratorOn:
  "cloud"`). The repos are under `/opt`. The worktrees are under the `.worktrees` of each repo.
- **`local`**: your laptop. It runs its own bridge against the same database over Tailscale.

A **workstream lives on the instance holding its worktree.** Orca puts new work on the first of
these that applies:

1. An explicit choice (the "run on" picker in the Add New box, or `spawn --on`).
2. The repo's `runsOn`.
3. The instance that got the request.

Orca forwards a request for a workstream on a different instance to that instance over the tailnet.
The board on each machine shows the workstreams of the two instances. **Move** (in the card menu, or
`orca move --to`) pushes the branch and gives the workstream a new home instance. The history stays
where it is, because it is in the shared database.

The Overview shows one card for each machine. The card shows CPU and memory (with marks for OOM
kills), the agents that run, disk, and **Cost · this month**. The cost is the hourly rate multiplied
by the hours that the instance was up. The hourly rate comes from `instanceHourlyUsd`. If that is not
set, Orca uses an EC2 on-demand estimate from the instance metadata. Open PR #180
("Robust instance cost") moves the month value to a boot ledger that starts from
`instanceBillingSince`. That PR is not on `main` at this time.

## Notifications

Orca has one notification centre (the bell at the bottom of the sidebar) and one toast stack (bottom
left). The two read the same `notification` table, so the two instances show the same rows. The
kinds include:

- Run finished, needs input, failed or stopped.
- Check failed.
- Preview ready or failed.
- PR CI failing, and PR conflicts.
- Merged, and merge refused.
- Auto-addressing, and auto-upkeep gave up (automatic PR upkeep).
- A failed button click. This kind is local to your browser.

Each notification has quick actions:

- CI failing or conflicts → **Address PR**.
- Check failed → **Fix**.
- Finished → **Reply**.
- Failed → **Retry**.
- Preview ready → **Open preview**.

**Open** is the last action on each notification. A notification is unread or read. Orca deletes a
notification only when it is more than 30 days old. You set do-not-disturb, toasts for each kind and
browser notifications in **Settings**.

## The UI, the keyboard and the phone

- **Pages:** Overview, Agents, Previews, Repos, Usage (each Claude login through hydra, and Codex),
  and Settings (theme, density, notifications, machine cost, and the config in read-only mode).
- **Agent page:** Overview (details, failure box, PR review, checks, description, GitHub
  conversation) | Chat (the conversation and a composer) | Files | Preview.
- **Keys:** `⌘K` palette, `C` new agent, `O` orchestrator, `A` quick ask, `F` find, `⌘B` sidebar,
  `G` then `O/A/P/R/U/S` to go to a page, `?` for the full sheet. To select a PR in a composer, type
  `@`.
- **Phone / PWA.** Below 768px, a bottom bar shows Agents, New agent and Orchestrator. Menus open as
  bottom sheets. You can install Orca as a PWA. The manifest has New agent and Orchestrator
  shortcuts. The **service worker registers only in a secure context**. Thus, on a plain-`http`
  tailnet URL, it does not operate, and Android does not offer to install it. To install it, you
  must have HTTPS (for example, Tailscale HTTPS certificates). When Orca deploys a new build, a
  "new version · Refresh" banner shows. iOS caches home-screen icons. Thus, after an icon change,
  remove the shortcut and add it again.

## Rules of thumb for workers

These rules come from the operation of Orca on one 16 GB box. To make Orca apply a rule, put it in
the orchestrator's notes or in a repo's `CLAUDE.md`.

- **Commit and push early.** Orca stops a run after `agentTimeoutMinutes` (45 in the seed config). A
  SIGTERM shows as exit 143. Work that is not pushed at that time can be lost.
- **Do not wait for background jobs.** The run ends when the agent stops.
- **Do not use headless browsers in workers.** Use `orca-shot <url> [--viewport 390x844] [--dark] …`.
  It goes into the queue for the bridge's one browser, which has a memory limit. It prints
  `shot: <path>`.
- **Run only the test files that the change affects.** Do not run the full suite, or two suites at
  the same time. Each run has a memory limit for each worker (`agentMemoryMaxGb`, 4 GB by default). A
  type-check or test run of the full project can go above it. The run then ends as
  `out of memory (<N> GB ceiling)`. Increase the repo's limit (8 GB for a large TypeScript repo). Do
  not remove the limit.
