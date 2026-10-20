// The repo badge (components/console.tsx RepoBadge, workstream.ts repoBadgeTone): a small pill
// beside a workstream's title — the Agents rows (desktop and stacked/phone), the Board card — in
// place of the old separate repo text/column (Board's Eyebrow, the Agents subline's "repo" item).
// Its colour is a stable hash of the repo name, from a fixed pastel palette. The pure model first,
// then its position against the fake api in a real DOM.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import { REPO_BADGE_TONES, repoBadgeTone, repoBadgeToneIndex } from "@/workstream";
import { NARROW_QUERY } from "@/lib/viewport";

describe("repo badge colour (pure)", () => {
  test("the same name always gets the same tone; the index stays inside the fixed palette", () => {
    for (const name of ["orca", "branch-demo", "a", "", "Orca", "a-very-long-repo-name-indeed"]) {
      const i = repoBadgeToneIndex(name);
      expect(i).toBe(repoBadgeToneIndex(name)); // stable across calls
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(REPO_BADGE_TONES.length);
      expect(repoBadgeTone(name)).toBe(REPO_BADGE_TONES[i]!);
    }
  });

  test("two different names usually land on different tones (a handful of real repo names spread out)", () => {
    const names = ["orca", "branch-demo", "site-templates", "chorus-server", "finnformica"];
    const tones = new Set(names.map(repoBadgeToneIndex));
    expect(tones.size).toBeGreaterThan(1); // not every name hashing to the same slot
  });
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function open(path: string) {
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
}
const close = () => { act(() => root?.unmount()); container?.remove(); root = container = undefined; };

const pr = (over: Record<string, unknown> = {}) => ({
  number: 11, title: "Repo badge sample", branch: "feat-badge", url: "u", state: "OPEN", isDraft: false,
  ciStatus: "passing", reviewStatus: "review_required", mergeable: "MERGEABLE", autoMergeEnabled: false, ...over,
});

describe("repo badge position and styling", () => {
  beforeAll(() => store.configReady);
  afterEach(async () => {
    apiFake.reset();
    await act(async () => { await store.refresh(); await flush(); await flush(); });
    close();
    navigate("/");
  });

  test("the Agents desktop row: the badge leads the title, same colour the pure function picks for this repo", async () => {
    apiFake.prsData = [pr()];
    await open("/agents");
    const row = container!.querySelector<HTMLElement>('[data-branch="feat-badge"]')!;
    const repoBadge = row.querySelector<HTMLElement>('[data-slot="repo-badge"]')!;
    expect(repoBadge.textContent).toBe("r"); // the fake config's one repo
    expect(repoBadge.previousElementSibling).toBeNull(); // first in the title's flex row
    expect(repoBadge.nextElementSibling?.textContent).toContain("Repo badge sample");
    for (const cls of repoBadgeTone("r").split(" ")) expect(repoBadge.className).toContain(cls);
    // No separate repo text in the subline any more.
    expect(row.querySelector('[data-slot="row-subline"]')!.textContent).not.toContain("r·");
  });

  test("the Agents stacked/phone row: the badge leads the title there too", async () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q === NARROW_QUERY, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      apiFake.prsData = [pr()];
      await open("/agents");
      const row = container!.querySelector<HTMLElement>('[data-branch="feat-badge"][data-layout="stacked"]')!;
      const repoBadge = row.querySelector<HTMLElement>('[data-slot="repo-badge"]')!;
      expect(repoBadge.previousElementSibling).toBeNull();
      expect(repoBadge.nextElementSibling?.textContent).toContain("Repo badge sample");
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  test("the Board card: the badge sits beside the title, not as the old uppercase Eyebrow tab", async () => {
    apiFake.prsData = [pr()];
    await open("/board");
    const repoBadge = container!.querySelector<HTMLElement>('[data-slot="repo-badge"]')!;
    expect(repoBadge.textContent).toBe("r");
    expect(repoBadge.nextElementSibling?.textContent).toContain("Repo badge sample");
    // The old Eyebrow (uppercase, tracking-widest) is gone.
    expect(container!.querySelector(".tracking-widest")).toBeNull();
  });
});
