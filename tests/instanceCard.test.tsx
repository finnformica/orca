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
import { openTip } from "./tip";

apiFake.holdConfig = true; // before the store's import, so config is still in flight at mount
const store = await import("@/store");
const { Overview } = await import("@/views/Overview");
const { InstanceCard, RefreshVitals } = await import("@/views/Vitals");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined; let container: HTMLElement | undefined;
afterEach(async () => { await act(async () => { root?.unmount(); }); container?.remove(); apiFake.reset(); localStorage.clear(); });

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
  // This month's cost — the rate over the hours it was up — marked as an estimate when IMDS supplied
  // the type; the rate × hours behind it is the tooltip.
  expect(detail(cloud, "instance-cost")).toBe("Cost · this month$5.52est.");
  const costValue = cloud.querySelector<HTMLElement>('[data-slot="instance-cost"] .tabular-nums')!;
  expect(openTip(costValue).textContent).toBe("$0.23/h est. (m7i.xlarge) × 23.7 h up this month (UTC), from the machine's boot ledger");
});

const lastValue = (chart: Element) => chart.querySelector('[data-slot="chart-value"]')!.textContent;
const linePoints = (chart: Element) => chart.querySelector("polyline")!.getAttribute("points")!.split(" ");

test("CPU and memory as line graphs from the last 24h, ending on the live reading the header shows; the range picker refetches", async () => {
  const now = Date.now();
  apiFake.healthHistoryData = [0, 1, 2].map((i) => ({ at: now - (2 - i) * 60_000 - 1000, cpuPct: [5, 40, 23][i], load1: 0.1, memUsedGb: [2, 2.5, 4.2][i], memTotalGb: 15.3, runningAgents: 0 }));
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  expect(apiFake.healthHistoryCalls).toEqual([{ instance: "cloud", hours: 24 }]);
  const card = container!.querySelector('[data-slot="instance-cloud"]')!;
  const cpu = container!.querySelector('[data-slot="chart-cpu"]')!;
  const mem = container!.querySelector('[data-slot="chart-mem"]')!;
  // The live reading (12%, 3.1 GB) is newer than the last recorded sample (23%, 4.2 GB): it is the
  // header's stat AND the line's last point — one sample, not a minute-old one beside a fresher one.
  expect(detail(card, "instance-cpu")).toContain("12%");
  expect(lastValue(cpu)).toBe("12%");
  expect(detail(card, "instance-mem")).toContain("3.1 / 15.3 GB");
  expect(lastValue(mem)).toBe("3.1 GB");
  expect(cpu.querySelector("figcaption")!.textContent).toBe("CPU12%"); // main's caption: label left, value right
  expect(linePoints(cpu)).toHaveLength(4); // three recorded + the live one
  expect(cpu.querySelector("svg")!.getAttribute("aria-label")).toBe("CPU, now 12%");
  // 6h / 24h / 7d: another range is another fetch at that many hours.
  const range = (label: string) => [...container!.querySelectorAll('[role="group"][aria-label="Range"] button')].find((b) => b.textContent === label)!;
  expect(range("24h").getAttribute("aria-pressed")).toBe("true");
  await act(async () => { range("7d").dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });
  expect(apiFake.healthHistoryCalls.at(-1)).toEqual({ instance: "cloud", hours: 168 });
  expect(range("7d").getAttribute("aria-pressed")).toBe("true");
});

