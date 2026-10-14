# Scaling Orca: what the industry runs, what it measured, and what Orca's data says

*Research report for Finn, 2026-10-14, revised the same day to weight it toward industry evidence, then reviewed (Fable 5.1, same day): every quantitative claim was re-checked against its cited source, and the Orca figures were re-run against the database. Published sources were fetched today; anything not confirmed from a primary source is marked **unverified**. Orca data: `/opt/orca` (main @ 09c80aa), the shared Postgres (read-only transaction) and `~/.orca/ledger.json` on the cloud box. No code, config or data was changed.*

**Review note.** Two material corrections: §5.2's per-model, per-action and per-workstream dollar figures had been priced at 5-minute cache-write rates while the totals used 1-hour rates (they are now all 1-hour, 15–25% higher than first stated, e.g. the median workstream is $4.35 not $3.66); and the "load 58" peak cited as agent load came from a sample with no agents running (with agents, load peaked at ~15). The rest were wording: a few quotes that were paraphrases, Google's study cited at its v2 figures where v3 differs, and Anthropic's harness post (context resets went with Opus 4.5, not 4.6). Each is marked in place.

**How to read it:**
- §1 covers what each lab and company actually runs, with their own numbers.
- §2 compares the architectures that exist.
- §3 and §4 answer your two questions against that evidence.
- §5 and §6 cover Orca's own measurements and its cost model. These are secondary.
- §7 gives the recommendations.

## Executive summary

1. **The industry has converged on one shape, and Orca already has it.** That shape is one coordinator; workers that each write to one branch in isolation (VM, container or worktree); state kept outside the model (git, task files, ledgers); and an independent verifier before a human sees the work. Codex cloud, Copilot coding agent, Jules, Devin ("manages Devins"), Cursor background agents, Factory Missions and Anthropic's long-running harnesses all fit it. Cognition's 10-month verdict: multi-agent works when **"writes stay single-threaded and additional agents contribute intelligence rather than actions."** Orca's gaps are **verification** and **structured state**, not the number of orchestrators.

2. **No published measurement supports multiple orchestrators each running a team (your architecture A).**
   - In Google's controlled study, every multi-agent topology did **worse than a single agent on SWE-bench Verified** (−2% to −15%). Coordination returns go **negative once a single agent passes ~45%**, and the hierarchical/hybrid variant cost **+515%** tokens.
   - Claude Code agent teams forbid nesting.
   - The one success at scale is Cursor's research harness: recursive planners → sub-planners → workers, with **hundreds of agents** and ~**1,000 commits/h**. It was greenfield, and they had to accept a steady error rate and remove the central integrator. Repo-partitioned peer leads are defensible; an LLM orchestrator-of-orchestrators is not, yet.

3. **Flat peer swarms that coordinate through shared state fail on code.**
   - Cursor: with locks over a shared file, **20 agents ran at the throughput of 1–3**.
   - Anthropic's 16-agent C compiler had no orchestrator and worked until the agents converged on the same kernel bug ("16 agents running didn't help"). It recovered only when GCC was used as an oracle to cut the work into independently checkable pieces.
   - Parallelism pays off only along boundaries that can be tested independently.

4. **The best-evidenced addition is an independent reviewer or validator that shares no context with the coder.**

   | Who | What they measured |
   |---|---|
   | Devin Review | ~**2 bugs per Devin PR**, 58% severe |
   | OpenAI's Codex reviewer | >100k PRs/day; 52.7% of addressed comments lead to a code change; "verification can be cheaper than generation" |
   | Factory's validators | 81 issues on one mission; fixing them was **34%** of all implementation work |
   | Cursor Bugbot | resolution rate **52% → 70%+** after moving to an agentic reviewer |
   | Anthropic | a separate skeptical evaluator, because self-evaluators "confidently prais[e] the work" |
   | MAST | an objective-verification step gave **+15.6%** |

5. **Strong planner + cheap one-shot coder + strong reviewer (your architecture B): keep the reviewer, drop the cheap-coder premise.**
   - Aider's architect/editor pairs won by 3–5 points in 2024. By Nov 2025 they **lose to a strong solo model at equal cost** (o3 + gpt-4.1 78.2% vs o3 solo 81.3%).
   - Cognition's cheap fast primary (SWE-1.5) wasn't good enough at **knowing when to escalate** to the strong planner.
   - Anthropic's advisor pattern (Sonnet executor, Opus advisor) is the measured version that works: **+2.7 points at 11.9% lower cost** on SWE-bench Multilingual.
   - Factory and Cursor pick a model **per role** (Opus orchestrates, Sonnet/Opus implement, a GPT-Codex model validates).
   - On Orca's own tokens, plan → Sonnet → review costs about the same as Opus end to end (§6).

6. **Best-of-N with a judge lifts solve rates by +5 to +17 points, at roughly N× the cost, and selection is the bottleneck.**
   - Results: Anthropic 77.2 → 82.0, OpenHands 60.6 → 66.4 (N=5), R2E-Gym 34 → 51.
   - Even then the selected answer trails the best-of-N oracle by **12–19 points**.
   - A judge trained on benchmark data scored **worse than random** on real work (AUC 0.45). One trained on code survival needed only **1.35 attempts on average** with early stopping.
   - Augment and Bugbot both moved away from wide ensembles in production. Use it for hard tasks that have a cheap real check.

7. **The dominant product shape is an async background queue with human review, and the human is the bottleneck.**
   - Merge rates on GitHub:
     - Codex 65%, Claude Code 52%, Cursor 51%, Devin 49%, Copilot 38% (AIDev, popular repos).
     - Agentic 77% vs human 83% on closed PRs.
     - Devin 67% by its own count, up from 34%.
   - METR: 38% of agent PRs passed the maintainers' tests, but **0 of 15 were mergeable as-is** (~26 minutes of fixing each). Their RCT measured developers 19% *slower* with AI (2025); the 2026 update estimates ~18% faster for the original developers and ~4% for new ones, both with confidence intervals spanning zero.
   - Size the work in flight to review capacity, not to agent capacity.

8. **The harness and context matter as much as the model.** With the same model:
   - Factory's Droid beat Claude Code by **15 points** on Terminal-Bench (58.8% vs 43.2%).
   - Opus 4.5 scored **45.9–51.8%** on SWE-bench Pro depending on the harness.
   - Cursor: "The harness and models matter, but the prompts matter more."

   At Orca, **~90% of spend is context** (cache writes and reads), and CLAUDE.md is 97 KB.

9. **Orca's own data (secondary, §5–6).**
   - Volume: 474 runs ≈ $850 list-equivalent in 29.5 h.
   - **Correctness is not measured:** no `checkCommand` is set, and `turn.model`/cost are empty.
   - The orchestrator averaged **8.5 and peaked at 21** active workstreams per 2 h. Industry guidance is 3–5 per lead: Anthropic, agent teams, OpenHands ~5.
   - The 4-vCPU box saturates at 4 concurrent agents.
   - Typical workstream: $4.35 median; ≈ $11 at Opus list price for a typical shape including the orchestrator.

10. **Recommendations, in order (§7):**
    1. Measure correctness and cost.
    2. Fix the model ladder.
    3. Build a structured ask/state ledger.
    4. Add an independent review gate (cross-family where possible).
    5. Trim context.
    6. Cap work in progress per lead and admit runs by CPU.
    7. Write validation-contract briefs.
    8. Use best-of-N only on hard tasks that have a check.
    9. Add advisor-style escalation instead of a cheap-coder sandwich.
    10. Per-repo peer orchestrators only if asks still drop after (3) and (6).

---

## 1. What labs and companies actually run (their own numbers)

### 1.1 Frontier labs

**Anthropic**
- **Research system** (Opus lead + 3–5 parallel Sonnet subagents) [L1]:
  - **+90.2%** over single-agent Opus on their research eval.
  - ~**15×** chat tokens (single agents ~4×). Token use alone explained **80%** of BrowseComp variance.
  - Effort scaling: 1 agent for facts, 2–4 for comparisons, 10+ for complex research.
  - Failures: 50 subagents for simple queries, duplicated work, endless search, distracting updates.
  - *"Most coding tasks involve fewer truly parallelizable tasks than research."*
- **C compiler, 16 parallel Opus 4.6 instances, no orchestrator** [L2]:
  - Each agent ran in its own container. They pushed to a shared bare repo, claimed tasks with lock files in `current_tasks/`, and a bash loop restarted any session that ended. There were specialist roles: dedup, performance, a Rust-design reviewer, docs.
  - Scale: ~**2,000 sessions** over 2 weeks, ~2 B input / 140 M output tokens, **just under $20k**, ~100k lines of Rust. It builds Linux 6.9 on three architectures and passes **99%** of most test suites.
  - Failures:
    - New features broke old ones until CI was tightened.
    - On the kernel, every agent hit the same bug and overwrote the others' fixes. GCC as an oracle split the work again.
- **Long-running harnesses** [L3]:
  - An initializer writes `init.sh`, a progress file, a **JSON feature list** (200+ features, all failing) and the first commit. A coding agent then does one feature per session.
  - Failures: one-shotting, declaring victory early, and marking a feature done without an end-to-end test.
  - The Mar-2026 follow-up uses **planner → generator → separate skeptical evaluator** (Playwright, hard thresholds). Solo Opus 4.5: **20 min / $9, broken**. Full harness: **6 h / $200, working**. A later iteration without the sprint decomposition: 3 h 50 m / $124.70.
  - Opus 4.5 had already made context resets unnecessary; after Opus 4.6 the sprint construct went too. The planner stayed, because without it the generator under-scoped. "Worth the cost when the task sits beyond what the current model does reliably solo."
