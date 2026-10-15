# Caveman trial: sample runs, 2026-10-15

These samples show how caveman changes worker responses. Each task ran twice on the `orca` repo, in the worktree `orca/caveman-trial-0d5682`:

- **With caveman:** the run uses the same wiring as a trial worker run (`server/caveman.ts` `prepare()`). It goes through `caveman-proxy` on `127.0.0.1:8797` in mode `compress`. It gets the pinned `caveman` skill as `--append-system-prompt` and `caveman-mcp` as `--mcp-config`.
- **Without caveman (direct):** the same command without the proxy, the skill and the MCP server.

## Method

- CLI: `claude -p <prompt> --output-format json --model claude-sonnet-5-5 --allowedTools Read,Grep,Glob,Bash(git diff:*)`. Claude Code 2.1.296, through the hydra shim.
- Environment: `agentEnv()`, so Orca's secrets are not in the run.
- All eight runs started at the same time. Each run is one sample, so the numbers have noise.
- Input tokens are the sum of uncached input, cache write and cache read, as the API reports them. Through the proxy, this is what the model read after compression.
- Cost is the CLI's own `total_cost_usd` estimate. The logins are subscriptions, so this is not a bill.
- The test output in sample 2 is a synthetic `bun test` log (`/tmp/cvs/test-output.log`, 375 lines, 3 failures). It is not from a real run. Its paths start with `/repo/`.

## Findings

- **Output:** caveman runs wrote 9% to 20% fewer output tokens. The answers kept the same facts. The style change is small, because the repo's STE rules and `CLAUDE.md` also control the style.
- **Input:** caveman runs read about 29% MORE input tokens on every task, and their cost estimate was about 50% higher.
- **Cause of the extra input:** the proxy. A one-line probe ("Reply with the word ok.") shows this:

| Probe | Total input | Cache write | Cache read |
|---|---:|---:|---:|
| Direct | 62,063 | 51,083 | 10,978 |
| Skill only | 63,788 | 52,799 | 10,987 |
| MCP only | 62,146 | 51,166 | 10,978 |
| Proxy only | 78,135 | 78,133 | 0 |
| All three (caveman) | 81,018 | 81,016 | 0 |

- The skill adds about 1,700 tokens. The MCP server adds about 80 tokens.
- The proxy adds about 16,000 tokens to each request. It also stops the cache read of the shared Claude Code prefix, so every token is a cache write.
- The proxy store had 0 rows after the runs (`caveman_middleware_store_rows 0` on `/metrics`). Thus no tool result was compressed in these samples.
- The proxy log does not show which content it adds. Find the cause before the trial numbers from 2026-10-15 to 2026-10-22 are used.

## Summary

| Task | Input, caveman | Input, direct | Change | Output, caveman | Output, direct | Change | Cost, caveman | Cost, direct |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Explain a function in server/agent.ts | 251,111 | 194,107 | +29% | 1,265 | 1,434 | -12% | $0.371 | $0.244 |
| Summarise the failures in a long test output | 174,417 | 136,531 | +28% | 860 | 940 | -9% | $0.384 | $0.258 |
| Answer a question from a large JSON-like file | 336,121 | 260,293 | +29% | 570 | 700 | -19% | $0.370 | $0.241 |
| Summarise a diff | 168,560 | 130,713 | +29% | 503 | 630 | -20% | $0.357 | $0.232 |
| **All four** | 930,209 | 721,644 | +29% | 3,198 | 3,704 | -14% | | |

## Sample 1: Explain a function in server/agent.ts

**Prompt:**

```text
Read server/agent.ts and explain what the function `agentCommand` does, for each provider. Do not change any file.
```

### With caveman

- Input tokens: 251,111 (uncached 6, cache write 85,570, cache read 165,535)
- Output tokens: 1,265
- Turns: 3. Cost: $0.371. Duration: 13.2 s.

