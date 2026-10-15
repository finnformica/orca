# Duplication audit — 2026-10-15

Scope: `server/`, `web/src/`, `shared/`, `scripts/`, `bin/`, plus `tests/` helpers. Report only — no
code was changed. Line numbers are at `main` @ 76603b6.

## Method

- `bunx --bun jscpd@4` (well under the memory cap). At 8 lines / 70 tokens it found **zero** clones in
  source; at 5 lines / 40 tokens, 12 small ones (80 lines, 0.3%). Over `tests/` at 6 / 60: 102 clones,
  945 lines (4.1%). Verbatim copy-paste is rare. Most duplication here is **semantic** —
  the same decision written twice, after which the copies drifted. That is the more expensive kind,
  so it got most of the attention.
- Four read-only sweeps (server, web UI, cross-layer types/constants, tests) by grep and reading,
  then a manual spot-check of each claimed drift bug before it went in this report. Findings marked
  **(verified)** were confirmed by reading the code at the cited lines. None were reproduced at
  runtime: no app or test run was involved.
- Ranking = lines removable × drift/bug risk × how often the code changes (`store.ts`,
  `workstream.ts`, `agent.ts`, `index.ts` and the views change in most PRs).

**Out of scope, listed only:** the chat transcript duplication — `web/src/views/Chat.tsx`
`ChatPanel` vs the orchestrator in `web/src/components/Terminal.tsx` (including
`OrchestratorPanel`/`OrchestratorPage` building the same `row`, header and `send`,
`Terminal.tsx:273-276/415-418`, `318-321/428-431`, `340-349/438-444`, and the Compact flow
`Terminal.tsx:194-205` vs `Chat.tsx:700-721`). Another workstream is fixing it, so this report leaves
`Terminal.tsx`'s chat parts alone. Any workstream below that touches `Terminal.tsx` should land
after it.

## Structural observation

`web/src/workstream.ts` (3250 lines) has become the real shared layer: 11 server files import runtime
code from it (config, git, health, gh, mergeQueue, orchestrator, upkeep, verbs, notify, index), and
it imports types back from `server/gh.ts`. `shared/` holds three files. Most of the cross-layer
duplication below exists because there was no obvious neutral home for a type or a decision, so each
side wrote its own. Moving the server-domain sections of `workstream.ts` (merge queue 1177-1271,
upkeep 1273-1382, orchestrator prompts 1465-1593, billing 2364-2461, sweep 3120-3171) to `shared/`
is a zero-net-lines prerequisite that makes findings 4, 5 and 13 cheap.

---

## Ranked findings

### 1. Orca's secrets are scrubbed in 2 of ~8 places that run untrusted code — and the list is copied
*Bug risk: high (security). Size: ~10 lines removed + ~6 call sites changed. Risk of the change: low.*

- `server/agent.ts:147-158` — `ORCA_SECRETS = ["SLACK_TOKEN", "ORCA_DATABASE_URL",
  "ORCA_TEST_DATABASE_URL"]`, `agentEnv()`; used by `agent.ts:620` and `check.ts:15`.
- `server/usage.ts:318-319` (`renewToken`) — a hand copy of the list plus `CLAUDE_CONFIG_DIR`
  **(verified)**. When a fourth secret is added to `ORCA_SECRETS`, this copy will not get it.
- Places that spawn with the bridge's FULL `process.env`:
  - `preview.ts:165`: preview services, i.e. `sh -lc` over repo commands in an agent-edited worktree **(verified)**.
  - `preview.ts:254`: `onStop`.
  - `agent.ts:798`: `commandOutput`, a resumed provider session for PR title/body, which Codex can run shell in.
  - `screenshot.ts:261,266`: the browser.
  - `run.ts:6`: every git/gh call, so git hooks in an agent worktree see the token.
- An agent that edits the branch's dev server can read `SLACK_TOKEN` through its preview. That
  defeats the "a prompt injection that reads the environment must find nothing" rule in CLAUDE.md.
- Caveat: Orca's *own* preview (`scripts/preview-orca.sh`) needs `ORCA_DATABASE_URL`. A scrubbed
  preview env therefore needs a per-repo allow-back, or that script has to read it from `.env`. Decide
  this before changing anything.
- **Home:** `server/env.ts` — `ORCA_SECRETS`, `scrubbedEnv(extra?, {keep?})`; `agentEnv` = scrubbed
  + `WORKER_BIN` on PATH.

### 2. Test DOM scaffolding repeated in ~52 component tests
*Size: ~475-525 lines. Bug risk: low-medium (flaky-test drift). Changes: every UI PR adds one.*

- Repeated in each file:
  - `IS_REACT_ACT_ENVIRONMENT` (52 files)
  - `beforeAll(() => store.configReady)` (55)
  - `flush` (47)
  - `root`/`container` + `mount()` (41)
  - an `afterEach` that unmounts and removes (54)
  - `apiFake.reset()` (53)
  - `localStorage.clear()` (42)
  - `navigate("/")` + `act(store.refresh)` (36)
- Representative copies: `tests/header.test.tsx:13-46`, `autoMergeBadge.test.tsx:10-36`,
  `usageMeter.test.tsx:14-43`, `addNewDialog.test.tsx:11-42`, `previewPlacement.test.tsx:8-22`.
