# Orca — manual QA runbook

The automated spec (`tests/workflow.test.ts`, W1–W7) runs `git` against a scratch repo and a
fake `gh`. This runbook is the same seven steps against **real** GitHub + Slack, to catch
integration issues the fakes can't. Run it before shipping anything that touches the
adapters or routes.

## Setup

1. Pick a throwaway GitHub repo you can open real PRs against. Set `ORCA_REPO_PATH`,
   `ORCA_WORKTREE_ROOT`, `ORCA_BASE_BRANCH`, and Slack env vars (see README).
2. `gh auth status` → logged in. `bun run dev` → open the UI.

## W1 — create-worktree

- **Agents** tab → fill title (e.g. "QA dark mode") + a prompt → **Create worktree**.
- ✅ A card appears (state `DRAFTING`). **Copy prompt** puts your prompt on the clipboard.
- Spot-check: `git -C $ORCA_REPO_PATH worktree list` shows the new worktree + branch.

## W2 — change-summary → READY

- In the worktree (`cd` to the path on the card), make a commit.
- Click **Refresh** on the card.
- ✅ Summary shows the right files and `+/−`; badge flips to `READY`.

## W3 — promote-to-pr

- Click **Promote to PR** (enabled once `READY`).
- ✅ A real PR opens (check `gh pr view` / GitHub). The card moves to the **PRs** kanban in
  `IN_REVIEW`; `#<number>` links to the PR.

## W4 — poll-status

- Let CI run / add a review on GitHub. Wait for the 15s poll (or reload).
- ✅ Card shows CI + review + mergeable, and lands in the right column:
  green → `MERGEABLE`, changes requested → `CHANGES_REQUESTED`, conflicts → `CONFLICTED`.

## W5 — merge-when-green

- On a `MERGEABLE` card, click **Merge**.
- ✅ PR merges (verify on GitHub); card → `MERGED`; the worktree is removed
  (`git worktree list` no longer shows it). On a non-green PR the button isn't offered, and
  the API refuses with 409 if forced.

## W6 — slack-notify-and-bump

- On an open PR card, click **Slack notify**.
- ✅ A message posts to the configured channel; the button becomes **Bump**.
- Click **Bump** → ✅ replies in-thread (bot token) or re-posts (webhook). The button is
  visually flagged only once older than `staleHours`.

## W7 — fix-conflicts

- Create a conflict on the base branch so the PR becomes `CONFLICTED`.
- ✅ Card shows **Copy rebase prompt**; the copied text names the branch + base.
- Resolve/rebase, push. After the next poll ✅ the card leaves `CONFLICTED`.

## N — notifications

- Run an agent on a card (W1's). When it finishes ✅ a toast pops bottom-right (above the orchestrator
  launcher): the card's title, **Finished**, the outcome's first line, "just now", **Open**, ×. It
  hides itself after ~6s. ✅ The bell at the sidebar's foot shows **1**.
- Send a follow-up that ends in a question for you (e.g. "Ask me which colour to use before doing
  anything"). ✅ A **Needs input** toast that stays until dismissed; **Open** lands on the card's page.
- Stop a running agent from its chat. ✅ A **Stopped** toast. Break the repo's `checkCommand` and have
  the agent commit. ✅ **Check failed** beside the run's own toast.
- Start three runs that finish close together. ✅ The stack collapses to the top toast with two peeks
  and "3 notifications"; hover expands it; **Clear all** empties the corner but ✅ the bell's count
  stays.
- Start a preview. ✅ **Preview ready** with the URL once every service answers; **Open preview**
  opens it. Point a service at a bad command. ✅ **Preview failed** with the log's last line.
- Open the bell. ✅ Rows grouped **Today / Yesterday / date**, unread dots, the kind chips filter, a
  click marks read and opens; **Mark all read** clears the count; **Clear all** empties the centre on
  BOTH machines (refresh the other).
- Settings → Notifications: **Do not disturb** on ✅ no toasts, the centre still fills; untick
  **Finished** ✅ only that kind stops popping; **Browser notifications** on, hide the tab, make an
  agent fail ✅ a system notification, click brings the tab back on the card.
- With two instances: finish a run on the box ✅ the laptop's tab pops it once (no duplicate after a
  bridge restart on the box while the run was in flight).

