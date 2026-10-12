// E2E for the Overview's Agents card (views/Overview.tsx) and the Agents list (views/Agents.tsx):
// numbers and rows come from the same rows the swimlanes render. The pure derivations
// (workstream.overviewStats / filterRows / sortRows / recentActivity) are checked directly first;
// then the views are driven against the fake api (tests/apiFake.ts) in a real DOM.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { Overview } from "@/views/Overview";
import { Agents } from "@/views/Agents";
import { agentQueryAtom, boardViewAtom, repoFilterAtom } from "@/lib/atoms";
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

// ---- the views: the Overview's Agents card, and the Agents list ----

const flush = () => new Promise((r) => setTimeout(r, 0));
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(node: React.ReactNode = <Overview />) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
}

afterEach(async () => {
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  const s = getDefaultStore();
  s.set(repoFilterAtom, "all");
  s.set(agentQueryAtom, "");
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

const stat = (slot: string) => container!.querySelector<HTMLElement>(`[data-slot="stat-${slot}"]`)!;
const value = (slot: string) => stat(slot).querySelector('[data-slot="stat-value"]')!.textContent;
const listed = () => [...container!.querySelectorAll<HTMLElement>('[data-slot="workstream-row"]')].map((r) => r.dataset.branch);
const button = (text: string) => [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text))!;
const type = async (input: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
});

describe("overview: the Agents card", () => {
  test("ONE card with the four numbers — running (with the 24h runs line), needs attention, open PRs by state, merged today", async () => {
    seed();
    await mount();
    const card = container!.querySelector('[data-slot="agents-card"]')!;
    expect(card.querySelectorAll('[data-slot^="stat-"][role="button"]')).toHaveLength(4);
    expect(value("running")).toBe("1");
    expect(value("attention")).toBe("2"); // CI red + the errored run
    expect(value("prs")).toBe("3");
    expect(stat("prs").querySelector('[data-slot="pipeline-DRAFT"]')!.textContent).toContain("1");
    expect(stat("prs").querySelector('[data-slot="pipeline-IN_REVIEW"]')!.textContent).toContain("1");
    expect(stat("prs").querySelector('[data-slot="pipeline-MERGEABLE"]')!.textContent).toContain("1");
    expect(stat("attention").querySelector('[data-slot="attention-reasons"]')!.textContent).toBe("1 agent error · 1 CI failing"); // why, not just how many
    expect(value("merged")).toBe("0");
    expect(stat("running").querySelector("svg[aria-label^='Runs started per hour']")).not.toBeNull();
    // The redundant Awaiting-you tiles of the first cut are gone.
    expect(container!.querySelector('[data-slot="stat-tiles"]')).toBeNull();
  });

  test("shows stat-tile skeletons, sized like the real tiles, until the first agents+PRs refresh settles", async () => {
    store._resetWorkstreamsLoaded(); // a module singleton that an earlier test's mount() already flipped
    seed();
    apiFake.holdPrs = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => { root = createRoot(container!); root.render(<Overview />); await flush(); });
    void store.refresh(); // fired, not awaited — it's held on pollPrs until releasePrs()
    await flush();
    const card = container!.querySelector('[data-slot="agents-card"]')!;
    expect(card.querySelectorAll('[data-slot="stat-skeleton"]')).toHaveLength(4);
    expect(card.querySelector('[data-slot="stat-running"]')).toBeNull();
    await act(async () => { apiFake.releasePrs!(); await flush(); await flush(); });
    expect(card.querySelectorAll('[data-slot="stat-skeleton"]')).toHaveLength(0);
    expect(value("running")).toBe("1");
  });

  test("each number links to the Agents list's quick chips that count exactly it", async () => {
    seed();
    await mount();
    await click(stat("attention"));
    expect(location.pathname + location.search).toBe("/agents?status=attention");
    act(() => root?.unmount()); container?.remove();
    await mount(<Agents />);
    expect(listed().sort()).toEqual(["feat-ci", "local-err"]); // the same two the card counted
    expect(container!.querySelector('[data-chip="status:attention"]')!.getAttribute("aria-pressed")).toBe("true");
    act(() => root?.unmount()); container?.remove();
    await act(async () => navigate("/"));
    await mount();
    for (const [el, query] of [
      [stat("running"), "?status=running"],
      [stat("prs"), "?pr=open"],
      [stat("prs").querySelector('[data-slot="pipeline-MERGEABLE"]')!, "?pr=mergeable"],
      [stat("merged"), "?pr=merged"],
    ] as const) {
      await act(async () => navigate("/"));
      await click(el);
      expect(location.pathname + location.search).toBe(`/agents${query}`);
    }
  });

  test("recent activity lists the newest turns with what was asked", async () => {
    seed();
    await mount();
    const feed = container!.querySelector('[data-slot="recent-activity"]')!;
    expect(feed.textContent).toContain("Add a gauge to the tiles");
    expect(feed.textContent).toContain("Wire the gauge");
  });
});

