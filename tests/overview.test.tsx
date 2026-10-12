// E2E for the overview — the board's default List view (views/Overview.tsx): stat tiles whose
// numbers come from the same rows the swimlanes render, a dense workstream list with its actions
// inline and a filter bar, a recent-activity feed from the transcripts, and the List | Board choice
// persisted in localStorage. The pure derivations (workstream.overviewStats / filterRows / sortRows
// / recentActivity) are checked directly first; then the view is driven against the fake api
// (tests/apiFake.ts) in a real DOM.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { Overview } from "@/views/Overview";
import { boardViewAtom, repoFilterAtom } from "@/lib/atoms";
import { navigate } from "@/lib/route";
import {
  DEFAULT_LIST_FILTER, attentionReasons, filterRows, lastActivity, overviewStats, recentActivity, rowTone, sortRows, turnsByHour,
  type OverviewRow,
} from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const NOW = Date.parse("2026-10-12T12:30:00Z");
const HOUR = 3_600_000;
const row = (over: Partial<OverviewRow>): OverviewRow => ({ repo: "r", branch: "b", title: "t", lane: "LOCAL", ...over });

describe("overview derivations (pure)", () => {
  const rows: OverviewRow[] = [
    row({ branch: "run", title: "Running one", agentStatus: "running", worktreePath: "/wt/run", transcript: [{ provider: "claude", prompt: "go", instruction: "Build the thing", startedAt: NOW - 10 * 60_000 }] }),
    row({ branch: "chk", title: "Check failed", agentStatus: "done", agentCheck: { ok: false }, worktreePath: "/wt/chk", instance: "cloud" }),
    row({ branch: "draft", title: "Draft PR", lane: "DRAFT", prNumber: 1 }),
    row({ branch: "ci", title: "CI red", lane: "IN_REVIEW", prNumber: 2, ciStatus: "failing" }),
    row({ branch: "conf", title: "Conflicted", lane: "IN_REVIEW", prNumber: 3, mergeable: "CONFLICTING", reviewStatus: "changes_requested" }),
    row({ branch: "ok", title: "Approved", lane: "MERGEABLE", prNumber: 4, transcript: [{ provider: "codex", prompt: "x", instruction: "Address review", startedAt: NOW - 3 * HOUR, finishedAt: NOW - 3 * HOUR + 60_000 }] }),
    row({ branch: "done", title: "Shipped", lane: "DONE", prNumber: 5, mergedAt: new Date(NOW - HOUR).toISOString(), ciStatus: "failing" }),
  ];

  test("attention: a failed check, CI, conflicts and changes requested ask for you; running and merged never do", () => {
    expect(attentionReasons(rows[1]!)).toEqual(["check failed"]);
    expect(attentionReasons(rows[3]!)).toEqual(["CI failing"]);
    expect(attentionReasons(rows[4]!)).toEqual(["conflicts", "changes requested"]);
    expect(attentionReasons({ ...rows[3]!, agentStatus: "running" })).toEqual([]); // an agent is on it
    expect(attentionReasons(rows[6]!)).toEqual([]); // merged: finished, whatever its last CI said
    expect(rows.map(rowTone)).toEqual(["running", "failed", "neutral", "failed", "attention", "ready", "ready"]);
  });

  test("stats: running, awaiting you, open PRs by state, local branches, merged today, runs per hour", () => {
    const s = overviewStats(rows, NOW);
    expect(s.running).toBe(1);
    expect(s.attention).toBe(3);
    expect(s.prs).toEqual({ draft: 1, inReview: 2, mergeable: 1, total: 4 });
    expect(s.local).toBe(2);
    expect(s.mergedToday).toBe(1);
    expect(s.turnsByHour).toHaveLength(24);
    expect(s.turnsByHour[23]).toBe(1); // the run started ten minutes ago: this hour
    expect(s.turnsByHour[20]).toBe(1); // three hours ago
    expect(turnsByHour(rows, NOW).reduce((a, b) => a + b, 0)).toBe(2);
  });

  test("filter: repo, instance, state, needs-you and text all narrow; sort orders by the chosen key", () => {
    const f = (over: Partial<typeof DEFAULT_LIST_FILTER>) => filterRows(rows, { ...DEFAULT_LIST_FILTER, ...over }, "laptop").map((r) => r.branch);
    expect(f({})).toHaveLength(rows.length);
    expect(f({ state: "IN_REVIEW" })).toEqual(["ci", "conf"]);
    expect(f({ attention: true })).toEqual(["chk", "ci", "conf"]);
    expect(f({ instance: "cloud" })).toEqual(["chk"]);
    expect(f({ instance: "laptop" })).toEqual(["run"]); // a worktree with no instance is here; PR-only rows have none
    expect(f({ q: "#4" })).toEqual(["ok"]);
    expect(f({ q: "conf" })).toEqual(["conf"]);
    expect(f({ repo: "other" })).toEqual([]);

    expect(sortRows(rows, "updated")[0]!.branch).toBe("run"); // newest activity first
    expect(lastActivity(rows[2]!)).toBe(0);
    expect(sortRows(rows, "state").map((r) => r.lane)).toEqual(["LOCAL", "LOCAL", "DRAFT", "IN_REVIEW", "IN_REVIEW", "MERGEABLE", "DONE"]);
    expect(sortRows(rows, "attention").slice(0, 3).map((r) => r.branch)).toEqual(["conf", "chk", "ci"]);
    expect(sortRows(rows, "title")[0]!.title).toBe("Approved");
  });

  test("recent activity is the newest turns across workstreams, showing what was asked", () => {
    const items = recentActivity(rows);
    expect(items.map((i) => [i.branch, i.text, i.status])).toEqual([
      ["run", "Build the thing", "running"],
      ["ok", "Address review", "done"],
    ]);
  });
});

