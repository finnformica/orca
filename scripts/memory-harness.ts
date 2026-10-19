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
//
// It never touches the box's systemd or the bin/worker shims (2026-10-19: six fake claudes from this
// harness looped through two `bun` shims for minutes, in real orca-run-<id>.scope units). The fake
// claude runs this bun by its absolute path, and `systemd-run` / `systemctl` / the user bus are
// fakes, as in tests/agentScope.test.ts. `--root <dir>` puts its temp dirs there, so a caller can
// find (`<root>/orca-memh-bin-`) and kill any fake claude that outlives it.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const root = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1]! : tmpdir();
const RUNS = arg("runs", 12), CONCURRENCY = arg("concurrency", 3), MB = arg("mb", 40), STALLED = arg("stalled", 4);

const { freshSchema } = await import("../tests/pg");
const pg = await freshSchema("memh");
process.env.ORCA_DATABASE_URL = pg.url;
process.env.NODE_ENV = "test";
const state = await mkdtemp(join(root, "orca-memh-state-"));
const shim = await mkdtemp(join(root, "orca-memh-bin-"));
const work = await mkdtemp(join(root, "orca-memh-wt-"));
const runtime = await mkdtemp(join(root, "orca-memh-run-"));
process.env.ORCA_STATE_DIR = state;
process.env.PATH = `${shim}:${process.env.PATH}`;

// Fake systemd: a user bus that "answers", `systemd-run … -- <cmd>` runs <cmd> unscoped, and
// `systemctl --user` says yes to everything. No orca-run-<id>.scope is ever made.
const sh = async (name: string, body: string) => {
  await writeFile(join(shim, name), `#!/bin/sh\n${body}\n`);
  await chmod(join(shim, name), 0o755);
};
await writeFile(join(runtime, "bus"), "");
await mkdir(join(runtime, "linger"));
await sh("systemd-run", `echo "$*" >> "${join(runtime, "systemd-run.log")}"\nfor a in "$@"; do shift; [ "$a" = "--" ] && break; done\nexec "$@"`);
await sh("systemctl", `case "$*" in *"is-system-running") echo running ;; *"-p Result --value") echo success ;; *) exit 0 ;; esac`);
Object.assign(process.env, { XDG_RUNTIME_DIR: runtime, ORCA_LINGER_DIR: join(runtime, "linger"), ORCA_CGROUP_ROOT: runtime, ORCA_TEST_FORCE_CGROUP_LINUX: "1" });

// A fake claude: per MB of stdout, one tool call with a 64 KB result (a step) and ~1 MB of reply
// deltas — what `--include-partial-messages` makes of a long, chatty run.
// Its script is claude.js, run by this bun's own path: `#!/usr/bin/env bun` found bin/worker's shim.
await writeFile(join(shim, "claude.js"), `const mb = Number(process.env.ORCA_MEMH_MB);
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
await sh("claude", `exec "${process.execPath}" "${join(shim, "claude.js")}" "$@"`);
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
const fakeScopes = (await Bun.file(join(runtime, "systemd-run.log")).text().catch(() => "")).split("\n").filter(Boolean).length;
for (const d of [state, shim, work, runtime]) await rm(d, { recursive: true, force: true });
console.log(JSON.stringify({
  runs: RUNS, concurrency: CONCURRENCY, stdoutMbPerRun: MB, stalledStreams: STALLED, elapsedMs,
  rssBeforeMb: mib(before), rssPeakMb: mib(peak), rssAfterMb: mib(after), retainedMb: mib(after - before), heapAfterMb: mib(heapAfter),
  stalledStreamsOpen: live, statuses, fakeScopes, runsBeforePrune, runsAfterPrune,
}));
process.exit(0);
