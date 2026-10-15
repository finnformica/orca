# Caveman trial: sample runs, 2026-10-15

These samples show how caveman changes worker responses and token use. Each task ran on the `orca` repo, in the worktree `orca/caveman-trial-0d5682`, in two arms:

- **Caveman:** the run uses the same wiring as a trial worker run (`server/caveman.ts` `prepare()`). It goes through `caveman-proxy` on `127.0.0.1:8797` in mode `compress`. It gets the pinned `caveman` skill as `--append-system-prompt` and `caveman-mcp` as `--mcp-config`.
- **Control (direct):** the same command without the proxy, the skill and the MCP server.

## Method

- CLI: `claude -p <prompt> --output-format json --model claude-sonnet-5-5 --allowedTools Read,Grep,Glob,Bash(git diff:*)`. Claude Code 2.1.296, through the hydra shim.
- Environment: `agentEnv()`, so Orca's secrets are not in the run.
- Run 1 started all eight runs at the same time. Runs 2 and 3 ran one at a time, in two rounds. Round 1 runs the caveman arm first. Round 2 runs the control first. Thus neither arm gets a cache benefit from the order.
- Token counts are the API's own: uncached input, cache read, cache write and output.
- Cost is the CLI's own `total_cost_usd` estimate. The logins are subscriptions, so this is not a bill.
- The test output in sample 2 is a synthetic `bun test` log (375 lines, 3 failures). It is not from a real run. Its paths start with `/repo/`.
- Each task ran only two times in each arm. The model takes a different number of turns from run to run, so the numbers have noise.

## Result

- With the final wiring (run 3), the caveman arm cost 4.9% less than the control: $1.062 against $1.116.
- The caveman arm wrote 13.3% fewer output tokens. The answers kept the same facts.
- In round 1 alone, the caveman arm cost 1.6% more ($0.947 against $0.932). In round 2, it cost less ($0.116 against $0.185). The gap is small, and it is within the noise.
- The proxy compressed no tool result in these samples (`caveman_middleware_store_rows 0` on `/metrics`). The tool results were too small. The saving comes from shorter output.

## Why the first wiring cost more

Run 1 showed about 29% more input tokens for the caveman arm, and a cost 52% higher. The cause is in Claude Code, not in the proxy. Claude Code treats any `ANTHROPIC_BASE_URL` as a third-party gateway. It then changes the request in two ways:

1. It turns tool search off. Every tool schema goes into every request, and the request grows by about 16k tokens.
2. It drops the global prompt-cache scope. A cold run then writes about 11k tokens that a direct run reads from the shared cache.

These checks show it. All use the prompt "Reply with the word ok.":

| Request | Total input | Cache write | Cache read |
|---|---:|---:|---:|
| Direct, in a new empty directory | 21,688 | 10,708 | 10,978 |
| Through a pass-through server that only logs and forwards (no caveman) | 34,055 | 34,053 | 0 |
| Pass-through, with `ENABLE_TOOL_SEARCH=true` | 18,952 | 18,950 | 0 |
| Pass-through, `ENABLE_TOOL_SEARCH=true`, second run | 18,952 | 0 | 18,950 |
| Caveman proxy, `ENABLE_TOOL_SEARCH=true` | 18,952 | 0 | 18,950 |
| Caveman proxy, new empty directory, `ENABLE_TOOL_SEARCH=true` | 21,344 | 21,342 | 0 |
| Caveman proxy, new empty directory, `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` | 21,478 | 10,498 | 10,978 |

- The pass-through server shows the same growth as the caveman proxy. Thus the proxy is not the cause.
- Through the caveman proxy, a request reads the cache entry that the pass-through request wrote. Thus the proxy keeps the request prefix and `cache_control` byte-identical.
- The skill adds about 1,700 tokens to the system prompt. The MCP server adds about 80 tokens.
- The proxy's cache-breakpoint planner (`CAVEMAN_BREAKPOINT_PLAN`) changed nothing in a multi-turn run, so it stays at its default.

## The fix

`server/caveman.ts` now gives each caveman run two more environment variables:

- `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`: the CLI treats the proxy as the Anthropic API. Tool search and the global cache scope stay on. This is an internal CLI setting (the leading `_`). A CLI update can remove it.
- `ENABLE_TOOL_SEARCH=true`: the documented setting. It keeps tool search on if the internal setting goes. This is the larger half of the saving.

Run 2 had only `ENABLE_TOOL_SEARCH=true`. Run 3 has both.

## Totals for each arm

### Run 1: first wiring (no fix)

