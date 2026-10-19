// The box-wide heavy-command queue (server/heavy.ts) and its CLI (bin/worker/orca-run) plus the
// shims beside it. The slot manager runs with a fake clock; the CLI and shims run for real against
// a tiny bridge that serves the same `acquireResponse` the real route does.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  acquireResponse, createSlotManager, heavyQueueProblems, heavySettings, HeavyWaitTimeout, scopePrefix,
  type Grant, type HeavyEntry, type HeavySettings, type ReleaseReason, type SlotManager,
} from "../server/heavy";
import { runIdentity } from "../server/agent";
import { HEAVY_COMMANDS, followUpPrompt, heavyQueueRows } from "../web/src/workstream";
import { native } from "./happydom";

const WORKER = join(import.meta.dir, "..", "bin", "worker");
const tick = () => new Promise((r) => setTimeout(r, 0));

function manager(over: Partial<HeavySettings> = {}, deps: { now?: () => number; alive?: (pid: number) => boolean } = {}) {
  const stopped: { entry: HeavyEntry; reason: ReleaseReason }[] = [];
  const s = { ...heavySettings(undefined), ...over };
  const m = createSlotManager({ settings: () => s, stop: (entry, reason) => stopped.push({ entry, reason }), ...deps });
  return { m, stopped };
}
/** Ask for a slot and record when it is granted. */
function ask(m: SlotManager, kind: "e2e" | "test" | "lint" | "build", extra: { runId?: string; pid?: number; signal?: AbortSignal; positions?: number[] } = {}) {
  const r: { grant?: Grant; error?: Error } = {};
  void m.acquire({ kind, command: `${kind} cmd`, runId: extra.runId, pid: extra.pid }, { signal: extra.signal, onQueue: (n) => extra.positions?.push(n) })
    .then((g) => { r.grant = g; }, (e) => { r.error = e; });
  return r;
}

