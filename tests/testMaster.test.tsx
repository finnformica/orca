// E2E for Test master — a row per repo on the Previews page (PreviewControl.TestMasterRow):
// launching a base-branch preview, reflecting its ready state, and surfacing a failed start as Retry
// + a Log popover trigger; and the sidebar's Previews badge that tracks it. Driven against the fake
// api (tests/apiFake.ts) into a real DOM.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { PreviewsBadge, TestMasterRow } from "@/views/PreviewControl";
import { navigate } from "@/lib/route";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady); // cfg (repo "r", base "main") populated before the first render

const flush = () => new Promise((r) => setTimeout(r, 0));

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<TestMasterRow repo="r" />); await flush(); });
}
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
const button = (label: string) => [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes(label));

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  await store.stopMaster("r"); // clear the module-level master-preview state + poll timer between tests
  apiFake.reset();
  localStorage.clear();
  await act(async () => { await store.refresh(); });
});

test("TM3 sidebar: Previews is a page with the badges; Add New is the last action, above you", async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });

  const sidebar = container.querySelector("[data-slot='sidebar']")!;
  const previews = [...sidebar.querySelectorAll('nav[aria-label="Main"] button')].find((b) => b.textContent?.startsWith("Previews"))!;
  expect(previews.querySelector("[data-slot='previews-badge']")).toBeTruthy();
  const profile = sidebar.querySelector("[data-slot='profile']")!;
  const addNew = sidebar.querySelector("[data-slot='add-new']")!;
  expect(addNew.compareDocumentPosition(profile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // Add New, then you
  // No preview buttons left in the foot or the top bar: the page holds Test master and the list.
  expect(container.querySelector("[aria-label='Test master']")).toBeNull();
  await act(async () => { navigate("/previews"); await flush(); await flush(); });
  expect(container.querySelector("[data-slot='test-master']")!.textContent).toContain("Test main");
  await act(async () => { navigate("/"); await flush(); });
});

test("TM1 test-master row: launches the base preview and opens once ready", async () => {
  apiFake.previewSvcs = [{ name: "web", port: 5173, url: "http://localhost:5173", open: true, running: true, ready: true, startedAt: 1 }];
  await mount();
  // Idle: offers to test the repo's base branch by name.
  expect(button("Test main")).toBeTruthy();

  await click(button("Test main")!);
  expect(apiFake.calls).toContain("previewMaster:r"); // hit the base-preview endpoint for this repo
  expect(button("Open main")).toBeTruthy();           // ready → surfaces the open link
});

test("TM2 test-master row: a failed start shows Retry + a Log popover trigger", async () => {
  apiFake.previewMasterError = "sh: nest: command not found";
  await mount();

  await click(button("Test main")!);
  expect(button("Retry main")).toBeTruthy();               // failed start drops back to a retry affordance…
  expect(button("Preview failed — show log")).toBeTruthy(); // …with the card-styled log trigger below it (opens a popover)
});

test("TM4 test-master row: survives the popover closing — no reset, no duplicate launch", async () => {
  apiFake.previewSvcs = [{ name: "web", port: 5173, url: "http://localhost:5173", open: true, running: true, ready: true, startedAt: 1 }];
  await mount();
  expect(button("Test main")).toBeTruthy();
  await click(button("Test main")!);
  expect(button("Open main")).toBeTruthy();
  const starts = () => apiFake.calls.filter((c) => c === "previewMaster:r").length;
  const launched = starts();

  // Closing the popover unmounts the row — but the preview lifecycle lives in the store, so the
  // detached preview keeps running and a reopened row re-reads it instead of resetting/relaunching.
  act(() => root!.unmount());
  await mount();
  expect(button("Open main")).toBeTruthy(); // still connected to the running preview
  expect(button("Test main")).toBeFalsy();  // NOT reset to the idle "launch" affordance
  expect(starts()).toBe(launched);          // no second base-preview launch
});

test("TM5 nav badge: spinner while a base preview boots, a dot once it's live", async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<PreviewsBadge />); await flush(); });
  const badge = () => container!.querySelector("[data-slot='previews-badge']")!;

  // Booting (running, not yet ready) → spinner.
  apiFake.previewSvcs = [{ name: "web", port: 5173, url: "http://localhost:5173", open: true, running: true, ready: false, startedAt: 1 }];
  await act(async () => { await store.startMaster("r"); await flush(); });
  expect(badge().querySelector(".animate-spin")).toBeTruthy();

  // Fully up → dot, no spinner.
  apiFake.previewSvcs = [{ name: "web", port: 5173, url: "http://localhost:5173", open: true, running: true, ready: true, startedAt: 1 }];
  await act(async () => { await store.startMaster("r"); await flush(); });
  expect(badge().querySelector(".animate-spin")).toBeFalsy();
  expect(badge().querySelector("[aria-label='a base preview is running']")).toBeTruthy();
});
