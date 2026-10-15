// Process lookups — who listens on a port, where a process runs, which headless agents are alive.
// One copy of each, so the cwd-not-argv rule (a prompt is passed in argv, and the orchestrator's
// carries the whole board) can't drift between the callers again. Every lookup is best effort: a
// missing `ps`/`lsof`, or a process that's gone, reads as "nothing".
import { existsSync, readlinkSync } from "fs";

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

// ---- Orca's own bridges (incident 2026-10-15: a preview bridge outlived its worktree by 19h) ----

const program = (command: string): string => command.trim().split(/\s+/)[0]?.split("/").pop() ?? "";

/** An Orca bridge, or the pieces of a branch preview's: `bun … server/index.ts`, the
 *  `scripts/preview-orca.sh` wrapper (under sh/bash), or the `bun -e` shim it forwards to main with.
 *  A headless agent is never one, whatever its prompt (in argv) mentions. */
export function isOrcaBridgeCommand(command: string): boolean {
  if (isHeadlessAgentProcess(command)) return false;
  const prog = program(command);
  if (prog === "bun") return /(^|[\s/])server\/index\.ts(\s|$)/.test(command) || command.includes("process.env.MAIN");
  return (prog === "sh" || prog === "bash") && command.includes("preview-orca.sh");
}

/** A cwd that was deleted under its process: Linux reads it back as `<path> (deleted)`; elsewhere it
 *  just no longer exists. Unknown (unreadable) is NOT deleted. */
export const cwdDeleted = (cwd: string | undefined): boolean => Boolean(cwd) && (cwd!.endsWith(" (deleted)") || !existsSync(cwd!));

/** A process left with a deleted cwd that `orca sweep` stops: any bun process (a bridge, a shim, a
 *  worker's forgotten `bun test`) or a preview wrapper. Nothing alive can use a deleted checkout. */
const sweepable = (command: string): boolean => !isHeadlessAgentProcess(command) && (program(command) === "bun" || isOrcaBridgeCommand(command));

export type ProcInfo = { pid: number; command: string; cwd: string | undefined };
export type ProcRow = { pid: number; ppid: number; command: string };

/** Every process: pid, parent, command line. Empty when `ps` can't be run. */
export async function processTable(): Promise<ProcRow[]> {
  let out = "";
  try {
    const proc = Bun.spawn(["ps", "-Ao", "pid=,ppid=,command="], { env: process.env, stdout: "pipe", stderr: "ignore" });
    out = await new Response(proc.stdout).text();
    await proc.exited;
  } catch { return []; }
  return out.split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }));
}

/** The nearest Orca bridge above `pid` (its parent, or a wrapper's parent — a hydra shim, a scope),
 *  or undefined when there is none: a run whose bridge died was reparented to init / a subreaper,
 *  which is what an adopted run looks like. Pure over a `processTable`. */
export function bridgeAncestor(pid: number, table: ProcRow[]): ProcRow | undefined {
  const byPid = new Map(table.map((r) => [r.pid, r]));
  const seen = new Set<number>();
  for (let p = byPid.get(pid)?.ppid; p && p > 1 && !seen.has(p); p = byPid.get(p)?.ppid) {
    seen.add(p);
    const row = byPid.get(p);
    if (!row) return undefined;
    if (isOrcaBridgeCommand(row.command)) return row;
  }
  return undefined;
}

/** Every process (but this one and its ancestors — the supervisor) whose command passes `keep`,
 *  with its cwd. Filtered on the command BEFORE the cwd lookup, which costs an lsof on macOS. */
export async function processesWhere(keep: (command: string) => boolean): Promise<ProcInfo[]> {
  const rows = await processTable();
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const mine = new Set<number>();
  for (let p: number | undefined = process.pid; p && !mine.has(p); p = parent.get(p)) mine.add(p);
  return rows.filter((r) => !mine.has(r.pid) && keep(r.command)).map((r) => ({ pid: r.pid, command: r.command, cwd: processCwd(r.pid) }));
}

/** Processes `orca sweep` reports and, confirmed, stops: see `sweepable`. */
export const strayProcesses = async (): Promise<ProcInfo[]> => (await processesWhere(sweepable)).filter((p) => cwdDeleted(p.cwd));

/** An Orca bridge's processes running IN a worktree (by cwd — deleted or not), for its removal. */
export const bridgesIn = async (worktreePath: string): Promise<ProcInfo[]> =>
  (await processesWhere(isOrcaBridgeCommand)).filter((p) => cwdInWorktree(p.cwd?.replace(/ \(deleted\)$/, ""), worktreePath));

/** SIGTERM them, a preview wrapper first: killed after its bridge, it would see the bridge exit and
 *  start a forward shim on the port. Returns the pids it signalled. */
export function terminate(list: ProcInfo[]): number[] {
  const done: number[] = [];
  for (const p of [...list].sort((a, b) => Number(program(b.command) !== "bun") - Number(program(a.command) !== "bun"))) {
    try { process.kill(p.pid, "SIGTERM"); done.push(p.pid); } catch { /* already gone */ }
  }
  return done;
}

/** Stop the Orca bridges (a branch preview's bridge, its wrapper, its shim) running in a worktree
 *  — the worktree's removal makes them strays. preview.stop handles the services it tracks; this
 *  catches what it doesn't (started by an earlier bridge, or by hand). */
export async function stopBridgesIn(worktreePath: string): Promise<number[]> {
  return terminate(await bridgesIn(worktreePath));
}