- A `click` helper is redefined in 25 files, and the copies differ:
  - 5 flush once instead of twice: `header:52`, `optimisticFollowUp:38`, `prOverview:93`, `notificationCentre:76`, `usageMeter:267,342`.
  - 4 use `el.click()`: `addNewDialog:34`, `mobile:197`, `orchestratorFocus:46`, `quickAsk:42`.

  These differences are a likely source of the suite's load-dependent flakes.
- What else differs between copies: whether `<App/>` or a node is mounted, sync vs async `act`, and per-file atom resets
  (`sidebarCollapsedAtom` ×4, `repoFilterAtom`, …).
- **Home:** new `tests/dom.tsx`.
  - `setupDomTest({ app?, path?, resetAtoms?, refreshStore? })` registers the hooks and returns `mount`.
  - `flush`.
  - `click(el, { flushes = 2 })`.

### 3. The board is assembled twice, and the agent verbs are implemented twice (browser vs server)
*Size: ~160-180 lines. Bug risk: high (live drift). Changes: very often. Risk of the change: medium-high.*

- **Board assembly**, written twice:
  - `web/src/store.ts:399-406, 504-511, 603-665` (`worktreesByBranch`, `laneFor`, `assembleRows`).
  - `server/orchestrator.ts:379-422` (`board()`, what the orchestrator reads).
- **Drift: titles (verified).** `orchestrator.ts:414` takes `pr?.title ?? e.title`, so the PR title wins. The
  browser's `rowTitle(e.title, pr?.title, branch)` (`store.ts:420, 635`), which is documented as "the
  ONE place this is decided", lets the card title win. The orchestrator and the user therefore see different
  titles for a renamed card. Activity input and remote/inventory merging also differ.
- **Verbs**, written twice. `verbs.ts:7-9` admits this:

  | Verb | Browser | Server |
  |---|---|---|
  | `providerFor` | `store.ts:760-764` | `verbs.ts:133-137` |
  | `createWorkstream` | `store.ts:674-710` | `verbs.ts:140-162` |
  | follow-up | `store.ts:981-1036` | `verbs.ts:164-188` |
  | `addressPr` | `store.ts:1142-1178` | `verbs.ts:249-283` |

  Drift between the copies:
  - `providerFor`: the browser checks installed providers; the server checks the repo allow-list.
  - `addressPr` "blocked": the browser includes `mergeClean === "conflict"`; the server checks only `mergeable === "CONFLICTING"`.
  - Copied verbatim in both: `.slice(-100)` of handed thread ids, the `evidenceChars` sum, and `commentsSeenAt`.
- **Default model drift (verified).**
  - The browser's `defaultModelFor` (`store.ts:767`) falls back to `defaultModelOf("claude")`, which is Fable, and always sends it.
  - The server's `runModel` (`verbs.ts:26-27`) returns `undefined` when nothing is pinned, so the CLI default applies.
  - Result: an unpinned run started in the browser runs on Fable, but the same run started by the orchestrator or server does not.
  - `ORCHESTRATOR_DEFAULT_MODEL` is defined twice: `server/orchestrator.ts:73` and `web/src/components/Terminal.tsx:148` **(verified)**.
  - `MODEL_LADDER` (`workstream.ts:994-999`) restates four ids from `shared/models.ts`.
- **Home:**
  - `shared/board.ts`: a pure `assembleBoard(...)` used by both sides.
  - `shared/models.ts`: `DEFAULT_MODEL`, `ORCHESTRATOR_DEFAULT_MODEL`, `resolveModel(pin, repo, app)`.
  - The verbs' pure parts (hand-over merge, evidence plan) move to `shared/`. The browser keeps only its optimistic/Undo glue.
- Fix the title and model drift first, deliberately (decide which semantics are right), then dedupe.

### 4. Test server harness: fake CLIs, DB/env save-restore, bridge boot, polling, fixtures
*Size: ~350-400 lines. Bug risk: low-medium. Changes: every server feature adds a test.*

- **Postgres + env per test, 23 files.** Every file does `freshSchema` → set `ORCA_DATABASE_URL` → `db.close()`, then restores the env.
  - Three restore idioms: a `prev` object loop (13 files), `prevDbUrl` (7), a `saved` array (2).
  - `previewBridge.test.ts:15-30` and `previewInventory.test.ts:15-30` are identical except for keys and label.
  - `tests/pg.ts` creates the schema but does none of the rest.
- **Fake provider CLIs on PATH, 22 files.**
  - A fake `claude` appears in 15 files; `fakeClaude()` is defined in 4 of them.
  - `compact.test.ts:20-82` and `orchestrator.test.ts:31-77` differ by one `case`.
  - A fake `hydra` in 3 files: `hydraUsage:24-41`, `usageProfile:17-60`, `usageMerge:103-126`.
  - An identical `systemctl` shim in `cgroup:90` and `oom:68`.
  - `helpers.ts` already has the pattern (`installFakeGh`, `installFakeDocker`, `restorePath`), but no generic version.
