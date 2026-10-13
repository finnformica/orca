// E2E for the PR status pill's auto-merge override (web/src/workstream.ts `prPill`, on the Agents
// list row's "state-pill"): an open PR armed for auto-merge — by GitHub's own autoMergeRequest, or
// by Orca's merge-when-green queue mark (#169, stored on the branch's enrichment) — reads "Auto-merge"
// in purple instead of "In review"/"Mergeable", unless CI is actually failing, in which case the
// ordinary review-state pill wins. Driven against the fake api (tests/apiFake.ts), real DOM.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  navigate("/agents");
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });
}

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
  localStorage.clear();
  navigate("/");
  await act(async () => { await store.refresh(); }); // clear the shared store's live PRs so we don't leak rows into other test files
});

const pr = (over: Record<string, unknown>) => ({
  number: 1, title: "feat", branch: "feat-x", url: "u", state: "OPEN", isDraft: false,
  ciStatus: "none", reviewStatus: "none", mergeable: "MERGEABLE", autoMergeEnabled: false, ...over,
});
const statePill = () => container!.querySelector("[data-slot='state-pill']");

test("GitHub auto-merge armed on an in-review PR shows a purple Auto-merge state-pill, not In review", async () => {
  apiFake.prsData = [pr({ branch: "feat-am", autoMergeEnabled: true })];
  await act(async () => { await store.refresh(); });
  await mount();
  expect(statePill()?.textContent).toBe("Auto-merge");
  expect(statePill()?.className).toContain("purple");
});

test("Orca's merge-when-green mark alone (no GitHub auto-merge) also shows Auto-merge", async () => {
  apiFake.prsData = [pr({ branch: "feat-mwg" })];
  apiFake.enrichmentData.set("r::feat-mwg", { mergeWhenGreen: { by: "user", at: Date.now() } });
  await act(async () => { await store.refresh(); });
  await mount();
  expect(statePill()?.textContent).toBe("Auto-merge");
});

test("failing CI keeps the ordinary In review pill even with auto-merge armed", async () => {
  apiFake.prsData = [pr({ branch: "feat-red", autoMergeEnabled: true, ciStatus: "failing" })];
  await act(async () => { await store.refresh(); });
  await mount();
  expect(statePill()?.textContent).toBe("In review");
});

test("a plain PR with neither signal shows the ordinary In review pill", async () => {
  apiFake.prsData = [pr({ branch: "feat-plain" })];
  await act(async () => { await store.refresh(); });
  await mount();
  expect(statePill()?.textContent).toBe("In review");
});
