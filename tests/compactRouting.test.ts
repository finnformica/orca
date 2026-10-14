// /api/compact routing for the orchestrator's reserved repo. The orchestrator lives on exactly ONE
// instance (cfg.orchestratorOn); every /api/orchestrator route already forwards there, but
// /api/compact (the context ring's Compact button) is a repo-scoped route that reached
// forwardToOwner's generic placement logic instead — which, for the synthetic orchestrator repo
// object, had no `runsOn` and so always resolved to "wherever the browser happened to be talking
// to", not the host. A compact posted from the non-host instance then tried to `--resume` a Claude
// session that instance never ran, and failed with "No conversation found with session ID …".
//
// Two real bridges (server/index.ts as subprocesses), one shared Postgres schema — same harness as
// tests/attachmentsRelay.test.ts.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import { freePort } from "../server/preview";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO } from "../web/src/workstream";
import { makeScratchRepo } from "./helpers";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const fetch = native.fetch; // happy-dom's preloaded fetch CORS-blocks a real port
const ROOT = join(import.meta.dir, "..");

let laptop: string, box: string, shim: string, repo: string, log: string, hold: string;
let pg: TestDb;
let A: string, B: string;
const procs: Bun.Subprocess[] = [];

async function bridge(name: string, state: string, port: number) {
  const env = { ...process.env, ORCA_STATE_DIR: state, ORCA_DATABASE_URL: pg.url, PATH: `${shim}:${process.env.PATH}`, ORCA_API_PORT: String(port), ORCA_BIND: "127.0.0.1", ORCA_INSTANCE: name, ORCA_ALLOW_WORKTREE_MIGRATIONS: "1", ORCA_PRIMARY: "1" } as Record<string, string>;
  delete env.NODE_ENV;
  for (const k of ["ORCA_PREVIEW_HOST", "ORCA_PREVIEW_BIND", "SLACK_TOKEN"]) delete env[k];
  procs.push(Bun.spawn(["bun", "run", join(ROOT, "server", "index.ts")], { cwd: ROOT, env, stdout: "ignore", stderr: "inherit" }));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) return base; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${name} never came up`);
}

beforeAll(async () => {
  laptop = await mkdtemp(join(tmpdir(), "orca-compactrt-laptop-"));
  box = await mkdtemp(join(tmpdir(), "orca-compactrt-box-"));
  shim = await mkdtemp(join(tmpdir(), "orca-compactrt-claude-"));
  log = join(shim, "log");
  hold = join(shim, "hold");
  repo = await makeScratchRepo();
  // Records cwd + argv for every launch, then holds while `hold` exists, then answers `/compact`.
  await writeFile(join(shim, "claude"), `#!/bin/sh
printf '%s\\t%s\\n<<END>>\\n' "$PWD" "$*" >> "${log}"
while [ -f "${hold}" ]; do sleep 0.02; done
printf '{"type":"result","subtype":"success","is_error":false,"result":""}'
`);
  await chmod(join(shim, "claude"), 0o755);
  pg = await freshSchema("compactroute");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  const [pa, pb] = [await freePort([20_000, 40_000]), await freePort([40_001, 60_000])];
  A = `http://127.0.0.1:${pa}`; B = `http://127.0.0.1:${pb}`;
  await db.saveConfig({
    repos: [{ name: "r", config: { repoPath: repo, worktreeRoot: repo, baseBranch: "main", previewServices: [], providers: ["claude"] } }],
    app: { portRange: [30000, 40000], staleHours: 24, instances: { laptop: A, box: B }, orchestratorOn: "box" },
  });
  await db.close();
  await bridge("laptop", laptop, pa);
  await bridge("box", box, pb);
}, 60_000);

afterAll(async () => {
  for (const p of procs) p.kill();
  await db.close();
  await pg.drop();
  for (const d of [laptop, box, shim, repo]) await rm(d, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(hold, { force: true });
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});

async function compactLog(): Promise<string[]> {
  return existsSync(log) ? (await readFile(log, "utf8")).split("\n<<END>>\n").filter(Boolean) : [];
}
async function waitForLog(pred: (entries: string[]) => boolean): Promise<string[]> {
  for (let i = 0; i < 400; i++) {
    const entries = await compactLog();
    if (pred(entries)) return entries;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("log never matched");
}

test("a compact for the orchestrator repo posted to a non-host instance is forwarded to orchestratorOn — the 409 too", async () => {
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { sessionId: "sess-a" });
  await db.close();

  await writeFile(hold, ""); // keep the box's claude running so we can observe where it ran, and race a 2nd request
  const first = await fetch(`${A}/api/compact`, { method: "POST", body: JSON.stringify({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH }) });
  expect(first.status).toBe(200);
  const { runId } = await first.json() as { runId: string };
  expect(runId).toBeTruthy();

  // Ran on the box (orchestratorOn), never on the laptop it was posted to.
  const entries = await waitForLog((e) => e.length === 1);
  expect(entries[0]).toStartWith(box);
  expect(entries[0]).not.toContain(laptop);
  expect(entries[0]).toContain("--resume sess-a");
  expect(entries[0]).toContain("/compact");

  // Still mid-turn on the box: a second compact posted to the laptop comes back 409 — the box's own
  // busy refusal, relayed through unchanged, not a second launch.
  const second = await fetch(`${A}/api/compact`, { method: "POST", body: JSON.stringify({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH }) });
  expect(second.status).toBe(409);
  expect((await second.json()).error).toMatch(/mid-turn/);
  expect(await compactLog()).toHaveLength(1); // no second launch anywhere

  await rm(hold, { force: true });
  for (let i = 0; i < 200 && !(await db.turn(runId))?.finishedAt; i++) await new Promise((r) => setTimeout(r, 25));
});

test("a compact for the orchestrator repo posted directly to orchestratorOn runs there with no forward", async () => {
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { sessionId: "sess-b" });
  await db.close();

  const res = await fetch(`${B}/api/compact`, { method: "POST", body: JSON.stringify({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH }) });
  expect(res.status).toBe(200);
  const { runId } = await res.json() as { runId: string };
  expect(runId).toBeTruthy();

  const entries = await waitForLog((e) => e.some((l) => l.includes("sess-b")));
  const hit = entries.find((l) => l.includes("sess-b"))!;
  expect(hit).toStartWith(box); // orchestratorOn's own cwd — it never asked the laptop to do anything

  for (let i = 0; i < 200 && !(await db.turn(runId))?.finishedAt; i++) await new Promise((r) => setTimeout(r, 25));
});