test("the header stat equals the chart's last point when the recorded sample is the newer one — and at 7d, not a bucket's mean", async () => {
  const now = Date.now();
  // A week of minute samples (10k, downsampled to 300 buckets of ~34 minutes) ending on a spike; the
  // live reading is older than it (a remote box whose last health answer was a while ago).
  apiFake.healthHistoryData = Array.from({ length: 10_080 }, (_, i) => ({
    at: now - (10_079 - i) * 60_000 - 1000, cpuPct: i === 10_079 ? 97 : 10, load1: 0.1, memUsedGb: i === 10_079 ? 9.9 : 2, memTotalGb: 15.3, runningAgents: i === 10_079 ? 5 : 1,
  }));
  apiFake.healthData = { instance: "cloud", hostname: "orca-box", cores: 4, cpuPct: 50, load1: 2, load5: 1, memUsedGb: 6, memTotalGb: 15.3, uptimeS: 9, at: now - 10 * 60_000, runningAgents: 3 };
  localStorage.setItem("orca.ui.v1.instanceRange:cloud", "168");
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  const card = container!.querySelector('[data-slot="instance-cloud"]')!;
  const cpu = card.querySelector('[data-slot="chart-cpu"]')!;
  expect(detail(card, "instance-cpu")).toContain("97%");
  expect(lastValue(cpu)).toBe("97%");
  expect(lastValue(card.querySelector('[data-slot="chart-mem"]')!)).toBe("9.9 GB");
  expect(detail(card, "instance-mem")).toContain("9.9 / 15.3 GB");
  expect(lastValue(card.querySelector('[data-slot="chart-agents"]')!)).toBe("5");
  expect(linePoints(cpu).length).toBeLessThanOrEqual(300);
  expect(linePoints(cpu).at(-1)!.split(",")[1]).toBe("3.6"); // 97% of a 120px axis, drawn raw
});

test("each machine's range is remembered per machine across a reload; bad JSON or an unknown range falls back to 24h", async () => {
  const range = (label: string) => [...container!.querySelectorAll('[role="group"][aria-label="Range"] button')].find((b) => b.textContent === label)!;
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  expect(range("24h").getAttribute("aria-pressed")).toBe("true"); // default when nothing is saved
  await act(async () => { range("6h").dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });
  expect(localStorage.getItem("orca.ui.v1.instanceRange:cloud")).toBe("6");
  // A reload: the remount restores 6h and fetches it straight away.
  await act(async () => { root?.unmount(); }); container?.remove(); apiFake.healthHistoryCalls.length = 0;
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  expect(range("6h").getAttribute("aria-pressed")).toBe("true");
  expect(apiFake.healthHistoryCalls).toEqual([{ instance: "cloud", hours: 6 }]);
  // Another machine keeps its own choice.
  await act(async () => { root?.unmount(); }); container?.remove();
  await render(<InstanceCard instance="laptop" here={false} />);
  await ready();
  expect(range("24h").getAttribute("aria-pressed")).toBe("true");
  for (const bad of ["{nope", "13", '"6"']) {
    await act(async () => { root?.unmount(); }); container?.remove();
    localStorage.setItem("orca.ui.v1.instanceRange:cloud", bad);
    await render(<InstanceCard instance="cloud" here={false} />);
    await ready();
    expect(range("24h").getAttribute("aria-pressed")).toBe("true");
  }
});

test("no history yet says so instead of an empty chart", async () => {
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  expect(container!.textContent).toContain("No history recorded yet");
  expect(container!.querySelector('[data-slot="chart-cpu"]')).toBeNull();
});