## S — shortcuts, palette, Ask the orchestrator

Automated in `tests/shortcuts.test.tsx` (S1–S5); by hand, in a real browser on Mac and non-Mac:

- `⌘K` (Ctrl+K) → ✅ the palette opens, even with the caret in a composer; `⌘K` again closes it.
  Type part of a workstream title, `#<pr>`, `usage`, `new` → ✅ the best match is first; ↑/↓ wrap,
  Enter runs it. Reopen → ✅ what you ran leads under **Recent**. On an agent page → ✅ **Start
  preview: …** starts that branch's preview and lands on its Preview tab.
- Outside a field: `C` → New agent, `O` → the orchestrator with its composer focused, `F` → Find,
  `⌘B` → the sidebar collapses (reload: ✅ still collapsed), `?` → the shortcuts sheet, Esc → closes
  whichever is open. The browser's own `⌘B` / Downloads never fires.
- In the Find box or any composer, type `c`, `o`, `f`, `?` → ✅ they're just text.
- Top bar, every page: **Ask the orchestrator**. Click → ✅ the window opens focused. Type "what is
  running?" into it → ✅ the window opens with that text after any earlier draft, caret at the end,
  nothing sent. Pop the window out (Chrome/Edge), then ask from the top bar → ✅ the text lands in
  the PiP window.
- Tooltips show the keys: Add New (C), Collapse sidebar (⌘B / Ctrl+B), Ask the orchestrator (O).

## Agents list — condensed row, right-click, live timer

Open **Agents** (List view) with a few workstreams, at least one running and one with a PR.

- ✅ Header reads Workstream · Status · PR · Checks & review · (Instance, with two instances) ·
  Updated. No branch / latest-instruction / model-avatar columns; hovering a title shows the latest
  instruction and the branch.
- Resize the window to **1280px** wide with the sidebar expanded (then 1440, 1920). ✅ No horizontal
  scrollbar on the list; long titles and errors truncate with an ellipsis and show in full on hover.
- ✅ The subline under the title reads `repo · Opus 5.5` (a readable model name, never `O5` / `CF`);
  hovering it says which model the last run used and, if re-pinned, the next one.
- A running row shows a spinning loader and `m:ss` elapsed that ticks every second. ✅ Other rows
  don't flicker (React DevTools "highlight updates": only the running rows' status cells repaint).
- Right-click a row. ✅ A menu opens at the pointer with the same items as its ⋯ (Open, Open PR,
  Copy branch, Follow up, PR ▸ Address PR / Add preview, Move to <instance>, Close PR / Discard…),
  in the Geist menu style. ↑/↓ move, Enter runs, **Esc** closes, a click outside closes. Right-click
  on the PR # link still gives the browser's own menu.
- Tab to a row, press the **menu key** (or Shift+F10). ✅ The same menu opens under the row; Enter on
  a focused row opens its agent page.

- Pick a couple of chips, type a search, choose a sort, switch to Board and dense, then reload
  `/agents` with no query. ✅ The same chips come back and are in the URL, the search, sort, view and
  density too. Open a link like `/agents?pr=mergeable` instead: ✅ the link wins (and is what's
  remembered next). **Clear** ✅ empties chips and search, and a reload stays clear. Switching the
  top bar's repo ✅ remembers filters per repo. (Keys: `orca.ui.v1.*` in DevTools → Local Storage.)

## Teardown

Delete the test PRs/branches and remove any leftover worktrees:
`git -C $ORCA_REPO_PATH worktree prune`.
