// This machine's vitals for the header's instance chip (GET /api/health). Shells out to `df` for
// the root disk; everything else is the os module. The cost is an ESTIMATE from two env vars the
// box sets (ORCA_HOURLY_USD, ORCA_BILLING_SINCE) — Cost Explorer needs AWS credentials the instance
// role doesn't have, and an estimate that is always there beats a bill that needs a login.
import * as os from "os";
import * as db from "./db";
import * as lease from "./lease";
import * as ledger from "./ledger";
import { run } from "./run";

export type Health = {
  instance: string; hostname: string; cores: number; cpuPct: number; load1: number; load5: number;
  memUsedGb: number; memTotalGb: number; memPressurePct?: number; memPressure?: boolean;
  disk?: { usedGb: number; totalGb: number }; uptimeS: number;
  cost?: { monthUsd: number; hourlyUsd: number; sinceIso: string }; at: number;
  /** Live leases right now — the same count the sampler records, so the card's "Agents · N" and
   *  the agents line's newest point are one reading. */
  runningAgents: number;
};

// ---- darwin memory: os.freemem() is only the truly-free page count, and the kernel keeps nearly
// all RAM occupied by design (inactive/file cache/speculative), so totalmem()-freemem() reads
// ~100% on every healthy Mac. `vm_stat` is what Activity Monitor's "Memory Used" reads instead:
// app + wired + compressed, i.e. active + wired + occupied-by-compressor pages. (Linux is fine as
// is: os.freemem() there already tracks /proc/meminfo's MemAvailable, so totalmem()-freemem() is
// the same "used" Activity Monitor's Linux equivalents report — verified against /proc/meminfo on
// the box.) Both shell out through `run` (server/run.ts) so tests can shim them on PATH, same as
// the rest of the server's adapters.

type VmStatPages = { pageSize: number; activePages: number; wiredPages: number; compressorPages: number };

/** Parse `vm_stat`'s text report. `Pages occupied by compressor` is missing on older macOS, where
 *  it counts as zero. Returns undefined if the page size or the active/wired lines aren't there —
 *  a format we don't recognise, so the caller should fall back rather than report nonsense. */
export function parseVmStat(out: string): VmStatPages | undefined {
  const pageSize = out.match(/page size of (\d+) bytes/)?.[1];
  const activePages = out.match(/Pages active:\s*(\d+)\./)?.[1];
  const wiredPages = out.match(/Pages wired down:\s*(\d+)\./)?.[1];
  const compressorPages = out.match(/Pages occupied by compressor:\s*(\d+)\./)?.[1];
  if (!pageSize || !activePages || !wiredPages) return undefined;
  return { pageSize: Number(pageSize), activePages: Number(activePages), wiredPages: Number(wiredPages), compressorPages: Number(compressorPages ?? 0) };
}

/** Activity Monitor's "Memory Used", in GB: app (active) + wired + compressed, page size weighted. */
export function vmStatUsedGb(p: VmStatPages): number {
  return Math.round(((p.pageSize * (p.activePages + p.wiredPages + p.compressorPages)) / 1073741824) * 10) / 10;
}

async function vmStat(): Promise<string> {
  return run(["vm_stat"]);
}

/** `kern.memorystatus_level` is a free-ness level (100 ≈ plenty free, falling as pressure rises).
 *  Inverted to a pressure percentage; "pressure" proper below ~20 (Apple's own warn/critical band
 *  starts there). Undefined when the sysctl isn't there (non-darwin, or an old kernel). */
async function memoryPressureLevel(): Promise<number | undefined> {
  const n = Number((await run(["sysctl", "-n", "kern.memorystatus_level"])).trim());
  return Number.isFinite(n) ? n : undefined;
}

/** darwin's corrected memory figures, shelling to `vm_stat`/`sysctl` through `run` so a test can
 *  shim them on PATH (tests/health.test.ts, same approach as tests/helpers.ts' fake `gh`) without
 *  the box actually being a Mac. Exported separately
 *  from `health()` for exactly that: `process.platform` can't be faked, these adapters can. Each
 *  failure degrades on its own — a missing sysctl shouldn't cost the (more important) used figure. */
export async function darwinMemory(): Promise<{ memUsedGb?: number; memPressurePct?: number; memPressure?: boolean }> {
  let memUsedGb: number | undefined;
  try {
    const parsed = parseVmStat(await vmStat());
    if (parsed) memUsedGb = vmStatUsedGb(parsed);
  } catch { /* vm_stat unavailable */ }
  let memPressurePct: number | undefined, memPressure: boolean | undefined;
  try {
    const level = await memoryPressureLevel();
    if (level !== undefined) { memPressurePct = Math.round(100 - level); memPressure = level < 20; }
  } catch { /* sysctl unavailable */ }
  return { memUsedGb, memPressurePct, memPressure };
}

