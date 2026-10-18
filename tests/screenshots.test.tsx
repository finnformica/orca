// Screenshots in the UI: the agent page's Screenshots card lists every shot the workstream's turns
// reported (newest turn first, grouped by turn, each an ExpandableImage with its label and time),
// and a worker report in the chat draws its `Screenshots (Read to view):` paths as thumbnails.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import type { Row } from "@/store";
import { ScreenshotsCard } from "@/components/Screenshots";
import { ChatPanel } from "@/views/Chat";
import { WORKER_EVENT_MARKER } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); await flush(); });
}
beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(async () => { await act(async () => { root?.unmount(); }); container?.remove(); apiFake.reset(); });

const A = "shot-2026-10-15T10-00-00-000Z-aaaaaaaa-before";
const B = "shot-2026-10-15T11-00-00-000Z-bbbbbbbb-after";
const C = "shot-2026-10-15T12-00-00-000Z-cccccccc-mobile";
const at = (id: string) => `/home/orca/.orca/attachments/shots/${id}.png`;

test("S1: the Screenshots card — every reported shot, grouped by turn, newest first, as expandable thumbnails", async () => {
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", instruction: "build it", prompt: "", response: `shot: ${at(A)}\nshot: ${at(B)}`, startedAt: 1000, finishedAt: 2000 },
    { id: "run-2", provider: "claude", instruction: "no ui", prompt: "", response: "done", startedAt: 3000, finishedAt: 4000 },
    { id: "run-3", provider: "claude", instruction: "phone", prompt: "", response: "ok", structured: { outcome: "ok", verification: [`mobile: ${at(C)}`] }, startedAt: 5000, finishedAt: 6000 },
  ]);
  await mount(<ScreenshotsCard repo="r" branch="feat" />);
  const card = container!.querySelector<HTMLElement>('[data-slot="screenshots"]')!;
  expect(card.querySelector('[data-slot="card-header"]')!.textContent).toBe("Screenshots (3)");
  const groups = [...card.querySelectorAll<HTMLElement>('[data-slot="shot-turn"]')];
  expect(groups.map((g) => [...g.querySelectorAll("img")].map((i) => i.getAttribute("src")))).toEqual([
    [`/api/screenshots/${C}`],
    [`/api/screenshots/${B}`, `/api/screenshots/${A}`], // newest first within a turn too
  ]);
  const first = groups[1]!.querySelector<HTMLElement>('[data-slot="shot"]')!;
  expect(first.querySelector("img")!.getAttribute("alt")).toBe("after");
  expect(first.querySelector("figcaption")!.textContent).toStartWith("after");
  // The shared ExpandableImage: a click opens its lightbox.
  await act(async () => { first.querySelector<HTMLElement>('[data-slot="expandable-image"]')!.click(); await flush(); });
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
  expect(dialog).not.toBeNull();
  // The turn's two shots are one gallery: the index shows, and Right moves to the other shot.
  expect(dialog.querySelector('[data-slot="lightbox-index"]')!.textContent).toBe("1 / 2");
  await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); await flush(); });
  expect(dialog.querySelector("img")!.getAttribute("src")).toBe(`/api/screenshots/${A}`);
  expect(dialog.querySelector('[data-slot="lightbox-index"]')!.textContent).toBe("2 / 2");
});

test("S2: no shots reported → no card at all", async () => {
  apiFake.turnsData.set("r::plain", [{ id: "run-1", provider: "claude", instruction: "x", prompt: "", response: "no ui here", startedAt: 1, finishedAt: 2 }]);
  await mount(<ScreenshotsCard repo="r" branch="plain" />);
  expect(container!.querySelector('[data-slot="screenshots"]')).toBeNull();
});

test("S3: a worker report's screenshot paths render as thumbnails, not raw paths", async () => {
  const report = [`${WORKER_EVENT_MARKER} app/feat-ui "Banner" — done`, "Outcome: banner updated", "Screenshots (Read to view):", `- before: ${at(A)}`, `- after: ${at(B)}`, "Full turn: orca read --run run-9"].join("\n");
  const row: Row = { repo: "r", hasRemote: false, branch: "orch", title: "Orch", prompt: "", lane: "LOCAL", worktreePath: "/wt/orch", agentProvider: "claude" };
  apiFake.turnsData.set("r::orch", [{ id: "run-1", provider: "claude", instruction: report, prompt: "", response: "noted", startedAt: 1000, finishedAt: 1001, source: "agents" }]);
  await mount(<ChatPanel row={row} />);
  // The only turn is the newest answer, which is never folded into the agents block — so the
  // turn's own collapsed report block is what to open.
  expect(container!.querySelector('[data-slot="agents-marker"]')).toBeNull();
  await act(async () => { container!.querySelector<HTMLElement>('[data-slot="turn-reports"] button')!.click(); await flush(); });
  const reports = container!.querySelector<HTMLElement>('[data-slot="worker-reports"]')!;
  // The body is markdown, not a raw <pre> block — a report's own prose (and any table in it) renders
  // the same as the agent's own reply, not as unrendered text.
  expect(reports.querySelector("pre")).toBeNull();
  expect(reports.querySelector(".prose")!.textContent).toContain("Outcome: banner updated");
  expect(reports.querySelector(".prose")!.textContent).toContain("Full turn: orca read --run run-9");
  expect(reports.textContent).not.toContain("/attachments/shots/");
  expect([...reports.querySelectorAll('[data-slot="shot"] img')].map((i) => [i.getAttribute("src"), i.getAttribute("alt")]))
    .toEqual([[`/api/screenshots/${A}`, "before"], [`/api/screenshots/${B}`, "after"]]);
});