- **Booting a real bridge: 4-5 copies.**
  - `compactRouting.test.ts:29-79` ≈ `attachmentsRelay.test.ts:29-75`: the same `bridge()` function, two-instance config and teardown.
  - Also `primaryBridge:28-49`, `queueBusyAgent:61-73`, `degradedMode:140-150`.
- **"Wait until" loops:** 50 sites in 25 files. Only 4 named local variants: `until`, `waitForLog`, `finished`, `settled`.
- **Fixtures:**
  - `pr(over)` ×6 with different defaults: `number` 1/7, `ciStatus` none/passing, `reviewStatus` four ways.
  - A `Row` base literal in 15+ files. It is identical in `chatPanel:30`, `chatMarkdownBold:30` and `messageQuote:92`.
- **Bare origin + clone, 3 files:** `cleanup:38-45`, `moveWorkstream:25-32`, `changelogConflict`.
- **Home:**
  - `tests/pg.ts`: `useTestDb(label, {scope, flushAgent})`.
  - `tests/helpers.ts`: `saveEnv(keys)`, `installShim`, `fakeClaude({...})`, `installFakeHydra`, `eventually(fn, {ms, step})`, `makeOriginAndClone`.
  - `tests/bridge.ts`: `startBridge`, `twoBridgeHarness`.
  - `tests/fixtures.ts`: `openPr`, `localRow`, `reviewRow`, `hydraProfile`.

### 5. Process plumbing: run-with-timeout ×12, `ps`/cwd/lsof helpers that drifted
*Size: ~90-110 lines. Bug risk: high (two live drift bugs). Risk of the change: low.*

- **`agent.detectRunning` still matches branches by argv substring (verified).**
  - Where: `agent.ts:996-1010`, `lines.some((l) => l.includes(b))`.
  - Its sibling `killInWorktree` (`agent.ts:974-993`) was moved to cwd matching precisely because the orchestrator's `claude -p` argv contains the whole board (incident 2026-10-13).
  - Consequence: while the orchestrator is mid-wake, `/api/agents` (`index.ts:394`) can report every idle branch named in its prompt as running. A branch name that is a substring of another branch's run is also caught.
- **Preview re-adoption uses a weaker copy of "process cwd".**
  - Where: `preview.ts:78-85` `listenerCwd` is lsof-only, and `reattach` (`:100`) tests `cwd.startsWith(key)`.
  - Consequence 1: `/wt/foo` adopts `/wt/foo-bar`'s server.
  - Consequence 2: on Linux without lsof, nothing is re-adopted.
  - The canonical version is `agent.ts:961-972` `processCwd` (`/proc` first) plus `cwdInWorktree`.
  - The `lsof -ti tcp:P -sTCP:LISTEN` lookup appears 3 times: `net.ts:29`, `preview.ts:80,126`.
  - `ps` scans: `agent.ts:982,999`, `lease.ts:40`, `net.ts:31`.
- **Spawn, collect output, timeout, throw on nonzero**, written ~12 times:
  - `run.ts:3-16` (no timeout option).
  - `pushTemplate.ts:72-77`, a second `run` with env/stdin (verified).
  - `previewdb.ts:27-32` `psql`, `check.ts:15-18`, `agent.ts:797-802`, `cgroup.ts:93-95`.
  - `usage.ts:202, 224, 247, 320, 335, 427, 476`.

  How the copies differ:
  - Error text formats differ.
  - `usage.ts:427` (macOS `security`) and `:476` (codex app-server) omit `env: process.env`, the PATH-snapshot trap `run.ts:4` warns about. So `codexUsage` checks the live PATH with `Bun.which` and then spawns with the startup PATH.
  - `security` has no timeout and can hang the usage poll.
- **psql connection env from a repo `.env`**, built twice: `previewdb.ts:14-24` and `pushTemplate.ts:103-113` **(verified)**.
  - Drift: `previewdb` reads `vars.get(k)?.value` and `pushTemplate` reads `?.value || undefined`. An empty `DB_HOST=` therefore gives `PGHOST=""` in one and `localhost` in the other.
  - `parseEnv` lives in `pushTemplate.ts` and `previewdb` imports it from there.
- **NDJSON line reader ×3** in `agent.ts`: `223-248` (codex), `255-276` (cursor), `416-458` (claude).
  - More copies: `usage.ts:485-501`, `bin/worker/orca-shot:82-103`.
  - None of the agent copies flush a final line that has no trailing newline. orca-shot does.
- **Home:**
  - `server/run.ts`: `run(cmd, {cwd, env, timeoutMs, stdin, allowFail}) → {stdout, stderr, code}`, with today's `run` as a wrapper.
  - `server/proc.ts`: `listenerPids(port)`, `processCwd(pid)`, `cwdInWorktree`, `headlessAgents()`.
  - `server/previewdb.ts`: owns `parseEnv` + `pgEnv` + `psql`.
  - A small `lines(stream)` async generator.

### 6. Wire types re-declared in `web/src`, with drift
*Size: ~100-120 lines. Bug risk: medium (optional-vs-required mismatches hide missing fields). Risk: low (types).*

