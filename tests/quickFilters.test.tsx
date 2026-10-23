// The Agents page's quick filters (views/Agents.tsx, workstream.ts parseQuickFilter / applyQuickFilter
// / quickCount): one dropdown per family above the list — State (Open PRs, Verified, Mergeable,
// Merged today, Merged this week, Not merged), Activity (Running, Needs attention) and Repo (one per
// repo) — whose choices are toggleable and combinable (AND across groups, OR within one), each with
// its count, and held in the URL query so a filtered view is a link. "Mine"/"Orchestrated" and per-instance pills were dropped (orchestrated
// and instance stay visible as the row's own badge/column), but their URL params and pure filtering
// still work for a link someone already has. The pure model first, then the page against the fake api
// (tests/apiFake.ts) in a real DOM.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import { agentQueryAtom, instanceScopeAtom, repoFilterAtom } from "@/lib/atoms";
import {
  MERGED_WEEK_MS, NO_QUICK_FILTER, applyQuickFilter, attentionReasons, clearQuickGroup, dropStaleRepos, mergedThisWeek, mergedToday, notMergedCount, overviewStats, parseQuickFilter, quickCount, quickFilterQuery, quickGroupActive, toggleNotMerged, toggleQuick, type OverviewRow,
} from "@/workstream";

const row = (over: Partial<OverviewRow>): OverviewRow => ({ repo: "a", branch: "b", title: "t", lane: "LOCAL", ...over });