test("CPU and memory stay one line each, as on main; Agents is a chart of the same design beside them", async () => {
  const now = Date.now();
  apiFake.healthHistoryData = [0, 1, 2].map((i) => ({
    at: now - (2 - i) * 60_000 - 1000, cpuPct: [5, 40, 23][i], load1: 0.1, memUsedGb: [2, 2.5, 4.2][i], memTotalGb: 15.3, runningAgents: [0, 2, 1][i], diskUsedGb: [30, 31, 32][i],
  }));
  apiFake.healthData = { instance: "cloud", hostname: "orca-box", cores: 4, cpuPct: 12, load1: 0.5, load5: 0.4, memUsedGb: 3.1, memTotalGb: 15.3, uptimeS: 9, at: now, runningAgents: 3,
    disk: { usedGb: 35.7, totalGb: 144.3 }, rate: { hourlyUsd: 36, source: "config" }, month: { usd: 12, upHours: 0.33, since: 0 } };
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  const chart = (slot: string) => container!.querySelector(`[data-slot="${slot}"]`)!;
  for (const slot of ["chart-cpu", "chart-mem", "chart-agents"]) {
    // One line, the left axis and its three gridlines — no overlay, no right-hand axis, no marks.
    expect(chart(slot).querySelectorAll("polyline")).toHaveLength(1);
    expect(chart(slot).querySelectorAll(".text-muted-foreground.flex.w-8")).toHaveLength(1);
    expect(chart(slot).querySelectorAll(".text-muted-foreground.flex.w-8 span")).toHaveLength(3);
    expect(chart(slot).querySelectorAll("svg line")).toHaveLength(3);
    // The same caption, axis and tick-row markup as CPU's.
    expect(chart(slot).querySelector("figcaption")!.className).toBe(chart("chart-cpu").querySelector("figcaption")!.className);
    expect(chart(slot).lastElementChild!.className).toBe(chart("chart-cpu").lastElementChild!.className);
  }
  expect(chart("chart-agents").querySelector("figcaption")!.textContent).toBe("Agents3"); // the live count
  expect([...chart("chart-agents").querySelectorAll(".text-muted-foreground.flex.w-8 span")].map((e) => e.textContent)).toEqual(["8", "4", "0"]); // fixed top of 8 until the data outgrows it
  expect(chart("chart-agents").querySelector("polyline")!.getAttribute("stroke")).toBe("var(--geist-pink)");
  // No Disk used chart any more (Finn: the header's Disk cell is enough); the figure still shows there.
  expect(container!.querySelector('[data-slot="chart-disk"]')).toBeNull();
  expect(container!.querySelector('[data-slot="instance-cloud"]')!.textContent).toContain("35.7 / 144.3 GB");
  // No Bridge memory chart (Finn: the box's memory is what matters; the row still records the RSS).
  expect(container!.querySelector('[data-slot="chart-bridge"]')).toBeNull();
  // The constant-rate cost ramp is gone; the month's cost is the details cell.
  expect(container!.querySelector('[data-slot="chart-cost"]')).toBeNull();
  expect(detail(container!, "instance-cost")).toBe("Cost · this month$12.00");
  expect(apiFake.healthHistoryCalls).toEqual([{ instance: "cloud", hours: 24 }]); // one poll feeds all four
});

test("an agent run OOM-killed in its scope is a red mark on the Memory chart, counted in its caption", async () => {
  const now = Date.now();
  apiFake.healthHistoryData = [0, 1, 2, 3].map((i) => ({
    at: now - (3 - i) * 60_000 - 1000, cpuPct: 50, load1: 2, memUsedGb: 12, memTotalGb: 15.3, runningAgents: 4, ...(i === 1 ? { oomKills: 2 } : i === 3 ? { oomKills: 1 } : {}),
  }));
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  const mem = container!.querySelector('[data-slot="chart-mem"]')!;
  const marks = [...mem.querySelectorAll('[data-slot="chart-mark"]')];
  expect(marks).toHaveLength(2);
  expect(marks.map((m) => m.getAttribute("stroke"))).toEqual(["var(--geist-red)", "var(--geist-red)"]);
  expect(marks.map((m) => m.querySelector("title")!.textContent)).toEqual(["2 agent runs out of memory", "1 agent run out of memory"]);
  expect(mem.querySelector('[data-slot="chart-oom"]')!.textContent).toBe(" · 3 OOM kills");
  // Only on the Memory chart.
  expect(container!.querySelectorAll('[data-slot="chart-mark"]')).toHaveLength(2);
});

