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

## Teardown

Delete the test PRs/branches and remove any leftover worktrees:
`git -C $ORCA_REPO_PATH worktree prune`.
