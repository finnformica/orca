// Run limits: a run stops on no progress (`agentIdleMinutes`), not on wall-clock time; a hard
// ceiling (`agentMaxRunMinutes`, alias `agentTimeoutMinutes`) is the safety net. The end-to-end
// cases are in backgroundTasks.test.ts (the idle stop, the heavy-queue hold) and
// orchestrator.test.ts O23c (the worker report and the model ladder).
import { expect, test } from "bun:test";
import { parseConfigDocument, runLimits } from "../server/config";
import { idleExpired, runStopLabel } from "../shared/agent";
import { wakeExitReason } from "../web/src/workstream";

test("runLimits: defaults 20 / 240 min, agentTimeoutMinutes is an alias read only without agentMaxRunMinutes", () => {
  expect(runLimits({})).toEqual({ idleMs: 20 * 60_000, timeoutMs: 240 * 60_000 });
  expect(runLimits({ agentTimeoutMinutes: 90 })).toEqual({ idleMs: 20 * 60_000, timeoutMs: 90 * 60_000 });
  expect(runLimits({ agentTimeoutMinutes: 90, agentMaxRunMinutes: 300, agentIdleMinutes: 15 })).toEqual({ idleMs: 15 * 60_000, timeoutMs: 300 * 60_000 });
});

test("the config document parses and checks the new keys", () => {
  const base = { repos: [{ name: "r", repoPath: "/tmp/r", worktreeRoot: "/tmp/r/.worktrees", baseBranch: "main", previewServices: [] }] };
  const ok = parseConfigDocument({ ...base, agentIdleMinutes: 10, agentMaxRunMinutes: 120 });
  expect(ok.errors).toEqual([]);
  expect(ok.config).toMatchObject({ agentIdleMinutes: 10, agentMaxRunMinutes: 120 });
  expect(parseConfigDocument({ ...base, agentIdleMinutes: 0 }).errors).toContain("agentIdleMinutes must be a positive number");
  expect(parseConfigDocument({ ...base, agentMaxRunMinutes: "4h" }).errors).toContain("agentMaxRunMinutes must be a positive number");
});

test("a stop is labelled, never a bare exit 143", () => {
  expect(runStopLabel({ kind: "idle", minutes: 20 })).toBe("stopped: no progress for 20 min");
  expect(runStopLabel({ kind: "ceiling", minutes: 240 })).toBe("stopped: hard limit of 240 min reached");
  expect(wakeExitReason({ kind: "idle", minutes: 20 })).toBe("made no progress for 20 min");
});

test("idleExpired: quiet time counts, a heavy-queue job (busy) never does", () => {
  const at = { lastProgressAt: 0, idleMs: 1000 };
  expect(idleExpired({ ...at, now: 999, busy: false })).toBe(false);
  expect(idleExpired({ ...at, now: 1000, busy: false })).toBe(true);
  expect(idleExpired({ ...at, now: 60_000, busy: true })).toBe(false);
});
