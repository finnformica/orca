// Reflection (docs/design/named-agents-and-memory.md §5): an idle-time pass over the agent's recent
// transcripts and its memory. Pure rules (shared/memory.ts): when a pass starts, the signals it finds
// in the transcript, contradiction candidates, its prompt and its change counts. Then real Postgres:
// what it reads (turns, worker reports, Orca checks, memories), its log (startPass / finishPass),
// merge, the reflection mode's verb list and change cap, and "never while a message waits".
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as memory from "../server/memory";
import * as orchestrator from "../server/orchestrator";
import type { OrcaConfig } from "../server/config";
import {
  CHIEF, REFLECTION, REFLECTION_MARKER, SHARED, contradictionCandidates, isReflection, reflectionChanges, reflectionPrompt, reflectionReadCounts, reflectionRefusal,
  reflectionTrigger, similarPairs, tokensOf, transcriptSignals, type Memory, type ReflectionInput, type ReflectionState, type TranscriptTurn,
} from "../shared/memory";
import { WRITING_STYLE } from "../shared/writingStyle";
import { MESSAGE_BREAK, ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, isUserMessage, turnSource } from "../web/src/workstream";
import { freshSchema, type TestDb } from "./pg";

const H = 3_600_000;
const NOW = 1_800_000_000_000;
const SAVED = { ...REFLECTION, budget: { ...REFLECTION.budget } };
const report = (branch: string, end: string, extra = "") => `[worker finished] r/${branch} "T" — ${end}${extra}\nOutcome: x`;

