// E2E for persisted UI state (lib/persisted): the helper's safe read / versioned keys first, then the
// Agents page's chips, search and sort surviving a reload — with the URL still
// the source of truth when it has a query, and Clear resetting both the URL and what's remembered.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { Agents } from "@/views/Agents";
import { agentQueryAtom, repoFilterAtom } from "@/lib/atoms";
import { navigate } from "@/lib/route";
import { oneOf, persistedKey, readPersisted, writePersisted } from "@/lib/persisted";
import { openTip } from "./tip";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

describe("persisted helper (pure)", () => {
  afterEach(() => localStorage.clear());

  test("versioned keys under orca.ui., per repo where repo-specific", () => {
    expect(persistedKey("agents.sort")).toBe("orca.ui.v1.agents.sort");
    expect(persistedKey("agents.filters", "web")).toBe("orca.ui.v1.agents.filters:web");
  });

  test("default when absent; the stored value round-trips", () => {
    const k = persistedKey("t");
    expect(readPersisted(k, "dflt")).toBe("dflt");
    writePersisted(k, { a: 1 });
    expect(readPersisted<unknown>(k, null)).toEqual({ a: 1 });
  });

  test("bad JSON and the wrong shape fall back to the default, never throw", () => {
    const k = persistedKey("t");
    localStorage.setItem(k, "{not json");
    expect(readPersisted(k, "dflt")).toBe("dflt");
    localStorage.setItem(k, JSON.stringify("sideways"));
    expect(readPersisted(k, "asc", oneOf("asc", "desc"))).toBe("asc");
    localStorage.setItem(k, JSON.stringify(42));
    expect(readPersisted(k, "asc", oneOf("asc", "desc"))).toBe("asc");
  });

  test("a legacy unversioned key is read when the new one is absent, and the new one wins once written", () => {
    localStorage.setItem("orca.sort", JSON.stringify("desc"));
    expect(readPersisted(persistedKey("sort"), "asc", oneOf("asc", "desc"), "orca.sort")).toBe("desc");
    writePersisted(persistedKey("sort"), "asc");
    expect(readPersisted(persistedKey("sort"), "asc", oneOf("asc", "desc"), "orca.sort")).toBe("asc");
  });

  test("a persisted atom falls back on a bad value after a reload", () => {
    localStorage.setItem(persistedKey("repoFilter"), "]]");
    const reloaded = createStore(); // a reload: mounting the atoms reads storage
    reloaded.sub(repoFilterAtom, () => {});
    expect(reloaded.get(repoFilterAtom)).toBe("all");
  });
});

// ---- the page ----

const flush = () => new Promise((r) => setTimeout(r, 0));
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
const type = async (input: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
});
let root: Root | undefined;
let container: HTMLElement | undefined;
async function open(path: string) {
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<Agents />); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
}
// A reload: the page goes away, the in-memory search resets, and /agents is opened again.
async function reload(path = "/agents") {
  act(() => root?.unmount());
  container?.remove();
  getDefaultStore().set(agentQueryAtom, "");
  await open(path);
}
afterEach(async () => {
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  const s = getDefaultStore();
  s.set(repoFilterAtom, "all"); s.set(agentQueryAtom, "");
  localStorage.clear();
  navigate("/");
});

const chip = (key: string) => container!.querySelector<HTMLButtonElement>(`[data-slot="quick-filter"][data-chip="${key}"]`)!;
const searchBox = () => container!.querySelector<HTMLInputElement>('input[aria-label="Search workstreams"]')!;
const saved = (repo = "all") => JSON.parse(localStorage.getItem(persistedKey("agents.filters", repo)) ?? "null");