/** Month-to-date cost: hours since the later of the billing start and the first of the month, at
 *  the hourly rate. Pure, so the arithmetic is tested; `now` is injectable for that. */
export function costEstimate(hourlyUsd: number, billingSince: string | undefined, now = Date.now()): Health["cost"] | undefined {
  if (!(hourlyUsd > 0)) return undefined;
  const since = billingSince ? Date.parse(billingSince) : NaN;
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const from = Math.max(monthStart, Number.isFinite(since) ? since : 0);
  return { monthUsd: Math.round(((now - from) / 3_600_000) * hourlyUsd * 100) / 100, hourlyUsd, sinceIso: new Date(from).toISOString() };
}

export async function health(): Promise<Health> {
  const cores = os.cpus().length || 1;
  const [load1 = 0, load5 = 0] = os.loadavg();
  let disk: Health["disk"];
  try {
    const out = Bun.spawnSync(["df", "-k", "/"]).stdout.toString().trim().split("\n").at(-1)?.split(/\s+/) ?? [];
    if (out.length >= 4) disk = { usedGb: Math.round((Number(out[2]) / 1048576) * 10) / 10, totalGb: Math.round((Number(out[1]) / 1048576) * 10) / 10 };
  } catch { /* no df */ }

  // linux: os.freemem() already tracks MemAvailable, so totalmem()-freemem() is real "used".
  let memUsedGb = Math.round(((os.totalmem() - os.freemem()) / 1073741824) * 10) / 10;
  let memPressurePct: number | undefined;
  let memPressure: boolean | undefined;
  if (process.platform === "darwin") {
    const darwin = await darwinMemory();
    if (darwin.memUsedGb !== undefined) memUsedGb = darwin.memUsedGb;
    memPressurePct = darwin.memPressurePct;
    memPressure = darwin.memPressure;
  }

  return {
    instance: db.instanceName(), hostname: os.hostname(), cores,
    cpuPct: Math.min(100, Math.round((load1 / cores) * 100)), load1, load5,
    memUsedGb, memTotalGb: Math.round((os.totalmem() / 1073741824) * 10) / 10, memPressurePct, memPressure,
    disk, uptimeS: Math.round(os.uptime()),
    cost: costEstimate(Number(process.env.ORCA_HOURLY_USD), process.env.ORCA_BILLING_SINCE), at: Date.now(),
    runningAgents: lease.live().length,
  };
}

// ---- history (instance_metric) ----

/** How often each instance samples itself into `instance_metric`. */
export const METRIC_SAMPLE_MS = 60_000;

/** The `hours` a history request asks for: 24 by default, at most the 30 days kept. */
export function historyHours(raw: string | null | undefined): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 30) : 24;
}

/** USD the agent runs in the ledger that finished in (from, to] cost. Only Claude reports a cost
 *  (`total_cost_usd`); a Codex/Cursor run counts as 0. Pure, for the test. */
export function costSince(entries: ledger.LedgerEntry[], from: number, to: number): number {
  let usd = 0;
  for (const e of entries) if (e.kind === "run" && e.at > from && e.at <= to && e.costUsd) usd += e.costUsd;
  return Math.round(usd * 1e6) / 1e6;
}

// Where the next sample's cost window starts. Seeded from this instance's newest row on the first
// sample after a start, so a restart neither loses nor double-counts a run (the ledger is on disk).
let costFrom: number | null = null;
/** Tests: forget the window, as a fresh process would. */
export function resetCostWindow(): void { costFrom = null; }

/** Sample this machine and record it. Never throws: a metrics write must not touch anything else.
 *  Running agents come from the leases (durable, per-host) rather than agent.ts's in-memory `runs`
 *  map, so a sample taken right after a restart still counts what's genuinely live. The cost is
 *  what the runs that finished since the previous sample cost, from the run ledger. */
export async function sampleMetrics(): Promise<void> {
  try {
    const h = await health();
    costFrom ??= (await db.lastMetricAt()) ?? h.at - METRIC_SAMPLE_MS;
    const costUsd = costSince(ledger.all(), costFrom, h.at);
    await db.recordMetric({
      cpuPct: h.cpuPct, load1: h.load1, memUsedGb: h.memUsedGb, memTotalGb: h.memTotalGb, diskUsedGb: h.disk?.usedGb,
      runningAgents: h.runningAgents, costUsd,
    }, h.at);
    costFrom = h.at;
  } catch (e) {
    console.error("orca: metrics sample failed", e instanceof Error ? e.message : e);
  }
}

/** Each instance samples ITSELF once a minute (and once at startup, so a fresh box has a point). */
export function startMetricsSampler(ms = METRIC_SAMPLE_MS): ReturnType<typeof setInterval> {
  void sampleMetrics();
  return setInterval(() => void sampleMetrics(), ms).unref();
}
