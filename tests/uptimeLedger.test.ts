// The machine's uptime ledger maths (`billedUptime`, `journalBoots`): what EC2 bills, from the
// kernel's boots rather than Orca's samples. Pure — no database.
import { expect, test } from "bun:test";
import { REBOOT_GAP_MS, billedUptime, bootKey, journalBoots, type BootSpan } from "../web/src/workstream";

const H = 3_600_000;
const from = Date.UTC(2026, 9, 1), now = Date.UTC(2026, 9, 13, 12);
const boot = (bootId: string, bootedAt: number, lastSeen: number): BootSpan => ({ bootId, bootedAt, lastSeen });

test("one boot spanning the month: every hour billed, nothing unknown", () => {
  const u = billedUptime([boot("a", from - 5 * H, now - 3 * H)], { from, now, currentBootId: "a" });
  // The live boot runs to now even though its heartbeat is 3h stale (Orca hung or down).
  expect(u).toEqual({ billedMs: now - from, assumedMs: 0, unknownMs: 0, ledgerFrom: from - 5 * H });
});

test("a boot that isn't the live one ends at its last sighting", () => {
  const u = billedUptime([boot("a", from + H, from + 3 * H)], { from, now, billingSince: from + H });
  expect(u.billedMs).toBe(2 * H);
});

test("a reboot (gap ≤ REBOOT_GAP_MS) bills straight through; a longer gap is unknown, not billed", () => {
  const b1 = from + H, e1 = from + 10 * H;
  const reboot = billedUptime([boot("a", b1, e1), boot("b", e1 + 40_000, now)], { from, now, currentBootId: "b", billingSince: b1 });
  expect(reboot.billedMs).toBe(now - b1);
  expect(reboot.unknownMs).toBe(0);
  const edge = billedUptime([boot("a", b1, e1), boot("b", e1 + REBOOT_GAP_MS, now)], { from, now, currentBootId: "b", billingSince: b1 });
  expect(edge.unknownMs).toBe(0);
  const stop = billedUptime([boot("a", b1, e1), boot("b", e1 + 5 * H, now)], { from, now, currentBootId: "b", billingSince: b1 });
  expect(stop.billedMs).toBe(now - b1 - 5 * H);
  expect(stop.unknownMs).toBe(5 * H);
});

test("before the ledger: billingSince assumes running from it; without one the stretch is unknown", () => {
  const first = from + 100 * H;
  const boots = [boot("a", first, now)];
  expect(billedUptime(boots, { from, now, currentBootId: "a" })).toEqual({ billedMs: now - first, assumedMs: 0, unknownMs: 100 * H, ledgerFrom: first });
  const seeded = billedUptime(boots, { from, now, currentBootId: "a", billingSince: from + 40 * H });
  expect(seeded).toEqual({ billedMs: now - from - 40 * H, assumedMs: 60 * H, unknownMs: 0, ledgerFrom: first });
  // A billing start after the ledger's first boot: nothing before it counts.
  expect(billedUptime(boots, { from, now, currentBootId: "a", billingSince: first + H }).billedMs).toBe(now - first - H);
  // No boots at all.
  expect(billedUptime([], { from, now })).toEqual({ billedMs: 0, assumedMs: 0, unknownMs: now - from, ledgerFrom: null });
  expect(billedUptime([], { from, now, billingSince: from }).assumedMs).toBe(now - from);
});

test("only [from, now) counts: last month's boots and a gap straddling the 1st are clipped", () => {
  const u = billedUptime([boot("a", from - 48 * H, from - 2 * H), boot("b", from + 3 * H, now)], { from, now, currentBootId: "b" });
  expect(u.billedMs).toBe(now - from - 3 * H);
  expect(u.unknownMs).toBe(3 * H); // the stop straddling midnight: only this month's 3h
});

test("overlapping spans (one boot seen under two ids) are merged, never double-counted", () => {
  const u = billedUptime([boot("a", from + H, from + 5 * H), boot("t123", from + H + 30_000, from + 6 * H)], { from, now, billingSince: from + H });
  expect(u.billedMs).toBe(5 * H);
});

test("journalBoots: µs entries to ms spans, hyphen-free ids; junk is skipped", () => {
  const json = JSON.stringify([
    { index: -1, boot_id: "3ffa6db5fce34ce8a29ae09da0d8a136", first_entry: 1791797440820873, last_entry: 1791901865129021 },
    { index: 0, boot_id: "x" },
  ]);
  expect(journalBoots(json)).toEqual([{ bootId: "3ffa6db5fce34ce8a29ae09da0d8a136", bootedAt: 1791797440821, lastSeen: 1791901865129 }]);
  expect(journalBoots("not json")).toEqual([]);
  expect(journalBoots("{}")).toEqual([]);
  expect(bootKey("7022A62D-4105-4b26-9b49-c45093d98e66\n")).toBe("7022a62d41054b269b49c45093d98e66");
});