test("a machine with no rate (the laptop) shows no cost, and no history of OOM kills means no marks", async () => {
  const now = Date.now();
  apiFake.healthHistoryData = [0, 1].map((i) => ({ at: now - (1 - i) * 60_000 - 1000, cpuPct: 30, load1: 0.1, memUsedGb: 2, memTotalGb: 15.3, diskUsedGb: 16 }));
  apiFake.healthData = { instance: "local", hostname: "mac", cores: 8, cpuPct: 30, load1: 0.5, load5: 0.4, memUsedGb: 2, memTotalGb: 15.3, uptimeS: 9, at: now, runningAgents: 0,
    rate: { hourlyUsd: 0, source: "none" } };
  await render(<InstanceCard instance="local" here={false} />);
  await ready();
  expect(detail(container!, "instance-cost")).toBe("Cost · this month—");
  expect(container!.querySelector('[data-slot="chart-mark"]')).toBeNull();
  expect(container!.querySelector('[data-slot="chart-oom"]')).toBeNull();
  expect(lastValue(container!.querySelector('[data-slot="chart-mem"]')!)).toBe("2.0 GB");
});

test("a bridge that sends no runningAgents, rate, month or disk (an older build) still renders: zero agents, no cost", async () => {
  const now = Date.now();
  apiFake.healthHistoryData = [0, 1].map((i) => ({ at: now - (1 - i) * 60_000 - 1000, cpuPct: 30, load1: 0.1, memUsedGb: 2, memTotalGb: 15.3 }));
  apiFake.healthData = { instance: "cloud", hostname: "orca-box", cores: 4, cpuPct: 30, load1: 0.5, load5: 0.4, memUsedGb: 2, memTotalGb: 15.3, uptimeS: 9, at: now };
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  expect(container!.querySelector('[data-slot="chart-cpu"]')!.querySelectorAll("polyline")).toHaveLength(1);
  expect(lastValue(container!.querySelector('[data-slot="chart-agents"]')!)).toBe("0");
  expect(container!.querySelector('[data-slot="chart-disk"]')).toBeNull();
  expect(detail(container!, "instance-cost")).toBe("Cost · this month—");
});

test("a box missing crash protections says which and how to fix it, with its last OOM kill; a hardened box shows nothing", async () => {
  const now = Date.now();
  const base = { instance: "cloud", hostname: "orca-box", cores: 4, cpuPct: 30, load1: 0.5, load5: 0.4, memUsedGb: 2, memTotalGb: 7.6, uptimeS: 9, at: now };
  apiFake.healthData = { ...base, protections: { missing: [{ key: "swap", label: "no swap" }, { key: "watchdog", label: "no watchdog" }], lastOomKill: now - 3 * 3_600_000, at: now } };
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  const strip = container!.querySelector('[data-slot="protections-warning"]')!;
  expect(strip.getAttribute("data-warn")).toBe("true");
  expect(strip.textContent).toContain("Crash protection missing: no swap, no watchdog. Last OOM kill 3h ago");
  expect(strip.textContent).toContain("sudo deploy/harden.sh");
  await act(async () => { root?.unmount(); });
  container?.remove();
  apiFake.healthData = { ...base, protections: { missing: [], lastOomKill: null, at: now } };
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  expect(container!.querySelector('[data-slot="protections-warning"]')).toBeNull();
});

test("the Instances refresh button refetches health and history at once, spinning until they answer", async () => {
  await render(<><RefreshVitals /><InstanceCard instance="cloud" here={false} /></>);
  await ready();
  expect(apiFake.healthHistoryCalls).toHaveLength(1);
  apiFake.healthData = { instance: "cloud", hostname: "orca-box", cores: 4, cpuPct: 77, load1: 3, load5: 1, memUsedGb: 3.1, memTotalGb: 15.3, uptimeS: 9, at: Date.now(), runningAgents: 0 };
  apiFake.holdHealthHistory = true;
  const button = container!.querySelector<HTMLButtonElement>('[data-slot="instances-refresh"]')!;
  // It sits just under the sticky top bar (z-30): its tooltip opens BELOW the button, never up under the bar.
  const tip = openTip(button).closest('[data-slot="tip-content"]')!;
  expect(tip.getAttribute("data-side")).toBe("bottom");
  await act(async () => { button.click(); await flush(); });
  expect(apiFake.healthHistoryCalls).toHaveLength(2);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.disabled).toBe(true);
  await act(async () => { apiFake.releaseHealthHistory!(); await flush(); await flush(); });
  expect(button.getAttribute("aria-busy")).toBe("false");
  expect(detail(container!.querySelector('[data-slot="instance-cloud"]')!, "instance-cpu")).toContain("77%");
});