> `agentCommand` (`server/agent.ts:550`) is a pure function. It builds the argv array that launches one headless agent run. It does no I/O. Every provider's prompt goes last, after a `--` end-of-options marker. Prompts often start with `-` (a Markdown bullet), and without `--` each CLI would read that dash as an unknown option and the run would die.
>
> If `model` is set, all three providers get `--model <model>`. Otherwise each CLI uses its own default.
>
> **codex**
> - With `resume`: `codex exec resume --json --dangerously-bypass-approvals-and-sandbox [--model m] <resume> -- <prompt>`. This continues the native session id.
> - Without `resume`: `codex exec --json --dangerously-bypass-approvals-and-sandbox [--model m] -C <cwd> -- <prompt>`. The `-C` flag sets the working directory.
> - It always bypasses approvals and the sandbox. It ignores `permissionMode`, `maxBudgetUsd`, `allowedTools`, `sessionId` and `extraArgs`.
>
> **cursor**
> - The command is `cursor-agent -p [--model m] [--resume <resume>] --output-format stream-json --force --trust -- <prompt>`.
> - It uses `stream-json` instead of `json`, so steps arrive as they happen. The final `result` event has the same shape, so `parseCursorOutput` still works.
> - It has no `cwd` flag, so the process's own working directory applies. It also ignores `permissionMode`, `maxBudgetUsd`, `allowedTools`, `sessionId` and `extraArgs`.
>
> **claude** (the default branch)
> - The command is `claude -p --permission-mode <mode> [--model m] [--max-budget-usd N] (--resume <id> | --session-id <id>) [--allowedTools a,b] ...extraArgs --output-format stream-json --verbose --include-partial-messages -- <prompt>`.
> - Permission mode is `bypassPermissions` when `permissionMode` is `"bypass"`, else `default`. The repo opts into bypass.
> - `--max-budget-usd` is added only when `maxBudgetUsd` is truthy. The CLI stops at that spend and the turn records `budget_reached`.
> - With `resume` it passes `--resume`. Otherwise it passes `--session-id`, using `sessionId` or a fresh `crypto.randomUUID()`.
> - `--allowedTools` is added only when the list is non-empty. The orchestrator uses it when `orchestratorShell` is false.
> - `extraArgs` is spliced in before the output flags. In `launch` (line 617) it carries `wiring.args` only when `wiring?.on` is true. This is likely the caveman-trial switch from your recent commits, though I didn't check it.
> - `--verbose` is required for `stream-json` under `-p`. `--include-partial-messages` adds `stream_event` text deltas so the chat types out the reply live. Those deltas are never stored.

### Without caveman (direct)

- Input tokens: 194,107 (uncached 6, cache write 53,884, cache read 140,217)
- Output tokens: 1,434
- Turns: 3. Cost: $0.244. Duration: 14.6 s.

> `agentCommand` (`server/agent.ts:550`) is a pure function. It builds the argv array that launches one headless agent run. It does no I/O. `launch()` at line 617 calls it, and tests use it to pin each CLI's resume contract.
>
> **Shared behaviour**
> - `model`, if set, becomes `--model <model>`. If it is unset, each CLI uses its own default.
> - The prompt is always the last argument, after a `--` end-of-options marker. User prompts often start with `-` (a Markdown bullet), and without `--` the CLI would read that as an unknown option and the run would die.
>
> **Codex** (`codex exec`)
> - **New run:** `codex exec --json --dangerously-bypass-approvals-and-sandbox [--model m] -C <cwd> -- <prompt>`. `-C` sets the working directory.
> - **Resume:** `codex exec resume --json --dangerously-bypass-approvals-and-sandbox [--model m] <session> -- <prompt>`. There is no `-C` here.
> - Codex always runs with approvals and sandbox bypassed. It ignores `permissionMode`, `maxBudgetUsd`, `allowedTools` and `extraArgs`.
>
> **Cursor** (`cursor-agent`)
> - Both cases: `cursor-agent -p [--model m] [--resume <session>] --output-format stream-json --force --trust -- <prompt>`.
> - `--resume` is added only when resuming.
> - It uses `stream-json` so steps arrive as they happen. The final `result` event matches the old buffered form, so `parseCursorOutput` can still read the outcome.
> - `--force` and `--trust` are always on. Like Codex, it ignores `permissionMode`, `maxBudgetUsd`, `allowedTools` and `extraArgs`. It does not pass `cwd`, so the process's own working directory applies.
>
> **Claude** (the default branch, any other provider value)
> - Full shape: `claude -p --permission-mode <bypassPermissions|default> [--model m] [--max-budget-usd N] (--resume <session> | --session-id <id>) [--allowedTools a,b] ...extraArgs --output-format stream-json --verbose --include-partial-messages -- <prompt>`.
> - **Permission mode:** `"bypass"` gives `bypassPermissions`. The default `"ask"` gives `default`. This is a per-repo opt-in, because bypass is risky on a client's repo.
> - **Budget:** `--max-budget-usd` is added only if `maxBudgetUsd` is truthy. When the run hits that spend, the CLI reports a budget result and the turn records `budget_reached`.
> - **Session:** a resume uses `--resume <session>`. A fresh run uses `--session-id <sessionId>`, or a new `crypto.randomUUID()` if none was given.
> - **Tools:** `--allowedTools` is added only if `allowedTools` is non-empty, joined with commas.
> - **Extra args:** `extraArgs` is spliced in before the output flags. `launch()` passes `wiring.args` there when `wiring?.on` is set, otherwise an empty array.
> - **Streaming:** `stream-json` makes steps arrive live for the chat's activity trail. `--verbose` is required for `stream-json` under `-p`. `--include-partial-messages` adds text deltas so the reply types out live. Those deltas are never stored.
>
> I made no changes to any file.

