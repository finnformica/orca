// The typing indicator's refresh loop (server/integrations/typing.ts) with a fake clock and a fake
// adapter: one call at once, one every 8 s, and each way it ends — the reply, the run's end (a tick
// or `check()`), the hard stop after 10 min — plus a failed call that never ends the loop.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as typing from "../server/integrations/typing";
import type { Envelope } from "../shared/integrations";

function fakeClock() {
  let t = 0, id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => { timers.set(++id, { at: t + ms, fn }); return id; },
    clearTimeout: (i: unknown) => { timers.delete(i as number); },
    pending: () => timers.size,
    flush,
    /** Move time on by `ms`, firing each due timer in order. */
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        await flush(); // a tick sets its next timer only after its call settles
        const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

let clock: ReturnType<typeof fakeClock>;
let calls: number;
let running: boolean;
const start = (send: () => Promise<typing.TypingResult> = async () => { calls++; return { ok: true }; }) =>
  typing.start({ integrationId: "dc", place: "C1", send, alive: () => running });

beforeEach(() => { clock = fakeClock(); typing.useClock(clock); calls = 0; running = true; });
afterEach(() => { typing.stopAll(); typing.useClock(); });

describe("typing loop", () => {
  test("one call at once, then one every 8 s while the run is alive", async () => {
    start();
    await clock.flush();
    expect(calls).toBe(1);
    await clock.advance(7_999);
    expect(calls).toBe(1);
    await clock.advance(1);
    expect(calls).toBe(2);
    await clock.advance(16_000);
    expect(calls).toBe(4);
    expect(typing.active()).toEqual(["dc|C1"]);
  });

  test("the reply in that place stops it at once; a post elsewhere does not", async () => {
    start();
    await clock.flush();
    typing.stopPlace("dc", "C2");
    typing.stopPlace("other", "C1");
    expect(typing.active()).toEqual(["dc|C1"]);
    typing.stopPlace("dc", "C1");
    expect(typing.active()).toEqual([]);
    expect(clock.pending()).toBe(0);
    await clock.advance(60_000);
    expect(calls).toBe(1);
  });

  test("the run's end (done, failed or stopped) stops it: at once by check(), else on the next tick", async () => {
    start();
    await clock.flush();
    await typing.check();
    expect(typing.active()).toEqual(["dc|C1"]); // still running: kept
    running = false;
    await typing.check();
    expect(typing.active()).toEqual([]);
    expect(clock.pending()).toBe(0);

    running = true;
    start();
    await clock.flush();
    running = false; // no check() call: the tick finds it
    await clock.advance(8_000);
    expect(typing.active()).toEqual([]);
    expect(calls).toBe(2); // one at each start, none after the run ended
  });

  test("a run that hangs: a hard stop after 10 min", async () => {
    start();
    await clock.advance(typing.TYPING.maxMs - 1);
    expect(typing.active()).toEqual(["dc|C1"]);
    const before = calls;
    expect(before).toBe(Math.floor((typing.TYPING.maxMs - 1) / typing.TYPING.everyMs) + 1);
    await clock.advance(typing.TYPING.everyMs);
    expect(typing.active()).toEqual([]);
    expect(calls).toBe(before);
    expect(clock.pending()).toBe(0);
  });

  test("a failed or throwing typing call never ends the loop", async () => {
    let n = 0;
    start(async () => { n++; if (n === 1) return { ok: false, error: "403 Missing Permissions" }; if (n === 2) throw new Error("socket closed"); return { ok: true }; });
    await clock.advance(16_000);
    expect(n).toBe(3);
    expect(typing.active()).toEqual(["dc|C1"]);
  });

  test("a second message to the same place replaces the loop with a fresh deadline", async () => {
    start();
    await clock.advance(9 * 60_000);
    start();
    await clock.advance(5 * 60_000);
    expect(typing.active()).toEqual(["dc|C1"]);
  });
});

describe("startFor", () => {
  const env = (over: Partial<Envelope> = {}): Envelope => ({
    id: "e1", key: "discord:M5", topic: "ext.discord.message" as never, at: 0, text: "hi",
    source: { adapter: "discord", integrationId: "dc", linkId: "L1", channel: "C1" },
    thread: { adapter: "discord", externalId: "C1:M5", messageId: "M5" },
    grant: { level: "work", repos: [], linkId: "L1" },
    ...over,
  } as Envelope);
  const targets: unknown[] = [];
  const adapter = { typing: async (t: unknown) => { targets.push(t); return { ok: true }; } };

  test("starts in the reply's place for a message an agent may answer", async () => {
    targets.length = 0;
    expect(typing.startFor(env(), adapter, () => true)).toBe(true);
    await clock.flush();
    expect(targets).toEqual([{ linkId: "L1", externalId: "C1", threadId: "C1:M5" }]);
    expect(typing.active()).toEqual(["dc|C1"]);
  });

  test("does nothing for an adapter without typing, a read-only sender or Orca's own event", () => {
    expect(typing.startFor(env(), {}, () => true)).toBe(false);
    expect(typing.startFor(env(), undefined, () => true)).toBe(false);
    expect(typing.startFor(env({ grant: { level: "notify", repos: [], linkId: "L1" } as never }), adapter, () => true)).toBe(false);
    expect(typing.startFor(env({ grant: undefined }), adapter, () => true)).toBe(false);
    expect(typing.active()).toEqual([]);
  });
});
