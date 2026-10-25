// The Memory page (views/Memory.tsx) against the fake api (tests/apiFake.ts) in a real DOM: the list
// with owner, tags, source and an untrusted pill; filters in the URL; search; one memory in a dialog
// with its history, a diff and Revert; Pin; New memory; the rate warning; the Core tab's budget.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import { answer } from "./dialogs";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import type { Memory, MemoryRevision } from "../shared/memory";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function open(path: string) {
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });
}
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  apiFake.reset();
  navigate("/");
});
const all = (slot: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)];
const one = (slot: string, within: ParentNode = document) => all(slot, within)[0];
const click = async (el: HTMLElement) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });
const waitFor = async <T,>(get: () => T | undefined | null): Promise<T> => {
  for (let i = 0; i < 60; i++) { const v = get(); if (v) return v; await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); }
  throw new Error("never appeared");
};

const NOW = Date.now();
const mem = (o: Partial<Memory>): Memory => ({
  id: 1, owner: "chief", title: "t", body: "b", tags: [], importance: 5, pinned: false, source: "agent:chief", trust: "trusted", state: "active",
  revision: 1, createdBy: "agent:chief", updatedBy: "agent:chief", createdAt: NOW, updatedAt: NOW, recallCount: 0, ...o,
});
const rev = (r: Partial<MemoryRevision>): MemoryRevision => ({ memoryId: 1, revision: 1, title: "t", body: "b", tags: [], importance: 5, pinned: false, source: "agent:chief", trust: "trusted", state: "active", owner: "chief", by: "agent:chief", at: NOW, ...r });

function seed() {
  apiFake.memoryRows = [
    mem({ id: 1, title: "Deploy window", body: "Deploys only before 15:00.", tags: ["rule"], importance: 8, revision: 2, updatedAt: NOW - 1000 }),
    mem({ id: 2, owner: "shared", title: "Sam asks for Friday merges", body: "From Discord.", trust: "untrusted", source: "outside:discord:D1", updatedAt: NOW - 2000 }),
    mem({ id: 3, owner: "shared", title: "Old plan", state: "archived" }),
  ];
  apiFake.memoryDetails.set(1, {
    memory: apiFake.memoryRows[0]!, wakes: [], links: [{ relation: "about", direction: "out", id: 2, title: "Sam asks for Friday merges", state: "active" }],
    revisions: [
      rev({ revision: 2, title: "Deploy window", body: "Deploys only before 15:00.", reason: "moved", runId: "run-abcdef12" }),
      rev({ revision: 1, title: "Deploy window", body: "Deploys only before 16:00.", reason: "Finn said so" }),
    ],
  });
}