- **Advisor strategy** [L4]: a Sonnet or Haiku executor calls Opus as a tool-less advisor (~400–700 token plans, a `max_uses` cap).
  - SWE-bench Multilingual: Sonnet + Opus advisor **+2.7 points at −11.9% cost**.
  - BrowseComp: Haiku + advisor **41.2% vs 19.7%**, 85% cheaper than Sonnet solo.
- **Claude Code agent teams** (experimental) [L5]:
  - A lead plus teammates sharing a task list with file-locked claiming and a mailbox.
  - "Start with **3–5 teammates**", 5–6 tasks each; "three focused teammates often outperform five scattered ones".
  - Cost scales linearly. Teammates editing the same file overwrite each other. **No nested teams**, and **not available under `-p`**.
  - Prefer a single session or subagents for sequential or same-file work. Subagents themselves default to 20 concurrent and three levels of nesting (both configurable).
- **Subagents are for context isolation** [L6]: they burn tens of thousands of tokens and return **1–2k-token** summaries.
- **SWE-bench high-compute mode** [L7]: parallel attempts → drop patches that break the visible tests → an internal scorer picks one. Sonnet 4.5 **77.2 → 82.0**.

**OpenAI** (openai.com refused direct fetches, so some figures come from excerpts or secondary coverage)
- **Harness engineering** [L8]: ~5 months, **0 hand-written lines**, ~1 M LOC, ~**1,500 PRs** from 3 (later 7) engineers, **3.5 PRs/engineer/day**.
  - "Humans steer, agents execute."
  - A structured docs directory (maps, execution plans, specs) is the source of truth. Strict layering is enforced by linters and structural tests.
  - These are OpenAI's own figures, via excerpts.
- **Codex cloud** [L9]: an async queue with one container per task, parallel tasks, and best-of-N attempts where the user picks.
  - codex-1 pass@1 72.1% / pass@8 83.8% is **unverified**.
- **Code verification at scale** [L10] is the strongest reviewer evidence from any lab.
  - A dedicated agentic reviewer (trained alongside gpt-5-codex, with repo tools and code execution) reviews every internal PR and **>100k external PRs/day**.
  - **>80%** positive reactions, and **52.7%** of addressed comments lead to a change.
  - Precision is deliberately favoured over recall to keep trust. "Verification can be cheaper than generation."
- **Agent-design guide** [L11]: maximise a single agent first, and split only when evals show it struggling. Two patterns: manager (specialists as tools) or decentralised handoffs.
- **SWE-Lancer** [P20]: the best model (Claude 3.5 Sonnet) solved **26.2%** of IC coding tasks but **44.9%** of "manager" tasks (choosing between proposals) on the Diamond subset, and earned $403k of the full set's $1M. Models judge better than they implement.

**Google / DeepMind**
- **"Towards a science of scaling agent systems"** [L12]: v3 (Apr 2026) covers 260 configurations over six benchmarks, including SWE-bench Verified and Terminal-Bench; the Google blog and the earlier versions describe 180 over four.
  - Centralised coordination gained **+80.8%** on parallel financial analysis, but all variants lost **39–70%** on sequential planning.
  - **SWE-bench Verified:** every topology was worse than a single agent.

    | Topology | vs single agent |
    |---|---|
    | Hybrid | −2.1% |
    | Centralised | −3.1% |
    | Decentralised | −5.4% |
    | Independent | −14.9% |

  - Terminal-Bench, centralised: −19.2%.
  - Error amplification: independent **17.2×**, central coordinator **4.4×**.
  - Overhead: +58% (independent) to **+515% (hybrid)**.
  - Successes per 1k tokens: **single 67.7** vs 13.6–42.4 multi-agent.
  - Saturation: past **~45%** single-agent success, more agents hurt.
  - More tools make coordination costlier (v3 reports a tool-coordination trade-off, β = −0.096; v2 had put the effect much higher), and a coding agent is tool-heavy.
- **AlphaEvolve** [L13]: breadth from Flash, depth from Pro, and automated evaluators score every program. **0.7%** of Google's fleet compute recovered and a 23% faster kernel.
- **CodeMender** [L14]: special-purpose agents plus an LLM critique agent and fuzzing/SMT checks. Only patches that pass every check reach a human. **72 fixes upstreamed** in 6 months.
- **Jules** [L15]: async, with the plan shown for approval before any code changes. Concurrency of 3/15/60 by plan tier is **unverified**. No quality numbers.

### 1.2 Agent product companies

**Cognition (Devin, Windsurf)**
- **"Don't build multi-agents"** (Jun 2025) [C1]: "share full agent traces, not just messages"; "actions carry implicit decisions, and conflicting decisions carry bad results". Recommends a single-threaded agent plus a compression model.
- **"Multi-agents: what's actually working"** (Apr 2026) [C2]: of parallel-writer swarms, "most of the sexy ideas in that space still don't see meaningful adoption".
  - **The reviewer works:** Devin Review finds 2 bugs per Devin PR, roughly 58% severe. It works best with **no shared context** with the coder, reading only the diff. A bridge filters findings by the user's instructions, so review loops stay in scope.
  - **"Smart friend" escalation is mixed:** a fast cheap primary (SWE-1.5, ~950 tok/s) was "not good enough" as the primary — the gap was in knowing when to escalate and what to ask. Routing between two frontier models did work, as "a capability router rather than a difficulty escalator".
  - **Manager → child Devins is in progress.** Managers wrote over-prescriptive briefs without codebase context, assumed shared state with their children, and children didn't report discoveries unless asked. Cross-agent communication is "the main open problem".
- **"Devin can now manage Devins"** (Mar 2026) [C3]: a coordinator scopes the work, spawns children (each a full Devin in its own VM, verifying its own work), monitors them, resolves conflicts, reads their trajectories, tracks spend per child and pauses or kills children. No limits or results are published.
- **2025 performance review** [C4]:
  - **PR merge rate 67%, up from 34%**; "hundreds of thousands" merged.
  - Migrations 10–14× faster than humans.
  - Self-reported weaknesses: ambiguous requirements and mid-task scope changes.
- **SWE-grep** [C5]: a read-only retrieval subagent trained with RL (8 parallel calls × 4 turns). It is rewarded for **precision over recall**, because "polluting the main agent's context hurts more than omitting".

**Cursor**
- **"Towards self-driving codebases"** (Feb 2026) [C6] is the most detailed public account of scaling coding agents. The architectures they went through, in order:

  | # | Architecture | Result |
  |---|---|---|
  | 1 | Single agent told to keep going | Lost track and declared success early |
  | 2 | Hand-split parallel agents | "Weren't much better" |
  | 3 | **Flat peers with a shared state file and locks** | **20 agents → throughput of 1–3**. Locks were held too long; lockless optimistic concurrency cut the waiting but not the confusion |
  | 4 | Planner / executor / workers / judge | Better, but bound by the slowest worker |
  | 5 | A continuous executor | Overloaded; claimed completion early |
  | 6 | **Root planner → recursive sub-planners → workers, each in its own repo copy, returning handoff reports, with the central integrator removed** | Worked |

  - Scale with design 6: hundreds of agents per run and **~1,000 commits/h over 10 M tool calls in a week**.
  - They accepted a small steady error rate rather than requiring every commit green, with a fix-up pass before release.
  - Other failures: disk I/O saturation from hundreds of agents compiling at once, and deadlocks the agents didn't notice.
- **"Scaling long-running autonomous coding"** [C7]: **"The harness and models matter, but the prompts matter more."** GPT-5.2 was a better planner than GPT-5.1-Codex; Opus 4.5 "tends to stop earlier and take shortcuts when convenient".
  - Outputs: a >1 M LOC browser in about a week; a Solid→React migration of +266k/−193k lines in 3 weeks.
  - Cost: "trillions of tokens"; no dollar figures.
- **Long-running agents** [C8]: plan approval first, then several agents check each other against the plan. Listed runs of 25–36 h (a customer reports a 52 h task and a 151k-line PR). "Substantially larger PRs with merge rates comparable to other agents"; the figures are in a chart.
- **Cursor 2.0** [C9]: parallel agents in worktrees or remote machines. Picking the best of several models' attempts "significantly improves" hard tasks; **no number given**.
- **Bugbot** [C10]: v1 was 8-pass voting with randomised diff order. The move to a single **agentic** reviewer gave the biggest gain: resolution **52% → 70%+**, and resolved bugs per PR ~0.2 → ~0.5.

**Factory (Droids)**
- **Terminal-Bench** [C11]:
  - Droid with Opus scored **58.8% vs Claude Code with Opus 43.2%**; Droid with GPT-5 52.5% vs Codex CLI 42.8%.
  - Design: a minimal tool set ("multiplicative" gains from lower per-call error), a plan tool that keeps state at the end of context, and short timeouts.
- **Missions** [C12, C13]: an orchestrator plans milestones, a fresh worker session runs each feature, validators run at each milestone, and git is the source of truth.
  - **"Serial execution with targeted parallelization has worked better than broad parallelism."**
  - Models per role:

    | Role | Model |
    |---|---|
    | Orchestration | Opus 4.6 |
    | Implementation | Sonnet 4.6 / Opus 4.6 |
    | Validation | GPT-5.3-Codex (a different model family) |

  - Rules: validators never fix anything; the **validation contract is written before the features**; state lives in files (`features.json`, `validation-contract.md`).
  - Measured on one mission:

    | Measure | Value |
    |---|---|
    | Runtime | 16.5 h |
    | Agent runs | 185 |
    | Orchestration's share | **2.3% of runtime, ~4% of tokens** |
    | Validation's share | 37% of runtime |
    | Issues found by validators | **81** (65 blocking) |
    | Fix work | **34% of implementation** |
    | Convergence | 2–4 validation rounds per milestone |

  - Across missions, the median uses **12× the tokens** of a normal session. The Missions page's date is uncertain (it reads 2025 but lists 4.6-era models).
