// E2E for the Agents list's ⋯ bulk-actions menu: with the chips narrowed to one lane, one action
// applied to every row in it that can take it. The menu is state-gated (workstream.bulkActions) — items only appear when some card is eligible
// and each says how many it will hit — and running one fires the SAME per-card action per card.
// Driven against the fake api (tests/apiFake.ts), rendered into a real DOM. See views/BulkActions.tsx.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { Agents } from "@/views/Agents";
import { navigate } from "@/lib/route";
import { answer } from "./dialogs";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
// Radix opens menus on pointerdown, not click — drive it the way a pointer would.
const pointerdown = async (el: Element) => { await act(async () => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await flush(); await flush(); }); };
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };

const pr = (over: Record<string, unknown>) => ({
  number: 7, title: "feat", branch: "feat-x", url: "https://x/7", state: "OPEN", isDraft: false,
  ciStatus: "passing", reviewStatus: "commented", mergeable: "MERGEABLE", autoMergeEnabled: false, ...over,
});

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(path: string) {
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<Agents />); await flush(); });
  await act(async () => { await store.refresh(); await flush(); });
}

// Each mutating bulk verb asks first in the in-app AlertDialog; `answer` confirms it and records the question.
const confirmed: string[] = [];
const confirmIt = async () => { confirmed.push(await answer()); };
// Copy verbs are aggregate (one clipboard write per lane, not per card) — capture what they write.
const copied: string[] = [];
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { copied.push(t); } } });

afterEach(async () => {
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  confirmed.length = 0;
  copied.length = 0;
  localStorage.clear();
  navigate("/");
});

// The list's ⋯ bulk trigger, shown once the chips narrow to one lane.
const laneMenu = () => container!.querySelector<HTMLElement>('button[aria-label="Bulk actions"]');
const item = (text: string) => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim().startsWith(text))!;

describe("Agents list bulk actions", () => {
  test("no bulk menu until the chips narrow to one lane", async () => {
    apiFake.prsData = [pr({ reviewStatus: "approved" })];
    await mount("/agents");
    expect(laneMenu()).toBeNull();
  });

  test("Mergeable's Merge runs the per-card merge on every approved PR, behind an it-can't-be-undone confirm", async () => {
    apiFake.prsData = [pr({ reviewStatus: "approved" }), pr({ number: 8, branch: "feat-y", reviewStatus: "approved" })];
    await mount("/agents?pr=mergeable");
    await pointerdown(laneMenu()!);
    await click(item("Merge"));
    await confirmIt();
    expect(confirmed).toEqual(["Merge on 2 cards? — Run merge on 2 cards in mergeable. You cannot undo this."]);
    expect(apiFake.calls.filter((c) => c.startsWith("merge:"))).toEqual(["merge:7", "merge:8"]);
  });
});