Runs: 8. Rounds: 1. Each round runs each task once in each arm.

| Arm | Uncached input | Cache read | Cache write | Output | Turns | Cost (CLI estimate) |
|---|---:|---:|---:|---:|---:|---:|
| Caveman | 22 | 582,032 | 348,155 | 3,198 | 11 | $1.483 |
| Control (direct) | 22 | 499,644 | 221,978 | 3,704 | 11 | $0.975 |
| Caveman against control | | +16.5% | +56.8% | -13.7% | | +52.1% |

### Run 2: `ENABLE_TOOL_SEARCH=true` only

Runs: 16. Rounds: 2. Each round runs each task once in each arm.

| Arm | Uncached input | Cache read | Cache write | Output | Turns | Cost (CLI estimate) |
|---|---:|---:|---:|---:|---:|---:|
| Caveman | 42 | 1,047,263 | 479,897 | 7,473 | 23 | $2.099 |
| Control (direct) | 50 | 1,319,623 | 413,554 | 7,671 | 25 | $1.863 |
| Caveman against control | | -20.6% | +16.0% | -2.6% | | +12.7% |

### Run 3: final wiring

Runs: 16. Rounds: 2. Each round runs each task once in each arm.

| Arm | Uncached input | Cache read | Cache write | Output | Turns | Cost (CLI estimate) |
|---|---:|---:|---:|---:|---:|---:|
| Caveman | 40 | 1,118,115 | 221,249 | 6,467 | 20 | $1.062 |
| Control (direct) | 42 | 1,149,386 | 231,658 | 7,463 | 23 | $1.116 |
| Caveman against control | | -2.7% | -4.5% | -13.3% | | -4.9% |

### Run 3 for each task (both rounds)

| Task | Arm | Cache read | Cache write | Output | Cost |
|---|---|---:|---:|---:|---:|
| Explain a function in server/agent.ts | Caveman | 342,465 | 55,685 | 2,719 | $0.284 |
| Explain a function in server/agent.ts | Control | 322,982 | 63,891 | 2,800 | $0.316 |
| Summarise the failures in a long test output | Caveman | 220,817 | 58,565 | 1,798 | $0.274 |
| Summarise the failures in a long test output | Control | 287,369 | 60,851 | 2,487 | $0.297 |
| Answer a question from a large JSON-like file | Caveman | 343,197 | 50,885 | 866 | $0.247 |
| Answer a question from a large JSON-like file | Control | 333,721 | 50,858 | 888 | $0.246 |
| Summarise a diff | Caveman | 211,636 | 56,114 | 1,084 | $0.256 |
| Summarise a diff | Control | 205,314 | 56,058 | 1,288 | $0.258 |

### Run 3 for each round

| Round | Caveman cost | Control cost | Caveman output | Control output |
|---|---:|---:|---:|---:|
| 1 | $0.946 | $0.932 | 3,215 | 3,417 |
| 2 | $0.115 | $0.185 | 3,252 | 4,046 |

## Sample pairs (run 3, round 1)

### Sample 1: Explain a function in server/agent.ts

**Prompt:**

```text
Read server/agent.ts and explain what the function `agentCommand` does, for each provider. Do not change any file.
```

#### With caveman

- Uncached input: 6. Cache read: 143,390. Cache write: 55,685. Output: 1,345.
- Turns: 3. Cost: $0.251. Duration: 11.7 s.

