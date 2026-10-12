// E2E for persisted shell state (lib/persisted): the top bar's repo, the sidebar's instance scope and
// collapse, and the palette's recent items survive a reload under versioned `orca.ui.` keys; bad JSON
// or a wrong-typed value falls back to the default; a restored repo or instance that the config no
// longer has goes back to "all" once the config lands. A "reload" is a fresh jotai store — the atoms
// read localStorage on first use, exactly as on page load.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./apiFake";
import { createStore, getDefaultStore } from "jotai";
import * as store from "@/store";
import { App } from "@/App";
import { instanceScopeAtom, paletteRecentAtom, repoFilterAtom, sidebarCollapsedAtom } from "@/lib/atoms";
import { perRepo, persistedAtom, readPersisted, uiKey, usePersisted } from "@/lib/persisted";
import { navigate } from "@/lib/route";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);
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

describe("persisted UI state", () => {
  test("keys are versioned under orca.ui.; per-repo names carry the repo", () => {
    expect(uiKey("repoFilter")).toBe("orca.ui.repoFilter.v1");
    expect(uiKey("x", 2)).toBe("orca.ui.x.v2");
    expect(uiKey(perRepo("view", "r"))).toBe("orca.ui.view:r.v1");
  });

  test("default when absent; bad JSON and a wrong-typed value fall back", () => {
    expect(readPersisted(uiKey("t"), "all")).toBe("all");
    localStorage.setItem(uiKey("t"), "{not json");
    expect(readPersisted(uiKey("t"), "all")).toBe("all");
    localStorage.setItem(uiKey("t"), "42");
    expect(readPersisted(uiKey("t"), "all")).toBe("all");
    localStorage.setItem(uiKey("t"), "null");
    expect(readPersisted(uiKey("t"), false)).toBe(false);
    localStorage.setItem(uiKey("t"), JSON.stringify("x"));
    expect(readPersisted(uiKey("t"), [] as string[])).toEqual([]);
    // Every shell atom, from a fresh load over junk: its default.
    for (const name of ["repoFilter", "instanceScope", "sidebarCollapsed", "palette.recent"]) localStorage.setItem(uiKey(name), "}{");
    const fresh = createStore();
    expect(fresh.get(repoFilterAtom)).toBe("all");
    expect(fresh.get(instanceScopeAtom)).toBe("all");
    expect(fresh.get(sidebarCollapsedAtom)).toBe(false);
    expect(fresh.get(paletteRecentAtom)).toEqual([]);
    // A recent list holding a non-string is rejected whole.
    localStorage.setItem(uiKey("palette.recent"), JSON.stringify(["page:/", 3]));
    expect(createStore().get(paletteRecentAtom)).toEqual([]);
  });

  test("the four shell values restore on reload", () => {
    const before = createStore();
    before.set(repoFilterAtom, "r");
    before.set(instanceScopeAtom, "cloud");
    before.set(sidebarCollapsedAtom, true);
    before.set(paletteRecentAtom, ["page:/usage", "action:new"]);
    expect(localStorage.getItem(uiKey("sidebarCollapsed"))).toBe("true");
    const after = createStore(); // the reload
    expect(after.get(repoFilterAtom)).toBe("r");
    expect(after.get(instanceScopeAtom)).toBe("cloud");
    expect(after.get(sidebarCollapsedAtom)).toBe(true);
    expect(after.get(paletteRecentAtom)).toEqual(["page:/usage", "action:new"]);
  });

  test("a value saved under the pre-orca.ui. key is carried over", () => {
    localStorage.setItem("orca.sidebarCollapsed", "true");
    localStorage.setItem("orca.palette.recent", JSON.stringify(["action:help"]));
    const s = createStore();
    expect(s.get(sidebarCollapsedAtom)).toBe(true);
    expect(s.get(paletteRecentAtom)).toEqual(["action:help"]);
  });

  test("usePersisted is a shared, persisted useState", async () => {
    function Count({ id }: { id: string }) {
      const [n, setN] = usePersisted("test.count", 0);
      return <button type="button" data-id={id} onClick={() => setN(n + 1)}>{n}</button>;
    }
    localStorage.setItem(uiKey("test.count"), "4");
    await render(<><Count id="a" /><Count id="b" /></>);
    const btn = (id: string) => container!.querySelector<HTMLButtonElement>(`[data-id="${id}"]`)!;
    expect(btn("a").textContent).toBe("4");
    await act(async () => { btn("a").click(); await flush(); });
    expect(btn("b").textContent).toBe("5");
    expect(localStorage.getItem(uiKey("test.count"))).toBe("5");
    expect(createStore().get(persistedAtom("test.count", 0))).toBe(5);
  });

  test("a restored repo or instance that no longer exists falls back to all; a live one is kept", async () => {
    const s = getDefaultStore();
    s.set(repoFilterAtom, "gone-repo");
    s.set(instanceScopeAtom, "retired-box");
    await render(<App />);
    expect(s.get(repoFilterAtom)).toBe("all");
    expect(s.get(instanceScopeAtom)).toBe("all");
    expect(localStorage.getItem(uiKey("repoFilter"))).toBe(JSON.stringify("all"));
    act(() => root?.unmount());
    container?.remove();
    s.set(repoFilterAtom, "r");
    s.set(instanceScopeAtom, "cloud");
    await render(<App />);
    expect(s.get(repoFilterAtom)).toBe("r");
    expect(s.get(instanceScopeAtom)).toBe("cloud");
  });
});
