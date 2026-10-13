// The board's side of changelog-only conflicts (server/git.ts `mergeBaseUnioningChangelogs`): Address
// PR and Resolve conflicts ask the bridge to merge the base first, and only hand the agent what's left.
// The bridge's own merge is covered end to end in changelogConflict.test.ts; here the store's decision.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { apiFake } from "./apiFake";
import * as store from "@/store";

beforeAll(() => store.configReady);
afterEach(async () => {
  localStorage.clear();
  apiFake.reset();
  await store.refresh();
});

const pr: store.Row = {
  repo: "r", hasRemote: true, branch: "feat", title: "Feat", prompt: "", lane: "IN_REVIEW",
  worktreePath: "/wt/feat", agentProvider: "claude", sessionId: "s", prNumber: 7, mergeable: "CONFLICTING",
};

test("CL-S1: a conflicting PR whose only conflict was the changelog starts no agent", async () => {
  apiFake.settleResult = { outcome: "resolved", files: ["CHANGELOG.md"] };
  await store.addressPr(pr, false); // Follow's call — the one that re-ran five times on branch-demo #6189
  await store.addressPr(pr);        // and the button
  expect(apiFake.settleCalls).toEqual(["feat", "feat"]);
  expect(apiFake.agentLaunches).toEqual([]);
});

test("CL-S2: settled, but CI is failing — the agent still runs, with no conflict section", async () => {
  apiFake.settleResult = { outcome: "resolved", files: ["CHANGELOG.md"] };
  await store.addressPr({ ...pr, ciStatus: "failing", failingChecks: ["test"] });
  expect(apiFake.agentLaunches).toHaveLength(1);
  expect(apiFake.agentLaunches[0]!.prompt).not.toContain("## Merge conflicts");
  expect(apiFake.agentLaunches[0]!.prompt).toContain("## Failing CI");
});

test("CL-S3: a mixed conflict falls back to the agent with the conflict section", async () => {
  apiFake.settleResult = { outcome: "conflict", files: ["CHANGELOG.md", "src/app.ts"] };
  await store.addressPr(pr);
  expect(apiFake.agentLaunches).toHaveLength(1);
  expect(apiFake.agentLaunches[0]!.prompt).toContain("## Merge conflicts");
});

test("CL-S4: no conflict, nothing outstanding — a manual Address PR still runs, and nothing is merged first", async () => {
  await store.addressPr({ ...pr, mergeable: "MERGEABLE" });
  expect(apiFake.settleCalls).toEqual([]);
  expect(apiFake.agentLaunches).toHaveLength(1);
});

test("CL-S5: Resolve conflicts on a local branch settles a changelog-only conflict without an agent", async () => {
  apiFake.settleResult = { outcome: "resolved", files: ["CHANGELOG.md"] };
  await store.resolveConflicts({ ...pr, prNumber: undefined, mergeable: undefined, mergeClean: "conflict" });
  expect(apiFake.agentLaunches).toEqual([]);
  apiFake.settleResult = { outcome: "conflict", files: ["src/app.ts"] };
  await store.resolveConflicts({ ...pr, prNumber: undefined, mergeable: undefined, mergeClean: "conflict" });
  expect(apiFake.agentLaunches).toHaveLength(1);
});
