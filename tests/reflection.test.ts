// Reflection (docs/design/named-agents-and-memory.md §5): when it is due, what it reads, what it may
// do. Pure rules (shared/memory.ts), then the store and the orchestrator's tool route against real
// Postgres: merge, the reflection mode's verb list and its change cap, and "never while a message waits".
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as memory from "../server/memory";
import * as orchestrator from "../server/orchestrator";
import type { OrcaConfig } from "../server/config";
import {
  CHIEF, REFLECTION, REFLECTION_MARKER, SHARED, isReflection, reflectionDue, reflectionPrompt, reflectionRefusal, similarPairs, tokensOf, type Memory,
} from "../shared/memory";
import { WRITING_STYLE } from "../shared/writingStyle";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, isUserMessage, turnSource } from "../web/src/workstream";
import { freshSchema, type TestDb } from "./pg";

const H = 3_600_000;
const NOW = 1_800_000_000_000;
const SAVED = { ...REFLECTION };

describe("pure rules", () => {
  const idle = { changes: 0, idle: true, queued: 0, paused: false };
  test("due: 15 changes, or a day with one, or on request — never busy, queued, paused, or within 6 hours", () => {
    expect(reflectionDue({ ...idle, changes: 15 }, NOW)).toBe(true);
    expect(reflectionDue({ ...idle, changes: 14, lastAt: NOW - 2 * H }, NOW)).toBe(false);
    expect(reflectionDue({ ...idle, changes: 1, lastAt: NOW - 25 * H }, NOW)).toBe(true);
    expect(reflectionDue({ ...idle, changes: 1 }, NOW)).toBe(true); // never reflected
    expect(reflectionDue({ ...idle, changes: 0, lastAt: NOW - 48 * H }, NOW)).toBe(false); // nothing to tidy
    expect(reflectionDue({ ...idle, requested: true, lastAt: NOW - 7 * H }, NOW)).toBe(true);
    expect(reflectionDue({ ...idle, changes: 99, lastAt: NOW - 5 * H }, NOW)).toBe(false);
    expect(reflectionDue({ ...idle, changes: 99, requested: true, lastAt: NOW - 5 * H }, NOW)).toBe(false);
    expect(reflectionDue({ ...idle, changes: 99, idle: false }, NOW)).toBe(false);
    expect(reflectionDue({ ...idle, changes: 99, queued: 1 }, NOW)).toBe(false);
    expect(reflectionDue({ ...idle, changes: 99, paused: true }, NOW)).toBe(false);
  });

  test("duplicate pairs: the most overlap first, above the threshold only", () => {
    expect(similarPairs([
      { id: 1, lexemes: ["merg", "order", "auth", "seri"] },
      { id: 2, lexemes: ["merg", "order", "auth"] },
      { id: 3, lexemes: ["deploy", "window"] },
      { id: 4, lexemes: ["merg", "order"] },
    ])).toEqual([[1, 2, 0.75], [2, 4, 0.67], [1, 4, 0.5]]);
  });

  test("the verbs: reads, memory and wakes only; never spawn, send, post, ask-user, notes set or another reflect", () => {
    for (const ok of [["board"], ["read"], ["memory", "merge"], ["memory", "write"], ["wake", "list"], ["notes"]]) expect(reflectionRefusal(ok[0]!, ok.slice(1))).toBeUndefined();
    for (const no of ["spawn", "send", "post", "ask-user", "merge", "archive", "preview"]) expect(reflectionRefusal(no)).toContain(`not "${no}"`);
    expect(reflectionRefusal("notes", ["set"])).toContain("does not change the notes");
    expect(reflectionRefusal("memory", ["reflect"])).toContain("this IS a reflection");
  });

  test("the prompt: the marker, the rules, the candidates, the writing style once, inside its budget", () => {
    let id = 1;
    const m = (o: Partial<Memory>): Memory => ({ id: id++, owner: CHIEF, title: "t", body: "b", tags: [], importance: 5, pinned: false, source: "agent:chief", trust: "trusted", state: "active", revision: 1, createdBy: "agent:chief", updatedBy: "agent:chief", createdAt: NOW, updatedAt: NOW, recallCount: 0, ...o });
    const changed = Array.from({ length: 80 }, (_, i) => m({ title: `changed ${i}`, body: "c".repeat(400) }));
    const a = m({ title: "Merge order" }), b = m({ title: "Merge order again" });
    const old = m({ title: "Old idea" });
    const text = reflectionPrompt({ agent: CHIEF, changed, lowest: [old], pairs: [{ a, b, overlap: 0.8 }], lastSummary: "Merged two." }, WRITING_STYLE);
    expect(isReflection(text)).toBe(true);
    expect(text.startsWith(`${REFLECTION_MARKER} A reflection on your memory.`)).toBe(true);
    expect(text).toContain("orca memory merge <id> <id>…");
    expect(text).toContain("You may change at most 40 memories.");
    expect(text).toContain("## Changed since your last reflection\n[m1 r1] changed 0");
    expect(text).toMatch(/\(\d+ more not shown\)/);
    expect(text).toContain(`## Least used (candidates to archive)\n[m${old.id} r1] Old idea`);
    expect(text).toContain(`- m${a.id} "Merge order" ~ m${b.id} "Merge order again" (overlap 0.8)`);
    expect(text).toContain("## Your last reflection\nMerged two.");
    expect(text.split(WRITING_STYLE).length - 1).toBe(1);
    expect(tokensOf(text)).toBeLessThan(REFLECTION.inputTokens + tokensOf(WRITING_STYLE) + 600);
    // A reflection is never the user's word, and a turn of it alone is the agents'.
    expect(isUserMessage(`${REFLECTION_MARKER} 3 changed`)).toBe(false);
    expect(turnSource([`${REFLECTION_MARKER} 3 changed`])).toBe("agents");
  });
});

