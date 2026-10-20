// A throwaway harness, not linked from the app and not part of `vite build`'s default entry (only
// index.html is): it renders the REAL PR-column pieces (Pill, Tip, ConditionBadges) for one row per
// PR state, side by side, exactly as Agents.tsx composes them. happy-dom (the unit test DOM) lays
// out nothing, so this is the only way to measure their real box geometry in a real browser.
// Driven by tests/pillLayout.e2e.test.ts through the box's one capped browser (server/screenshot.ts).
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Pill } from "@/components/console";
import { Tip } from "@/components/ui/tip";
import { ConditionBadges } from "./views/ConditionBadges";
import { prPill, verifiedMark, type PrPillLike } from "./workstream";
import type { Row } from "./store";

type Fixture = { key: string; row: Partial<Row> & PrPillLike };

const mark = verifiedMark("user", "aaa1111", 267, new Date().toISOString());
const FIXTURES: Fixture[] = [
  { key: "open", row: { repo: "r", lane: "IN_REVIEW", ciStatus: "passing", reviewStatus: "review_required", mergeable: "MERGEABLE" } },
  { key: "draft", row: { repo: "r", lane: "DRAFT", ciStatus: "passing" } },
  { key: "merged", row: { repo: "r", lane: "DONE" } },
  { key: "mergeable", row: { repo: "r", lane: "MERGEABLE", reviewStatus: "approved", ciStatus: "passing", mergeable: "MERGEABLE" } },
  { key: "ci-failing", row: { repo: "r", lane: "IN_REVIEW", ciStatus: "failing", mergeable: "MERGEABLE" } },
  { key: "auto-merge", row: { repo: "r", lane: "MERGEABLE", autoMergeEnabled: true, ciStatus: "passing", mergeable: "MERGEABLE" } },
  { key: "verified", row: { repo: "r", lane: "VERIFIED", verified: mark, prHead: "aaa1111", prNumber: 267, ciStatus: "passing" } },
  { key: "changed", row: { repo: "r", lane: "IN_REVIEW", verified: mark, prHead: "bbb2222", prNumber: 267, ciStatus: "passing", mergeable: "MERGEABLE" } },
];

// The exact JSX Agents.tsx uses at its state-pill line (AgentRow, both the desktop and stacked
// rows): a tooltip wraps the Pill in <Tip>, no tooltip renders it bare.
function StateCell({ row }: { row: PrPillLike }) {
  const pill = prPill(row);
  return pill.tooltip
    ? <Tip label={pill.tooltip}><Pill tone={pill.tone} slot="state-pill">{pill.label}</Pill></Tip>
    : <Pill tone={pill.tone} slot="state-pill">{pill.label}</Pill>;
}

function Harness() {
  return (
    <div className="bg-background p-6 text-sm">
      {FIXTURES.map((f) => (
        <div key={f.key} data-fixture={f.key} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b py-2">
          <span className="w-24 shrink-0 text-xs text-muted-foreground">{f.key}</span>
          <StateCell row={f.row} />
          <ConditionBadges row={f.row as Row} />
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);

// Measured right after paint — well before the capture's own 300ms settle-then-screenshot-then-
// close (server/screenshot.ts capture()), so the console session is still open to read this — and
// reported through console.error, the only console level orca-shot's --console (and the shooter's
// own `console: true`) forwards (see consoleLine), one line per fixture: each line is cut to 500
// characters there, so one combined blob for all fixtures would truncate.
requestAnimationFrame(() => requestAnimationFrame(() => {
  for (const row of document.querySelectorAll<HTMLElement>("[data-fixture]")) {
    const key = row.dataset.fixture!;
    // `t` is relative to the ROW's own top (not the page), so two different fixture rows — stacked
    // at different page y's — are directly comparable: equal `t` means equally centred in the row.
    const rowTop = row.getBoundingClientRect().top;
    const items: Record<string, { h: number; t: number; w: number }> = {};
    for (const el of row.querySelectorAll<HTMLElement>('[data-slot="state-pill"], [data-slot="badge"], [data-slot="ci-chip"]')) {
      const r = el.getBoundingClientRect();
      items[`${el.dataset.slot}:${(el.textContent ?? "").trim().slice(0, 14)}`] = { h: r.height, t: r.top - rowTop, w: r.width };
    }
    console.error(`PILL_MEASUREMENTS ${key} ${JSON.stringify(items)}`);
  }
}));
