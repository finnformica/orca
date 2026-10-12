// E2E for persisted shell state (lib/persisted): the top bar's repo, the sidebar's instance scope and
// collapse, and the palette's recent items survive a reload under versioned `orca.ui.` keys; bad JSON
// or a wrong-typed value falls back to the default; a restored repo or instance that the config no
// longer has goes back to "all" once the config lands. A "reload" is a fresh jotai store with the
// atoms mounted — mounting reads localStorage, exactly as on page load. (The helper's own key format
// and usePersisted are covered by tests/persistedState.test.tsx.)
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./apiFake";
import { createStore, getDefaultStore } from "jotai";
import * as store from "@/store";
import { App } from "@/App";
import { instanceScopeAtom, paletteRecentAtom, repoFilterAtom, sidebarCollapsedAtom } from "@/lib/atoms";
import { persistedKey, validChoice } from "@/lib/persisted";
import { navigate } from "@/lib/route";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);
const SHELL = [repoFilterAtom, instanceScopeAtom, sidebarCollapsedAtom, paletteRecentAtom] as const;
const reload = () => { const s = createStore(); for (const a of SHELL) s.sub(a, () => {}); return s; };
const flush = () => new Promise((r) => setTimeout(r, 0));

let root: Root | undefined;
let container: HTMLElement | undefined;
async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); await flush(); });
}

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  const s = getDefaultStore();
  s.set(repoFilterAtom, "all");
  s.set(instanceScopeAtom, "all");
  s.set(sidebarCollapsedAtom, false);
  s.set(paletteRecentAtom, []);
  localStorage.clear(); // after the resets, which write through
  await act(async () => navigate("/"));
});

describe("persisted shell state", () => {
  test("default when absent", () => {
    const s = reload();
    expect(s.get(repoFilterAtom)).toBe("all");
    expect(s.get(instanceScopeAtom)).toBe("all");
    expect(s.get(sidebarCollapsedAtom)).toBe(false);
    expect(s.get(paletteRecentAtom)).toEqual([]);
  });

  test("bad JSON or a wrong-typed value falls back to the default", () => {
    for (const name of ["repoFilter", "instanceScope", "sidebarCollapsed", "palette.recent"]) localStorage.setItem(persistedKey(name), "}{");
    let s = reload();
    expect(s.get(repoFilterAtom)).toBe("all");
    expect(s.get(instanceScopeAtom)).toBe("all");
    expect(s.get(sidebarCollapsedAtom)).toBe(false);
    expect(s.get(paletteRecentAtom)).toEqual([]);
    localStorage.setItem(persistedKey("repoFilter"), "42");
    localStorage.setItem(persistedKey("sidebarCollapsed"), JSON.stringify("yes"));
    localStorage.setItem(persistedKey("palette.recent"), JSON.stringify(["page:/", 3])); // rejected whole
    s = reload();
    expect(s.get(repoFilterAtom)).toBe("all");
    expect(s.get(sidebarCollapsedAtom)).toBe(false);
    expect(s.get(paletteRecentAtom)).toEqual([]);
  });

  test("the four shell values restore on reload, under orca.ui.v1. keys", () => {
    const before = reload();
    before.set(repoFilterAtom, "r");
    before.set(instanceScopeAtom, "cloud");
    before.set(sidebarCollapsedAtom, true);
    before.set(paletteRecentAtom, ["page:/usage", "action:new"]);
    expect(localStorage.getItem("orca.ui.v1.sidebarCollapsed")).toBe("true");
    const after = reload();
    expect(after.get(repoFilterAtom)).toBe("r");
    expect(after.get(instanceScopeAtom)).toBe("cloud");
    expect(after.get(sidebarCollapsedAtom)).toBe(true);
    expect(after.get(paletteRecentAtom)).toEqual(["page:/usage", "action:new"]);
  });

  test("a value saved under the pre-orca.ui. key is carried over", () => {
    localStorage.setItem("orca.sidebarCollapsed", "true");
    localStorage.setItem("orca.palette.recent", JSON.stringify(["action:help"]));
    const s = reload();
    expect(s.get(sidebarCollapsedAtom)).toBe(true);
    expect(s.get(paletteRecentAtom)).toEqual(["action:help"]);
  });

  test("validChoice keeps a live choice and the default, and drops a gone one", () => {
    expect(validChoice("r", ["r", "web"], "all")).toBe("r");
    expect(validChoice("all", [], "all")).toBe("all");
    expect(validChoice("gone", ["r"], "all")).toBe("all");
  });

  test("a restored repo or instance that no longer exists falls back to all; a live one is kept", async () => {
    const s = getDefaultStore();
    s.set(repoFilterAtom, "gone-repo");
    s.set(instanceScopeAtom, "retired-box");
    await render(<App />);
    expect(s.get(repoFilterAtom)).toBe("all");
    expect(s.get(instanceScopeAtom)).toBe("all");
    expect(localStorage.getItem(persistedKey("repoFilter"))).toBe(JSON.stringify("all"));
    act(() => root?.unmount());
    container?.remove();
    s.set(repoFilterAtom, "r");
    s.set(instanceScopeAtom, "cloud");
    await render(<App />);
    expect(s.get(repoFilterAtom)).toBe("r");
    expect(s.get(instanceScopeAtom)).toBe("cloud");
  });
});