test("the machine graphs show a skeleton, sized like the chart, while history is still loading", async () => {
  apiFake.holdHealthHistory = true;
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  expect(container!.querySelector('[data-slot="chart-cpu-skeleton"]')).toBeTruthy();
  expect(container!.querySelector('[data-slot="chart-mem-skeleton"]')).toBeTruthy();
  expect(container!.querySelector('[data-slot="chart-cpu"]')).toBeNull();
  await act(async () => { apiFake.releaseHealthHistory!(); await flush(); await flush(); });
  expect(container!.querySelector('[data-slot="chart-cpu-skeleton"]')).toBeNull();
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

test("a long heavy-command queue scrolls inside the card (a ScrollArea with a height cap), and a long command shrinks in its row", async () => {
  const now = Date.now();
  const rows = (n: number, state: "run" | "q") => Array.from({ length: n }, (_, i) => ({ id: `${state}${i}`, kind: "test", command: `npx jest src/a-very-long-path/${i}/component.test.tsx --maxWorkers=1`, branch: `orca/branch-${i}`, queuedAt: now - i, ...(state === "run" ? { startedAt: now } : {}) }));
  apiFake.healthData = { instance: "cloud", hostname: "orca-box", cores: 4, cpuPct: 30, load1: 0.5, load5: 0.4, memUsedGb: 2, memTotalGb: 15.3, uptimeS: 9, at: now,
    heavy: { running: rows(3, "run"), queued: rows(11, "q"), limits: {}, cpu: { used: 3, budget: 3 }, memory: { used: 8, budget: 8 } } };
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  const queue = container!.querySelector('[data-slot="heavy-queue"]')!;
  expect(queue.textContent).toContain("CPU 3 / 3");
  expect(queue.textContent).toContain("Memory 8 / 8 GB");
  // Every row sits in the ScrollArea's viewport, whose height is capped: the card does not grow.
  const viewport = queue.querySelector('[data-slot="scroll-area"] [data-slot="scroll-area-viewport"]')!;
  expect(viewport.className).toContain("max-h-64");
  expect(viewport.querySelectorAll('[data-slot="heavy-row"]')).toHaveLength(14);
  // On a desktop the command's tooltip wrapper shrinks with the row, so a long command truncates.
  const tip = viewport.querySelector('[data-slot="heavy-command"]')!.parentElement!;
  expect(tip.getAttribute("data-slot")).toBe("tip");
  expect(tip.className).toContain("min-w-0");
  expect(tip.className).toContain("flex-1");
  // The full command is the shadcn tooltip, never a native title.
  expect(queue.querySelector("[title]")).toBeNull();
  expect(openTip(tip.querySelector('[data-slot="heavy-command"]') as HTMLElement).textContent).toMatch(/^npx jest src\/a-very-long-path\/\d+\/component.test.tsx --maxWorkers=1$/);
});

// The 15 s ring (/api/health/live) for ranges up to 6 hours: the whole box, no split by workstream.
const liveRing = (now: number) => ({
  stepMs: 15_000, cores: 4, memTotalGb: 15.3, sliceMaxGb: 8.4, diskCapMBs: 125,
  samples: [0, 1, 2].map((i) => ({
    at: now - (2 - i) * 15_000, work: [20, 10, 15][i]!, iowait: [5, 80, 2][i]!, load1: [1, 6, 2][i]!,
    readMBs: [3, 130, 1][i]!, writeMBs: [1, 2, 0.5][i]!, memUsedGb: [3, 3.5, 4][i]!, memCacheGb: 5, ...(i === 1 ? { ooms: 1 } : {}),
  })),
});
const pickRange = async (label: string) => {
  const b = [...container!.querySelectorAll('[role="group"][aria-label="Range"] button')].find((x) => x.textContent === label)!;
  await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });
};
const bands = (chart: Element) => [...chart.querySelectorAll('[data-slot="chart-band"]')].map((g) => g.getAttribute("data-band"));
const legend = (chart: Element) => chart.querySelector('[data-slot="chart-legend"]')!.textContent;

