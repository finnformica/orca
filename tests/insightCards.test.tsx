// The Overview's Insights section (views/Insights.tsx) against the fake api: four cards that hold
// their shape as skeletons until /api/insights answers, the Spend card adding each machine's hourly
// cost (from the /api/health poll the instance cards already run) to the agent spend by category, a
// range picker that refetches, a breakdown toggle, and the limit forecast from /api/usage. Every
// estimate says so on hover.
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import { InsightsSection } from "@/views/Insights";
import { insightRangeAtom } from "@/lib/atoms";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, insights, type InsightRun } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined; let container: HTMLElement | undefined;
afterEach(async () => { await act(async () => { root?.unmount(); }); container?.remove(); apiFake.reset(); getDefaultStore().set(insightRangeAtom, 7); });

async function render() {
  container = document.createElement("div"); document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<InsightsSection machines={["cloud"]} here="cloud" />); await flush(); await flush(); });
}
const $ = (sel: string) => container!.querySelector(sel);
const text = (sel: string) => $(sel)?.textContent ?? "";

const NOW = Date.now();
const run = (over: Partial<InsightRun>): InsightRun => ({ runId: String(Math.random()), repo: "app", branch: "b", orchestrated: false, provider: "claude", status: "done", startedAt: NOW - 60_000, finishedAt: NOW - 30_000, ...over });
const DATA = insights([
  run({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH, costUsd: 3, model: "Opus 5.5" }),
  run({ branch: "w", title: "Worker", orchestrated: true, costUsd: 2, model: "Sonnet 5.5", check: "passed" }),
  run({ branch: "mine", repo: "api", costUsd: 1, model: "Sonnet 5.5", status: "error" }),
  run({ branch: "cx", provider: "codex", model: "Codex" }),
], { days: 7, now: NOW, tzOffsetMin: new Date().getTimezoneOffset() });

test("before the aggregate answers, all four cards are there as skeletons — no numbers, nothing to shift", async () => {
  await render();
  for (const slot of ["insight-spend", "insight-runs", "insight-breakdown", "insight-forecast"]) expect($(`[data-slot="${slot}"]`)).toBeTruthy();
  expect($('[data-slot="spend-total"]')).toBeNull();
  expect(container!.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(8);
  expect(apiFake.insightsCalls).toEqual([{ days: 7, tz: new Date().getTimezoneOffset(), repo: undefined, on: undefined }]);
});

test("Spend: orchestrator, workers, your runs and the box, each with its basis on hover, totalled as an estimate", async () => {
  apiFake.insightsData = DATA as unknown as Record<string, unknown>;
  // The box's rate from /api/health: $0.25/h billed since well before the range — 7 days' worth at most.
  apiFake.healthData = { instance: "cloud", hostname: "h", cores: 4, cpuPct: 1, load1: 0, load5: 0, memUsedGb: 1, memTotalGb: 2, uptimeS: 1, at: NOW, cost: { monthUsd: 1, hourlyUsd: 0.25, sinceIso: "2026-01-01T00:00:00Z", billingSince: "2026-01-01T00:00:00Z" } };
  await render();
  const row = (k: string) => $(`[data-slot="spend-${k}"]`)!;
  expect(row("orchestrator").textContent).toContain("$3.00");
  expect(row("workers").textContent).toContain("$2.00");
  expect(row("direct").textContent).toContain("$1.00");
  expect(row("direct").textContent).toContain("2 runs");
  const box = row("box:cloud");
  expect(box.textContent).toContain("Cloud box");
  expect(box.getAttribute("title")).toContain("$0.25/h");
  const boxUsd = Number(box.textContent!.match(/\$(\d+\.\d\d)/)![1]);
  expect(boxUsd).toBeGreaterThan(36); // 6 days and some of today at 0.25
  expect(boxUsd).toBeLessThanOrEqual(42);
  expect(text('[data-slot="spend-total"]')).toBe(`~$${(6 + boxUsd).toFixed(2)}`);
  // Honest labelling: the pill and every agent row say what the number is, and unpriced runs are counted.
  expect($('[data-slot="estimate-pill"]')!.getAttribute("title")).toContain("not what a subscription login is billed");
  expect(row("workers").getAttribute("title")).toMatch(/^Estimated: runs on workstreams the orchestrator/);
  expect(text('[data-slot="spend-footnote"]')).toContain("1 run reported no cost");
});

test("Runs: success rate, check pass rate and median, bars per day; the range picker refetches and is remembered", async () => {
  apiFake.insightsData = DATA as unknown as Record<string, unknown>;
  await render();
  expect(text('[data-slot="success-rate"] [data-slot="figure-value"]')).toBe("75%"); // 3 done, 1 failed
  expect(text('[data-slot="check-rate"] [data-slot="figure-value"]')).toBe("100%");
  expect(text('[data-slot="check-rate"]')).toContain("1 of 1 commits");
  expect(text('[data-slot="median-run"] [data-slot="figure-value"]')).toBe("30s");
  expect(text('[data-slot="runs-total"]')).toBe("4 in the last 7 days");
  expect(container!.querySelectorAll('[data-slot="run-bar"]')).toHaveLength(7);
  expect(container!.querySelector('[data-slot="run-bar"]:last-child title')!.textContent).toContain("4 runs: 3 done, 1 failed");

  const range = (label: string) => [...container!.querySelectorAll('[aria-label="Insights range"] button')].find((b) => b.textContent === label)!;
  await act(async () => { range("Today").dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });
  expect(apiFake.insightsCalls.at(-1)!.days).toBe(1);
  expect(getDefaultStore().get(insightRangeAtom)).toBe(1);
});

test("Where it went: by model by default, by repo or workstream on the toggle; ranked by cost, then agent time", async () => {
  apiFake.insightsData = DATA as unknown as Record<string, unknown>;
  await render();
  const rows = () => [...container!.querySelectorAll('[data-slot="breakdown-row"]')].map((r) => [r.querySelector("span.relative > span")!.textContent, r.querySelector('[data-slot="breakdown-value"]')!.textContent]);
  expect(rows()).toEqual([["Sonnet 5.5", "$3.00"], ["Opus 5.5", "$3.00"], ["Codex", "$0.00"]]); // a tie goes to more agent time
  const by = (label: string) => [...container!.querySelectorAll('[aria-label="Break down by"] button')].find((b) => b.textContent === label)!;
  await act(async () => { by("Repo").dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(rows()).toEqual([["app", "$2.00"], ["api", "$1.00"]]);
  await act(async () => { by("Workstream").dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(rows()[0]).toEqual(["Orchestrator", "$3.00"]);
});

test("Limit forecast: each window projected at its burn rate, labelled as a projection", async () => {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  apiFake.usageData = { claude: { fiveHour: { utilization: 60, resetsAt: at(2.5 * 3_600_000) }, sevenDay: { utilization: 10, resetsAt: at(3.5 * 86_400_000) }, extra: null }, codex: null };
  await render();
  const rows = [...container!.querySelectorAll('[data-slot="forecast-row"]')];
  expect(rows.map((r) => r.getAttribute("data-state"))).toEqual(["will-hit", "ok"]);
  expect(rows[0]!.textContent).toMatch(/runs out in ~1h 40m/);
  expect(rows[1]!.textContent).toContain("on pace for ~20% at reset");
  expect($('[data-slot="projection-pill"]')!.getAttribute("title")).toContain("average rate since the window opened");
});
