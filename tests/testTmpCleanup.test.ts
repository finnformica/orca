// A test run leaves nothing in /tmp: the preload (tests/env.ts) puts every temp dir of the run in
// one TMPDIR and removes it at the end. /tmp is a tmpfs, and its pages count against the agents'
// memory cap (2.2 GB of test leftovers once got a worker OOM-killed). A child `bun test` runs a
// file that makes a scratch repo; the child's parent TMPDIR must be empty afterwards.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

test("a bun test run removes its temp dirs at the end", () => {
  const parent = mkdtempSync(join(tmpdir(), "orca-tmp-cleanup-"));
  const p = Bun.spawnSync([process.execPath, "test", "./tests/tmpCleanupFixture.ts"], {
    cwd: ROOT, env: { ...process.env, TMPDIR: parent, ORCA_RUN_SLOT: "1" } as Record<string, string>, stdout: "pipe", stderr: "pipe",
  });
  expect(p.stderr.toString()).toContain("1 pass");
  expect(p.exitCode).toBe(0);
  expect(readdirSync(parent)).toEqual([]);
});
