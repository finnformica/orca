// E2E for the dense-view toggle: flipping orca.density to "dense" strips a (non-Done) card down to
// its at-a-glance status — repo, title, and status/condition badges stay, while the prompt, diffstat
// and preview+actions footer are dropped; "comfortable" shows them all. Done cards ignore density
// (already compact). Driven against the fake api (tests/apiFake.ts), rendered into a real DOM. See
// Board.WorkstreamCard + lib/atoms.densityAtom.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { WorkstreamCard } from "@/views/Board";
import { densityAtom } from "@/lib/atoms";
import type { Row } from "@/store";
import { openTip } from "./tip";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);
// Another file's cached r#7 review digest must not decide this card's quick actions.
beforeEach(() => store._resetReviewSignals());

const flush = () => new Promise((r) => setTimeout(r, 0));
// Raw (unescaped) class strings, so we can assert the dense size-down variants are wired on.
const hasClass = (needle: string) => [...container!.querySelectorAll("*")].some((e) => e.getAttribute("class")?.includes(needle));

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(row: Row) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<WorkstreamCard row={row} />); await flush(); await flush(); });
}

const base: Row = {
  repo: "r", hasRemote: true, branch: "dense-1", title: "Add dense view",
  prompt: "Make the board denser", lane: "IN_REVIEW", worktreePath: "/wt/dense-1", prNumber: 7, prUrl: "https://x/7",
  mergeable: "MERGEABLE", ciStatus: "passing",
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  getDefaultStore().set(densityAtom, "comfortable");
  localStorage.clear();
  apiFake.reset();
});

const byAria = (label: string) => container!.querySelector<HTMLElement>(`button[aria-label^="${label}"]`);
const labelledBtn = (label: string) => [...container!.querySelectorAll("button")].some((b) => b.textContent?.trim() === label);

describe("dense view", () => {
  test("comfortable (default) shows the prompt, diffstat and full labelled actions", async () => {
    apiFake.summaryData = { files: [{}, {}], commits: [{}], additions: 12, deletions: 3 };
    await mount({ ...base, lane: "MERGEABLE", reviewStatus: "approved" });
    expect(container!.textContent).toContain("Make the board denser"); // prompt
    expect(container!.textContent).toContain("2 files"); // diffstat
    // Labelled toolbar (text buttons), not icon-only.
    expect(labelledBtn("Follow up")).toBe(true);
    expect(container!.textContent).toContain("Test on"); // "Test on <instance>" now that previews can be placed (the fake config has two instances)
    // Approved and clean: the state-aware quick actions (workstream.quickActions) — icon-only with a
    // tooltip, on the preview line immediately LEFT of Test: Merge and Enable auto-merge (GitHub's).
    expect(byAria("Merge")).not.toBeNull();
    expect(byAria("Enable auto-merge")).not.toBeNull();
    expect(labelledBtn("Enable auto-merge")).toBe(false);
    const quick = container!.querySelector<HTMLElement>('[data-slot="quick-actions"]')!;
    expect(quick.nextElementSibling!.textContent).toContain("Test on");
    expect(openTip(byAria("Enable auto-merge")!).textContent).toBe("Enable auto-merge");
    // Full-size badges — no dense size-down variant.
    expect(hasClass("[data-slot=badge]]:text-[10px]")).toBe(false);
  });

  test("dense folds the toolbar into icon buttons: Test locally, Follow up, Merge, Actions", async () => {
    getDefaultStore().set(densityAtom, "dense");
    apiFake.summaryData = { files: [{}, {}], commits: [{}], additions: 12, deletions: 3 };
    await mount({ ...base, lane: "MERGEABLE", reviewStatus: "approved" });
    // At-a-glance status survives.
    expect(container!.textContent).toContain("Add dense view"); // title
    expect(container!.textContent).toContain("CI"); // condition badge
    expect(container!.querySelector('[href="https://x/7"]')).not.toBeNull(); // PR destination link
    // Every verb is an icon button (found by aria-label), and none renders its text label.
    expect(byAria("Test locally")).not.toBeNull();
    expect(byAria("Follow up")).not.toBeNull();
    // Approved and clean: Merge now AND Enable auto-merge, never Merge when green (not a quick action
    // any more — Orca's queue merges what it can by itself) and never Slack.
    expect(container!.querySelector('button[aria-label="Merge"]')).not.toBeNull();
    expect(byAria("Enable auto-merge")).not.toBeNull();
    expect(byAria("Merge when green")).toBeNull();
    // The quick icons come first, immediately left of the Test control.
    const quick = container!.querySelector<HTMLElement>('[data-slot="quick-actions"]')!;
    expect(quick.nextElementSibling!.contains(byAria("Test locally"))).toBe(true);
    expect(byAria("Actions")).not.toBeNull();
    expect(labelledBtn("Follow up")).toBe(false);
    expect(container!.textContent).not.toContain("Test locally"); // label hidden, icon only
    expect(labelledBtn("Enable auto-merge")).toBe(false);
    // Detail is gone; badges shrink.
    expect(container!.textContent).not.toContain("Make the board denser"); // prompt
    expect(container!.textContent).not.toContain("2 files"); // diffstat
    expect(hasClass("[data-slot=badge]]:text-[10px]")).toBe(true);
  });

  test("a Done card ignores dense (stays as-is)", async () => {
    getDefaultStore().set(densityAtom, "dense");
    await mount({ ...base, lane: "DONE", mergedAt: new Date().toISOString() });
    expect(container!.textContent).toContain("Add dense view");
    expect(container!.textContent).toContain("merged"); // Done cards render their normal merged line
  });
});