| Web copy | Server original | Drift |
|---|---|---|
| `InstanceHealth` `api.ts:47-59` | `Health` `health.ts:11-25` | `runningAgents` optional vs required; `rate`/`month` inlined (verified identical shape otherwise) |
| `MonthCostInfo` `workstream.ts:2443` | `MonthCost` `health.ts:197-205` | third copy; optionality differs |
| `MetricPoint` `api.ts:61-64`, `VitalSample` `workstream.ts:2330` | `db.ts:1467-1471` | `runningAgents` optional |
| `PreviewSvc` `api.ts:65` | `preview.ts:61` `SvcStatus` | identical |
| `QueuedMessage` `api.ts:43` | `db.ts:1609-1612` | web drops `worktreePath`, `provider` |
| `TurnPage` `api.ts:41` | `db.ts:1169` | web adds `dbUnavailable`; `asTurnPage` (`workstream.ts:2797`) a third shape |
| `Window`/`ClaudeReading`/`UsageReading` `workstream.ts:2144-2175` | `usage.ts:13-42` | missing `durationMinutes`, `bin`, `fetchedAt` — while `api.ts:5` imports the server `Usage` anyway |
| `CheckRow`, `PrComment`, `PrReview`, `PrStatusLike` (`workstream.ts:2994, 3037-3038, 39-44`) | `gh.ts:437, 426-427, 32-37` | identical |
| orchestrator status `api.ts:154`, `Terminal.tsx:182` | `orchestrator.ts:90` | web drops `notes`/`shell`, `queued` optional |
| `Enrichment` `store.ts:121-133` | server casts `db.Fields` (`verbs.ts:262-264`, `upkeep.ts:81`, `orchestrator.ts:59`) | server writes `failStreak`, `cleanupBlocked`, `upkeepOff` the web type lacks |
| `LiveAgent` `api.ts:10-34`, `BridgeInfo` `workstream.ts:3104`, config `api.ts:76-84` | untyped handlers `index.ts:395-412, 272, 667-697` | nothing checks the shape |

The enrichment key `` `${repo}::${branch}` `` is also built in 9 places: `store.ts:68,142,609,626`,
`lib/events.ts:63,90`, `CommandPalette.tsx:53`, `Chat.tsx:896`, `WorkstreamActions.tsx:35`.
`lib/events.ts:61-71` casts event payloads to an inline shape instead of importing `BusEvent`
(`server/bus.ts:18-26`).
**Home:** `shared/api.ts` (response types; annotate server handlers against them),
`shared/enrichment.ts` (`Enrichment`, `branchKey()`).

### 7. Native `<dialog>` shell ×7, and popovers that are probably dead inside one of them
*Size: ~60-80 lines. Bug risk: medium (likely a live bug). Risk: low-medium.*

- The same `showModal`/`close` effect, the same `onClose`/`onCancel`/backdrop-click handling, and the same `bg-card … shadow-modal backdrop:bg-black/50` styling appear in:
  - `Terminal.tsx:28-63` (`TerminalDialog`)
  - `Board.tsx:410-426` (`NewChatDialog`)
  - `WorkstreamActions.tsx:346-378` (`RenameDialog`)
  - `CommandPalette.tsx:101-134` (palette)
  - `CommandPalette.tsx:167-184` (shortcuts)
  - `Shell.tsx:320-353` (`AddNew`)
  - `BottomSheet.tsx:18-67`
- How the copies drift:
  - A ref vs state for the element.
  - Only `BottomSheet` calls `preventDefault` on cancel.
  - Swipe-to-close is only in two of them.
  - Five different widths.
- **Probable bug (verified by reading, not reproduced):**
  - Only `AddNew` (`Shell.tsx:352`) and `BottomSheet` (`:59`) provide `PortalContainer` for the dialog.
  - `TerminalDialog` renders `ChatPanel` → `ChatControls` → the Radix `ModelPicker` `Select` and the context `Popover`. Those portal to `<body>`, which is inert while a modal is open, so the card terminal's model picker and Compact popover likely can't be used.
- **Home:** `components/ui/modal.tsx`: `<Modal open onClose size sheet swipe>`, which always provides `PortalContainer`.
- `TerminalDialog` overlaps the chat-transcript work, so migrate it last.

### 8. Peer HTTP: five POST-to-peer callers with no probe and no timeout; two proxies that drifted
*Size: ~55 lines. Bug risk: medium-high (hangs). Risk: low.*

- **Five callers repeat `fetch(new URL(path, base), {method:"POST", …})` + `res.json().catch(() => ({}))` + `error ?? answered ${status}`:**
  - `orchestrator.ts:229` (`report`)
  - `orchestrator.ts:430-437` (`viaInstance`)
  - `verbs.ts:350-355` (`moveWorkstream`)
  - `verbs.ts:528-533` (`sweepAll`)
  - `usage.ts:271-274`
- None of them calls `peer.reachable`, so a sleeping laptop black-holes them for over a minute, which is what `peer.ts` exists to prevent.
  - Example: `orca move` hangs *after* `verbs.ts:348` has already removed the worktree.
  - The "not a configured instance" message is copied in `orchestrator.ts:432` and `verbs.ts:343`.