describe("quick filters (pure)", () => {
  const rows: OverviewRow[] = [
    row({ branch: "run", agentStatus: "running", worktreePath: "/wt/run" }),
    row({ branch: "err", agentStatus: "error", worktreePath: "/wt/err", instance: "cloud", orchestrated: true }),
    row({ branch: "ci", lane: "IN_REVIEW", prNumber: 2, ciStatus: "failing", repo: "b" }),
    row({ branch: "ok", lane: "MERGEABLE", prNumber: 3, orchestrated: true }),
    row({ branch: "done", lane: "DONE", prNumber: 4 }),
  ];
  const names = (f: ReturnType<typeof parseQuickFilter>) => applyQuickFilter(rows, f, "local").map((r) => r.branch);

  test("needs attention: check failed, conflicts, CI red, changes requested, a run error or stop, a held message", () => {
    expect(attentionReasons(row({ agentStatus: "done", transcript: [{ provider: "claude", prompt: "", stopped: true }] }))).toEqual(["run stopped"]);
    expect(attentionReasons(row({ agentStatus: "idle", queued: 1 }))).toEqual(["message held"]);
    expect(attentionReasons(row({ agentStatus: "running", queued: 2 }))).toEqual([]); // queued behind a live run: it'll send itself
    expect(attentionReasons(row({ lane: "IN_REVIEW", prNumber: 1, reviewStatus: "changes_requested", mergeable: "CONFLICTING", agentCheck: { ok: false } })))
      .toEqual(["check failed", "conflicts", "changes requested"]);
  });

  test("the URL holds the chips: parse drops unknown values; the query is stable and empty when nothing is on", () => {
    const f = parseQuickFilter("?status=attention,bogus&pr=merged&on=cloud&repo=a,b&by=orchestrated&x=1");
    expect(f).toEqual({ status: ["attention"], pr: ["merged"], by: ["orchestrated"], on: ["cloud"], repo: ["a", "b"], notMerged: true });
    expect(quickFilterQuery(f)).toBe("?status=attention&pr=merged&by=orchestrated&on=cloud&repo=a,b");
    expect(quickFilterQuery(NO_QUICK_FILTER)).toBe(""); // a plain URL already means "not merged" is on
    expect(parseQuickFilter(quickFilterQuery(f))).toEqual(f); // round-trips
  });

  test("not merged: on by default (hides merged), togglable off, and only in the URL when off", () => {
    expect(NO_QUICK_FILTER.notMerged).toBe(true);
    expect(parseQuickFilter("")).toEqual(NO_QUICK_FILTER);
    expect(names(parseQuickFilter(""))).toEqual(["run", "err", "ci", "ok"]); // "done" (merged) is hidden by default
    const off = toggleNotMerged(NO_QUICK_FILTER);
    expect(off.notMerged).toBe(false);
    expect(names(off)).toEqual(["run", "err", "ci", "ok", "done"]); // toggled off: merged rows show again
    expect(quickFilterQuery(off)).toBe("?notMerged=0"); // off differs from the default, so it's carried
    expect(parseQuickFilter(quickFilterQuery(off))).toEqual(off); // round-trips
    expect(toggleNotMerged(off)).toEqual(NO_QUICK_FILTER); // toggling twice is a no-op
    // Explicitly asking for merged (the "Merged today" chip) overrides the default hide, even
    // without touching the toggle — the chip would otherwise be permanently empty.
    expect(names(parseQuickFilter("?pr=merged"))).toEqual(["done"]);
  });

  test("chips combine: OR within a group, AND across groups; toggling twice is a no-op", () => {
    expect(names(parseQuickFilter("?status=running"))).toEqual(["run"]);
    expect(names(parseQuickFilter("?status=running,attention"))).toEqual(["run", "err", "ci"]); // OR
    expect(names(parseQuickFilter("?status=attention&by=orchestrated"))).toEqual(["err"]); // AND
    expect(names(parseQuickFilter("?pr=open"))).toEqual(["ci", "ok"]);
    expect(names(parseQuickFilter("?pr=mergeable,merged"))).toEqual(["ok", "done"]);
    expect(names(parseQuickFilter("?by=mine"))).toEqual(["run", "ci"]); // "done" is merged: hidden by the default notMerged
    expect(names(parseQuickFilter("?on=local"))).toEqual(["run"]); // a worktree with no instance is here
    expect(names(parseQuickFilter("?repo=b"))).toEqual(["ci"]);
    const once = toggleQuick(NO_QUICK_FILTER, "pr", "open");
    expect(once.pr).toEqual(["open"]);
    expect(toggleQuick(once, "pr", "open")).toEqual(NO_QUICK_FILTER);
  });

  test("a chip's count is what it would show with the other groups' chips on", () => {
    const f = parseQuickFilter("?by=orchestrated");
    expect(quickCount(rows, f, "status", "attention", "local")).toBe(1); // err (orchestrated); ci is mine
    expect(quickCount(rows, f, "pr", "mergeable", "local")).toBe(1);
    expect(quickCount(rows, f, "by", "mine", "local")).toBe(2); // its own group is ignored: what switching to it shows ("done" stays hidden)
  });

  test("merged this week: a rolling 7 days, today's included; Merged today stays today's", () => {
    const now = new Date(2026, 9, 21, 15, 0).getTime(); // a Wednesday afternoon, local time
    const at = (ms: number) => new Date(ms).toISOString();
    const hour = 3_600_000;
    const week: OverviewRow[] = [
      row({ branch: "today", lane: "DONE", prNumber: 1, mergedAt: at(now - 2 * hour) }),
      row({ branch: "monday", lane: "DONE", prNumber: 2, mergedAt: at(now - 50 * hour) }),
      row({ branch: "six-days", lane: "DONE", prNumber: 3, mergedAt: at(now - MERGED_WEEK_MS + hour) }),
      row({ branch: "eight-days", lane: "DONE", prNumber: 4, mergedAt: at(now - MERGED_WEEK_MS - hour) }),
      row({ branch: "open", lane: "IN_REVIEW", prNumber: 5 }),
    ];
    const names = (search: string) => applyQuickFilter(week, parseQuickFilter(search), "local", now).map((r) => r.branch);
    expect(mergedToday(week[0]!, now)).toBe(true);
    expect(mergedToday(week[1]!, now)).toBe(false);
    expect(mergedThisWeek(week[2]!, now)).toBe(true);
    expect(mergedThisWeek(week[3]!, now)).toBe(false);
    expect(mergedThisWeek(week[4]!, now)).toBe(false); // not merged at all
    expect(mergedToday(row({ lane: "DONE" }), now)).toBe(true); // no mergedAt: read as today's, as before
    expect(names("?pr=merged")).toEqual(["today"]);
    expect(names("?pr=week")).toEqual(["today", "monday", "six-days"]);
    expect(names("?pr=merged,week")).toEqual(["today", "monday", "six-days"]); // OR within the group
    expect(names("")).toEqual(["open"]); // Not merged (the default) hides every merged row
    expect(quickCount(week, NO_QUICK_FILTER, "pr", "week", "local", now)).toBe(3);
    expect(quickCount(week, NO_QUICK_FILTER, "pr", "merged", "local", now)).toBe(1);
    // The Overview's "Merged today" number (which links to ?pr=merged) counts today's only.
    expect(overviewStats(week, now).mergedToday).toBe(1);
  });

  test("the URL round-trips the new choice, and an old link still parses the same", () => {
    const f = parseQuickFilter("?pr=week,open&status=running");
    expect(f.pr).toEqual(["week", "open"]);
    expect(quickFilterQuery(f)).toBe("?status=running&pr=week,open");
    expect(parseQuickFilter(quickFilterQuery(f))).toEqual(f);
    // Links from before the dropdowns (the Overview's "Merged today" among them) mean what they meant.
    expect(parseQuickFilter("?pr=merged")).toEqual({ ...NO_QUICK_FILTER, pr: ["merged"] });
    expect(parseQuickFilter("?status=attention&pr=open&notMerged=0")).toEqual({ ...NO_QUICK_FILTER, status: ["attention"], pr: ["open"], notMerged: false });
  });

  test("a dropdown's count and Clear: only its own group; State counts Not merged when it is off", () => {
    const f = parseQuickFilter("?pr=open,week&status=running&notMerged=0");
    expect(quickGroupActive(f, "pr")).toBe(3); // two choices + Not merged turned off
    expect(quickGroupActive(f, "status")).toBe(1);
    expect(quickGroupActive(NO_QUICK_FILTER, "pr")).toBe(0); // Not merged on is the default, not a choice
    expect(clearQuickGroup(f, "pr")).toEqual({ ...NO_QUICK_FILTER, status: ["running"] });
    expect(clearQuickGroup(f, "status")).toEqual({ ...f, status: [] });
  });

  test("dropStaleRepos: drops a repo value no repo config names (a rename or removal), keeps the rest", () => {
    const f = parseQuickFilter("?status=running&repo=a,orca-src,b");
    expect(dropStaleRepos(f, ["a", "b"])).toEqual({ ...f, repo: ["a", "b"] });
    // Nothing to drop: the same reference comes back, so a caller can tell nothing changed.
    const clean = parseQuickFilter("?repo=a,b");
    expect(dropStaleRepos(clean, ["a", "b"])).toBe(clean);
    // An empty repo list reads as "not loaded yet", not "no repos configured" — callers must not
    // call this before the repo list has loaded, else every value would be dropped.
    expect(dropStaleRepos(f, []).repo).toEqual([]);
  });

  test("the notMerged chip's own count: NOT merged workstreams, under the other groups' chips", () => {
    expect(notMergedCount(rows, NO_QUICK_FILTER, "local")).toBe(4); // everything but "done"
    expect(notMergedCount(rows, parseQuickFilter("?status=running"), "local")).toBe(1); // "run" only
    expect(notMergedCount(rows, parseQuickFilter("?pr=merged"), "local")).toBe(0); // only "done" matches pr=merged, and it's merged
    expect(notMergedCount(rows, toggleNotMerged(NO_QUICK_FILTER), "local")).toBe(4); // same count whether the toggle is on or off
  });
});

