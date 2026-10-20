// Local-agent status, open PRs, and merged history poll as three independent streams (store.ts).
// Each keeps its own {ok} and `live` is the merge of the three streams' LATEST GOOD values, so one
// stream's transient failure never reads as "those branches are gone" and never drops what another
// stream retained. Driven against the real store.
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

test("agents and PR streams poll independently of merged history", async () => {
  const before = store.clientPollCounts();
  await store.pollAgents();
  const afterAgents = store.clientPollCounts();
  expect(afterAgents.agents).toBe(before.agents + 1);
  expect(afterAgents.prs).toBe(before.prs); // pollAgents does not drag the PR or merged streams along

  await store.pollPrs();
  expect(store.clientPollCounts().prs).toBe(afterAgents.prs + 1);
  expect(store.clientPollCounts().merged).toBe(afterAgents.merged);
});