- **Two copies of "proxy the request to its owner":** `forwardToOwner` (`index.ts:326-377`) and the orchestrator proxy (`index.ts:498-509`).
  - Drift: the unreachable message uses `repo.runsOn` (`:375`) where the rest of the function uses `home`, so a workstream placed elsewhere reports "undefined is unreachable".
  - The orchestrator copy sends a body for `HEAD`.
  - Neither calls `peer.markDown` (`usage.ts:169` does).
- **Home:** `server/peer.ts`, with `postPeer(cfg, instance, path, body, {timeoutMs})` and `proxyTo(...)`.

### 9. Display primitives that render one fact several ways
*Size: ~150 lines across many small items. Bug risk: medium (visible inconsistency). Changes: often.*

- **Agent status in two vocabularies.**
  - The board's `AgentBadge`/`ConditionBadges` (`Board.tsx:298-325`, using `ui/badge`) say *Completed / Done / Verified*.
  - The list's `TONE_LABEL` (`Agents.tsx:343-344`, using `console` `Pill`, also used by `AgentPage.tsx:96-99`) says *Idle / Ready / Needs you* for the same row.
  - `PrDetail.tsx:109-120` is an inline third copy. It has no "Checking…" and orders "Auto-merge" differently.
  - `Badge` and `Pill` are two overlapping badge primitives (`ui/badge.tsx:11-17` vs `console.tsx:67-87`, with different tints).
  - Conflicts appear as three different chips.
- **Clipboard ×13 with three failure behaviours.**
  - `prompt()` fallback: `WorkstreamActions.tsx:149-163`, `Board.tsx:162, 234-243`, `Notifications.tsx:76-78`.
  - Silent catch: `Chat.tsx:195-199`, `PreviewControl.tsx:92-95, 324-327`.
  - No catch at all, and it shows ✓ anyway: `Board.tsx:108-114`.
  - "Copy worktree name" copies the branch (`Board.tsx:253`); "Copy worktree" copies the path (`WorkstreamActions.tsx:149`).
