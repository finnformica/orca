// The instance health chip's numbers (server/health.ts): the machine's hourly rate (config, else an
// EC2 on-demand estimate from IMDSv2, else 0 — the source order is worth pinning); the vitals come straight from the os module, except on darwin where
// memory is corrected via `vm_stat`/`sysctl` (see darwinMemory's doc comment for why).
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { native } from "./happydom";
import { darwinMemory, EC2_ON_DEMAND_USD, health, imdsInstance, instanceRate, parseVmStat, resetImds, vmStatUsedGb } from "../server/health";

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

/** A fake IMDSv2: a PUT for a session token, then the two metadata reads, which demand the token. */
function fakeImds(instanceType: string, region: string) {
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      calls.push(`${req.method} ${path}`);
      if (req.method === "PUT" && path === "/latest/api/token") return new native.Response("tok-1");
      if (req.headers.get("X-aws-ec2-metadata-token") !== "tok-1") return new native.Response("", { status: 401 });
      if (path === "/latest/meta-data/instance-type") return new native.Response(instanceType);
      if (path === "/latest/meta-data/placement/region") return new native.Response(region);
      return new native.Response("", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

const prevImds = process.env.ORCA_IMDS_URL;
afterEach(() => { resetImds(); if (prevImds === undefined) delete process.env.ORCA_IMDS_URL; else process.env.ORCA_IMDS_URL = prevImds; });

test("rate: with no config entry, an EC2 box's type and region from IMDSv2 priced from the built-in table, labelled an estimate", async () => {
  const imds = fakeImds("m7i.xlarge", "eu-west-2");
  process.env.ORCA_IMDS_URL = imds.url;
  try {
    expect(await instanceRate(undefined, "cloud")).toEqual({ hourlyUsd: 0.2331, source: "estimate", instanceType: "m7i.xlarge", region: "eu-west-2" });
    expect(imds.calls).toEqual(["PUT /latest/api/token", "GET /latest/meta-data/instance-type", "GET /latest/meta-data/placement/region"]);
    await instanceRate({ local: 0 }, "cloud"); // another instance's entry is not this one's
    expect(imds.calls).toHaveLength(3); // IMDS is asked once per process
  } finally { imds.stop(); }
});

test("rate: the config's instanceHourlyUsd wins over IMDS; an unknown type is 0, never a guess", async () => {
  const imds = fakeImds("x9.huge", "eu-west-2");
  process.env.ORCA_IMDS_URL = imds.url;
  try {
    expect(await instanceRate({ cloud: 0.3 }, "cloud")).toEqual({ hourlyUsd: 0.3, source: "config" });
    expect(imds.calls).toEqual([]); // not even asked
    expect(await instanceRate({}, "cloud")).toEqual({ hourlyUsd: 0, source: "none", instanceType: "x9.huge", region: "eu-west-2" });
  } finally { imds.stop(); }
});

test("rate: the laptop (instance local) — no IMDS answers — is 0, unless the config names a rate for it", async () => {
  process.env.ORCA_IMDS_URL = "http://127.0.0.1:1"; // nothing listens, as off EC2
  expect(await imdsInstance(process.env.ORCA_IMDS_URL, 500)).toBeUndefined();
  expect(await instanceRate(undefined, "local")).toEqual({ hourlyUsd: 0, source: "none" });
  expect(await instanceRate({ local: 0 }, "local")).toEqual({ hourlyUsd: 0, source: "config" });
  expect(EC2_ON_DEMAND_USD["eu-west-2"]!["m7i.xlarge"]).toBe(0.2331); // this box
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
