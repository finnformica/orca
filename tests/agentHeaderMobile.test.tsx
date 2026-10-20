// Mobile detail header (PR #6278 wrapped word-per-line beside the status + action icons): the
// title now gets its own row below md, with status/actions on a row under it (AgentPage.tsx
// AgentHeader); the tab bar's active highlight is a visible pill (ui/tabs.tsx), not a near-square
// 6px corner; and the PR page's header follows the same workstream-title precedence as the
// breadcrumb (PR 213's rowTitle), with the PR number kept as a link to GitHub.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { PrDetail } from "@/views/PrDetail";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;

async function mount(number: number) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<PrDetail repo="r" number={number} sub="overview" />); await flush(); await flush(); await flush(); });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
});

describe("agent header: title row splits from status/actions below md, tab pill radius, PR-title precedence", () => {
  test("the header shows the workstream's own title (not the PR's), with #N as a link to GitHub", async () => {
    apiFake.prsData = [{
      number: 90, branch: "fix-design-values", title: "fix: render design-value mentions as one live value", url: "https://github.com/o/r/pull/90",
      state: "OPEN", isDraft: false, ciStatus: "passing", reviewStatus: "review_required", mergeable: "MERGEABLE", autoMergeEnabled: false,
    }];
    apiFake.enrichmentData.set("r::fix-design-values", { title: "Magic text design values" });
    await store.refresh();
    apiFake.prDetailData = { number: 90, title: "fix: render design-value mentions as one live value", url: "https://github.com/o/r/pull/90", head: "fix-design-values" };
    await mount(90);

    const head = container!.querySelector('[data-slot="agent-header"]')!;
    const h1 = head.querySelector("h1")!;
    expect(h1.textContent).toContain("Magic text design values"); // the workstream title, not the PR's
    expect(h1.textContent).not.toContain("render design-value mentions");
    expect(h1.getAttribute("title")).toBeNull(); // no native hover box — a long title just truncates

    const link = h1.querySelector("a")!;
    expect(link.textContent).toBe("#90");
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/pull/90");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  test("the header has no Follow up button, and Verified sits immediately left of Actions", async () => {
    apiFake.prsData = [{
      number: 94, branch: "feat-head", title: "Header layout", url: "https://github.com/o/r/pull/94", head: "abc1234",
      state: "OPEN", isDraft: false, ciStatus: "passing", reviewStatus: "review_required", mergeable: "MERGEABLE", autoMergeEnabled: false,
    }];
    apiFake.enrichmentData.set("r::feat-head", { title: "Header layout", verified: { by: "user", at: new Date().toISOString(), sha: "abc1234", pr: 94 } });
    await store.refresh();
    apiFake.prDetailData = { number: 94, title: "Header layout", url: "https://github.com/o/r/pull/94", head: "feat-head" };
    await mount(94);

    const head = container!.querySelector('[data-slot="agent-header"]')!;
    expect(head.querySelector('button[aria-label="Follow up"]')).toBeNull();
    const actions = head.querySelector('button[aria-label="Actions"]')!;
    const verified = head.querySelector<HTMLElement>('[data-slot="verified-button"]')!;
    expect(verified.dataset.state).toBe("verified");
    expect(actions.previousElementSibling).toBe(verified.closest('[data-slot="tip"]')); // the Tip around it
  });

  test("a coworker's PR (no workstream) still shows the PR's own title", async () => {
    apiFake.prDetailData = { number: 91, title: "Someone else's change", url: "https://github.com/o/r/pull/91" };
    await mount(91);
    const h1 = container!.querySelector('[data-slot="agent-header"] h1')!;
    expect(h1.textContent).toContain("Someone else's change");
  });

  test("below md the title is its own row; status + actions sit together on the row under it", async () => {
    apiFake.prDetailData = { number: 92, title: "Any title" };
    await mount(92);
    const head = container!.querySelector('[data-slot="agent-header"]')!;
    expect(head.className).toContain("flex-col"); // stacked by default (below md)
    expect(head.className).toContain("md:flex-row"); // one row again at md+
    const h1 = head.querySelector("h1")!;
    expect(h1.querySelector("span.truncate")).not.toBeNull(); // one line, ellipsis — never wraps word-per-line
    const status = head.querySelector('[data-slot="agent-header-status"]')!;
    // Status (and actions) live in a sibling row, which collapses back beside the title at md+.
    expect(status.parentElement).not.toBe(h1);
    expect(status.parentElement!.className).toContain("md:contents");
  });

  test("the tab bar's active highlight is a full pill, not a near-square 6px corner", async () => {
    apiFake.prDetailData = { number: 93, title: "Any title" };
    await mount(93);
    const active = container!.querySelector('[role="tab"][data-state="active"]')!;
    expect(active.className).toContain("rounded-full");
  });
});
