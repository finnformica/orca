// Fail fast when git would act on another repository. A git hook exports GIT_DIR (and friends); a
// suite started from a hook in a linked worktree once re-initialised the MAIN clone (core.bare=true,
// the scratch identity) and committed a scratch "init" over a worker's branch, because every test
// that spawns git with process.env passed GIT_DIR on. Unset them before `bun test`.
import { inheritedGitRepoVars } from "../server/env";
const gitRepoVars = inheritedGitRepoVars();
if (gitRepoVars.length) {
  throw new Error(`bun test refuses to start: ${gitRepoVars.join(", ")} set. Git would act on that repository, not the tests' scratch repos. Run: unset ${gitRepoVars.join(" ")}`);
}
// orca.config now requires ORCA_DEV_ROOT (fails loudly otherwise). Give the test suite a default so
// files that import orca.config (e.g. previewPreflight.test.ts) don't throw at import time. Real
// runs still require the operator to set it; this only covers the test process.
process.env.ORCA_DEV_ROOT ??= `${process.env.HOME}/Documents`;
// server/preview.ts persists its registry to TMPDIR/orca-previews.json at import-time-resolved path,
// and a test's start/stop rewrites it with only the test's previews — which once wiped the LIVE
// bridge's registry. Every test process gets its own TMPDIR, set here before anything imports it.
// Every temp dir of the run (each `mkdtemp(tmpdir())`, the helpers' scratch repos and shims) is in it,
// and the run removes it at the end: /tmp is a tmpfs whose pages count against the agents' memory cap.
// One hook at the end, not one per test: a fixture dir often outlives the test that made it.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const runTmp = mkdtempSync(join(tmpdir(), "orca-test-"));
process.env.TMPDIR = runTmp;
afterAll(() => rmSync(runTmp, { recursive: true, force: true }));
// The agent scope (server/cgroup.ts) reads this host: the real user manager and its
// orca-agents.slice (which the LIVE bridge on a box uses) and the lingering file. Off for the
// suite; tests/agentScope.test.ts turns each one on.
process.env.ORCA_AGENTS_SLICE_MAX_GB = "0";
process.env.ORCA_LINGER_DIR = mkdtempSync(join(runTmp, "orca-test-linger-"));
// The OOM cause of a killed run reads the cgroup tree: an empty one for the suite (tests/oom.test.ts).
process.env.ORCA_CGROUP_ROOT = mkdtempSync(join(runTmp, "orca-test-cgroup-"));
