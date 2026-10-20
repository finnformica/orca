// Orca's own post-run check (server/check.ts) takes a slot of the heavy queue (server/heavy.ts) and
// gives it back on every exit path. 2026-10-20: the repo's `bun install --frozen-lockfile && bun run
// check` ran with no slot, beside worker builds, and the machine card showed the queue almost empty.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CHECK_KIND, runCheck } from "../server/check";
import { createSlotManager, heavySettings, type HeavySettings } from "../server/heavy";

const saved = { PATH: process.env.PATH, ORCA_RUN_SLOT: process.env.ORCA_RUN_SLOT, ORCA_URL: process.env.ORCA_URL };
let dir: string;
let fake: string;

beforeAll(() => {
  // This test may itself run under orca-run: the check must set its own slot, not inherit one.
  delete process.env.ORCA_RUN_SLOT;
  // A shim that queued again would ask this dead port and say "orca-run: no bridge".
  process.env.ORCA_URL = "http://127.0.0.1:9";
  fake = mkdtempSync(join(tmpdir(), "orca-check-bin-"));
  writeFileSync(join(fake, "tsc"), `#!/bin/sh\necho "tsc $* slot=\${ORCA_RUN_SLOT:-none}"\nexit \${TSC_EXIT:-0}\n`);
  chmodSync(join(fake, "tsc"), 0o755);
  process.env.PATH = `${fake}:${process.env.PATH}`;
  dir = mkdtempSync(join(tmpdir(), "orca-check-wt-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { check: "tsc --noEmit && echo check slot=${ORCA_RUN_SLOT:-none}" } }));
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(fake, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const manager = (over: Partial<HeavySettings> = {}) => createSlotManager({ settings: () => ({ ...heavySettings(undefined), ...over }), stop: () => {} });

test("CQ1: the check holds one build slot while it runs, its shims pass through, and the slot comes back", async () => {
  const m = manager();
  let during: number | undefined;
  const pending = runCheck(dir, "bun run check", { slots: m, scoped: false, repo: "orca", branch: "feat" });
  for (let i = 0; i < 100 && !m.view().running.length; i++) await Bun.sleep(5);
  during = m.view().running.length;
  const entry = m.view().running[0]!;
  expect(entry.kind).toBe(CHECK_KIND);
  expect(entry.command).toBe("check: bun run check");
  expect(entry.branch).toBe("feat");
  const r = await pending;
  expect(during).toBe(1);
  expect(r.ok).toBe(true);
  // `bun run check` and the tsc inside it ran under the check's slot: queued once, not again.
  expect(r.output).toContain(`tsc --noEmit slot=${entry.id}`);
  expect(r.output).toContain(`check slot=${entry.id}`);
  expect(r.output).not.toContain("orca-run");
  expect(m.view().running).toHaveLength(0);
});

test("CQ2: a failed check and a check that cannot start both give the slot back", async () => {
  const m = manager();
  const failed = await runCheck(dir, "TSC_EXIT=2 bun run check", { slots: m, scoped: false });
  expect(failed.ok).toBe(false);
  expect(m.view().running).toHaveLength(0);
  const gone = await runCheck(join(dir, "no-such-dir"), "true", { slots: m, scoped: false });
  expect(gone.ok).toBe(false);
  expect(m.view().running).toHaveLength(0);
});

test("CQ3: a check waits in line behind a full queue, then runs", async () => {
  const m = manager({ limits: { ...heavySettings(undefined).limits, build: 1 } });
  const holder = await m.acquire({ kind: "build", command: "worker build" });
  let done = false;
  const pending = runCheck(dir, "echo ok slot=$ORCA_RUN_SLOT", { slots: m, scoped: false }).then((r) => { done = true; return r; });
  await Bun.sleep(100);
  expect(done).toBe(false);
  expect(m.view().queued.map((e) => e.command)).toEqual(["check: echo ok slot=$ORCA_RUN_SLOT"]);
  holder.release();
  const r = await pending;
  expect(r.output).toMatch(/^ok slot=heavy-/);
  expect(m.view().running).toHaveLength(0);
});

test("CQ4: when the wait fails the check still runs, with no slot, so the inner shims queue themselves", async () => {
  const m = manager({ maxWaitMs: 20 });
  const holder = await m.acquire({ kind: "build", command: "worker build" });
  const r = await runCheck(dir, "echo slot=${ORCA_RUN_SLOT:-none}", { slots: m, scoped: false });
  expect(r.ok).toBe(true);
  expect(r.output).toBe("slot=none");
  holder.release();
  expect(m.view().running).toHaveLength(0);
});
