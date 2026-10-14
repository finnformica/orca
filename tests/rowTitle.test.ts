// Precedence for a workstream row's title (web/src/workstream.ts `rowTitle`): the workstream's own
// title always wins, so a card never flips once its PR loads — the PR title and branch name are
// fallbacks for a branch Orca didn't title itself (e.g. one created outside Orca).
import { expect, test } from "bun:test";
import { rowTitle } from "@/workstream";

test("the workstream's own title wins over the PR title", () => {
  expect(rowTitle("Chat history up arrow", "chore: bump deps and fix lints", "orca/chat-history-up-arrow")).toBe("Chat history up arrow");
});

test("the PR title is used when the workstream has no title of its own", () => {
  expect(rowTitle(undefined, "Fix flaky retry test", "someone-elses-branch")).toBe("Fix flaky retry test");
});

test("the branch name is the last resort when neither a workstream nor a PR title exists", () => {
  expect(rowTitle(undefined, undefined, "orca/some-branch")).toBe("orca/some-branch");
});

test("an empty workstream title (not just undefined) still falls through to the PR title", () => {
  expect(rowTitle("", "Fix flaky retry test", "branch")).toBe("Fix flaky retry test");
});
