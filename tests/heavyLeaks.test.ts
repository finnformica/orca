// The heavy queue's leak detector (server/heavyLeaks.ts): heavy processes in the agents' slice with
// no ORCA_RUN_SLOT, shown on the machine card and in `orca machine` as "unqueued heavy: N".
import { expect, test } from "bun:test";
import type { ProcInfo } from "../server/browserWatch";
import { findLeaks, hasSlot, heavyName, leakReport, sweep, unqueuedSummary } from "../server/heavyLeaks";
import { machineSummary, machineText, unqueuedHeavyText, type MachineReport } from "../web/src/workstream";

const RUN = "0f5e3c1a-1111-4222-8333-444455556666";
const inRun = `/user.slice/user-1000.slice/user@1000.service/orca-agents.slice/orca-run-${RUN}.scope`;
const inSlot = "/user.slice/user-1000.slice/user@1000.service/orca-agents.slice/orca-heavy-ab12cd34.scope";
const outside = "/system.slice/orca.service";

test("HL1: heavy command lines by tool and subcommand, through node or bun", () => {
  expect(heavyName(["node", "/w/node_modules/vitest/vitest.mjs", "run"])).toBe("vitest");
  expect(heavyName(["node", "--max-old-space-size=4096", "/w/node_modules/typescript/bin/tsc", "--noEmit"])).toBe("tsc");
  expect(heavyName(["node", "/w/node_modules/jest/bin/jest.js"])).toBe("jest");
  expect(heavyName(["bun", "test", "a.test.ts"])).toBe("bun test");
  expect(heavyName(["/w/node_modules/turbo-linux-64/bin/turbo", "run", "build"])).toBe("turbo");
  expect(heavyName(["node", "/w/node_modules/vite/bin/vite.js", "build"])).toBe("vite build");
  expect(heavyName(["node", "/w/node_modules/next/dist/bin/next", "build"])).toBe("next build");
  expect(heavyName(["node", "/w/node_modules/@playwright/test/cli.js", "test"])).toBe("playwright test");
  // Not heavy: a dev server, a script runner, the shim and orca-run themselves, the agent.
  expect(heavyName(["node", "/w/node_modules/vite/bin/vite.js", "--port", "5173"])).toBeUndefined();
  expect(heavyName(["bun", "run", "check"])).toBeUndefined();
  expect(heavyName(["/bin/sh", "/opt/x/bin/worker/tsc", "--noEmit"])).toBeUndefined();
  expect(heavyName(["bun", "/opt/x/bin/worker/orca-run", "--kind", "test", "--", "vitest"])).toBeUndefined();
  expect(heavyName(["claude", "-p", "run vitest"])).toBeUndefined();
  expect(heavyName([])).toBeUndefined();
});

test("HL2: a slot is a real ORCA_RUN_SLOT; orca-run's no-bridge fallback 'none' is not", () => {
  expect(hasSlot("PATH=/bin\0ORCA_RUN_SLOT=heavy-1a2b\0")).toBe(true);
  expect(hasSlot("PATH=/bin\0ORCA_RUN_SLOT=none\0")).toBe(false);
  expect(hasSlot("PATH=/bin\0ORCA_RUN_SLOT=\0")).toBe(false);
  expect(hasSlot("PATH=/bin\0")).toBe(false);
});

test("HL3: only the top unqueued heavy process of a tree in the agents' slice counts", () => {
  const procs: ProcInfo[] = [
    { pid: 10, ppid: 1, cgroup: inRun, argv: ["claude", "-p"], comm: "claude" },
    // A leaked vitest and its fork worker: one leak.
    { pid: 11, ppid: 10, cgroup: inRun, argv: ["node", "/w/node_modules/vitest/vitest.mjs", "run"], comm: "node" },
    { pid: 12, ppid: 11, cgroup: inRun, argv: ["node", "/w/node_modules/vitest/vitest.mjs", "--worker"], comm: "node" },
    // A leaked tsc.
    { pid: 13, ppid: 10, cgroup: inRun, argv: ["node", "/w/node_modules/typescript/bin/tsc"], comm: "node" },
    // Queued: it carries a slot, or it runs in a slot's scope.
    { pid: 14, ppid: 10, cgroup: inRun, argv: ["bun", "test"], comm: "bun" },
    { pid: 15, ppid: 1, cgroup: inSlot, argv: ["node", "/w/node_modules/jest/bin/jest.js"], comm: "node" },
    // Outside the agents' slice (the bridge's own tree): not a worker's.
    { pid: 16, ppid: 1, cgroup: outside, argv: ["bun", "test"], comm: "bun" },
    // Unreadable (gone): skipped.
    { pid: 17, ppid: 10, cgroup: inRun, argv: ["bun", "test"], comm: "bun" },
  ];
  const env: Record<number, string | null> = { 11: "PATH=/bin\0", 12: "PATH=/bin\0", 13: "ORCA_RUN_SLOT=none\0", 14: "ORCA_RUN_SLOT=heavy-1\0", 15: "", 16: "", 17: null };
  const leaks = findLeaks(procs, (pid) => (pid in env ? env[pid] ?? null : ""), 999);
  expect(leaks).toEqual([{ pid: 11, name: "vitest", runId: RUN }, { pid: 13, name: "tsc", runId: RUN }]);
  expect(leakReport(leaks, 5)).toEqual({ at: 5, count: 2, names: ["tsc", "vitest"], leaks });
});

test("HL4: a pass keeps its report for the card and `orca machine`, and both print 'unqueued heavy: N'", () => {
  const procs: ProcInfo[] = [{ pid: 21, ppid: 1, cgroup: inRun, argv: ["node", "/w/node_modules/next/dist/bin/next", "build"], comm: "node" }];
  sweep({ procs: () => procs, environ: () => "", now: () => 7, log: false });
  expect(unqueuedSummary()).toEqual({ at: 7, count: 1, names: ["next build"] });
  expect(unqueuedHeavyText(unqueuedSummary())).toBe("unqueued heavy: 1 (next build)");
  sweep({ procs: () => [], environ: () => "", now: () => 8, log: false });
  expect(unqueuedHeavyText(unqueuedSummary())).toBe("unqueued heavy: 0");
  expect(unqueuedHeavyText(undefined)).toBeUndefined();

  const report: MachineReport = {
    instance: "box", at: 0, cores: 4, memTotalGb: 16, diskCapMBs: 125, stepMs: 15_000,
    summary: machineSummary([], 4), heavy: { running: 1, queued: 0, unqueued: { count: 2, names: ["tsc", "vitest"] } }, samples: [],
  };
  expect(machineText(report)).toContain("Heavy queue: 1 running, 0 queued · unqueued heavy: 2 (tsc, vitest)");
  // An older bridge, or before the first pass: no line.
  expect(machineText({ ...report, heavy: { running: 1, queued: 0 } })).toContain("Heavy queue: 1 running, 0 queued\n");
});