- **Time formatters.**
  - `Board.tsx:284-290` `timeAgo` stops at hours, so it shows "merged 72h ago" where `ago()` (`workstream.ts:1884-1892`) shows "3d ago" **(verified)**.
  - Elapsed time is formatted 4 ways: `Board.tsx:292-296` "3m 5s" (doesn't tick), `formatElapsed` "3:05", the orchestrator's `formatDuration`, and the preview's "12s".
  - Clock times use mixed locales (en-GB vs default): `Chat.tsx:264, 315`, `console.tsx:168`, `Agents.tsx:517`, `workstream.ts:2484`.
  - `dayLabel` (`workstream.ts:1606-1611`) vs `groupByDay` (`shared/notifications.ts:183`).
- **Smaller items:**
  - Diffstat is drawn 5 ways in 3 colour schemes: `Board.tsx:265-273`, `Agents.tsx:325-332`, `AgentPage.tsx:61`, `LocalDetail.tsx:66`, `PrDetail.tsx:151, 262`.
  - The PR link is drawn 6 ways, and `Agents.tsx:488` re-inlines the `prLink` it defines at `:418`.
  - The model label is drawn 3 ways: `AgentPage.tsx:26` "Claude · Opus 5.5" before a run, `modelBadge` "Opus 5.5".
  - Preview link: `AgentPage.tsx:29` renders it twice in one card.
  - Repo tag: drawn 4 ways.
  - Board instance chip: `Board.tsx:499-503` re-implements `rowInstance`.
  - Detail path: `Board.tsx:479-481` `titleTo` doesn't exclude `opt-` branches the way `Agents.tsx:347-351` `detailPath` does.
- **Home:**
  - `components/console.tsx`: `StatusBadge`, `ConditionBadges`, `Diffstat`, `PrLink`, `RepoTag`. Fold `Pill` into a `Badge` variant.
  - `lib/clipboard.ts`: `copyText` and `useCopied`.
  - `shared/time.ts`: `ago`, `clock`, `formatSpan`.
  - `lib/route.ts`: `detailPath(row, tab?)`.

### 10. Shared polling sources reimplemented per component
*Size: ~100 lines + far fewer requests. Bug risk: medium. Risk: medium.*

- **Preview lifecycle, twice.**
  - Copies: `PreviewControl.tsx:22-85` `usePreview` and `store.ts:909-976` (`pollMaster`/`startMaster`/`stopMaster`). The crash→reap algorithm is the same in both.
  - Drift: the master copy calls `api.previewStatus(key)` / `previewStop(key)` with no instance (`store.ts:944, 975`), while rows pass `placementOf(key)`. On two instances, a "Test master" preview may be polled and stopped on the wrong host.
  - Every mounted `PreviewCell`/`PreviewControl`/`PreviewPanel` polls its key every 2.5s. An agent page runs three polls for one key, beside the shared `/api/previews` poll.
  - The 1s elapsed ticker appears 3 times (`PreviewControl.tsx:74-82, 347-356`), and none uses `lib/ticker.ts` `useNow`. `usePreview`'s `elapsed` has no reader, so it causes a pointless 1Hz re-render.
  - `ErrorLog` vs `LogPopover`: `PreviewControl.tsx:90-107` vs `322-343`.
- **`useSummary`** (`Board.tsx:427-441`) is per-instance, although `Agents.tsx:388` says it is shared.
  - The card, the row, `PrDetail` and `LocalDetail` each poll it every 8s.
  - `LocalDetail.tsx:26-31` re-implements it without `base`.
- **Orchestrator status:** `useOrchestratorState` (`Terminal.tsx:183-207`) is mounted separately by the panel, the page and `QuickAsk`, so up to three 2s polls run at once. `useOrchestratorActivity` is a fourth reader. This is in `Terminal.tsx`, so it lands after the chat fix.
- **`usageSource`** (`lib/vitals.ts:55-77`) re-implements `poll`, without the hidden-tab skip.
  - There are three "refetch now" mechanisms: `refreshUsageNow`, `loaders`, and `PreviewControl.tsx:420` `reloadPreviews`.
  - `api.ts:67-68` `post`, `api.ts:212` upload and `Freshness.tsx:59` bypass `trackedFetch`, so Refresh everything can't see them.
- **Home:** move `sharedSource` out of `lib/vitals.ts:12` into `lib/source.ts`, add keyed sources and `reload()`, and make preview state and the summary keyed sources.

### 11. Config field list written 5 times; seeding drops fields
*Size: ~35 lines. Bug risk: medium. Risk: low.*

- `config.ts:403-421` (`seedFromFile`), `:500-520` (`saveConfigDocument`), `:345-357`, `:476-489`, plus the type.
- `seedFromFile` omits `instances` and `instanceHourlyUsd`/`instanceBillingSince`, which `saveConfigDocument` copies **(verified)**. A fresh database seeded from `orca.config.ts` therefore loses its instance map, and with it cross-instance routing.
- The defaults `[30000, 40000]` / `24` appear twice. The repo `templatePath` mapping appears twice (`:393-400`, `:493-500`).
- The `mergePolicy` key list (`:276`) is a hand copy of the `MergePolicy` type.
- **Home:** `APP_KEYS` + `pickDefined`, `toStoredRepos()`, `DEFAULT_PORT_RANGE` / `DEFAULT_STALE_HOURS`.

### 12. `scripts/preview-gc.ts` re-implements the server's preview reaper and has drifted
*Size: ~60 of 87 lines. Bug risk: high (data loss). Risk: medium.*

How it differs from the server's reaper:
- It has no 2-hour grace period **(verified: no `GRACE` in the file)**, so it can drop a database that is mid-clone.
- Its "live" set is one repo's worktrees, not all repos' plus tracked previews.
- `repoOf` silently falls back to `repos[0]`. `--drop` without `--repo` makes the repo name `args[0]`.
- It has its own `.env` regex.
- It requires `PGPASSWORD`.
- It runs a raw `DROP DATABASE` instead of `preview-db.sh drop`.

**Home:** a thin CLI over `preview.reap(repos, {dryRun})` (`server/preview.ts:304-351`, `previewdb.ts`).

### 13. PR "blocked / needs attention" decided ~9 ways
*Size: ~30 lines. Bug risk: medium. Risk: medium (pick the intended semantics first).*

- The copies:
  - `followBlockers` `workstream.ts:801-810`
  - `upkeepReasons` `1328-1334`
  - `attentionReasons` `1731-1744`
  - `quickActions` `3225-3226`
  - `BULK_ELIGIBLE` `185, 216`
  - `store.ts:1145`
  - `verbs.ts:254-256`
  - `shared/notifications.ts:151-168`
  - `boardText` `1450`
- Merge drift: the bulk `merge` rule allows pending CI (`ciStatus !== "failing"`), while `mergeSafe` (`61-63`) requires passing or none. `/api/merge` (`index.ts:829-832`) writes its own refusal text, separate from `mergeVerdict` (`1251-1260`).
- **Home:** `shared/pr.ts`, with `isConflicting`, `prBlockers(pr, {...})` and one merge-refusal reason.

### 14. Smaller server items (each low risk)

- **`index.ts` route boilerplate:**
  - The provider guard appears ×5 (`736-738, 756-758, 954-956, 980-982, 1023-1025`).
  - Queue-or-409 appears ×2, and the copies differ (`957-969` checks `worktreePath`, `983-996` checks `key`).
  - `e instanceof Error ? e.message : String(e)` appears 16× in `server/` and 14× in `web/src`.
  - ~50 lines.
- **`db.ts` mappers and upserts:**
  - `QueuedMessage` mapper ×2 (`1635-1638`, `1669-1673`), `Conversation` head ×2 (`1248`, `1267`), inventory row ×2 (`1413`, `1443`).
  - The upsert-then-sweep transaction ×2 (`1378-1403`, `1419-1435`). The `app_config` upsert ×2.
  - 30-day retention is written 4 ways.
  - `health.ts:121-124` caps history at 30 days, against a 32-day `METRIC_RETENTION_MS` (`db.ts:1475`).
  - ~30 lines.
- **Leases:** the directory scan is written ×4 (`lease.ts:81-128`); `outbox.ts:216-221` has the same shape. `state.ts:35-41` re-does atomic write. Home: `readJsonDir` / `writeAtomicSync` in `state.ts`. ~30 lines.
- **gh TTL + in-flight caches ×4** (`gh.ts:344-364, 389-412, 502-520, 545-560`) with different failure behaviour: merged/closed drop good rows on one gh blip. Home: a `swrCache`. ~40 lines; medium risk.
- **State dir and database URL defaults** recomputed in several places:
  - `scripts/import-*.ts:16-18` and `lease.ts`/`outbox.ts` joins.
  - `preview.ts:66` keeps its registry in `tmpdir()`, shared across instances on one host and written non-atomically.
  - The database URL default appears in `db.ts:45`, `primary.ts:70` and `scripts/db-check.ts:7`, along with the connect timeout.
- **"Am I a worktree?" ×2** with different overrides: `db.ts:827-829` (a `.git` file) vs `primary.ts:31-35` (a `/.worktrees/` regex).
- **Timeout race ×4:** `usage.ts:165-169, 450-453`, `health.ts:265-272`, `peer.ts:20-27`.
- **`Bun.which` with the live PATH** ×6 in `usage.ts`, plus its hydra preamble ×2 (`242-247`, `354-359`).
- **The bridge URL** in `bin/orca:26`, `bin/worker/orca-shot:59` and `orchestrator.ts:363`. The arg parsers differ on purpose, so leave them.
- **git outside `git.ts`:** `primary.ts:133`, `index.ts:271`, `agent.ts:759-761`.

### 15. Smaller cross-layer / web items (each low risk)

- **Attachment reference format ×2.**
  - Copies: `server/attachments.ts:13-34` and `workstream.ts:564-585`. The header appears a third time in `SCAFFOLDING`.
  - Drift: they dedupe by ref vs by id. Home: `shared/attachments.ts`.
- **Glob matchers ×2:** `workstream.ts:732-743` vs `1195-1204`. Only one strips `./` and treats a bare name as a directory.
- **Text clipping ×7:**
  - `clip` is identical in `workstream.ts:1144` and `orchestrator.ts:440`.
  - `oneLine` exists twice (with and without an ellipsis).
  - Also `firstLine`, `truncate`, `bounded`.
- **Bot detection ×4:**
  - `gh.ts:45` `botLogin`, `gh.ts:267, 297` (`isOther` defined twice), `workstream.ts:1903-1907`, `gh.ts:157`.
  - Drift: a `github-actions` comment counts as human feedback in one copy and as a bot in another.
- **Tool-subject extraction ×3:** `shared/agent.ts` `activityLines`, `steps.ts:15-17`, `workstream.ts:1073`. Cursor's `filePath` is missing from hand-off activity lines.
- **Lane vocabulary ×2:**
  - `store.Lane` = `OverviewLane`.
  - The board titles "In Review" / "Done · today" vs `LANE_LABELS` "In review" / "Done today".
  - The legacy `WorkstreamState` / `deriveKanbanState` survives only through `Pick<>`.
- **Upkeep guards ×2:** `upkeep.ts:88` re-lists a subset of `upkeepDecision`'s guards.
- **Duplication inside `workstream.ts`:**
  - The merge-when-green note appears ×2 (`365`, `389`).
  - Three Slack builders rebuild the same label (`307-350`).
  - Five "label + `- item`" outcome renderers.
  - `splitMessages(t.instruction ?? promptInstruction(...))` appears ×4.
  - `recentActivity`'s turn status (`1876`) vs `turnStatus` (`orchestrator.ts:442`): a failed turn with no `finishedAt` reads as failed in one and running in the other.
  - The `ListFilter.state` / `.attention` fields are dead.
- **Web plumbing:**
  - The async idle→loading→done/error machine is hand-rolled ×5: `Vitals.tsx:155-172, 200-224`, `Shell.tsx:378-394`, `WorkstreamActions.tsx:120-131` (canonical: `ActionButton.tsx:36-52`).
  - `notifyLocal({kind:"action_failed"…})` is built by hand ×3.
  - The undo-after-send toast ×2: `Shell.tsx:333-369`, `Board.tsx:342-347`.
  - `reducedMotion()` ×2: `BottomSheet.tsx:16`, `QuickAsk.tsx:37`.
  - Raw `localStorage` and `atomWithStorage` bypass `lib/persisted.ts`: `Terminal.tsx:446-459` PiP, `lib/theme.ts`, `lib/atoms.ts:7, 64-70`, `lib/composerDraft.ts`.
- **`PrDetail` / `LocalDetail` tab scaffold** (the jscpd hit `PrDetail.tsx:174-183` / `LocalDetail.tsx:91-101`), plus a **stale-diff bug (verified by reading):**
  - `App.tsx:50-51` doesn't key these pages, and `diff` (`PrDetail.tsx:54, 79-81`; `LocalDetail.tsx:21, 33-35`) is loaded only while `null` and is never reset when `repo`/`number`/`branch` change.
  - Result: going from PR #1's Files tab to PR #2's still shows #1's diff.
  - Home: a `useDiff` hook keyed by identity and a shared `<DetailTabs>`.

---

## Workstreams (each independently mergeable, no overlapping files)

| WS | Findings | Files it owns | Est. lines saved |
|---|---|---|---|
| **A. Server env & processes** | 1, 5, 12, 14 (state-dir/registry, `which`, timeout race) | new `server/env.ts`, `server/proc.ts`; `run.ts`, `agent.ts`, `usage.ts`, `preview.ts`, `check.ts`, `screenshot.ts`, `pushTemplate.ts`, `previewdb.ts`, `net.ts`, `lease.ts`, `state.ts`, `outbox.ts`, `cgroup.ts`, `scripts/preview-gc.ts`, `scripts/import-*.ts` | ~250 |
| **B. Peer, routes, config, db** | 8 (helpers + `index.ts` proxies), 11, 14 (route boilerplate, db mappers, db URL, worktree detection, gh caches) | `peer.ts`, `index.ts`, `config.ts`, `db.ts`, `primary.ts`, `gh.ts`, `scripts/db-check.ts` | ~230 |
| **C. Shared domain layer** | 3, 6, 13, 15 (attachments, globs, clip, bots, tool subject, lanes, `workstream.ts` internals) | new `shared/{board,api,enrichment,pr,attachments,text}.ts`, `shared/models.ts`; `store.ts`, `api.ts`, `workstream.ts`, `orchestrator.ts`, `verbs.ts`, `upkeep.ts`, `attachments.ts`, `steps.ts`, `health.ts` (type move + the 30-vs-32-day history cap), `lib/events.ts` | ~400 |
| **D. Web display primitives & modals** | 7 (except `TerminalDialog`), 9, 15 (detail tabs + stale diff, `useAction`, undo, `reducedMotion`) | new `components/ui/modal.tsx`, `lib/clipboard.ts`, `lib/route.ts`; `console.tsx`, `ui/badge.tsx`, `Board.tsx`, `Agents.tsx`, `AgentPage.tsx`, `PrDetail.tsx`, `LocalDetail.tsx`, `WorkstreamActions.tsx`, `CommandPalette.tsx`, `Shell.tsx`, `BottomSheet.tsx`, `Notifications.tsx`, `Vitals.tsx`, `Pages.tsx`, `App.tsx` | ~300 |
| **E. Web shared sources** | 10 (minus master preview + orchestrator hooks), 15 (localStorage) | new `lib/source.ts`; `lib/vitals.ts`, `PreviewControl.tsx`, `Freshness.tsx`, `lib/theme.ts`, `lib/atoms.ts`, `lib/composerDraft.ts`, `QuickAsk.tsx` | ~120 |
| **F. Test DOM scaffold** | 2, plus the `Row`/`pr` fixtures used by `.tsx` tests | new `tests/dom.tsx`, `tests/fixtures.ts`; `tests/*.test.tsx` | ~550 |
| **G. Test server harness** | 4 | new `tests/bridge.ts`; `tests/helpers.ts`, `tests/pg.ts`; `tests/*.test.ts` | ~350 |

Cross-workstream notes:

- **File ownership is strict.** A shared helper is introduced by ONE workstream; callers that sit in
  another workstream's files switch over there (or in a short follow-up). C adds `branchKey()` and converts `store.ts`/`lib/events.ts`;
  D converts `CommandPalette.tsx` / `WorkstreamActions.tsx`, and `Chat.tsx` waits for the chat fix.
  C keeps `api.ts`'s exported type names (re-exported from `shared/api.ts`), so D's/E's views need no
  edits. D uses the existing `ago` / `formatElapsed` from `workstream.ts` in its views (deleting
  `Board.tsx`'s `timeAgo`/`elapsed`); moving them to `shared/time.ts` belongs to C.

- **The peer callers in A and C.** B adds `postPeer`/`proxyTo` in `peer.ts` and converts the `index.ts` proxies. The callers in `usage.ts` (A) and in `orchestrator.ts`/`verbs.ts` (C) switch over in their own workstream, or in a 10-line follow-up once B is merged.
- **`Board.tsx`'s `useSummary` and the store's master preview** (finding 10) touch D's and C's files. Do them inside D and C respectively, or after both land.
- **After the chat-transcript fix:** the `TerminalDialog` modal migration (7), the orchestrator status hooks and `ORCHESTRATOR_DEFAULT_MODEL` in `Terminal.tsx` (3/10), and the PiP localStorage key.
- **Order by value and risk:**
  1. A (security + two drift bugs, low risk).
  2. B and F/G in parallel (mechanical).
  3. D.
  4. C, which needs product decisions on title, default-model and blocker semantics, so settle those in the brief first.
  5. E.

## Not duplicated (checked)

- These constants each have a single definition: `ORCHESTRATOR_REPO`/`@orca`, `ORCHESTRATOR_BRANCH`, `AUTOFIX_MARKER`, `MESSAGE_BREAK`, `[worker finished]`, `NOTIFICATION_KINDS`, and the `<started_at>~<id>` turn cursor (`db.ts` only; the client treats it opaquely).
- gh is called only through `gh.ts:39`.
- `bin/orca` is a 36-line relay.
- `scripts/supervise.ts` and `scripts/dev.ts` own their logic.