describe("pure rules", () => {
  const idle: ReflectionState = { idle: true, queued: 0, workersRunning: false, paused: false, coreOver: false, activity: 3 };
  test("a pass starts only in idle time: after 6 hours with something new, when the core is over budget, or on request", () => {
    expect(reflectionTrigger(idle, NOW)).toBe("idle"); // never reflected
    expect(reflectionTrigger({ ...idle, lastAt: NOW - 7 * H }, NOW)).toBe("idle");
    expect(reflectionTrigger({ ...idle, lastAt: NOW - 5 * H }, NOW)).toBeUndefined();
    expect(reflectionTrigger({ ...idle, lastAt: NOW - 7 * H, activity: 0 }, NOW)).toBeUndefined(); // nothing new to read
    expect(reflectionTrigger({ ...idle, lastAt: NOW - 2 * H, coreOver: true }, NOW)).toBe("core");
    expect(reflectionTrigger({ ...idle, lastAt: NOW - 2 * H, coreOver: true, activity: 0 }, NOW)).toBeUndefined();
    expect(reflectionTrigger({ ...idle, lastAt: NOW - 2 * H, requested: true, activity: 0 }, NOW)).toBe("request");
    // An hour apart, whatever asks.
    expect(reflectionTrigger({ ...idle, lastAt: NOW - 30 * 60_000, requested: true, coreOver: true }, NOW)).toBeUndefined();
    // Never while busy: a wake running, a message waiting, a worker running, or paused.
    for (const busy of [{ idle: false }, { queued: 1 }, { workersRunning: true }, { paused: true }]) {
      expect(reflectionTrigger({ ...idle, ...busy, requested: true, coreOver: true }, NOW)).toBeUndefined();
    }
  });

  test("signals from the transcript: corrections, failed worker runs, failed checks, repeated questions", () => {
    const turns: TranscriptTurn[] = [
      { runId: "a", at: NOW - 3 * H, messages: ["Why is CI red on the cache PR?"], response: "Looking.", failed: false },
      { runId: "b", at: NOW - 2 * H, messages: ["No, I said use Sonnet for that.", report("orca/x", "failed")], response: "Sorry.", failed: false },
      { runId: "c", at: NOW - H, messages: [report("orca/y", "done"), report("orca/z", "done", "\nOrca's check `bun run check` FAILED (exit 1):")], response: "ok", failed: false },
      { runId: "d", at: NOW, messages: ["why is CI red on the cache PR again?", "[orca event] r#12 ci failed"], response: "Fixing.", failed: false },
    ];
    // The check line of a report sits on its second line.
    turns[2]!.messages[1] = '[worker finished] r/orca/z "T" — done\nOrca\'s check `bun run check` FAILED (exit 1):\nboom';
    const checks = [{ repo: "r", branch: "orca/z", at: NOW - H, ok: false, command: "bun run check", exitCode: 1, output: "boom" }, { repo: "r", branch: "orca/y", at: NOW - H, ok: true, command: "bun run check", exitCode: 0 }];
    const s = transcriptSignals(turns, checks);
    expect(s.corrections.map((c) => c.text)).toEqual(["No, I said use Sonnet for that."]);
    expect(s.failedReports.map((f) => f.head)).toEqual(['[worker finished] r/orca/x "T" — failed', '[worker finished] r/orca/z "T" — done']);
    expect(s.failedChecks.map((c) => c.branch)).toEqual(["orca/z"]);
    expect(s.repeated).toEqual([{ at: [NOW - 3 * H, NOW], text: "Why is CI red on the cache PR?" }]);
  });

  test("duplicate pairs and contradiction candidates: same title, different body", () => {
    expect(similarPairs([
      { id: 1, lexemes: ["merg", "order", "auth", "seri"] },
      { id: 2, lexemes: ["merg", "order", "auth"] },
      { id: 3, lexemes: ["deploy", "window"] },
      { id: 4, lexemes: ["merg", "order"] },
    ])).toEqual([[1, 2, 0.75], [2, 4, 0.67], [1, 4, 0.5]]);
    expect(contradictionCandidates([
      { id: 1, title: ["deploy", "window"], body: ["deploy", "befor", "four"] },
      { id: 2, title: ["deploy", "window"], body: ["deploy", "never", "friday", "weekend"] },
      { id: 3, title: ["deploy", "window"], body: ["deploy", "befor", "four"] }, // agrees with 1: a duplicate, not a contradiction
      { id: 4, title: ["review", "hour"], body: ["morn"] },
    ])).toEqual([[1, 2], [2, 3]]);
  });

  test("the verbs: reads, memory and wakes only; never spawn, send, post, ask-user, notes set or another reflect", () => {
    for (const ok of [["board"], ["read"], ["memory", "merge"], ["memory", "write"], ["wake", "list"], ["notes"]]) expect(reflectionRefusal(ok[0]!, ok.slice(1))).toBeUndefined();
    for (const no of ["spawn", "send", "post", "ask-user", "merge", "archive", "preview"]) expect(reflectionRefusal(no)).toContain(`not "${no}"`);
    expect(reflectionRefusal("notes", ["set"])).toContain("does not change the notes");
    expect(reflectionRefusal("memory", ["reflect"])).toContain("this IS a reflection");
  });

  test("the prompt: the job, the signals, the transcript newest-first inside its budget, contradictions, the writing style once", () => {
    let id = 1;
    const m = (o: Partial<Memory>): Memory => ({ id: id++, owner: CHIEF, title: "t", body: "b", tags: [], importance: 5, pinned: false, source: "agent:chief", trust: "trusted", state: "active", revision: 1, createdBy: "agent:chief", updatedBy: "agent:chief", createdAt: NOW, updatedAt: NOW, recallCount: 0, ...o });
    const turns: TranscriptTurn[] = Array.from({ length: 60 }, (_, i) => ({ runId: `r${i}`, at: NOW - (60 - i) * 60_000, messages: [`question ${i} ${"x".repeat(600)}`], response: `answer ${i}`, failed: i === 59 }));
    const a = m({ title: "Deploy window", body: "Before 16:00." }), b = m({ title: "Deploy window", body: "Never on Friday." });
    const input: ReflectionInput = {
      agent: CHIEF, trigger: "idle", since: NOW - 2 * H, turns, checks: [], signals: transcriptSignals([{ runId: "x", at: NOW, messages: ["No, I said Sonnet."], response: "", failed: false }], []),
      changed: [m({ title: "Fresh" })], lowest: [m({ title: "Old idea" })], pairs: [], contradictions: [{ a, b }], lastSummary: "Merged two.",
    };
    const text = reflectionPrompt(input, WRITING_STYLE);
    expect(isReflection(text)).toBe(true);
    expect(text).toStartWith(`${REFLECTION_MARKER} A reflection pass (idle).`);
    expect(text).toContain("Find what went right and what went wrong");
    expect(text).toContain("tagged `lesson`");
    expect(text).toContain('`--reason "contradicts m<id>: <why>"`');
    expect(text).toContain("You may change at most 40 memories.");
    expect(text).toContain("## Signals (found by Orca)\n- Correction (");
    // The newest turns are kept, in time order; the oldest are left out and counted.
    expect(text).toMatch(/## Transcript since your last pass \(60 turns, the oldest \d+ not shown\)/);
    expect(text).toContain("run r59 · FAILED");
    expect(text).not.toContain("run r0 ");
    expect(text.indexOf("run r58")).toBeLessThan(text.indexOf("run r59"));
    expect(text).toContain(`- m${a.id} "Deploy window" vs m${b.id} "Deploy window"`);
    expect(text).toContain("## Your last pass\nMerged two.");
    expect(text.split(WRITING_STYLE).length - 1).toBe(1);
    const budget = Object.values(REFLECTION.budget).reduce((x, y) => x + y, 0);
    expect(tokensOf(text)).toBeLessThan(budget + tokensOf(WRITING_STYLE) + 800);
    expect(reflectionReadCounts(input)).toMatchObject({ turns: 60, userMessages: 60, corrections: 1, contradictions: 1, changedMemories: 1, lowest: 1 });
    // A reflection is never the user's word, and a turn of it alone is the agents'.
    expect(isUserMessage(`${REFLECTION_MARKER} idle`)).toBe(false);
    expect(turnSource([`${REFLECTION_MARKER} idle`])).toBe("agents");
  });

  test("what a pass changed, from its run's revisions", () => {
    expect(reflectionChanges([
      { memoryId: 1, revision: 1, state: "active", tags: ["lesson"], reason: "a lesson" },
      { memoryId: 2, revision: 1, state: "active", tags: [], reason: "merged" },
      { memoryId: 3, revision: 4, state: "archived", tags: [], reason: "merged into m2" },
      { memoryId: 4, revision: 2, state: "forgotten", tags: [], reason: "contradicts m5: Finn changed it" },
      { memoryId: 5, revision: 3, state: "active", tags: [], reason: "clearer" },
      { memoryId: 6, revision: 2, state: "archived", tags: [], reason: "done" },
    ], 2)).toEqual({ written: 2, lessons: 1, revised: 1, merged: 1, archived: 1, forgotten: 1, contradictions: 1, linked: 2, total: 6 });
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
    Object.assign(REFLECTION, SAVED, { budget: { ...SAVED.budget } });
    await db.close();
    await pg.drop();
    await rm(stateDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const blob = async () => (await db.enrichment(ORCHESTRATOR_REPO))[ORCHESTRATOR_BRANCH] ?? {};
  /** One finished turn of the orchestrator (its messages joined as a wake joins them). */
  async function orchTurn(runId: string, at: number, messages: string[], response: string, status: "done" | "error" = "done") {
    await db.startTurn({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH, runId, provider: "claude", instruction: messages.join(MESSAGE_BREAK), prompt: "p", startedAt: at });
    await db.finishTurn(runId, { status, response, finishedAt: at + 1000 });
  }

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

  test("the input reads transcripts since the last pass — turns, worker reports, Orca checks — and the memories", async () => {
    const since = NOW - 3 * H;
    await orchTurn("old", NOW - 5 * H, ["before the last pass"], "x");
    await orchTurn("t1", NOW - 2 * H, ["No, I said use Sonnet for small fixes.", report("orca/x", "failed")], "Noted.");
    await orchTurn("refl", NOW - 90 * 60_000, [`${REFLECTION_MARKER} idle: 1 turns`], "summary"); // a pass reads no pass
    await orchTurn("t2", NOW - H, ["Deploy the cache fix."], "Spawned.", "error");
    // A worker run the orchestrator owns, with Orca's check on it.
    await db.patchEnrichment("r", "orca/x", { orchestrated: true });
    await db.startTurn({ repo: "r", branch: "orca/x", runId: "w1", provider: "claude", instruction: "fix", prompt: "p", startedAt: NOW - 2 * H });
    await db.setCheck("w1", { command: "bun run check", ok: false, exitCode: 1, output: "1 test failed", durationMs: 5 });
    const old = await memory.write({ owner: CHIEF, title: "Old idea", body: "Something stale.", importance: 1 }, chief, NOW - 40 * 24 * H);
    await memory.write({ owner: CHIEF, title: "Deploy window rule", body: "Deploy only before four in the afternoon." }, chief, NOW);
    await memory.write({ owner: SHARED, title: "Deploy window rule", body: "Deploys may run any time, weekends too." }, chief, NOW);
    await memory.write({ owner: SHARED, title: "Deploy window", body: "Deploy only before four in the afternoon, never later." }, chief, NOW);

    const input = await memory.reflectionInput(CHIEF, { since, trigger: "idle", lastSummary: "last time" }, NOW);
    expect(input.turns.map((t) => [t.runId, t.messages.length, t.failed])).toEqual([["t1", 2, false], ["t2", 1, true]]);
    expect(input.checks).toEqual([{ repo: "r", branch: "orca/x", at: NOW - 2 * H, ok: false, command: "bun run check", exitCode: 1, output: "1 test failed" }]);
    expect(input.signals.corrections.map((c) => c.text)).toEqual(["No, I said use Sonnet for small fixes."]);
    expect(input.signals.failedReports).toHaveLength(1);
    expect(input.signals.failedChecks).toHaveLength(1);
    expect(input.lowest[0]!.id).toBe(old.id);
    // "Any time" clashes with both "before four" memories; the two "before four" ones agree (a duplicate pair, not a clash).
    expect(input.contradictions.map((c) => [c.a.body, c.b.body].sort()).sort()).toEqual([
      ["Deploy only before four in the afternoon, never later.", "Deploys may run any time, weekends too."],
      ["Deploy only before four in the afternoon.", "Deploys may run any time, weekends too."],
    ]);
    expect(input.pairs.map((p) => [p.a.body, p.b.body].sort())).toEqual([["Deploy only before four in the afternoon, never later.", "Deploy only before four in the afternoon."]]);
    expect(input.lastSummary).toBe("last time");
    expect(await memory.activitySince(CHIEF, since)).toBe(2 + 3); // two turns (no pass's turn) and three memory writes after `since`
  });

  test("the log: a pass is written at launch with what it read, and finished with what its run changed", async () => {
    await memory.startPass({ agent: CHIEF, runId: "pass-1", trigger: "idle", read: { turns: 4, userMessages: 3, reports: 2, checks: 1, failedChecks: 1, failedReports: 1, corrections: 1, repeated: 0, changedMemories: 2, lowest: 3, pairs: 0, contradictions: 1, tokens: 900 }, startedAt: NOW });
    expect((await memory.lastPass(CHIEF))).toMatchObject({ runId: "pass-1", state: "running", at: NOW });
    const actor: memory.Actor = { kind: "agent", agent: CHIEF, runId: "pass-1", prov: { source: "agent:chief", trust: "trusted" } };
    const lesson = await memory.write({ owner: CHIEF, title: "Lesson: small fixes on Sonnet", body: "Finn wants Sonnet for small fixes.", tags: ["lesson"], reason: "a correction" }, actor, NOW + 1000);
    const wrong = await memory.write({ owner: CHIEF, title: "Fixes on Opus", body: "Use Opus." }, chief, NOW - H);
    await memory.setState(wrong.id, "forgotten", actor, { base: 1, reason: `contradicts m${lesson.id}: Finn corrected it` }, NOW + 2000);
    await memory.link(lesson.id, wrong.id, "replaces", actor, NOW + 3000);
    const done = await memory.finishPass("pass-1", "done", "Wrote one lesson. Forgot one wrong memory.", NOW + 5000);
    expect(done).toMatchObject({ state: "done", finishedAt: NOW + 5000, summary: "Wrote one lesson. Forgot one wrong memory.", trigger: "idle" });
    expect(done!.changed).toEqual({ written: 1, lessons: 1, revised: 0, merged: 0, archived: 0, forgotten: 1, contradictions: 1, linked: 1, total: 2 });
    expect(done!.memoryIds.sort()).toEqual([lesson.id, wrong.id].sort());
    expect(done!.read).toMatchObject({ turns: 4, corrections: 1, tokens: 900 });
    // Only a running row changes; the next pass reads from its end.
    expect((await memory.finishPass("pass-1", "failed", "late"))!.state).toBe("done");
    expect((await memory.lastPass(CHIEF))!.at).toBe(NOW + 5000);
    expect((await memory.passes()).map((p) => p.runId)).toEqual(["pass-1"]);
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

  test("orca memory reflect asks at most once an hour; no pass starts while a message waits", async () => {
    expect(await orchestrator.tool(cfg, "memory", { _: ["reflect"] })).toStartWith("Asked.");
    expect((await blob()).reflectRequested).toBeGreaterThan(0);
    await db.queueMessage({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH, worktreePath: orchestrator.dir(), instruction: "hello", attachments: [], provider: "claude" });
    expect(await orchestrator.maybeReflect(cfg)).toBeUndefined();
    await memory.startPass({ agent: CHIEF, runId: "p0", trigger: "idle", read: reflectionReadCounts({ agent: CHIEF, trigger: "idle", turns: [], checks: [], signals: transcriptSignals([], []), changed: [], lowest: [], pairs: [], contradictions: [] }), startedAt: Date.now() - 30 * 60_000 });
    await memory.finishPass("p0", "done", "x", Date.now() - 20 * 60_000);
    expect(await orchestrator.tool(cfg, "memory", { _: ["reflect"] })).toStartWith("Not now: the last reflection pass ended 20 minutes ago");
  });
});