// ---- the page ----

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
const listed = () => [...container!.querySelectorAll<HTMLElement>('[data-slot="workstream-row"]')].map((r) => r.dataset.branch).sort();
// A filter dropdown's choices render in a popover (portaled to <body>) only while it is open.
const trigger = (group: string) => container!.querySelector<HTMLButtonElement>(`[data-slot="quick-filter-trigger"][data-group="${group}"]`)!;
const menu = () => document.querySelector<HTMLElement>('[data-slot="quick-filter-menu"]');
const chip = (key: string) => document.querySelector<HTMLElement>(`[data-slot="quick-filter"][data-chip="${key}"]`)!;
const box = (key: string) => chip(key).querySelector<HTMLButtonElement>('[role="checkbox"]')!;
const checked = (key: string) => box(key).getAttribute("aria-checked");
const count = (key: string) => chip(key).querySelector('[data-slot="quick-count"]')!.textContent;
const active = (group: string) => trigger(group).querySelector('[data-slot="quick-filter-active"]')?.textContent ?? "0";
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
const keyDown = async (key: string) => { await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); await flush(); }); };
/** Open one group's dropdown (closing any other first). */
async function openGroup(group: string) {
  if (menu()?.getAttribute("data-group") === group) return;
  if (menu()) await keyDown("Escape");
  await click(trigger(group));
  expect(menu()?.getAttribute("data-group")).toBe(group);
}

