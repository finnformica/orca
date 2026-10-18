// The PR menu's "Merge when green" (store.mergeWhenGreen): marks the PR for Orca's own merge queue
// (server/mergeQueue.ts — exercised end to end in mergeQueue.test.ts) through the same route the
// orchestrator's `orca merge --when-green` uses, naming the branch so the mark lands on its card.
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { apiFake } from "./apiFake";
import * as store from "@/store";

beforeAll(() => store.configReady);
beforeEach(() => { apiFake.calls.length = 0; });

test("Merge when green marks the row's PR by number and branch; a row with no PR is a no-op", async () => {
  await store.mergeWhenGreen({ repo: "orca", branch: "feat-x", prNumber: 7 } as store.Row);
  expect(apiFake.calls).toContain("mergeWhenGreen:7:feat-x");
  apiFake.calls.length = 0;
  await store.mergeWhenGreen({ repo: "orca", branch: "local-only" } as store.Row);
  expect(apiFake.calls.filter((c) => c.startsWith("mergeWhenGreen"))).toEqual([]);
});

// The existing "Disable auto-merge" action is the one way to cancel either mechanism: GitHub's own
// auto-merge, or the mark the Enable-auto-merge fallback left on Orca's own merge-when-green queue
// when GitHub refused it (server/mergeQueue.ts).
test("Disable auto-merge cancels whichever mechanism is actually active", async () => {
  await store.disableAutoMerge({ repo: "orca", branch: "feat-x", prNumber: 7, mergeWhenGreen: { by: "user", at: 0 } } as store.Row);
  expect(apiFake.calls).toContain("cancelMergeWhenGreen:7:feat-x");
  expect(apiFake.calls.filter((c) => c.startsWith("disableAutoMerge"))).toEqual([]);

  apiFake.calls.length = 0;
  await store.disableAutoMerge({ repo: "orca", branch: "feat-y", prNumber: 8, autoMergeEnabled: true } as store.Row);
  expect(apiFake.calls).toContain("disableAutoMerge:8");
  expect(apiFake.calls.filter((c) => c.startsWith("cancelMergeWhenGreen"))).toEqual([]);
});
