// Real-browser proof for the PR-column Verified pill's box (Agents.tsx prItems / workstream.ts
// prPill): happy-dom, every other test's DOM, lays out nothing — getBoundingClientRect() is always
// zero there — so a claim about pixel height, padding or vertical position can only be checked in a
// real browser. This drives web/pill-harness.html (web/src/pillHarnessMain.tsx), which renders the
// REAL Pill/Tip/ConditionBadges components for one row per PR state, through the box's one capped
// browser (server/screenshot.ts) — no new dependency, no custom CDP wiring.
//
// Run via the e2e queue: `orca-run --kind e2e -- bunx --bun bun test tests/pillLayout.e2e.test.ts`.
// Skipped where no headless browser is cached (CI; see findBrowser) — this is a box-local proof,
// not a CI gate.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { findBrowser, shooter } from "../server/screenshot";
import { native } from "./happydom"; // happy-dom's preloaded fetch CORS-blocks a real port

type Box = { h: number; t: number; w: number };

const PORT = 18734;
// Not a CI gate: GitHub's runner has google-chrome on PATH, which findBrowser takes, so test for CI
// itself rather than for a browser.
const browser = process.env.CI ? undefined : findBrowser();
let proc: ReturnType<typeof Bun.spawn> | undefined;

beforeAll(async () => {
  if (!browser) return; // the test below skips; no point starting a server for it
  proc = Bun.spawn(["bunx", "--bun", "vite", "--port", String(PORT), "--strictPort"], {
    cwd: `${import.meta.dir}/../web`, stdout: "ignore", stderr: "ignore",
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { if ((await native.fetch(`http://localhost:${PORT}/pill-harness.html`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("vite dev server for the pill harness did not come up in time");
    await Bun.sleep(200);
  }
});

afterAll(() => { proc?.kill(); });

/** A fixture row's item keyed `<data-slot>:<first 14 chars of its text>` — `t` is relative to the
 *  row's own top (pillHarnessMain.tsx), so two different rows are directly comparable. */
const item = (items: Record<string, Box>, prefix: string) => Object.entries(items).find(([k]) => k.startsWith(prefix))![1];

test.skipIf(!browser)("the PR-column pill and its badge siblings share one box: Pill vs Pill, Tip-wrapped vs bare, Pill vs Badge", async () => {
  const shot = await shooter().shoot({ url: `http://localhost:${PORT}/pill-harness.html`, viewport: { width: 900, height: 700 }, console: true });
  const lines = new Map((shot.console ?? [])
    .filter((l) => l.startsWith("console.error: PILL_MEASUREMENTS "))
    .map((l) => {
      const rest = l.slice("console.error: PILL_MEASUREMENTS ".length);
      const sp = rest.indexOf(" ");
      return [rest.slice(0, sp), JSON.parse(rest.slice(sp + 1)) as Record<string, Box>] as const;
    }));
  expect(lines.size).toBe(8);

  const open = item(lines.get("open")!, "state-pill:");
  const draft = item(lines.get("draft")!, "state-pill:");
  const merged = item(lines.get("merged")!, "state-pill:");
  const mergeable = item(lines.get("mergeable")!, "state-pill:");
  const verified = item(lines.get("verified")!, "state-pill:");
  const changed = item(lines.get("changed")!, "state-pill:");

  // Bare Pills (no tooltip: Open, Draft, Merged, Mergeable) must already agree with each other —
  // same component, same classes.
  for (const p of [draft, merged, mergeable]) { expect(p.h).toBeCloseTo(open.h, 1); expect(p.t).toBeCloseTo(open.t, 1); }
  // Tip-wrapped Pills (Verified, Changed since verified) must render the SAME box as a bare one:
  // the Tip wrapper must add no height and shift nothing.
  for (const p of [verified, changed]) { expect(p.h).toBeCloseTo(open.h, 1); expect(p.t).toBeCloseTo(open.t, 1); }

  // The Badge-based condition chips beside the state-pill (CI, auto-merge) must match its box too —
  // the real, measured difference this review flagged (ConditionBadges.tsx / PrPanels.tsx CiChip).
  const openCi = item(lines.get("open")!, "badge:CI");
  const autoMergeBadge = item(lines.get("auto-merge")!, "badge:Auto-merge");
  expect(openCi.h).toBeCloseTo(open.h, 1);
  expect(openCi.t).toBeCloseTo(open.t, 1);
  expect(autoMergeBadge.h).toBeCloseTo(open.h, 1);
}, 60_000); // a cold browser plus Vite's first compile of the harness takes longer than bun's 5 s
