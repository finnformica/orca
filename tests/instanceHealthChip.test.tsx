// The header's cloud-box chip reads the other instance from config, which lands AFTER the header's
// first paint — so the chip has to re-render when it does. It once read config at mount only and
// stayed invisible for good (the user "couldn't see any cloud box status").
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";

apiFake.holdConfig = true; // before the store's import, so config is still in flight at mount
const store = await import("@/store");
const { InstanceHealthChip } = await import("@/App");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined; let container: HTMLElement | undefined;
afterEach(async () => { await act(async () => { root?.unmount(); }); container?.remove(); apiFake.reset(); });

test("the chip appears once config names another instance, and shows its vitals and cost", async () => {
  container = document.createElement("div"); document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<InstanceHealthChip />); await flush(); });
  // Run alone, the hold catches the config fetch and this is the race. In the whole suite the store
  // module is already loaded by an earlier file, so only the "renders once config is in" half applies.
  if (apiFake.releaseConfig) {
    expect(container.querySelector('[data-slot="instance-health"]')).toBeNull(); // config not in yet — nothing to show
    apiFake.releaseConfig();
  }
  await act(async () => { await store.configReady; await flush(); await flush(); });
  const chip = container.querySelector('[data-slot="instance-health"]')!;
  expect(chip).toBeTruthy();
  expect(chip.textContent).toContain("cloud");
  expect(chip.textContent).toContain("cpu 12%");
  expect(chip.textContent).toContain("$1.23");
});

test("the popover graphs the last 24h of cpu and memory, labelled with the newest values", async () => {
  const now = Date.now();
  apiFake.healthHistoryData = [0, 1, 2].map((i) => ({ at: now - (2 - i) * 60_000, cpuPct: [5, 40, 23][i], load1: 0.1, memUsedGb: [2, 2.5, 4.2][i], memTotalGb: 15.3 }));
  container = document.createElement("div"); document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<InstanceHealthChip />); await flush(); });
  if (apiFake.releaseConfig) apiFake.releaseConfig();
  await act(async () => { await store.configReady; await flush(); await flush(); });
  const chip = container.querySelector('[data-slot="instance-health"]') as HTMLElement;
  const line = chip.textContent;
  expect(apiFake.healthHistoryCalls).toHaveLength(0); // nothing fetched until the popover opens
  await act(async () => { chip.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })); chip.click(); await flush(); await flush(); });
  expect(apiFake.healthHistoryCalls).toEqual([{ instance: "cloud", hours: 24 }]);
  const cpu = document.querySelector('[data-slot="health-chart-cpu"]')!;
  const mem = document.querySelector('[data-slot="health-chart-mem"]')!;
  expect(cpu.querySelector('[data-slot="health-chart-value"]')!.textContent).toBe("23%");
  expect(mem.querySelector('[data-slot="health-chart-value"]')!.textContent).toBe("4.2 / 15.3 GB");
  expect(cpu.querySelector("polyline")!.getAttribute("points")!.split(" ")).toHaveLength(3);
  expect(mem.querySelector("polyline")).toBeTruthy();
  expect(chip.textContent).toBe(line); // the one-line chip is unchanged
});
