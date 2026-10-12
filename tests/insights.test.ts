// The Overview's insight cards' data (/api/insights): a run's model, cost and tokens are recorded on
// its turn (migration 14) from the CLI's own result, read back without prompt or response
// (db.insightRuns), and aggregated by the pure workstream.insights — spend by category (orchestrator /
// workers / your runs), by model / repo / workstream, runs per bucket by outcome, success and check
// pass rates. Plus the two derivations the browser finishes: a machine's hourly cost over a range
// (boxSpend) and a usage window projected at its burn rate (forecastWindow / limitForecasts).
// The first test drives the real launcher with a fake `claude` on PATH and a real Postgres.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import {
  ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, boxSpend, forecastWindow, insightDays, nextLimit, insightWindow, insights, limitForecasts, runCategory, type WindowForecast,
  type InsightRun,
} from "../web/src/workstream";
import { freshSchema, type TestDb } from "./pg";

const H = 3_600_000, DAY = 24 * H;

describe("recorded on the turn, read back for the cards", () => {
  let dir: string, shim: string, pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  beforeEach(async () => {
    prev = { ORCA_STATE_DIR: process.env.ORCA_STATE_DIR, ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, PATH: process.env.PATH };
    dir = await mkdtemp(join(tmpdir(), "orca-insights-"));
    shim = await mkdtemp(join(tmpdir(), "orca-claude-"));
    process.env.ORCA_STATE_DIR = dir;
    process.env.PATH = `${shim}:${prev.PATH}`;
    pg = await freshSchema("insights");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
  });
  afterEach(async () => {
    await agent.flushHistory();
    await db.close();
    await pg.drop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(dir, { recursive: true, force: true });
    await rm(shim, { recursive: true, force: true });
  });

  test("I1: a run's cost, model and tokens land on its turn; insightRuns returns them by category, no text", async () => {
    const result = {
      type: "result", subtype: "success", result: "done", is_error: false, total_cost_usd: 0.42,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 },
      modelUsage: { "claude-opus-5-5": { outputTokens: 50, contextWindow: 200000 } },
    };
    await writeFile(join(shim, "claude"), `#!/bin/sh\nprintf '%s' '${JSON.stringify(result)}'\n`);
    await chmod(join(shim, "claude"), 0o755);
    const wt = join(dir, "feat");
    await mkdir(wt, { recursive: true });
    const since = Date.now() - 1000;
    await agent.runAgent(wt, "go", { repo: "r", branch: "feat", provider: "claude" });
    for (let i = 0; i < 400 && !(await db.turns("r", "feat"))[0]?.finishedAt; i++) await new Promise((r) => setTimeout(r, 25));
    await agent.flushHistory();

    // An orchestrator wake and a worker it drives, recorded the way their runs are (start, finish).
    const t0 = Date.now();
    await db.startTurn({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH, runId: "wake", provider: "claude", prompt: "p", startedAt: t0 });
    await db.finishTurn("wake", { status: "done", finishedAt: t0 + 5000, usage: { model: "Opus 5.5", costUsd: 1.5, outputTokens: 7 } });
    await db.patchEnrichment("r", "worker", { orchestrated: true, title: "Worker task" });
    await db.startTurn({ repo: "r", branch: "worker", runId: "w1", provider: "codex", prompt: "p", startedAt: t0 });
    await db.finishTurn("w1", { status: "error", finishedAt: t0 + 2000, usage: { model: "Codex", inputTokens: 9 } });

    const runs = await db.insightRuns(since);
    expect(runs.map((r) => r.runId)).toContain("wake");
    const feat = runs.find((r) => r.branch === "feat")!;
    expect(feat).toMatchObject({ repo: "r", provider: "claude", status: "done", costUsd: 0.42, tokens: 1160, orchestrated: false });
    expect(feat.model).toContain("Opus");
    expect(Object.keys(feat)).not.toContain("prompt");
    expect(runs.find((r) => r.runId === "w1")).toMatchObject({ orchestrated: true, title: "Worker task", status: "error", costUsd: undefined, tokens: 9 });
    expect(runs.map(runCategory).sort()).toEqual(["direct", "orchestrator", "workers"]);

    const agg = insights(runs, { days: 1, now: Date.now(), tzOffsetMin: new Date().getTimezoneOffset() });
    expect(agg.spend).toEqual({ orchestrator: 1.5, workers: 0, direct: 0.42 });
    expect(agg).toMatchObject({ priced: 2, unpriced: 1, runs: { total: 3, done: 2, error: 1, stopped: 0, running: 0 } });
    // A run before the range is not in it.
    expect(await db.insightRuns(Date.now() + 60_000)).toEqual([]);
  });

  test("I2: a finish with no usage keeps what was there (an adopted run reports none)", async () => {
    const t0 = Date.now();
    await db.startTurn({ repo: "r", branch: "b", runId: "x", provider: "claude", prompt: "p", startedAt: t0 });
    await db.finishTurn("x", { status: "done", finishedAt: t0 + 1, usage: { costUsd: 0.1, model: "Sonnet 5.5" } });
    await db.finishTurn("x", { status: "done", finishedAt: t0 + 2 });
    expect((await db.insightRuns(t0 - 1))[0]).toMatchObject({ costUsd: 0.1, model: "Sonnet 5.5", tokens: undefined });
  });
});