> `agentCommand` (`server/agent.ts:550`) builds the argv array that starts a headless agent run. It is pure: it does no I/O, so tests can pin the resume contracts. For every provider, the prompt goes last, after a `--` end-of-options marker. User prompts often start with `-`, such as a Markdown bullet. Without `--`, the CLI would read that dash as an unknown option and the run would die.
>
> All providers share this: if `model` is set, `--model <model>` is added. If it is unset, each CLI uses its own default.
>
> **codex**
> - Resume: `codex exec resume --json --dangerously-bypass-approvals-and-sandbox [--model m] <sessionId> -- <prompt>`
> - New run: `codex exec --json --dangerously-bypass-approvals-and-sandbox [--model m] -C <cwd> -- <prompt>`
> - It always bypasses approvals and the sandbox. It ignores `permissionMode`, `maxBudgetUsd`, `allowedTools` and `extraArgs`.
> - A new run sets the working directory with `-C cwd`. A resume does not, because the session already knows its directory.
>
> **cursor**
> - Command: `cursor-agent -p [--model m] [--resume <sessionId>] --output-format stream-json --force --trust -- <prompt>`
> - It uses `stream-json` instead of `json`, so steps arrive as they happen. The final `result` event is the same object the buffered form gave, so `parseCursorOutput` still works.
> - `--force` and `--trust` skip confirmations, so it also ignores `permissionMode`.
> - It ignores `maxBudgetUsd`, `allowedTools` and `extraArgs`.
> - It has no `-C`, so the working directory comes from the spawn's cwd.
>
> **claude** (the default branch)
> - Command: `claude -p --permission-mode <mode> [--model m] [--max-budget-usd N] (--resume <id> | --session-id <id>) [--allowedTools a,b] ...extraArgs --output-format stream-json --verbose --include-partial-messages -- <prompt>`
> - Permission mode is `bypassPermissions` when `permissionMode` is `"bypass"`, else `default`. The repo opts in to bypass.
> - `--max-budget-usd` is added only when `maxBudgetUsd` is truthy. When the cap is hit, the turn records `budget_reached`.
> - Resume uses `--resume <resume>`. A new run uses `--session-id`, with the given `sessionId` or a fresh `crypto.randomUUID()`. Claude is the only provider that pre-assigns its session ID.
> - `--allowedTools` is added only when the list is non-empty, joined with commas.
> - `extraArgs` is spliced in before the output flags. `launch` passes `wiring.args` there when `wiring?.on` is true, which looks like the caveman trial wiring.
> - `stream-json` needs `--verbose` under `-p`. `--include-partial-messages` produces the live-typing text deltas, which are never stored.
> - Only Claude uses `permissionMode`, `maxBudgetUsd`, `allowedTools` and `extraArgs`.

#### Without caveman (control)

- Uncached input: 6. Cache read: 142,000. Cache write: 52,089. Output: 1,502.
- Turns: 3. Cost: $0.238. Duration: 12.3 s.

> `agentCommand` (`server/agent.ts:550`) is a pure function. It builds the argv array for a headless agent run and does no I/O. Tests use it to pin each CLI's resume contract. Its parameters are `provider`, `cwd`, `prompt`, `resume`, `sessionId`, `model`, `permissionMode` (`"bypass"` or `"ask"`, default `"ask"`), `maxBudgetUsd`, `allowedTools` and `extraArgs`.
>
> Three things hold for every provider:
> - A `model` becomes `--model <model>`. If it is unset, the CLI uses its own default.
> - The prompt is always the last argument, after a `--` end-of-options marker. Prompts often start with `-` (a Markdown bullet), and without `--` the CLI reads that as an unknown option and the run dies before the agent sees the prompt.
> - `resume` is the provider's native session id. When it is set, the command continues that session.
>
> **codex**
> - Resume: `codex exec resume --json --dangerously-bypass-approvals-and-sandbox [--model m] <resume> -- <prompt>`.
> - New run: `codex exec --json --dangerously-bypass-approvals-and-sandbox [--model m] -C <cwd> -- <prompt>`. `-C` sets the working directory.
> - It always bypasses approvals and the sandbox. `permissionMode`, `maxBudgetUsd`, `allowedTools` and `extraArgs` are ignored.
> - The resume form has no `-C`, so it relies on the process's own cwd.
>
> **cursor**
> - Command: `cursor-agent -p [--model m] [--resume <id>] --output-format stream-json --force --trust -- <prompt>`.
> - It uses `stream-json` so steps arrive as they happen. The final `result` event is the same object the buffered form gave, so `parseCursorOutput` still works.
> - `--force` and `--trust` are always on.
> - `cwd`, `permissionMode`, `maxBudgetUsd`, `allowedTools` and `extraArgs` are ignored. `cwd` is not passed, so the process's cwd decides where it runs.
>
> **claude** (the default branch)
> - Command: `claude -p --permission-mode <mode> [--model m] [--max-budget-usd N] (--resume <id> | --session-id <id>) [--allowedTools a,b] ...extraArgs --output-format stream-json --verbose --include-partial-messages -- <prompt>`.
> - Permission mode: `bypassPermissions` when `permissionMode` is `"bypass"`, else `default`. A repo opts into bypass.
> - Budget: `--max-budget-usd` is added only when `maxBudgetUsd` is truthy. The CLI stops at that spend, and the turn records `budget_reached`.
> - Session: with `resume` it passes `--resume`. Otherwise it passes `--session-id`, using `sessionId` or a fresh `crypto.randomUUID()`. A new session therefore has a known id up front.
> - Tools: `--allowedTools` is added only when the list is non-empty. It is comma-joined.
> - Extra args: `extraArgs` go in just before the output flags. The caller (`launch`, line 617) fills them from `wiring.args` when the caveman wiring is on.
> - Output: `stream-json` with `--verbose` (required under `-p`) streams steps live. `--include-partial-messages` adds the text deltas that type the reply out in the chat. The deltas are never stored.
> - `cwd` is not used. The caller sets it on the spawned process.
>
> Only claude honours the budget, tool allowlist, permission mode and extra args.

