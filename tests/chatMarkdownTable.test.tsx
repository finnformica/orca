// A markdown table in a chat reply had no column minimum width, so a 4-5 column table squashed
// its columns unreadably thin on a phone or in the narrow popped-out orchestrator panel. The fix
// wraps every rendered table in a horizontally scrollable container (so a wide table scrolls
// sideways inside itself, never the page) and gives each cell a minimum width (so a column is
// never squeezed below a readable floor).
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;

async function mount(row: Row) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<ChatPanel row={row} />); await flush(); await flush(); });
}

const base: Row = {
  repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL",
  worktreePath: "/wt/feat", agentProvider: "claude",
};

const table = [
  "| Repo | Branch | Provider | State | Updated |",
  "| --- | --- | --- | --- | --- |",
  "| orca | main | claude | open | today |",
].join("\n");

beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  apiFake.reset();
});

test("a markdown table renders inside a horizontally scrollable wrapper with a minimum cell width", async () => {
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", prompt: "status?", response: table, finishedAt: 2 },
  ]);

  await mount(base);

  const tableEl = container!.querySelector("table");
  expect(tableEl).toBeTruthy();

  // The table sits in its own scroll container, not relying on the chat log or page to scroll.
  const wrapper = tableEl!.parentElement!;
  expect(wrapper.className).toContain("overflow-x-auto");
  expect(wrapper.className).toContain("max-w-full");

  // Every cell carries a minimum width so a column can't be squashed thinner than it.
  const th = tableEl!.querySelector("th")!;
  const td = tableEl!.querySelector("td")!;
  expect(th.className).toContain("min-w-32");
  expect(td.className).toContain("min-w-32");
});
