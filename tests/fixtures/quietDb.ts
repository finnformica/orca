// Run by tests/quietDegraded.test.ts in its own process (primary.ts holds one election per process).
// The same wiring server/index.ts has: open the database without awaiting it, elect, a run-once
// duty behind `primary.whenUp` (the boot reconcile's), and the metrics sampler's two writes on a
// fast tick. The test watches this process's console while the database is down, then brings it back.
import * as db from "../../server/db";
import * as primary from "../../server/primary";
import { heartbeat, sampleMetrics } from "../../server/health";

void db.open().catch(() => {});
primary.elect();
primary.whenUp(async () => {
  await db.reconcileRunning(new Set(), async () => undefined); // a real query: fails fast while the database is down
  console.log("DUTY ran");
}, "fixture: duty failed");
setInterval(() => { void heartbeat(); void sampleMetrics(); }, 50);
setInterval(() => console.log(`STATE held=${primary.held()}`), 200);
