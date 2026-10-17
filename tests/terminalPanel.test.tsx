// The instance terminal's panel (components/InstanceTerminal.tsx): the pure tab state first, then the
// UI against the fake api in a real DOM — Settings → Instances (the Switch, Open terminal and its
// inline reason), the panel that opens like the orchestrator's and stays mounted while closed, tabs
// per session with + for a new one on a chosen machine, and the status dot with Reconnect. The socket
// is a recording fake: the test reads the URL each session dials (straight to its machine) and plays
// the server's open / close.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import { orchestratorOpenAtom, terminalPanelAtom } from "@/lib/atoms";
import {
  TERMINAL_PANEL_INITIAL, terminalCloseTab, terminalNewTab, terminalSelectTab, terminalSetOpen, terminalShowInstance, terminalTabLabels,
} from "@/workstream";

test("tab state: new, show (reuse), select, close hands over, the last close hides the panel", () => {
  let s = terminalNewTab(TERMINAL_PANEL_INITIAL, "cloud");
  expect(s).toEqual({ open: true, tabs: [{ id: "t1", instance: "cloud" }], active: "t1", next: 2 });
  s = terminalNewTab(s, "local");
  s = terminalNewTab(s, "cloud");
  expect(s.tabs.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  expect(terminalTabLabels(s.tabs)).toEqual({ t1: "cloud", t2: "local", t3: "cloud 2" });
  // Show a machine: its newest session, else a new one.
  expect(terminalShowInstance({ ...s, open: false }, "cloud")).toMatchObject({ open: true, active: "t3", tabs: s.tabs });
  expect(terminalShowInstance(s, "spare")).toMatchObject({ active: "t4", tabs: [...s.tabs, { id: "t4", instance: "spare" }] });
  expect(terminalSelectTab(s, "t2").active).toBe("t2");
  expect(terminalSelectTab(s, "nope")).toBe(s);
  // Closing the active tab hands over to its right neighbour, else its left.
  s = terminalSelectTab(s, "t2");
  expect(terminalCloseTab(s, "t2")).toMatchObject({ active: "t3", tabs: [{ id: "t1" }, { id: "t3" }] });
  expect(terminalCloseTab(terminalSelectTab(s, "t3"), "t3").active).toBe("t2");
  expect(terminalCloseTab(s, "t1").active).toBe("t2"); // not the active one: it stays
  // Hidden, the sessions stay; shown with none, nothing opens; the last close hides the panel.
  expect(terminalSetOpen(s, false)).toMatchObject({ open: false, tabs: s.tabs });
  expect(terminalSetOpen(TERMINAL_PANEL_INITIAL, true).open).toBe(false);
  const one = terminalNewTab(TERMINAL_PANEL_INITIAL, "cloud");
  expect(terminalCloseTab(one, "t1")).toMatchObject({ open: false, tabs: [], active: null });
});

// ---- the UI ----

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;

/** A WebSocket that dials nothing: it records its URL, and the test plays the server. */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; }
  serverOpen() { this.readyState = 1; this.onopen?.(); }
  serverClose(code: number, reason: string) { this.readyState = 3; this.onclose?.({ code, reason }); }
}
const g = globalThis as unknown as Record<string, unknown>;
const saved = { WebSocket: g.WebSocket };

