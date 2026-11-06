// A worker's own tool output can hold U+0000 (a `wrangler dev` banner prints "Ready on
// http://localhost:8790\0"), and Postgres refuses it in text/jsonb (PostgresError 22P05). Before
// this, one such step failed the whole run's transcript write ("orca: transcript write failed").
// shared/sanitize.ts strips it at every insert of worker-sourced text (server/db.ts), so a run with
// a NUL byte anywhere in its output still lands.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import { stripNul, stripNulDeep } from "../shared/sanitize";
import { freshSchema, type TestDb } from "./pg";

test("stripNul removes every U+0000, leaving the rest of the text untouched", () => {
  expect(stripNul("Ready on http://localhost:8790\u0000")).toBe("Ready on http://localhost:8790");
  expect(stripNul("no nul here")).toBe("no nul here");
});

test("stripNulDeep walks nested objects and arrays, stripping every string", () => {
  const value = {
    text: "line one\u0000",
    input: { command: "wrangler dev\u0000", flags: ["--local\u0000", "--port"] },
    output: null,
    kept: 3,
  };
  expect(stripNulDeep(value)).toEqual({
    text: "line one",
    input: { command: "wrangler dev", flags: ["--local", "--port"] },
    output: null, // the deletion sentinel: never coerced to a string
    kept: 3,
  });
});

// ---- against a real database (server/db.ts: every insert of worker-sourced text) ----

let pg: TestDb;
let state: string;
let prevDbUrl: string | undefined;
let prevStateDir: string | undefined;

beforeEach(async () => {
  prevDbUrl = process.env.ORCA_DATABASE_URL;
  prevStateDir = process.env.ORCA_STATE_DIR;
  state = mkdtempSync(join(tmpdir(), "orca-nul-"));
  process.env.ORCA_STATE_DIR = state;
  pg = await freshSchema("nul");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await db.close();
  await pg.drop();
  if (prevDbUrl === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prevDbUrl;
  if (prevStateDir === undefined) delete process.env.ORCA_STATE_DIR; else process.env.ORCA_STATE_DIR = prevStateDir;
  rmSync(state, { recursive: true, force: true });
});

test("a step with a NUL byte in its text and output lands, and reads back without it", async () => {
  await db.startTurn({ repo: "r", branch: "feat", runId: "run-nul", provider: "claude", prompt: "run wrangler", startedAt: Date.now() });
  await db.appendSteps("run-nul", 1, [
    { at: 1, kind: "tool", name: "Bash", text: "wrangler dev\u0000", output: "Ready on http://localhost:8790\u0000" } as never,
  ]);
  const [row] = await db.steps("run-nul");
  expect(row!.step.text).toBe("wrangler dev");
  expect(row!.step.output).toBe("Ready on http://localhost:8790");
  expect(JSON.stringify(row!.step)).not.toContain("\u0000");
});

test("a turn's prompt, instruction, response and outcome strip a NUL byte before they reach the database", async () => {
  await db.startTurn({
    repo: "r", branch: "feat", runId: "run-turn", provider: "claude",
    instruction: "fix it\u0000", prompt: "fix it\u0000 + scaffolding", startedAt: Date.now(),
  });
  await db.finishTurn("run-turn", {
    status: "done", response: "done\u0000", structured: { outcome: "ok\u0000", verification: [], decisions: [], remaining: [], commits: [] },
    finishedAt: Date.now(),
  });
  const [turn] = await db.turns("r", "feat");
  expect(turn).toMatchObject({ instruction: "fix it", prompt: "fix it + scaffolding", response: "done" });
  expect(turn?.structured?.outcome).toBe("ok");
});

test("a check's command output strips a NUL byte", async () => {
  await db.startTurn({ repo: "r", branch: "feat", runId: "run-check", provider: "claude", prompt: "p", startedAt: Date.now() });
  await db.setCheck("run-check", { command: "bun test", ok: false, exitCode: 1, output: "failed\u0000 here", durationMs: 10 });
  const [turn] = await db.turns("r", "feat");
  expect(turn?.check?.output).toBe("failed here");
});

test("an enrichment patch strips a NUL byte", async () => {
  await db.patchEnrichment("r", "feat", { title: "wrangler dev\u0000" });
  expect((await db.enrichment("r")).feat?.title).toBe("wrangler dev");
});
