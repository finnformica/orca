// lib/poll.ts — the poll every component uses for its status fetches. `setInterval` fired on the
// clock whether or not the last request came back; with the browser's six connections busy, those
// requests queued hundreds deep (660 preview-status calls in one measured stall) and the PR page's
// own fetch waited behind them. A poll now has at most one request in flight, and a hidden page
// fetches nothing.
import { afterEach, expect, test } from "bun:test";
import { poll } from "@/lib/poll";

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
afterEach(() => { visibility = "visible"; });

test("a slow request is never overlapped: the next tick waits for it to settle", async () => {
  let started = 0, inFlight = 0, maxInFlight = 0;
  let release: () => void = () => {};
  const stop = poll(() => {
    started++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<void>((r) => { release = () => { inFlight--; r(); }; });
  }, 5);
  await Bun.sleep(60); // twelve intervals' worth of clock while the request hangs
  expect(started).toBe(1);
  release();
  await Bun.sleep(30);
  expect(started).toBe(2); // the next one only after it came back
  expect(maxInFlight).toBe(1);
  stop(); release();
});

test("a hidden page doesn't fetch, and resumes when shown; a failed fetch keeps polling", async () => {
  let calls = 0;
  visibility = "hidden";
  const stop = poll(() => { calls++; throw new Error("bridge down"); }, 5);
  await Bun.sleep(40);
  expect(calls).toBe(0);
  visibility = "visible";
  await Bun.sleep(40);
  expect(calls).toBeGreaterThan(1); // a throw doesn't end the poll
  stop();
  const after = calls;
  await Bun.sleep(30);
  expect(calls).toBe(after); // stopped means stopped
});
