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
import { totalmem, userInfo } from "os";
import { runCmd } from "./run";

export const DEFAULT_MEMORY_MAX_GB = 4;
export const DEFAULT_CPU_WEIGHT = 50;

// ---- the OOM score and the agents' slice ----
// 2026-10-18: every agent INHERITED the bridge's oom_score_adj -500, the user manager had 100, so a
// memcg OOM in user-<uid>.slice killed the user manager and dbus, and every later scope failed.
// So: every agent starts with a POSITIVE score (`withOomScore` — not `-p OOMScoreAdjust=`, which
// systemd 255 refuses for a scope and would fail every run), and every scope runs in
// orca-agents.slice with its own MemoryMax, so a memcg OOM there picks only agents.

/** The scopes' slice under the user manager. The dash makes it orca.slice/orca-agents.slice. */
export const AGENTS_SLICE = "orca-agents.slice";
export const DEFAULT_OOM_SCORE_ADJ = 500;
/** The agents' slice limit as a share of RAM when `ORCA_AGENTS_SLICE_MAX_GB` is unset. */
export const AGENTS_SLICE_SHARE = 0.55;

type Env = Record<string, string | undefined>;
const num = (raw: string | undefined): number | undefined => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) ? n : undefined;
};

/** The OOM score every agent process starts with (`ORCA_AGENT_OOM_SCORE_ADJ`, default 500). */
export function oomScoreAdj(env: Env = process.env): number {
  const n = num(env.ORCA_AGENT_OOM_SCORE_ADJ);
  return n === undefined ? DEFAULT_OOM_SCORE_ADJ : Math.max(-1000, Math.min(1000, Math.round(n)));
}

/** The agents' slice MemoryMax in GB (`ORCA_AGENTS_SLICE_MAX_GB`, else 55 % of RAM). 0 = no limit. */
export function agentsSliceMaxGb(env: Env = process.env, totalBytes = totalmem()): number {
  const n = num(env.ORCA_AGENTS_SLICE_MAX_GB);
  if (n !== undefined && n >= 0) return n;
  return Math.floor((totalBytes / 1024 ** 3) * AGENTS_SLICE_SHARE * 10) / 10;
}

/** argv run with its OOM score set first: the agent must not keep the bridge's -500. Pure. */
export function withOomScore(argv: string[], adj: number): string[] {
  return ["sh", "-c", `{ echo ${adj} > /proc/self/oom_score_adj; } 2>/dev/null; exec "$@"`, "orca-run", ...argv];
}

/** Set only by tests that drive this through `agent.launch` (tests/oom.test.ts) rather than calling
 *  `available()` directly (tests/cgroup.test.ts, which passes `platform` straight in): the real call
 *  site (server/agent.ts) never passes `platform`, so on macOS there is no other way to make the
 *  rest of the detection (PATH shim, fake bus socket) count for anything — never set outside tests. */
const TEST_FORCE_LINUX_ENV = "ORCA_TEST_FORCE_CGROUP_LINUX";

/** Linux, or a test that forces the Linux path (see TEST_FORCE_LINUX_ENV). */
export const linux = (): boolean => process.platform === "linux" || process.env[TEST_FORCE_LINUX_ENV] === "1";

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
export function scopedCommand(argv: string[], opts: { available: boolean; memoryMaxGb: number; cpuWeight: number; unit: string; slice?: string; oomScoreAdj?: number }): string[] {
  // The OOM score applies scoped or not: the unscoped fallback is exactly when it matters most.
  const cmd = opts.oomScoreAdj === undefined ? argv : withOomScore(argv, opts.oomScoreAdj);
  if (!opts.available) return cmd;
  return [
    "systemd-run", "--user", "--scope", "--quiet", `--unit=${opts.unit}`, ...(opts.slice ? [`--slice=${opts.slice}`] : []),
    "-p", `MemoryMax=${opts.memoryMaxGb}G`, "-p", "MemorySwapMax=0", "-p", `CPUWeight=${opts.cpuWeight}`,
    "--", ...cmd,
  ];
}

/** Set the agents' slice MemoryMax (runtime only: a user-manager restart loses it, so every scoped
 *  launch sets it again). No sudo: the user manager owns the slice. Never throws. */
export async function limitAgentsSlice(maxGb: number, env: Env): Promise<boolean> {
  if (!(maxGb > 0)) return true;
  const r = await runCmd(["systemctl", "--user", "set-property", "--runtime", AGENTS_SLICE, `MemoryMax=${Math.floor(maxGb * 1024)}M`], { env, allowFail: true, timeoutMs: 5_000 }).catch(() => undefined);
  return r?.code === 0;
}

// ---- a dead user manager or user bus ----
// Each scoped launch asks the user manager first. When it is down, the run starts unscoped (still
// with its positive score) and the state is kept here for /api/health and a notification.

/** Lingering is on for this user (deploy/bootstrap.sh): a user manager SHOULD be running. */
export function lingering(env: Env = process.env, user = userName()): boolean {
  return existsSync(`${env.ORCA_LINGER_DIR ?? "/var/lib/systemd/linger"}/${user}`);
}
function userName(): string {
  try { return userInfo().username; } catch { return ""; }
}

/** Is the user manager there and answering? `is-system-running` exits nonzero for "degraded" too,
 *  so only no answer (the bus is gone) counts as down. */
export async function userManagerCheck(env: Env): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!existsSync(busSocketPath(env))) return { ok: false, reason: `no user bus at ${busSocketPath(env)}` };
  const r = await runCmd(["systemctl", "--user", "is-system-running"], { env, allowFail: true, timeoutMs: 5_000 }).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
  const state = r.stdout.trim();
  if (state && state !== "offline" && state !== "unknown") return { ok: true };
  return { ok: false, reason: (r.stderr.trim().split("\n")[0] || `user manager state: ${state || "no answer"}`).slice(0, 200) };
}

export type UserManagerDown = { since: number; reason: string };
let down: UserManagerDown | undefined;
let onDown: ((d: UserManagerDown, run: { repo?: string; branch?: string }) => void) | undefined;
/** index.ts sends a notification (notify.emit) when the user manager goes down. */
export function onUserManagerDown(fn: typeof onDown): void { onDown = fn; }
/** Record what the last check found. A change to down calls the hook once (with the run that found
 *  it, so the notification opens its card); a good check clears it. */
export function noteUserManager(result: { ok: true } | { ok: false; reason: string }, run: { repo?: string; branch?: string } = {}, now = Date.now()): void {
  if (result.ok) { down = undefined; return; }
  if (down) return;
  down = { since: now, reason: result.reason };
  console.error(`orca: the user manager is down (${result.reason}); agent runs start without a memory scope until it is back`);
  try { onDown?.(down, run); } catch { /* a listener must not break a launch */ }
}
/** The user manager as the last launch found it: down since when and why, or undefined. */
export const userManagerDown = (): UserManagerDown | undefined => down;

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
