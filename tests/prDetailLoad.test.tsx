// The PR page's load states (views/PrDetail.tsx). The page never waits on GitHub: the header, the
// tabs and the Chat tab render at once from the live workstream row (or, for a coworker's PR, from
// the URL). Only the parts that need the PR detail wait, and the Overview shows an inline note —
// loading, slow or failed — with a Retry that refetches. (It used to block the whole page on
// "Loading PR #N…", so a slow GitHub kept you out of the chat.)
import { afterEach, beforeAll, expect, test } from "bun:test";
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
afterEach(async () => {
  apiFake.releasePrDetail?.(); // a test that failed while the fetch was held must not hold the next one
  await act(async () => { root?.unmount(); });
  container?.remove();
  root = container = undefined;
  apiFake.reset();
});

async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); await flush(); });
}
const $ = (slot: string) => container!.querySelector(`[data-slot="${slot}"]`);
const tabs = () => [...container!.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
const retryButton = () => [...container!.querySelectorAll("button")].find((b) => b.textContent === "Retry");

// Your own PR: a live row on the board, so the page has branch, title, URL and status without GitHub.
async function seedLive(n: number, branch: string) {
  apiFake.agentsData = [{ branch, worktreePath: `/wt/${branch}`, agentStatus: "done" }];
  apiFake.prsData = [{
    number: n, branch, title: "Live title", url: `https://github.com/o/r/pull/${n}`,
    state: "OPEN", isDraft: false, ciStatus: "passing", reviewStatus: "review_required", mergeable: "MERGEABLE", autoMergeEnabled: false,
  }];
  await store.refresh();
}

test("a pending PR load: the header, the tabs and the Chat tab render at once from the live row", async () => {
  await seedLive(81, "feat-pending");
  apiFake.holdPrDetail = true; // GitHub has not answered
  await mount(<PrDetail repo="r" number={81} sub="chat" />);

  const header = $("agent-header")!;
  expect(header.textContent).toContain("#81");
  expect(header.textContent).toContain("Live title");
  expect(header.querySelector("a")?.getAttribute("href")).toBe("https://github.com/o/r/pull/81");
  expect($("agent-header-source")?.textContent).toContain("feat-pending");
  expect(tabs()).toEqual(["Overview", "Chat", "Files changed", "Preview"]);
  expect($("agent-chat")).not.toBeNull(); // the conversation, not a page-wide "Loading PR…"

  // Release GitHub: the Files count arrives, and nothing else changes.
  await act(async () => { apiFake.releasePrDetail!(); await flush(); await flush(); });
  expect(tabs()).toEqual(["Overview", "Chat", "Files changed (1)", "Preview"]);
  expect($("agent-chat")).not.toBeNull();
});

test("a pending PR load: the Overview shows the live Details card and an inline loading note", async () => {
  await seedLive(82, "feat-pending-ov");
  apiFake.holdPrDetail = true;
  await mount(<PrDetail repo="r" number={82} sub="overview" />);

  expect($("pr-loading")?.textContent).toContain("Loading PR #82 from GitHub");
  expect($("agent-details")).not.toBeNull(); // from the store, no wait
  expect($("pr-description")).toBeNull(); // needs the detail
  expect($("pr-checks")).toBeNull();

  apiFake.prDetailData = { body: "The description" };
  await act(async () => { apiFake.releasePrDetail!(); await flush(); await flush(); });
  expect($("pr-loading")).toBeNull();
  expect($("pr-description")?.textContent).toContain("The description");
  expect($("pr-checks")).not.toBeNull();
});

test("a failed PR load: an inline error with Retry on the Overview, and the Chat tab still works", async () => {
  await seedLive(77, "feat-failed");
  apiFake.prDetailError = "orca: gh timed out";
  await mount(<PrDetail repo="r" number={77} sub="overview" />);

  expect($("pr-error")?.textContent).toContain("Couldn't load PR #77: orca: gh timed out");
  expect($("agent-header")?.textContent).toContain("Live title"); // the page is not blocked
  expect($("agent-details")).not.toBeNull();
  expect(tabs()).toContain("Chat");

  apiFake.prDetailError = null; // GitHub recovered
  await act(async () => { retryButton()!.click(); await flush(); await flush(); });
  expect(apiFake.calls.filter((c) => c === "prDetail:77")).toHaveLength(2); // Retry refetched
  expect($("pr-error")).toBeNull();
  expect($("pr-description")).not.toBeNull();
});

test("a failed PR load on the Chat tab still shows the conversation", async () => {
  await seedLive(78, "feat-failed-chat");
  apiFake.prDetailError = "orca: gh timed out";
  await mount(<PrDetail repo="r" number={78} sub="chat" />);
  expect($("agent-chat")).not.toBeNull();
});

test("a coworker PR (no live row), pending: the header renders from the URL, the rest waits", async () => {
  await store.refresh(); // loaded, and #83 is not on the board
  apiFake.holdPrDetail = true;
  await mount(<PrDetail repo="r" number={83} sub="overview" />);

  expect($("agent-header")?.textContent).toContain("r /");
  expect($("agent-header")?.textContent).toContain("#83");
  expect($("pr-loading")).not.toBeNull();
  expect($("pr-details")).toBeNull();

  apiFake.prDetailData = { title: "Someone else's work", author: "alice", head: "their-branch" };
  await act(async () => { apiFake.releasePrDetail!(); await flush(); await flush(); });
  expect($("agent-header")?.textContent).toContain("Someone else's work");
  expect($("agent-header")?.querySelector("a")?.getAttribute("href")).toBe("https://example.test/83");
  expect($("pr-details")?.textContent).toContain("alice");
});

test("a coworker PR, failed: the inline error with Retry, under a header from the URL", async () => {
  await store.refresh();
  apiFake.prDetailError = "orca: gh timed out";
  await mount(<PrDetail repo="r" number={84} sub="overview" />);
  expect($("agent-header")?.textContent).toContain("#84");
  expect($("pr-error")?.textContent).toContain("Couldn't load PR #84");
  expect(retryButton()).toBeDefined();
});
