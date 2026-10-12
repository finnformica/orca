// The instance cards (views/Vitals.InstanceCard) on the Overview and the Usage page — the header
// chip's replacement. The machine list comes from config, which lands AFTER first paint, so the
// cards must appear when it does (the chip once read config at mount and stayed invisible). Each
// card shows the machine's vitals as a details grid and CPU % / memory GB as line graphs from
// /api/health/history over a chosen range — one shared poll per machine and range, via poll(), so a
// slow history call can't pile more behind it and nothing polls once the card is gone.
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";

apiFake.holdConfig = true; // before the store's import, so config is still in flight at mount
const store = await import("@/store");
const { Overview } = await import("@/views/Overview");
const { InstanceCard } = await import("@/views/Vitals");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined; let container: HTMLElement | undefined;
afterEach(async () => { await act(async () => { root?.unmount(); }); container?.remove(); apiFake.reset(); });

async function render(node: React.ReactNode) {
  container = document.createElement("div"); document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); });
}
const ready = async () => {
  if (apiFake.releaseConfig) apiFake.releaseConfig();
  await act(async () => { await store.configReady; await flush(); await flush(); });
};
const detail = (card: Element, slot: string) => card.querySelector(`[data-slot="${slot}"]`)!.textContent;

test("a card per machine appears once config names them, with each one's vitals and cost", async () => {
  await render(<Overview />);
  // Run alone, the hold catches the config fetch and this is the race. In the whole suite the store
  // module is already loaded by an earlier file, so only the "renders once config is in" half applies.
  if (apiFake.releaseConfig) expect(container!.querySelector('[data-slot="instance-cloud"]')).toBeNull();
  await ready();
  const cloud = container!.querySelector('[data-slot="instance-cloud"]')!;
  expect(cloud).toBeTruthy();
  expect(container!.querySelector('[data-slot="instance-laptop"]')).toBeTruthy();
  expect(detail(cloud, "instance-status")).toContain("Online");
  expect(detail(cloud, "instance-cpu")).toContain("12%");
  expect(detail(cloud, "instance-mem")).toContain("3.1 / 15.3 GB");
  expect(detail(cloud, "instance-cost")).toContain("$1.23");
});

test("CPU and memory as line graphs from the last 24h, labelled with the newest values; the range picker refetches", async () => {
  const now = Date.now();
  apiFake.healthHistoryData = [0, 1, 2].map((i) => ({ at: now - (2 - i) * 60_000, cpuPct: [5, 40, 23][i], load1: 0.1, memUsedGb: [2, 2.5, 4.2][i], memTotalGb: 15.3 }));
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  expect(apiFake.healthHistoryCalls).toEqual([{ instance: "cloud", hours: 24 }]);
  const cpu = container!.querySelector('[data-slot="chart-cpu"]')!;
  const mem = container!.querySelector('[data-slot="chart-mem"]')!;
  expect(cpu.querySelector('[data-slot="chart-value"]')!.textContent).toBe("23%");
  expect(mem.querySelector('[data-slot="chart-value"]')!.textContent).toBe("4.2 GB");
  expect(cpu.querySelector("polyline")!.getAttribute("points")!.split(" ")).toHaveLength(3);
  expect(mem.querySelector("polyline")).toBeTruthy();
  expect(cpu.querySelector("svg")!.getAttribute("aria-label")).toBe("CPU, now 23%");
  // 6h / 24h / 7d: another range is another fetch at that many hours.
  const range = (label: string) => [...container!.querySelectorAll('[role="group"][aria-label="Range"] button')].find((b) => b.textContent === label)!;
  expect(range("24h").getAttribute("aria-pressed")).toBe("true");
  await act(async () => { range("7d").dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });
  expect(apiFake.healthHistoryCalls.at(-1)).toEqual({ instance: "cloud", hours: 168 });
  expect(range("7d").getAttribute("aria-pressed")).toBe("true");
});

test("no history yet says so instead of an empty chart", async () => {
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  expect(container!.textContent).toContain("No history recorded yet");
  expect(container!.querySelector('[data-slot="chart-cpu"]')).toBeNull();
});

test("the history poll waits for a slow call to settle, and stops when the card goes away", async () => {
  // poll(), not setInterval: the next 60s tick is scheduled only after a fetch settles, so a slow
  // history call can't queue more behind it on the bridge's six connections.
  const realSet = window.setTimeout, realClear = window.clearTimeout;
  const minuteTimers = new Set<unknown>();
  window.setTimeout = ((fn: () => void, ms?: number) => { const t = realSet(fn, ms); if (ms === 60_000) minuteTimers.add(t); return t; }) as typeof window.setTimeout;
  window.clearTimeout = ((t?: number) => { minuteTimers.delete(t); realClear(t); }) as typeof window.clearTimeout;
  try {
    apiFake.holdHealthHistory = true;
    await render(<InstanceCard instance="cloud" here={false} />);
    await ready();
    expect(apiFake.healthHistoryCalls).toHaveLength(1);
    expect(minuteTimers.size).toBe(0); // in flight: no next tick yet
    await act(async () => { apiFake.releaseHealthHistory!(); await flush(); await flush(); });
    expect(minuteTimers.size).toBe(1); // settled: exactly one next tick
    await act(async () => { root?.unmount(); root = undefined; await flush(); });
    expect(minuteTimers.size).toBe(0); // gone: no more history fetches
    expect(apiFake.healthHistoryCalls).toHaveLength(1);
  } finally {
    window.setTimeout = realSet; window.clearTimeout = realClear;
  }
});
