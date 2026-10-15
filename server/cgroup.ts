// Caps one agent run's memory inside its OWN transient systemd scope, so a runaway worker (a build,
// a headless browser left at 1.5TB virtual / 800MB RSS) gets killed by the kernel's cgroup OOM
// killer alone — not the box. The incident this exists for: an m7i.xlarge (16GB) ran 4-5 builds at
// once, the kernel OOM killer fired on the whole system, load average hit 49, and Postgres/
// Tailscale/SSM went unreachable for 12 minutes. Finn does not want a cap on how many workers may
// run — he wants each one's blast radius bounded to itself.
//
// `systemd-run --user --scope` (not the system manager): a non-root `systemd-run --scope` against
// the SYSTEM manager needs polkit authorization ("Interactive authentication required" for a
// service account with no admin rights), which a headless box has no way to grant non-interactively.
// The user manager has no such check, but a `systemd` SERVICE (unlike a login shell) has no running
// user manager and no XDG_RUNTIME_DIR by default — `loginctl enable-linger <user>` (deploy/
// bootstrap.sh) starts one at boot regardless of any login session, and `runtimeEnv` below points at
// its bus explicitly rather than trusting the service's own environment to have it. Verified by hand
// against a real systemd 255: `--user --scope` creates the scope and reports exit 137 on an OOM kill
// with lingering + XDG_RUNTIME_DIR set, and fails outright ("Failed to connect to bus") without
// either — which is also, conveniently, the exact state of a CI runner or a laptop with no lingering
// enabled, so `available()`'s bus-socket check keeps this a no-op there rather than breaking every
// run. `prlimit` was considered and rejected: it bounds one process's own address space, not a whole
// process tree (a build's child processes, Chrome's many), so it would not have stopped the incident.
import { existsSync } from "fs";
import { runCmd } from "./run";

export const DEFAULT_MEMORY_MAX_GB = 4;
export const DEFAULT_CPU_WEIGHT = 50;

/** Set only by tests that drive this through `agent.launch` (tests/oom.test.ts) rather than calling
 *  `available()` directly (tests/cgroup.test.ts, which passes `platform` straight in): the real call
 *  site (server/agent.ts) never passes `platform`, so on macOS there is no other way to make the
 *  rest of the detection (PATH shim, fake bus socket) count for anything — never set outside tests. */
const TEST_FORCE_LINUX_ENV = "ORCA_TEST_FORCE_CGROUP_LINUX";

/** Whether `systemd-run --user --scope` can actually create a scope right now: Linux, the binary on
 *  PATH, and a reachable user bus. Each check is overridable so a test can force any combination
 *  without a real systemd — `process.platform` and the filesystem can't be faked, this can. The bus
 *  check (not just the binary) is what keeps this inert on a CI runner or an unprovisioned box: the
 *  binary is on PATH there too, but with no lingering enabled there is no user manager to talk to. */
export function available(opts: { platform?: string; hasSystemdRun?: boolean; busReachable?: boolean } = {}): boolean {
  const platform = opts.platform ?? (process.env[TEST_FORCE_LINUX_ENV] === "1" ? "linux" : process.platform);
  if (platform !== "linux") return false;
  // Bun.which() with no options reads the PATH captured at process startup, not a later edit to
  // process.env.PATH — passed explicitly so a test's PATH shim (or a real config change) takes
  // effect without a process restart.
  const hasSystemdRun = opts.hasSystemdRun ?? Bun.which("systemd-run", { PATH: process.env.PATH ?? "" }) !== null;
  if (!hasSystemdRun) return false;
  const busReachable = opts.busReachable ?? existsSync(busSocketPath());
  return busReachable;
}

/** Where the user manager's runtime dir lives: `XDG_RUNTIME_DIR` when something already set it
 *  (a login shell, or a test), else the standard `/run/user/<uid>` a systemd SERVICE — which has
 *  no login session and so no XDG_RUNTIME_DIR of its own — would otherwise never have. Takes `env`
 *  explicitly so a test can point this at a throwaway directory instead of the real `/run/user`,
 *  which needs root to write to. */
function runtimeDir(env: Record<string, string | undefined> = process.env): string {
  return env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`;
}

/** Path to the user bus socket `systemd-run --user` needs — present once lingering has started a
 *  user manager for this uid, absent otherwise (a fresh CI runner, a box nobody has provisioned). */
export function busSocketPath(env: Record<string, string | undefined> = process.env): string {
  return `${runtimeDir(env)}/bus`;
}

/** The env a wrapped spawn (and a later `systemctl --user show`) needs: a systemd SERVICE's own
 *  environment has no XDG_RUNTIME_DIR by default, unlike a login shell, so this is set explicitly
 *  rather than trusted to already be there. */
export function runtimeEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return { XDG_RUNTIME_DIR: runtimeDir(env) };
}

/** Wrap argv so it runs inside its own memory/CPU-limited scope, or return it unchanged when
 *  wrapping isn't usable (darwin, or a box with no reachable user bus — `available()` above decides
 *  that; this half just builds the command once it's been told yes). Pure, so a test pins the exact
 *  systemd-run invocation without a real systemd. `MemorySwapMax=0`: swap would turn "OOM-killed at
 *  4GB" into "thrashing the box's disk at 4GB", the same blast-radius problem one layer down. */
export function scopedCommand(argv: string[], opts: { available: boolean; memoryMaxGb: number; cpuWeight: number; unit: string }): string[] {
  if (!opts.available) return argv;
  return [
    "systemd-run", "--user", "--scope", "--quiet", `--unit=${opts.unit}`,
    "-p", `MemoryMax=${opts.memoryMaxGb}G`, "-p", "MemorySwapMax=0", "-p", `CPUWeight=${opts.cpuWeight}`,
    "--", ...argv,
  ];
}

/** Was `unit` (the scope a run was wrapped in) killed by the kernel's cgroup-aware OOM killer?
 *  `systemctl --user show <unit>.scope -p Result` reports `oom-kill` for exactly that — briefly,
 *  until the scope is garbage-collected once its process tree is gone — which is a cleaner signal
 *  than the exit code alone (137 is also plain SIGKILL from something else). Advisory: any failure
 *  to ask (the scope already reaped, the bus gone) reads as "no" rather than throwing — this must
 *  never turn a real run's result into an error of its own. */
export async function wasOomKilled(unit: string, env: Record<string, string | undefined>): Promise<boolean> {
  try {
    const { stdout } = await runCmd(["systemctl", "--user", "show", `${unit}.scope`, "-p", "Result", "--value"], { env, allowFail: true });
    return stdout.trim() === "oom-kill";
  } catch {
    return false;
  }
}
