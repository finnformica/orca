// The Agents page's quick filters (views/Agents.tsx, workstream.ts parseQuickFilter / applyQuickFilter
// / quickCount): one-click chips above the list, grouped into families — State (Open PRs, Mergeable,
// Merged today, Not merged), Activity (Running, Needs attention) and Repo (one per repo) — toggleable
// and combinable (AND across groups, OR within one), each with its count, and held in the URL query so
// a filtered view is a link. "Mine"/"Orchestrated" and per-instance pills were dropped (orchestrated
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
  NO_QUICK_FILTER, applyQuickFilter, attentionReasons, notMergedHiddenCount, parseQuickFilter, quickCount, quickFilterQuery, toggleNotMerged, toggleQuick, type OverviewRow,
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

  test("the notMerged chip's own count: merged rows it hides, under the other groups' chips", () => {
    expect(notMergedHiddenCount(rows, NO_QUICK_FILTER, "local")).toBe(1); // "done"
    expect(notMergedHiddenCount(rows, parseQuickFilter("?status=running"), "local")).toBe(0); // "done" isn't running
    expect(notMergedHiddenCount(rows, toggleNotMerged(NO_QUICK_FILTER), "local")).toBe(1); // same count whether on or off
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
const chip = (key: string) => container!.querySelector<HTMLButtonElement>(`[data-slot="quick-filter"][data-chip="${key}"]`)!;
const count = (key: string) => chip(key).querySelector('[data-slot="quick-count"]')!.textContent;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };

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

  test("chips toggle and combine, each shows its count, grouped into families, and the URL holds the view", async () => {
    seed();
    await open("/agents");
    expect(listed()).toEqual(["cloud-bot", "feat-ci", "feat-ok", "local-held", "local-run"]);
    const labels = [...container!.querySelectorAll('[data-slot="quick-filter"]')].map((c) => c.getAttribute("data-chip"));
    expect(labels).toEqual(["pr:open", "pr:mergeable", "pr:merged", "notMerged", "status:running", "status:attention"]); // one repo: no repo chips; no mine/orchestrated/instance pills
    // Grouped into families: State (the pr chips + not merged), Activity (status).
    const groups = [...container!.querySelectorAll('[data-slot="quick-filter-group"]')].map((g) => g.getAttribute("data-group"));
    expect(groups).toEqual(["state", "activity"]);
    expect(chip("pr:open").closest('[data-slot="quick-filter-group"]')!.getAttribute("data-group")).toBe("state");
    expect(chip("notMerged").closest('[data-slot="quick-filter-group"]')!.getAttribute("data-group")).toBe("state");
    expect(chip("status:running").closest('[data-slot="quick-filter-group"]')!.getAttribute("data-group")).toBe("activity");
    expect(chip("notMerged").getAttribute("aria-pressed")).toBe("true"); // on by default
    expect(count("status:attention")).toBe("2"); // CI red + the held message
    expect(count("status:running")).toBe("1");
    expect(count("pr:open")).toBe("2");

    await click(chip("status:attention"));
    expect(chip("status:attention").getAttribute("aria-pressed")).toBe("true");
    expect(listed()).toEqual(["feat-ci", "local-held"]);
    expect(location.search).toBe("?status=attention");
    await click(chip("status:running")); // same group → OR
    expect(listed()).toEqual(["feat-ci", "local-held", "local-run"]);
    expect(location.search).toBe("?status=attention,running");
    await click(chip("pr:open")); // another group → AND
    expect(listed()).toEqual(["feat-ci"]);
    expect(location.search).toBe("?status=attention,running&pr=open");
    expect(count("pr:mergeable")).toBe("0"); // counts follow the other groups' chips
    await click(chip("status:attention"));
    await click(chip("status:running"));
    expect(location.search).toBe("?pr=open");
    expect(listed()).toEqual(["feat-ci", "feat-ok"]);
    await click([...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Clear")!);
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

  test("not merged: on by default with no URL param, togglable off, and a link round-trips it", async () => {
    seed();
    await open("/agents");
    expect(location.search).toBe(""); // on by default, so a plain URL
    expect(chip("notMerged").getAttribute("aria-pressed")).toBe("true");
    expect(count("notMerged")).toBe("0"); // no merged rows seeded, but the chip still reports a count
    expect(listed()).toHaveLength(5);

    await click(chip("notMerged"));
    expect(chip("notMerged").getAttribute("aria-pressed")).toBe("false");
    expect(location.search).toBe("?notMerged=0"); // off differs from the default, so it's carried
    expect(listed()).toHaveLength(5); // unaffected here: nothing merged in this seed

    // The turned-off state is itself a link.
    await act(async () => { navigate("/agents?notMerged=0"); await flush(); });
    expect(chip("notMerged").getAttribute("aria-pressed")).toBe("false");

    await click([...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Clear")!);
    expect(location.search).toBe(""); // Clear restores the default (not merged back on)
    expect(chip("notMerged").getAttribute("aria-pressed")).toBe("true");
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