describe("quick filter chips on the Agents page", () => {
  beforeAll(() => store.configReady);
  afterEach(async () => {
    apiFake.reset();
    await act(async () => { await store.refresh(); });
    act(() => root?.unmount());
    container?.remove();
    root = container = undefined;
    const s = getDefaultStore();
    s.set(repoFilterAtom, "all"); s.set(instanceScopeAtom, "all"); s.set(agentQueryAtom, "");
    localStorage.clear();
    navigate("/");
  });

  const seed = () => {
    apiFake.prsData = [
      { number: 8, title: "Red CI", branch: "feat-ci", url: "u", state: "OPEN", isDraft: false, ciStatus: "failing", reviewStatus: "review_required", mergeable: "MERGEABLE", autoMergeEnabled: false },
      { number: 9, title: "Approved", branch: "feat-ok", url: "u", state: "OPEN", isDraft: false, ciStatus: "passing", reviewStatus: "approved", mergeable: "MERGEABLE", autoMergeEnabled: false },
    ];
    apiFake.agentsData = [
      { branch: "local-run", worktreePath: "/wt/local-run", agentStatus: "running" },
      { branch: "local-held", worktreePath: "/wt/local-held", agentStatus: "done", queued: 1 },
      { branch: "cloud-bot", worktreePath: "/wt/cloud-bot", agentStatus: "done", instance: "cloud", remote: true },
    ];
    apiFake.enrichmentData.set("r::cloud-bot", { title: "Bot work", orchestrated: true });
  };

  test("one dropdown per group: choices toggle and combine, each shows its count, and the URL holds the view", async () => {
    seed();
    await open("/agents");
    expect(listed()).toEqual(["cloud-bot", "feat-ci", "feat-ok", "local-held", "local-run"]);
    // One trigger per group; one repo, so no Repo dropdown; no mine/orchestrated/instance choices.
    const groups = [...container!.querySelectorAll('[data-slot="quick-filter-trigger"]')].map((g) => g.getAttribute("data-group"));
    expect(groups).toEqual(["state", "activity"]);
    expect(container!.querySelector('[data-slot="quick-filter"]')).toBeNull(); // closed: the choices are not on the page
    expect(active("state")).toBe("0");

    await openGroup("state");
    expect([...menu()!.querySelectorAll('[data-slot="quick-filter"]')].map((c) => c.getAttribute("data-chip")))
      .toEqual(["pr:open", "pr:verified", "pr:mergeable", "pr:merged", "pr:week", "notMerged"]);
    expect(chip("pr:merged").textContent).toContain("Merged today");
    expect(chip("pr:week").textContent).toContain("Merged this week");
    expect(chip("pr:merged").querySelector('[data-slot="status-dot"], [data-tone]')).not.toBeNull(); // the colored dot stays
    expect(checked("notMerged")).toBe("true"); // on by default
    expect(count("pr:open")).toBe("2");

    await openGroup("activity");
    expect(count("status:attention")).toBe("2"); // CI red + the held message
    expect(count("status:running")).toBe("1");
    await click(box("status:attention"));
    expect(checked("status:attention")).toBe("true");
    expect(menu()).not.toBeNull(); // a multi-select: it stays open
    expect(listed()).toEqual(["feat-ci", "local-held"]);
    expect(location.search).toBe("?status=attention");
    await click(box("status:running")); // same group → OR
    expect(listed()).toEqual(["feat-ci", "local-held", "local-run"]);
    expect(location.search).toBe("?status=attention,running");
    expect(active("activity")).toBe("2");

    await openGroup("state");
    await click(box("pr:open")); // another group → AND
    expect(listed()).toEqual(["feat-ci"]);
    expect(location.search).toBe("?status=attention,running&pr=open");
    expect(count("pr:mergeable")).toBe("0"); // counts follow the other groups' choices

    // The Activity dropdown's Clear clears only its own group.
    await openGroup("activity");
    await click(menu()!.querySelector('[data-slot="quick-filter-clear"]')!);
    expect(location.search).toBe("?pr=open");
    expect(listed()).toEqual(["feat-ci", "feat-ok"]);
    expect(active("activity")).toBe("0");
    expect(active("state")).toBe("1");
    await keyDown("Escape");
    await click(container!.querySelector('[data-slot="clear-filters"]')!);
    expect(location.search).toBe("");
    expect(listed()).toHaveLength(5);
  });

  test("a link using the retired by/on params still filters, though their pills are gone", async () => {
    seed();
    await open("/agents?by=orchestrated&on=cloud");
    expect(listed()).toEqual(["cloud-bot"]);
    expect(container!.querySelector('[data-chip^="by:"]')).toBeNull();
    expect(container!.querySelector('[data-chip^="on:"]')).toBeNull();
    // Back to plain /agents clears them (the query is part of where you are).
    await act(async () => { navigate("/agents"); await flush(); });
    expect(listed()).toHaveLength(5);
  });

  test("a stale repo value (a rename, e.g. orca-src → r) self-heals: dropped from the URL, rows reappear", async () => {
    seed();
    await open("/agents?repo=orca-src&status=running");
    // "orca-src" names no configured repo (only "r" exists): dropped once the repo list has loaded,
    // leaving the other chip untouched — the URL is replaced, not pushed (no extra history step).
    expect(location.search).toBe("?status=running");
    expect(listed()).toEqual(["local-run"]); // the stale repo value no longer hides every row
  });

  test("not merged: on by default with no URL param, togglable off, and a link round-trips it", async () => {
    seed();
    await open("/agents");
    expect(location.search).toBe(""); // on by default, so a plain URL
    await openGroup("state");
    expect(checked("notMerged")).toBe("true");
    expect(count("notMerged")).toBe("5"); // every seeded row is not merged
    expect(listed()).toHaveLength(5);

    await click(box("notMerged"));
    expect(checked("notMerged")).toBe("false");
    expect(location.search).toBe("?notMerged=0"); // off differs from the default, so it's carried
    expect(listed()).toHaveLength(5); // unaffected here: nothing merged in this seed
    expect(active("state")).toBe("1"); // off is a choice the trigger counts

    // The turned-off state is itself a link.
    await keyDown("Escape");
    await act(async () => { navigate("/agents?notMerged=0"); await flush(); });
    await openGroup("state");
    expect(checked("notMerged")).toBe("false");

    // The State dropdown's Clear restores the default (not merged back on).
    await click(menu()!.querySelector('[data-slot="quick-filter-clear"]')!);
    expect(location.search).toBe("");
    expect(checked("notMerged")).toBe("true");
  });

  test("the sidebar's instance scope narrows the list with no instance pills in the row (dropped with mine/orchestrated)", async () => {
    seed();
    getDefaultStore().set(instanceScopeAtom, "cloud");
    await open("/agents");
    expect(listed()).toEqual(["cloud-bot"]);
    expect(container!.querySelector('[data-chip^="on:"]')).toBeNull();
    expect(container!.querySelector('[data-chip^="by:"]')).toBeNull();
  });
});
