// The caveman trial report (shared/cavemanTrial.ts): worker runs with and without caveman over a date
// range, from this host's trial log (~/.orca/trial/caveman.jsonl). Read-only.
//
//   bun run trial:caveman [--from 2026-10-15] [--to 2026-10-22] [--file <jsonl>]...
//
// --from defaults to the recorded trial start (else 7 days ago), --to to now. Dates are UTC; a bare
// date means midnight. Repeat --file to merge another host's log (copy it here first).
import { readRows, startedAt } from "../server/caveman";
import { renderTrialReport } from "../shared/cavemanTrial";

const args = process.argv.slice(2);
const values = (flag: string): string[] => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]!] : []));
const date = (flag: string): number | undefined => {
  const v = values(flag)[0];
  if (!v) return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) { console.error(`${flag}: not a date: ${v}`); process.exit(2); }
  return t;
};

const start = startedAt();
const to = date("--to") ?? Date.now();
const from = date("--from") ?? start ?? to - 7 * 24 * 60 * 60_000;
const files = values("--file");
const rows = files.length ? files.flatMap((f) => readRows(f)) : readRows();
console.log(renderTrialReport(rows, { from, to }, start));