beforeAll(async () => { g.WebSocket = FakeSocket; await store.configReady; });
afterAll(() => { g.WebSocket = saved.WebSocket; });
afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  getDefaultStore().set(terminalPanelAtom, TERMINAL_PANEL_INITIAL);
  getDefaultStore().set(orchestratorOpenAtom, false);
  FakeSocket.all = [];
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
const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const row = (m: string) => q(`[data-slot="instance-row"][data-instance="${m}"]`)!;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); await flush(); await flush(); }); };
const pointerdown = async (el: Element) => { await act(async () => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); await flush(); await flush(); }); };
/** Let the dynamic xterm import resolve and the session dial. */
const settle = async (until: () => boolean) => { for (let i = 0; i < 100 && !until(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
const panel = () => q('[data-slot="terminal-panel"]');
const tabs = () => [...document.querySelectorAll<HTMLElement>('[data-slot="terminal-tab"]')];

test("Settings → Instances: off by default with the reason inline; the Switch turns it on; Open terminal opens the panel on that machine", async () => {
  await open("/settings");
  expect([...document.querySelectorAll('[data-slot="instance-row"]')].map((r) => r.getAttribute("data-instance"))).toEqual(["cloud", "laptop"]);
  // Off by default: the Open button is disabled and the row says why — no hover box.
  const openBtn = () => row("cloud").querySelector<HTMLButtonElement>('[data-slot="terminal-open"]')!;
  expect(openBtn().disabled).toBe(true);
  expect(row("cloud").querySelector('[data-slot="terminal-blocked"]')!.textContent).toBe("Terminal is off");
  expect(row("cloud").querySelector("[title]")).toBeNull();
  // The shadcn Switch on the same row turns it on.
  const sw = row("cloud").querySelector<HTMLButtonElement>('[data-slot="terminal-switch"]')!;
  expect(sw.getAttribute("role")).toBe("switch");
  expect(sw.getAttribute("aria-checked")).toBe("false");
  await click(sw);
  expect(apiFake.setInstanceTerminalCalls).toEqual([{ instance: "cloud", on: true }]);
  expect(sw.getAttribute("aria-checked")).toBe("true");
  expect(openBtn().disabled).toBe(false);
  expect(row("cloud").querySelector('[data-slot="terminal-blocked"]')).toBeNull();
  expect(panel()).toBeNull(); // nothing mounted until a session opens

  // An open orchestrator gives way: one panel at a time on the right edge.
  getDefaultStore().set(orchestratorOpenAtom, true);
  await click(openBtn());
  expect(getDefaultStore().get(orchestratorOpenAtom)).toBe(false);
  expect(panel()!.dataset.state).toBe("open");
  expect(panel()!.getAttribute("aria-modal")).toBe("false");
  expect(panel()!.querySelector('[data-slot="terminal-resize"]')).not.toBeNull(); // the orchestrator's resize edge
  expect(tabs().map((t) => t.textContent)).toEqual(["cloud"]);
  expect(q('[data-slot="terminal-title"], #terminal-title')!.textContent).toBe("Terminal · cloud");

  // The socket goes STRAIGHT to cloud's own bridge (its configured address), never through this one.
  await settle(() => FakeSocket.all.length > 0);
  expect(FakeSocket.all).toHaveLength(1);
  expect(FakeSocket.all[0]!.url).toStartWith("ws://100.64.0.5:8787/api/terminal?instance=cloud&");
  const status = () => q('[data-slot="terminal-status"]')!.dataset.status;
  expect(status()).toBe("connecting");
  await act(async () => { FakeSocket.all[0]!.serverOpen(); await flush(); });
  expect(status()).toBe("connected");
  expect(tabs()[0]!.querySelector('[data-slot="status-dot"]')!.getAttribute("data-tone")).toBe("ready");

  // The server refuses (its reason is final): Closed, the reason, and a clear Reconnect.
  await act(async () => { FakeSocket.all[0]!.serverClose(4429, "cloud already has 2 terminal sessions — close one first"); await flush(); });
  expect(status()).toBe("closed");
  expect(q('[data-slot="terminal-closed"]')!.textContent).toContain("2 terminal sessions");
  await click(q('[data-slot="terminal-reconnect"]')!);
  await settle(() => FakeSocket.all.length > 1);
  expect(FakeSocket.all).toHaveLength(2);
  expect(status()).toBe("reconnecting");

  // Back off for the next test (the store's mirror outlives a test).
  await click(sw);
});

test("tabs: + opens another session on a chosen machine; the panel hides and comes back with its sessions; ✕ ends one", async () => {
  await open("/settings");
  for (const m of ["cloud", "laptop"]) await click(row(m).querySelector('[data-slot="terminal-switch"]')!);
  await click(row("cloud").querySelector('[data-slot="terminal-open"]')!);
  await settle(() => FakeSocket.all.length > 0);

  // + lists every machine; a pick opens a new tab there, labelled with its name.
  await pointerdown(q('[data-slot="terminal-new"]')!);
  const items = [...document.querySelectorAll<HTMLElement>('[data-slot="terminal-new-on"]')];
  expect(items.map((i) => i.dataset.instance)).toEqual(["cloud", "laptop"]);
  await click(items.find((i) => i.dataset.instance === "laptop")!);
  expect(tabs().map((t) => t.textContent)).toEqual(["cloud", "laptop"]);
  expect(tabs().map((t) => t.dataset.state)).toEqual(["inactive", "active"]);
  await settle(() => FakeSocket.all.length > 1);
  // This machine's shell: on the page's host at the bridge's port.
  expect(FakeSocket.all[1]!.url).toContain(`/api/terminal?instance=laptop&`);
  expect(FakeSocket.all[1]!.url).toContain(":8787/");
  // A second session on one machine is numbered.
  await pointerdown(q('[data-slot="terminal-new"]')!);
  await click([...document.querySelectorAll<HTMLElement>('[data-slot="terminal-new-on"]')].find((i) => i.dataset.instance === "cloud")!);
  expect(tabs().map((t) => t.textContent)).toEqual(["cloud", "laptop", "cloud 2"]);

  // Every session stays mounted; only the active one shows.
  const sessions = () => [...document.querySelectorAll<HTMLElement>('[data-slot="terminal-session"]')];
  expect(sessions().map((s) => s.getAttribute("aria-hidden"))).toEqual(["true", "true", "false"]);
  await click(tabs()[0]!.querySelector('[role="tab"]')!);
  expect(sessions().map((s) => s.getAttribute("aria-hidden"))).toEqual(["false", "true", "true"]);

  // Close the panel and move around the app: it slides out, its sessions keep running.
  await click(panel()!.querySelector('[aria-label="Close terminal panel"]')!);
  expect(panel()!.dataset.state).toBe("closed");
  await act(async () => { navigate("/agents"); await flush(); });
  expect(sessions()).toHaveLength(3);
  expect(FakeSocket.all.every((s) => s.readyState !== 3)).toBe(true);
  await act(async () => { navigate("/settings"); await flush(); await flush(); });
  await click(row("laptop").querySelector('[data-slot="terminal-open"]')!);
  expect(panel()!.dataset.state).toBe("open");
  expect(tabs().map((t) => t.dataset.state)).toEqual(["inactive", "active", "inactive"]); // laptop's existing session

  // ✕ ends that session's shell (its socket closes); the last one hides the panel.
  const laptopSocket = FakeSocket.all[1]!;
  await click(tabs()[1]!.querySelector('[aria-label="Close laptop"]')!);
  expect(laptopSocket.readyState).toBe(3);
  expect(tabs().map((t) => t.textContent)).toEqual(["cloud", "cloud 2"]);
  await click(tabs()[0]!.querySelector('[aria-label="Close cloud"]')!);
  expect(tabs().map((t) => t.textContent)).toEqual(["cloud"]); // the one left on cloud is plain "cloud" again
  await click(tabs()[0]!.querySelector('[aria-label="Close cloud"]')!);
  expect(panel()).toBeNull();

  for (const m of ["cloud", "laptop"]) await click(row(m).querySelector('[data-slot="terminal-switch"]')!);
});
