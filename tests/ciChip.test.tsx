// The CI chip's hover card (views/PrPanels.tsx CiChip/CiPanel): the same generic HoverCard the
// review cluster uses (Review.tsx, PRs 190-196), listing a PR's checks failing-first, then
// pending, then passing, with skipped checks collapsed into one count. Checks already in hand (the
// PR page's own prDetail fetch) are reused as-is; a row that only has `ciStatus` (the Agents list,
// the Board's cards) fetches lazily — only once the chip's hover card opens — and caches the result.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { Agents } from "@/views/Agents";
import { PrDetail } from "@/views/PrDetail";
import { CiPanel } from "@/views/PrPanels";
import { navigate } from "@/lib/route";
import type { CheckRow } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const CHECKS: CheckRow[] = [
  { name: "lint", status: "failing" },
  { name: "build", status: "failing", url: "https://ci/build" },
  { name: "e2e", status: "pending", startedAt: "2026-10-13T10:00:00Z", completedAt: "0001-01-01T00:00:00Z" },
  { name: "unit", status: "passing", startedAt: "2026-10-13T10:00:00Z", completedAt: "2026-10-13T10:00:42Z", url: "https://ci/unit" },
  { name: "typecheck", status: "passing" },
  { name: "windows", status: "passing", skipped: true },
  { name: "deploy-preview", status: "passing", skipped: true },
];

const rowsOf = (card: Element) => [...card.querySelectorAll<HTMLElement>('[data-slot="check"]')].map((r) => `${r.getAttribute("data-status")}:${r.querySelector("span")!.textContent}`);

let root: Root | undefined;
let container: HTMLElement | undefined;
const flush = () => new Promise((r) => setTimeout(r, 0));
async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
}
// Opens (and closes) the same way the review cluster's own hover card test does — focus doubles as
// hover minus touch, and is also how a keyboard user reaches it.
async function focusChip(chip: HTMLElement) {
  await act(async () => { chip.focus(); await new Promise((r) => setTimeout(r, 200)); });
}
async function blurChip(chip: HTMLElement) {
  await act(async () => { chip.blur(); await new Promise((r) => setTimeout(r, 150)); });
}
afterEach(async () => {
  apiFake.reset();
  store._resetChecksCache();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  navigate("/");
});

describe("CiPanel: order and grouping (pure-ish — a mounted component, no network)", () => {
  test("failing first, then pending, then passing, each by name; skipped collapses into one count, never listed", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => { root = createRoot(container!); root.render(<CiPanel checks={CHECKS} />); });
    const card = container.querySelector('[data-slot="ci-panel"]')!;
    expect(rowsOf(card)).toEqual(["failing:build", "failing:lint", "pending:e2e", "passing:typecheck", "passing:unit"]);
    const skipped = card.querySelector('[data-slot="checks-skipped"]')!;
    expect(skipped.textContent).toBe("2 skipped");
    expect(card.querySelectorAll('[data-slot="check"]')).toHaveLength(5); // the 2 skipped never render a row of their own
    // Duration (when known) and a link to the run ride the same CheckLine the PR page's Checks card uses.
    const unit = [...card.querySelectorAll('[data-slot="check"]')].find((r) => r.textContent?.includes("unit"))!;
    expect(unit.textContent).toContain("42s");
    expect(unit.querySelector<HTMLAnchorElement>('a[aria-label="Logs for unit"]')!.href).toBe("https://ci/unit");
    expect(card.textContent).toContain("2 failing · 1 running · 2 passing · 2 skipped"); // the aside summary
  });

  test("no checks at all", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => { root = createRoot(container!); root.render(<CiPanel checks={[]} />); });
    expect(container.textContent).toContain("No checks.");
  });
});

