// The verification gate: after a run that committed, Orca runs the repo's own check command in the
// worktree and records the result on the turn. "Claude stops when the work looks done. Without a
// check it can run, 'looks done' is the only signal" — so the check is Orca's, deterministic, not
// the agent's self-report in the outcome's Verification section. The output tail is kept as the
// evidence a fix follow-up is given.
//
// The check is heavy (a repo's `bun install --frozen-lockfile && bun run check` is an install, tsc
// and a whole test suite), so it takes a slot of the box-wide queue (server/heavy.ts) like every
// worker command. 2026-10-20: three checks and two worker builds ran at once on a 4 vCPU box while
// the machine card showed the queue almost empty.
import * as cgroup from "./cgroup";
import { agentEnv } from "./env";
import * as heavy from "./heavy";
import { runCmd } from "./run";
import type { TurnCheck } from "../shared/agent";

const OUTPUT_TAIL = 4_000; // chars of combined output kept on the turn — enough for a failing test's name and assertion
const TIMEOUT_MS = 10 * 60_000;
/** An install plus the whole gate costs like a build (the pre-push gate queues as `build` too). */
export const CHECK_KIND: heavy.HeavyKind = "build";

export type CheckOpts = {
  /** The queue to take the slot from (default: the bridge's one). */
  slots?: heavy.SlotManager;
  /** Run the command in the slot's capped scope (default: when the box has a user bus). */
  scoped?: boolean;
  repo?: string;
  branch?: string;
};

/** Run `command` through `sh -lc` in `cwd` in a slot of the heavy queue; never throws. The slot comes
 *  back on every exit path: a pass, a fail, a timeout and a spawn that throws. */
export async function runCheck(cwd: string, command: string, o: CheckOpts = {}): Promise<TurnCheck> {
  const startedAt = Date.now();
  const slots = o.slots ?? heavy.slots();
  let grant: heavy.Grant | undefined;
  try {
    grant = await slots.acquire({ kind: CHECK_KIND, command: `check: ${command}`.slice(0, 500), cwd, ...(o.repo ? { repo: o.repo } : {}), ...(o.branch ? { branch: o.branch } : {}) });
  } catch (e) {
    // The queue must not stop the gate. With no slot and no ORCA_RUN_SLOT, the shims inside the
    // command still queue each heavy tool on their own.
    console.error(`orca: check in ${cwd} runs with no slot (${e instanceof Error ? e.message : e})`);
  }
  const scoped = grant !== undefined && (o.scoped ?? cgroup.available());
  try {
    const prefix = grant && scoped ? heavy.scopePrefix({ available: true, unit: grant.unit, memoryMaxGb: grant.memoryGb, slice: cgroup.AGENTS_SLICE }) : [];
    // The agent's env (bin/worker on PATH, never Orca's secrets): the check runs the worktree's code.
    // ORCA_RUN_SLOT: the shims under the check pass straight through, so it queues exactly once.
    const env: Record<string, string> = { PATH: agentEnv().PATH ?? "", ...(scoped ? cgroup.runtimeEnv() : {}), ...(grant ? { ORCA_RUN_SLOT: grant.id } : {}) };
    const { stdout: out, stderr: err, code } = await runCmd([...prefix, "sh", "-lc", command], { cwd, env, timeoutMs: TIMEOUT_MS, allowFail: true })
      .catch((e) => ({ stdout: "", stderr: e instanceof Error ? e.message : String(e), code: 127 }));
    const combined = `${out}${err}`.trim();
    return {
      command,
      ok: code === 0,
      exitCode: code,
      output: combined.length > OUTPUT_TAIL ? `…${combined.slice(-OUTPUT_TAIL)}` : combined,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    // A timeout kills only `sh`: stop the scope, so a test server or a build it left dies too.
    if (grant && scoped) heavy.stopHeavyScope(grant.unit);
    grant?.release();
  }
}
