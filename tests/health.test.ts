// The instance health chip's numbers (server/health.ts): the month-to-date cost estimate is plain
// arithmetic worth pinning; the vitals come straight from the os module, except on darwin where
// memory is corrected via `vm_stat`/`sysctl` (see darwinMemory's doc comment for why).
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { costEstimate, darwinMemory, health, parseVmStat, vmStatUsedGb } from "../server/health";

// A real `vm_stat` capture (Apple Silicon, page size 16384) — asserts the parse against actual
// field names/formatting, not a hand-trimmed fixture.
const VM_STAT_SAMPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               21309.
Pages active:                            612847.
Pages inactive:                          583296.
Pages speculative:                         4821.
Pages throttled:                              0.
Pages wired down:                        198532.
Pages purgeable:                          12044.
"Translation faults":                 892374651.
Pages copy-on-write:                    3847291.
Pages zero filled:                   412938475.
Pages reactivated:                       284719.
Pages purged:                           1829374.
File-backed pages:                       421837.
Anonymous pages:                         774306.
Pages stored in compressor:              892147.
Pages occupied by compressor:            213847.
Decompressions:                         3847291.
Compressions:                           5847392.
Pageins:                                8473921.
Pageouts:                                  48372.
Swapins:                                       0.
Swapouts:                                      0.
`;

test("cost: hours since the later of the billing start and the 1st of the month, at the rate", () => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0); // 12 Oct 2026 12:00Z
  expect(costEstimate(0.25, "2026-10-12T09:00:00Z", now)).toEqual({ monthUsd: 0.75, hourlyUsd: 0.25, sinceIso: "2026-10-12T09:00:00.000Z" }); // 3h × 0.25
  expect(costEstimate(0.25, "2026-09-01T00:00:00Z", now)?.monthUsd).toBe(69); // from the 1st: 11.5 days × 24 × 0.25
  expect(costEstimate(0.25, undefined, now)?.sinceIso).toBe("2026-10-01T00:00:00.000Z"); // no start → the month
  expect(costEstimate(0, "2026-10-12T09:00:00Z", now)).toBeUndefined(); // no rate → no estimate
  expect(costEstimate(NaN, undefined, now)).toBeUndefined();
});

test("health reports this machine's vitals in the shape the chip reads", async () => {
  const h = await health();
  expect(h.cores).toBeGreaterThan(0);
  expect(h.cpuPct).toBeGreaterThanOrEqual(0);
  expect(h.memUsedGb).toBeGreaterThan(0);
  expect(h.memTotalGb).toBeGreaterThan(0);
  expect(h.uptimeS).toBeGreaterThan(0);
  expect(typeof h.hostname).toBe("string");
  // This box isn't a Mac: no vm_stat/sysctl adapters run, so no pressure figures ride along.
  if (process.platform !== "darwin") {
    expect(h.memPressurePct).toBeUndefined();
    expect(h.memPressure).toBeUndefined();
  }
});

test("parseVmStat reads page size + active/wired/compressor pages off a real vm_stat report", () => {
  const parsed = parseVmStat(VM_STAT_SAMPLE);
  expect(parsed).toEqual({ pageSize: 16384, activePages: 612847, wiredPages: 198532, compressorPages: 213847 });
  // Activity Monitor's "Memory Used": app + wired + compressed, excluding free/inactive/speculative.
  expect(vmStatUsedGb(parsed!)).toBe(15.6);
});

test("parseVmStat tolerates a pre-compressor vm_stat (no 'occupied by compressor' line)", () => {
  const noCompressor = VM_STAT_SAMPLE.replace(/Pages occupied by compressor:.*\n/, "");
  const parsed = parseVmStat(noCompressor);
  expect(parsed).toEqual({ pageSize: 16384, activePages: 612847, wiredPages: 198532, compressorPages: 0 });
});

test("parseVmStat returns undefined for text it doesn't recognise", () => {
  expect(parseVmStat("not vm_stat output at all")).toBeUndefined();
});

let shimDir: string | undefined;
let realPath: string | undefined;

/** Prepend fake `vm_stat`/`sysctl` to PATH, same shim-on-PATH approach as tests/helpers.ts' fake
 *  `gh` — real adapters, fed canned output, no actual darwin required. */
async function installDarwinShims(vmStatOut: string, memorystatusLevel: number): Promise<void> {
  shimDir = await mkdtemp(join(tmpdir(), "orca-vmstat-"));
  const vmStatFixture = join(shimDir, "vm_stat.out");
  await writeFile(vmStatFixture, vmStatOut);
  await writeFile(join(shimDir, "vm_stat"), `#!/bin/sh\ncat "${vmStatFixture}"\n`);
  await writeFile(join(shimDir, "sysctl"), `#!/bin/sh\necho "${memorystatusLevel}"\n`);
  await chmod(join(shimDir, "vm_stat"), 0o755);
  await chmod(join(shimDir, "sysctl"), 0o755);
  realPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${realPath}`;
}

afterEach(() => {
  if (realPath !== undefined) process.env.PATH = realPath;
  realPath = undefined;
});

test("darwinMemory: vm_stat used figure + sysctl pressure level under shim, pressure flagged below ~20", async () => {
  await installDarwinShims(VM_STAT_SAMPLE, 12); // free-ness level 12 → low → pressure
  const d = await darwinMemory();
  expect(d.memUsedGb).toBe(15.6);
  expect(d.memPressurePct).toBe(88);
  expect(d.memPressure).toBe(true);
});

test("darwinMemory: a healthy pressure level reports no pressure", async () => {
  await installDarwinShims(VM_STAT_SAMPLE, 75); // plenty free
  const d = await darwinMemory();
  expect(d.memPressurePct).toBe(25);
  expect(d.memPressure).toBe(false);
});
