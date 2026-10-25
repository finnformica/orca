// The Memory page's API (server/memoryRoutes.ts) against real Postgres, through the same handler the
// bridge calls (server/index.ts): list with filters, one memory with links, history and wakes, the
// user's write, pin, trust, state and revert — each a revision by "user". An agent has no path to pin
// or trust. Plus the page's pure rules (shared/memory.ts): the URL query, the filter and the diff.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as memory from "../server/memory";
import * as orchestrator from "../server/orchestrator";
import * as wakes from "../server/scheduledWake";
import { handleMemory } from "../server/memoryRoutes";
import type { OrcaConfig } from "../server/config";
import { CHIEF, filterMemories, lineDiff, memoryQueryString, parseMemoryQuery, sourceKind, type Memory } from "../shared/memory";
import { freshSchema, type TestDb } from "./pg";

const cfg = { repos: [] } as unknown as OrcaConfig;
const chief: memory.Actor = { kind: "agent", agent: CHIEF, prov: { source: "agent:chief", trust: "trusted" } };
const outside: memory.Actor = { kind: "agent", agent: CHIEF, prov: { source: "outside:discord:D1", trust: "untrusted" } };

async function call(method: "GET" | "POST", path: string, body: Record<string, unknown> = {}): Promise<{ status: number; data: Record<string, unknown> }> {
  const url = new URL(`http://x${path}`);
  const res = await handleMemory(new Request(url, { method, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) }), url, body);
  if (!res) throw new Error(`not a memory route: ${path}`);
  return { status: res.status, data: await res.json() as Record<string, unknown> };
}

describe("pure rules", () => {
  test("the URL query: defaults, round trip, unknown values dropped", () => {
    expect(parseMemoryQuery("")).toEqual({ q: "", owners: [], states: ["active"], sources: [], trust: [], pinned: false, tag: "", sort: "updated" });
    const q = parseMemoryQuery("?q=deploy&owner=chief,shared&state=active,archived&source=outside&trust=untrusted&pinned=1&tag=rule&sort=core");
    expect(q).toEqual({ q: "deploy", owners: ["chief", "shared"], states: ["active", "archived"], sources: ["outside"], trust: ["untrusted"], pinned: true, tag: "rule", sort: "core" });
    expect(parseMemoryQuery(memoryQueryString(q))).toEqual(q);
    expect(memoryQueryString(parseMemoryQuery(""))).toBe("");
    expect(memoryQueryString(parseMemoryQuery(""), { tab: "core", m: "3" })).toBe("?tab=core&m=3");
    expect(parseMemoryQuery("?state=gone&sort=random&source=martian")).toMatchObject({ states: ["active"], sort: "updated", sources: [] });
  });

  test("source kinds, the filter and the sorts", () => {
    expect(["user", "agent:chief", "outside:discord:D1", "migration:notes"].map(sourceKind)).toEqual(["user", "agent", "outside", "migration"]);
    const m = (o: Partial<Memory>): Memory => ({ id: 1, owner: "chief", title: "t", body: "b", tags: [], importance: 5, pinned: false, source: "agent:chief", trust: "trusted", state: "active", revision: 1, createdBy: "x", updatedBy: "x", createdAt: 0, updatedAt: 0, recallCount: 0, ...o });
    const list = [m({ id: 1, updatedAt: 3, importance: 2 }), m({ id: 2, updatedAt: 2, importance: 9, trust: "untrusted", source: "outside:x" }), m({ id: 3, updatedAt: 1, pinned: true, tags: ["rule"], recallCount: 5 }), m({ id: 4, state: "archived" })];
    const ids = (s: string) => filterMemories(list, parseMemoryQuery(s), 10).map((x) => x.id);
    expect(ids("")).toEqual([1, 2, 3]);
    expect(ids("?sort=importance")).toEqual([2, 3, 1]);
    expect(ids("?sort=recalls")).toEqual([3, 1, 2]);
    expect(ids("?trust=untrusted")).toEqual([2]);
    expect(ids("?source=outside")).toEqual([2]);
    expect(ids("?pinned=1")).toEqual([3]);
    expect(ids("?tag=rule")).toEqual([3]);
    expect(ids("?state=archived")).toEqual([4]);
  });

  test("the line diff", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a" }, { kind: "del", text: "b" }, { kind: "add", text: "B" }, { kind: "same", text: "c" }, { kind: "add", text: "d" },
    ]);
    expect(lineDiff("x", "x")).toEqual([{ kind: "same", text: "x" }]);
  });
});