- **Context compression** [C14]: anchored iterative summaries (intent, file changes, decisions, next steps) scored 3.70 vs Anthropic 3.44 vs OpenAI 3.35 under an LLM judge. **Tracking which files changed was the worst dimension for every method**, so they recommend tracking file state explicitly in the scaffold.

**Sourcegraph / Amp**
- **Oracle** [C15]: a read-only second-opinion subagent on a *different* model, for review, debugging and planning.
- **The Dial** (Jul 2026) [C16]: **every effort tier pairs a writer with an oracle reviewer; on the top tiers "it's the other frontier model"** (ultra: Fable 5 writes, GPT-5.6 Sol reviews; high: the reverse). The only result is qualitative: "closer to reviewer-ready" at "about twice the wait".
- **Handoff instead of compaction** [C17]: a fresh thread seeded with a goal-directed prompt and a file list, because compaction "encourages long, meandering threads". No numbers.

**GitHub Copilot**
- **Coding agent** [C18]: issue → a branch it created → draft PR, working in a GitHub Actions VM. Its workflow runs need approval, the developer who asked for the PR can't approve it, and branch protections apply.
- **Agent HQ** [C19]: one control plane to assign Copilot, Claude, Codex and others, including the same task to several agents.
- **Code review** [C20]: **60 M reviews**, more than 1 in 5 GitHub reviews. 71% have actionable feedback, ~5.1 comments each.
  - The agentic architecture gave +8.1% positive feedback, and a stronger model a further +6% at +16% latency.
- Copilot agent merge rates from third-party trackers range **38–80%** depending on sample and window [E1, E3].

**Replit**
- **Agent 3** [C21]: up to **200 min** autonomous, with browser self-testing in a loop.
- Its manager / editor / verifier multi-agent design is described only in secondary LLMOps write-ups (**unverified**). Replit moved off a single ReAct agent as error rates rose with the number of tools.

**OpenHands / All Hands**
- **Critic + best-of-N** [C22]: **60.6% → 66.4%** with 5 rollouts on SWE-bench Verified.
- **2026 critic trained on production data** [C23]:
  - Trained on benchmarks only: **AUC 0.45–0.48, worse than random**.
  - Trained on code survival: 0.69.
  - Best@8 73.8% vs random 57.9%, with early stopping at **1.35 attempts on average** instead of 8.
- **Parallel refactors** [C24]:
  - The work is cut into tasks an agent can finish in 1–3 tries, one PR each, grouped by module dependency analysis.
  - Each agent works on its own branch off an *integration* branch, with a fixer and a verifier per task.
  - The author runs **~5 agents** at once. Refactors are "80–90% automatable", with a human reviewing every PR.

**Augment**
- **SWE-bench Verified** [C25]: **65.4%** with Sonnet 3.7 plus o1 picking among candidates; ensembling added 3–8%.
  - They stopped there because more ensembling cost too much for real use.
  - No net gain from a separate "fix regressions" agent, an orientation agent, or thinking mode.
- **SWE-bench Pro, same Opus 4.5 in different harnesses** [C26]: Auggie 51.8, Cursor 50.2, Claude Code 49.75, SWE-Agent 45.9. Augment credits its context engine.

**Aider**
- **Architect/editor** [C27]: 2024 gains of +3 to +10 points (o1-preview + editor 85.0% vs 79.7% solo).
- **Nov 2025 polyglot leaderboard:** solo gpt-5 (high) **88.0%**; the best pair, o3 + gpt-4.1, **78.2%** vs o3 solo 81.3% at similar cost. **The pair advantage has gone.**

