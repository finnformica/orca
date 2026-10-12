// E2E for the console shell (App + components/Shell): Vercel's left sidebar — the Orca mark with the
// instance switcher, Find, the nav (Overview, Agents, Repos, Usage, Settings), you at the foot and a
// persisted collapse — and a top bar with the breadcrumb. "/" is the Overview; Agents keeps the
// swimlanes behind a persisted List | Board toggle (with the density toggle beside it on Board).
// Driven against the fake api (tests/apiFake.ts), rendered into a real DOM.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./apiFake";
import { getDefaultStore } from "jotai";
import * as store from "@/store";
import { App } from "@/App";
import { agentQueryAtom, boardViewAtom, densityAtom, instanceScopeAtom, sidebarCollapsedAtom } from "@/lib/atoms";
import { navigate } from "@/lib/route";

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

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  localStorage.clear();
  // The atoms outlive localStorage within one run: a dense board left behind here once made later
  // files' cards hide their prompt.
  const s = getDefaultStore();
  s.set(boardViewAtom, "list");
  s.set(densityAtom, "comfortable");
  s.set(sidebarCollapsedAtom, false);
  s.set(instanceScopeAtom, "all");
  s.set(agentQueryAtom, "");
  await act(async () => navigate("/"));
});

const gridEl = () => container!.querySelector(".xl\\:grid-cols-5");
const btnByText = (label: string) =>
  [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const navItem = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>('nav[aria-label="Main"] button')].find((b) => b.textContent?.trim() === label)!;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); }); };
const crumb = () => container!.querySelector('nav[aria-label="Breadcrumb"]')!.textContent;

describe("console shell", () => {
  test("'/' is the Overview: usage, the agents snapshot, instances and recent activity — not the kanban grid", async () => {
    await mount();
    for (const slot of ["usage-card", "agents-card", "recent-activity"]) expect(container!.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    expect(container!.querySelector('[data-slot^="instance-"]')).not.toBeNull();
    expect(gridEl()).toBeNull();
    expect(crumb()).toContain("Overview");
    // The old header meter and health chip are gone: their numbers live in the cards now.
    expect(container!.querySelector("[aria-label='Claude usage limits']")).toBeNull();
    expect(container!.querySelector('[data-slot="instance-health"]')).toBeNull();
  });

  test("the sidebar: Orca mark + instance switcher, Find, the five pages, and the active one marked", async () => {
    await mount();
    const sidebar = container!.querySelector('[data-slot="sidebar"]')!;
    expect(sidebar.querySelector("svg")).not.toBeNull(); // the orca mark
    expect(sidebar.textContent).toContain("Orca");
    expect(sidebar.querySelector('[data-slot="instance-scope"]')!.textContent).toBe("All instances"); // two instances in the fake config
    expect(sidebar.querySelector('input[aria-label="Find agents"]')).not.toBeNull();
    const items = [...sidebar.querySelectorAll('nav[aria-label="Main"] button')].map((b) => b.textContent?.trim());
    expect(items).toEqual(["Overview", "Agents", "Repos", "Usage", "Settings"]);
    expect(navItem("Overview").getAttribute("aria-current")).toBe("page");
    for (const [label, path, slot] of [["Agents", "/agents", "workstream-list"], ["Repos", "/repos", "repos-list"], ["Usage", "/usage", "usage-card"], ["Settings", "/settings", "settings-appearance"]] as const) {
      await click(navItem(label));
      expect(location.pathname).toBe(path);
      expect(navItem(label).getAttribute("aria-current")).toBe("page");
      expect(crumb()).toContain(label);
      expect(container!.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    }
  });

  test("the instance switcher scopes the pages to one machine, and remembers it", async () => {
    await mount();
    getDefaultStore().set(instanceScopeAtom, "cloud");
    await act(flush);
    expect(container!.querySelector('[data-slot="instance-scope"]')!.textContent).toBe("cloud");
    // The Overview now shows that machine's card only.
    expect(container!.querySelector('[data-slot="instance-cloud"]')).not.toBeNull();
    expect(container!.querySelector('[data-slot="instance-laptop"]')).toBeNull();
    expect(localStorage.getItem("orca.instanceScope")).toBe('"cloud"');
  });

  test("Find: typing filters the Agents list (going there), and 'F' focuses it from anywhere", async () => {
    await mount();
    const find = container!.querySelector<HTMLInputElement>('input[aria-label="Find agents"]')!;
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
      await flush();
    });
    expect(document.activeElement).toBe(find);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(find, "gauge");
      find.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    expect(location.pathname).toBe("/agents");
    expect(container!.querySelector<HTMLInputElement>('input[aria-label="Search workstreams"]')!.value).toBe("gauge"); // one query, shared
  });

  test("the sidebar's foot: the profile button has room for its two lines; collapsed, it stacks so the toggle can't overlap", async () => {
    await mount();
    const profile = container!.querySelector<HTMLElement>('[data-slot="profile"]')!;
    expect(profile.className).toContain("min-h-11"); // two lines (13px + 12px) never touch its edges
    expect(profile.textContent).toContain("You");
    const foot = () => container!.querySelector<HTMLElement>('[data-slot="sidebar-foot"]')!;
    expect(foot().className).not.toContain("flex-col");
    await click(container!.querySelector('button[aria-label="Collapse sidebar"]')!);
    expect(foot().className).toContain("flex-col"); // avatar above the expand button, one column
    expect(container!.querySelector<HTMLElement>('[data-slot="sidebar-actions"]')!.className).toContain("flex-col");
    // Add New is still there, as an icon.
    expect(container!.querySelector('[data-slot="sidebar"] [data-slot="add-new"]')!.getAttribute("aria-label")).toBe("Add New");
  });

  test("the sidebar collapses to icons and stays collapsed across a reload", async () => {
    await mount();
    await click(container!.querySelector('button[aria-label="Collapse sidebar"]')!);
    expect(container!.querySelector('[data-slot="sidebar"]')!.getAttribute("data-collapsed")).toBe("true");
    expect(localStorage.getItem("orca.sidebarCollapsed")).toBe("true");
    act(() => root?.unmount());
    container?.remove();
    await mount();
    expect(container!.querySelector('button[aria-label="Expand sidebar"]')).not.toBeNull();
  });

  test("Agents: the List | Board toggle swaps the view and is remembered across a reload", async () => {
    navigate("/agents");
    await mount();
    expect(btnByText("List")!.getAttribute("aria-pressed")).toBe("true");
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
    navigate("/agents");
    await mount();
    expect(container!.querySelector('button[aria-label^="Switch to"]')).toBeNull(); // the list has no cards to densify
    await click(btnByText("Board")!);
    const toggle = container!.querySelector<HTMLButtonElement>('button[aria-label^="Switch to"]')!;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false"); // comfortable by default
    await act(async () => { toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("orca.density")).toBe('"dense"');
  });
});
