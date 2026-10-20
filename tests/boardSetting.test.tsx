// The Board view's visibility (#333 removed the board; this restores it behind a setting). The
// setting is `ui.showBoard` in the shared config document: on unless false. Server: the document
// parses and stores it, and Settings' setter keeps the rest of the document. UI (the fake api, a
// real DOM): the Board nav entry and /board show the lanes; the Settings switch hides both, and a
// board URL then falls back to the Agents view.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as db from "../server/db";
import { configDocument, invalidateConfig, loadConfig, parseConfigDocument, saveConfigDocument, setInstanceTerminal, setUiOptions } from "../server/config";
import { freshSchema } from "./pg";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";

test("BV1: ui.showBoard parses, is stored by Settings' setter, and the setter keeps the terminal flag", async () => {
  const doc = { repos: [{ name: "app", repoPath: "/tmp/app", worktreeRoot: "/tmp/app/.worktrees", baseBranch: "main" }], portRange: [30000, 40000], staleHours: 24 };
  expect(parseConfigDocument({ ...doc, ui: { showBoard: false } }).config!.ui).toEqual({ showBoard: false });
  expect(parseConfigDocument({ ...doc, ui: { showBoard: "no" } }).errors).toEqual(["ui must be { showBoard?: true | false }"]);
  expect(parseConfigDocument(doc).config!.ui).toBeUndefined(); // absent: the Board shows

  const prev = process.env.ORCA_DATABASE_URL;
  const pg = await freshSchema("showboard");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  invalidateConfig();
  try {
    await saveConfigDocument(parseConfigDocument(doc).config!);
    expect((await loadConfig()).ui).toBeUndefined();
    await setInstanceTerminal("box", true);
    await setUiOptions({ showBoard: false });
    invalidateConfig();
    let cfg = await loadConfig();
    expect(cfg.ui).toEqual({ showBoard: false });
    expect(cfg.terminal).toEqual({ box: true });
    // The stored document round-trips it, and the terminal setter keeps it.
    await setInstanceTerminal("box", false);
    invalidateConfig();
    cfg = await loadConfig();
    expect(cfg.ui).toEqual({ showBoard: false });
    expect(parseConfigDocument(await configDocument()).config!.ui).toEqual({ showBoard: false });
    await setUiOptions({ showBoard: true });
    invalidateConfig();
    expect((await loadConfig()).ui).toEqual({ showBoard: true });
  } finally {
    await db.close();
    await pg.drop();
    if (prev === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prev;
    invalidateConfig();
  }
});

// ---- the UI ----

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;

beforeAll(() => store.configReady);
afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  await store.setShowBoard(true); // one bun process: leave the config mirror as other files expect it
  apiFake.reset();
  localStorage.clear();
  navigate("/");
});

async function open(path: string) {
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
}
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); await flush(); await flush(); }); };
const navBoard = () => [...document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Main"] button')].find((b) => b.querySelector('[data-slot="nav-label"]')?.textContent?.trim() === "Board");
const lanes = () => [...document.querySelectorAll("h3")].map((h) => h.firstChild?.textContent?.trim());

test("BV2: on by default — the Board nav entry opens /board with the six lanes and the new-draft box", async () => {
  await open("/agents");
  expect(navBoard()).toBeDefined();
  await click(navBoard()!);
  expect(location.pathname).toBe("/board");
  expect(navBoard()!.getAttribute("aria-current")).toBe("page");
  expect(document.querySelector("h1")!.textContent).toBe("Board");
  expect(lanes().slice(0, 6)).toEqual(["Local", "Draft", "In Review", "Verified", "Mergeable", "Done · today"]);
  expect(document.querySelector('textarea[placeholder^="Describe a feature"]')).not.toBeNull();
  expect(document.querySelector('button[aria-label="Switch to dense view"]')).not.toBeNull();
});

test("BV3: the Settings switch hides the Board for every browser; a board URL then shows Agents", async () => {
  await open("/settings");
  const sw = document.querySelector<HTMLButtonElement>('[data-slot="show-board-switch"]')!;
  expect(sw.getAttribute("role")).toBe("switch");
  expect(sw.getAttribute("aria-checked")).toBe("true");
  expect(document.body.textContent).toContain("Board density");
  await click(sw);
  expect(apiFake.setShowBoardCalls).toEqual([false]);
  expect(sw.getAttribute("aria-checked")).toBe("false");
  expect(navBoard()).toBeUndefined();
  expect(document.body.textContent).not.toContain("Board density");

  await act(async () => { navigate("/board"); await flush(); await flush(); });
  expect(location.pathname).toBe("/agents");
  expect(document.querySelector("h1")!.textContent).toBe("Agents");

  // On again: the entry and the page come back.
  await act(async () => { navigate("/settings"); await flush(); });
  await click(document.querySelector('[data-slot="show-board-switch"]')!);
  expect(apiFake.setShowBoardCalls).toEqual([false, true]);
  expect(navBoard()).toBeDefined();
});
