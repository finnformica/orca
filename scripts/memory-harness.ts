// The bridge's memory under load, measured in a process of its own (2026-10-18: the bridge peaked at
// its 3 GB cap plus 2.7 GB swap after 9 hours). It runs the bridge's real run path (agent.launch, the
// stream readers, the transcript writes, the bus) against a fake `claude` that writes a large
// stream-json stdout, with SSE streams open that never read (a tab on a laptop that went to sleep).
// It samples this process's RSS and prints one JSON line: the peak and what stays after the runs.
//
//   NODE_ENV=test bun scripts/memory-harness.ts --runs 12 --concurrency 3 --mb 40 --stalled 4
//
// It makes its own throwaway schema (tests/pg.ts, ORCA_TEST_DATABASE_URL) and ignores
// ORCA_DATABASE_URL. NODE_ENV=test makes db.ts refuse any database that is not a test schema, so it
// can never write to the shared one. tests/bridgeMemory.test.ts runs it at a small size.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const RUNS = arg("runs", 12), CONCURRENCY = arg("concurrency", 3), MB = arg("mb", 40), STALLED = arg("stalled", 4);

const { freshSchema } = await import("../tests/pg");
const pg = await freshSchema("memh");
process.env.ORCA_DATABASE_URL = pg.url;
process.env.NODE_ENV = "test";
const state = await mkdtemp(join(tmpdir(), "orca-memh-state-"));
const shim = await mkdtemp(join(tmpdir(), "orca-memh-bin-"));
const work = await mkdtemp(join(tmpdir(), "orca-memh-wt-"));
process.env.ORCA_STATE_DIR = state;
process.env.PATH = `${shim}:${process.env.PATH}`;

// A fake claude: per MB of stdout, one tool call with a 64 KB result (a step) and ~1 MB of reply
// deltas — what `--include-partial-messages` makes of a long, chatty run.
await writeFile(join(shim, "claude"), `#!/usr/bin/env bun
const mb = Number(process.env.ORCA_MEMH_MB);
const out = Bun.stdout.writer();
out.write(JSON.stringify({ type: "system", subtype: "init", session_id: crypto.randomUUID() }) + "\\n");
const delta = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x".repeat(160) } } }) + "\\n";
const deltas = delta.repeat(Math.floor((1 << 20) / delta.length));
const tool = (i) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t" + i, name: "Bash", input: { command: "cat big" + i } }] } }) + "\\n"
  + JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t" + i, content: "y".repeat(64 << 10) }] } }) + "\\n";
for (let i = 0; i < mb; i++) { out.write(tool(i)); out.write(deltas); await out.flush(); }
out.write(JSON.stringify({ type: "result", subtype: "success", result: "## Outcome\\nDone.", is_error: false, session_id: "s" }) + "\\n");
await out.flush();
`);
await chmod(join(shim, "claude"), 0o755);
process.env.ORCA_MEMH_MB = String(MB);

const agent = await import("../server/agent");
const events = await import("../server/events");
const db = await import("../server/db");
const bus = await import("../server/bus");

const mib = (n: number) => Math.round(n / (1 << 20));
let peak = 0;
const sample = () => { peak = Math.max(peak, process.memoryUsage().rss); };
const sampler = setInterval(sample, 50);

// Streams nobody reads: each holds whatever the bridge enqueues for it.
const aborts: AbortController[] = [];
const stalled: Response[] = [];
for (let i = 0; i < STALLED; i++) {
  const ac = new AbortController();
  aborts.push(ac);
  stalled.push(events.eventStream(new Request("http://x/api/events", { signal: ac.signal }), []));
}

Bun.gc(true);
const before = process.memoryUsage().rss;
const t0 = Date.now();
let next = 0;
const statuses: Record<string, number> = {};
async function worker(w: number) {
  while (next < RUNS) {
    const i = next++;
    const key = join(work, `wt-${w}`);
    await Bun.$`mkdir -p ${key}`.quiet();
    await agent.launch(key, key, `run ${i}`, { repo: "r", branch: `b${w}`, provider: "claude", instruction: `run ${i}` });
    while (agent.isRunning(key)) await Bun.sleep(25);
    await agent.afterRunsSettled();
    const st = agent.status(key).status ?? "none";
    statuses[st] = (statuses[st] ?? 0) + 1;
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, (_, w) => worker(w)));
await agent.flushHistory();
const elapsedMs = Date.now() - t0;
const live = bus.subscriberCount(); // a stalled stream the bridge closed has unsubscribed
// The worktrees go (as the reaper removes them); their finished runs must not stay in memory.
const runsBeforePrune = agent.runCount();
await rm(work, { recursive: true, force: true });
agent.pruneRuns();
const runsAfterPrune = agent.runCount();
Bun.gc(true);
sample();
const after = process.memoryUsage().rss;
const heapAfter = process.memoryUsage().heapUsed;
clearInterval(sampler);
for (const ac of aborts) ac.abort();
await db.close();
await pg.drop();
for (const d of [state, shim, work]) await rm(d, { recursive: true, force: true });
console.log(JSON.stringify({
  runs: RUNS, concurrency: CONCURRENCY, stdoutMbPerRun: MB, stalledStreams: STALLED, elapsedMs,
  rssBeforeMb: mib(before), rssPeakMb: mib(peak), rssAfterMb: mib(after), retainedMb: mib(after - before), heapAfterMb: mib(heapAfter),
  stalledStreamsOpen: live, statuses, runsBeforePrune, runsAfterPrune,
}));
process.exit(0);
