// Per-worker memory ceiling (server/cgroup.ts, CLAUDE.md "Per-worker memory ceiling"): every agent
// run gets its own `systemd-run --user --scope` with a MemoryMax, so a runaway worker is OOM-killed
// alone, not the box. Pure argv building + availability detection are pinned directly; the scope's
// OOM signal (`systemctl --user show -p Result`) is driven through a fake `systemctl` on PATH, the
// same PATH-shim pattern tests/helpers.ts uses for `gh`.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cgroup from "../server/cgroup";

test("scopedCommand wraps argv in a memory/CPU-limited user scope", () => {
  expect(cgroup.scopedCommand(["claude", "-p", "go"], { available: true, memoryMaxGb: 4, cpuWeight: 50, unit: "orca-run-abc" })).toEqual([
    "systemd-run", "--user", "--scope", "--quiet", "--unit=orca-run-abc",
    "-p", "MemoryMax=4G", "-p", "MemorySwapMax=0", "-p", "CPUWeight=50",
    "--", "claude", "-p", "go",
  ]);
});

test("scopedCommand carries a repo's own memoryMaxGb and the app's cpuWeight", () => {
  expect(cgroup.scopedCommand(["codex", "exec"], { available: true, memoryMaxGb: 8, cpuWeight: 20, unit: "orca-run-xyz" }))
    .toEqual(["systemd-run", "--user", "--scope", "--quiet", "--unit=orca-run-xyz", "-p", "MemoryMax=8G", "-p", "MemorySwapMax=0", "-p", "CPUWeight=20", "--", "codex", "exec"]);
});

test("scopedCommand is a no-op when wrapping isn't available — darwin, or no systemd-run", () => {
  const argv = ["claude", "-p", "go"];
  expect(cgroup.scopedCommand(argv, { available: false, memoryMaxGb: 4, cpuWeight: 50, unit: "orca-run-abc" })).toEqual(argv);
});

test("available() is false off Linux even with everything else present", () => {
  expect(cgroup.available({ platform: "darwin", hasSystemdRun: true, busReachable: true })).toBe(false);
});

test("available() is false without systemd-run on PATH", () => {
  expect(cgroup.available({ platform: "linux", hasSystemdRun: false, busReachable: true })).toBe(false);
});

test("available() is false with the binary present but no reachable user bus — an unprovisioned box or a CI runner", () => {
  expect(cgroup.available({ platform: "linux", hasSystemdRun: true, busReachable: false })).toBe(false);
});

test("available() is true only once Linux, the binary, and the bus all line up", () => {
  expect(cgroup.available({ platform: "linux", hasSystemdRun: true, busReachable: true })).toBe(true);
});

let prevPath: string | undefined;
let prevRuntimeDir: string | undefined;
let shimDir: string;
let runtimeDir: string;

beforeEach(async () => {
  prevPath = process.env.PATH;
  prevRuntimeDir = process.env.XDG_RUNTIME_DIR;
  shimDir = await mkdtemp(join(tmpdir(), "orca-cgroup-shim-"));
  runtimeDir = await mkdtemp(join(tmpdir(), "orca-cgroup-runtime-"));
});
afterEach(async () => {
  process.env.PATH = prevPath;
  if (prevRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = prevRuntimeDir;
  await rm(shimDir, { recursive: true, force: true });
  await rm(runtimeDir, { recursive: true, force: true });
});

test("available()'s own detection finds systemd-run on PATH via a real PATH shim, bus forced reachable", async () => {
  await writeFile(join(shimDir, "systemd-run"), "#!/bin/sh\nexit 0\n");
  await chmod(join(shimDir, "systemd-run"), 0o755);
  process.env.PATH = `${shimDir}:${prevPath}`;
  expect(cgroup.available({ platform: "linux", busReachable: true })).toBe(true);
});

test("available()'s own detection finds no systemd-run when PATH has none", () => {
  process.env.PATH = shimDir; // nothing in it
  expect(cgroup.available({ platform: "linux", busReachable: true })).toBe(false);
});

test("available()'s own bus check finds the socket once XDG_RUNTIME_DIR points at it", async () => {
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  expect(cgroup.available({ platform: "linux", hasSystemdRun: true })).toBe(false); // no bus file yet
  await writeFile(join(runtimeDir, "bus"), "");
  expect(cgroup.available({ platform: "linux", hasSystemdRun: true })).toBe(true);
});

test("runtimeEnv points XDG_RUNTIME_DIR at an already-set value rather than guessing", () => {
  expect(cgroup.runtimeEnv({ XDG_RUNTIME_DIR: "/run/user/42" })).toEqual({ XDG_RUNTIME_DIR: "/run/user/42" });
});

/** A fake `systemctl` that answers `show <unit>.scope -p Result --value` with `reply`, ignoring the
 *  unit name — real systemctl is matched the same loose way tests/helpers.ts matches `gh`. */
async function fakeSystemctl(reply: string): Promise<void> {
  await writeFile(join(shimDir, "systemctl"), `#!/bin/sh\ncase "$*" in\n  *"show "*"-p Result --value") echo '${reply}' ;;\n  *) exit 1 ;;\nesac\n`);
  await chmod(join(shimDir, "systemctl"), 0o755);
  process.env.PATH = `${shimDir}:${prevPath}`;
}

test("wasOomKilled reads the scope's Result — oom-kill means yes", async () => {
  await fakeSystemctl("oom-kill");
  expect(await cgroup.wasOomKilled("orca-run-abc", process.env)).toBe(true);
});

test("wasOomKilled reads false for any other Result — a plain SIGKILL isn't automatically OOM", async () => {
  await fakeSystemctl("success");
  expect(await cgroup.wasOomKilled("orca-run-abc", process.env)).toBe(false);
});

test("wasOomKilled degrades to false rather than throwing when systemctl itself is unusable", async () => {
  process.env.PATH = shimDir; // no systemctl at all
  expect(await cgroup.wasOomKilled("orca-run-abc", process.env)).toBe(false);
});
