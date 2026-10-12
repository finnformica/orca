// The Agents page's quick filters (views/Agents.tsx, workstream.ts parseQuickFilter / applyQuickFilter
// / quickCount): one-click chips above the list — Needs attention, Running, Mine, Orchestrated, Open
// PRs, Mergeable, Merged today, per instance, per repo — toggleable and combinable (AND across groups,
// OR within one), each with its count, and held in the URL query so a filtered view is a link. The
// pure model first, then the page against the fake api (tests/apiFake.ts) in a real DOM.
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
  NO_QUICK_FILTER, applyQuickFilter, attentionReasons, parseQuickFilter, quickCount, quickFilterQuery, toggleQuick, type OverviewRow,
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
    expect(f).toEqual({ status: ["attention"], pr: ["merged"], by: ["orchestrated"], on: ["cloud"], repo: ["a", "b"] });
    expect(quickFilterQuery(f)).toBe("?status=attention&pr=merged&by=orchestrated&on=cloud&repo=a,b");
    expect(quickFilterQuery(NO_QUICK_FILTER)).toBe("");
    expect(parseQuickFilter(quickFilterQuery(f))).toEqual(f); // round-trips
  });

  test("chips combine: OR within a group, AND across groups; toggling twice is a no-op", () => {
    expect(names(parseQuickFilter("?status=running"))).toEqual(["run"]);
    expect(names(parseQuickFilter("?status=running,attention"))).toEqual(["run", "err", "ci"]); // OR
    expect(names(parseQuickFilter("?status=attention&by=orchestrated"))).toEqual(["err"]); // AND
    expect(names(parseQuickFilter("?pr=open"))).toEqual(["ci", "ok"]);
    expect(names(parseQuickFilter("?pr=mergeable,merged"))).toEqual(["ok", "done"]);
    expect(names(parseQuickFilter("?by=mine"))).toEqual(["run", "ci", "done"]);
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
    expect(quickCount(rows, f, "by", "mine", "local")).toBe(3); // its own group is ignored: what switching to it shows
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

  test("chips toggle and combine, each shows its count, and the URL holds the view", async () => {
    seed();
    await open("/agents");
    expect(listed()).toEqual(["cloud-bot", "feat-ci", "feat-ok", "local-held", "local-run"]);
    const labels = [...container!.querySelectorAll('[data-slot="quick-filter"]')].map((c) => c.getAttribute("data-chip"));
    expect(labels).toEqual(["status:attention", "status:running", "by:mine", "by:orchestrated", "pr:open", "pr:mergeable", "pr:merged", "on:laptop", "on:cloud"]); // one repo: no repo chips
    expect(count("status:attention")).toBe("2"); // CI red + the held message
    expect(count("status:running")).toBe("1");
    expect(count("by:orchestrated")).toBe("1");
    expect(count("pr:open")).toBe("2");
    expect(count("on:cloud")).toBe("1");

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
    expect(count("by:mine")).toBe("1"); // counts follow the other groups' chips
    await click(chip("status:attention"));
    await click(chip("status:running"));
    expect(location.search).toBe("?pr=open");
    expect(listed()).toEqual(["feat-ci", "feat-ok"]);
    await click([...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Clear")!);
    expect(location.search).toBe("");
    expect(listed()).toHaveLength(5);
  });

  test("a filtered view is a link: opening the URL applies its chips", async () => {
    seed();
    await open("/agents?by=orchestrated&on=cloud");
    expect(listed()).toEqual(["cloud-bot"]);
    expect(chip("by:orchestrated").getAttribute("aria-pressed")).toBe("true");
    expect(chip("on:cloud").getAttribute("aria-pressed")).toBe("true");
    expect(chip("on:laptop").getAttribute("aria-pressed")).toBe("false");
    // Back to plain /agents clears them (the query is part of where you are).
    await act(async () => { navigate("/agents"); await flush(); });
    expect(listed()).toHaveLength(5);
  });

  test("the sidebar's instance scope hides the instance chips (it already decides them)", async () => {
    seed();
    getDefaultStore().set(instanceScopeAtom, "cloud");
    await open("/agents");
    expect(listed()).toEqual(["cloud-bot"]);
    expect(container!.querySelector('[data-chip^="on:"]')).toBeNull();
  });
});