**Amazon and the orchestrator-mode tools**
- **Q Developer** [C28]: 66% SWE-bench Verified by generating several candidates and picking one. The Java-upgrade agent: "over 4,500 years of development work" and $260 M/yr saved (Amazon's estimate).
- **Kiro** [C29]: spec-driven (requirements.md → design.md → tasks.md). No measured results.
- **Roo "Boomerang" / Kilo orchestrator mode** [C30]: a parent hands subtasks to modes in fresh contexts and gets back summaries only. No measured results.

### 1.3 Field data on agent PRs and productivity

- **AIDev** (456k agent PRs, 61k repos) [E1], acceptance on popular repos:

  | Author | Acceptance | Median time to accept |
  |---|---|---|
  | Human | 76.8% | |
  | Codex | 65.3% | 0.3 h |
  | Claude Code | 52.5% | |
  | Cursor | 51.4% | |
  | Devin | 48.9% | |
  | Copilot | 38.2% | 17 h |

- Agentic PRs are small: a median of **1 commit and 3 files** (vs 2 and 4 for human PRs; lines changed not significantly different). Closed agentic PRs merged at 76.8% vs 82.8% for human ones [E2].
- **About a third of rejections are workflow problems**, not agent failures. Merge rate is a noisy quality signal [E4, unverified]. A Jul-2026 study puts Claude Code at 84% merged, Codex 74% and Devin 43% [E5, unverified].
- **METR** [E6, E7, E8]:
  - 38% of agent PRs passed the maintainers' tests; **0 of 15 were mergeable as-is**, at ~26 min of fixing each.
  - RCT: developers **19% slower** with AI (2025); the 2026 update estimates ~18% faster for the original developers and ~4% for new ones, with confidence intervals of −38% to +9% and −15% to +9% (METR's time-change convention: negative is faster).
  - Time horizons double about every 7 months, and the **80% horizon is ~5× shorter than the 50% one**. Reliable autonomy comes from small tasks.

## 2. Architectures that exist, compared

Evidence strength: **strong** = several primary measurements; **some** = one or two measurements or vendor-only; **thin** = claims without numbers.

| # | Architecture | Who runs it | Measured effect on solve rate / quality | Cost multiplier | Scales to many parallel tasks? | Evidence | Fit for Orca |
|---|---|---|---|---|---|---|---|
| A1 | **Single strong agent + read-only subagents for context isolation** | Claude Code, Amp (search/librarian/oracle), Gemini CLI, Devin + SWE-grep, Cognition's default | Best successes per token in Google's study (67.7/1k vs ≤42); harness/context changes +5–15 pts on the same model [C11, C26] | 1× (subagents add ~10–50%) | One task at a time; scale comes from running many | **strong** | **Already the worker** — keep it, invest in the harness |
| A2 | **One coordinator + isolated single-writer workers (branch/VM each) + human/CI merge** | Codex cloud, Copilot agent / Agent HQ, Jules, Devin manages Devins, Cursor background agents, Factory Missions, **Orca** | Merge 38–67% per agent in the field [E1, C4]; centralised coordination amplifies errors least (4.4×) [L12] | ~1× per task + coordinator (Factory: 2–4% of tokens) | Yes, up to review capacity; 3–5 per lead is the common guidance (Anthropic, agent teams, OpenHands ~5) | **strong** (deployment), **some** (controlled) | **Orca today** — the gaps are verification and state, not shape |
| A3 | **Hierarchical planners (root → sub-planners → workers)** | Cursor research harness | ~1,000 commits/h, hundreds of agents; accepts a steady error rate | linear in agents ("trillions of tokens") | **Yes**, the only measured case at hundreds of agents | **some** (one vendor, greenfield) | Only for very large, decomposable projects |
| A4 | **Multiple peer orchestrators, or orchestrator-of-orchestrators** | Nobody publishes results; agent teams forbid nesting | Hybrid/hierarchical: +515% overhead, worse on SWE-bench (−2.1%) [L12]; Devin manager failures [C2] | high (each layer re-summarises) | In principle | **thin / negative** | Per-repo peers at most (§3) |
| A5 | **Flat peer swarm with shared state / handoffs** | Cursor stage 3, Anthropic C compiler (lock files), OpenAI handoffs, agent teams' mailbox | Cursor: 20 agents → throughput of 1–3; compiler: collisions on a shared bug; independent agents amplify errors 17× | ≥ linear | **Poorly**, except along test-oracle boundaries | **some (negative)** | Avoid inside one branch; git + merge queue already do this job between branches |
| A6 | **Strong planner → cheap coder → strong reviewer** | Aider architect/editor (2024), Windsurf SWE-1.5 + Sonnet, Factory (per role) | 2024: +3–10 pts; 2025: pairs **lose** to strong solo at equal cost [C27]; cheap primary can't decide when to escalate [C2] | 0.5–1× (Orca: ≈1× after retries, §6.4) | Same as A2 | **some** | Keep the reviewer; choose the coder per task, don't assume a cheap one |
| A7 | **Advisor / smart-friend escalation (cheap executor calls a strong model)** | Anthropic advisor tool, Amp oracle, Cognition (frontier ↔ frontier) | +2.7 pts at −11.9% cost (SWE-bench Multilingual) [L4]; Haiku BrowseComp 19.7 → 41.2 | 0.7–0.9× | Same as A2 | **some** | A Sonnet worker with an Opus advisor is the measured form of your idea B |
| A8 | **Writer + independent reviewer / validator (no shared context)** | Devin Review, Codex reviewer, Bugbot, Copilot review, Factory validators, Amp Dial (cross-family), Anthropic evaluator, CodeMender | ~2 bugs/PR (58% severe); 52.7% of comments acted on; Bugbot 52 → 70%+; MAST +15.6%; validators' fixes = 34% of the work | +5–40% (verification cheaper than generation [L10]) | Yes, per task | **strong** | **Highest-value addition** (R4) |
| A9 | **Parallel best-of-N + judge / verifier** | Anthropic high-compute, OpenHands critic, Augment, Q Developer, Codex attempts, Cursor multi-model | +5 to +17 pts; oracle gap 12–19 pts [P15–P17, P21]; early stop 1.35 attempts [C23] | ~N× (CodeMonkeys ≈ $4.6/issue) | Multiplies load by N | **strong** (benchmarks), **some** (production) | Hard, high-value tasks with a real check only (R8) |
| A10 | **Test- / validation-driven generation** | AgentCoder, Anthropic feature list, Factory validation contract, OpenAI structural tests, Kiro specs | AgentCoder HumanEval 96.3% with fewer tokens; external feedback beats self-critique [P3, P25–P29] | ~1× (+ test writing) | Yes; tests are what make parallel work safe (C compiler) | **strong** (function level), **some** (repo level) | Validation-contract briefs (R7) + `checkCommand` (R1) |
| A11 | **Routing / cascades / cheap-first escalation** | FrugalGPT, RouteLLM, SWE-Router, Scrouting, Not Diamond; Orca's model ladder | SWE-Router: deciding to escalate from a partial trajectory beats static routing by +13–15 pts Route-AUC; Scrouting: same solves at ~⅕ cost, **gain from the handoff, not the router** | 0.2–0.6× | Yes | **some** (2026, academic) | The ladder + evidence-driven escalation; invest in the handoff |
| A12 | **Async background queue + human review** | Codex cloud, Copilot, Jules, Devin, Cursor | Merge 38–84%; METR 0/15 mergeable as-is; human review is the bottleneck | per task | Yes — bounded by review | **strong** (field) | Orca's lanes and merge queue; size WIP to Finn's review rate |
| A13 | **Fixed pipeline (no agent loop)** | Agentless; Copilot review's earlier non-agentic version | 2024: Agentless 27–32% Lite at $0.34–0.70, beating multi-agent systems; agentic versions have since overtaken it (Bugbot, Copilot review) | 0.1–0.3× | Yes | **some** | For deterministic chores (changelog merges, which Orca already does) |

**Patterns across the table:**
1. Every system that scales **separates writers**: one writer per branch or copy, with git as the arbiter.
2. Every system that reports quality **adds an independent check**: tests, CI, a validator, a reviewer.
3. Whatever deployments **share between agents is files, not conversation**: progress files, feature lists, ledgers, handoff reports.
4. **More coordination layers cost tokens and add error unless the work decomposes cleanly.**

Magentic-One's ablation is the cleanest measurement of the state point: dropping its task and progress ledgers for plain group chat cost **−31%** on GAIA [P9].

## 3. Question 1: multiple orchestrators, each managing a team

### 3.1 What the evidence says

- **For more than one lead, partitioned by domain:**
  - Google: centralised coordination wins **only on parallelisable** work (+80.8%).
  - Cursor's sub-planners own disjoint scopes and report up through handoffs.
  - Factory: orchestration is cheap (2–4% of tokens).
  - Anthropic's lead persists its plan outside context.
  - None of these is a controlled test of "N orchestrators × M workers" on code. **No one has published one.**
- **Against deeper hierarchy:**
  - Google: hybrid/hierarchical topologies had the highest overhead (+515%, 6.2× turns) and were worse than a single agent on SWE-bench.
  - Cognition: managers wrote over-prescriptive briefs and assumed shared state, and children didn't report discoveries.
  - Agent teams: no nesting.
  - Every extra layer is one more lossy summary (Cognition's "share full traces").
- **Concurrency per lead, in published numbers:**

  | Source | Workers per lead |
  |---|---|
  | Anthropic research lead | 3–5 |
  | Agent teams | start at 3–5 |
  | OpenHands refactors | ~5 |
  | Practitioners (v1 sources) | 5–10 sessions |
  | Jules tiers (unverified) | 3 / 15 / 60 |
  | Cursor | hundreds, but by accepting a steady error rate and building a hierarchy |

  Orca's lead averaged **8.5 and peaked at 21** active workstreams per 2 h (§5.4).
- **Failure modes, with the published fix for each:**

  | Failure mode | Published fix |
  |---|---|
  | Context loss at the lead | Anthropic plan-to-memory; Magentic-One ledgers; Factory features.json |
  | Duplicated work | Anthropic's early 50-subagent spawns; fixed by effort scaling and explicit task boundaries |
  | Conflicting edits | Cursor locks; agent teams' same-file overwrites; fixed by one writer per copy and serial merge |
  | Several agents chasing the same failure | Compiler kernel bug; fixed by an oracle-based split |
  | Premature "done" | Every source; fixed by an independent validator |
  | Disk/CPU saturation | Cursor; Orca's 74–90% CPU at 4–6 agents |

### 3.2 Hierarchy options for Orca

| Option | How it would look | Industry analogue | Verdict |
|---|---|---|---|
| **A. One lead (today)**, plus an ask ledger and a WIP cap | One session; asks and per-workstream state in tables rendered each wake; ≤ ~6 in flight | Factory Missions, Devin manager, Codex/Copilot queues | **Do this first** |
| **B. Per-repo peer leads under a thin deterministic router** | `@orca/orca`, `@orca/branch-demo`, each with its own session, notes, board and asks; routing by repo / `@PR` / page, else ask | Cursor sub-planners with disjoint scopes; Google's "centralised per parallel domain" | **Next, if asks still drop** after A's fixes |
| **C. LLM orchestrator-of-orchestrators** | A top session delegating to repo leads | Cursor's root planner (greenfield, hundreds of agents); no measured coding result otherwise | **Not now**; reconsider past ~4 domains |
| **D. Peer swarm on one branch** (shared task file, locks) | Several workers on one feature branch | Cursor stage 3, agent teams | **No**: Orca's one-branch-per-worker plus merge queue is the measured-better design |

**Numbers to plan with:**
- Per lead: **≤ 6 workstreams in flight** and ≤ 10–12 live; the rest wait in the ask table.
- **One lead per repo** if B happens.
- A box-wide cap on running agents set by CPU (**4** on m7i.xlarge, **8** on m7i.2xlarge).
- The real ceiling is Finn's review rate. Industry merge rates of 50–67% mean roughly one in two or three agent PRs needs human rework.

## 4. Question 2: strong planner + cheap coder + strong reviewer vs strong end to end

| Component | Industry evidence | Verdict |
|---|---|---|
| **Strong planner** | Anthropic keeps a planner because without one generators under-scope [L3]; DCAS: "planning quality is a high-leverage component" (numbers unverified); a 2026 harness ablation found planning is an accuracy scaffold for *weaker* models and mostly a **cost saver** for strong ones [P14]; Factory/Cursor plan with the strongest model; orchestration is a few % of tokens | **Keep**: cheap relative to execution. Skip for one-sentence diffs (Anthropic) |
| **Cheap one-shot coder** | Aider pairs lost to strong solo by 2025; Cognition's cheap primary failed to escalate; Augment's extra agents added nothing; SWE-Lancer: models implement worse than they judge; Haiku 4.5 73.3% vs Sonnet 4.5 77.2% on SWE-bench Verified; strong models use fewer tokens per solve (Opus 4.5 matched Sonnet 4.5 with 76% fewer output tokens) | **Not as a default.** Fine for mechanical edits; for the rest, use the advisor form (A7) or Sonnet with a review gate |
| **Strong reviewer** | Devin Review, Codex reviewer, Bugbot, Copilot review, Factory validators, Anthropic evaluator (§1); cross-family pairing at Amp and Factory | **Strongest part of the idea**: adopt (R4) |
| **Strong end to end** | Opus 4.5/5.5 token efficiency; harness/context matter as much as model | Still the baseline to beat on hard work |

**Cost on Orca's real tokens** (§6):

| Pipeline | Cost per workstream |
|---|---|
| Opus end to end | ≈ **$11.0** |
| Sonnet 5.5 coder | ≈ $6.6 |
| Haiku 5.5 coder | ≈ $2.4–3.6 (only under 100k-token requests) |
| Opus plan → Sonnet code → Opus review, after retries | ≈ $13.6 |
| Opus end to end, after retries | ≈ $14.1 |

**Conclusion:** the split pays for **review quality**, not savings. These are cheaper per unit of quality than a cheap-coder sandwich:
- Add the reviewer to *every* non-small change, whatever model coded it.
- Right-size the coder per task with the ladder.
- Escalate on evidence (failures, check results).
- Cut context, which is ~90% of spend.

---

## 5. Orca's own numbers (secondary; measured)

### 5.1 What data exists, and what is missing

| Source | Covers | Has | Missing |
|---|---|---|---|
| `turn` (Postgres) | 2,175 turns at review time (21:30 UTC), 2026-07-21 → 2026-10-14 | status, stop_reason, timings, repo/branch via `workstream`, `source` (human/agents) | **`model`, `cost_usd`, `input_tokens`, `output_tokens`, `cache_*_tokens` are empty on every row** — the columns exist but nothing writes them. **`check` is null on every turn** — the verification gate has never recorded a result, because **no repo sets `checkCommand`** in the config. |
| `~/.orca/ledger.json` | a **snapshot of the last 500 records = 29.5 h** (2026-10-13 14:45 → 10-14 20:16 UTC), 487 runs, 474 with usage; the file is rolling, so later reads differ slightly | action, mode (fresh/resume/reset), status, duration, tokens, `costUsd`, `errorKind` | model, repo, branch, run id (I joined ledger→turn by finish time ±3 s and duration: 465/487 matched). The model comes from the workstream's **current** `preferredModel`, which may differ from the model the run used (e.g. today's "switch all Fable workstreams to Opus"). |
| `instance_metric` | per-minute samples, both machines | CPU, load, memory, `running_agents`, OOM kills | — |
| `REQUESTS.md` | the orchestrator's ask ledger, today | 37 asks at 21:16 UTC, 19 closed, 18 open | not linked to workstream ids in any structured way |

**The ledger's `costUsd` is cumulative per Claude session, not per run.** On `--resume`, Claude Code's `total_cost_usd` carries the session's running total: the orchestrator's sequence reads $30.57 → $31.06 → … → $39.17, then $0.72 after a `reset`. Summing the field reports **$7,501** for 29.5 h; repricing the per-run token counts (which *are* per-run) at list price gives **≈ $850**. Anything that sums `costUsd` (and `lastWakeUsd` / `sessionHint`) is overstated by ~an order of magnitude for resumed sessions. Calibration: on *fresh* runs (where reported = per-run), list price with **1-hour cache writes** reproduces the reported cost exactly for Sonnet 5 ($101.2 vs $101.4) and Fable ($10.7 vs $10.7), so Claude Code writes 1-hour caches; Opus-pinned fresh runs report ~28% more than the estimate ($174.8 vs $136.7), consistent with some of them having actually run on Fable before the re-pin. Read every dollar below as ±20%.

**These are subscription logins (hydra), not API billing** — the dollar figures are *list-price equivalents*, the right unit for comparing designs; the binding constraint in practice is the 5-hour/weekly windows across logins, which scale with the same tokens.

### 5.2 Volume and cost, last 29.5 h (list-price equivalent, 1h cache writes)

- **474 runs ≈ $850 ≈ $690/day.** 209 orchestrator wakes (7.1/h) and 265 worker runs (9.0/h) across **77 workstreams** in 2 repos.
- **Where the money goes** (by token class, all runs): cache *writes* 51% (1-hour writes at 2× base input), cache *reads* 39%, output 11%, uncached input ~0%. **≈ 90% of spend is context** (writing it to the cache, then re-reading it every tool call), not generated code. An Opus worker launch re-reads **5.9 M cached tokens** on average to emit 36 k output tokens.
- **By role:** workers ≈ $688 (81%), orchestrator ≈ $159 (19%) (≈ $0.76/wake; 1.53 M cache-read, 52 k cache-write, 1.8 k output per wake — it reads its whole session each wake to write ~1 paragraph).
- **By model (worker runs, current pin):** Opus 5.5 187 runs / mean **$2.16**; Sonnet 5 53 runs / $2.31 (longer runs: 29.5 k output, 7.7 M cache-read — it was given the big `orca` launches); Fable 5.1 24 priced runs / **$6.70 mean** (3 more errored before reporting usage: 3 of 27, 11%, not done); Haiku 4.5: 1 run. The ladder's bottom rung is essentially unused. *(Correction at review: the first version priced this line, the next two and the tails at 5-minute cache-write rates while the totals used 1-hour; everything is now at 1-hour, which the calibration above supports. The 5-minute figures were 15–25% lower.)*
- **By repo × action:** `branch-demo` Address PR is the single biggest line (61 runs, **$4.34 mean, p90 $10.93**, 5.6 M cache-read) — a big repo + review threads + CI logs. `orca` launches: 52 × $2.64.
- **Per workstream (78):** median **2 runs / $4.35 / 10.7 agent-minutes**; mean $8.82, p90 $24. `orca` median $3.49 (2 runs); `branch-demo` median **$9.48 (4 runs)**, mean $18.83. Tail: `ai-pdf-report-generation` 8 runs ≈ $73, `word-doc-editing` 13 runs ≈ $70, `ai-question-widget` 10 runs ≈ $64 — long-lived feature branches that go round the Address PR loop.
- **Orchestrator overhead per workstream:** 2.7 wakes ≈ **$2.05**, i.e. ~18–23% on top of a typical Opus workstream.

### 5.3 Reliability

| | runs | not `done` | notes |
|---|---|---|---|
| all (ledger) | 487 | 16 (3.3%) | 14 `nonzero-exit`, 2 `timeout` |
| orchestrator wakes | 215 | 8 (3.7%) | turn table: 18 wakes `error` on 10-13 alone (13%), 1 on 10-14 |
| Fable workers | 27 | 3 (11%) | small n |
| `branch-demo` follow-ups | 36 | 4 (11%) | |
| Sonnet workers | 53 | 0 | |

Durations (turn table, since 10-09, finished Claude runs, re-run at review time): orchestrator p50 0.5 min / p90 2.5; `orca` workers p50 4.3 / p90 14.8; `branch-demo` p50 5.1 / p90 **26.7** min. 26 Codex turns all-time, p50 2.5 min.

There is **no measured correctness signal**: `turn.check` is never written (no `checkCommand`), `failStreak`/model escalation is in "suggest" mode, and CI outcome per PR isn't joined to the run that produced it. Right now Orca can say what a workstream cost but not whether the model did it right first time.

### 5.4 Load on the orchestrator

- **Weekly turns** went from 43–184 (Jul–Sep, no orchestrator) to **604 and 803** in the two orchestrator weeks (the second still running); distinct workstreams touched per week 11–69 → **58 and 140**.
- **Workstreams active in a rolling 2 h window**: avg **8.9** on 10-13 and 7.5 on 10-14, peak **21** (10-13) and 20 (10-14); worker turns running at the same moment peak 9 (10-13) and 8 (10-14).
- **Live (unarchived) workstreams: 109**, 55 marked orchestrated, only 17 carrying an `orchStatus`.
- **Wakes/day:** 138 (10-13) and 125 (10-14, to 21:30 UTC), ≈ 2/3 human-sourced and 1/3 worker reports. 10-13 had **18 dead wakes** (13%); 10-14 had 1.
- **REQUESTS.md today:** 37 asks logged by 21:16 UTC, 19 closed, 18 open — about 6 of the open ones are blocked on Finn (a decision, creds, a merge) and are not dropped asks, but the ledger only exists because, before it, asks were lost in a 1–2 M-token resumed session.

**Where today's dropped asks come from**, read from the code and the ledger: (1) the orchestrator's working memory is a resumed session holding 1–2 M tokens of history — an ask from three hours ago is "somewhere in context", which is exactly the context-rot regime; (2) a wake carries a **batch** of messages and reports, and the reply addresses the salient ones; (3) on 10-13, **18 wakes died** (each a cut-off + retry, a message whose wake dies twice is dropped with a note); (4) asks that need Finn (merge, creds, a decision) look "done" from the orchestrator's side. The REQUESTS.md ledger fixes (1)–(2) by moving the open-ask list out of context and into every wake — the same move as Anthropic's progress file.

### 5.5 Machine capacity (cloud box: m7i.xlarge, 4 vCPU, 15 GiB usable)

From `instance_metric` (cloud, last 7 days), grouped by `running_agents` at sample time:

| running agents | samples | avg mem GB | max mem GB | avg CPU % | avg load1 |
|---|---|---|---|---|---|
| 0 | 814 | 1.2 | 2.3 | 3 | 0.2 |
| 1 | 490 | 1.9 | 8.0 | 20 | 0.8 |
| 2 | 309 | 2.8 | 9.8 | 41 | 1.8 |
| 3 | 149 | 3.7 | 13.0 | 60 | 2.8 |
| 4 | 102 | 3.9 | 10.6 | 74 | 3.9 |
| 5 | 44 | 4.6 | 10.0 | 83 | 4.9 |
| 6 | 21 | 5.5 | 10.8 | 90 | 5.7 |
| 8–9 | 12 | ~7 | 13.3 | 66–92 | 4.7–8.2 |

- **CPU, not average memory, is the steady-state ceiling:** load ≈ number of agents, and at 4+ agents the 4 vCPUs are saturated (74–90% CPU). With agents running, load1 peaked at **~15** (8 agents). *(Correction at review: the first version cited a load1 of 58 on 10-13 as agent load. That sample — 14:29 UTC, CPU 100%, 1.6 GB used — had **no** agents running and is a separate, unexplained event.)*
- **Memory is the tail risk:** mean usage is low (≈ 0.7 GB per agent), but builds/tests spike — max 13.3 GB at 9 agents, 13.0 at 3. **Both repos set `agentMemoryMaxGb: 8`**, so the per-worker cgroup lets *two* runaway workers exhaust a 15 GiB box between them; the cgroup protects the box only if ceilings × concurrently-building workers < ~12 GB.
- No `oom_kills` recorded in the last 10 days (the counter is new).
- The laptop instance (`local`, 24 GB) ran 0 agents over the period — all execution is on the box.

### 5.6 Config facts that matter for scaling

- `agentModel: claude-fable-5-1` is the app-wide default (anything that doesn't pass a model gets the scarcest model).
- `MODEL_LADDER` in `web/src/workstream.ts` names **`claude-haiku-4-5-20251001` and `claude-sonnet-5`**, not Haiku 5.5 / Sonnet 5.5. At list price Haiku 4.5 is **10× Haiku 5.5** on input/output ($1/$5 vs $0.10/$0.50) and Sonnet 5's cache reads cost 2× Sonnet 5.5's ($0.20 vs $0.10).
- `modelEscalation` unset (= suggest), `autoUpkeep` default on, `mergePolicy` only on `orca` (`whenGreen: small`, `autoPr: true`).
- `MAX_WAKES` 12, no wake budget, no cap on concurrent workers (deliberate).
- **Standing context is large:** this repo's `CLAUDE.md` is 97 KB (≈ 25–30 k tokens at the 4.7+ tokenizer) and is in every request of every `orca` worker — a launch makes tens of model calls, so on the order of 1 M of its 5.9 M cache-read tokens is this one file. `branch-demo`'s `AGENTS.md` is 21 KB. The orchestrator's own role + board + notes are re-sent on every wake.

---

## 6. Cost model of a typical Orca workstream

### 6.1 Prices used (official, platform.claude.com/docs/en/about-claude/pricing, fetched 2026-10-14)

| Model | Input | 5m write | **1h write** | Cache read | Output |
|---|---|---|---|---|---|
| Fable 5.1 | $10 | $12.50 | $20 | $0.25 (0.025×) | $50 |
| Opus 5.5 | $4 | $5 | $8 | $0.20 (0.05×) | $20 |
| Sonnet 5.5 | $2 | $2.50 | $4 | $0.10 (0.05×) | $10 |
| Sonnet 5 (on the ladder) | $2 | $2.50 | $4 | $0.20 | $10 |
| Haiku 5.5, prompt ≤ 100k | $0.10 | $0.125 | $0.20 | $0.01 | $0.50 |
| Haiku 5.5, prompt > 100k | $0.50 | $0.625 | $1 | $0.05 | $2.50 |
| Haiku 4.5 (on the ladder) | $1 | $1.25 | $2 | $0.10 | $5 |

Per MTok. 1M context at standard price for 4.6+ except Haiku 5.5, which is priced per request by prompt length (cache reads count toward the 100k). Batch −50% (not applicable to interactive Claude Code). The 4.7+ tokenizer yields ~30% more tokens for the same text than older models.

### 6.2 Measured token shape per run (Opus 5.5 workers, means)

| run | n | input | cache write | cache read | output | p50 min | Opus $ |
|---|---|---|---|---|---|---|---|
| launch (fresh) | 36 | 158 | 140 k | 5.92 M | 36.0 k | 6 | 3.02 |
| follow-up (resume) | 63 | 95 | 118 k | 3.12 M | 10.8 k | 2 | 1.79 |
| Address PR | 88 | 50 | 143 k | 4.00 M | 6.6 k | 2 | 2.08 |
| orchestrator wake | 209 | 8 | 52 k | 1.53 M | 1.8 k | 0.4 | 0.76 |

For an Opus launch the $3.02 splits ≈ 39% cache reads, 37% cache writes, 24% output.

### 6.3 Typical workstream = 1 launch + 1 follow-up + 2 Address PR + 2.7 orchestrator wakes

Same token counts repriced per model (this *assumes* a cheaper model uses the same tokens — see 6.4):

| worker model | worker $ | + orchestrator (Opus) | total | vs Opus |
|---|---|---|---|---|
| Fable 5.1 | 18.16 | 2.07 | **20.23** | 1.8× |
| Opus 5.5 | 8.97 | 2.07 | **11.04** | 1× |
| Sonnet 5.5 | 4.48 | 2.07 | **6.55** | 0.59× |
| Haiku 4.5 (current ladder rung) | 3.09 | 2.07 | 5.16 | 0.47× |
| Haiku 5.5 (requests > 100k) | 1.55 | 2.07 | 3.62 | 0.33× |
| Haiku 5.5 (requests ≤ 100k) | 0.31 | 2.07 | 2.38 | 0.22× |

### 6.4 Adjusting for reality: retries, review, under-specified plans

The naive table flatters cheap models. Three corrections:

1. **Cheaper models use more tokens on the same task.** Orca's own Sonnet 5 runs averaged 29.5 k output / 7.7 M cache-read vs Opus's 13.7 k / 4.1 M (confounded: Sonnet got bigger `orca` launches). Treat a cheaper rung as **1.3–2× the tokens**.
2. **Retries.** Each failed attempt re-pays a launch-sized context. If p = probability a worker's first attempt is mergeable without another round, expected rounds ≈ 1/p.
3. **A strong review gate** costs an Opus read of the diff + touched files: ~0.8 M cache-read, 60 k write, 6 k output ≈ **$0.76** per review (Fable: $1.70). A planning pass (Opus) ≈ **$0.68**.

Worked comparison for one *mid-size* feature (one launch-equivalent of work, 2 Address rounds baseline), with stated assumptions:

| pipeline | per-attempt worker $ | assumed first-pass success | expected attempts | + plan + review | expected $ | notes |
|---|---|---|---|---|---|---|
| Opus end-to-end (today) | 8.97 | 0.75 | 1.33 | +0 (no review gate) | **≈ 12.0 + 2.1 orch = 14.1** | |
| Opus plan → Sonnet 5.5 code → Opus review | 4.48 × 1.4 tokens = 6.27 | 0.65 | 1.54 | 0.68 + 0.76/attempt | **≈ 9.65 + 0.68 + 1.17 + 2.1 = 13.6** | ~4% cheaper; review catches the misses earlier, so fewer Address rounds land on reviewers |
| Opus plan → Haiku 5.5 code → Opus review | 0.31–1.55 × 2 = 0.62–3.10 | 0.40 | 2.5 | 0.68 + 0.76/attempt | **≈ 1.6–7.8 + 0.68 + 1.9 + 2.1 = 6.3–12.5** | cheap only if Haiku's requests stay under 100 k tokens — Claude Code sessions on these repos usually exceed that |
| Fable end-to-end | 18.16 | 0.80 | 1.25 | 0 | **≈ 22.7 + 2.1 = 24.8** | |

Success rates are **assumptions** for illustration (Orca has no measured first-pass rate — see R1 in §7). The literature in §2 and §4 brackets them: Haiku 4.5 reached 73.3% vs Sonnet 4.5's 77.2% on SWE-bench Verified, and strong models solve with fewer tokens. The structural conclusions are robust to those numbers:

- **The orchestrator + review + plan overhead (~$3.5) is fixed**, so model splitting pays only on large tasks; on Orca's median $4.35 workstream the overhead is close to the size of the work.
- **The cheap-coder win is mostly a cache-read win**, because cache writes and reads are ~90% of Orca's spend and scale with the per-token price. Shrinking the context a worker re-reads (smaller CLAUDE.md, focused briefs, `--resume` vs fresh) helps every model by the same factor.
- **Under-specified plans are the expensive failure**: a brief that sends a worker down the wrong path costs a whole extra launch (~$3 Opus) plus an orchestrator wake plus Finn's attention — far more than a $0.68 plan pass.
- **Haiku 5.5's >100k cliff matters**: on `branch-demo` an Address run's context per request is often >100k tokens, so Haiku 5.5 is 5× its headline price there.


---

## 7. Recommendations (prioritised)

Each recommendation gives the change, the industry evidence for it, its expected impact, cost and risk, and what to measure. The order follows the evidence plus how cheap the change is. The numbering changed from the first version: the review gate moved up and best-of-N and advisor escalation were added.

**R1. Measure correctness and cost first** (days, low risk; unblocks every later decision).
- What:
  - Write `model`, tokens and a **per-run** cost to `turn`. The columns exist. Diff the cumulative `total_cost_usd` per session, or price the run from its tokens.
  - Fix `lastWakeUsd`.
  - Set `checkCommand` on both repos.
  - Derive per-workstream outcomes: first-pass merge, Address rounds per PR, time to merge, $ per merged PR, and **code survival** (lines still present after N days).
- Evidence: the measurements companies use to judge their agents are merge rate (Devin 34% → 67%, AIDev), code survival and PR merge as critic labels (OpenHands: benchmark-only labels scored worse than random), and acted-on review comments (OpenAI 52.7%). Without these, every later recommendation runs on assumptions.
- Measure: share of turns with model and cost recorded; check pass rate by model; merge rate by model and task class.

**R2. Fix and enforce the model ladder** (hours, low risk, direct savings).
- What:
  - Point `MODEL_LADDER` at Haiku 5.5 and Sonnet 5.5.
  - Change the app default from Fable 5.1 to Opus 5.5.
  - Run CI-only and conflict-only Address PR runs and small follow-ups on Sonnet 5.5.
  - Use Haiku 5.5 only under 100k-token requests.
  - Turn on `modelEscalation: "apply"` once R1 measures it.
- Evidence: Factory and Cursor assign a model per role. SWE-Router and Scrouting route cheap-first and escalate. Cognition shows the *orchestrator* should pick the model; a cheap primary left to escalate on its own doesn't.
- Impact: ~20% of worker spend by moving ~40% of runs to Sonnet 5.5.
- Measure: first-pass merge and $ per merged PR by model.

**R3. Structured ask and state ledger** (days, low risk; the main fix for dropped asks).
- What:
  - An `ask` table (text, source turn, linked workstreams/PRs, status open / waiting-on-Finn / in-progress / verified / dropped, verify-how).
  - `orca ask add|link|close`, rendered into every wake and shown in the panel.
  - Auto-open an ask from any human message the lead doesn't link or close.
  - `orchStatus` required on every orchestrated row.
- Evidence:
  - Magentic-One: dropping its task and progress ledgers cost **−31%** on GAIA.
  - Anthropic keeps a JSON feature list and progress file ("JSON because models mangle it less").
  - Factory keeps `features.json` and a validation contract.
  - Cursor workers return handoff reports.
  - Factory found file-change tracking was the weakest part of every summary, which argues for structured file state.
- Measure: asks open more than 24 h, asks with no workstream, asks Finn has to raise again.

**R4. Independent review gate before a PR reaches Finn** (days, low–medium risk). This was R7 and is now the best-evidenced addition.
- What:
  - After a worker's clean finish on a non-small change, run a **fresh-context reviewer** that sees only the brief, the diff and the touched files, and has tool access to run tests.
  - Blocking findings become **one** fix follow-up, reusing the `AUTOFIX_MARKER` loop guard. The reviewer never fixes anything itself (Factory's rule).
  - Prefer a **different model family** where Orca has one available: Codex as reviewer for Claude workers. Amp and Factory both do this.
  - Tune for precision (OpenAI deliberately favoured precision, and adversarial reviewers over-report).
- Evidence: Devin Review ~2 bugs per PR, 58% severe; Codex reviewer 52.7% of addressed comments acted on; Bugbot 52% → 70%+; Factory validators found fix work worth 34% of implementation; MAST +15.6%; Anthropic's evaluator.
- Cost: ~$0.76 per review at Opus (§6.4), 1–3 min.
- Risk: churn from false positives, so cap it at one review-fix round.
- Measure: Finn's change-request rate, defects found per review, Address rounds after the PR opens.

**R5. Context and harness** (days, low risk).
- What:
  - (a) Split the 97 KB CLAUDE.md into a short core plus on-demand `docs/`.
  - (b) Reset the orchestrator's session at 40–50% context, or every N wakes. Its state lives in R3's ledger, the notes and the board, which is Amp's "handoff, not compaction".
  - (c) A per-workstream spend alarm at about the p90 ($20 list-equivalent).
  - (d) Keep worker tool sets small: Factory's "minimal tools" and Google's tool-density penalty.
- Evidence: the same model scores 15 points apart in different harnesses (Factory, Augment). Cursor: "prompts mattered more". About 90% of Orca's spend is context (§5.2).
- Measure: cache-read tokens per run, $ per merged PR, cost per wake.

**R6. Cap work in progress per lead; admit runs by CPU; capacity** (days, medium risk; ~$170/month if the bigger box turns out to be needed).
- What:
  - The lead keeps **≤ 6 workstreams in flight** and queues the rest in R3's table.
  - A box-wide admission queue starts a run only while `running_agents < vCPU` and there is memory headroom.
  - Lower `agentMemoryMaxGb` from 8 to 4–5 now (two 8 GB ceilings exceed the box). Move to m7i.2xlarge only once the admission queue shows measured wait: with the load-58 reading gone (§5.5), the evidence is CPU saturation at 4–6 agents, not harm.
- Evidence:
  - Concurrency guidance of 3–5 per lead (Anthropic, agent teams, OpenHands).
  - Cursor's disk I/O saturation at hundreds of agents.
  - Orca's own CPU data: 74–90% CPU at 4–6 agents, load up to ~15 (§5.5); no OOM kills recorded.
  - Human review is the binding constraint: METR, merge rates.
- Measure: queue wait, run p90 duration against concurrency, OOM kills, load1.

**R7. Validation-contract briefs** (days, low risk). This extends the earlier "plan-then-execute".
- What:
  - For multi-file features, the brief carries objective, acceptance criteria, **how it will be verified** (commands, screens, `orca-shot`), files likely touched, and what is out of scope.
  - The contract is written **before** the work, and R4's reviewer checks against it.
  - `briefProblems` requires a verify step above a size threshold.
  - Skip all of this for one-sentence diffs.
- Evidence: Factory writes the validation contract before features; Kiro uses requirements → design → tasks; Anthropic's feature list starts all-failing; OpenAI uses structural tests; Cursor approves the plan first; MAST's per-mode figures sum to ~44% specification failures.
- Measure: Address rounds per PR, discarded launches, review findings per PR.

**R8. Best-of-N only for hard, high-value tasks that have a cheap check** (days, medium cost).
- What:
  - For a task that has already failed once on Opus, or is flagged hard, launch 2–3 parallel attempts in separate worktrees, on different models where possible (Cursor 2.0, Agent HQ).
  - Filter by `checkCommand`, let R4's reviewer pick, and **stop at the first attempt that passes**.
  - Use this instead of escalating straight to Fable.
- Evidence: +5 to +17 points on benchmarks; selection leaves a 12–19-point gap; early stopping brought the average down to 1.35 attempts (OpenHands). Augment and Bugbot dropped wide ensembles because of cost.
- Risk: N× CPU on a box that is already saturated, so this needs R6 first.
- Measure: solve rate of the hard class against the cost per solve.

**R9. Advisor-style escalation instead of a cheap-coder sandwich** (experiment, low risk).
- What: run Sonnet 5.5 workers that can consult Opus for a plan or second opinion when stuck. Use Anthropic's advisor tool if Claude Code exposes it (**not verified** for the CLI). Otherwise use a worker-side "ask the lead" path, which is the orchestrator answering on `send`.
- Evidence: advisor +2.7 points at −11.9% cost (SWE-bench Multilingual). Scrouting showed the gain comes from the **handoff** quality, not the router.
- Measure: A/B Sonnet+advisor against Opus on one task class using R1's metrics.

**R10. Per-repo peer orchestrators under a thin deterministic router** (1–2 weeks, medium risk).
- What: as option B in §3.2.
- When: only if asks still drop **after R3 and R6**. No published measurement favours more coordination layers for coding, and Google's hierarchical variant was the costliest.
- Do **not** build an LLM orchestrator-of-orchestrators until there are more than ~4 domains.
- Measure: cache-read tokens per wake, stale asks per repo, wake deaths.

**Suggested order:**
1. R1, R2 (this week).
2. R3, R4.
3. R5, R6.
4. R7.
5. R8, R9 as measured experiments.
6. R10 only if R3 and R6 don't stop the drops.

---

## Sources

### Pricing
- Anthropic pricing, fetched 2026-10-14: https://platform.claude.com/docs/en/about-claude/pricing

### Frontier labs
- [L1] Anthropic, *How we built our multi-agent research system*: https://www.anthropic.com/engineering/multi-agent-research-system
- [L2] Anthropic, *Building a C compiler with a team of parallel Claudes* (Carlini, Feb 2026): https://www.anthropic.com/engineering/building-c-compiler
- [L3] Anthropic, *Effective harnesses for long-running agents*: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- [L3] Anthropic, *Harness design for long-running application development* (Mar 2026): https://www.anthropic.com/engineering/harness-design-long-running-apps
- [L4] Anthropic, *The advisor strategy* (Apr 2026): https://claude.com/blog/the-advisor-strategy
- [L5] Claude Code agent teams: https://code.claude.com/docs/en/agent-teams
- [L5] Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- [L5] Claude Code best practices: https://code.claude.com/docs/en/best-practices
- [L6] Anthropic, *Effective context engineering for AI agents*: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- [L6] Anthropic, *Building effective agents*: https://www.anthropic.com/engineering/building-effective-agents
- [L7] Claude Sonnet 4.5, SWE-bench footnote: https://www.anthropic.com/news/claude-sonnet-4-5
- [L7] Haiku 4.5: https://www.anthropic.com/news/claude-haiku-4-5
- [L7] Opus 4.5: https://www.anthropic.com/news/claude-opus-4-5
- [L7] Opus 5: https://www.anthropic.com/news/claude-opus-5
- [L7] Opus 5.5: https://www.anthropic.com/news/claude-opus-5-5
- [L8] OpenAI, *Harness engineering* (Feb 2026): https://openai.com/index/harness-engineering/. Figures via excerpts and InfoQ: https://www.infoq.com/news/2026/02/openai-harness-engineering-codex
- [L9] OpenAI, *Introducing Codex*: https://openai.com/index/introducing-codex/
- [L10] OpenAI, *Scaling code verification* (Dec 2025): https://alignment.openai.com/scaling-code-verification/
- [L11] OpenAI, *A practical guide to building agents* (2025, PDF on cdn.openai.com; via secondary summaries)
- [L12] Google Research, *Towards a science of scaling agent systems*: https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/ and https://arxiv.org/abs/2512.08296. The SWE-bench, Terminal-Bench, overhead and token-efficiency figures are from arXiv v3 (Apr 2026); the blog has the v1 framing (180 configurations, +80.9%).
- [L13] DeepMind, AlphaEvolve: https://deepmind.google/discover/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/
- [L14] DeepMind, CodeMender: https://deepmind.google/blog/introducing-codemender-an-ai-agent-for-code-security/
- [L15] Jules (concurrency limits from press, unverified). AI co-scientist: https://arxiv.org/abs/2502.18864. Gemini CLI subagents: https://geminicli.com/docs/core/subagents/

### Companies
- [C1] Cognition, *Don't build multi-agents*: https://cognition.com/blog/dont-build-multi-agents
- [C2] Cognition, *Multi-agents: what's actually working* (Apr 2026): https://cognition.com/blog/multi-agents-working
- [C3] Cognition, *Devin can now manage Devins*: https://cognition.com/blog/devin-can-now-manage-devins
- [C4] Cognition, *Devin's 2025 performance review*: https://cognition.com/blog/devin-annual-performance-review-2025
- [C5] Cognition, SWE-grep: https://cognition.com/blog/swe-grep
- [C6] Cursor, *Towards self-driving codebases*: https://cursor.com/blog/self-driving-codebases
- [C7] Cursor, *Scaling long-running autonomous coding*: https://cursor.com/blog/scaling-agents
- [C8] Cursor, *Long-running agents*: https://cursor.com/blog/long-running-agents
- [C9] Cursor 2.0: https://cursor.com/blog/2-0
- [C10] Cursor, *Building Bugbot*: https://cursor.com/blog/building-bugbot
- [C11] Factory, Terminal-Bench: https://factory.com/news/terminal-bench
- [C12] Factory, Missions: https://factory.com/news/missions
- [C13] Factory, *How Missions work*: https://factory.com/news/missions-architecture
- [C14] Factory, *Evaluating context compression*: https://factory.com/news/evaluating-compression
- [C15] Amp, Oracle: https://ampcode.com/news/oracle
- [C16] Amp, *The Dial*: https://ampcode.com/news/the-dial
- [C17] Amp, Handoff: https://ampcode.com/news/handoff. Subagents: https://ampcode.com/docs/models-and-subagents
- [C18] GitHub Copilot coding agent: https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/
- [C19] Agent HQ (secondary): https://thenewstack.io/github-agent-hq/
- [C20] GitHub, *60 million Copilot code reviews*: https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/
- [C21] Replit Agent 3 changelog: https://docs.replit.com/updates/2025/09/12/changelog. Architecture via ZenML LLMOps (secondary): https://www.zenml.io/llmops-database/building-reliable-multi-agent-systems-for-application-development
- [C22] OpenHands, critic + inference-time scaling: https://openhands.dev/blog/sota-on-swe-bench-verified-with-inference-time-scaling-and-critic-model
- [C23] OpenHands, *Learning to verify AI-generated code* (Mar 2026): https://openhands.dev/blog/20260305-learning-to-verify-ai-generated-code (arXiv 2603.03800)
- [C24] OpenHands, *Automating massive refactors with parallel agents*: https://www.openhands.dev/blog/automating-massive-refactors-with-parallel-agents
- [C25] Augment, SWE-bench Verified with Claude 3.7 + o1: https://www.augmentcode.com/blog/1-open-source-agent-on-swe-bench-verified-by-combining-claude-3-7-and-o1
- [C26] Augment, *Auggie tops SWE-bench Pro*: https://augmentcode.com/blog/auggie-tops-swe-bench-pro
- [C27] Aider architect/editor: https://aider.chat/2024/09/26/architect.html. Leaderboards: https://aider.chat/docs/leaderboards/
- [C28] Amazon Q Developer agent: https://aws.amazon.com/about-aws/whats-new/2025/04/amazon-q-developer-releases-state-art-agent-feature-development. $260M: https://aws.amazon.com/blogs/devops/amazon-q-developer-just-reached-a-260-million-dollar-milestone
- [C29] Kiro specs: https://kiro.dev/blog/from-chat-to-specs-deep-dive/
- [C30] Roo Boomerang: https://docs.roocode.com/features/boomerang-tasks. Kilo orchestrator mode: https://kilo.ai/docs/basic-usage/orchestrator-mode

### Field data
- [E1] AIDev, *The rise of AI teammates in SE 3.0*: https://arxiv.org/abs/2507.15003
- [E2] *Code change characteristics and description alignment*: https://arxiv.org/abs/2601.17627
- [E3] PRarena via Simon Willison: https://simonwillison.net/2025/Oct/1/prarena/. amplifying.ai tracker (secondary): https://amplifying.ai/coding-agents/github-copilot
- [E4] *Why are agentic PRs merged or rejected?* (unverified): https://arxiv.org/abs/2605.22534
- [E5] Mazloomzadeh et al. (unverified): https://www.alphaxiv.org/abs/2607.21832
- [E6] METR, developer RCT: https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/. Uplift update: https://metr.org/blog/2026-02-24-uplift-update/
- [E7] METR, algorithmic vs holistic evaluation: https://metr.org/blog/2025-08-12-research-update-towards-reconciling-slowdown-with-time-horizons
- [E8] METR, time horizons: https://arxiv.org/abs/2503.14499 and https://metr.org/time-horizons/

### Practitioners (from the first version)
- Simon Willison: https://simonwillison.net/2025/Oct/5/parallel-coding-agents/
- Boris Cherny (secondary): https://developers.slashdot.org/story/26/01/06/2239243/creator-of-claude-code-reveals-his-workflow
- Kilo Code engineers (secondary): https://blog.kilo.ai/p/how-7-kilo-code-engineers-run-up
- Gas Town (Heise): https://www.heise.de/en/background/Full-Control-Gas-Town-Orchestrates-Ten-or-More-Coding-Agents-11178824.html

### Papers
**Role-based multi-agent**
- [P1] MetaGPT: https://arxiv.org/abs/2308.00352
- [P2] ChatDev: https://arxiv.org/abs/2307.07924
- [P3] AgentCoder: https://arxiv.org/abs/2312.13010
- [P4] MapCoder: https://arxiv.org/abs/2405.11403
- [P5] MASAI: https://arxiv.org/abs/2406.11638
- [P6] CodeR: https://arxiv.org/abs/2406.01304
- [P7] HyperAgent: https://arxiv.org/abs/2409.16299
- [P8] MarsCode Agent: https://arxiv.org/abs/2409.00899
- [P9] Magentic-One: https://arxiv.org/abs/2411.04468

**Pipelines and minimal agents**
- [P10] Agentless: https://arxiv.org/abs/2407.01489
- [P11] SWE-agent: https://arxiv.org/abs/2405.15793
- [P12] mini-SWE-agent (README claim): https://github.com/SWE-agent/mini-swe-agent
- [P13] AutoCodeRover: https://arxiv.org/abs/2404.05427
- [P14] Harness ablation, 2026 (abstract): https://arxiv.org/abs/2609.20804

**Test-time scaling and verifiers**
- [P15] Large Language Monkeys: https://arxiv.org/abs/2407.21787
- [P16] CodeMonkeys: https://arxiv.org/abs/2501.14723
- [P17] DEI: https://arxiv.org/abs/2408.07060
- [P18] SWE-Search: https://arxiv.org/abs/2410.20285
- [P19] SWE-Gym: https://arxiv.org/abs/2412.21139
- [P21] R2E-Gym: https://arxiv.org/abs/2504.07164
- [P22] *Thinking longer, not larger*: https://arxiv.org/abs/2503.23803
- [P23] S*: https://arxiv.org/abs/2502.14382
- [P24] *More agents is all you need*: https://arxiv.org/abs/2402.05120
- First version's citations: SWE-World https://arxiv.org/pdf/2602.03419; Agentic Rubrics https://arxiv.org/abs/2601.04171; MacNet https://arxiv.org/abs/2406.07155

**Critique loops and judges**
- [P25] Reflexion: https://arxiv.org/abs/2303.11366
- [P26] Self-Refine: https://arxiv.org/abs/2303.17651
- [P27] Self-Debug: https://arxiv.org/abs/2304.05128
- [P28] *Is self-repair a silver bullet?*: https://arxiv.org/abs/2306.09896
- [P29] *LLMs cannot self-correct reasoning yet*: https://arxiv.org/abs/2310.01798
- [P30] Agent-as-a-Judge: https://arxiv.org/abs/2410.10934

**Failure analysis**
- [P31] MAST, *Why do multi-agent LLM systems fail?*: https://arxiv.org/abs/2503.13657
- Cognition's "share full traces" argument is [C1].

**Routing and planner/executor**
- [P32] FrugalGPT: https://arxiv.org/abs/2305.05176
- [P33] RouteLLM: https://arxiv.org/abs/2406.18665
- [P34] Hybrid LLM: https://arxiv.org/abs/2404.14618
- [P35] SWE-Router: https://arxiv.org/abs/2607.00053
- [P36] Scrouting / SuperScout: https://arxiv.org/abs/2608.04804. This corrects the first version, which cited 2608.13867, a separate monograph, *Engineering Reliable Coding Agents*.
- [P37] Plan-and-Act: https://arxiv.org/abs/2503.09572
- [P38] DCAS (numbers unverified): https://arxiv.org/abs/2608.06113
- Not Diamond (vendor claim): https://www.notdiamond.ai/blog/not-diamond-code-intelligent-model-routing-for-coding-agents

**Benchmarks**
- [P20] SWE-Lancer: https://arxiv.org/abs/2502.12115
- [P39] SWE-bench Pro: https://arxiv.org/abs/2509.16941
- [P40] Multi-SWE-bench: https://arxiv.org/abs/2504.02605

### Not verified, so not relied on
- SWE-bench Verified scores for Opus 5 / 5.5 / Fable 5.x (third-party only).
- codex-1 pass@k, and the GPT-5-Codex review accuracy percentages.
- Jules concurrency limits, and "up to 8 parallel agents" in Cursor.
- Replit's manager / editor / verifier internals and its reliability numbers.
- Bugbot's ~80% resolution in May 2026.
- Devin's "~85% failure on ambiguous tasks".
- TwinRouterBench's "53% cheaper".
- Whether the advisor tool is exposed in the Claude Code CLI.
- The Missions page's publication year.
- E2's exact line-count medians (the paper reports no significant difference).
- That Cursor's lockless peers became "risk-averse" (dropped; the post says the confusion remained).
- The MAST category shares, which are summed from the per-mode figures rather than stated.

### Orca data
- Sources: Postgres `turn`, `workstream` and `instance_metric` (read-only transaction); `~/.orca/ledger.json` (500 records, 2026-10-13 14:45 → 10-14 20:16 UTC); `~/.orca/config.cache.json`; `~/.orca/orchestrator/REQUESTS.md`.
- The analysis scripts are in `/tmp/orca-research/` and were not kept.