test("up to 6 hours the card reads the 15 s ring: CPU work + hatched iowait, memory used + cache under the agents limit, disk IO under its cap", async () => {
  const now = Date.now();
  apiFake.healthLiveData = liveRing(now);
  apiFake.healthHistoryData = [{ at: now - 60_000, cpuPct: 50, load1: 2, memUsedGb: 12, memTotalGb: 15.3, runningAgents: 2 }];
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  expect(apiFake.healthLiveCalls).toEqual([]); // 24h: the 1-minute history only
  await pickRange("1h");
  expect(apiFake.healthLiveCalls.at(-1)).toEqual({ instance: "cloud", hours: 1 });

  const cpu = container!.querySelector('[data-slot="chart-cpu"]')!;
  expect(bands(cpu)).toEqual(["Work", "iowait"]);
  expect(cpu.querySelector('[data-band="iowait"] polygon')!.getAttribute("fill")).toStartWith("url(#hatch-");
  expect(lastValue(cpu)).toBe("15% + 2% iowait · load 0.50/core");
  expect(legend(cpu)).toBe("Workiowait");
  expect(cpu.querySelector("figcaption")!.textContent).toStartWith("CPU · % of all cores");

  const mem = container!.querySelector('[data-slot="chart-mem"]')!;
  expect(bands(mem)).toEqual(["Used", "Cache"]);
  expect(lastValue(mem)).toBe("4.0 GB used");
  expect(mem.querySelectorAll('[data-slot="chart-ref"]')).toHaveLength(1);
  expect(legend(mem)).toBe("UsedCacheAgents limit 8.4 GB");
  expect(mem.querySelectorAll('[data-slot="chart-mark"]')).toHaveLength(1);
  expect(mem.querySelector('[data-slot="chart-oom"]')!.textContent).toBe(" · 1 OOM kill");

  const io = container!.querySelector('[data-slot="chart-io"]')!;
  expect(bands(io)).toEqual(["Read", "Write"]);
  expect(lastValue(io)).toBe("1.5 MB/s");
  expect(legend(io)).toBe("ReadWriteCap 125 MB/s");
  // No native title tooltips on the live charts.
  expect(container!.querySelectorAll('[data-slot="chart-cpu"] title, [data-slot="chart-mem"] title, [data-slot="chart-io"] title')).toHaveLength(0);
  // The other charts stay on the history.
  expect(container!.querySelector('[data-slot="chart-agents"]')).toBeTruthy();

  await pickRange("24h");
  expect(container!.querySelector('[data-slot="chart-io"]')).toBeNull();
  expect(container!.querySelector('[data-slot="chart-cpu"] polyline')).toBeTruthy();
});