## Sample 2: Summarise the failures in a long test output

**Prompt:**

```text
Read /tmp/cvs/test-output.log. It is the output of `bun test`. Summarise each failure: the test name, the file and line, and the likely cause. Do not change any file.
```

### With caveman

- Input tokens: 174,417 (uncached 4, cache write 91,785, cache read 82,628)
- Output tokens: 860
- Turns: 2. Cost: $0.384. Duration: 13.4 s.

> 3 failures out of 350 tests (347 pass). I read only the log, not the source, so the causes below are inferences.
>
> 1. **`mergeVerdict > merges when every required check passed`**
>    - File: `tests/mergeQueue.test.ts:212`
>    - Error: expected `"merged"`, received `"waiting"`.
>    - Likely cause: `mergeVerdict` in `workstream.ts` treats the fixture as not green yet. Per the brief, "no checks yet" counts as waiting. The fixture may have no checks, or a status the verdict doesn't count as passed. A recent change to the verdict or the fixture could also cause it.
>
> 2. **`toast stack > collapses past three`**
>    - File: `tests/notifications.test.ts`, no line given in the log.
>    - Stack: `shared/notifications.ts:88`, `stackLayout`.
>    - Error: `TypeError: undefined is not an object (evaluating 'row.key.startsWith')`.
>    - Likely cause: `stackLayout` calls `row.key.startsWith(...)`, and the test builds rows with no `key`. Either the test's row builder is stale, or `stackLayout` now needs a field the test doesn't set. The notification `key` became required, so the fixture needs it.
>
> 3. **`upkeep tick > gives up after UPKEEP_MAX_STREAK`**
>    - File: `tests/upkeep.test.ts`, no line given in the log.
>    - Error: timeout after 5000ms.
>    - Likely cause: the test loops through several upkeep ticks, each doing git, `gh` shim or Postgres I/O. It may be slow, or it may be waiting on something that never completes. It could be the known full-suite-load flakiness in your memory notes, or a missing or polluted test environment (`.env`, `ORCA_*` variables). Compare against a baseline run, and rerun this file alone to see if it passes.
>
> Every path in the log starts with `/repo/`, not this worktree, so the run happened in a different checkout. Check that it matches this branch before relying on these results.
>
> I changed no files.

### Without caveman (direct)

- Input tokens: 136,531 (uncached 4, cache write 60,314, cache read 76,213)
- Output tokens: 940
- Turns: 2. Cost: $0.258. Duration: 12.5 s.

> `bun test` had 3 failures out of 350 tests (347 passed). I only read the log. I did not open the source, so the causes below are inferences from the error text.
>
> 1. **`mergeVerdict > merges when every required check passed`**
>    - **Where:** `tests/mergeQueue.test.ts:212`, in `/repo/`.
>    - **Error:** it expected `"merged"` and got `"waiting"`.
>    - **Likely cause:** `mergeVerdict` decided the checks were not all green, so it kept waiting. The test fixture may be missing a field the verdict now needs, such as a check's state or conclusion, or `MERGEABLE`. Or `mergeVerdict` changed and the test was not updated. Rules here: "no checks yet" is not green, and every check must have passed.
>
> 2. **`toast stack > collapses past three`**
>    - **Where:** the throw is at `shared/notifications.ts:88` (`stackLayout`). The log gives no test line.
>    - **Error:** `TypeError: undefined is not an object (evaluating 'row.key.startsWith')`.
>    - **Likely cause:** `stackLayout` now reads `row.key`, but the test builds its rows without a `key`. Notification rows carry an idempotency `key` such as `run:<id>:<kind>`. Either the test fixture needs a `key`, or `stackLayout` should handle a missing one.
>
> 3. **`upkeep tick > gives up after UPKEEP_MAX_STREAK`**
>    - **Where:** `tests/upkeep.test.ts`. The log gives no line.
>    - **Error:** the test timed out after 5000 ms.
>    - **Likely cause:** the test ran the real upkeep tick in a loop, and a step never settled. Candidates are a launch awaiting an agent or `gh` shim, a database call, or the primary-lock check (`held()`). A database call would hang if the test is not pointed at a `tests/pg.ts` schema. A slow machine or a leaked environment variable is also possible. It may be a flake: my memory notes about 7–8 known full-suite-load flakes. I'd run it alone to check.
>
> The log paths start with `/repo/`, so the run happened in a different checkout from this worktree. Failures 1 and 2 look like real test/code mismatches. Failure 3 needs a re-run on its own before you treat it as one.

