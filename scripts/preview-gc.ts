// Report — or, with `--drop`, reap — orphan preview databases and stale test containers, by hand.
//
// The bridge already does this at startup and hourly (`preview.reap`); this is the same pass on
// demand, so it has the same rules: a database is an orphan only if NO repo on this machine has its
// worktree, it is left alone for its first 2 hours (a preview mid-clone), and it is dropped through
// preview-db.sh with the repo's own env file. Reports by default: the failure mode of getting this
// wrong is deleting a preview someone is using.
//
//   bun run scripts/preview-gc.ts                        # report, every repo checked out here
//   bun run scripts/preview-gc.ts --repo branch-demo     # report, one repo
//   bun run scripts/preview-gc.ts --drop                 # reap
import { existsSync } from "fs";
import { loadConfig } from "../server/config";
import { reap } from "../server/preview";

const args = process.argv.slice(2);
const drop = args.includes("--drop");
const at = args.indexOf("--repo");
const repoName = at >= 0 ? args[at + 1] : undefined;
if (at >= 0 && (!repoName || repoName.startsWith("--"))) { console.error("orca: --repo needs a repo name"); process.exit(1); }

const cfg = await loadConfig();
const here = cfg.repos.filter((r) => existsSync(r.repoPath));
if (repoName && !here.some((r) => r.name === repoName)) {
  console.error(`orca: no repo "${repoName}" checked out here (have: ${here.map((r) => r.name).join(", ") || "none"})`);
  process.exit(1);
}
// The live set is always every repo's worktrees (a database's worktree may be another repo's);
// --repo only narrows which repo's Postgres and containers are looked at.
const report = await reap(here.filter((r) => !repoName || r.name === repoName), { dryRun: !drop, liveFrom: here });
const verb = drop ? "reaped" : "would reap";
console.log(`orca: ${verb} ${report.droppedDbs.length} preview database(s), ${report.removedContainers.length} test container(s)`);
for (const d of report.droppedDbs) console.log(`  db         ${d}`);
for (const c of report.removedContainers) console.log(`  container  ${c}`);
if (!drop && (report.droppedDbs.length || report.removedContainers.length)) console.log("orca: re-run with --drop to reap");