// ---- the view ----

const flush = () => new Promise((r) => setTimeout(r, 0));
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<Overview />); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
}

afterEach(async () => {
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  getDefaultStore().set(repoFilterAtom, "all");
  localStorage.clear();
  navigate("/"); // the route store, not just the URL — later files mount App on "/"
});

const pr = (over: Record<string, unknown>) => ({
  number: 7, title: "feat", branch: "feat-x", url: "https://x/7", state: "OPEN", isDraft: false,
  ciStatus: "passing", reviewStatus: "review_required", mergeable: "MERGEABLE", autoMergeEnabled: false, ...over,
});

function seed() {
  apiFake.prsData = [
    pr({ number: 7, branch: "feat-draft", title: "Draft work", isDraft: true }),
    pr({ number: 8, branch: "feat-ci", title: "Red CI", ciStatus: "failing" }),
    pr({ number: 9, branch: "feat-ok", title: "Approved thing", reviewStatus: "approved" }),
  ];
  apiFake.agentsData = [
    { branch: "local-run", worktreePath: "/wt/local-run", agentStatus: "running" },
    { branch: "local-err", worktreePath: "/wt/local-err", agentStatus: "error", agentError: "CLI exploded" },
  ];
  apiFake.enrichmentData.set("r::local-run", {
    title: "Wire the gauge",
    transcript: [{ id: "t1", provider: "claude", prompt: "full prompt", instruction: "Add a gauge to the tiles", response: "", startedAt: Date.now() - 60_000 }],
  });
}

const tile = (slot: string) => container!.querySelector<HTMLElement>(`[data-slot="tile-${slot}"]`)!;
const value = (slot: string) => tile(slot).querySelector('[data-slot="stat-value"]')!.textContent;
const listed = () => [...container!.querySelectorAll<HTMLElement>('[data-slot="workstream-row"]')].map((r) => r.dataset.branch);
const button = (text: string) => [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text))!;
const stateChip = (label: string) => [...container!.querySelectorAll('[role="group"][aria-label="State"] button')].find((b) => b.textContent?.trim().startsWith(label))!;

