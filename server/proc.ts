// Process lookups — who listens on a port, where a process runs, which headless agents are alive.
// One copy of each, so the cwd-not-argv rule (a prompt is passed in argv, and the orchestrator's
// carries the whole board) can't drift between the callers again. Every lookup is best effort: a
// missing `ps`/`lsof`, or a process that's gone, reads as "nothing".
import { readlinkSync } from "fs";

const text = (cmd: string[]): string => {
  try { return Bun.spawnSync(cmd, { env: process.env, stdout: "pipe", stderr: "ignore" }).stdout.toString(); } catch { return ""; }
};

/** Pids LISTENING on a TCP port. `-sTCP:LISTEN` is critical: without it lsof also returns clients
 *  connected to the port — including the bridge itself (a readiness fetch). */
export function listenerPids(port: number): number[] {
  return text(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]).trim().split("\n").filter(Boolean).map(Number).filter((n) => n > 0);
}

/** The working directory of a process, or undefined when it can't be read (gone, or no /proc and
 *  no lsof). Linux reads /proc; macOS asks lsof. */
export function processCwd(pid: number): string | undefined {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { /* not linux, or gone */ }
  return text(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]).split("\n").find((l) => l.startsWith("n"))?.slice(1) || undefined;
}

/** Is `cwd` the worktree or somewhere under it? (`/wt/foo` is not under `/wt/foo-bar`.) */
export const cwdInWorktree = (cwd: string | undefined, worktreePath: string): boolean =>
  Boolean(cwd) && (cwd === worktreePath || cwd!.startsWith(worktreePath.replace(/\/+$/, "") + "/"));

/** A process's command line, or "" when it's gone. */
export const processCommand = (pid: number): string => text(["ps", "-o", "command=", "-p", String(pid)]).trim();

/** A zombie (state Z): exited, never reaped — `kill(pid, 0)` still succeeds on one. False when `ps`
 *  can't say. */
export const isZombie = (pid: number): boolean => text(["ps", "-o", "stat=", "-p", String(pid)]).trim().startsWith("Z");

/** Recognize the headless CLI forms Orca launches, including resumed Cursor conversations. */
export function isHeadlessAgentProcess(line: string): boolean {
  return line.includes("claude -p")
    || line.includes("codex exec")
    || (/(?:^|\s)(?:\S*\/)?cursor-agent(?:\s|$)/.test(line) && /(?:^|\s)(?:-p|--print)(?:\s|$)/.test(line));
}

/** Every live headless agent process but this one, with its cwd (undefined when unreadable). Match
 *  them to a worktree by `cwd`, never by `command`. */
export async function headlessAgents(): Promise<Array<{ pid: number; command: string; cwd: string | undefined }>> {
  let out = "";
  try {
    const proc = Bun.spawn(["ps", "-Ao", "pid=,command="], { env: process.env, stdout: "pipe", stderr: "ignore" });
    out = await new Response(proc.stdout).text();
    await proc.exited;
  } catch { return []; }
  const found: Array<{ pid: number; command: string; cwd: string | undefined }> = [];
  for (const line of out.split("\n")) {
    if (!isHeadlessAgentProcess(line)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (pid && pid !== process.pid) found.push({ pid, command: line.trim().replace(/^\d+\s+/, ""), cwd: processCwd(pid) });
  }
  return found;
}
