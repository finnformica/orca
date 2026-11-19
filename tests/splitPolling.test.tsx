// Local-agent status, open PRs, enrichment and merged history come in ONE board call (store.ts,
// GET /api/board), merged history only on a TTL. Each part keeps its own {ok} and `live` is the merge
// of the parts' LATEST GOOD values, so one part's transient failure never reads as "those branches
// are gone" and never drops what another part retained. Driven against the real store.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { overviewStats } from "@/workstream";

beforeAll(() => store.configReady); // config repo is "r"
beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(() => apiFake.reset());

test("a branch that exists only as an open PR still lands on the board", async () => {
  apiFake.prsData = [{ branch: "haspr", number: 7, title: "Has PR", url: "u", isDraft: false }]; // agents stream is empty
  apiFake.enrichmentData.set("r::haspr", { prompt: "still open" });

  await store.refresh();

  expect(store.enrichmentFor("r", "haspr").prompt).toBe("still open");
});

// The Overview's flicker: a failed poll stored `[]` as that stream's value, so the repo's rows left the
// board for one cycle — Open PRs read 0, Running read 0 and Recent activity went empty — then came
// back on the next good poll. The rows (not only the enrichment mirror) must survive the failure.
test("a failed PR poll keeps the PR rows the last good poll had", async () => {
  apiFake.prsData = [{ branch: "haspr", number: 7, title: "Has PR", url: "u", isDraft: false }];
  await store.refresh();
  const before = store.assembleRows().find((r) => r.branch === "haspr");
  expect(before?.prNumber).toBe(7);
  expect(overviewStats(store.assembleRows()).prs.total).toBe(1);

  apiFake.prsError = "network blip";
  await store.refresh(); // agents + merged settle cleanly, PRs fail

  // `live` still carries the retained PR slice, so the row and its count don't blink out.
  expect(store.assembleRows().find((r) => r.branch === "haspr")?.prNumber).toBe(7);
  expect(overviewStats(store.assembleRows()).prs.total).toBe(1);

  apiFake.prsError = null;
  apiFake.prsData = [];
  await store.refresh(); // a GOOD answer that the PR is gone still removes it
  expect(store.assembleRows().find((r) => r.branch === "haspr")).toBeUndefined();
});

test("a failed agents poll keeps the running rows the last good poll had", async () => {
  apiFake.worktrees.set("busy", { branch: "busy", worktreePath: "/wt/busy" }); // the fake reports it running
  await store.refresh();
  expect(overviewStats(store.assembleRows()).running).toBe(1);

  apiFake.agentsError = "network blip";
  await store.refresh();
  expect(store.assembleRows().find((r) => r.branch === "busy")?.agentStatus).toBe("running");
  expect(overviewStats(store.assembleRows()).running).toBe(1);

  apiFake.agentsError = null;
  apiFake.worktrees.clear();
  await store.refresh();
  expect(store.assembleRows().find((r) => r.branch === "busy")).toBeUndefined();
});

test("one board call per poll; merged PRs only when asked", async () => {
  const before = store.clientPollCounts();
  await store.pollBoard();
  expect(apiFake.boardCalls).toEqual([{ merged: false }]); // ONE call for every repo, not four per repo
  expect(store.clientPollCounts().agents).toBe(before.agents + 1);
  expect(store.clientPollCounts().merged).toBe(before.merged); // the tick reads merged PRs on a TTL

  await store.refresh(); // after a mutation: the merged list too
  expect(apiFake.boardCalls).toEqual([{ merged: false }, { merged: true }]);
  expect(store.clientPollCounts().merged).toBe(before.merged + 1);
});

test("a refresh during a poll without merged PRs gets them in the chained poll", async () => {
  apiFake.holdPrs = true;
  const tick = store.pollBoard(); // in flight, no merged PRs
  await Promise.resolve();
  const after = store.refresh(); // a merge just landed: this must read the merged list
  apiFake.releasePrs!();
  await Promise.all([tick, after]);
  expect(apiFake.boardCalls).toEqual([{ merged: false }, { merged: true }]);
});

test("a failed part keeps its last good value; the other parts still land", async () => {
  apiFake.prsData = [{ branch: "haspr", number: 7, title: "Has PR", url: "u", isDraft: false }];
  await store.refresh();
  apiFake.prsError = "network blip";
  apiFake.enrichmentData.set("r::haspr", { prompt: "new prompt" });
  await store.refresh();
  expect(store.assembleRows().find((r) => r.branch === "haspr")?.prNumber).toBe(7);
  expect(store.enrichmentFor("r", "haspr").prompt).toBe("new prompt"); // the enrichment part was good
});

// Last in the file: the fallback is remembered for the page's life (the bridge does not change under it).
test("a bridge older than /api/board: the per-repo calls, the same rows", async () => {
  apiFake.boardError = "not found";
  apiFake.prsData = [{ branch: "oldpr", number: 9, title: "Old bridge", url: "u", isDraft: false }];
  await store.refresh();
  expect(store.assembleRows().find((r) => r.branch === "oldpr")?.prNumber).toBe(9);
  apiFake.boardCalls = [];
  await store.refresh();
  expect(apiFake.boardCalls).toEqual([]); // asked once, then the per-repo calls only
});
