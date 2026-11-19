// GET /api/board: the whole board for every repo in ONE answer (the store's first load and poll).
// A browser has six HTTP/1.1 connections per host; four calls per repo (52 for 13 repos) queued
// behind each other (PR #518). A real bridge, two repos: each part must be exactly what the per-repo
// route answers, merged PRs only when asked, and none for a repo with no remote.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import { freePort } from "../server/preview";
import { runCmd } from "../server/run";
import { installFakeGh, makeScratchRepo, setDonePrListFixture, setPrFixture, setPrListFixture } from "./helpers";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const fetch = native.fetch; // happy-dom's preloaded fetch CORS-blocks a real port
const ROOT = join(import.meta.dir, "..");
const iso = (ms: number) => new Date(ms).toISOString();

let pg: TestDb, withRemote: string, noRemote: string, wtR: string, wtS: string, state: string, base: string;
let bridge: Bun.Subprocess | undefined;

const OPEN_PR = {
  number: 7, title: "Seven", headRefName: "feat", headRefOid: "aaa111", baseRefName: "main", url: "https://github.com/acme/app/pull/7",
  state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "", author: { login: "active" }, statusCheckRollup: [],
};
const MERGED_PR = {
  number: 5, title: "Five", headRefName: "done-5", headRefOid: "bbb222", baseRefName: "main", url: "https://github.com/acme/app/pull/5",
  state: "MERGED", isDraft: false, author: { login: "active" }, mergedAt: iso(Date.now() - 3_600_000), closedAt: iso(Date.now() - 3_600_000),
};

type Part = { ok: boolean; v?: unknown; error?: string };
type Board = { repos: Record<string, { agents: Part; prs: Part; enrichment: Part; merged?: Part }> };
const getJson = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${base}${path}`);
  expect(res.status).toBe(200);
  return await res.json() as T;
};
const board = (q = "") => getJson<Board>(`/api/board${q}`);

beforeAll(async () => {
  withRemote = await makeScratchRepo();
  await runCmd(["git", "-C", withRemote, "remote", "add", "origin", "https://github.com/acme/app.git"]);
  noRemote = await makeScratchRepo();
  wtR = await mkdtemp(join(tmpdir(), "orca-board-wtr-"));
  wtS = await mkdtemp(join(tmpdir(), "orca-board-wts-"));
  state = await mkdtemp(join(tmpdir(), "orca-board-state-"));
  // One worktree in the repo with no remote, so its agents part has a row.
  await runCmd(["git", "-C", noRemote, "worktree", "add", "-b", "local-work", join(wtS, "local-work")]);
  await installFakeGh();
  await setPrListFixture([OPEN_PR]);
  await setDonePrListFixture([MERGED_PR]);
  await setPrFixture({ state: "OPEN", mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [] });
  pg = await freshSchema("board");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  await db.saveConfig({
    repos: [
      { name: "r", config: { repoPath: withRemote, worktreeRoot: wtR, baseBranch: "main", previewServices: [], providers: ["claude"] } },
      { name: "s", config: { repoPath: noRemote, worktreeRoot: wtS, baseBranch: "main", previewServices: [], providers: ["claude"] } },
    ],
    app: { portRange: [30000, 40000], staleHours: 24 },
  });
  await db.close();
  const port = await freePort([20_000, 60_000]);
  const env = { ...process.env, ORCA_STATE_DIR: state, ORCA_DATABASE_URL: pg.url, ORCA_API_PORT: String(port), ORCA_BIND: "127.0.0.1", ORCA_INSTANCE: "here", ORCA_ALLOW_WORKTREE_MIGRATIONS: "1", ORCA_PRIMARY: "1", ORCA_PR_SYNC_INLINE: "1" } as Record<string, string>;
  delete env.NODE_ENV;
  for (const k of ["ORCA_PREVIEW_HOST", "ORCA_PREVIEW_BIND", "SLACK_TOKEN"]) delete env[k];
  bridge = Bun.spawn(["bun", "run", join(ROOT, "server", "index.ts")], { cwd: ROOT, env, stdout: "ignore", stderr: "inherit" });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  const res = await fetch(`${base}/api/enrichment`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo: "s", branch: "local-work", fields: { prompt: "make it fast" } }) });
  expect(res.status).toBe(200);
}, 60_000);

afterAll(async () => {
  bridge?.kill();
  await db.close();
  await pg?.drop();
  for (const d of [withRemote, noRemote, wtR, wtS, state]) if (d) await rm(d, { recursive: true, force: true });
});

test("B1: one answer holds every repo's agents, PRs and enrichment, each as its per-repo route gives it", async () => {
  const b = await board();
  expect(Object.keys(b.repos).sort()).toEqual(["r", "s"]);
  for (const name of ["r", "s"]) {
    const repo = b.repos[name]!;
    expect(repo.merged).toBeUndefined(); // merged PRs only when asked
    expect(repo.agents).toEqual({ ok: true, v: await getJson(`/api/agents?repo=${name}`) });
    expect(repo.enrichment).toEqual({ ok: true, v: await getJson(`/api/enrichment?repo=${name}`) });
    const prs = await getJson<{ number: number; branch: string }[]>(`/api/prs?repo=${name}`);
    expect(repo.prs.ok).toBe(true);
    // syncedAt moves between two reads; the rows themselves are the same.
    expect((repo.prs.v as typeof prs).map((p) => [p.number, p.branch])).toEqual(prs.map((p) => [p.number, p.branch]));
  }
  expect((b.repos.s!.agents.v as { branch: string; queued: number }[]).map((a) => [a.branch, a.queued])).toEqual([["local-work", 0]]);
  expect(b.repos.s!.enrichment.v).toMatchObject({ "local-work": { prompt: "make it fast" } });
  expect((b.repos.r!.prs.v as { number: number }[]).map((p) => p.number)).toEqual([7]);
});

test("B2: merged=<since> adds the merged PRs, the same 7-day window as /api/prs/merged; none for a repo with no remote", async () => {
  const since = Date.now() - 7 * 86_400_000;
  const b = await board(`?merged=${since}`);
  const merged = await getJson<{ number: number }[]>(`/api/prs/merged?repo=r&since=${since}`);
  expect(merged.map((m) => m.number)).toEqual([5]);
  expect(b.repos.r!.merged).toEqual({ ok: true, v: merged });
  expect(b.repos.s!.merged).toEqual({ ok: true, v: [] }); // no remote: no merged PRs to read, as /api/config's hasRemote
});
