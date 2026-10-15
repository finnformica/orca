import { scrubbedEnv, type Env } from "./env";

export type RunOptions = {
  cwd?: string;
  /** Laid over the scrubbed live env (server/env.ts); a key set to `undefined` is removed. */
  env?: Env;
  /** Kill the process after this long; it then fails as a timeout. */
  timeoutMs?: number;
  stdin?: Blob | ReadableStream | "ignore";
  /** Return a nonzero exit instead of throwing. */
  allowFail?: boolean;
};
export type RunResult = { stdout: string; stderr: string; code: number };

/** Spawn, collect stdout/stderr, optionally time out, throw on a nonzero exit (unless `allowFail`).
 *  The env is the bridge's LIVE env — Bun.spawn otherwise snapshots PATH at startup, which defeats
 *  a test's PATH shim for `gh` — minus Orca's secrets: git hooks in an agent-edited worktree run
 *  under this, and must not find the Slack token or database URL. */
export async function runCmd(cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: scrubbedEnv(opts.env), stdin: opts.stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs) : undefined;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer));
  if (timedOut && !opts.allowFail) throw new Error(`${cmd.join(" ")} timed out after ${opts.timeoutMs}ms`);
  if (code !== 0 && !opts.allowFail) {
    throw new Error(`${cmd.join(" ")} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`);
  }
  return { stdout, stderr, code };
}

/** Run a command, capture stdout, throw on non-zero exit. */
export async function run(cmd: string[], cwd?: string): Promise<string> {
  return (await runCmd(cmd, { cwd })).stdout;
}
