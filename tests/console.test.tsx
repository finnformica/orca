// The Vercel-style console (sidebar shell, Overview, Agents, Agent page, Usage/Repos/Settings): the
// pure derivations first — usage rows, chart helpers, durations, the chat log's counters and find,
// repo summaries — then the pages rendered against the fake api (tests/apiFake.ts) in a real DOM.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import { repoFilterAtom } from "@/lib/atoms";
import {
  agentFailure, chatSummary, downsample, formatDuration, niceMax, repoSummaries, routingBroken, rowDuration, timeTicks, turnMatches, untilReset,
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
    expect(t[3]!.label).toBe("now"); // the right edge
    expect(t[0]!.label).toBe(new Date(NOW - 6 * 3_600_000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })); // clock time within a day
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
    expect(chatSummary([{ failed: true }, { stopped: true }, { check: { ok: false, command: "x", exitCode: 1, output: "", durationMs: 1 } }, {}])).toEqual({ turns: 4, errors: 1, warnings: 2 });
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

test("agent failure box: a failed run's error, else the failed check's command, exit code and output tail", async () => {
  expect(agentFailure({ agentStatus: "error", agentError: "claude: not logged in" })).toEqual({ title: "Run failed", detail: "claude: not logged in" });
  const check = { command: "bun run check", ok: false, exitCode: 1, output: "x\n".repeat(20) + "1 fail", durationMs: 9 };
  const f = agentFailure({ agentStatus: "done", agentCheck: check })!;
  expect(f.title).toBe("Check failed");
  expect(f.detail).toStartWith('Command "bun run check" exited with 1');
  expect(f.detail.split("\n").length).toBeLessThanOrEqual(14); // only the tail
  expect(agentFailure({ agentStatus: "done", agentCheck: { ...check, ok: true } })).toBeUndefined();
});

// ---- the pages, against the fake api ----


(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function open(path: string) {
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
}
const $ = (slot: string) => container!.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!;
const type = async (input: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
});

describe("the console's pages", () => {
  beforeAll(() => store.configReady);
  afterEach(async () => {
    apiFake.reset();
    await act(async () => { await store.refresh(); });
    act(() => root?.unmount());
    container?.remove();
    root = container = undefined;
    getDefaultStore().set(repoFilterAtom, "all");
    localStorage.clear();
    navigate("/");
  });

  const turns = [
    { id: "t1", provider: "claude", prompt: "p", instruction: "Build the login form", response: "## Outcome\nForm built.", startedAt: NOW - 3_600_000, finishedAt: NOW - 3_500_000 },
    { id: "t2", provider: "claude", prompt: "p", instruction: "Fix the flaky login test", response: "claude: not logged in", failed: true, startedAt: NOW - 600_000, finishedAt: NOW - 590_000 },
    { id: "t3", provider: "claude", prompt: "p", instruction: "Try again", response: "Stopped.", stopped: true, startedAt: NOW - 300_000, finishedAt: NOW - 290_000 },
  ];
  const seedLocal = () => {
    apiFake.agentsData = [{ branch: "feat-login", worktreePath: "/wt/feat-login", agentStatus: "error", agentError: "claude: not logged in" }];
    apiFake.enrichmentData.set("r::feat-login", { title: "Login form", transcript: turns });
    apiFake.turnsData.set("r::feat-login", turns);
    apiFake.summaryData = { files: [{ path: "src/login.tsx", additions: 40, deletions: 2 }], commits: [{ hash: "6eaab29aaaa", subject: "Add the login form" }], additions: 40, deletions: 2 };
  };

  test("agent page: a Details card — the failure box like Build Failed, status, model, source branch + latest commit", async () => {
    seedLocal();
    await open("/r/local/feat-login");
    expect(container!.querySelector('nav[aria-label="Breadcrumb"]')!.textContent).toContain("Login form");
    const details = $("agent-details");
    expect(details.querySelector('[data-slot="failure-box"]')!.textContent).toContain("Run failed");
    expect(details.querySelector('[data-slot="failure-box"]')!.textContent).toContain("claude: not logged in");
    expect(details.querySelector('[data-slot="detail-status"]')!.textContent).toContain("Error");
    expect(details.querySelector('[data-slot="detail-created"]')!.textContent).toContain("ago");
    expect(details.querySelector('[data-slot="detail-model"]')!.textContent).not.toBe("");
    const source = details.querySelector('[data-slot="detail-source"]')!.textContent!;
    expect(source).toContain("feat-login");
    expect(source).toContain("6eaab29");
    expect(source).toContain("Add the login form");
    // The page's actions live on the card, Vercel's Redeploy / ⋯.
    expect(details.querySelector('button[aria-label="Actions"]')).not.toBeNull();
    const tabs = [...container!.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(["Overview", "Chat", "Files changed (1)", "Preview"]);
  });

  test("agent page: the conversation sits where Build Logs do — turn count, error / warning counters, Find in chat, timestamps", async () => {
    seedLocal();
    await open("/r/local/feat-login");
    const chat = $("agent-chat");
    expect(chat.querySelector('[data-slot="chat-count"]')!.textContent).toBe("3 turns");
    expect(chat.querySelector('[data-slot="chat-errors"]')!.textContent).toBe("1");
    expect(chat.querySelector('[data-slot="chat-warnings"]')!.textContent).toBe("1");
    expect(chat.querySelectorAll('[data-slot="turn-time"]')).toHaveLength(3);
    expect(chat.querySelector('[data-slot="chat-turn"][data-failed]')!.className).toContain("bg-red-500/10"); // tinted like an error line
    await type(chat.querySelector<HTMLInputElement>('input[aria-label="Find in chat"]')!, "flaky");
    expect(chat.querySelectorAll('[data-slot="chat-turn"]')).toHaveLength(1);
    expect(chat.textContent).toContain("Fix the flaky login test");
    await type(chat.querySelector<HTMLInputElement>('input[aria-label="Find in chat"]')!, "nothing like it");
    expect(chat.textContent).toContain("No turn matches");
    // The composer is at the foot of the card.
    expect(chat.querySelector("textarea")).not.toBeNull();
  });

  test("agent page: the Chat tab is the conversation alone; a coworker's PR has no Chat tab", async () => {
    seedLocal();
    await open("/r/local/feat-login/chat");
    expect($("agent-chat")).not.toBeNull();
    expect(container!.querySelector('[data-slot="agent-details"]')).toBeNull();
    act(() => root?.unmount()); container?.remove();
    apiFake.prDetailData = { title: "Someone else's work", author: "alice", head: "their-branch" };
    await open("/r/prs/42");
    expect($("pr-details").textContent).toContain("alice");
    expect([...container!.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).not.toContain("Chat");
    expect(container!.querySelector('[data-slot="agent-chat"]')).toBeNull();
  });

  test("Repos: one row per repo with its numbers; a click opens Agents scoped to it", async () => {
    seedLocal();
    await open("/repos");
    const row = $("repo-row");
    expect(row.textContent).toContain("r");
    expect(row.textContent).toContain("Needs you1");
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    expect(location.pathname).toBe("/agents");
    expect(getDefaultStore().get(repoFilterAtom)).toBe("r");
  });

  test("Settings: theme and density, and the configuration this bridge runs with (read-only)", async () => {
    await open("/settings");
    expect($("settings-appearance").querySelector('[role="group"][aria-label="Theme"]')).not.toBeNull();
    expect($("settings-appearance").querySelector('[role="group"][aria-label="Density"]')).not.toBeNull();
    const cfg = $("settings-config");
    expect(cfg.textContent).toContain("laptop");
    expect(cfg.textContent).toContain("base main");
  });
});
