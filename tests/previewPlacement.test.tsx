// Previews are placed by you, independent of where the session lives (store.testLocally): a laptop
// short on CPU runs the preview on the box and opens it over the tailnet. The fake api has two
// instances (local = here, cloud). The placement lives on the SERVER (enrichment's
// `previewInstance`, written by the bridge that starts the preview) — a refreshed page, or a phone,
// is just a view of it; this drives store.ts directly, without the UI (see previewCell.test.tsx for
// the Agents-list row's own rendering of these states).
import { afterEach, beforeAll, expect, test } from "bun:test";
import { apiFake } from "./apiFake";
import * as store from "@/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);
afterEach(() => { apiFake.reset(); });

const HERE = "laptop"; // the fake config's own instance name (tests/apiFake.ts); the other is "cloud"
const localRow: store.Row = { repo: "r", hasRemote: true, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat" };
const cloudRow: store.Row = { ...localRow, branch: "cfeat", worktreePath: "/opt/wt/cfeat", instance: "cloud", remote: true };

test("a session's preview defaults to its own instance; the store sends that placement with the start", async () => {
  await store.testLocally(cloudRow);
  expect(apiFake.adoptCalls).toEqual([]); // its worktree is already on cloud
  expect(apiFake.previewCalls).toEqual([{ key: "/opt/wt/cfeat", instance: "cloud" }]);
  await store.testLocally(localRow);
  expect(apiFake.previewCalls.at(-1)).toEqual({ key: "/wt/feat", instance: HERE });
});

test("choosing the other instance adopts the branch there and starts the preview there", async () => {
  await store.testLocally(cloudRow, HERE);
  expect(apiFake.adoptCalls).toEqual([{ repo: "r", branch: "cfeat", instance: HERE }]); // a second worktree, here
  expect(apiFake.previewCalls).toEqual([{ key: "/wt/cfeat", instance: HERE }]);
});

test("starting records the placement server-side; it survives a re-hydrate and the stop targets it", async () => {
  apiFake.worktrees.set("feat", { branch: "feat", worktreePath: "/wt/feat" });
  await store.testLocally(localRow, "cloud");
  await store.refresh(); // the mirror is rebuilt from the server, not from this tab's memory
  expect(store.enrichmentFor("r", "feat").previewInstance).toMatchObject({ instance: "cloud", key: "/wt/feat" });
  await store.previewStatus("/wt/feat");
  expect(apiFake.previewStatusCalls.at(-1)).toEqual({ key: "/wt/feat", instance: "cloud" });
  await store.stopPreview("/wt/feat");
  expect(apiFake.previewStopCalls).toEqual([{ key: "/wt/feat", instance: "cloud" }]);
});