describe("slot manager", () => {
  test("HQ1: per-kind and total limits (defaults for 4 vCPU: e2e 1, test 2, lint 2, build 1, total 3)", async () => {
    const { m } = manager();
    const e1 = ask(m, "e2e"), e2 = ask(m, "e2e");
    await tick();
    expect(e1.grant).toBeDefined();
    expect(e2.grant).toBeUndefined(); // e2e is 1
    const t1 = ask(m, "test"), t2 = ask(m, "test");
    await tick();
    expect(t1.grant && t2.grant).toBeDefined();
    const l1 = ask(m, "lint");
    await tick();
    expect(l1.grant).toBeUndefined(); // total is 3: e2e + 2 tests
    expect(m.view().running).toHaveLength(3);
    expect(m.view().queued.map((q) => q.kind)).toEqual(["e2e", "lint"]);
    t1.grant!.release();
    await tick();
    expect(l1.grant).toBeDefined(); // the e2e head is still blocked by its own kind, so lint goes
    expect(e2.grant).toBeUndefined();
    e1.grant!.release();
    await tick();
    expect(e2.grant).toBeDefined();
  });

  test("HQ2: FIFO within a kind, and each waiter hears its position as it moves", async () => {
    const { m } = manager();
    const first = ask(m, "e2e");
    const pa: number[] = [], pb: number[] = [];
    const a = ask(m, "e2e", { positions: pa }), b = ask(m, "e2e", { positions: pb });
    await tick();
    expect(pa).toEqual([0]);
    expect(pb).toEqual([1]);
    first.grant!.release();
    await tick();
    expect(a.grant).toBeDefined();
    expect(b.grant).toBeUndefined();
    expect(pb).toEqual([1, 0]);
    a.grant!.release();
    a.grant!.release(); // idempotent: a second release frees nothing more
    await tick();
    expect(b.grant).toBeDefined();
    expect(m.view().running).toHaveLength(1);
  });

  test("HQ3: a run that ends frees its slots, stops their commands and drops its queued jobs", async () => {
    const { m, stopped } = manager();
    const mine = ask(m, "e2e", { runId: "run-a" });
    const other = ask(m, "e2e", { runId: "run-b" });
    const mineQueued = ask(m, "e2e", { runId: "run-a" });
    await tick();
    let revoked: string | undefined;
    mine.grant!.onRevoke((r) => { revoked = r; });
    expect(m.releaseRun("run-a")).toBe(1);
    await tick();
    expect(revoked).toBe("run-ended");
    expect(stopped.map((s) => [s.entry.runId, s.reason])).toEqual([["run-a", "run-ended"]]);
    expect(mineQueued.error?.message).toMatch(/run ended/);
    expect(other.grant).toBeDefined();
  });

  test("HQ4: max wait — a job queued too long fails with a clear message and leaves the queue", async () => {
    const { m } = manager({ maxWaitMs: 30 });
    const holder = ask(m, "build");
    const waiter = ask(m, "build");
    await new Promise((r) => setTimeout(r, 60));
    expect(holder.grant).toBeDefined();
    expect(waiter.error).toBeInstanceOf(HeavyWaitTimeout);
    expect(waiter.error!.message).toMatch(/busy/);
    expect(m.view().queued).toHaveLength(0);
  });

  test("HQ5: max run time and a dead client pid — the sweep takes the slot back", async () => {
    let now = 1_000;
    const dead = new Set<number>();
    const { m, stopped } = manager({ maxRunMs: 60_000 }, { now: () => now, alive: (pid) => !dead.has(pid) });
    const slow = ask(m, "test", { pid: 11 });
    const gone = ask(m, "test", { pid: 22 });
    const next = ask(m, "test", { pid: 33 });
    await tick();
    const reasons: string[] = [];
    slow.grant!.onRevoke((r) => reasons.push(`slow:${r}`));
    gone.grant!.onRevoke((r) => reasons.push(`gone:${r}`));
    dead.add(22);
    m.sweep();
    expect(reasons).toEqual(["gone:pid-dead"]);
    await tick();
    expect(next.grant).toBeDefined();
    now += 61_000;
    m.sweep();
    expect(reasons).toEqual(["gone:pid-dead", "slow:max-run", ]);
    expect(stopped.map((s) => s.reason)).toEqual(["pid-dead", "max-run", "max-run"]);
    expect(m.view().running).toHaveLength(0);
  });

  test("HQ6: an aborted request leaves the queue before it gets a slot", async () => {
    const { m } = manager();
    const holder = ask(m, "e2e");
    const ac = new AbortController();
    const quitter = ask(m, "e2e", { signal: ac.signal });
    const after = ask(m, "e2e");
    await tick();
    ac.abort();
    await tick();
    expect(quitter.error?.message).toBe("cancelled");
    holder.grant!.release();
    await tick();
    expect(after.grant).toBeDefined();
  });

  test("HQ7: config — defaults, overrides and validation", () => {
    const s = heavySettings({ limits: { e2e: 2 }, maxWaitMinutes: 5, memoryMaxGb: 2 });
    expect(s.limits).toEqual({ e2e: 2, test: 2, lint: 2, build: 1, total: 3 });
    expect(s.maxWaitMs).toBe(300_000);
    expect(s.maxRunMs).toBe(30 * 60_000);
    expect(s.memoryMaxGb).toBe(2);
    expect(heavyQueueProblems(undefined)).toEqual([]);
    expect(heavyQueueProblems({ limits: { e2e: 0, unit: 1 }, maxRunMinutes: -1 })).toEqual([
      "heavyQueue.limits.e2e must be a whole number of at least 1",
      "heavyQueue.limits.unit is not a kind (e2e, test, lint, build, total)",
      "heavyQueue.maxRunMinutes must be a positive number",
    ]);
  });

  test("HQ8: the scope prefix caps one command's memory in the agents' slice; none without systemd", () => {
    expect(scopePrefix({ available: false, unit: "u", memoryMaxGb: 3 })).toEqual([]);
    expect(scopePrefix({ available: true, unit: "orca-heavy-1", memoryMaxGb: 3, slice: "orca-agents.slice" })).toEqual([
      "systemd-run", "--user", "--scope", "--quiet", "--unit=orca-heavy-1", "--slice=orca-agents.slice",
      "-p", "MemoryMax=3G", "-p", "MemorySwapMax=0", "-p", "CPUWeight=50", "--",
    ]);
  });

  test("HQ9: a run's env names the run, so its slot is tied to it", () => {
    expect(runIdentity("r1", { repo: "orca", branch: "b" })).toEqual({ ORCA_RUN_ID: "r1", ORCA_REPO: "orca", ORCA_BRANCH: "b" });
    expect(runIdentity("r1", {})).toEqual({ ORCA_RUN_ID: "r1" });
  });

  test("HQ10: the machine card lists running commands, then the queue with positions", () => {
    expect(heavyQueueRows(undefined)).toEqual([]);
    const rows = heavyQueueRows({
      running: [{ id: "b", kind: "test", command: "jest", branch: "feat", queuedAt: 5, startedAt: 9 }, { id: "a", kind: "e2e", command: "playwright test", repo: "demo", queuedAt: 1, startedAt: 2 }],
      queued: [{ id: "c", kind: "e2e", command: "x".repeat(100), queuedAt: 3 }],
    });
    expect(rows.map((r) => [r.id, r.state, r.who, r.position])).toEqual([["a", "running", "demo", undefined], ["b", "running", "feat", undefined], ["c", "queued", "shell", 1]]);
    expect(rows[2]!.command.length).toBe(80);
  });
});

