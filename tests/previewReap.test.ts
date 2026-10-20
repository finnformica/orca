// server/preview.ts's hourly reaper: drops orphaned `orca_*` preview databases (a bridge crash, a
// reaped worktree, or a worker's own test run can leave one behind with no preview to drop it) and
// removes a repo's stale test-harness Docker containers. Runs the real psql chain against the test
// Postgres (tests/pg.ts's convention: point ORCA_TEST_DATABASE_URL at a throwaway instance — this
// test creates and drops real databases there, same as tests/pushTemplate.test.ts) and a fake
// `docker` via a PATH shim (tests/helpers.ts, same shape as the `gh` shim).
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree } from "../server/git";
import { previewDbName, reap } from "../server/preview";
import type { RepoConfig } from "../server/config";
import { installFakeDocker, makeScratchRepo, restoreDockerPath } from "./helpers";
import { canCreateDatabases } from "./pg";

const createdb = await canCreateDatabases();

const BASE = new URL(process.env.ORCA_TEST_DATABASE_URL || "postgres://localhost:5432/postgres");
const SLOW = 30_000;
const urlOf = (db: string) => { const u = new URL(BASE); u.pathname = `/${db}`; return u.toString(); };

const admin = new Bun.SQL(BASE.toString());
const mine = (name: string) => `orca_reaptest_${process.pid}_${name}`;
const toClean = new Set<string>();

async function createDb(name: string): Promise<void> {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  toClean.add(name);
}
const dbExists = async (name: string): Promise<boolean> =>
  (await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`).length > 0;

afterAll(async () => {
  for (const name of toClean) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
  await admin.end();
}, SLOW);

async function repoWithEnv(): Promise<RepoConfig> {
  const repoPath = await makeScratchRepo();
  const worktreeRoot = join(repoPath, ".worktrees");
  await mkdir(join(repoPath, "backend"), { recursive: true });
  const conn = [
    `DB_HOST=${BASE.hostname}`,
    `DB_PORT=${BASE.port || 5432}`,
    `DB_MASTER_USER=${decodeURIComponent(BASE.username) || "postgres"}`,
    `PGPASSWORD=${decodeURIComponent(BASE.password)}`,
    "",
  ].join("\n");
  await writeFile(join(repoPath, "backend/.env"), conn);
  return { name: "reaptest", repoPath, worktreeRoot, baseBranch: "main", previewServices: [], copyToWorktree: ["backend/.env"] };
}

test.skipIf(!createdb)("R1 the reaper drops an orphan preview db, keeps a live worktree's, and leaves a freshly-created one alone", async () => {
  const repo = await repoWithEnv();
  const { worktreePath: liveWorktree } = await createWorktree(repo.repoPath, repo.worktreeRoot, "live-branch", "main");

  const orphanDb = mine("orphan"); // no worktree ever existed for this path
  const liveDb = previewDbName(liveWorktree); // a real, currently-live worktree
  // The measured age is coarse: pg_stat_file's mtime is whole seconds and the age is floored, so a
  // database a few ms old can read as 1000ms. The grace must sit well above that resolution — at
  // 1s, a fresh database straddling a second boundary under CI load was reaped.
  const GRACE_MS = 3_000;
  await createDb(orphanDb);
  await Bun.sleep(GRACE_MS + 500); // age the orphan past the grace period below
  await createDb(liveDb);
  const report = await reap([repo], { dbGraceMs: GRACE_MS });

  // A database younger than the grace period must survive a pass that sees it — created fresh,
  // right before its own reap call, so its age is a few ms, well under GRACE_MS.
  const freshDb = mine("fresh");
  await createDb(freshDb);
  const report2 = await reap([repo], { dbGraceMs: GRACE_MS });

  expect(report.droppedDbs).toContain(orphanDb);
  expect(report.droppedDbs).not.toContain(liveDb);
  expect(report2.droppedDbs).not.toContain(freshDb); // too young — left for the next pass
  expect(report2.droppedDbs).not.toContain(liveDb);

  expect(await dbExists(orphanDb)).toBe(false); // actually gone
  expect(await dbExists(liveDb)).toBe(true);
  expect(await dbExists(freshDb)).toBe(true);
  toClean.delete(orphanDb); // already dropped; nothing for afterAll to do
}, SLOW);

test("R2 docker: a stale test container is removed, a recent one and an unrelated one are left alone", async () => {
  const now = Date.now();
  const stale = "branch_demo_test_postgres_5433"; // created 4h ago — past the 3h default
  const recent = "branch_demo_test_postgres_5434"; // created 10 minutes ago
  const readRemoved = await installFakeDocker([
    { name: stale, createdAt: new Date(now - 4 * 60 * 60 * 1000).toISOString() },
    { name: recent, createdAt: new Date(now - 10 * 60 * 1000).toISOString() },
  ]);
  try {
    const repo: RepoConfig = {
      name: "reaptest-docker", repoPath: await makeScratchRepo(), worktreeRoot: "/tmp/nope",
      baseBranch: "main", previewServices: [], testContainerPrefix: "branch_demo_test_postgres_",
    };
    const report = await reap([repo]);
    expect(report.removedContainers).toEqual([stale]);
    expect(await readRemoved()).toEqual([stale]);
  } finally {
    restoreDockerPath();
  }
});

test("R3 docker: absent docker is skipped silently, not thrown", async () => {
  const repoPath = await makeScratchRepo(); // needs real `git` — set up before PATH is emptied
  const emptyPathDir = await mkdtemp(join(tmpdir(), "orca-nodocker-"));
  const real = process.env.PATH;
  process.env.PATH = emptyPathDir; // no docker, no bash — just an empty dir
  try {
    const repo: RepoConfig = {
      name: "reaptest-nodocker", repoPath, worktreeRoot: "/tmp/nope",
      baseBranch: "main", previewServices: [], testContainerPrefix: "branch_demo_test_postgres_",
    };
    const report = await reap([repo]); // must not throw
    expect(report.removedContainers).toEqual([]);
  } finally {
    process.env.PATH = real;
  }
});
