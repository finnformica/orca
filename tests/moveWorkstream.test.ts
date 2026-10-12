// Moving a workstream between instances (verbs.moveWorkstream): the branch goes to origin, the
// worktree here is removed, the target adopts it over HTTP, and the session pointer is cleared so
// the next run there takes the portable-transcript rung. A bare "origin" repo, two clones standing
// in for the two instances, and a stubbed `fetch` standing in for the far instance's adopt route
// (its handler IS our own git.adoptWorktree). Real git, real Postgres (enrichment).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as git from "../server/git";
import * as verbs from "../server/verbs";
import { run } from "../server/run";
import type { OrcaConfig, RepoConfig } from "../server/config";
import { freshSchema, type TestDb } from "./pg";

let dir: string, origin: string, here: string, there: string, state: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

beforeEach(async () => {
  prev = { ORCA_STATE_DIR: process.env.ORCA_STATE_DIR, ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE };
  dir = realpathSync(await mkdtemp(join(tmpdir(), "orca-move-")));
  state = join(dir, "state"); process.env.ORCA_STATE_DIR = state;
  process.env.ORCA_INSTANCE = "local";
  pg = await freshSchema("move"); process.env.ORCA_DATABASE_URL = pg.url; await db.close();
  origin = join(dir, "origin.git");
  await run(["git", "init", "--bare", "-b", "main", origin]);
  const seed = join(dir, "seed");
  await run(["git", "clone", "-q", origin, seed]);
  await run(["git", "-C", seed, "config", "user.email", "t@orca.dev"]); await run(["git", "-C", seed, "config", "user.name", "T"]);
  await writeFile(join(seed, "README.md"), "# seed\n");
  await run(["git", "-C", seed, "add", "."]); await run(["git", "-C", seed, "commit", "-q", "-m", "init"]); await run(["git", "-C", seed, "push", "-q", "origin", "main"]);
  here = join(dir, "here"); there = join(dir, "there");
  for (const c of [here, there]) { await run(["git", "clone", "-q", origin, c]); await run(["git", "-C", c, "config", "user.email", "t@orca.dev"]); await run(["git", "-C", c, "config", "user.name", "T"]); }
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await db.close(); await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(dir, { recursive: true, force: true });
});

const repoAt = (path: string): RepoConfig => ({ name: "r", repoPath: path, worktreeRoot: join(path, ".wt"), baseBranch: "main", previewServices: [], providers: ["claude"] });

test("M1: a workstream moves to the other instance: branch pushed, worktree re-homed, session pointer cleared", async () => {
  const hereRepo = repoAt(here), thereRepo = repoAt(there);
  // The far instance: its adopt route, reached over fetch, adopts into its own clone — what the
  // real /api/worktrees/adopt does. (A stub rather than a Bun.serve: the test DOM preload replaces
  // Response, which Bun.serve then refuses.)
  const adopted: unknown[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("http://cloud.test/api/worktrees/adopt");
    const body = JSON.parse(String(init?.body)) as { branch: string; instance?: string };
    adopted.push(body);
    const r = await git.adoptWorktree(thereRepo.repoPath, thereRepo.worktreeRoot, body.branch);
    return { ok: true, status: 200, json: async () => r } as unknown as Response;
  }) as typeof fetch;
  const cfg: OrcaConfig = { repos: [hereRepo], portRange: [30000, 40000], staleHours: 24, instances: { cloud: "http://cloud.test" } };

  const wt = await git.createWorktree(hereRepo.repoPath, hereRepo.worktreeRoot, "feat", "main");
  await writeFile(join(wt.worktreePath, "work.txt"), "done\n");
  await run(["git", "-C", wt.worktreePath, "add", "."]); await run(["git", "-C", wt.worktreePath, "commit", "-q", "-m", "work"]);
  await db.patchEnrichment("r", "feat", { sessionId: "sess-here", agentProvider: "claude", title: "Feat" });

  await expect(verbs.moveWorkstream(cfg, hereRepo, "feat", "local")).rejects.toThrow("already on local");
  await expect(verbs.moveWorkstream(cfg, hereRepo, "feat", "mars")).rejects.toThrow('"mars" is not a configured instance');
  await expect(verbs.moveWorkstream(cfg, hereRepo, "nope", "cloud")).rejects.toThrow("no worktree on local");

  const moved = await verbs.moveWorkstream(cfg, hereRepo, "feat", "cloud");
  expect(moved).toMatchObject({ branch: "feat", instance: "cloud" });
  expect(existsSync(wt.worktreePath)).toBe(false); // gone from here…
  expect((await git.listWorktrees(hereRepo.repoPath, hereRepo.worktreeRoot)).map((w) => w.branch)).toEqual([]);
  expect(existsSync(join(moved.worktreePath, "work.txt"))).toBe(true); // …with its commit over there
  expect((await run(["git", "-C", origin, "branch", "--list", "feat"])).trim()).toBe("feat"); // via origin
  expect(adopted).toEqual([{ repo: "r", branch: "feat", instance: "cloud" }]); // the target was told explicitly where
  const e = (await db.enrichment("r")).feat!;
  expect(e.sessionId).toBeUndefined(); // the next run there starts fresh from the portable transcript
  expect(e).toMatchObject({ title: "Feat", agentProvider: "claude", movedFrom: "local" });
});

test("M2: steps for many runs come back in one round trip, grouped by run", async () => {
  for (const [runId, n] of [["run-a", 3], ["run-b", 1]] as const) {
    await db.startTurn({ repo: "r", branch: "b", runId, provider: "claude", prompt: "p", startedAt: 1 });
    await db.appendSteps(runId, 0, Array.from({ length: n }, (_, i) => ({ kind: "text", text: `${runId}#${i}`, at: i })));
  }
  const by = await db.stepsForRuns(["run-a", "run-b", "run-none"]);
  expect([...by.keys()].sort()).toEqual(["run-a", "run-b"]);
  expect(by.get("run-a")!.map((s) => s.seq)).toEqual([0, 1, 2]);
  expect(by.get("run-b")![0]!.step.text).toBe("run-b#0");
  expect(await db.stepsForRuns([])).toEqual(new Map());
});