### Sample 2: Summarise the failures in a long test output

**Prompt:**

```text
Read /tmp/cvs/test-output.log. It is the output of `bun test`. Summarise each failure: the test name, the file and line, and the likely cause. Do not change any file.
```

#### With caveman

- Uncached input: 4. Cache read: 81,126. Cache write: 58,565. Output: 933.
- Turns: 2. Cost: $0.252. Duration: 9.5 s.

> 3 failures out of 350 tests. 347 pass. The log only has stack lines, so the causes below are inferred and I haven't opened the source. The paths are `/repo/...` in the log, which is another checkout's path.
>
> 1. **`mergeVerdict > merges when every required check passed`**
>    - Location: `tests/mergeQueue.test.ts:212:31`
>    - Error: expected `"merged"`, received `"waiting"`.
>    - Likely cause: `mergeVerdict` in `workstream.ts` still sees the checks as not green. Three possibilities:
>      - The test fixture is missing a field the verdict now requires (a `MERGEABLE` state, or a non-empty checks list).
>      - A required-check rule changed.
>      - Skipped or neutral checks are not counted as passed.
>    - The queue treats "no checks yet" as not green, so an empty or mis-shaped checks array in the fixture would give `waiting`.
>
> 2. **`toast stack > collapses past three`**
>    - Location: `shared/notifications.ts:88:14`, in `stackLayout`. The test is in `tests/notifications.test.ts`; the log gives no line for it.
>    - Error: `TypeError: undefined is not an object (evaluating 'row.key.startsWith')`.
>    - Likely cause: the test builds notification rows with no `key`. Either `stackLayout` started reading `row.key` and the fixture was not updated, or the fixture helper omits it. The `key` field is on every stored row, so the fixture is the likelier culprit.
>
> 3. **`upkeep tick > gives up after UPKEEP_MAX_STREAK`**
>    - Location: `tests/upkeep.test.ts`; the log gives no line.
>    - Error: timeout after 5001ms.
>    - Likely cause: it is either a hang or a slow loop. The test runs several minute ticks to reach `UPKEEP_MAX_STREAK`. One of them probably awaits a real `gh`, git or DB call, or a launch that never resolves.
>    - If it only fails under the full suite, it is probably one of the load flakes in my memory notes. Run it alone to check.
>
> Next step: run `bun test tests/upkeep.test.ts` and `bun test tests/mergeQueue.test.ts` separately. A failure that goes away alone points to a flake. One that stays points to a real regression.

#### Without caveman (control)

- Uncached input: 4. Cache read: 78,000. Cache write: 58,519. Output: 852.
- Turns: 2. Cost: $0.250. Duration: 8.2 s.

> The log shows 3 failures out of 350 tests (347 pass). I only read the log, not the source files, so the causes below are inferred from the error output.
>
> 1. **`mergeVerdict > merges when every required check passed`**
>    - Location: `tests/mergeQueue.test.ts:212:31`.
>    - Error: it expected `"merged"` but got `"waiting"`.
>    - Likely cause: `mergeVerdict` (in `workstream.ts`) did not treat the test's checks as all green. The test fixture may not match the current definition of green. CLAUDE.md says no checks yet is not green, and only required checks count. Either the fixture has no checks, or a check state or `MERGEABLE` field is missing or in the wrong shape. Otherwise `mergeVerdict` changed and the test was not updated.
>
> 2. **`toast stack > collapses past three`**
>    - Location: the throw is in `shared/notifications.ts:88:14`, in `stackLayout`. The log does not give a line in the test file.
>    - Error: `TypeError: undefined is not an object (evaluating 'row.key.startsWith')`.
>    - Likely cause: `stackLayout` now calls `row.key.startsWith(...)`, probably to spot local notifications. The test builds rows without a `key`. Either the test fixtures need a `key`, or `stackLayout` should tolerate a missing one.
>
> 3. **`upkeep tick > gives up after UPKEEP_MAX_STREAK`**
>    - Location: `tests/upkeep.test.ts`. The log gives no line number, only the timeout.
>    - Error: it timed out after 5000ms (took 5001.44ms).
>    - Likely cause: this test runs several upkeep ticks, each with real `git`/`gh` calls. It probably ran slowly while the full suite was loading the machine, which is a flake. Another possibility is a tick that waits for an agent run that never finishes. CLAUDE.md's memory notes already mention about 7–8 flaky tests under full-suite load. Run this test alone to tell the two apart.
>
> The log paths start with `/repo/`, not this worktree's path, so the run may have come from a different checkout or a container. Check that it matches the current branch before acting on these results.
>
> I changed no files.

