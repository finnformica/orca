// E2E for the PR page's Overview, after Finn's list: the checks moved off their own tab onto
// Overview (between Review and Description), failing first, running next, the passing and skipped
// folded into ONE expandable line; and the PR conversation reads like GitHub's — a counts line,
// a jump to the first open thread, resolved / outdated threads as one line, long bodies clamped
// behind Show more, every bot comment in ONE folded row. The pure derivations (workstream.ts) are
// asserted directly; the page is rendered against the fake api.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { PrDetail } from "@/views/PrDetail";
import { checkDuration, checkGroups, checkSummary, conversationSummary, foldedChecksLabel, prConversation, type CheckRow } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);
const flush = () => new Promise((r) => setTimeout(r, 0));

const CHECKS: CheckRow[] = [
  ...Array.from({ length: 24 }, (_, i) => ({ name: `unit ${String(i).padStart(2, "0")}`, status: "passing" as const })),
  { name: "deploy", status: "passing", skipped: true },
  { name: "e2e", status: "pending", startedAt: "2026-10-13T10:00:00Z", completedAt: "0001-01-01T00:00:00Z" },
  { name: "lint", status: "failing", url: "https://ci/lint", startedAt: "2026-10-13T10:00:00Z", completedAt: "2026-10-13T10:01:05Z" },
  { name: "build", status: "failing" },
];

describe("checks: sorted by what needs you, the rest folded", () => {
  test("failing, then running, by name; passing and skipped apart; the summary and the folded label", () => {
    const g = checkGroups(CHECKS);
    expect(g.failing.map((c) => c.name)).toEqual(["build", "lint"]);
    expect(g.running.map((c) => c.name)).toEqual(["e2e"]);
    expect(g.passing).toHaveLength(24);
    expect(g.skipped.map((c) => c.name)).toEqual(["deploy"]);
    expect(checkSummary(g)).toBe("2 failing · 1 running · 24 passing · 1 skipped");
    expect(foldedChecksLabel(g)).toBe("24 passing, 1 skipped");
    expect(checkSummary(checkGroups([]))).toBe("No checks");
  });

  test("duration: finished = end − start; running counts to now; GitHub's year-1 placeholder is no time", () => {
    expect(checkDuration(CHECKS.find((c) => c.name === "lint")!)).toBe(65_000);
    expect(checkDuration(CHECKS.find((c) => c.name === "e2e")!, Date.parse("2026-10-13T10:00:30Z"))).toBe(30_000);
    expect(checkDuration({ name: "q", status: "pending", startedAt: "0001-01-01T00:00:00Z" })).toBeUndefined();
    expect(checkDuration({ name: "x", status: "passing" })).toBeUndefined();
  });
});

const LONG = Array.from({ length: 30 }, (_, i) => `QA step ${i}: looked fine`).join("\n");
const comments = [
  { author: "vercel[bot]", body: "Preview deployed", createdAt: "2026-10-13T09:00:00Z", bot: true },
  { author: "carol", body: "Can we split this?", createdAt: "2026-10-13T09:05:00Z", url: "https://gh/c1" },
  { author: "github-actions", body: "Billing notice: over budget", createdAt: "2026-10-13T09:06:00Z", bot: true },
  { author: "dave", body: LONG, createdAt: "2026-10-13T11:00:00Z" },
];
const reviews = [
  { author: "bob", state: "APPROVED", submittedAt: "2026-10-13T12:00:00Z" },
  { author: "erin", state: "COMMENTED", submittedAt: "2026-10-13T09:30:00Z" }, // only wraps inline threads — dropped
];
const threads = [
  { id: "T1", author: "erin", body: "Rename this", path: "a.ts", line: 3, resolved: true, createdAt: "2026-10-13T09:30:00Z" },
  { id: "T2", author: "erin", body: "Old line", path: "b.ts", line: 9, resolved: false, outdated: true, createdAt: "2026-10-13T09:31:00Z" },
  { id: "T3", author: "erin", body: "This leaks a handle", path: "c.ts", line: 1, resolved: false, createdAt: "2026-10-13T09:32:00Z" },
];

describe("the conversation: GitHub's order, folded", () => {
  test("chronological, bots split out, resolved / outdated threads collapsed, the first open thread the jump target", () => {
    const c = prConversation({ comments, reviews, threads });
    expect(c.entries.map((e) => e.id)).toEqual(["c1", "t:T1", "t:T2", "t:T3", "c3", "r0"]);
    expect(c.bots.map((b) => b.author)).toEqual(["vercel[bot]", "github-actions"]);
    expect(c.entries.filter((e) => e.kind === "thread" && e.collapsed).map((e) => e.id)).toEqual(["t:T1", "t:T2"]);
    expect(c.firstUnresolved).toBe("t:T3");
    expect(c.entries.find((e) => e.id === "c3")!.long).toBe(true);
    expect(c.entries.find((e) => e.id === "c1")!.long).toBe(false);
    expect(conversationSummary(c.counts)).toBe("3 comments · 3 threads (1 unresolved, 1 resolved, 1 outdated) · 2 bot");
    expect(conversationSummary(prConversation({ comments: [], reviews: [] }).counts)).toBe("No comments");
  });
});

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(sub: "overview" | "checks" = "overview") {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<PrDetail repo="r" number={70} sub={sub} />); await flush(); await flush(); await flush(); });
}
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
  store._resetReviewSignals();
});
const $ = (slot: string) => container!.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); }); };

