// The instance health chip's numbers (server/health.ts): the month-to-date cost estimate is plain
// arithmetic worth pinning; the vitals come straight from the os module.
import { expect, test } from "bun:test";
import { costEstimate, health } from "../server/health";

test("cost: hours since the later of the billing start and the 1st of the month, at the rate", () => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0); // 12 Oct 2026 12:00Z
  expect(costEstimate(0.25, "2026-10-12T09:00:00Z", now)).toEqual({ monthUsd: 0.75, hourlyUsd: 0.25, sinceIso: "2026-10-12T09:00:00.000Z", billingSince: "2026-10-12T09:00:00.000Z" }); // 3h × 0.25
  expect(costEstimate(0.25, "2026-09-01T00:00:00Z", now)?.billingSince).toBe("2026-09-01T00:00:00.000Z"); // unclamped, for a range spanning the 1st
  expect(costEstimate(0.25, "2026-09-01T00:00:00Z", now)?.monthUsd).toBe(69); // from the 1st: 11.5 days × 24 × 0.25
  expect(costEstimate(0.25, undefined, now)?.sinceIso).toBe("2026-10-01T00:00:00.000Z"); // no start → the month
  expect(costEstimate(0, "2026-10-12T09:00:00Z", now)).toBeUndefined(); // no rate → no estimate
  expect(costEstimate(NaN, undefined, now)).toBeUndefined();
});

test("health reports this machine's vitals in the shape the chip reads", async () => {
  const h = await health();
  expect(h.cores).toBeGreaterThan(0);
  expect(h.cpuPct).toBeGreaterThanOrEqual(0);
  expect(h.memTotalGb).toBeGreaterThan(0);
  expect(h.uptimeS).toBeGreaterThan(0);
  expect(typeof h.hostname).toBe("string");
});