describe("against Postgres", () => {
  const cfg = { repos: [{ name: "r", repoPath: "/nope", worktreeRoot: "/nope", baseBranch: "main", previewServices: [] }] } as unknown as OrcaConfig;
  const chief: memory.Actor = { kind: "agent", agent: CHIEF, runId: "run-r", prov: { source: "agent:chief", trust: "trusted" } };
  let pg: TestDb;
  let stateDir: string;
  let prev: Record<string, string | undefined> = {};
  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_STATE_DIR: process.env.ORCA_STATE_DIR };
    stateDir = await mkdtemp(join(tmpdir(), "orca-reflect-"));
    process.env.ORCA_STATE_DIR = stateDir;
    pg = await freshSchema("reflect");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
  });
  afterEach(async () => {
    Object.assign(REFLECTION, SAVED);
    await db.close();
    await pg.drop();
    await rm(stateDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const blob = async () => (await db.enrichment(ORCHESTRATOR_REPO))[ORCHESTRATOR_BRANCH] ?? {};

  test("merge: one new memory, the sources archived and linked; an untrusted source keeps it untrusted", async () => {
    const a = await memory.write({ owner: CHIEF, title: "Merge order", body: "PR 1 first." }, chief);
    const b = await memory.write({ owner: SHARED, title: "Merge order (shared)", body: "PR 1 then PR 2." }, chief);
    const c = await memory.write({ owner: CHIEF, title: "Sam on merges", body: "Sam says Friday." }, { ...chief, prov: { source: "outside:discord:D1", trust: "untrusted" } } as memory.Actor);
    const clean = await memory.merge([a.id, b.id], { title: "The merge order", body: "PR 1, then PR 2.", reason: "same thing" }, chief);
    expect(clean).toMatchObject({ owner: CHIEF, trust: "trusted", importance: 5 });
    expect((await memory.get(a.id))).toMatchObject({ state: "archived", revision: 2 });
    expect((await memory.links(clean.id)).map((l) => [l.direction, l.relation, l.id]).sort()).toEqual([["in", "merged into", a.id], ["in", "merged into", b.id]].sort());
    const tainted = await memory.merge([clean.id, c.id], { title: "Merges, all of it", body: "PR order; Sam's Friday ask.", reason: "tidy" }, chief);
    expect(tainted).toMatchObject({ trust: "untrusted", source: "outside:discord:D1" });
    await expect(memory.merge([a.id], { title: "x", body: "y", reason: "r" }, chief)).rejects.toThrow("at least two");
    const theirs = await memory.write({ owner: "assistant", title: "Theirs", body: "x" }, { kind: "user" });
    await expect(memory.merge([tainted.id, theirs.id], { title: "x", body: "y", reason: "r" }, chief)).rejects.toThrow('belongs to "assistant"');
  });

  test("the reflection's input: what changed since, the least used, the duplicate pairs", async () => {
    const old = await memory.write({ owner: CHIEF, title: "Old idea", body: "Something stale.", importance: 1 }, chief, NOW - 40 * 24 * H);
    await memory.write({ owner: CHIEF, title: "Deploy window rule", body: "Deploy only before four in the afternoon." }, chief, NOW);
    await memory.write({ owner: SHARED, title: "Deploy window", body: "Deploy only before four in the afternoon, never later." }, chief, NOW);
    const input = await memory.reflectionInput(CHIEF, NOW - H, "last time", NOW);
    expect(input.changed.map((m) => m.title).sort()).toEqual(["Deploy window", "Deploy window rule"]);
    expect(input.lowest[0]!.id).toBe(old.id);
    expect(input.pairs.map((p) => [p.a.title, p.b.title].sort())).toEqual([["Deploy window", "Deploy window rule"]]);
    expect(input.lastSummary).toBe("last time");
  });

  test("in a reflection the server refuses spawn and post, and caps memory changes", async () => {
    REFLECTION.maxChanges = 2;
    await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakeMode: "reflect", handling: { runId: "run-refl", instance: "local", messages: [] } });
    await expect(orchestrator.tool(cfg, "spawn", { repo: "r", title: "x" })).rejects.toThrow('refused: a reflection may only read and tidy memory and wakes');
    await expect(orchestrator.tool(cfg, "post", { link: "D1", _: ["hi"] })).rejects.toThrow('not "post"');
    await orchestrator.tool(cfg, "memory", { _: ["write"], title: "Lesson one", body: "x", tag: "lesson" });
    await orchestrator.tool(cfg, "memory", { _: ["write"], title: "Lesson two", body: "y" });
    await expect(orchestrator.tool(cfg, "memory", { _: ["write"], title: "Lesson three", body: "z" })).rejects.toThrow("2 memory changes in one wake is the limit");
    expect(await orchestrator.tool(cfg, "board")).toBeString();
  });

  test("orca memory reflect asks once each 6 hours; a due reflection never starts while a message waits", async () => {
    expect(await orchestrator.tool(cfg, "memory", { _: ["reflect"] })).toStartWith("Asked.");
    expect((await blob()).reflectRequested).toBeGreaterThan(0);
    await db.queueMessage({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH, worktreePath: orchestrator.dir(), instruction: "hello", attachments: [], provider: "claude" });
    expect(await orchestrator.maybeReflect(cfg)).toBeUndefined();
    await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { lastReflection: { at: Date.now() - H, runId: "r0" } });
    expect(await orchestrator.tool(cfg, "memory", { _: ["reflect"] })).toStartWith("Not now: the last reflection ended 60 minutes ago");
  });
});
