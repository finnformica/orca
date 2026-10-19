// orca.config now requires ORCA_DEV_ROOT (fails loudly otherwise). Give the test suite a default so
// files that import orca.config (e.g. previewPreflight.test.ts) don't throw at import time. Real
// runs still require the operator to set it; this only covers the test process.
process.env.ORCA_DEV_ROOT ??= `${process.env.HOME}/Documents`;
// The agent scope (server/cgroup.ts) reads this host: the real user manager and its
// orca-agents.slice (which the LIVE bridge on a box uses) and the lingering file. Off for the
// suite; tests/agentScope.test.ts turns each one on.
process.env.ORCA_AGENTS_SLICE_MAX_GB = "0";
process.env.ORCA_LINGER_DIR = mkdtempSync(join(tmpdir(), "orca-test-linger-"));
// The OOM cause of a killed run reads the cgroup tree: an empty one for the suite (tests/oom.test.ts).
process.env.ORCA_CGROUP_ROOT = mkdtempSync(join(tmpdir(), "orca-test-cgroup-"));
// server/preview.ts persists its registry to TMPDIR/orca-previews.json at import-time-resolved path,
// and a test's start/stop rewrites it with only the test's previews — which once wiped the LIVE
// bridge's registry. Every test process gets its own TMPDIR, set here before anything imports it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.TMPDIR = mkdtempSync(join(tmpdir(), "orca-test-"));
