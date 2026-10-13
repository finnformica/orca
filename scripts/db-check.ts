// `bun run db:check` — the migration ledger of ORCA_DATABASE_URL against this checkout's MIGRATIONS,
// for a human before/after a deploy. READ-ONLY: it never migrates (server/db.ts `open()` would), so
// it is safe to point at the shared database from anywhere. Exit 1 when the bridge would refuse to
// start (a non-idempotent mismatch), else 0 — pending and re-runnable steps are what a start applies.
import { describeMismatch, MIGRATIONS, planMigrations, recordedMigrations } from "../server/db";

const url = process.env.ORCA_DATABASE_URL || "postgres://localhost:5432/orca";
const sql = new Bun.SQL(url);
try {
  const recorded = await recordedMigrations(sql);
  const byId = new Map(recorded.map((r) => [r.id, r.name]));
  const plan = planMigrations(MIGRATIONS, recorded);
  console.log(`database: ${url.replace(/\/\/[^@/]*@/, "//***@")}`);
  console.log("  id  expected                          recorded");
  for (const step of MIGRATIONS) {
    const rec = byId.has(step.id) ? (byId.get(step.id) ?? "(applied, no name)") : "— not applied";
    const flag = plan.refused.some((m) => m.id === step.id) ? "  ✗ MISMATCH (refuses start)"
      : plan.mismatches.some((m) => m.id === step.id) ? "  ⚠ MISMATCH (will re-run)"
      : plan.run.includes(step) ? (byId.has(step.id) ? "  → re-runs on next start (no name to verify)" : "  → runs on next start")
      : plan.stamp.includes(step) ? "  → named on next start" : "";
    console.log(`  ${String(step.id).padStart(2)}  ${step.name.padEnd(32)}  ${rec}${flag}`);
  }
  for (const u of plan.unknown) console.log(`  ${String(u.id).padStart(2)}  ${"(no such step here)".padEnd(32)}  ${u.name ?? "(no name)"}  ⚠ unknown`);
  for (const m of plan.mismatches) console.log(`MISMATCH: ${describeMismatch(m)}`);
  console.log(plan.refused.length ? "result: the bridge would REFUSE to start" : plan.run.length || plan.stamp.length ? `result: next start applies ${plan.run.map((s) => s.id).join(", ") || "nothing"}${plan.stamp.length ? ` and names ${plan.stamp.map((s) => s.id).join(", ")}` : ""}` : "result: up to date");
  process.exitCode = plan.refused.length ? 1 : 0;
} finally {
  await sql.end();
}
