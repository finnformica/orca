// Bridge memory (2026-10-18: the bridge peaked at its 3 GB cap plus 2.7 GB swap after 9 hours).
// What grew, and the bound on each:
//   - each run's whole stdout was kept until exit, and stayed retained after it — now only the lines
//     the exit parse reads (keepForOutcome / outcomeLines), and a bounded stderr tail;
//   - an SSE stream nobody reads (a tab on a sleeping laptop) queued every event — now closed past
//     MAX_BACKLOG_CHARS, its queue dropped;
//   - the GitHub ETag cache was bounded by entries only — now by size too;
//   - finished runs of reaped worktrees stayed in agent.ts's `runs` map — now pruned.
// The end-to-end check runs scripts/memory-harness.ts (the real run path, a fake claude with a large
// stdout, stalled streams) in a child process and reads its memory report.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import * as agent from "../server/agent";
import * as bus from "../server/bus";
import * as db from "../server/db";
import * as events from "../server/events";
import * as github from "../server/github";
import { health } from "../server/health";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const delta = (text: string) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const big = "y".repeat(64 << 10);

test("a claude run keeps only what the exit parse reads, and parses the same", () => {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
    ...Array.from({ length: 200 }, () => delta("x".repeat(200))),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "cat" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: big }] } }),
    JSON.stringify({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 9, post_tokens: 3 } }),
    JSON.stringify({ type: "result", subtype: "success", result: "## Outcome\nDone.", is_error: false, session_id: "s-1", total_cost_usd: 0.5 }),
  ];
  const out = agent.outcomeLines("claude");
  for (const l of lines) out.add(l, JSON.parse(l));
  const kept = out.text();
  expect(kept.length).toBeLessThan(2_000);
  expect(agent.parseClaudeStreamOutput(kept)).toEqual(agent.parseClaudeStreamOutput(lines.join("\n")));
});

test("codex and cursor keep only their outcome events, and parse the same", () => {
  const codex = [
    JSON.stringify({ type: "thread.started", thread_id: "th-1" }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: big } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "All done." } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 7 } }),
  ];
  const c = agent.outcomeLines("codex");
  for (const l of codex) c.add(l, JSON.parse(l));
  expect(c.text().length).toBeLessThan(1_000);
  expect(agent.parseCodexOutput(c.text())).toEqual(agent.parseCodexOutput(codex.join("\n")));

  const cursor = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "cu-1" }),
    JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { result: big } }),
    JSON.stringify({ type: "result", result: "Fine.", session_id: "cu-1", is_error: false }),
  ];
  const k = agent.outcomeLines("cursor");
  for (const l of cursor) k.add(l, JSON.parse(l));
  expect(k.text().length).toBeLessThan(1_000);
  expect(agent.parseCursorOutput(k.text())).toEqual(agent.parseCursorOutput(cursor.join("\n")));
});

test("non-JSON stdout keeps only a bounded tail", () => {
  const out = agent.outcomeLines("claude");
  for (let i = 0; i < 100; i++) out.add("z".repeat(10_000), undefined);
  expect(out.text().length).toBeLessThanOrEqual(agent.OUTPUT_TAIL_CHARS);
});

test("an event stream nobody reads is closed once its backlog passes the limit", async () => {
  const before = bus.subscriberCount();
  const res = events.eventStream(new Request("http://x/api/events"), []);
  expect(bus.subscriberCount()).toBe(before + 1);
  // Under the limit: still open.
  bus.publish({ kind: "delta", runId: "r", repo: "a", branch: "b", text: "x".repeat(1 << 20) });
  expect(bus.subscriberCount()).toBe(before + 1);
  for (let i = 0; i < 9; i++) bus.publish({ kind: "delta", runId: "r", repo: "a", branch: "b", text: "x".repeat(1 << 20) });
  expect(bus.subscriberCount()).toBe(before);
  // The stream errors (its queue dropped), so a reader that comes back sees it end.
  await expect(res.text()).rejects.toThrow();
});

test("a stream that is read stays open however much passes through it", async () => {
  const before = bus.subscriberCount();
  const ac = new AbortController();
  const res = events.eventStream(new Request("http://x/api/events", { signal: ac.signal }), []);
  const reader = res.body!.getReader();
  let read = 0;
  for (let i = 0; i < 20; i++) {
    bus.publish({ kind: "delta", runId: "r", repo: "a", branch: "b", text: "x".repeat(1 << 20) });
    for (let r = await reader.read(); ; r = await reader.read()) { read += String(r.value ?? "").length; if (String(r.value).includes("x".repeat(100))) break; }
  }
  expect(read).toBeGreaterThan(20 << 20);
  expect(bus.subscriberCount()).toBe(before + 1);
  ac.abort();
  expect(bus.subscriberCount()).toBe(before);
});

test("the GitHub ETag cache is bounded by size, and skips one huge answer", async () => {
  github.resetCaches();
  let n = 0;
  github.setFetch(async (url) => {
    const size = Number(new URL(url).searchParams.get("kb")) << 10;
    return new native.Response(JSON.stringify({ blob: "b".repeat(size) }), { headers: { etag: `"e${n++}"`, "content-type": "application/json" } });
  });
  try {
    for (let i = 0; i < 40; i++) await github.request(`http://gh.test/p${i}?kb=900`, { token: "t" });
    const { chars, entries } = github.etagCacheSize();
    expect(chars).toBeLessThanOrEqual(github.ETAG_MAX_CHARS);
    expect(entries).toBeLessThan(40);
    await github.request("http://gh.test/huge?kb=2048", { token: "t" });
    expect(github.etagCacheSize().entries).toBe(entries); // not kept
  } finally {
    github.setFetch(undefined);
    github.resetCaches();
  }
});

test("the harness: many large runs and stalled streams leave the bridge's heap small", async () => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "scripts", "memory-harness.ts"), "--runs", "6", "--concurrency", "2", "--mb", "10", "--stalled", "2"], {
    env: { ...process.env, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  expect(await proc.exited, err).toBe(0);
  const report = JSON.parse(out.trim().split("\n").at(-1)!);
  expect(report.statuses).toEqual({ done: 6 });
  // Before: 60 MB of stdout went through, and the heap kept about all of it (plus the streams'
  // backlog). Now a few MB stay.
  expect(report.heapAfterMb).toBeLessThan(30);
  expect(report.stalledStreamsOpen).toBe(0);
  expect(report.runsBeforePrune).toBeGreaterThan(0);
  expect(report.runsAfterPrune).toBe(0);
}, 60_000);

let pg: TestDb;
let prevUrl: string | undefined;
beforeAll(async () => {
  prevUrl = process.env.ORCA_DATABASE_URL;
  pg = await freshSchema("bridgememory");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterAll(async () => {
  await db.close();
  await pg.drop();
  if (prevUrl === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prevUrl;
});

test("/api/health reports the bridge's RSS and the sampler records it", async () => {
  const h = await health();
  expect(h.bridgeRssMb).toBeGreaterThan(0);
  const at = Date.now() - 60_000;
  await db.recordMetric({ cpuPct: 5, load1: 0.1, memUsedGb: 1, memTotalGb: 8, runningAgents: 0, bridgeRssMb: 321 }, at);
  const [row] = await db.metricHistory(db.instanceName(), 1);
  expect(row).toMatchObject({ bridgeRssMb: 321 });
});
