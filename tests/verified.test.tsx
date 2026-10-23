// The user's hand-set Verified marker (workstream.ts verifiedState / verifiedLane / prPill,
// store.setVerified, views/VerifiedButton.tsx): a PR the user tested moves from In review to its
// own Verified lane with a teal pill, has its own Agents chip, and a push after the test shows
// "Changed since verified" instead of a silent pass. It is enrichment only: no merge, no GitHub.
// The pure model first, then the Board and the Agents page against the fake api in a real DOM.
// The `orca status --verified` flag is O31 in tests/orchestrator.test.ts.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import {
  LANE_LABELS, NO_QUICK_FILTER, OVERVIEW_LANES, applyQuickFilter, lanePill, parseQuickFilter, prPill, quickFilterQuery,
  verifiedLane, verifiedMark, verifiedState, type OverviewRow,
} from "@/workstream";

describe("Verified marker (pure)", () => {
  test("the lane sits between In review and Mergeable, with its own teal pill", () => {
    expect(OVERVIEW_LANES).toEqual(["LOCAL", "DRAFT", "IN_REVIEW", "VERIFIED", "MERGEABLE", "DONE"]);
    expect(LANE_LABELS.VERIFIED).toBe("Verified");
    expect(lanePill("VERIFIED")).toEqual({ label: "Verified", tone: "teal" });
    const tones = OVERVIEW_LANES.map((l) => lanePill(l).tone);
    expect(new Set(tones.filter((t) => t !== "default")).size).toBe(tones.filter((t) => t !== "default").length); // distinct colour
  });

  test("a mark holds for the head it names; a new head commit or another PR reads as changed", () => {
    const mark = verifiedMark("user", "aaa", 7, "2026-10-20T10:00:00Z");
    expect(mark).toEqual({ by: "user", at: "2026-10-20T10:00:00Z", sha: "aaa", pr: 7 });
    expect(verifiedState(undefined, "aaa", 7)).toBeUndefined();
    expect(verifiedState(mark, "aaa", 7)).toBe("verified");
    expect(verifiedState(mark, "bbb", 7)).toBe("changed");
    expect(verifiedState(mark, "aaa", 8)).toBe("changed");
    expect(verifiedState(mark, undefined, 7)).toBe("verified"); // head not known yet: no false alarm
  });

  test("only an open, unapproved PR moves to Verified; Draft, Mergeable and Done keep their lane", () => {
    expect(verifiedLane("IN_REVIEW", "verified")).toBe("VERIFIED");
    expect(verifiedLane("IN_REVIEW", "changed")).toBe("IN_REVIEW");
    expect(verifiedLane("IN_REVIEW", undefined)).toBe("IN_REVIEW");
    for (const lane of ["DRAFT", "MERGEABLE", "DONE"] as const) expect(verifiedLane(lane, "verified")).toBe(lane);
  });

  test("the pill: Verified with who and when; a push after it is an amber Changed since verified that wins over auto-merge", () => {
    const mark = verifiedMark("user", "aaa1111", 7, new Date(Date.now() - 2 * 3_600_000).toISOString());
    const fresh = prPill({ lane: "VERIFIED", verified: mark, prHead: "aaa1111", prNumber: 7 });
    expect(fresh).toMatchObject({ label: "Verified", tone: "teal" });
    expect(fresh.tooltip).toBe("Verified by you 2h ago at aaa1111. Ask a coworker to approve it.");
    const changed = prPill({ lane: "IN_REVIEW", verified: mark, prHead: "bbb2222", prNumber: 7, autoMergeEnabled: true, ciStatus: "failing" });
    expect(changed).toMatchObject({ label: "Changed since verified", tone: "amber" });
    expect(changed.tooltip).toContain("New commits landed since (now bbb2222)");
    const byOrch = prPill({ lane: "VERIFIED", verified: { ...mark, by: "orchestrator" }, prHead: "aaa1111", prNumber: 7 });
    expect(byOrch.tooltip).toStartWith("Verified by the orchestrator, for you,");
  });

  test("the Verified chip matches only the Verified lane and survives the URL round-trip", () => {
    const row = (over: Partial<OverviewRow>): OverviewRow => ({ repo: "a", branch: "b", title: "t", lane: "IN_REVIEW", prNumber: 1, ...over });
    const rows = [row({ branch: "rev" }), row({ branch: "ver", lane: "VERIFIED" }), row({ branch: "ok", lane: "MERGEABLE" })];
    const f = { ...NO_QUICK_FILTER, pr: ["verified" as const] };
    expect(applyQuickFilter(rows, f).map((r) => r.branch)).toEqual(["ver"]);
    expect(quickFilterQuery(f)).toBe("?pr=verified");
    expect(parseQuickFilter("?pr=verified").pr).toEqual(["verified"]);
    expect(applyQuickFilter(rows, { ...NO_QUICK_FILTER, pr: ["open"] }).map((r) => r.branch)).toEqual(["rev", "ver", "ok"]);
  });
});

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
const close = () => { act(() => root?.unmount()); container?.remove(); root = container = undefined; };
const reload = async () => { await act(async () => { await store.refresh(); await flush(); await flush(); }); };
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
const laneOf = (title: string) => [...container!.querySelectorAll<HTMLElement>("[data-lane]")].find((l) => l.textContent?.includes(title))?.dataset.lane;
const button = () => container!.querySelector<HTMLButtonElement>('[data-slot="verified-button"]')!;
// The read-only badge beside the title (VerifiedBadge), on the Board card or the Agents row.
const badge = () => container!.querySelector<HTMLElement>('[data-slot="verified-badge"]');
const statePill = () => container!.querySelector('[data-slot="workstream-row"] [data-slot="state-pill"]')?.textContent;
// The Verified choice's count, in the State filter dropdown (opened first: its choices render only while open).
const chipCount = async () => {
  if (!document.querySelector('[data-slot="quick-filter-menu"]')) await click(container!.querySelector('[data-slot="quick-filter-trigger"][data-group="state"]')!);
  return document.querySelector('[data-chip="pr:verified"] [data-slot="quick-count"]')!.textContent;
};

