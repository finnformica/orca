// Previews are placed by you, independent of where the session lives (store.testLocally + the
// card's Test control): a laptop short on CPU runs the preview on the box and opens it over the
// tailnet. The fake api has two instances (local = here, cloud).
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { PreviewControl } from "@/views/PreviewControl";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined; let container: HTMLElement | undefined;
async function mount(node: React.ReactNode) {
  container = document.createElement("div"); document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); await flush(); });
}
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
afterEach(async () => { await act(async () => { root?.unmount(); }); container?.remove(); apiFake.reset(); });

const HERE = "laptop"; // the fake config's own instance name (tests/apiFake.ts); the other is "cloud"
const localRow: store.Row = { repo: "r", hasRemote: true, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat" };
const cloudRow: store.Row = { ...localRow, branch: "cfeat", worktreePath: "/opt/wt/cfeat", instance: "cloud", remote: true };

test("a session's preview defaults to its own instance; the store sends that placement with the start", async () => {
  await store.testLocally(cloudRow);
  expect(apiFake.adoptCalls).toEqual([]); // its worktree is already on cloud
  expect(apiFake.previewCalls).toEqual([{ key: "/opt/wt/cfeat", instance: "cloud" }]);
  await store.testLocally(localRow);
  expect(apiFake.previewCalls.at(-1)).toEqual({ key: "/wt/feat", instance: HERE });
});

test("choosing the other instance adopts the branch there and starts the preview there", async () => {
  await store.testLocally(cloudRow, HERE);
  expect(apiFake.adoptCalls).toEqual([{ repo: "r", branch: "cfeat", instance: HERE }]); // a second worktree, here
  expect(apiFake.previewCalls).toEqual([{ key: "/wt/cfeat", instance: HERE }]);
});

test("the card's Test button names the target and offers the other instance", async () => {
  await mount(<PreviewControl row={localRow} />);
  const main = [...container!.querySelectorAll("button")].find((b) => b.textContent?.startsWith(`Test on ${HERE}`))!;
  expect(main).toBeTruthy();
  // Radix opens menus on pointerdown, not click — drive it the way a pointer would.
  const menu = container!.querySelector<HTMLButtonElement>('button[aria-label="Test on…"]')!;
  // The pair reads as one split button: inner corners squared, one shared border between them.
  expect(main.className).toContain("rounded-r-none");
  expect(menu.className).toContain("rounded-l-none");
  await act(async () => { menu.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await flush(); await flush(); });
  const cloud = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => /Test on cloud/.test(i.textContent ?? ""))!;
  expect(cloud).toBeTruthy();
  await click(cloud);
  expect(apiFake.previewCalls.at(-1)).toEqual({ key: "/wt/feat", instance: "cloud" });
});

// The placement lives on the SERVER (enrichment's `previewInstance`, written by the bridge that starts
// the preview): a refreshed page, or a phone, is just a view of it.
const startingSvc = { name: "frontend", port: 9001, url: "http://orca-box:9001", open: true, running: true, ready: false, startedAt: Date.now() };
function Card({ branch }: { branch: string }) {
  const row = store.useWorkstreams().find((r) => r.branch === branch);
  return row ? <PreviewControl row={row} /> : null;
}

test("a preview started elsewhere shows on a fresh page with no click, polled and stopped on its owner", async () => {
  // Another device pressed "Test on cloud" for the laptop's worktree: the box adopted its own checkout
  // and the bridge recorded where. This page never saw the click — it only has what the server says.
  apiFake.worktrees.set("feat", { branch: "feat", worktreePath: "/wt/feat" });
  apiFake.enrichmentData.set("r::feat", { title: "Feat", previewInstance: { instance: "cloud", key: "/opt/wt/feat", startedAt: new Date().toISOString() } });
  apiFake.previewSvcs = [startingSvc];
  await store.refresh(); // the hydrate a page load does
  await mount(<Card branch="feat" />);
  expect(apiFake.previewStatusCalls).toContainEqual({ key: "/opt/wt/feat", instance: "cloud" }); // the owner's key, on the owner
  expect(container!.querySelector('[aria-label="Starting…"]')).toBeTruthy(); // not the idle Test button
  await click(container!.querySelector('button[aria-label="Stop preview"]')!);
  expect(apiFake.previewStopCalls).toEqual([{ key: "/opt/wt/feat", instance: "cloud" }]);
  await act(async () => { await store.refresh(); });
  expect(store.enrichmentFor("r", "feat").previewInstance).toBeUndefined(); // cleared with the stop
});

test("starting records the placement server-side; it survives a re-hydrate and the stop targets it", async () => {
  apiFake.worktrees.set("feat", { branch: "feat", worktreePath: "/wt/feat" });
  await store.testLocally(localRow, "cloud");
  await store.refresh(); // the mirror is rebuilt from the server, not from this tab's memory
  expect(store.enrichmentFor("r", "feat").previewInstance).toMatchObject({ instance: "cloud", key: "/wt/feat" });
  await store.previewStatus("/wt/feat");
  expect(apiFake.previewStatusCalls.at(-1)).toEqual({ key: "/wt/feat", instance: "cloud" });
  await store.stopPreview("/wt/feat");
  expect(apiFake.previewStopCalls).toEqual([{ key: "/wt/feat", instance: "cloud" }]);
});