test("hover on a live chart opens its tooltip with the values at that time, iowait and load included", async () => {
  const now = Date.now();
  apiFake.healthLiveData = liveRing(now);
  localStorage.setItem("orca.ui.v1.instanceRange:cloud", "1");
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  const svgOf = (slot: string) => container!.querySelector(`[data-slot="${slot}"] svg`)!;
  // The sample 15 s ago (the IO stall): x = 600 × (1 − 15 s / 1 h) on the chart's 600-unit width.
  const hover = async (slot: string) => {
    await act(async () => { svgOf(slot).dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 597.5, pointerType: "mouse" })); await flush(); });
    return document.querySelector('[data-slot="chart-tooltip"]')!.textContent;
  };
  const cpuTip = await hover("chart-cpu");
  expect(cpuTip).toContain("Work10%");
  expect(cpuTip).toContain("iowait80%");
  expect(cpuTip).toContain("Load / cores1.50");
  expect(lastValue(container!.querySelector('[data-slot="chart-cpu"]')!)).toContain("10% + 80% iowait");
  const leave = (slot: string) => act(async () => { svgOf(slot).dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body })); await flush(); });
  await leave("chart-cpu");
  expect(document.querySelector('[data-slot="chart-tooltip"]')).toBeNull();
  const ioTip = await hover("chart-io");
  expect(ioTip).toContain("Read130.0 MB/s");
  expect(ioTip).toContain("iowait80%");
  await leave("chart-io");
  const memTip = await hover("chart-mem");
  expect(memTip).toContain("Used3.5 GB");
  expect(memTip).toContain("1 agent run out of memory");
});

// The Overview's flicker: a failed poll replaced the last good data with "nothing" — the graphs became
// "No history recorded yet", or the stacked ring charts became the old line charts — until the next
// good poll. A failure now keeps what the card already shows.
test("a failed history or ring poll keeps the graphs the last good poll drew", async () => {
  const now = Date.now();
  apiFake.healthLiveData = liveRing(now);
  apiFake.healthHistoryData = [{ at: now - 60_000, cpuPct: 50, load1: 2, memUsedGb: 12, memTotalGb: 15.3, runningAgents: 2 }];
  await render(<><RefreshVitals /><InstanceCard instance="cloud" here={false} /></>);
  await ready();
  const refresh = async () => {
    await act(async () => { container!.querySelector<HTMLButtonElement>('[data-slot="instances-refresh"]')!.click(); await flush(); await flush(); });
  };
  expect(container!.querySelector('[data-slot="chart-cpu"] polyline')).toBeTruthy(); // 24h: from the history

  apiFake.healthHistoryError = "network blip";
  await refresh();
  expect(apiFake.healthHistoryCalls).toHaveLength(2);
  expect(container!.textContent).not.toContain("No history recorded yet");
  expect(container!.querySelector('[data-slot="chart-cpu"] polyline')).toBeTruthy();
  apiFake.healthHistoryError = null;

  await pickRange("1h"); // the ring
  expect(container!.querySelector('[data-slot="chart-io"]')).toBeTruthy();
  apiFake.healthLiveData = null; // the fake's ring route now fails
  const calls = apiFake.healthLiveCalls.length;
  await refresh();
  expect(apiFake.healthLiveCalls.length).toBeGreaterThan(calls);
  expect(container!.querySelector('[data-slot="chart-io"]')).toBeTruthy(); // still the stacked charts
});

test("a bridge without the ring (an older build) keeps the 6h line charts from the history", async () => {
  apiFake.healthHistoryData = [{ at: Date.now() - 60_000, cpuPct: 50, load1: 2, memUsedGb: 12, memTotalGb: 15.3 }];
  localStorage.setItem("orca.ui.v1.instanceRange:cloud", "6");
  await render(<InstanceCard instance="cloud" here={false} />);
  await ready();
  expect(apiFake.healthLiveCalls).toEqual([{ instance: "cloud", hours: 6 }]);
  expect(container!.querySelector('[data-slot="chart-cpu"] polyline')).toBeTruthy();
  expect(container!.querySelector('[data-slot="chart-io"]')).toBeNull();
});

