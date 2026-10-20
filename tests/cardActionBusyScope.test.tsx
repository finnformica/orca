// A click on Address PR (or any other quick action / menu action) used to disable the WHOLE card or
// row (WorkstreamActions/QuickActionButtons reported busy up to a card-level `onBusy`, which dimmed
// the Agents row and the Board card with `pointer-events-none opacity-60`). Finn wants only the
// clicked action disabled, with its own spinner — every other action, the card/row link, the chat and
// the menu stay usable. A second click on the SAME action while it's still running stays blocked.
// Driven against the real components and the fake api (tests/apiFake.ts, no network), rendered into a
// real DOM. See WorkstreamActions.tsx (Item's `busy` prop, the `busyActions` set keyed by action
// label) and Board.tsx's scoped `rerunning` state for the Play button.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import type { Row } from "@/store";
import { AgentRow } from "@/views/Agents";
import { WorkstreamCard } from "@/views/Board";
import { WorkstreamActions } from "@/views/WorkstreamActions";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);
beforeEach(() => store._resetReviewSignals());

const flush = () => new Promise((r) => setTimeout(r, 0));
const pointerdown = async (el: Element) => { await act(async () => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await flush(); await flush(); }); };
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); await flush(); });
}

afterEach(async () => {
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
});

const byAria = (label: string) => container!.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
const btn = (text: string) => [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const menuitem = (text: string) => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === text);

describe("card action busy scope", () => {
  test("Agents row: the Address PR quick action spins and disables only itself — the sibling quick action, the row and the ⋯ menu stay usable", async () => {
    apiFake.holdClaude = true; // block the launch so we can observe the in-flight state
    // A draft PR with failing CI offers BOTH quick actions together: Ready for review + Address PR.
    const row: Row = {
      repo: "r", hasRemote: true, branch: "feat", title: "Feat", prompt: "", lane: "IN_REVIEW",
      worktreePath: "/wt/feat", prNumber: 7, prUrl: "https://x/7", isDraft: true, ciStatus: "failing",
    };
    await mount(<AgentRow row={row} />);

    const address = byAria("Address PR")!;
    const ready = byAria("Ready for review")!;
    expect(address).not.toBeNull();
    expect(ready).not.toBeNull();

    await click(address);

    // Only the clicked action is busy: its own spinner, and it's disabled.
    expect(address.querySelector(".animate-spin")).not.toBeNull();
    expect((address as HTMLButtonElement).disabled).toBe(true);
    // The sibling quick action is untouched.
    expect(ready.querySelector(".animate-spin")).toBeNull();
    expect((ready as HTMLButtonElement).disabled).toBe(false);
    // The row itself carries no dimming — no pointer-events-none/opacity-60 class any more.
    const rowEl = container!.querySelector('[data-slot="workstream-row"]')!;
    expect(rowEl.className).not.toContain("pointer-events-none");
    expect(rowEl.className).not.toContain("opacity-60");

    // Another action (markReady) still runs while Address PR is in flight.
    await click(ready);
    expect(apiFake.calls).toContain("markReady:7");

    // The ⋯ menu is still usable too.
    const trigger = [...container!.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Actions")!;
    await pointerdown(trigger);
    expect(menuitem("Rename…")).not.toBeNull();
    await pointerdown(trigger); // close it back down

    // A second click on the SAME action, still busy, fires no second launch.
    await click(address);
    expect(apiFake.claudePrompts.length).toBe(1);

    // Releasing the launch clears the spinner.
    await act(async () => { apiFake.releaseClaude!(); await flush(); });
    expect(byAria("Address PR")!.querySelector(".animate-spin")).toBeNull();
    expect((byAria("Address PR")! as HTMLButtonElement).disabled).toBe(false);
  });

  test("Board card: the rerun (Play) button spins and disables only itself — Follow up and the title link stay usable", async () => {
    apiFake.holdClaude = true;
    const row: Row = {
      repo: "r", hasRemote: false, branch: "local-1", title: "Local work", prompt: "", lane: "LOCAL",
      worktreePath: "/wt/local-1",
    };
    await mount(<WorkstreamCard row={row} />);

    const play = container!.querySelector<HTMLButtonElement>('button[aria-label="Run"]')!;
    expect(play).not.toBeNull();
    await click(play);

    expect(play.querySelector(".animate-spin")).not.toBeNull();
    expect(play.disabled).toBe(true);
    // No card-wide overlay: Follow up stays enabled throughout.
    const followUp = btn("Follow up") as HTMLButtonElement | undefined;
    expect(followUp).not.toBeUndefined();
    expect(followUp!.disabled).toBe(false);

    // A second click while still running fires no second launch (the button is disabled).
    await click(play);
    expect(apiFake.claudePrompts.length).toBe(1);

    await act(async () => { apiFake.releaseClaude!(); await flush(); });
    expect(container!.querySelector('button[aria-label="Run"]')?.querySelector(".animate-spin")).toBeNull();
  });

  test("Actions menu: Address PR spins and disables only itself on reopen — Worktree path in the Copy submenu still runs", async () => {
    apiFake.holdClaude = true;
    let copied = "";
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: (t: string) => { copied = t; return Promise.resolve(); } },
    });
    const row: Row = {
      repo: "r", hasRemote: true, branch: "feat", title: "Feat", prompt: "", lane: "IN_REVIEW",
      worktreePath: "/wt/feat", prNumber: 7, prUrl: "https://x/7",
    };
    await mount(<WorkstreamActions row={row} />);

    const openPrSubmenu = async () => {
      await pointerdown([...container!.querySelectorAll("button")].find((b) => b.textContent?.includes("Actions"))!);
      const prTrigger = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "PR")!;
      await pointerdown(prTrigger);
      await click(prTrigger);
    };

    await openPrSubmenu();
    const address = menuitem("Address PR")!;
    expect(address).not.toBeNull();
    await click(address); // selecting an item closes the dropdown, by design

    // Reopen: the item itself now shows its own spinner and is disabled — a click re-fires nothing.
    await openPrSubmenu();
    const addressAgain = menuitem("Address PR")!;
    expect(addressAgain.querySelector(".animate-spin")).not.toBeNull();
    await click(addressAgain);
    expect(apiFake.claudePrompts.length).toBe(1); // still just the one launch

    // A different action, in a different submenu, is unaffected.
    const agentTrigger = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "Copy")!;
    await pointerdown(agentTrigger);
    await click(agentTrigger);
    await click(menuitem("Worktree path")!);
    expect(copied).toBe("/wt/feat");

    await act(async () => { apiFake.releaseClaude!(); await flush(); });
    await openPrSubmenu();
    expect(menuitem("Address PR")!.querySelector(".animate-spin")).toBeNull();
  });
});