describe("overview view", () => {
  test("stat tiles count the live rows: running, awaiting you, open PRs by state, merged today, each instance", async () => {
    seed();
    await mount();
    expect(value("running")).toBe("1");
    expect(value("attention")).toBe("2"); // CI red + the errored run
    expect(tile("attention").textContent).toContain("1 CI failing");
    expect(value("prs")).toBe("3");
    expect(tile("prs").querySelector('[data-slot="pipeline-DRAFT"]')!.textContent).toContain("1");
    expect(tile("prs").querySelector('[data-slot="pipeline-IN_REVIEW"]')!.textContent).toContain("1");
    expect(tile("prs").querySelector('[data-slot="pipeline-MERGEABLE"]')!.textContent).toContain("1");
    expect(tile("prs").textContent).toContain("2 local branches");
    expect(value("merged")).toBe("0");
    // The fake config has two instances (laptop, cloud): one tile each, CPU from /api/health.
    expect(value("instance-laptop")).toBe("12%");
    expect(value("instance-cloud")).toBe("12%");
    // The 24h runs chart is there with the one run in its current hour.
    expect(tile("running").querySelector("svg[aria-label^='Runs started per hour']")).not.toBeNull();
  });

  test("instance tiles: a CPU and memory sparkline from the last 24h of history, one fetch per instance; a meter until it lands", async () => {
    const now = Date.now();
    apiFake.healthHistoryData = [0, 1, 2].map((i) => ({ at: now - (2 - i) * 60_000, cpuPct: [5, 40, 23][i], load1: 0.1, memUsedGb: [2, 2.5, 4.2][i], memTotalGb: 16 }));
    await mount();
    for (const name of ["laptop", "cloud"]) {
      const t = tile(`instance-${name}`);
      for (const metric of ["cpu", "mem"]) {
        const trend = t.querySelector(`[data-slot="trend-${metric}"]`)!;
        expect(trend).not.toBeNull();
        expect(trend.querySelector("polyline")!.getAttribute("points")!.split(" ")).toHaveLength(3);
      }
    }
    // One shared loop per instance (database-only, so either instance answers), 24h each; a poll of
    // the board doesn't start another.
    await act(async () => { await store.refresh(); await flush(); });
    expect(apiFake.healthHistoryCalls.map((c) => `${c.instance}:${c.hours}`).sort()).toEqual(["cloud:24", "laptop:24"]);
  });

  test("instance tiles with no recorded history keep the plain meters", async () => {
    await mount();
    expect(tile("instance-cloud").querySelector('[data-slot^="trend-"]')).toBeNull();
    expect(tile("instance-cloud").textContent).toContain("cpu");
    expect(tile("instance-cloud").textContent).toContain("mem");
  });

  test("the usage tile shows the same Claude reading the header meter does", async () => {
    apiFake.usageData = { claude: { fiveHour: { utilization: 38, resetsAt: null }, sevenDay: { utilization: 55, resetsAt: null }, extra: null }, codex: null };
    await mount();
    expect(value("usage")).toBe("38%");
    expect(tile("usage").textContent).toContain("55%");
  });

  test("every workstream is one row with its actions inline; the error and badges show on the row", async () => {
    seed();
    await mount();
    expect(listed().sort()).toEqual(["feat-ci", "feat-draft", "feat-ok", "local-err", "local-run"]);
    const err = container!.querySelector<HTMLElement>('[data-branch="local-err"]')!;
    expect(err.textContent).toContain("CLI exploded");
    expect(err.querySelector('[data-tone="failed"]')).not.toBeNull();
    const ci = container!.querySelector<HTMLElement>('[data-branch="feat-ci"]')!;
    expect(ci.textContent).toContain("#8");
    expect(ci.textContent).toContain("In review");
    expect(ci.textContent).toContain("CI");
    // The card's controls, reused: Test/preview, terminal, Follow up, Merge (mergeable only), ⋯.
    for (const label of ["Test locally", "Open terminal", "Follow up", "Actions"]) expect(ci.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
    const ok = container!.querySelector<HTMLElement>('[data-branch="feat-ok"]')!;
    expect(ok.querySelector('button[aria-label^="Merge"]')).not.toBeNull();
  });

  test("filter bar: state chips, needs-you, search and the tiles all narrow the list; clearing restores it", async () => {
    seed();
    await mount();
    await click(stateChip("In review"));
    expect(listed()).toEqual(["feat-ci"]);
    await click(stateChip("All"));
    await click(button("Needs you"));
    expect(listed().sort()).toEqual(["feat-ci", "local-err"]);
    await click(button("Needs you"));
    const search = container!.querySelector<HTMLInputElement>('input[aria-label="Search workstreams"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(search, "gauge");
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    expect(listed()).toEqual(["local-run"]); // matched on its enriched title
    await click(container!.querySelector('button[aria-label="Clear search"]')!);
    // The Awaiting-you tile is the same filter, and the pipeline bar's segments pick a state.
    await click(tile("attention"));
    expect(tile("attention").getAttribute("aria-pressed")).toBe("true");
    expect(listed().sort()).toEqual(["feat-ci", "local-err"]);
    await click(tile("attention"));
    await click(tile("prs").querySelector('[data-slot="pipeline-DRAFT"]')!);
    expect(listed()).toEqual(["feat-draft"]);
    // Nothing matches → an empty state with a way back.
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(search, "no such thing");
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    expect(listed()).toEqual([]);
    await click(button("Clear filters"));
    expect(listed()).toHaveLength(5);
  });

  test("clicking a row opens its detail page; clicking a control in it does not", async () => {
    (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL("http://localhost/");
    seed();
    await mount();
    const ci = container!.querySelector<HTMLElement>('[data-branch="feat-ci"]')!;
    await click(ci.querySelector('[data-slot="badge"]')!); // a non-control cell
    expect(location.pathname).toBe("/r/prs/8");
    await act(async () => navigate("/"));
    await click(ci.querySelector('button[aria-label="Open terminal"]')!);
    expect(location.pathname).toBe("/");
    const local = container!.querySelector<HTMLElement>('[data-branch="local-run"]')!;
    await click(local.querySelector(".font-medium")!);
    expect(location.pathname).toBe("/r/local/local-run");
  });

  test("recent activity lists the newest turns with what was asked", async () => {
    seed();
    await mount();
    const feed = container!.querySelector('[data-slot="recent-activity"]')!;
    expect(feed.textContent).toContain("Add a gauge to the tiles");
    expect(feed.textContent).toContain("Wire the gauge");
  });
});

describe("view toggle persistence", () => {
  test("List is the default and the choice is read back from localStorage", () => {
    localStorage.removeItem("orca.boardView");
    const fresh = createStore();
    fresh.sub(boardViewAtom, () => {});
    expect(fresh.get(boardViewAtom)).toBe("list");
    localStorage.setItem("orca.boardView", JSON.stringify("board"));
    const reloaded = createStore(); // a reload: a new store reads the saved choice on mount
    reloaded.sub(boardViewAtom, () => {});
    expect(reloaded.get(boardViewAtom)).toBe("board");
  });
});
