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