test("HQ16: every worker prompt carries the rule: wrap heavy commands in orca-run, never a whole suite", () => {
  expect(HEAVY_COMMANDS).toContain("orca-run --kind test|lint|build|e2e -- <command>");
  expect(HEAVY_COMMANDS).toMatch(/Never run a whole suite/);
  expect(followUpPrompt("fix the header").split(HEAVY_COMMANDS)).toHaveLength(2);
});

// ---- the CLI and the shims, for real ----
describe("orca-run and the shims", () => {
  let server: ReturnType<typeof Bun.serve>;
  let m: SlotManager;
  let fakeBin: string;
  const env = () => {
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("ORCA_")) e[k] = v;
    // The shims first, then fake real tools, then bun itself (orca-run's `#!/usr/bin/env bun`).
    return { ...e, PATH: `${WORKER}:${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`, ORCA_URL: `http://127.0.0.1:${server.port}` };
  };

  // happy-dom replaces the globals; the bridge's code must build Bun's Response for Bun.serve.
  const saved = { Response: globalThis.Response, fetch: globalThis.fetch };
  beforeAll(() => {
    globalThis.Response = native.Response;
    globalThis.fetch = native.fetch;
    m = createSlotManager({ settings: () => ({ ...heavySettings(undefined), maxWaitMs: 20_000 }) });
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const p = new URL(req.url).pathname;
        const body = req.method === "POST" ? await req.json() : {};
        if (p === "/api/heavy") return acquireResponse(m, body, req.signal, { maxRunMs: 60_000, env: {}, prefix: () => [], beatMs: 200 });
        if (p === "/api/heavy/release") { m.release(body.id); return Response.json({ ok: true }); }
        return new Response("no", { status: 404 });
      },
    });
    // Fake "real" tools: print who they are, their args and the slot they run under.
    fakeBin = mkdtempSync(join(tmpdir(), "orca-heavy-bin-"));
    for (const name of ["playwright", "eslint", "npx", "tsc"]) {
      const f = join(fakeBin, name);
      writeFileSync(f, `#!/bin/sh\necho "${name} $* slot=\${ORCA_RUN_SLOT:-none}"\n[ -n "$SLEEP" ] && sleep "$SLEEP"\nexit \${EXIT_CODE:-0}\n`);
      chmodSync(f, 0o755);
    }
  });
  afterAll(() => {
    server.stop(true);
    globalThis.Response = saved.Response;
    globalThis.fetch = saved.fetch;
  });

  const run = async (cmd: string[], extra: Record<string, string> = {}) => {
    const proc = Bun.spawn(cmd, { env: { ...env(), ...extra }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  };

  test("HQ11: orca-run takes a slot, runs the command, returns its exit code and gives the slot back", async () => {
    const r = await run([join(WORKER, "orca-run"), "--kind", "lint", "--", "eslint", "src"], { EXIT_CODE: "3" });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/^eslint src slot=heavy-\w+/);
    await Bun.sleep(50);
    expect(m.view().running).toHaveLength(0);
  });

  test("HQ12: two Playwright runs at once — the second waits with a queue position", async () => {
    const first = Bun.spawn(["playwright", "test", "a.spec.ts"], { env: { ...env(), SLEEP: "1" }, stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(400);
    expect(m.view().running.map((e) => e.kind)).toEqual(["e2e"]);
    const t0 = Date.now();
    const second = await run(["playwright", "test", "b.spec.ts"]);
    expect(second.err).toContain("queued: position 1 in line for an e2e slot");
    expect(second.err).toContain("orca-run: slot granted (e2e)");
    expect(second.out).toMatch(/playwright test b.spec.ts slot=heavy-/);
    expect(Date.now() - t0).toBeGreaterThan(300);
    expect(await first.exited).toBe(0);
  });

  test("HQ13: kill -9 of a waiting or running orca-run frees its place", async () => {
    const holder = Bun.spawn(["playwright", "test"], { env: { ...env(), SLEEP: "30" }, stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(400);
    expect(m.view().running).toHaveLength(1);
    holder.kill("SIGKILL");
    await holder.exited;
    for (let i = 0; i < 40 && m.view().running.length; i++) await Bun.sleep(50);
    expect(m.view().running).toHaveLength(0);
    // The fake tool that orca-run started is an orphan now; the real bridge stops its scope.
    const next = await run(["playwright", "test", "c.spec.ts"]);
    expect(next.err).not.toContain("queued");
    expect(next.out).toContain("slot=heavy-");
  });

  test("HQ14: the shims queue only heavy calls; --version, other tools, nested calls and the bypass run at once", async () => {
    expect((await run(["playwright", "--version"])).out).toContain("slot=none");
    expect((await run(["playwright", "install"])).out).toContain("slot=none");
    expect((await run(["tsc", "--noEmit"])).out).toMatch(/slot=heavy-/);
    expect((await run(["npx", "-y", "eslint@9", "."])).out).toMatch(/npx -y eslint@9 \. slot=heavy-/);
    expect((await run(["npx", "cowsay", "hi"])).out).toContain("slot=none");
    expect((await run(["npx", "-p", "playwright", "playwright", "test"])).out).toMatch(/slot=heavy-/);
    expect((await run(["tsc", "--noEmit"], { ORCA_RUN_BYPASS: "1" })).out).toContain("slot=none");
    expect((await run(["eslint", "."], { ORCA_RUN_SLOT: "heavy-outer" })).out).toContain("slot=heavy-outer");
    // A tool that is not installed is still "not found", never a hang in the queue.
    const missing = await run(["vitest", "run"]);
    expect(missing.code).toBe(127);
    expect(missing.err).toContain("vitest: command not found");
  });

  test("HQ15: with no bridge, orca-run warns and runs the command anyway", async () => {
    const r = await run([join(WORKER, "orca-run"), "--", "eslint", "x"], { ORCA_URL: "http://127.0.0.1:9" });
    expect(r.code).toBe(0);
    expect(r.err).toContain("running without a slot");
    expect(r.out).toContain("eslint x");
  });
});
