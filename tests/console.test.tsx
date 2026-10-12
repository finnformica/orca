// The Vercel-style console (sidebar shell, Overview, Agents, Agent page, Usage/Repos/Settings): the
// pure derivations first — usage rows, chart helpers, durations, the chat log's counters and find,
// repo summaries — then the pages rendered against the fake api (tests/apiFake.ts) in a real DOM.
import { describe, expect, test } from "bun:test";
import {
  chatSummary, downsample, formatDuration, niceMax, repoSummaries, routingBroken, rowDuration, timeTicks, turnMatches, untilReset,
  usageGroups, type OverviewRow,
} from "@/workstream";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const w = (utilization: number, h: number | null = 2) => ({ utilization, resetsAt: h === null ? null : inHours(h) });

describe("console derivations (pure)", () => {
  test("usage rows: one Claude login → 5-hour / weekly / Fable / extra spend as value / limit; Codex after", () => {
    const groups = usageGroups({
      claude: { fiveHour: w(38, 2.25), sevenDay: w(55, 50), fable: w(12, 100), extra: { usedMinor: 8535, limitMinor: 20000, currency: "GBP", exponent: 2, utilization: 43 } },
      codex: { windows: [{ label: "5h", ...w(9, 1) }, { label: "wk", ...w(30, 30) }] },
    }, NOW);
    expect(groups.map((g) => g.title)).toEqual(["Claude", "Codex"]);
    expect(groups[0]!.rows.map((r) => [r.label, r.value, r.limit, r.resetsIn])).toEqual([
      ["5-hour window", "38%", "100%", "2h 15m"],
      ["Weekly", "55%", "100%", "2d 2h"],
      ["Fable weekly", "12%", "100%", "4d 4h"],
      ["Extra usage", "£85.35", "£200.00", null],
    ]);
    expect(groups[1]!.rows.map((r) => [r.label, r.pct])).toEqual([["5-hour window", 9], ["Weekly", 30]]);
    expect(usageGroups(null)).toEqual([]);
    expect(untilReset(inHours(-1), NOW)).toBeNull();
  });

  test("usage rows with hydra: the fleet mean over the logins in rotation, then every login with its state", () => {
    const login = (name: string, five: number, state?: string, usage = true) => ({
      name, state, usage: usage ? { fiveHour: w(five), sevenDay: w(five / 2, 40), fable: null, extra: null } : null,
    });
    const groups = usageGroups({
      claude: null, codex: null, routing: { hydra: true, shim: true },
      profiles: [login("work", 80), login("home", 40, "exhausted"), login("old", 0, "not signed in on this machine", false)],
    }, NOW);
    expect(groups.map((g) => [g.title, g.subtitle, g.state, g.dim])).toEqual([
      ["Claude", "2 logins in rotation · 1 exhausted", undefined, undefined],
      ["work", undefined, undefined, false],
      ["home", undefined, "exhausted", false],
      ["old", undefined, "not signed in on this machine", true],
    ]);
    expect(groups[0]!.rows.map((r) => [r.label, r.pct])).toEqual([["5-hour window", 60], ["Weekly", 30]]);
    expect(routingBroken({ claude: null, codex: null, routing: { hydra: true, shim: false } })).toBe(true);
    expect(routingBroken({ claude: null, codex: null, routing: { hydra: false, shim: false } })).toBe(false);
  });

  test("charts: downsampling keeps the shape in at most N points; round maxima; time ticks", () => {
    const from = NOW - 168 * 3_600_000;
    const week = Array.from({ length: 10_080 }, (_, i) => ({ at: from + i * 60_000, v: i % 2 ? 10 : 30 }));
    const d = downsample(week, 300, from, NOW);
    expect(d.length).toBeLessThanOrEqual(301);
    expect(d.every((p) => Math.abs(p.v - 20) < 1)).toBe(true); // alternating 10/30 averages to 20
    expect(downsample(week.slice(0, 10), 300, from, NOW)).toHaveLength(10);
    expect([niceMax(0), niceMax(15.3), niceMax(31), niceMax(100), niceMax(0.4)]).toEqual([1, 20, 50, 100, 0.5]);
    const t = timeTicks(NOW - 6 * 3_600_000, NOW, 4);
    expect(t).toHaveLength(4);
    expect(t[3]!.label).toBe(new Date(NOW).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })); // clock time within a day
    expect(timeTicks(NOW - 168 * 3_600_000, NOW)[0]!.label).toBe(new Date(NOW - 168 * 3_600_000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })); // dates beyond
  });

  test("durations: running counts from launch, otherwise the last turn's length; Vercel's compact format", () => {
    expect(formatDuration(44_000)).toBe("44s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(125 * 60_000)).toBe("2h 5m");
    expect(rowDuration({ agentStatus: "running", agentStartedAt: NOW - 90_000 }, NOW)).toBe(90_000);
    expect(rowDuration({ agentStatus: "done", transcript: [{ provider: "claude", prompt: "", startedAt: 1_000, finishedAt: 61_000 }] }, NOW)).toBe(60_000);
    expect(rowDuration({}, NOW)).toBeUndefined();
  });

  test("chat log: turns / errors / warnings counters, and find-in-chat over instruction and response", () => {
    expect(chatSummary([{ failed: true }, { stopped: true }, { check: { ok: false, command: "x", exitCode: 1, output: "" } }, {}])).toEqual({ turns: 4, errors: 1, warnings: 2 });
    const turn = { prompt: "", instruction: "Fix the flaky login test", response: "Root cause: a race in the session cookie." };
    expect(turnMatches(turn, "")).toBe(true);
    expect(turnMatches(turn, "login RACE")).toBe(true);
    expect(turnMatches(turn, "login deploy")).toBe(false);
  });

  test("repo summaries: the overview's numbers per repo, plus last activity", () => {
    const rows: OverviewRow[] = [
      { repo: "a", branch: "x", title: "x", lane: "LOCAL", agentStatus: "running", transcript: [{ provider: "claude", prompt: "", startedAt: 500 }] },
      { repo: "a", branch: "y", title: "y", lane: "IN_REVIEW", prNumber: 2, ciStatus: "failing" },
      { repo: "b", branch: "z", title: "z", lane: "DONE", prNumber: 3 },
    ];
    expect(repoSummaries(rows, ["a", "b", "c"])).toEqual([
      { repo: "a", total: 2, running: 1, attention: 1, openPrs: 1, local: 1, mergedToday: 0, lastActivity: 500 },
      { repo: "b", total: 1, running: 0, attention: 0, openPrs: 0, local: 0, mergedToday: 1, lastActivity: 0 },
      { repo: "c", total: 0, running: 0, attention: 0, openPrs: 0, local: 0, mergedToday: 0, lastActivity: 0 },
    ]);
  });
});