describe("the PR page's Overview", () => {
  test("no Checks tab: the checks card sits before Review and Description, failing first, 24 passing folded into one line", async () => {
    apiFake.prDetailData = { checks: CHECKS, body: "The description" };
    await mount();
    expect([...container!.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Overview", "Files changed (1)", "Preview"]);
    const cards = [...container!.querySelectorAll("section[data-slot]")].map((s) => s.getAttribute("data-slot"));
    // Paired with Screenshots in a two-column grid (no screenshots here, so it's the grid's sole
    // child and spans both columns), ahead of Review and Description.
    expect(cards.indexOf("review-panel")).toBe(cards.indexOf("pr-checks") + 1);
    expect(cards.indexOf("pr-description")).toBe(cards.indexOf("review-panel") + 1);

    const card = $("pr-checks");
    expect($("checks-summary").textContent).toBe("2 failing · 1 running · 24 passing · 1 skipped");
    const rows = () => [...card.querySelectorAll('[data-slot="check"]')].map((r) => `${r.getAttribute("data-status")}:${r.querySelector("span")!.textContent}`);
    expect(rows()).toEqual(["failing:build", "failing:lint", "pending:e2e"]); // the passing ones are folded
    const lint = card.querySelectorAll('[data-slot="check"]')[1]!;
    expect(lint.textContent).toContain("1m 5s");
    expect(lint.querySelector<HTMLAnchorElement>('a[aria-label="Logs for lint"]')!.href).toBe("https://ci/lint");

    const fold = $("checks-folded");
    expect(fold.textContent).toBe("24 passing, 1 skipped");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    await click(fold);
    expect(rows()).toHaveLength(3 + 25);
    expect(rows().at(-1)).toBe("skipped:deploy"); // skipped last, behind the same expander
  });

  test("Screenshots and Checks sit in a two-column grid; Checks alone spans both columns with no screenshots", async () => {
    apiFake.prDetailData = { checks: CHECKS };
    await mount(); // PR head defaults to "sticky-1"; no turns recorded for it, so no Screenshots card
    const checks = $("pr-checks");
    const grid = checks.parentElement!;
    expect(grid.className).toContain("lg:grid-cols-2");
    expect([...grid.children]).toEqual([checks]); // the grid's only child, so it spans the row (:only-child)
    expect(container!.querySelector('[data-slot="screenshots"]')).toBeNull();
  });

  test("with screenshots, the Screenshots card and Checks sit side by side in that grid", async () => {
    apiFake.prDetailData = { checks: CHECKS };
    apiFake.turnsData.set("r::sticky-1", [{ id: "run-1", provider: "claude", instruction: "x", prompt: "", response: "shot: /home/orca/.orca/attachments/shots/shot-1.png", startedAt: 1, finishedAt: 2 }]);
    await mount();
    const checks = $("pr-checks");
    const shots = $("screenshots");
    expect(checks.parentElement).toBe(shots.parentElement); // the same grid, as siblings
    expect([...checks.parentElement!.children]).toEqual([shots, checks]);
  });

  test("an old /checks link lands on Overview", async () => {
    apiFake.prDetailData = { checks: CHECKS };
    await mount("checks");
    expect(container!.querySelector('[role="tab"][data-state="active"]')!.textContent).toBe("Overview");
    expect($("pr-checks")).not.toBeNull();
  });

  test("the conversation: counts line, jump to unresolved, bots in one folded row, closed threads on one line, long bodies clamped", async () => {
    apiFake.prDetailData = { comments, reviews };
    apiFake.reviewEvidenceData = threads;
    await mount();
    const conv = $("pr-conversation");
    expect($("conversation-summary").textContent).toBe("3 comments · 3 threads (1 unresolved, 1 resolved, 1 outdated) · 2 bot");

    // Bots: ONE folded row naming them, their bodies hidden until opened.
    const bots = conv.querySelector('[data-slot="bot-group"]')!;
    expect(bots.textContent).toContain("2 bot comments");
    expect(conv.textContent).not.toContain("Billing notice");
    await click(bots.querySelector("button")!);
    expect(conv.textContent).toContain("Billing notice");

    // Resolved and outdated threads are one line each; the open one is in full.
    const collapsed = [...conv.querySelectorAll('[data-slot="conversation-entry"][data-collapsed]')];
    expect(collapsed.map((c) => c.textContent)).toEqual([expect.stringContaining("Resolved"), expect.stringContaining("Outdated")]);
    expect(conv.querySelector("#conv-t\\:T3")!.hasAttribute("data-unresolved")).toBe(true);
    await click(collapsed[0]!.querySelector("button")!);
    expect(conv.querySelector("#conv-t\\:T1")!.hasAttribute("data-collapsed")).toBe(false); // expanded in place

    // A long body is clamped behind Show more.
    const long = conv.querySelector('[data-slot="comment-body"][data-clamped]')!;
    expect(long.textContent).toContain("QA step 0");
    await click(long.querySelector('[data-slot="show-more"]')!);
    expect(long.hasAttribute("data-clamped")).toBe(false);
    expect(long.querySelector('[data-slot="show-more"]')!.textContent).toBe("Show less");

    // The approval with no body is one line; the bare COMMENTED wrapper isn't shown at all.
    expect(conv.textContent).toContain("bobapproved");
    expect(conv.textContent).not.toContain("reviewed");

    // Jump scrolls the first open thread into view.
    let scrolled = "";
    const t3 = conv.querySelector<HTMLElement>("#conv-t\\:T3")!;
    t3.scrollIntoView = () => { scrolled = t3.id; };
    await click($("jump-unresolved"));
    expect(scrolled).toBe("conv-t:T3");
  });
});
