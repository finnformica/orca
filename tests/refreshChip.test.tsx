// The top bar's "Updated 3 min ago" chip is a button: "Refresh everything" (web/src/lib/refresh.ts).
// A click aborts every GET stuck in flight, re-runs every poll on the page at once (each `poll()` is a
// source, as are the board's streams, usage, notifications and an open chat), spins until all have
// answered, and falls back to a hard reload when the page never settles.
import { afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { StaleIndicator } from "@/components/Freshness";
import { poll } from "@/lib/poll";
import { _resetRefresh, onRefresh, refreshEverything, trackedFetch } from "@/lib/refresh";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);
const flush = () => new Promise((r) => setTimeout(r, 0));

const realFetch = globalThis.fetch;
let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  globalThis.fetch = realFetch;
  setSystemTime();
  apiFake.reset();
  _resetRefresh();
});

test("refresh: a poll stuck on a request is aborted and re-run at once; the refresh waits for the re-run", async () => {
  const signals: AbortSignal[] = [];
  globalThis.fetch = ((_: string, init?: RequestInit) => {
    const signal = init!.signal!;
    signals.push(signal);
    // The first request hangs until aborted (a peer that never answers); the re-run answers.
    if (signals.length === 1) return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  let answered = 0;
  const stop = poll(() => trackedFetch("/api/usage").then(() => { answered++; }), 60_000);
  await flush();
  expect(signals).toHaveLength(1);

  expect(await refreshEverything({ stuckMs: 0 })).toBe("done");
  expect(signals[0]!.aborted).toBe(true);
  expect(signals).toHaveLength(2);
  expect(answered).toBe(1);
  stop();
});

test("refresh: a page that never settles falls back to a hard reload", async () => {
  const off = onRefresh(() => new Promise(() => {}));
  let reloads = 0;
  expect(await refreshEverything({ deadlineMs: 20, reload: () => { reloads++; } })).toBe("reloaded");
  expect(reloads).toBe(1);
  off();
});

test("the Updated chip refreshes everything on click, spinning until every source has answered", async () => {
  await store.refresh(); // a first sync, then two minutes of silence: the chip shows
  setSystemTime(new Date(Date.now() + 120_000));
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<StaleIndicator />); await flush(); });
  const chip = container.querySelector<HTMLButtonElement>('[data-slot="stale-indicator"]')!;
  expect(chip.tagName).toBe("BUTTON");
  expect(chip.textContent).toContain("Updated 2m ago");

  let release!: () => void;
  const off = onRefresh(() => new Promise<void>((r) => { release = r; }));
  const before = store.clientPollCounts();
  await act(async () => { chip.click(); await flush(); });
  expect(chip.getAttribute("aria-busy")).toBe("true");
  expect(chip.disabled).toBe(true);
  expect(chip.textContent).toContain("Refreshing…");
  expect(chip.querySelector("svg.animate-spin")).not.toBeNull();
  // The board's own streams were re-run by the same click.
  const after = store.clientPollCounts();
  expect(after.agents).toBeGreaterThan(before.agents);
  expect(after.prs).toBeGreaterThan(before.prs);
  expect(after.merged).toBeGreaterThan(before.merged);

  await act(async () => { release(); await flush(); await flush(); });
  // Fresh again: the board answered at the (moved) clock, so the chip is gone.
  expect(container.querySelector('[data-slot="stale-indicator"]')).toBeNull();
  off();
});