describe("the Memory page", () => {
  test("lists active memories with owner, tags and source; the untrusted one is marked; the nav has Memory", async () => {
    seed();
    await open("/memory");
    const rows = await waitFor(() => all("memory-row").length ? all("memory-row") : undefined);
    expect(rows.map((r) => r.dataset.id)).toEqual(["1", "2"]); // archived is out of the default view
    expect(rows[0]!.textContent).toContain("Deploy window");
    expect(rows[0]!.textContent).toContain("rule");
    expect(rows[0]!.textContent).toContain("source agent:chief");
    expect(one("memory-untrusted", rows[1]!)!.textContent).toBe("untrusted");
    expect(one("memory-untrusted", rows[0]!)).toBeUndefined();
    expect([...document.querySelectorAll("nav a, nav button")].some((a) => a.textContent?.includes("Memory"))).toBe(true);
  });

  test("filters live in the URL: owner and state; a tag click filters by it; search runs the text query", async () => {
    seed();
    await open("/memory?owner=shared&state=active,archived");
    let rows = await waitFor(() => all("memory-row").length ? all("memory-row") : undefined);
    expect(rows.map((r) => r.dataset.id)).toEqual(["3", "2"]); // newest first
    expect(one("memory-filter")!.dataset.active).toBe("1");
    await act(async () => navigate("/memory"));
    rows = await waitFor(() => all("memory-row").length === 2 ? all("memory-row") : undefined);
    await click(rows[0]!.querySelector("button")!); // the "rule" tag
    expect(location.search).toBe("?tag=rule");
    rows = await waitFor(() => all("memory-row").length === 1 ? all("memory-row") : undefined);
    expect(rows[0]!.dataset.id).toBe("1");
    await click(one("memory-tag-filter")!);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search memories"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "friday");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(location.search).toBe("?q=friday");
    rows = await waitFor(() => all("memory-row").length === 1 ? all("memory-row") : undefined);
    expect(rows[0]!.dataset.id).toBe("2");
  });

  test("one memory: body, links, history with reasons and a diff; Pin and Revert are the user's revisions", async () => {
    seed();
    await open("/memory");
    await click((await waitFor(() => all("memory-row")[0]))!);
    expect(location.search).toBe("?m=1");
    const dialog = await waitFor(() => one("memory-dialog"));
    await waitFor(() => all("memory-revision", dialog).length ? true : undefined);
    expect(dialog.textContent).toContain("Deploys only before 15:00.");
    expect(dialog.textContent).toContain("→ about m2 “Sam asks for Friday merges”");
    const revs = all("memory-revision", dialog);
    expect(revs.map((r) => r.dataset.revision)).toEqual(["2", "1"]);
    expect(revs[0]!.textContent).toContain("moved");
    expect(revs[0]!.textContent).toContain("run run-abcd");
    // The diff against the revision before.
    await click([...revs[0]!.querySelectorAll("button")].find((b) => b.textContent === "Diff")!);
    const diff = one("memory-diff", dialog)!;
    expect(diff.textContent).toContain("- Deploys only before 16:00.");
    expect(diff.textContent).toContain("+ Deploys only before 15:00.");
    // The current revision has no Revert; the older one does.
    expect(one("memory-revert", revs[0]!)).toBeUndefined();
    await click(one("memory-pin", dialog)!);
    expect(apiFake.memoryCalls.filter(([k]) => k === "change").map(([, b]) => b)).toEqual([{ id: 1, action: "pin" }]);
    await click(one("memory-revert", all("memory-revision", one("memory-dialog")!)[1]!)!);
    expect(await answer(true)).toBe("Revert m1 to r1? — This writes a new revision with that content. Nothing is lost.");
    await waitFor(() => apiFake.memoryCalls.some(([, b]) => (b as { action?: string }).action === "revert") ? true : undefined);
    expect(apiFake.memoryCalls.filter(([k]) => k === "change").map(([, b]) => b)).toContainEqual({ id: 1, action: "revert", revision: 1 });
  });

  test("New memory writes as the user; the rate warning shows when an agent hit its day's limit", async () => {
    seed();
    apiFake.memoryToday = { chief: 200 };
    await open("/memory");
    expect((await waitFor(() => one("memory-rate-warning"))).textContent).toContain("chief made 200 memory changes in 24 hours, the limit");
    await click(one("memory-new")!);
    const d = await waitFor(() => one("memory-new-dialog"));
    const set = (sel: string, v: string) => {
      const el = d.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel)!;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => { set('input[aria-label="Title"]', "Finn's review hours"); set('textarea[aria-label="Body"]', "Mornings only."); set('input[aria-label="Tags"]', "preference"); await flush(); });
    await click(one("memory-create", d)!);
    expect(apiFake.memoryCalls.find(([k]) => k === "write")![1]).toEqual({ owner: "shared", title: "Finn's review hours", body: "Mornings only.", tags: ["preference"], importance: 5 });
    expect(location.search).toBe("?m=4");
  });

  test("the Reflection tab: each pass with its trigger, state, what it read and changed, its memories and summary", async () => {
    seed();
    apiFake.memoryPasses = [
      { id: 2, agent: "chief", runId: "run-2", trigger: "idle", state: "done", since: NOW - 7 * 3_600_000, startedAt: NOW - 60_000, finishedAt: NOW, memoryIds: [1],
        read: { turns: 12, reports: 4, checks: 3, failedChecks: 1, corrections: 2, contradictions: 1, tokens: 5400 },
        changed: { written: 1, lessons: 1, forgotten: 1, contradictions: 1, linked: 1, total: 2 }, summary: "Went wrong: two corrections about models.\nWrote one lesson." },
      { id: 1, agent: "chief", runId: "run-1", trigger: "request", state: "running", startedAt: NOW - 3_600_000, memoryIds: [], read: { turns: 0 }, changed: {} },
    ];
    await open("/memory?tab=reflection");
    const rows = await waitFor(() => all("memory-reflection").length === 2 ? all("memory-reflection") : undefined);
    expect(rows.map((r) => r.dataset.state)).toEqual(["done", "running"]);
    expect(rows[0]!.textContent).toContain("idle time");
    expect(one("memory-reflection-read", rows[0]!)!.textContent).toBe("Read: 12 turns, 4 worker reports, 3 checks, 1 failed checks, 2 corrections, 1 possible contradictions · about 5400 tokens");
    expect(one("memory-reflection-changed", rows[0]!)!.textContent).toBe("Changed: 1 written, 1 lessons, 1 forgotten, 1 contradictions resolved, 1 links");
    expect(one("memory-reflection-changed", rows[1]!)!.textContent).toBe("Changed: running…");
    expect(rows[1]!.textContent).toContain("asked for");
    expect(one("memory-reflection-summary", rows[0]!)).toBeUndefined();
    await click(one("memory-reflection-toggle", rows[0]!)!);
    expect(one("memory-reflection-summary", rows[0]!)!.textContent).toContain("Wrote one lesson.");
    await click([...rows[0]!.querySelectorAll("button")].find((b) => b.textContent === "m1")!);
    expect(location.search).toBe("?tab=reflection&m=1");
  });

  test("the Core tab: tokens against the budget, the pinned warning, cut items", async () => {
    apiFake.memoryCoreData = { items: [{ memory: mem({ id: 7, title: "Pinned rule", pinned: true }), cut: false }, { memory: mem({ id: 8, title: "Long one" }), cut: true }], leftOut: 3, tokens: 3900, pinnedTokens: 2500, budget: 4000, pinnedWarn: 2000 };
    await open("/memory?tab=core");
    expect((await waitFor(() => one("memory-core-tokens"))).textContent).toBe("3900 of 4000 tokens");
    expect(one("memory-pinned-warning")!.textContent).toContain("Pinned memories use 2500 tokens, more than 2000");
    expect(all("memory-core-row").map((r) => r.textContent)).toEqual([expect.stringContaining("Pinned rule"), expect.stringContaining("cut")]);
    expect(document.body.textContent).toContain("3 more do not fit");
  });
});