## Sample 3: Answer a question from a large JSON-like file

**Prompt:**

```text
Read bun.lock (a JSON-like lockfile). Which exact versions of `react`, `react-dom` and `@radix-ui/react-hover-card` does it resolve? Do not change any file.
```

### With caveman

- Input tokens: 336,121 (uncached 8, cache write 84,861, cache read 251,252)
- Output tokens: 570
- Turns: 4. Cost: $0.370. Duration: 11.0 s.

> `bun.lock` resolves these exact versions:
>
> - `react`: 18.3.1
> - `react-dom`: 18.3.1
> - `@radix-ui/react-hover-card`: 1.2.1
>
> I didn't change any file.

### Without caveman (direct)

- Input tokens: 260,293 (uncached 8, cache write 53,276, cache read 207,009)
- Output tokens: 700
- Turns: 4. Cost: $0.241. Duration: 9.6 s.

> `bun.lock` resolves these exact versions:
>
> | Package | Resolved version | Range in `package.json` |
> |---|---|---|
> | `react` | 18.3.1 | `^18.3.1` |
> | `react-dom` | 18.3.1 | `^18.3.1` |
> | `@radix-ui/react-hover-card` | 1.2.1 | `^1.2.1` |
>
> These are the top-level entries (lines 174, 586 and 588). I did not check for nested copies of these packages under other dependencies. I changed no files.

## Sample 4: Summarise a diff

**Prompt:**

```text
Run `git diff 16474c1 3260409 -- server/agent.ts` and summarise what the change does in at most 6 bullets. Do not change any file.
```

### With caveman

- Input tokens: 168,560 (uncached 4, cache write 85,939, cache read 82,617)
- Output tokens: 503
- Turns: 2. Cost: $0.357. Duration: 9.7 s.

> - **Opt-in:** new `agentProxy` launch option (the repo's setting) routes Claude worker runs through a local "caveman" proxy. The orchestrator and non-Claude providers are excluded (`wantsCaveman`).
> - **Wiring:** `launch()` calls `caveman.prepare()`, which never throws. If the proxy is on, its extra CLI args go into `agentCommand` through a new `extraArgs` parameter, inserted before `--output-format`. Its env vars merge into the spawn env.
> - **Fallback:** if the proxy can't be had, `prepare()` returns a fallback result and the run goes direct as normal.
> - **Ledger:** the run record now carries `repo` and `caveman` (true or false, undefined if the trial didn't apply).
> - **Trial record:** `caveman.recordRun` logs every worker run for both arms (not the orchestrator). It logs status, duration, token counts, cost, model, action, mode, runId, and the fallback reason if any.
> - **Auto-retry:** if a proxied run fails on the connection, the code calls `caveman.markDown(...)` to take the proxy out of use. It queues one direct retry (`cavemanRetryInstruction`) on the same session. This only happens in the primary bridge and when `retryDirect` approves.

### Without caveman (direct)

- Input tokens: 130,713 (uncached 4, cache write 54,504, cache read 76,205)
- Output tokens: 630
- Turns: 2. Cost: $0.232. Duration: 9.4 s.

> - **Caveman trial wiring:** `launch()` calls `caveman.prepare()` when `wantsCaveman` is true for the run. That needs the repo's `agentProxy` option, the Claude provider, and a repo that isn't the orchestrator's. Every other run gets no wiring.
> - **Proxy routing:** When the proxy is available, `wiring.args` go to the Claude command through a new `extraArgs` parameter on `agentCommand`. `wiring.env` is merged into the spawned process's environment. If `prepare` can't get the proxy, the run goes out direct. The comment says `prepare` never throws.
> - **New option:** `LaunchOptions` gains an optional `agentProxy`. It carries the repo's `agentProxy` setting.
> - **Ledger fields:** The existing run-ledger record now includes `repo` and `caveman` (whether the run used the proxy, or undefined if the trial wasn't in play).
> - **Trial record:** After every worker run (not the orchestrator), `caveman.recordRun` stores one record for both arms. It holds the repo, provider, whether caveman was on, any fallback reason, status, duration, token counts, cost, model, action, mode and runId.
> - **Direct retry:** A caveman run that fails on the connection is treated as the proxy's fault, not the worker's. That needs a primary bridge, a repo and a branch, and `retryDirect` must return true. The bridge then calls `caveman.markDown(...)` and queues one direct retry on the same session through `db.queueMessage`. `dispatchQueued` sends the retry.
