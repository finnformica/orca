// Self-set wakes (`orca wake`, server/scheduledWake.ts, shared/scheduledWake.ts): the pure parsers and
// matcher, then the store against real Postgres — a due wake fires once, an event wake fires on a
// matching published event only, expiry, the pending limit, and a paused orchestrator holds it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as orchestrator from "../server/orchestrator";
import * as router from "../server/integrations/router";
import * as wakes from "../server/scheduledWake";
import * as memory from "../server/memory";
import type { OrcaConfig } from "../server/config";
import { grantRefusal, notificationEnvelope } from "../shared/integrations";
import {
  SCHEDULED_WAKE_MARKER, WAKE_LIMITS, isScheduledWake, parseDuration, parseScheduledWake, parseWakeAt, parseWakeOn, scheduledWakeMessage, wakeMatches, wakeOnText,
} from "../shared/scheduledWake";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, isUserMessage, turnSource } from "../web/src/workstream";
import { freshSchema, type TestDb } from "./pg";

const cfg = { repos: [{ name: "r", repoPath: "/nope", worktreeRoot: "/nope", baseBranch: "main", previewServices: [] }] } as unknown as OrcaConfig;
const NOW = Date.parse("2026-10-25T12:00:00Z");
const H = 3_600_000;
const LIMITS = { ...WAKE_LIMITS };