test("the heavy-queue header shows one decimal; on a phone the rows scroll sideways with their whole text", async () => {
  const now = Date.now();
  const long = "npx playwright test tests/a-very-long-spec-name/that-does-not-fit-on-a-phone.spec.ts --workers=1";
  // A raw, unrounded view from an older bridge, with a lone command over the memory budget.
  apiFake.healthData = { instance: "cloud", hostname: "orca-box", cores: 4, cpuPct: 30, load1: 0.5, load5: 0.4, memUsedGb: 2, memTotalGb: 15.3, uptimeS: 9, at: now,
    heavy: { running: [{ id: "r1", kind: "e2e", command: long, branch: "orca/a-long-branch-name", queuedAt: now, startedAt: now, overBudget: true }], queued: [],
      limits: {}, cpu: { used: 1.5, budget: 3 }, memory: { used: 6, budget: 1.0999999999999996 } } };
  const realMatchMedia = window.matchMedia;
  const phone = (on: boolean) => {
    window.matchMedia = ((q: string) => ({ matches: on && q === "(max-width: 767px)", media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  };
  try {
    // Desktop: one decimal, the overrun flagged, a long command truncates in its row.
    phone(false);
    await render(<InstanceCard instance="cloud" here={false} />);
    await ready();
    let queue = container!.querySelector('[data-slot="heavy-queue"]')!;
    expect(queue.querySelector('[data-slot="heavy-cpu"]')!.textContent).toBe(" · CPU 1.5 / 3");
    expect(queue.querySelector('[data-slot="heavy-memory"]')!.textContent).toBe(" · Memory 6 / 1.1 GB");
    expect(queue.textContent).not.toContain("0999");
    expect(queue.querySelector('[data-slot="heavy-memory"]')!.getAttribute("data-over")).toBe("true");
    expect(queue.querySelector('[data-slot="heavy-over"]')!.textContent).toBe("over memory budget");
    expect(queue.querySelector('[data-slot="heavy-command"]')!.className).toContain("truncate");
    expect(queue.querySelector('[data-slot="heavy-who"]')!.className).toContain("truncate");
    // The vertical-only viewport makes Radix's content wrapper a block, so truncation applies.
    expect(queue.querySelector('[data-slot="scroll-area-viewport"]')!.className).toContain("[&>div]:!block");
    await act(async () => { root?.unmount(); }); container?.remove();

    // Phone: the same ScrollArea, now horizontal too; nothing truncates, the list is as wide as its widest row.
    phone(true);
    await render(<InstanceCard instance="cloud" here={false} />);
    await ready();
    queue = container!.querySelector('[data-slot="heavy-queue"]')!;
    const viewport = queue.querySelector('[data-slot="scroll-area"] [data-slot="scroll-area-viewport"]')!;
    expect(viewport.className).toContain("max-h-64");
    expect(viewport.className).not.toContain("[&>div]:!block");
    expect(queue.querySelector('[data-slot="heavy-list"]')!.className).toContain("w-max");
    expect(queue.querySelector('[data-slot="heavy-list"]')!.className).toContain("min-w-full");
    expect(queue.querySelector('[data-slot="heavy-row"]')!.className).toContain("whitespace-nowrap");
    expect(queue.querySelector('[data-slot="heavy-command"]')!.className).not.toContain("truncate");
    expect(queue.querySelector('[data-slot="heavy-who"]')!.className).not.toContain("truncate");
    expect(queue.querySelector('[data-slot="heavy-command"]')!.textContent).toBe(long);
    expect(queue.querySelector('[data-slot="heavy-command"]')!.parentElement!.className).not.toContain("min-w-0");
  } finally {
    window.matchMedia = realMatchMedia;
  }
});

test("the status is Online while /api/health has not answered, once the machine's samples are fresh; Loading with no evidence", async () => {
  apiFake.holdHealth = true;
  const now = Date.now();
  apiFake.healthHistoryData = [{ at: now - 60_000, cpuPct: 30, load1: 0.1, memUsedGb: 2, memTotalGb: 24 }];
  await render(<InstanceCard instance="local" here={false} />);
  await ready();
  expect(detail(container!.querySelector('[data-slot="instance-local"]')!, "instance-status")).toContain("Online");
  await act(async () => { root?.unmount(); }); container?.remove();
  apiFake.healthHistoryData = [];
  await render(<InstanceCard instance="laptop" here={false} />);
  await ready();
  expect(detail(container!.querySelector('[data-slot="instance-laptop"]')!, "instance-status")).toContain("Loading…");
});
