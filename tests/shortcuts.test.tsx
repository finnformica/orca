// Keyboard shortcuts, the ⌘K command palette and "Ask the orchestrator" (components/CommandPalette,
// components/Terminal's AskOrchestrator, lib/shortcuts, lib/palette). The matcher and the ranking
// are pure and tested as such; then the whole App is driven in a real DOM against the fake api:
// keys open what they say — and never fire while you type in a field — the palette finds, ranks
// (recent first) and runs, and the top bar's entry opens the orchestrator with your text in it.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import {
  addNewOpenAtom, orchestratorOpenAtom, orchestratorPrefillAtom, paletteOpenAtom, shortcutsHelpOpenAtom, sidebarCollapsedAtom,
} from "@/lib/atoms";
import { isMacPlatform, isTypingTarget, matchShortcut, shortcutLabel } from "@/lib/shortcuts";
import { fuzzyScore, joinPrefill, moveSelection, pushRecent, rankPalette, type PaletteItem } from "@/lib/palette";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

describe("the shortcut matcher", () => {
  test("⌘ on a Mac, Ctrl elsewhere; letters only bare; ⌘K and Esc even while typing", () => {
    expect(matchShortcut({ key: "k", metaKey: true }, false, true)).toBe("palette");
    expect(matchShortcut({ key: "k", ctrlKey: true }, false, true)).toBeNull(); // Ctrl+K on a Mac is the line-kill, not ours
    expect(matchShortcut({ key: "k", ctrlKey: true }, false, false)).toBe("palette");
    expect(matchShortcut({ key: "K", metaKey: true }, true, true)).toBe("palette"); // in a text field too
    expect(matchShortcut({ key: "Escape" }, true, true)).toBe("escape");
    expect(matchShortcut({ key: "b", metaKey: true }, false, true)).toBe("sidebar");
    expect(matchShortcut({ key: "b", metaKey: true }, true, true)).toBeNull(); // ⌘B in a field is the field's
    expect(matchShortcut({ key: "c" }, false)).toBe("new");
    expect(matchShortcut({ key: "o" }, false)).toBe("orchestrator");
    expect(matchShortcut({ key: "f" }, false)).toBe("find");
    expect(matchShortcut({ key: "?", shiftKey: true }, false)).toBe("help");
    for (const key of ["c", "o", "f", "?"]) expect(matchShortcut({ key }, true)).toBeNull(); // never while typing
    expect(matchShortcut({ key: "c", metaKey: true }, false, true)).toBeNull(); // ⌘C is copy
    expect(matchShortcut({ key: "C", shiftKey: true }, false)).toBeNull();
    expect(matchShortcut({ key: "x" }, false)).toBeNull();
  });

  test("typing targets: fields, editable regions and anything inside a modal dialog", () => {
    const make = (html: string) => { const d = document.createElement("div"); d.innerHTML = html; document.body.append(d); return d; };
    const d = make('<input id="a"><textarea id="b"></textarea><div contenteditable="true" id="c"></div><dialog><button id="d"></button></dialog><button id="e"></button>');
    for (const id of ["a", "b", "c", "d"]) expect(isTypingTarget(d.querySelector(`#${id}`))).toBe(true);
    expect(isTypingTarget(d.querySelector("#e"))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    d.remove();
  });

  test("labels follow the platform", () => {
    expect(shortcutLabel("palette", true)).toBe("⌘K");
    expect(shortcutLabel("palette", false)).toBe("Ctrl+K");
    expect(shortcutLabel("sidebar", true)).toBe("⌘B");
    expect(shortcutLabel("orchestrator")).toBe("O");
    expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
    expect(isMacPlatform({ platform: "Linux x86_64" })).toBe(false);
  });
});

describe("palette ranking", () => {
  test("exact > prefix > word start > substring > scattered; no subsequence, no match", () => {
    const s = (q: string, t: string) => fuzzyScore(q, t)!;
    expect(s("agents", "Agents")).toBeGreaterThan(s("agents", "Agents list"));
    expect(s("age", "Agents")).toBeGreaterThan(s("age", "Manage agents"));
    expect(s("cache", "Add cache")).toBeGreaterThan(s("cache", "addcache"));
    expect(s("adc", "Add cache")).toBeGreaterThan(0);
    expect(s("ac", "Add cache")).toBeGreaterThan(s("ac", "xaxxxxxxc"));
    expect(fuzzyScore("zq", "Add cache")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  const items: PaletteItem[] = [
    { id: "page:/", group: "Pages", label: "Overview" },
    { id: "page:/usage", group: "Pages", label: "Usage" },
    { id: "page:/settings", group: "Pages", label: "Settings" },
    { id: "ws:r::feat", group: "Workstreams", label: "Add a cache", keywords: "r feat-cache" },
    { id: "ws:r::user", group: "Workstreams", label: "Users page", keywords: "r user-page" },
  ];
  test("no query: recent first (most recent first), then the rest in order", () => {
    expect(rankPalette(items, "", ["page:/settings", "ws:r::feat"]).map((i) => i.id))
      .toEqual(["page:/settings", "ws:r::feat", "page:/", "page:/usage", "ws:r::user"]);
  });
  test("a query: matches only, best first; keywords count; a recent item wins a tie", () => {
    expect(rankPalette(items, "us", []).map((i) => i.id)).toEqual(["page:/usage", "ws:r::user"]);
    expect(rankPalette(items, "feat-cache", []).map((i) => i.id)).toEqual(["ws:r::feat"]); // via its branch
    const twins: PaletteItem[] = [{ id: "a", group: "Pages", label: "Same" }, { id: "b", group: "Pages", label: "Same" }];
    expect(rankPalette(twins, "same", ["b"]).map((i) => i.id)).toEqual(["b", "a"]);
  });
  test("selection wraps; recents dedupe and cap; a prefill keeps the draft", () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, 1, 0)).toBe(0);
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
    expect(joinPrefill("", "hello")).toBe("hello");
    expect(joinPrefill("half a thought  ", "hello")).toBe("half a thought\nhello");
    expect(joinPrefill("draft", "")).toBe("draft");
  });
});

// ---- the App, end to end ----
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(path = "/") {
  navigate(path);
  await act(async () => { await store.refresh(); });
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });
}
afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
  localStorage.clear();
  const s = getDefaultStore();
  for (const a of [addNewOpenAtom, orchestratorOpenAtom, paletteOpenAtom, shortcutsHelpOpenAtom]) s.set(a, false);
  s.set(orchestratorPrefillAtom, null);
  s.set(sidebarCollapsedAtom, false);
  navigate("/");
  await act(async () => { await store.refresh(); });
});

