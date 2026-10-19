// Which of deploy/harden.sh's protections this box is missing (CLAUDE.md "Box crash safety"), for
// the Overview's instance card: no swap, no health watchdog (orca-health.timer), and — with
// lingering on — a user manager that is down or not protected from the OOM killer; plus the last
// OOM kill in the kernel log, when this user may read it. Linux only; elsewhere (the laptop) there
// is no report.
//
// Read-only and cheap enough, but it shells out several times, so `/api/health` (polled) gets a
// cached copy (`protectionsReport`, PROTECTIONS_TTL_MS). The parsing is pure and pinned in
// tests/protections.test.ts; the probe reads through `runCmd`, so a test shims the binaries on PATH.
import { readFileSync } from "node:fs";
import { lingering, type UserManagerDown } from "./cgroup";
import { runCmd } from "./run";

export type ProtectionKey = "swap" | "healthWatchdog" | "userManager" | "userManagerOom";
export type Protections = {
  /** What is missing, in the card's words. Empty: every protection is in place. */
  missing: { key: ProtectionKey; label: string }[];
  /** The newest OOM kill the kernel log shows (ms), null when it shows none, absent when unreadable. */
  lastOomKill?: number | null;
  at: number;
};

/** What the probe found, raw. Each field undefined = could not tell (never counted as missing). */
export type ProbeResult = {
  swapTotalBytes?: number;
  /** `systemctl is-active orca-health.timer`: the health watchdog that restarts a bridge that is
   *  alive but does not answer (deploy/health-check.sh). */
  healthTimer?: string;
  /** `systemctl show user@<uid>.service -p ActiveState -p OOMScoreAdjust`, read only when lingering
   *  is on (else no user manager is expected). After the 2026-10-18 OOM it was dead for 9 hours. */
  userManager?: string;
  /** The kernel log lines that name an OOM kill (journalctl -k / dmesg); undefined = unreadable. */
  kernelLog?: string;
};

/** /proc/meminfo's SwapTotal in bytes; undefined without the line. Pure. */
export function swapTotalBytes(meminfo: string): number | undefined {
  const m = meminfo.match(/^SwapTotal:\s*(\d+)\s*kB/m);
  return m ? Number(m[1]) * 1024 : undefined;
}

/** The missing protections, from what the probe found. Pure. */
export function missingProtections(p: ProbeResult): Protections["missing"] {
  const out: Protections["missing"] = [];
  if (p.swapTotalBytes !== undefined && p.swapTotalBytes <= 0) out.push({ key: "swap", label: "no swap" });
  if (p.healthTimer !== undefined && p.healthTimer.trim() !== "active") out.push({ key: "healthWatchdog", label: "no health watchdog" });
  if (p.userManager !== undefined) {
    const field = (k: string) => p.userManager!.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
    const state = field("ActiveState");
    const adj = Number(field("OOMScoreAdjust"));
    if (state !== undefined && state !== "active") out.push({ key: "userManager", label: `user manager ${state}: agent runs have no memory scope` });
    // deploy/harden.sh sets -900; the default (100) made it the memcg OOM killer's first pick.
    if (Number.isFinite(adj) && adj > -900) out.push({ key: "userManagerOom", label: "user manager not protected from the OOM killer" });
  }
  return out;
}

const OOM_LINE = /Out of memory|oom-kill|oom_reaper|Killed process \d+/i;

/** The newest OOM kill in kernel log text (`journalctl -k -o short-iso` or `dmesg --time-format
 *  iso`): the leading ISO time of the last line that names one. Null when no line does. Pure. */
export function lastOomKill(log: string): number | null {
  let last: number | null = null;
  for (const line of log.split("\n")) {
    if (!OOM_LINE.test(line)) continue;
    const m = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:[.,]\d+)?(Z|[+-]\d\d:?\d\d)?/);
    if (!m) continue;
    const zone = !m[2] ? "Z" : m[2] === "Z" ? "Z" : m[2].includes(":") ? m[2] : `${m[2].slice(0, 3)}:${m[2].slice(3)}`;
    const t = Date.parse(`${m[1]}${zone}`);
    if (Number.isFinite(t) && (last === null || t > last)) last = t;
  }
  return last;
}

/** The text that names an OOM kill, from the first log this user can read; undefined when none. */
async function kernelLog(): Promise<string | undefined> {
  const journal = await runCmd(["journalctl", "-k", "--no-pager", "-o", "short-iso", "--since", "-30d", "-g", "Out of memory|oom-kill|Killed process"], { allowFail: true, timeoutMs: 5_000 }).catch(() => undefined);
  // 0: matches; 1: no match (journalctl -g). Not -q: without it, a user who may not read the
  // system journal gets a warning on stderr, so "unreadable" never reads as "no OOM kill".
  if (journal && !journal.stderr.trim() && (journal.code === 0 || journal.code === 1)) return journal.stdout;
  const dmesg = await runCmd(["dmesg", "--time-format", "iso"], { allowFail: true, timeoutMs: 5_000 }).catch(() => undefined);
  if (dmesg && dmesg.code === 0) return dmesg.stdout;
  return undefined;
}

const out = async (cmd: string[]): Promise<string | undefined> => {
  const r = await runCmd(cmd, { allowFail: true, timeoutMs: 5_000 }).catch(() => undefined);
  return r && r.stdout.trim() ? r.stdout.trim() : undefined;
};

export type ProbePaths = { meminfo?: string; user?: string };

/** Look at this box. `paths` lets a test point the file reads elsewhere. */
export async function probe(paths: ProbePaths = {}, uid = process.getuid?.() ?? 0): Promise<ProbeResult> {
  let meminfo: string | undefined;
  try { meminfo = readFileSync(paths.meminfo ?? "/proc/meminfo", "utf8"); } catch { /* not Linux */ }
  const [healthTimer, userManager, log] = await Promise.all([
    out(["systemctl", "is-active", "orca-health.timer"]),
    lingering(process.env, paths.user) ? out(["systemctl", "show", `user@${uid}.service`, "-p", "ActiveState", "-p", "OOMScoreAdjust"]) : Promise.resolve(undefined),
    kernelLog(),
  ]);
  return { swapTotalBytes: meminfo === undefined ? undefined : swapTotalBytes(meminfo), healthTimer, userManager, kernelLog: log };
}

export async function protections(paths?: ProbePaths): Promise<Protections> {
  const p = await probe(paths);
  return { missing: missingProtections(p), lastOomKill: p.kernelLog === undefined ? undefined : lastOomKill(p.kernelLog), at: Date.now() };
}

/** The cached report plus what the last launch found (cgroup.userManagerDown), which must not wait
 *  five minutes for the next probe: it replaces the probe's own user-manager line. Pure. */
export function withLiveState(p: Protections, down: UserManagerDown | undefined): Protections {
  if (!down) return p;
  const line = { key: "userManager" as const, label: `user manager down since ${new Date(down.since).toISOString().slice(0, 16).replace("T", " ")} UTC: agent runs have no memory scope (${down.reason})` };
  return { ...p, missing: [...p.missing.filter((m) => m.key !== "userManager"), line] };
}

export const PROTECTIONS_TTL_MS = 5 * 60_000;
let cached: { value: Promise<Protections>; at: number } | undefined;
/** This box's report for `/api/health`: cached for five minutes, absent off Linux. */
export function protectionsReport(now = Date.now()): Promise<Protections> | undefined {
  if (process.platform !== "linux") return undefined;
  if (!cached || now - cached.at > PROTECTIONS_TTL_MS) cached = { value: protections().catch(() => ({ missing: [], at: now })), at: now };
  return cached.value;
}
