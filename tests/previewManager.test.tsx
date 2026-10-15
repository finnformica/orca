// E2E for the Previews page (views/Pages.PreviewsPage + PreviewControl.RunningPreviews) and its nav
// badge (PreviewControl.PreviewsBadge) — what the header's "Running previews" menu used to be: a
// count on the sidebar's Previews item, a list of each live preview labelled by its session title,
// and Open / Stop per preview. Driven against the fake api (tests/apiFake.ts) into a real DOM.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady); // cfg (repo "r") populated before the first render

const flush = () => new Promise((r) => setTimeout(r, 0));
const svc = (port: number) => ({ name: "web", port, url: `http://localhost:${port}`, open: true, running: true, ready: true, startedAt: 1 });

let root: Root | undefined;
let container: HTMLElement | undefined;
// The list polls api.previews on mount, so set apiFake.previewsData *before* mounting.
async function mount(path = "/previews") {
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });
}
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
const navItem = () => [...container!.querySelectorAll<HTMLElement>('nav[aria-label="Main"] button')].find((b) => b.textContent?.startsWith("Previews"))!;
const badge = () => navItem().querySelector("[data-slot='previews-badge']")!;
const list = () => container!.querySelector<HTMLElement>("[data-slot='running-previews']")!;

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
  localStorage.clear();
  navigate("/");
  await act(async () => { await store.refresh(); });
});

test("PM1 no previews: no badge, and the page says so", async () => {
  await mount();
  expect(badge().textContent).toBe(""); // no count
  expect(list().textContent).toBe("No previews running.");
});

test("PM2 the nav badge counts running previews; the page lists each by its session title, with Open + Stop", async () => {
  apiFake.worktrees.set("dark-mode", { branch: "dark-mode", worktreePath: "/wt/dark-mode" });
  apiFake.enrichmentData.set("r::dark-mode", { title: "Add dark mode" }); // titles come from the bridge
  await act(async () => { await store.refresh(); });
  apiFake.previewsData = [{ key: "/wt/dark-mode", svcs: [svc(5173)] }, { key: "/wt/other", instance: "cloud", svcs: [svc(5174)] }];
  await mount("/");
  // The badge rides the nav item on every page, not just on Previews.
  expect(badge().querySelector("[aria-label='2 running previews']")).toBeTruthy();
  await click(navItem());
  expect(location.pathname).toBe("/previews");
  const rows = [...list().querySelectorAll("[data-slot='running-preview']")].map((r) => r.textContent);
  expect(rows[0]).toContain("Add dark mode"); // labelled by the session title, not the raw path
  expect(rows[1]).toContain("other");         // adopted/base worktree with no card → last path segment
  expect(rows[1]).toContain("cloud");         // and where it runs
  expect([...list().querySelectorAll("button")].some((b) => b.textContent?.includes("Open"))).toBeTruthy();
});

test("PM4 unreachable endpoint: a distinct 'API unavailable' hint, no badge, not the empty state", async () => {
  apiFake.previewsError = "404"; // e.g. a self-preview whose bridge predates the /api/previews route
  await mount();
  expect(badge().textContent).toBe("");
  expect(list().textContent).toBe("Previews API unavailable — run the bridge on this branch.");
});

test("PM3 Stop tears the preview down and drops it from the list (and the badge) at once", async () => {
  apiFake.previewsData = [{ key: "/wt/solo", svcs: [svc(5173)] }];
  await mount();
  expect(badge().querySelector("[aria-label='1 running previews']")).toBeTruthy();
  apiFake.previewsData = []; // what the bridge answers once it's down
  await click(list().querySelector("button[aria-label='Stop preview']")!);
  expect(apiFake.calls).toContain("previewStop:/wt/solo"); // reaped via the same stop endpoint
  expect(list().textContent).toBe("No previews running.");
  expect(badge().querySelector("[aria-label='1 running previews']")).toBeFalsy();
});