const MOD = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
const press = async (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); await flush(); await flush(); });
};
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const dialogOpen = (slot: string) => q<HTMLDialogElement>(`[data-slot="${slot}"]`)!.open;
const panel = () => q('[data-slot="orchestrator-panel"]');
const find = () => q<HTMLInputElement>('input[aria-label="Find agents"]')!;
async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(); await flush();
  });
}

test("S1: C, O, ?, ⌘B and Esc work from the page — and never while typing in a field", async () => {
  await mount("/");
  // Typing in the Find box: the letters are text, not shortcuts.
  find().focus();
  for (const k of ["c", "o", "?"]) await press(find(), k);
  await press(find(), "b", MOD);
  expect(dialogOpen("add-new-dialog")).toBe(false);
  expect(panel()).toBeNull();
  expect(dialogOpen("shortcuts-help")).toBe(false);
  expect(q('[data-slot="sidebar"]')!.getAttribute("data-collapsed")).toBe("false");
  find().blur();

  await press(document.body, "c");
  expect(dialogOpen("add-new-dialog")).toBe(true);
  await act(async () => { q<HTMLDialogElement>('[data-slot="add-new-dialog"]')!.close(); await flush(); });
  expect(dialogOpen("add-new-dialog")).toBe(false);

  // O opens the orchestrator with its composer focused; Esc closes it.
  await press(document.body, "o");
  expect(panel()).not.toBeNull();
  expect(document.activeElement).toBe(panel()!.querySelector("textarea"));
  (document.activeElement as HTMLElement).blur();
  await press(document.body, "Escape");
  expect(panel()).toBeNull();

  // ⌘B collapses the sidebar and the choice is remembered.
  await press(document.body, "b", MOD);
  expect(q('[data-slot="sidebar"]')!.getAttribute("data-collapsed")).toBe("true");
  expect(localStorage.getItem("orca.ui.sidebarCollapsed.v1")).toBe("true");
  await press(document.body, "b", MOD);
  expect(q('[data-slot="sidebar"]')!.getAttribute("data-collapsed")).toBe("false");

  // ? lists every shortcut, with this platform's labels.
  await press(document.body, "?", { shiftKey: true });
  expect(dialogOpen("shortcuts-help")).toBe(true);
  const help = q('[data-slot="shortcuts-help"]')!.textContent!;
  for (const t of ["Command palette", shortcutLabel("palette"), "New agent", "Ask the orchestrator", "O", shortcutLabel("sidebar"), "Esc"]) expect(help).toContain(t);

  // The tooltips carry the keys too.
  expect(q('[data-slot="add-new"]')!.getAttribute("title")).toBe("Add New (C)");
  expect(q('button[aria-label="Collapse sidebar"]')!.getAttribute("title")).toBe(`Collapse sidebar (${shortcutLabel("sidebar")})`);
  expect(q('[data-slot="ask-orchestrator"]')!.getAttribute("title")).toContain("(O)");
});

test("S2: ⌘K opens the palette even from a text field, and toggles it shut", async () => {
  await mount("/");
  find().focus();
  await press(find(), "k", MOD);
  expect(dialogOpen("command-palette")).toBe(true);
  expect(document.activeElement).toBe(q('input[aria-label="Search commands"]'));
  await press(document.activeElement!, "k", MOD);
  expect(dialogOpen("command-palette")).toBe(false);
});

