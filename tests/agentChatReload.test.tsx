// A reload on an agent page's Chat tab (views/PrDetail.tsx, views/LocalDetail.tsx). Finn: the Chat
// tab sometimes did not load, and a reload on it sometimes landed on Overview. On a reload the
// workstreams store has no rows yet, so the PR page read "no live row" as "not your PR": it hid the
// Chat trigger and showed Overview, and stayed there when the row never came (merged before today,
// archived). The page now keeps the URL's tab, shows a loading line until the store loads, then the
// conversation or why there is none.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { PrDetail } from "@/views/PrDetail";
import { LocalDetail } from "@/views/LocalDetail";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(async () => { await store.configReady; await store.refresh(); });

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(async () => {
  apiFake.releasePrs?.(); // a test that failed while the store was held must not hold the next one
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
const selectedTab = () => container!.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
async function waitFor(slot: string) {
  for (const until = Date.now() + 2_000; !$(slot) && Date.now() < until;) await act(async () => { await flush(); });
  return $(slot);
}

const seedPr = (n: number, branch: string) => {
  apiFake.agentsData = [{ branch, worktreePath: `/wt/${branch}`, agentStatus: "done" }];
  apiFake.prsData = [{
    number: n, branch, title: "My change", url: `https://github.com/o/r/pull/${n}`,
    state: "OPEN", isDraft: false, ciStatus: "passing", reviewStatus: "review_required", mergeable: "MERGEABLE", autoMergeEnabled: false,
  }];
  apiFake.prDetailData = { number: n, title: "My change", url: `https://github.com/o/r/pull/${n}`, head: branch };
};

test("reload on /prs/N/chat before the store loads: the Chat tab stays, with a loading line, then the conversation", async () => {
  store._resetWorkstreamsLoaded(); // the reload: no refresh has settled yet
  seedPr(51, "feat-reload");
  apiFake.holdPrs = true;
  const loading = store.refresh(); // fired, held on pollPrs until releasePrs()
  await mount(<PrDetail repo="r" number={51} sub="chat" />);

  expect(selectedTab()).toBe("Chat"); // not swapped to Overview
  expect($("chat-loading")?.textContent).toBe("Loading conversation…");
  expect($("pr-details")).toBeNull(); // the Overview content is not shown

  await act(async () => { apiFake.releasePrs!(); await loading; await flush(); });
  expect(await waitFor("agent-chat")).not.toBeNull();
  expect(selectedTab()).toBe("Chat");
  expect($("chat-loading")).toBeNull();
});

test("reload on /prs/N/chat after the store loads: the conversation shows at once", async () => {
  seedPr(52, "feat-loaded");
  await store.refresh();
  await mount(<PrDetail repo="r" number={52} sub="chat" />);
  expect(selectedTab()).toBe("Chat");
  expect(await waitFor("agent-chat")).not.toBeNull();
});

test("/prs/N/chat for a PR with no live row (merged before today, archived): the Chat tab says so, no silent swap", async () => {
  await store.refresh();
  apiFake.prDetailData = { number: 53, title: "Old work", head: "old-branch", state: "MERGED" };
  await mount(<PrDetail repo="r" number={53} sub="chat" />);
  expect(selectedTab()).toBe("Chat");
  expect($("chat-none")?.textContent).toContain("No agent conversation for this PR");
  expect($("agent-chat")).toBeNull();
});

test("reload on /local/<branch>/chat before the store loads: a loading line, not 'No local session'", async () => {
  store._resetWorkstreamsLoaded();
  apiFake.agentsData = [{ branch: "feat-local", worktreePath: "/wt/feat-local", agentStatus: "done" }];
  await mount(<LocalDetail repo="r" branch="feat-local" sub="chat" />); // no refresh fired yet

  expect($("local-loading")).not.toBeNull();
  expect(container!.textContent).not.toContain("No local session");

  await act(async () => { await store.refresh(); await flush(); });
  expect(await waitFor("agent-chat")).not.toBeNull();
  expect(selectedTab()).toBe("Chat");
});
