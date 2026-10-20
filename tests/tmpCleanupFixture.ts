// Run only by tests/testTmpCleanup.test.ts (not a *.test.ts file, so the suite skips it).
import { expect, test } from "bun:test";
import { existsSync } from "fs";
import { makeScratchRepo } from "./helpers";

test("makes a scratch repo under the run's TMPDIR", async () => {
  const repo = await makeScratchRepo();
  expect(existsSync(repo)).toBe(true);
});