describe("pure rules", () => {
  test("--at: a length, today/tomorrow at a time, an ISO time; 5 minutes to 90 days ahead", () => {
    expect(parseDuration("90m")).toBe(90 * 60_000);
    expect(parseDuration("+2h")).toBe(2 * H);
    expect(parseDuration("1w")).toBe(7 * 24 * H);
    expect(parseDuration("soon")).toBeUndefined();
    expect(parseWakeAt("2h", NOW)).toBe(NOW + 2 * H);
    expect(parseWakeAt("2026-10-27T09:00Z", NOW)).toBe(Date.parse("2026-10-27T09:00Z"));
    const tomorrow = new Date(parseWakeAt("tomorrow 09:00", NOW));
    expect([tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([9, 0]);
    expect(tomorrow.getTime()).toBeGreaterThan(NOW);
    expect(() => parseWakeAt("1m", NOW)).toThrow("at least 5 minutes from now");
    expect(() => parseWakeAt("100d", NOW)).toThrow("at most 90 days");
    expect(() => parseWakeAt("next week-ish", NOW)).toThrow('--at "next week-ish" is not a time');
  });

  test("--on: three patterns, written back the same; a bad one says what is allowed", () => {
    for (const t of ["pr:r#12", "pr:r#12:merged", "worker:r/orca/add-cache", "topic:orca.pr.*", "topic:ext.discord.message repo=r"]) expect(wakeOnText(parseWakeOn(t))).toBe(t);
    expect(() => parseWakeOn("pr:r#12:closed")).toThrow("is not a PR event");
    expect(() => parseWakeOn("tomorrow")).toThrow("is not an event: use pr:<repo>#<n>");
  });

  test("the match reads the event's topic, repo, branch and PR", () => {
    const merged = { topic: "orca.pr.merged", scope: { repo: "r", branch: "b" }, link: { pr: 12 } };
    expect(wakeMatches(parseWakeOn("pr:r#12"), merged)).toBe(true);
    expect(wakeMatches(parseWakeOn("pr:r#12:merged"), merged)).toBe(true);
    expect(wakeMatches(parseWakeOn("pr:r#12:ci_failed"), merged)).toBe(false);
    expect(wakeMatches(parseWakeOn("pr:r#13"), merged)).toBe(false);
    expect(wakeMatches(parseWakeOn("pr:other#12"), merged)).toBe(false);
    const run = { topic: "orca.run.failed", scope: { repo: "r", branch: "orca/x" } };
    expect(wakeMatches(parseWakeOn("worker:r/orca/x"), run)).toBe(true);
    expect(wakeMatches(parseWakeOn("worker:r/orca/y"), run)).toBe(false);
    expect(wakeMatches(parseWakeOn("worker:r/orca/x"), { ...merged, scope: run.scope })).toBe(false); // a PR event is no run result
    expect(wakeMatches(parseWakeOn("topic:orca.run.*"), run)).toBe(true);
    expect(wakeMatches(parseWakeOn("topic:orca.run.* repo=q"), run)).toBe(false);
  });

  test("the message: marked, parsed back, never the user's word, and a wake of it alone is the agents'", () => {
    const at = scheduledWakeMessage({ id: 4, note: "Check PR #12 CI", memoryId: 9, at: NOW });
    expect(at).toBe(`${SCHEDULED_WAKE_MARKER} w4 · at 2026-10-25 12:00 UTC · memory m9\nCheck PR #12 CI`);
    expect(parseScheduledWake(at)).toEqual({ id: 4, note: "Check PR #12 CI", at: NOW, memoryId: 9 });
    const on = scheduledWakeMessage({ id: 5, note: "Look at the merge", on: "topic:orca.pr.* repo=r", event: "orca.pr.merged" });
    expect(parseScheduledWake(on)).toEqual({ id: 5, note: "Look at the merge", on: "topic:orca.pr.* repo=r", event: "orca.pr.merged" });
    expect(isScheduledWake(on)).toBe(true);
    expect(isUserMessage(on)).toBe(false);
    expect(turnSource([on])).toBe("agents");
    expect(turnSource([on, "hello"])).toBe("human");
  });

  test("an outside grant lists wakes under ask, and sets or cancels them only under work", () => {
    expect(grantRefusal({ level: "ask", repos: [] }, "wake", { _: ["list"] })).toBeUndefined();
    expect(grantRefusal({ level: "ask", repos: [] }, "wake", { _: [], at: "2h" })).toContain('"wake" needs "work"');
    expect(grantRefusal({ level: "work", repos: [] }, "wake", { _: ["cancel", "3"] })).toBeUndefined();
  });
});

describe("the store", () => {
  let pg: TestDb;
  let stateDir: string;
  let prev: Record<string, string | undefined> = {};
  const delivered: string[] = [];
  const deliver = async (t: string) => { delivered.push(t); };

  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_STATE_DIR: process.env.ORCA_STATE_DIR };
    stateDir = await mkdtemp(join(tmpdir(), "orca-wake-"));
    process.env.ORCA_STATE_DIR = stateDir;
    pg = await freshSchema("wake");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    delivered.length = 0;
  });
  afterEach(async () => {
    Object.assign(WAKE_LIMITS, LIMITS);
    await db.close();
    await pg.drop();
    await rm(stateDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test("orca wake sets, lists and cancels; a due wake fires once over two ticks", async () => {
    const set = await wakes.wakeTool("chief", [], { at: "2h", note: "Check PR #12 CI" }, "run-1", NOW);
    expect(set).toBe("Set w1 at 2026-10-25 14:00 UTC — Check PR #12 CI. It wakes you with the note; nothing else does.");
    await wakes.wakeTool("chief", [], { at: "3h", note: "Second" }, undefined, NOW);
    expect(await wakes.wakeTool("chief", ["list"], {})).toBe("w1 at 2026-10-25 14:00 UTC — Check PR #12 CI\nw2 at 2026-10-25 15:00 UTC — Second");
    expect(await wakes.wakeTool("chief", ["cancel", "w2"], {})).toBe("Cancelled w2.");
    expect(await wakes.wakeTool("chief", ["cancel", "2"], {})).toBe("No pending scheduled wake w2.");
    expect(await wakes.tick(deliver, NOW + H)).toEqual([]);
    const fired = await wakes.tick(deliver, NOW + 2 * H);
    expect(fired.map((w) => w.id)).toEqual([1]);
    expect(await wakes.tick(deliver, NOW + 2 * H + 60_000)).toEqual([]); // claimed once
    expect(delivered).toEqual([`${SCHEDULED_WAKE_MARKER} w1 · at 2026-10-25 14:00 UTC\nCheck PR #12 CI`]);
    expect(await wakes.wakeTool("chief", ["list"], { all: "" })).toContain("w1 [fired] at 2026-10-25 14:00 UTC");
  });

  test("the checks: one of --at and --on, a note, a real memory, the pending limit, and only chief's queue", async () => {
    await expect(wakes.wakeTool("chief", [], { note: "x" }, undefined, NOW)).rejects.toThrow("give exactly one of --at <time> and --on <event>");
    await expect(wakes.wakeTool("chief", [], { at: "2h", on: "pr:r#1", note: "x" }, undefined, NOW)).rejects.toThrow("exactly one");
    await expect(wakes.wakeTool("chief", [], { at: "2h" }, undefined, NOW)).rejects.toThrow("--note is required");
    await expect(wakes.wakeTool("chief", [], { at: "2h", note: "x", memory: "m99" }, undefined, NOW)).rejects.toThrow("no memory m99");
    await expect(wakes.wakeTool("chief", [], { at: "2h", note: "x", agent: "nobody" }, undefined, NOW, ["chief", "assistant"])).rejects.toThrow('there is no agent "nobody" (agents: chief, assistant)');
    // The Chief of Staff sets a wake for another agent; another agent may not (named agents).
    expect(await wakes.wakeTool("chief", [], { at: "2h", note: "x", agent: "assistant" }, undefined, NOW, ["chief", "assistant"])).toContain("for assistant");
    await expect(wakes.wakeTool("assistant", [], { at: "2h", note: "x", agent: "chief" }, undefined, NOW, ["chief", "assistant"], false)).rejects.toThrow("only an agent with every verb");
    const m = await memory.write({ owner: "chief", title: "Task: CI", body: "Watch CI." }, { kind: "user" });
    expect(await wakes.wakeTool("chief", [], { at: "2h", note: "x", memory: `m${m.id}` }, undefined, NOW)).toContain(`· memory m${m.id}`);
    WAKE_LIMITS.pendingMax = 1;
    await expect(wakes.wakeTool("chief", [], { at: "3h", note: "y" }, undefined, NOW)).rejects.toThrow("1 pending scheduled wakes is the limit");
  });

  test("an event wake fires on a matching published event only, once; it expires unfired", async () => {
    // A listener stays for the process (bun runs every file in one): it listens only during this test,
    // or it claims the wakes of another file's tests (prMergedWake.test.ts).
    let listening = true;
    router.onNewEvent((e) => { if (listening) void wakes.onEvent(e, deliver).catch(() => {}); });
    try {
      await wakes.wakeTool("chief", [], { on: "pr:r#12:merged", note: "Tell Finn #12 landed" }, undefined, Date.now());
      await wakes.wakeTool("chief", [], { on: "worker:r/orca/x", note: "Read the run", expires: "1d" }, undefined, Date.now());
      const publish = async (kind: string, key: string, extra: Record<string, unknown>) => {
        await router.publish(notificationEnvelope({ key, kind, repo: "r", title: "t", body: "b", ...extra })!);
        for (let i = 0; i < 40 && delivered.length < 1; i++) await new Promise((r) => setTimeout(r, 25));
      };
      await publish("pr_ci_failed", "pr-ci:r#12@abc", { branch: "b", link: { pr: 12 } });
      await new Promise((r) => setTimeout(r, 100));
      expect(delivered).toEqual([]); // CI failing is not "merged"
      await publish("merged", "merged:r#12", { branch: "b", link: { pr: 12 } });
      expect(delivered).toEqual([`${SCHEDULED_WAKE_MARKER} w1 · on pr:r#12:merged (orca.pr.merged)\nTell Finn #12 landed`]);
      await publish("merged", "merged:r#12:again", { branch: "b", link: { pr: 12 } });
      await new Promise((r) => setTimeout(r, 100));
      expect(delivered).toHaveLength(1); // fired once
      // The worker wake was never matched: two days later it is expired.
      expect(await wakes.expire(Date.now() + 2 * 24 * H)).toBe(1);
      expect((await wakes.list({ all: true })).map((w) => [w.id, w.state]).sort()).toEqual([[1, "fired"], [2, "expired"]]);
    } finally { listening = false; }
  });

  test("a fired wake reaches the orchestrator's queue; a paused orchestrator holds it", async () => {
    await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakes: orchestrator.MAX_WAKES });
    await wakes.wakeTool("chief", [], { at: "10m", note: "Look again" }, undefined, NOW);
    await wakes.tick((t) => orchestrator.deliverReport(cfg, t), NOW + H);
    const queued = await db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH);
    expect(queued.map((q) => q.instruction)).toEqual([`${SCHEDULED_WAKE_MARKER} w1 · at 2026-10-25 12:10 UTC\nLook again`]);
  });
});