describe("agents list", () => {
  test("one dense row per workstream: status dot + label, state pill, signals, PR, branch, model; the error shows on the row", async () => {
    seed();
    await mount(<Agents />);
    expect(listed().sort()).toEqual(["feat-ci", "feat-draft", "feat-ok", "local-err", "local-run"]);
    const err = container!.querySelector<HTMLElement>('[data-branch="local-err"]')!;
    expect(err.textContent).toContain("CLI exploded");
    expect(err.querySelector('[data-tone="failed"]')!.textContent).toBe("Error");
    expect(err.querySelector('[data-slot="status-dot"]')!.getAttribute("data-tone")).toBe("error");
    const run = container!.querySelector<HTMLElement>('[data-branch="local-run"]')!;
    expect(run.textContent).toContain("Add a gauge to the tiles"); // the latest instruction, where Vercel shows the commit
    expect(run.querySelector('[data-tone="running"]')!.textContent).toBe("Running");
    const ci = container!.querySelector<HTMLElement>('[data-branch="feat-ci"]')!;
    expect(ci.querySelector('[data-slot="state-pill"]')!.textContent).toBe("In review");
    expect(ci.textContent).toContain("8");
    expect(ci.textContent).toContain("CI");
    expect(ci.querySelector('[data-slot="model-avatar"]')).not.toBeNull();
    // Every action is in the trailing ⋯ (plus the preview's Test); no toolbar of verbs on the row.
    expect(ci.querySelector('button[aria-label="Actions"]')).not.toBeNull();
    expect(ci.querySelector('button[aria-label="Follow up"]')).toBeNull();
    expect(container!.querySelector<HTMLElement>('[data-branch="feat-ok"]')!.querySelector('[data-slot="state-pill"]')!.textContent).toBe("Mergeable");
  });

  test("search narrows the list alongside the chips; an empty result offers a way back", async () => {
    seed();
    await mount(<Agents />);
    const search = container!.querySelector<HTMLInputElement>('input[aria-label="Search workstreams"]')!;
    await type(search, "gauge");
    expect(listed()).toEqual(["local-run"]); // matched on its enriched title
    await type(search, "no such thing");
    expect(listed()).toEqual([]);
    await click(button("Clear filters"));
    expect(listed()).toHaveLength(5);
  });

  test("clicking a row opens its agent page; clicking a control in it does not", async () => {
    seed();
    await mount(<Agents />);
    const ci = container!.querySelector<HTMLElement>('[data-branch="feat-ci"]')!;
    await click(ci.querySelector('[data-slot="state-pill"]')!); // a non-control cell
    expect(location.pathname).toBe("/r/prs/8");
    await act(async () => navigate("/agents"));
    await click(ci.querySelector('button[aria-label="Actions"]')!);
    expect(location.pathname).toBe("/agents");
    const local = container!.querySelector<HTMLElement>('[data-branch="local-run"]')!;
    await click(local.querySelector(".font-medium")!);
    expect(location.pathname).toBe("/r/local/local-run");
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
