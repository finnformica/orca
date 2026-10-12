// This machine's vitals for the header's instance chip (GET /api/health). Shells out to `df` for
// the root disk; everything else is the os module. The cost is an ESTIMATE from two env vars the
// box sets (ORCA_HOURLY_USD, ORCA_BILLING_SINCE) — Cost Explorer needs AWS credentials the instance
// role doesn't have, and an estimate that is always there beats a bill that needs a login.
import * as os from "os";
import * as db from "./db";

export type Health = {
  instance: string; hostname: string; cores: number; cpuPct: number; load1: number; load5: number;
  memUsedGb: number; memTotalGb: number; disk?: { usedGb: number; totalGb: number }; uptimeS: number;
  cost?: { monthUsd: number; hourlyUsd: number; sinceIso: string; billingSince?: string }; at: number;
};

/** Month-to-date cost: hours since the later of the billing start and the first of the month, at
 *  the hourly rate. Pure, so the arithmetic is tested; `now` is injectable for that. */
export function costEstimate(hourlyUsd: number, billingSince: string | undefined, now = Date.now()): Health["cost"] | undefined {
  if (!(hourlyUsd > 0)) return undefined;
  const since = billingSince ? Date.parse(billingSince) : NaN;
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const from = Math.max(monthStart, Number.isFinite(since) ? since : 0);
  // `billingSince` unclamped, so a range spanning the 1st (the Spend card's 30 days) counts last month too.
  return {
    monthUsd: Math.round(((now - from) / 3_600_000) * hourlyUsd * 100) / 100, hourlyUsd, sinceIso: new Date(from).toISOString(),
    ...(Number.isFinite(since) ? { billingSince: new Date(since).toISOString() } : {}),
  };
}

export async function health(): Promise<Health> {
  const cores = os.cpus().length || 1;
  const [load1 = 0, load5 = 0] = os.loadavg();
  let disk: Health["disk"];
  try {
    const out = Bun.spawnSync(["df", "-k", "/"]).stdout.toString().trim().split("\n").at(-1)?.split(/\s+/) ?? [];
    if (out.length >= 4) disk = { usedGb: Math.round((Number(out[2]) / 1048576) * 10) / 10, totalGb: Math.round((Number(out[1]) / 1048576) * 10) / 10 };
  } catch { /* no df */ }
  return {
    instance: db.instanceName(), hostname: os.hostname(), cores,
    cpuPct: Math.min(100, Math.round((load1 / cores) * 100)), load1, load5,
    memUsedGb: Math.round(((os.totalmem() - os.freemem()) / 1073741824) * 10) / 10, memTotalGb: Math.round((os.totalmem() / 1073741824) * 10) / 10,
    disk, uptimeS: Math.round(os.uptime()),
    cost: costEstimate(Number(process.env.ORCA_HOURLY_USD), process.env.ORCA_BILLING_SINCE), at: Date.now(),
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

/** Sample this machine and record it. Never throws: a metrics write must not touch anything else. */
export async function sampleMetrics(): Promise<void> {
  try {
    const h = await health();
    await db.recordMetric({ cpuPct: h.cpuPct, load1: h.load1, memUsedGb: h.memUsedGb, memTotalGb: h.memTotalGb, diskUsedGb: h.disk?.usedGb });
  } catch (e) {
    console.error("orca: metrics sample failed", e instanceof Error ? e.message : e);
  }
}

/** Each instance samples ITSELF once a minute (and once at startup, so a fresh box has a point). */
export function startMetricsSampler(ms = METRIC_SAMPLE_MS): ReturnType<typeof setInterval> {
  void sampleMetrics();
  return setInterval(() => void sampleMetrics(), ms).unref();
}