const pr = (head: string) => ({
  number: 267, title: "Cache layer", branch: "feat-v", head, url: "u", state: "OPEN", isDraft: false,
  ciStatus: "passing", reviewStatus: "review_required", mergeable: "MERGEABLE", autoMergeEnabled: false,
});

describe("Verified marker on the Board and the Agents page", () => {
  beforeAll(() => store.configReady);
  afterEach(async () => {
    apiFake.reset();
    await reload();
    close();
    localStorage.clear();
    navigate("/");
  });

  test("set on the PR card, stored with who, when and head; a new head commit shows as changed; clear takes it off", async () => {
    apiFake.prsData = [pr("aaa1111")];
    await open("/board");
    expect(laneOf("Cache layer")).toBe("IN_REVIEW");
    expect(badge()).toBeNull();
    expect(button().dataset.state).toBe("none");
    expect(button().textContent).toBe("Verify");

    await click(button());
    const mark = apiFake.enrichmentData.get("r::feat-v")!.verified as Record<string, unknown>;
    expect(mark).toMatchObject({ by: "user", sha: "aaa1111", pr: 267 });
    expect(Date.parse(String(mark.at))).toBeGreaterThan(Date.now() - 60_000);
    expect(apiFake.calls.some((c) => /merge/i.test(String(c)))).toBe(false); // a marker only: no merge
    await reload();
    expect(laneOf("Cache layer")).toBe("VERIFIED");
    expect(button().textContent).toBe("Verified");
    expect(badge()?.getAttribute("aria-label")).toBe("Verified"); // icon only: no label text
    expect(badge()?.textContent).toBe("");
    expect(badge()!.closest('[data-slot="tip"]')!.previousElementSibling?.textContent).toBe("Cache layer"); // right after the title

    // A new commit lands on the PR: not a silent pass.
    apiFake.prsData = [pr("bbb2222")];
    await reload();
    expect(laneOf("Cache layer")).toBe("IN_REVIEW");
    expect(button().dataset.state).toBe("changed");
    expect(button().textContent).toBe("Changed since verified");
    expect(badge()).toBeNull(); // a mark on an older head is no badge
    close();

    await open("/agents");
    expect(statePill()).toBe("Changed since verified");
    expect(badge()).toBeNull();
    expect(await chipCount()).toBe("0");
    close();

    // Verify again at the new head, from the card.
    await open("/board");
    await click(button());
    expect(apiFake.enrichmentData.get("r::feat-v")!.verified).toMatchObject({ sha: "bbb2222" });
    await reload();
    expect(laneOf("Cache layer")).toBe("VERIFIED");
    close();

    await open("/agents?pr=verified");
    expect(statePill()).toBe("Verified");
    expect(await chipCount()).toBe("1");
    expect(container!.querySelectorAll('[data-slot="workstream-row"]')).toHaveLength(1);
    expect(badge()?.getAttribute("aria-label")).toBe("Verified"); // icon only: no label text
    expect(badge()?.textContent).toBe("");
    expect(badge()!.closest('[data-slot="tip"]')!.previousElementSibling?.textContent).toBe("Cache layer");
    close();

    // Clear: a click on a fresh mark takes it off.
    await open("/board");
    await click(button());
    expect(apiFake.enrichmentData.get("r::feat-v")).not.toHaveProperty("verified");
    await reload();
    expect(laneOf("Cache layer")).toBe("IN_REVIEW");
    expect(button().textContent).toBe("Verify");
  });

  test("a draft PR has no Verify button", async () => {
    apiFake.prsData = [{ ...pr("aaa1111"), isDraft: true }];
    await open("/board");
    expect(laneOf("Cache layer")).toBe("DRAFT");
    expect(container!.querySelector('[data-slot="verified-button"]')).toBeNull();
  });

  test("the Agents list's Verified pill shares the same pill classes (height, padding, font, icon size) as its siblings", async () => {
    const mark = verifiedMark("user", "aaa1111", 267, new Date().toISOString());
    apiFake.prsData = [pr("aaa1111"), { ...pr("bbb2222"), number: 268, branch: "feat-w", title: "Other work" }];
    apiFake.enrichmentData.set("r::feat-v", { verified: mark });
    await open("/agents");
    const verifiedPill = container!.querySelector<HTMLElement>('[data-branch="feat-v"] [data-slot="state-pill"]')!;
    const siblingPill = container!.querySelector<HTMLElement>('[data-branch="feat-w"] [data-slot="state-pill"]')!;
    expect(verifiedPill.textContent).toBe("Verified");
    expect(siblingPill.textContent).toBe("In review"); // a genuinely different state/tone, not a coincidence
    // Same component (console.tsx Pill), so these layout classes never diverge by tone.
    const SHARED = ["inline-flex", "h-6", "shrink-0", "items-center", "gap-1", "rounded-full", "px-2.5", "text-xs", "font-medium", "whitespace-nowrap"];
    const verifiedClasses = verifiedPill.className.split(/\s+/);
    const siblingClasses = siblingPill.className.split(/\s+/);
    for (const c of SHARED) {
      expect(verifiedClasses).toContain(c);
      expect(siblingClasses).toContain(c);
    }
  });
});