test("S3: the palette searches workstreams, PRs, pages and actions; arrows + Enter run one; recent comes first", async () => {
  apiFake.prsData = [
    { number: 9, title: "Approved thing", branch: "feat-ok", url: "u", state: "OPEN", isDraft: false, ciStatus: "passing", reviewStatus: "approved", mergeable: "MERGEABLE", autoMergeEnabled: false },
  ];
  apiFake.agentsData = [{ branch: "local-run", worktreePath: "/wt/local-run", agentStatus: "running" }];
  apiFake.enrichmentData.set("r::local-run", { title: "Add a cache" });
  await mount("/");
  const input = () => q<HTMLInputElement>('input[aria-label="Search commands"]')!;
  const options = () => [...document.querySelectorAll('[data-slot="command-palette"] [role="option"]')];
  const selected = () => q('[data-slot="command-palette"] [aria-selected="true"]')!.getAttribute("data-id");
  await press(document.body, "k", MOD);
  // Empty: everything is there — workstreams, the PR, pages and actions (incl. instance switching).
  const ids = options().map((o) => o.getAttribute("data-id"));
  for (const id of ["ws:r::local-run", "ws:r::feat-ok", "pr:r#9", "page:/", "page:/agents", "page:/usage", "page:/settings", "action:new", "action:orchestrator", "action:sidebar", "action:instance:cloud"]) expect(ids).toContain(id);

  await typeInto(input(), "cache");
  expect(options()[0]!.getAttribute("data-id")).toBe("ws:r::local-run");
  await typeInto(input(), "#9");
  expect(options()[0]!.getAttribute("data-id")).toBe("pr:r#9");
  // Arrows move (and wrap); Enter runs the selected one.
  await typeInto(input(), "settings");
  expect(selected()).toBe("page:/settings");
  await press(input(), "ArrowUp");
  expect(selected()).toBe(options().at(-1)!.getAttribute("data-id")); // wrapped to the last
  await press(input(), "ArrowDown");
  expect(selected()).toBe("page:/settings");
  await press(input(), "Enter");
  expect(location.pathname).toBe("/settings");
  expect(dialogOpen("command-palette")).toBe(false);

  // Reopened: what you just ran leads, under "Recent".
  await press(document.body, "k", MOD);
  expect(options()[0]!.getAttribute("data-id")).toBe("page:/settings");
  expect(q('[data-slot="palette-list"]')!.textContent!.startsWith("Recent")).toBe(true);
  // On a workstream's page it offers to start that workstream's preview.
  await press(input(), "Escape");
  await act(async () => { q<HTMLDialogElement>('[data-slot="command-palette"]')!.close(); await flush(); });
  await act(async () => { navigate("/r/prs/9"); await flush(); });
  await press(document.body, "k", MOD);
  await typeInto(input(), "start preview");
  expect(selected()).toBe("action:preview");
  expect(options()[0]!.textContent).toContain("Start preview: Approved thing");
});

test("S4: typed text with no match goes to the orchestrator, prefilled in its composer", async () => {
  await mount("/");
  await press(document.body, "k", MOD);
  // With matches, the ask is offered last, never above them.
  await typeInto(q<HTMLInputElement>('input[aria-label="Search commands"]')!, "usage");
  const all = [...document.querySelectorAll('[data-slot="command-palette"] [role="option"]')].map((o) => o.getAttribute("data-id"));
  expect(all[0]).toBe("page:/usage");
  expect(all.at(-1)).toBe("action:ask");
  await typeInto(q<HTMLInputElement>('input[aria-label="Search commands"]')!, "zzqx please");
  const opts = [...document.querySelectorAll('[data-slot="command-palette"] [role="option"]')];
  expect(opts.map((o) => o.getAttribute("data-id"))).toEqual(["action:ask"]);
  await press(q('input[aria-label="Search commands"]')!, "Enter");
  expect(panel()).not.toBeNull();
  const box = panel()!.querySelector("textarea")!;
  expect(box.value).toBe("zzqx please");
  expect(document.activeElement).toBe(box);
  expect(apiFake.orchestratorMessages).toEqual([]); // prefilled, not sent
});

test("S5: Ask the orchestrator is in the top bar of every page; typing in it continues in the composer, after any draft", async () => {
  for (const path of ["/", "/agents", "/usage", "/settings"]) {
    await mount(path);
    expect(q('header[data-slot="topbar"] [data-slot="ask-orchestrator"]')).not.toBeNull();
    act(() => root?.unmount()); container?.remove();
  }
  localStorage.setItem("orca.chat.@orca::orchestrator", JSON.stringify({ text: "earlier draft", images: [] }));
  await mount("/agents");
  const entry = q<HTMLInputElement>('input[aria-label="Ask the orchestrator"]')!;
  entry.focus();
  await typeInto(entry, "what is running?");
  expect(panel()).not.toBeNull();
  const box = panel()!.querySelector("textarea")!;
  expect(box.value).toBe("earlier draft\nwhat is running?");
  expect(document.activeElement).toBe(box);
  expect(entry.value).toBe(""); // the text moved, it isn't in two places
  // Clicking it while open just brings focus back to the composer, text intact.
  box.blur();
  await act(async () => { entry.click(); await flush(); });
  expect(document.activeElement).toBe(box);
  expect(box.value).toBe("earlier draft\nwhat is running?");
});
