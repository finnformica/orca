// Hide and archive a workstream (Finn 2026-10-28): the card leaves the main view, the work does not
// change. ONE nullable column, `workstream.hidden_until`; HIDDEN_FOREVER = archived. A real bridge
// answers the route, real Postgres holds the column, and the board's own pure filters decide.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as notify from "../server/notify";
import * as orchestrator from "../server/orchestrator";
import * as verbs from "../server/verbs";
import { freePort } from "../server/preview";
import type { OrcaConfig } from "../server/config";
import {
  HIDDEN_FOREVER, NO_QUICK_FILTER, applyQuickFilter, boardText, hiddenCount, hiddenLabel, hiddenState, hideFeedbackStep, isHidden,
  parseHideFor, parseQuickFilter, quickFilterQuery, toggleHidden, type OverviewRow,
} from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, setPrListFixture } from "./helpers";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const fetch = native.fetch; // happy-dom's preloaded fetch CORS-blocks a real port
const ROOT = join(import.meta.dir, "..");
const HOUR = 3_600_000, DAY = 24 * HOUR;

let pg: TestDb, repo: string, worktrees: string, state: string, base: string;
let bridge: Bun.Subprocess | undefined;

const cfg = (): OrcaConfig => ({
  repos: [{ name: "r", repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"] }],
  portRange: [30000, 40000], staleHours: 24,
});

beforeAll(async () => {
  repo = await makeScratchRepo();
  worktrees = await mkdtemp(join(tmpdir(), "orca-hide-wt-"));
  state = await mkdtemp(join(tmpdir(), "orca-hide-state-"));
  await installFakeGh();
  await setPrListFixture([]);
  pg = await freshSchema("hide");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  await db.saveConfig({
    repos: [{ name: "r", config: { repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"] } }],
    app: { portRange: [30000, 40000], staleHours: 24 },
  });
  await db.close();
  const port = await freePort([20_000, 60_000]);
  const env = { ...process.env, ORCA_STATE_DIR: state, ORCA_DATABASE_URL: pg.url, ORCA_API_PORT: String(port), ORCA_BIND: "127.0.0.1", ORCA_INSTANCE: "here", ORCA_ALLOW_WORKTREE_MIGRATIONS: "1", ORCA_PRIMARY: "1" } as Record<string, string>;
  delete env.NODE_ENV;
  for (const k of ["ORCA_PREVIEW_HOST", "ORCA_PREVIEW_BIND", "SLACK_TOKEN"]) delete env[k];
  bridge = Bun.spawn(["bun", "run", join(ROOT, "server", "index.ts")], { cwd: ROOT, env, stdout: "ignore", stderr: "inherit" });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("bridge never came up");
}, 60_000);

afterAll(async () => {
  bridge?.kill();
  await db.close();
  await pg.drop();
  for (const d of [repo, worktrees, state]) await rm(d, { recursive: true, force: true });
});

beforeEach(() => { process.env.ORCA_DATABASE_URL = pg.url; });

const row = (branch: string, hiddenUntil?: number): OverviewRow => ({ repo: "r", branch, title: branch, lane: "IN_REVIEW", hiddenUntil });
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const enrichment = async () => await (await fetch(`${base}/api/enrichment?repo=r`)).json() as Record<string, { hiddenUntil?: number; title?: string }>;

test("H1: hide hides the card from the board API until the timer brings it back", async () => {
  await db.patchEnrichment("r", "h1", { title: "One" });
  const until = Date.now() + DAY;
  expect((await post("/api/workstreams/hide", { repo: "r", branch: "h1", until })).status).toBe(200);
  const e = await enrichment();
  expect(e.h1).toMatchObject({ title: "One", hiddenUntil: until }); // the column rides the board's enrichment read

  // The board's rows: the default view leaves it out, the timer brings it back with no write.
  const rows = [row("h1", e.h1!.hiddenUntil), row("shown")];
  expect(applyQuickFilter(rows, NO_QUICK_FILTER, undefined, Date.now()).map((r) => r.branch)).toEqual(["shown"]);
  expect(applyQuickFilter(rows, NO_QUICK_FILTER, undefined, until + 1).map((r) => r.branch)).toEqual(["h1", "shown"]);
  expect(hiddenState(until, until + 1)).toBe("shown");
  expect(hiddenLabel(until, until - 23 * HOUR)).toBe("Hidden · 23h left");

  // A past time and a bad value are refused; null unhides.
  expect((await post("/api/workstreams/hide", { repo: "r", branch: "h1", until: Date.now() - 1 })).status).toBe(400);
  expect((await post("/api/workstreams/hide", { repo: "r", branch: "h1", until: null })).status).toBe(200);
  expect((await enrichment()).h1!.hiddenUntil).toBeUndefined();

  // A blob write cannot set or clear the column.
  await db.setHidden("r", "h1", until);
  await db.patchEnrichment("r", "h1", { hiddenUntil: null, title: "One again" });
  expect((await db.enrichment("r")).h1).toMatchObject({ title: "One again", hiddenUntil: until });
});

test("H2: a problem event clears a timed hide; an archive stays hidden until unarchive", async () => {
  const until = Date.now() + 7 * DAY;
  await db.setHidden("r", "h2", until);
  await db.setHidden("r", "h2a", HIDDEN_FOREVER);
  for (const branch of ["h2", "h2a"]) {
    await notify.emit({ repo: "r", branch, kind: "pr_ci_failed", key: `pr-ci:r#${branch}@abc`, title: branch, body: "CI is failing." });
  }
  let e = await db.enrichment("r");
  expect(e.h2!.hiddenUntil).toBeUndefined(); // back on the board
  expect(e.h2a!.hiddenUntil).toBe(HIDDEN_FOREVER); // archived: still out
  expect(hiddenState(e.h2a!.hiddenUntil as number, Date.now() + 365 * DAY)).toBe("archived");

  // A worker report brings a timed hide back too; a preview event does not.
  await db.setHidden("r", "h2", until);
  await notify.emit({ repo: "r", branch: "h2", kind: "preview_ready", key: "preview:h2:1:ready", title: "h2", body: "Running." });
  expect((await db.enrichment("r")).h2!.hiddenUntil).toBe(until);
  await notify.emit({ repo: "r", branch: "h2", kind: "finished", key: "run:h2-run:finished", title: "h2", body: "Done." });
  expect((await db.enrichment("r")).h2!.hiddenUntil).toBeUndefined();

  // New review feedback: the first look records a baseline, a rise brings the card back.
  await db.setHidden("r", "h2", until);
  await notify.hiddenFeedback("r", [{ branch: "h2", externalFeedback: 2 }, { branch: "h2a", externalFeedback: 2 }]);
  e = await db.enrichment("r");
  expect(e.h2).toMatchObject({ hiddenUntil: until, hiddenFeedback: 2 });
  await notify.hiddenFeedback("r", [{ branch: "h2", externalFeedback: 2 }, { branch: "h2a", externalFeedback: 5 }]);
  expect((await db.enrichment("r")).h2!.hiddenUntil).toBe(until); // no new feedback: still hidden
  await notify.hiddenFeedback("r", [{ branch: "h2", externalFeedback: 3 }, { branch: "h2a", externalFeedback: 9 }]);
  e = await db.enrichment("r");
  expect(e.h2!.hiddenUntil).toBeUndefined();
  expect(e.h2!.hiddenFeedback).toBeUndefined();
  expect(e.h2a!.hiddenUntil).toBe(HIDDEN_FOREVER);
  expect(hideFeedbackStep(undefined, 4)).toBe("baseline");

  // Unarchive is the only way out.
  expect((await post("/api/workstreams/hide", { repo: "r", branch: "h2a", until: null })).status).toBe(200);
  expect((await db.enrichment("r")).h2a!.hiddenUntil).toBeUndefined();
});

test("H3: the Hidden / Archived filter lists both, with the time left, and nothing else", () => {
  const now = Date.UTC(2026, 9, 28, 12);
  const rows = [row("shown"), row("hidden", now + 2 * DAY), row("archived", HIDDEN_FOREVER), row("expired", now - 1)];
  const on = toggleHidden(NO_QUICK_FILTER);
  expect(applyQuickFilter(rows, NO_QUICK_FILTER, undefined, now).map((r) => r.branch)).toEqual(["shown", "expired"]);
  expect(applyQuickFilter(rows, on, undefined, now).map((r) => r.branch)).toEqual(["hidden", "archived"]);
  expect(hiddenCount(rows, NO_QUICK_FILTER, undefined, now)).toBe(2);
  expect(rows.map((r) => hiddenLabel(r.hiddenUntil, now))).toEqual(["", "Hidden · 2d left", "Archived", ""]);
  expect(isHidden(rows[1]!, now)).toBe(true);
  // The filter is a link.
  expect(quickFilterQuery(on)).toBe("?hidden=1");
  expect(parseQuickFilter("?hidden=1")).toEqual(on);
  expect(parseQuickFilter("")).toEqual(NO_QUICK_FILTER);
});

test("H4: orca hide / unhide, and orca board still lists a hidden card, marked", async () => {
  const now = Date.UTC(2026, 9, 28, 12);
  expect(parseHideFor("1d", now)).toBe(now + DAY);
  expect(parseHideFor("1w", now)).toBe(now + 7 * DAY);
  expect(parseHideFor("forever", now)).toBe(HIDDEN_FOREVER);
  expect(parseHideFor("2026-11-03", now)).toBe(Date.UTC(2026, 10, 3));
  expect(() => parseHideFor("2026-10-01", now)).toThrow("in the past");
  expect(() => parseHideFor("soon", now)).toThrow("--for must be");

  await setPrListFixture([{ number: 9, title: "Feat", headRefName: "h4", baseRefName: "main", url: "u", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [], comments: [], author: { login: "me" }, reviews: [], labels: [] }]);
  expect(await orchestrator.tool(cfg(), "hide", { repo: "r", branch: "h4", for: "1w" })).toContain("r/h4 is hidden until");
  expect(hiddenState((await db.enrichment("r")).h4!.hiddenUntil as number)).toBe("hidden");
  expect(await orchestrator.tool(cfg(), "board", {})).toMatch(/r\/h4 "Feat" \| PR #9.*\| hidden until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  expect(await orchestrator.tool(cfg(), "hide", { repo: "r", branch: "h4", for: "forever" })).toContain("archived");
  expect(await orchestrator.tool(cfg(), "board", {})).toContain("archived (hidden from the user, no end)");
  await expect(orchestrator.tool(cfg(), "hide", { repo: "r", branch: "h4" })).rejects.toThrow("--for is required");
  expect(await orchestrator.tool(cfg(), "unhide", { repo: "r", branch: "h4" })).toContain("shows on the user's board again");
  expect((await db.enrichment("r")).h4!.hiddenUntil).toBeUndefined();
  expect(await orchestrator.tool(cfg(), "board", {})).not.toContain("hidden");
  expect(boardText([{ repo: "r", branch: "x", agent: "idle", hiddenUntil: HIDDEN_FOREVER }])).toContain("archived");
  await setPrListFixture([]);
});

test("H5: Close (verbs.archiveWorkstream, `orca archive`) keeps its behaviour on a hidden card", async () => {
  const { branch, worktreePath } = await verbs.newWorktree(cfg().repos[0]!, "close me");
  await db.patchEnrichment("r", branch, { title: "Close me" });
  await db.setHidden("r", branch, Date.now() + DAY);
  await verbs.archiveWorkstream(cfg().repos[0]!, branch);
  expect(await db.enrichment("r")).not.toHaveProperty(branch); // the card is closed, not hidden
  expect(await Bun.file(join(worktreePath, "README.md")).exists()).toBe(false); // worktree reaped
  expect((await db.archivedBranches("r")).has(branch)).toBe(true); // archived_at set: history kept
});
