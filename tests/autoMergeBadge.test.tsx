// E2E for the auto-merge indicator on the Agents list row (server/gh.listPrs → store
// Row.autoMergeEnabled → Agents.tsx's PR-cell state pill): an open PR with GitHub auto-merge armed
// shows the purple "Auto-merge" state pill, and the Checks & review column's condition badges do
// not repeat it there — it is already shown in the PR column (Finn). Driven against the fake api
// (tests/apiFake.ts), rendered into a real DOM.
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
  navigate("/agents"); // the Agents list: each PR row carries the card's condition badges
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
const badge = (label: string) =>
  [...container!.querySelectorAll("[data-slot='badge']")].find((b) => b.textContent?.trim().startsWith(label));
const statePill = (label: string) =>
  [...container!.querySelectorAll("[data-slot='state-pill']")].find((b) => b.textContent?.trim().startsWith(label));

test("open PR with auto-merge armed shows the Auto-merge state pill, with no duplicate badge", async () => {
  apiFake.prsData = [pr({ number: 1, branch: "feat-am", autoMergeEnabled: true })];
  await act(async () => { await store.refresh(); });
  await mount();
  expect(statePill("Auto-merge")).not.toBeUndefined();
  expect(badge("Auto-merge")).toBeUndefined();
});

test("open PR without auto-merge shows no Auto-merge pill or badge", async () => {
  apiFake.prsData = [pr({ number: 2, branch: "feat-plain", autoMergeEnabled: false })];
  await act(async () => { await store.refresh(); });
  await mount();
  expect(statePill("Auto-merge")).toBeUndefined();
  expect(badge("Auto-merge")).toBeUndefined();
});
