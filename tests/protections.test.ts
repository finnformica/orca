// The crash-protection check (server/protections.ts, CLAUDE.md "Box crash safety"): which of
// deploy/harden.sh's protections a box is missing, and the newest OOM kill in its kernel log, for
// the Overview's instance card. The parsing is pure; the probe runs against fake `systemctl`,
// `journalctl` and `dmesg` on PATH and fake /proc files, the PATH-shim pattern of tests/helpers.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { lastOomKill, missingProtections, protections, withLiveState, type ProbeResult } from "../server/protections";

const HARDENED: ProbeResult = {
  swapTotalBytes: 4 * 1024 ** 3, healthTimer: "active", userManager: "ActiveState=active\nOOMScoreAdjust=-900",
};

test("a hardened box is missing nothing", () => {
  expect(missingProtections(HARDENED)).toEqual([]);
});

test("each missing protection is named once", () => {
  expect(missingProtections({ ...HARDENED, swapTotalBytes: 0 }).map((m) => m.key)).toEqual(["swap"]);
  expect(missingProtections({ ...HARDENED, healthTimer: "inactive" }).map((m) => m.label)).toEqual(["no health watchdog"]);
  expect(missingProtections({ ...HARDENED, userManager: "ActiveState=failed\nOOMScoreAdjust=-900" }).map((m) => m.key)).toEqual(["userManager"]);
  expect(missingProtections({ ...HARDENED, userManager: "ActiveState=active\nOOMScoreAdjust=100" }).map((m) => m.key)).toEqual(["userManagerOom"]);
  expect(missingProtections({ swapTotalBytes: 0, healthTimer: "inactive", userManager: "ActiveState=failed\nOOMScoreAdjust=100" }).map((m) => m.key))
    .toEqual(["swap", "healthWatchdog", "userManager", "userManagerOom"]);
});

test("a user manager the last launch found down replaces the probe's line at once", () => {
  const live = withLiveState({ missing: [{ key: "userManager", label: "old" }, { key: "swap", label: "no swap" }], at: 0 }, { since: Date.parse("2026-10-18T21:34:00Z"), reason: "Failed to connect to bus" });
  expect(live.missing.map((m) => m.key)).toEqual(["swap", "userManager"]);
  expect(live.missing[1]!.label).toContain("2026-10-18 21:34 UTC");
  expect(withLiveState({ missing: [], at: 0 }, undefined).missing).toEqual([]);
});

test("what the probe could not read is never reported as missing", () => {
  expect(missingProtections({})).toEqual([]);
});

test("lastOomKill reads the newest OOM line of journalctl's short-iso and dmesg's iso formats", () => {
  const journal = [
    "2026-10-13T08:00:01+0000 orca-box kernel: eth0: link up",
    "2026-10-13T09:12:33+0000 orca-box kernel: Out of memory: Killed process 4242 (node) total-vm:9000kB",
    "2026-10-18T06:30:00+0100 orca-box kernel: Memory cgroup out of memory: Killed process 77 (claude)",
    "2026-10-18T07:00:00+0000 orca-box kernel: usb 1-1: new device",
  ].join("\n");
  expect(lastOomKill(journal)).toBe(Date.parse("2026-10-18T05:30:00Z"));
  const dmesg = "2026-10-18T05:40:12,123456+00:00 oom-kill:constraint=CONSTRAINT_NONE,task=claude,pid=9\n";
  expect(lastOomKill(dmesg)).toBe(Date.parse("2026-10-18T05:40:12Z"));
  expect(lastOomKill("-- No entries --\n")).toBeNull();
  expect(lastOomKill("")).toBeNull();
});

let shim: string;
let prevPath: string | undefined;
let prevLinger: string | undefined;
beforeEach(async () => {
  prevPath = process.env.PATH;
  prevLinger = process.env.ORCA_LINGER_DIR;
  shim = await mkdtemp(join(tmpdir(), "orca-protections-"));
  process.env.PATH = `${shim}:${prevPath}`;
  process.env.ORCA_LINGER_DIR = shim; // lingering on only where a test writes the user's file
});
afterEach(async () => {
  process.env.PATH = prevPath;
  process.env.ORCA_LINGER_DIR = prevLinger;
  await rm(shim, { recursive: true, force: true });
});
async function bin(name: string, body: string): Promise<void> {
  await writeFile(join(shim, name), `#!/bin/sh\n${body}\n`);
  await chmod(join(shim, name), 0o755);
}

test("protections() on an unhardened box reports all four, and the kill from the kernel log", async () => {
  await writeFile(join(shim, userInfo().username), ""); // lingering on: a user manager is expected
  await bin("systemctl", `case "$*" in
  "is-active orca-health.timer") echo inactive; exit 3 ;;
  "show user@"*"-p ActiveState -p OOMScoreAdjust") printf 'ActiveState=failed\\nOOMScoreAdjust=100\\n' ;;
esac`);
  await bin("journalctl", `echo '2026-10-18T09:12:33+0000 box kernel: Out of memory: Killed process 4242 (claude)'`);
  await writeFile(join(shim, "meminfo"), "MemTotal: 8000000 kB\nMemAvailable: 1000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n");
  const p = await protections({ meminfo: join(shim, "meminfo"), user: userInfo().username });
  expect(p.missing.map((m) => m.key)).toEqual(["swap", "healthWatchdog", "userManager", "userManagerOom"]);
  expect(p.lastOomKill).toBe(Date.parse("2026-10-18T09:12:33Z"));
});

test("protections() on a hardened box reports nothing; an unreadable kernel log leaves the kill unknown", async () => {
  await bin("systemctl", `case "$*" in
  "is-active orca-health.timer") echo active ;;
esac`);
  // No permission: journalctl warns on stderr, dmesg is restricted.
  await bin("journalctl", `echo 'Hint: You are currently not seeing messages from other users and the system.' >&2; exit 1`);
  await bin("dmesg", `echo 'dmesg: read kernel buffer failed: Operation not permitted' >&2; exit 1`);
  await writeFile(join(shim, "meminfo"), "MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 4194304 kB\nSwapFree: 4194304 kB\n");
  // Lingering off: no user manager is expected, so none is asked about.
  const p = await protections({ meminfo: join(shim, "meminfo"), user: userInfo().username });
  expect(p.missing).toEqual([]);
  expect(p.lastOomKill).toBeUndefined();
});