describe("the CI chip, wherever it renders", () => {
  const pr = (over: Record<string, unknown>) => ({
    number: 8, title: "feat", branch: "feat-ci", url: "https://x/8", state: "OPEN", isDraft: false,
    ciStatus: "failing", reviewStatus: "review_required", mergeable: "MERGEABLE", autoMergeEnabled: false, ...over,
  });

  test("the Agents list: no fetch just from rendering; hovering the chip fetches the PR's checks once and caches them", async () => {
    apiFake.prsData = [pr({})];
    apiFake.prDetailData = { checks: CHECKS };
    await mount(<Agents />);
    const row = container!.querySelector<HTMLElement>('[data-branch="feat-ci"]')!;
    expect(apiFake.calls.filter((c) => c === "prDetail:8")).toEqual([]); // the chip alone never fetches
    const chip = row.querySelector<HTMLElement>('[data-slot="ci-chip"]')!;
    expect(chip.dataset.status).toBe("failing");
    expect(chip.getAttribute("aria-label")).toBe("CI failing");
    expect(chip.textContent).toContain("CI");

    await focusChip(chip);
    const panel = document.querySelector<HTMLElement>('[data-slot="ci-panel"]')!;
    expect(panel).not.toBeNull();
    expect(rowsOf(panel)).toEqual(["failing:build", "failing:lint", "pending:e2e", "passing:typecheck", "passing:unit"]);
    expect(panel.querySelector('[data-slot="checks-skipped"]')!.textContent).toBe("2 skipped");
    await blurChip(chip);
    expect(apiFake.calls.filter((c) => c === "prDetail:8")).toEqual(["prDetail:8"]); // fetched exactly once

    // A second hover reads the cache — no second request.
    await focusChip(chip);
    expect(document.querySelector('[data-slot="ci-panel"]')).not.toBeNull();
    await blurChip(chip);
    expect(apiFake.calls.filter((c) => c === "prDetail:8")).toEqual(["prDetail:8"]);
  });

  test("while the lazy fetch is in flight, the hover card says Loading — never 'No checks.' (that reads as a real, checks-free PR)", async () => {
    apiFake.prsData = [pr({})];
    apiFake.prDetailData = { checks: CHECKS };
    apiFake.holdPrDetail = true;
    await mount(<Agents />);
    const chip = container!.querySelector<HTMLElement>('[data-branch="feat-ci"] [data-slot="ci-chip"]')!;
    await focusChip(chip);
    expect(document.querySelector('[data-slot="ci-panel-loading"]')!.textContent).toBe("Loading checks…");
    expect(document.querySelector('[data-slot="ci-panel"]')).toBeNull();
    await act(async () => { apiFake.releasePrDetail?.(); await flush(); await flush(); });
    const panel = document.querySelector<HTMLElement>('[data-slot="ci-panel"]')!;
    expect(rowsOf(panel)).toEqual(["failing:build", "failing:lint", "pending:e2e", "passing:typecheck", "passing:unit"]);
    await blurChip(chip);
  });

  test("a chip with no CI signal yet (ciStatus: none) renders nothing", async () => {
    apiFake.prsData = [pr({ ciStatus: "none" })];
    await mount(<Agents />);
    const row = container!.querySelector<HTMLElement>('[data-branch="feat-ci"]')!;
    expect(row.querySelector('[data-slot="ci-chip"]')).toBeNull();
  });

  test("the PR detail page: the chip already has pr.checks from the page's own load — hovering fetches nothing new", async () => {
    apiFake.prDetailData = { checks: CHECKS, number: 70, ciStatus: "failing" };
    await mount(<PrDetail repo="r" number={70} sub="overview" />);
    const before = apiFake.calls.filter((c) => c === "prDetail:70").length;
    expect(before).toBe(1); // the page's own load
    const chip = container!.querySelector<HTMLElement>('[data-slot="ci-chip"]')!;
    expect(chip.dataset.status).toBe("failing");
    await focusChip(chip);
    const panel = document.querySelector<HTMLElement>('[data-slot="ci-panel"]')!;
    expect(rowsOf(panel)).toEqual(["failing:build", "failing:lint", "pending:e2e", "passing:typecheck", "passing:unit"]);
    await blurChip(chip);
    expect(apiFake.calls.filter((c) => c === "prDetail:70").length).toBe(before); // no extra fetch
  });
});
