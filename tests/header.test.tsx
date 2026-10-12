// E2E for the header (App): the left-hand lockup is a monospace "Orca" wordmark beside an SVG orca
// mark, and "/" is the overview (List) by default, with a persisted List | Board toggle back to the
// five swimlanes. Driven against the fake api (tests/apiFake.ts), rendered into a real DOM.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./apiFake";
import { getDefaultStore } from "jotai";
import * as store from "@/store";
import { App } from "@/App";
import { boardViewAtom, densityAtom } from "@/lib/atoms";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  localStorage.clear();
  // The atoms outlive localStorage within one run: a dense board left behind here once made later
  // files' cards hide their prompt.
  getDefaultStore().set(boardViewAtom, "list");
  getDefaultStore().set(densityAtom, "comfortable");
});

const gridEl = () => container!.querySelector(".xl\\:grid-cols-5");
const btnByText = (label: string) =>
  [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); }); };

describe("header", () => {
  test("renders the overview (List) by default, not the kanban grid", async () => {
    await mount();
    expect(container!.querySelector('[data-slot="stat-tiles"]')).not.toBeNull();
    expect(container!.querySelector('[data-slot="workstream-list"]')).not.toBeNull();
    expect(gridEl()).toBeNull();
  });

  test("the wordmark is a monospace 'Orca' beside an SVG orca mark, linking home", async () => {
    await mount();
    const home = container!.querySelector('button[aria-label="Orca — go to board"]')!;
    expect(home).not.toBeNull();
    expect(home.querySelector("svg")).not.toBeNull(); // the orca mark
    const word = [...home.querySelectorAll("span")].find((s) => s.textContent?.trim() === "Orca")!;
    expect(word).not.toBeUndefined();
    expect(word.className).toContain("font-mono");
  });

  test("the List | Board toggle swaps the view and is remembered across a reload", async () => {
    await mount();
    expect(btnByText("List")!.getAttribute("aria-pressed")).toBe("true");
    expect(btnByText("Review")).toBeUndefined(); // the old third nav button stays gone
    await click(btnByText("Board")!);
    expect(gridEl()).not.toBeNull(); // the swimlanes
    expect(container!.querySelector('[data-slot="workstream-list"]')).toBeNull();
    expect(localStorage.getItem("orca.boardView")).toBe('"board"');
    // A fresh mount (a reload) keeps the choice.
    act(() => root?.unmount());
    container?.remove();
    await mount();
    expect(btnByText("Board")!.getAttribute("aria-pressed")).toBe("true");
    expect(gridEl()).not.toBeNull();
    await click(btnByText("List")!);
    expect(localStorage.getItem("orca.boardView")).toBe('"list"');
    expect(gridEl()).toBeNull();
  });

  test("the density toggle (Board view only) flips comfortable ⇄ dense (aria-pressed + persisted)", async () => {
    await mount();
    expect(container!.querySelector('button[aria-label^="Switch to"]')).toBeNull(); // List has no cards to densify
    await click(btnByText("Board")!);
    const toggle = container!.querySelector<HTMLButtonElement>('button[aria-label^="Switch to"]')!;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false"); // comfortable by default
    await act(async () => { toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("orca.density")).toBe('"dense"');
  });
});