describe("the Agents page remembers its filters", () => {
  test("chips + search restore on a bare /agents and are written into the URL", async () => {
    await open("/agents");
    await click(chip("status:running"));
    await click(chip("pr:open"));
    await type(searchBox(), "gauge");
    expect(location.search).toBe("?status=running&pr=open");
    expect(saved()).toEqual({ query: "?status=running&pr=open", q: "gauge" });

    await reload();
    expect(location.pathname + location.search).toBe("/agents?status=running&pr=open");
    expect(chip("status:running").getAttribute("aria-pressed")).toBe("true");
    expect(searchBox().value).toBe("gauge");
  });

  test("a URL with a query wins over what was saved (links still work), and becomes the saved state", async () => {
    writePersisted(persistedKey("agents.filters", "all"), { query: "?status=running", q: "old" });
    await open("/agents?pr=mergeable");
    expect(location.search).toBe("?pr=mergeable");
    expect(chip("pr:mergeable").getAttribute("aria-pressed")).toBe("true");
    expect(chip("status:running").getAttribute("aria-pressed")).toBe("false");
    expect(searchBox().value).toBe("");
    expect(saved()).toEqual({ query: "?pr=mergeable", q: "" });
  });

  test("Clear resets the chips, the search and what's remembered", async () => {
    await open("/agents?status=attention");
    await type(searchBox(), "x");
    await click(container!.querySelector('[data-slot="clear-filters"]')!);
    expect(location.search).toBe("");
    expect(searchBox().value).toBe("");
    expect(saved()).toEqual({ query: "", q: "" });
    await reload();
    expect(location.search).toBe("");
    expect(container!.querySelector('[data-slot="clear-filters"]')).toBeNull();
  });

  test("filters are per repo scope; bad JSON there falls back to no filters", async () => {
    writePersisted(persistedKey("agents.filters", "all"), { query: "?status=running", q: "" });
    localStorage.setItem(persistedKey("agents.filters", "r"), "{oops");
    getDefaultStore().set(repoFilterAtom, "r");
    await open("/agents");
    expect(location.search).toBe(""); // r's entry was garbage: nothing restored, nothing thrown
    expect(saved("r")).toEqual({ query: "", q: "" }); // and it is rewritten sane
    expect(saved("all")).toEqual({ query: "?status=running", q: "" }); // the other scope untouched
  });

  test("a stale repo value in a saved filter self-heals: dropped on restore, not brought back", async () => {
    // "orca-src" was a repo's old name (now "r") — a filter saved before the rename must not keep
    // hiding every row forever, since its chip can never render to untick it by hand.
    writePersisted(persistedKey("agents.filters", "all"), { query: "?repo=orca-src&status=running", q: "" });
    await open("/agents");
    expect(location.search).toBe("?status=running"); // dropped once the repo list has loaded
    expect(saved()).toEqual({ query: "?status=running", q: "" }); // rewritten clean
    await reload(); // the clean query is what the next session restores, not the stale one
    expect(location.search).toBe("?status=running");
  });

  test("sort restores from storage; an unknown value falls back to Last activity", async () => {
    writePersisted(persistedKey("agents.sort"), "title");
    await open("/agents");
    const trigger = container!.querySelector<HTMLElement>('[aria-label="Sort"]')!;
    expect(trigger.textContent).toContain("Title");
    expect(openTip(trigger).textContent).toBe("Sort: Title"); // full label readable on hover even when the value truncates
    // the value fills the remaining width and truncates instead of centering between the label and chevron
    expect(trigger.className).toContain("[&_[data-slot=select-value]]:flex-1");
    expect(trigger.className).toContain("[&_[data-slot=select-value]]:truncate");
    // the chevron is pinned right by its own margin, not by a justify-between that could re-centre
    // a label with no flex-grow of its own (ModelPicker's raw-children trigger has exactly that shape)
    expect(trigger.className).not.toContain("justify-between");
    expect(trigger.className).toContain("[&_svg]:ml-auto");
    writePersisted(persistedKey("agents.sort"), "nonsense");
    await reload();
    expect(container!.querySelector('[aria-label="Sort"]')!.textContent).toContain("Last activity");
  });
});