### Sample 3: Answer a question from a large JSON-like file

**Prompt:**

```text
Read bun.lock (a JSON-like lockfile). Which exact versions of `react`, `react-dom` and `@radix-ui/react-hover-card` does it resolve? Do not change any file.
```

#### With caveman

- Uncached input: 6. Cache read: 146,893. Cache write: 50,151. Output: 433.
- Turns: 3. Cost: $0.220. Duration: 5.4 s.

> `bun.lock` resolves:
>
> - `react`: 18.3.1
> - `react-dom`: 18.3.1
> - `@radix-ui/react-hover-card`: 1.2.1
>
> I changed no files.

#### Without caveman (control)

- Uncached input: 6. Cache read: 142,190. Cache write: 50,102. Output: 445.
- Turns: 3. Cost: $0.219. Duration: 5.2 s.

> `bun.lock` resolves these versions:
>
> - `react`: 18.3.1 (line 586)
> - `react-dom`: 18.3.1 (line 588)
> - `@radix-ui/react-hover-card`: 1.2.1 (line 174)
>
> I didn't change any file.

### Sample 4: Summarise a diff

**Prompt:**

```text
Run `git diff 16474c1 3260409 -- server/agent.ts` and summarise what the change does in at most 6 bullets. Do not change any file.
```

#### With caveman

- Uncached input: 4. Cache read: 81,118. Cache write: 52,758. Output: 504.
- Turns: 2. Cost: $0.224. Duration: 5.5 s.

> - Adds an opt-in "caveman trial" to `server/agent.ts`. A repo sets `agentProxy` in `LaunchOptions`, and its Claude workers run through a local proxy. The orchestrator is excluded.
> - At launch, `wantsCaveman(...)` decides whether the run is a trial run. If so, `caveman.prepare()` returns the wiring. `prepare` never throws, so it falls back to a direct run when the proxy is unavailable.
> - `agentCommand` gets an `extraArgs` parameter, inserted before `--output-format`. The proxy's extra args go there, and its env vars are merged into the spawned process's env.
> - The run ledger entry now records `repo` and `caveman` (true when the run went through the proxy).
> - Every worker run, in both arms, also goes to `caveman.recordRun`. It stores status, duration, token counts, cost, model, action, mode and runId, plus the fallback reason when the proxy was skipped.
> - If a proxied run fails and the proxy is unhealthy, the proxy is marked down and the bridge queues one direct retry. The retry uses `cavemanRetryInstruction` and the same session, but only on the primary bridge.

#### Without caveman (control)

- Uncached input: 4. Cache read: 77,992. Cache write: 52,676. Output: 618.
- Turns: 2. Cost: $0.225. Duration: 6.8 s.

> - **Opt-in routing:** `launch()` calls `caveman.prepare()` when `wantsCaveman(...)` is true. That needs the repo's new `agentProxy` option, a Claude provider, and a repo that isn't the orchestrator's. If the proxy is ready, the run gets the extra CLI args and env vars from `wiring`, so it goes through the local caveman proxy. `prepare` never throws, so a failure means the run goes direct.
> - **Command builder:** `agentCommand` takes a new `extraArgs` parameter. It places those args after `--allowedTools` and before `--output-format`.
> - **Ledger:** each run's ledger record now includes `repo` and `caveman`. `caveman` is `undefined` for runs that didn't opt in.
> - **Trial record:** every worker run, whichever arm it ran in, is also written with `caveman.recordRun`. The orchestrator is skipped. The record holds the status, duration, token counts, cost, model, action, mode and run id. When the proxy was unavailable it also holds the fallback reason.
> - **Direct retry:** a run that went through the proxy and failed is retried once, directly, on the same session. This happens only if `retryDirect` agrees (checking the stop state, the instruction, proxy health and the error) and the bridge is primary. The code then calls `caveman.markDown(...)` to take the proxy out of use. It queues a follow-up built by `cavemanRetryInstruction`, which `dispatchQueued` sends.
> - **New imports:** `./caveman`, `shared/cavemanTrial` and `ORCHESTRATOR_REPO`. I changed no files.