describe("aggregation (pure)", () => {
  // 2026-10-12 12:30 UTC; the viewer is in BST (getTimezoneOffset -60), so local midnight is 23:00 UTC.
  const NOW = Date.parse("2026-10-12T12:30:00Z"), TZ = -60;
  const MIDNIGHT = Date.parse("2026-10-11T23:00:00Z");
  const run = (over: Partial<InsightRun>): InsightRun => ({ runId: Math.random().toString(36), repo: "r", branch: "b", orchestrated: false, provider: "claude", status: "done", startedAt: NOW - H, finishedAt: NOW - H + 60_000, ...over });

  test("I3: the range is the viewer's day — hourly from local midnight today, daily otherwise; days parse to 1/7/30", () => {
    expect(insightWindow(1, NOW, TZ)).toEqual({ from: MIDNIGHT, to: MIDNIGHT + DAY, bucketMs: H, count: 24 });
    expect(insightWindow(7, NOW, TZ)).toEqual({ from: MIDNIGHT - 6 * DAY, to: MIDNIGHT + DAY, bucketMs: DAY, count: 7 });
    expect(insightWindow(1, NOW, 0).from).toBe(Date.parse("2026-10-12T00:00:00Z"));
    expect([insightDays("1"), insightDays("7"), insightDays("30"), insightDays(null), insightDays("999")]).toEqual([1, 7, 30, 30, 30]);
  });

  test("I4: spend by category, model, repo and workstream; outcomes per bucket; success, check and median", () => {
    const runs: InsightRun[] = [
      run({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH, costUsd: 2, model: "Opus 5.5", startedAt: MIDNIGHT + 10 * H, finishedAt: MIDNIGHT + 10 * H + 30_000 }),
      run({ repo: "app", branch: "w", title: "Worker", orchestrated: true, costUsd: 1.004, model: "Sonnet 5.5", check: "passed", startedAt: MIDNIGHT + 11 * H, finishedAt: MIDNIGHT + 11 * H + 120_000 }),
      run({ repo: "app", branch: "w", title: "Worker", orchestrated: true, costUsd: 0.5, model: "Sonnet 5.5", check: "failed", status: "error", startedAt: MIDNIGHT + 11 * H + 1, finishedAt: MIDNIGHT + 11 * H + 60_001 }),
      run({ repo: "api", branch: "mine", provider: "codex", status: "stopped", startedAt: MIDNIGHT + 12 * H, finishedAt: MIDNIGHT + 12 * H + 600_000 }),
      run({ repo: "api", branch: "live", status: "running", costUsd: undefined, startedAt: NOW - 60_000, finishedAt: undefined }),
      run({ repo: "api", branch: "old", costUsd: 9, startedAt: MIDNIGHT - H }), // yesterday: not today
    ];
    const a = insights(runs, { days: 1, now: NOW, tzOffsetMin: TZ });
    expect(a.spend).toEqual({ orchestrator: 2, workers: 1.5, direct: 0 });
    expect(a.runsBy).toEqual({ orchestrator: 1, workers: 2, direct: 2 });
    expect(a).toMatchObject({ priced: 3, unpriced: 2, runs: { total: 5, done: 2, error: 1, stopped: 1, running: 1 }, checks: { passed: 1, failed: 1 } });
    expect(a.successRate).toBeCloseTo(2 / 3); // the stopped run is neither
    expect(a.medianMs).toBe(90_000); // of 30s, 60s, 120s, 600s
    expect(a.buckets).toHaveLength(24);
    expect(a.buckets[11]).toMatchObject({ runs: 2, done: 1, error: 1, costUsd: 1.5 });
    expect(a.buckets[13]).toMatchObject({ runs: 1, running: 1 });
    expect(a.byModel.map((s) => [s.label, s.costUsd, s.runs])).toEqual([["Opus 5.5", 2, 1], ["Sonnet 5.5", 1.5, 2], ["Codex", 0, 1], ["Claude · model not recorded", 0, 1]]); // unpriced: by runtime
    expect(a.byRepo.map((s) => s.key)).toEqual(["app", "api"]); // the orchestrator belongs to no repo
    expect(a.topWorkstreams.map((s) => [s.label, s.sub])).toEqual([["Orchestrator", undefined], ["Worker", "app"], ["mine", "api"], ["live", "api"]]);
    // 30 days takes yesterday's run too; a repo filter drops the orchestrator; an instance filter narrows by machine.
    expect(insights(runs, { days: 30, now: NOW, tzOffsetMin: TZ }).spend.direct).toBe(9);
    expect(insights(runs, { days: 1, now: NOW, tzOffsetMin: TZ, repo: "app" }).runs.total).toBe(2);
    expect(insights(runs.map((r, i) => ({ ...r, instance: i % 2 ? "cloud" : "local" })), { days: 1, now: NOW, tzOffsetMin: TZ, instance: "cloud" }).runs.total).toBe(2);
    expect(insights([], { days: 7, now: NOW }).successRate).toBeNull();
  });

  test("I5: a machine's cost is its rate over the billed hours inside the range — never before billing, never the future", () => {
    const cost = { hourlyUsd: 0.25, billingSince: "2026-10-12T09:00:00Z", sinceIso: "2026-10-12T09:00:00Z" };
    const day = insightWindow(1, NOW, 0);
    expect(boxSpend(cost, day.from, day.to, NOW)).toBe(0.88); // 09:00 → 12:30 = 3.5h × 0.25
    // A range spanning the 1st counts last month's hours, from the unclamped billing start.
    expect(boxSpend({ hourlyUsd: 1, billingSince: "2026-09-30T00:00:00Z", sinceIso: "2026-10-01T00:00:00Z" }, Date.parse("2026-09-30T00:00:00Z"), NOW, NOW)).toBe(12 * 24 + 12.5);
    expect(boxSpend(undefined, day.from, day.to, NOW)).toBe(0);
    expect(boxSpend({ hourlyUsd: 0.25, billingSince: "2026-10-13T00:00:00Z" }, day.from, day.to, NOW)).toBe(0);
  });

  test("I6: a window is projected at its average burn rate — runs out, on pace, reached, or too early to say", () => {
    const five = 5 * H, at = (msLeft: number) => new Date(NOW + msLeft).toISOString();
    // 60% used with 2.5h of 5h gone → 120% at reset; hits 100% after another 100/24 h ≈ 1h40m.
    const hot = forecastWindow("k", "5-hour window", { utilization: 60, resetsAt: at(2.5 * H) }, five, NOW);
    expect(hot).toMatchObject({ state: "will-hit", projectedPct: 120, hitsInMs: Math.round((40 / 60) * 2.5 * H), resetsInMs: 2.5 * H });
    expect(forecastWindow("k", "l", { utilization: 20, resetsAt: at(2.5 * H) }, five, NOW)).toMatchObject({ state: "ok", projectedPct: 40, hitsInMs: null });
    expect(forecastWindow("k", "l", { utilization: 100, resetsAt: at(H) }, five, NOW)).toMatchObject({ state: "reached" });
    expect(forecastWindow("k", "l", { utilization: 30, resetsAt: at(4.8 * H) }, five, NOW)).toMatchObject({ state: "early", projectedPct: null }); // 4% elapsed
    expect(forecastWindow("k", "l", { utilization: 30, resetsAt: null }, five, NOW).state).toBe("early");

    const w = (utilization: number, left: number) => ({ utilization, resetsAt: at(left) });
    const groups = limitForecasts({
      claude: null,
      profiles: [
        { name: "a", usage: { fiveHour: w(50, 2.5 * H), sevenDay: w(5, 6 * DAY), fable: null, extra: null } },
        { name: "b", usage: { fiveHour: w(70, 2.5 * H), sevenDay: w(15, 6 * DAY), fable: null, extra: null } },
      ],
      codex: { windows: [{ label: "5h", utilization: 10, resetsAt: at(2.5 * H), durationMinutes: 300 }, { label: "odd", utilization: 5, resetsAt: null }] },
    }, NOW);
    expect(groups.map((g) => [g.key, g.subtitle, g.rows.map((r) => `${r.label}:${r.state}`)])).toEqual([
      ["claude", "mean of 2 logins", ["5-hour window:will-hit", "Weekly:ok"]],
      ["codex", undefined, ["5-hour window:ok"]], // a window with no known length is not projected
    ]);
    expect(limitForecasts(null)).toEqual([]);
  });

  test("nextLimit: a reached window first, then the soonest to run out, else the highest projected — one window, named", () => {
    const f = (key: string, label: string, over: Partial<WindowForecast>): WindowForecast =>
      ({ key, label, pct: 50, state: "ok", projectedPct: 60, hitsInMs: null, resetsInMs: H, ...over });
    const g = (title: string, rows: WindowForecast[]) => ({ key: title.toLowerCase(), title, rows });
    expect(nextLimit([])).toBeNull();
    // Two windows running out: the sooner wins, whichever provider it is.
    expect(nextLimit([
      g("Claude", [f("a", "5-hour window", { state: "will-hit", hitsInMs: 3 * H }), f("b", "Weekly", { state: "will-hit", hitsInMs: 2 * H, pct: 80 })]),
      g("Codex", [f("c", "Weekly", { state: "ok", projectedPct: 99 })]),
    ])).toEqual({ label: "Claude weekly", state: "will-hit", inMs: 2 * H, pct: 80, projectedPct: 60 });
    // A window already at its limit beats one that will be; inMs is then till its reset.
    expect(nextLimit([g("Claude", [f("a", "5-hour window", { state: "will-hit", hitsInMs: H }), f("b", "Fable weekly", { state: "reached", pct: 100, resetsInMs: 5 * H })])]))
      .toMatchObject({ label: "Claude Fable weekly", state: "reached", inMs: 5 * H });
    // Nothing running out: the highest projection (an early window counts at its current %).
    expect(nextLimit([g("Claude", [f("a", "5-hour window", { projectedPct: 40 }), f("b", "Weekly", { state: "early", projectedPct: null, pct: 70 })])]))
      .toMatchObject({ label: "Claude weekly", state: "early", inMs: null });
  });
});
