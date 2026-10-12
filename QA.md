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

## Teardown

Delete the test PRs/branches and remove any leftover worktrees:
`git -C $ORCA_REPO_PATH worktree prune`.
