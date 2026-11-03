// E2E for GitHub rate-limit resilience in the UI (Finn 2026-11-02): while the bridge is blocked on a
// GitHub budget, every page shows "GitHub rate limited until HH:MM", and an open PR read from the
// last known state stays on the Agents list with its badges and a "Stale" pill — never as a local
// branch with no PR. Driven against the fake api (tests/apiFake.ts), rendered into a real DOM.
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
const MIN = 60_000;

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
  await act(async () => { await store.refresh(); });
});

const pr = (over: Record<string, unknown>) => ({
  number: 7, title: "Seven", branch: "feat-7", url: "u", state: "OPEN", isDraft: false,
  ciStatus: "failing", reviewStatus: "none", mergeable: "CONFLICTING", autoMergeEnabled: false, externalFeedback: 0, additions: 0, deletions: 0, ...over,
});

test("rate limited: the banner names the reset in local time, and the stale PR keeps its state and its number", async () => {
  const until = Date.now() + 25 * MIN;
  apiFake.githubLimitsData = { limited: [{ resource: "graphql", until }] };
  apiFake.prsData = [pr({ staleAt: Date.now() - 12 * MIN, staleReason: "GitHub rate limited" })];
  await act(async () => { await store.refresh(); });
  await mount();
  const banner = container!.querySelector('[data-slot="github-limit-banner"]');
  const hhmm = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  expect(banner?.textContent).toContain(`GitHub rate limited until ${hhmm}`);
  expect(banner?.textContent).toContain("GraphQL");
  expect(container!.querySelector('[data-testid="pr-stale"]')?.textContent).toContain("Synced 12m ago");
  expect(container!.textContent).toContain("#7");
  expect(container!.textContent).toContain("Conflicts");
});

test("not rate limited: no banner, no stale pill", async () => {
  apiFake.prsData = [pr({})];
  await act(async () => { await store.refresh(); });
  await mount();
  expect(container!.querySelector('[data-slot="github-limit-banner"]')).toBeNull();
  expect(container!.querySelector('[data-testid="pr-stale"]')).toBeNull();
});