describe("the API", () => {
  let pg: TestDb;
  let stateDir: string;
  let prev: Record<string, string | undefined> = {};
  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_STATE_DIR: process.env.ORCA_STATE_DIR };
    stateDir = await mkdtemp(join(tmpdir(), "orca-memapi-"));
    process.env.ORCA_STATE_DIR = stateDir;
    pg = await freshSchema("memapi");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
  });
  afterEach(async () => {
    await db.close();
    await pg.drop();
    await rm(stateDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test("list with text search and filters; owners; today's changes per agent", async () => {
    await memory.write({ owner: CHIEF, title: "Deploy window", body: "Deploys only before 15:00.", tags: ["rule"] }, chief);
    await memory.write({ owner: "shared", title: "Sam's merge day", body: "Merges on Friday." }, outside);
    const all = await call("GET", "/api/memory");
    expect((all.data.memories as Memory[]).map((m) => m.title)).toEqual(["Sam's merge day", "Deploy window"]);
    expect(all.data.owners).toEqual(["chief", "assistant", "shared"]); // every agent, then shared
    expect(all.data.today).toEqual({ chief: 2 });
    expect(((await call("GET", "/api/memory?q=deploy")).data.memories as Memory[]).map((m) => m.title)).toEqual(["Deploy window"]);
    expect(((await call("GET", "/api/memory?trust=untrusted")).data.memories as Memory[]).map((m) => m.title)).toEqual(["Sam's merge day"]);
    expect(((await call("GET", "/api/memory?owner=chief&tag=rule")).data.memories as Memory[])).toHaveLength(1);
  });

  test("one memory: links, history and its scheduled wakes; a 404 for a missing one", async () => {
    const a = await memory.write({ owner: CHIEF, title: "Task: watch CI", body: "PR #12." }, chief);
    const b = await memory.write({ owner: CHIEF, title: "PR #12", body: "The cache PR." }, chief);
    await memory.link(a.id, b.id, "about", chief);
    await wakes.add({ agent: CHIEF, at: Date.now() + 3_600_000, note: "Look at CI", memoryId: a.id, by: "agent:chief" });
    const one = await call("GET", `/api/memory/${a.id}`);
    expect(one.status).toBe(200);
    expect(one.data.links).toEqual([{ relation: "about", direction: "out", id: b.id, title: "PR #12", state: "active" }]);
    expect((one.data.revisions as { revision: number }[]).map((r) => r.revision)).toEqual([1]);
    expect((one.data.wakes as { note: string }[]).map((w) => w.note)).toEqual(["Look at CI"]);
    expect((await call("GET", "/api/memory/999")).status).toBe(404);
  });

  test("the user writes, pins, trusts, archives, restores and reverts — each a revision by user", async () => {
    const created = await call("POST", "/api/memory", { owner: "shared", title: "Review hours", body: "Mornings.", tags: "preference, time", importance: 7 });
    const m = created.data.memory as Memory;
    expect(m).toMatchObject({ owner: "shared", trust: "trusted", source: "user", createdBy: "user", tags: ["preference", "time"], importance: 7 });
    const id = m.id;
    expect(((await call("POST", `/api/memory/${id}`, { action: "edit", body: "Mornings, before 11:00." })).data.memory as Memory).revision).toBe(2);
    expect(((await call("POST", `/api/memory/${id}`, { action: "pin" })).data.memory as Memory).pinned).toBe(true);
    // An agent cannot change it now, and has no verb to unpin or trust.
    await expect(memory.revise(id, { body: "x" }, chief, { base: 3, reason: "r" })).rejects.toThrow("is pinned by the user");
    await expect(orchestrator.tool(cfg, "memory", { _: ["pin", String(id)] })).rejects.toThrow('unknown memory command "pin"');
    await expect(orchestrator.tool(cfg, "memory", { _: ["trust", String(id)] })).rejects.toThrow('unknown memory command "trust"');
    expect(((await call("POST", `/api/memory/${id}`, { action: "state", state: "archived" })).data.memory as Memory).state).toBe("archived");
    expect(((await call("POST", `/api/memory/${id}`, { action: "state", state: "active" })).data.memory as Memory).state).toBe("active");
    const reverted = (await call("POST", `/api/memory/${id}`, { action: "revert", revision: 1 })).data.memory as Memory;
    expect(reverted).toMatchObject({ body: "Mornings.", pinned: false, revision: 6 });
    const history = await memory.revisions(id);
    expect(history.map((r) => [r.revision, r.by, r.reason])).toEqual([
      [6, "user", "revert to r1"], [5, "user", "restored by the user"], [4, "user", "archived by the user"],
      [3, "user", "pinned"], [2, "user", "edited by the user"], [1, "user", "written by the user"],
    ]);
    const activity = await call("GET", "/api/memory/activity");
    expect((activity.data.revisions as { revision: number; title: string }[]).slice(0, 2).map((r) => [r.revision, r.title])).toEqual([[6, "Review hours"], [5, "Review hours"]]);
  });

  test("mark trusted lifts an untrusted memory; bad input answers 400", async () => {
    const m = await memory.write({ owner: CHIEF, title: "From Discord", body: "Sam says X." }, outside);
    expect(((await call("POST", `/api/memory/${m.id}`, { action: "trust" })).data.memory as Memory).trust).toBe("trusted");
    expect((await call("POST", `/api/memory/${m.id}`, { action: "explode" })).status).toBe(400);
    expect((await call("POST", `/api/memory/${m.id}`, { action: "state", state: "gone" })).status).toBe(400);
    expect((await call("POST", "/api/memory", { title: "", body: "" })).status).toBe(400);
    expect((await call("POST", `/api/memory/${m.id}`, { action: "revert", revision: 99 })).status).toBe(404);
  });

  test("the reflection log for the page: newest pass first", async () => {
    const read = { turns: 2, userMessages: 1, reports: 1, checks: 0, failedChecks: 0, failedReports: 0, corrections: 1, repeated: 0, changedMemories: 0, lowest: 0, pairs: 0, contradictions: 0 };
    await memory.startPass({ agent: CHIEF, runId: "p1", trigger: "idle", read, startedAt: 1000 });
    await memory.finishPass("p1", "done", "ok", 2000);
    await memory.startPass({ agent: CHIEF, runId: "p2", trigger: "request", since: 2000, read, startedAt: 3000 });
    const log = await call("GET", "/api/memory/reflections");
    expect((log.data.passes as { runId: string; state: string; trigger: string }[]).map((p) => [p.runId, p.state, p.trigger])).toEqual([["p2", "running", "request"], ["p1", "done", "idle"]]);
  });

  test("the core for the page: what the agent gets, with its tokens and the pinned warning line", async () => {
    await memory.write({ owner: CHIEF, title: "Rule", body: "A rule." }, chief);
    const core = await call("GET", "/api/memory/core?agent=chief");
    expect(core.data).toMatchObject({ budget: 4000, pinnedWarn: 2000, leftOut: 0 });
    expect((core.data.items as { memory: Memory }[]).map((i) => i.memory.title)).toEqual(["Rule"]);
    expect(core.data.tokens).toBeGreaterThan(0);
    expect(await handleMemory(new Request("http://x/api/other"), new URL("http://x/api/other"), {})).toBeUndefined();
  });
});
