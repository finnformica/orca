// The box-wide heavy-command queue (server/heavy.ts) and its CLI (bin/worker/orca-run) plus the
// shims beside it. The slot manager runs with a fake clock; the CLI and shims run for real against
// a tiny bridge that serves the same `acquireResponse` the real route does.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  acquireResponse, createSlotManager, HEAVY_KINDS, heavyQueueProblems, heavySettings, HeavyWaitTimeout, scopePrefix,
  type Grant, type HeavyEntry, type HeavySettings, type PerKind, type ReleaseReason, type SlotManager,
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
function ask(m: SlotManager, kind: HeavyEntry["kind"], extra: { runId?: string; pid?: number; signal?: AbortSignal; positions?: number[] } = {}) {
  const r: { grant?: Grant; error?: Error } = {};
  void m.acquire({ kind, command: `${kind} cmd`, runId: extra.runId, pid: extra.pid }, { signal: extra.signal, onQueue: (n) => extra.positions?.push(n) })
    .then((g) => { r.grant = g; }, (e) => { r.error = e; });
  return r;
}

describe("slot manager", () => {
  test("HQ1: defaults keep the box under 3 busy CPUs — per-kind limits, the CPU budget, and strict FIFO across the budget", async () => {
    const { m } = manager();
    expect(m.view().cpu).toEqual({ used: 0, budget: 3 });
    const e1 = ask(m, "e2e"), e2 = ask(m, "e2e");
    const t1 = ask(m, "test"), t2 = ask(m, "test");
    const s1 = ask(m, "serve");
    await tick();
    expect(e1.grant && t1.grant).toBeDefined(); // 1.5 + 1 = 2.5 CPUs
    expect(e2.grant).toBeUndefined(); // e2e is 1: skipped, it does not block the rest
    expect(t2.grant).toBeUndefined(); // 2.5 + 1 > 3
    expect(s1.grant).toBeUndefined(); // 0.5 fits, but it never passes the test that waits for the budget
    expect(m.view().cpu.used).toBe(2.5);
    t1.grant!.release();
    await tick();
    expect(t2.grant && s1.grant).toBeDefined(); // 1.5 + 1 + 0.5 = 3
    expect(m.view().cpu.used).toBe(3);
    expect(e2.grant).toBeUndefined();
    e1.grant!.release();
    await tick();
    expect(e2.grant).toBeDefined();
    expect(e2.grant!.cpu).toBe(1.5);
  });

  test("HQ1b: a job that costs more than the whole budget runs alone; the limits and costs come from config", async () => {
    const { m } = manager(heavySettings({ cpu: { build: 5 }, cpuBudget: 3, limits: { lint: 1 } }));
    const big = ask(m, "build"), lint = ask(m, "lint");
    await tick();
    expect(big.grant).toBeDefined();
    expect(lint.grant).toBeUndefined();
    big.grant!.release();
    await tick();
    expect(lint.grant).toBeDefined();
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
    const maxRunMs = Object.fromEntries(HEAVY_KINDS.map((k) => [k, 60_000])) as PerKind;
    const { m, stopped } = manager({ maxRunMs }, { now: () => now, alive: (pid) => !dead.has(pid) });
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
    const s = heavySettings({ limits: { e2e: 2 }, cpu: { test: 2 }, cpuBudget: 2.5, maxWaitMinutes: 5, maxRunMinutes: { serve: 90 }, memoryMaxGb: 2 });
    expect(s.limits).toEqual({ e2e: 2, test: 2, lint: 2, build: 1, migrate: 1, serve: 2, total: 4 });
    expect(s.cpu).toEqual({ e2e: 1.5, test: 2, lint: 1, build: 1.5, migrate: 0.5, serve: 0.5 });
    expect(s.cpuBudget).toBe(2.5);
    expect(s.maxWaitMs).toBe(300_000);
    expect(s.maxRunMs.serve).toBe(90 * 60_000);
    expect(s.maxRunMs.test).toBe(30 * 60_000);
    expect(heavySettings({ maxRunMinutes: 10 }).maxRunMs).toEqual(Object.fromEntries(HEAVY_KINDS.map((k) => [k, 600_000])) as PerKind);
    expect(heavySettings(undefined).maxRunMs.serve).toBe(60 * 60_000);
    expect(s.memoryMaxGb).toEqual(Object.fromEntries(HEAVY_KINDS.map((k) => [k, 2])) as PerKind);
    expect(heavySettings(undefined).memoryMaxGb).toEqual({ e2e: 6, test: 4, lint: 6, build: 6, migrate: 2, serve: 2 });
    expect(heavySettings({ memoryMaxGb: { test: 5 } }).memoryMaxGb.test).toBe(5);
    expect(heavySettings({ memoryMaxGb: { test: 5 } }).memoryMaxGb.lint).toBe(6);
    expect(heavyQueueProblems({ memoryMaxGb: { test: 0, x: 1 } })).toEqual([
      "heavyQueue.memoryMaxGb.test must be a positive number",
      "heavyQueue.memoryMaxGb.x is not a kind (e2e, test, lint, build, migrate, serve)",
    ]);
    expect(heavyQueueProblems({ memoryMaxGb: 0 })).toEqual(["heavyQueue.memoryMaxGb must be a positive number"]);
    expect(heavyQueueProblems(undefined)).toEqual([]);
    expect(heavyQueueProblems({ limits: { e2e: 0, unit: 1 }, cpu: { lint: 0, x: 1 }, cpuBudget: 0, maxRunMinutes: -1 })).toEqual([
      "heavyQueue.limits.e2e must be a whole number of at least 1",
      "heavyQueue.limits.unit is not a kind (e2e, test, lint, build, migrate, serve, total)",
      "heavyQueue.cpu.lint must be a positive number",
      "heavyQueue.cpu.x is not a kind (e2e, test, lint, build, migrate, serve)",
      "heavyQueue.cpuBudget must be a positive number",
      "heavyQueue.maxRunMinutes must be a positive number",
    ]);
    expect(heavyQueueProblems({ maxRunMinutes: { serve: "a" } })).toEqual(["heavyQueue.maxRunMinutes.serve must be a positive number"]);
  });

  test("HQ8: the scope prefix caps one command's memory in the agents' slice; none without systemd", () => {
    expect(scopePrefix({ available: false, unit: "u", memoryMaxGb: 3 })).toEqual([]);
    expect(scopePrefix({ available: true, unit: "orca-heavy-1", memoryMaxGb: 3, slice: "orca-agents.slice" })).toEqual([
      "systemd-run", "--user", "--scope", "--quiet", "--unit=orca-heavy-1", "--slice=orca-agents.slice",
      "-p", "MemoryMax=3G", "-p", "MemorySwapMax=0", "-p", "CPUWeight=50", "--",
    ]);
  });

  test("HQ18: memory — each kind has its own cap, and the running caps fit under the agents' slice minus 3 GB", async () => {
    // No slice limit: no memory budget, only the CPU budget counts.
    expect(heavySettings(undefined).memoryBudgetGb).toBeUndefined();
    expect(heavySettings(undefined, 0).memoryBudgetGb).toBeUndefined();
    expect(manager().m.view().memory).toEqual({ used: 0 });
    // The box: an 11 GB slice leaves 8 GB for the caps.
    const { m } = manager(heavySettings(undefined, 11));
    expect(m.view().memory).toEqual({ used: 0, budget: 8 });
    const build = ask(m, "build"), test1 = ask(m, "test"), serve = ask(m, "serve");
    await tick();
    expect(build.grant?.memoryGb).toBe(6);
    expect(test1.grant).toBeUndefined(); // 6 + 4 > 8, though 1.5 + 1 CPUs fit
    expect(serve.grant).toBeUndefined(); // 2 fits, but it never passes the test that waits
    build.grant!.release();
    await tick();
    expect(test1.grant?.memoryGb).toBe(4);
    expect(serve.grant?.memoryGb).toBe(2);
    expect(m.view().memory).toEqual({ used: 6, budget: 8 });
    expect(m.view().running.map((e) => e.memoryGb)).toEqual([4, 2]);
    test1.grant!.release();
    serve.grant!.release();
    // A cap above the whole budget runs alone.
    const small = manager(heavySettings(undefined, 8)).m; // budget 5
    const big = ask(small, "lint"), after = ask(small, "migrate");
    await tick();
    expect(big.grant?.memoryGb).toBe(6);
    expect(after.grant).toBeUndefined();
    big.grant!.release();
    await tick();
    expect(after.grant).toBeDefined();
    // The granted line carries the kind's own cap into the scope prefix.
    const res = acquireResponse(createSlotManager({ settings: () => heavySettings({ memoryMaxGb: { test: 5 } }, 11) }), { kind: "test", command: "jest" }, new AbortController().signal, {
      maxRunMs: 1, env: {}, prefix: (unit, gb) => scopePrefix({ available: true, unit, memoryMaxGb: gb }),
    });
    const reader = res.body!.getReader();
    const line = JSON.parse(new TextDecoder().decode((await reader.read()).value).trim().split("\n").pop()!);
    await reader.cancel();
    expect(line.memoryGb).toBe(5);
    expect(line.prefix).toContain("MemoryMax=5G");
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
  expect(HEAVY_COMMANDS).toContain("orca-run --kind test|lint|build|e2e|migrate|serve -- <command>");
  expect(HEAVY_COMMANDS).toMatch(/database migration/);
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
    for (const name of ["playwright", "eslint", "npx", "tsc", "jest", "npm", "prettier", "mikro-orm"]) {
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
    expect(second.out).toMatch(/playwright test b.spec.ts --workers=1 slot=heavy-/);
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

  test("HQ17: package scripts, test scripts, migrations and formatters queue; jest and playwright get one worker", async () => {
    const slotted = /slot=heavy-/;
    // A fake npm prints its args: the script name decides.
    expect((await run(["npm", "test"])).out).toMatch(slotted);
    expect((await run(["npm", "run", "type-check"])).out).toMatch(slotted);
    expect((await run(["npm", "run", "setup-db"])).out).toMatch(slotted);
    expect((await run(["npm", "run", "dev:local:test"])).out).toMatch(slotted);
    expect((await run(["npm", "--prefix", "frontend", "run", "build"])).out).toMatch(slotted);
    // Installs unpack a whole node_modules: npm's queue as builds; another package manager's do not.
    expect((await run(["npm", "install"])).out).toMatch(slotted);
    expect((await run(["npm", "ci"])).out).toMatch(slotted);
    expect((await run(["npm", "i", "left-pad"])).out).toMatch(slotted);
    expect((await run(["npm", "audit"])).out).toContain("slot=none");
    expect((await run(["npm", "run", "generate-client"])).out).toContain("slot=none");
    expect((await run(["prettier", "--write", "src"])).out).toMatch(slotted);
    expect((await run(["mikro-orm", "migration:up"])).out).toMatch(slotted);
    expect((await run(["mikro-orm", "cache:generate"])).out).toContain("slot=none");
    // Worker caps: added only when the call sets none.
    expect((await run(["jest", "src/a.test.ts"])).out).toMatch(/jest src\/a.test.ts --maxWorkers=1 slot=heavy-/);
    expect((await run(["jest", "-w", "2"])).out).toMatch(/jest -w 2 slot=heavy-/);
    expect((await run(["jest", "--runInBand"])).out).toMatch(/jest --runInBand slot=heavy-/);
    expect((await run(["playwright", "test", "x.spec.ts"])).out).toMatch(/playwright test x.spec.ts --workers=1 slot=heavy-/);
    expect((await run(["playwright", "test", "--workers=2"])).out).toMatch(/playwright test --workers=2 slot=heavy-/);
    expect((await run(["npx", "jest", "a"], { ORCA_RUN_WORKERS: "2" })).out).toMatch(/npx jest a --maxWorkers=2 slot=heavy-/);
    // The real bun and bash, through their shims.
    const dir = mkdtempSync(join(tmpdir(), "orca-heavy-pkg-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "echo lint slot=${ORCA_RUN_SLOT:-none}", hello: "echo hello slot=${ORCA_RUN_SLOT:-none}" } }));
    writeFileSync(join(dir, "run-e2e-tests.sh"), "echo e2e slot=${ORCA_RUN_SLOT:-none}\n");
    writeFileSync(join(dir, "notes.sh"), "echo notes slot=${ORCA_RUN_SLOT:-none}\n");
    const inDir = async (cmd: string[]) => {
      const proc = Bun.spawn(cmd, { cwd: dir, env: env(), stdout: "pipe", stderr: "pipe" });
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return out;
    };
    expect(await inDir(["bun", "run", "lint"])).toMatch(/lint slot=heavy-/);
    expect(await inDir(["bun", "run", "hello"])).toContain("hello slot=none");
    expect(await inDir(["bash", "run-e2e-tests.sh"])).toMatch(/e2e slot=heavy-/);
    expect(await inDir(["bash", "notes.sh"])).toContain("notes slot=none");
    expect(await inDir(["bash", "-c", "echo c slot=${ORCA_RUN_SLOT:-none}"])).toContain("c slot=none");
    expect(m.view().running).toHaveLength(0);
  });

  test("HQ18: two shim directories on PATH never exec each other; with no real tool the shim fails fast", async () => {
    // A worktree's copy of bin/worker before the main one (2026-10-19: six `bun` shims looped for
    // minutes at 25% CPU each, because each copy skipped only its own directory).
    const copy = mkdtempSync(join(tmpdir(), "orca-heavy-copy-"));
    copyFileSync(join(WORKER, ".heavy-shim"), join(copy, ".heavy-shim"));
    chmodSync(join(copy, ".heavy-shim"), 0o755);
    symlinkSync(".heavy-shim", join(copy, "bun"));
    const timed = async (cmd: string[], PATH: string, extra: Record<string, string> = {}) => {
      const t0 = Date.now();
      const proc = Bun.spawn(cmd, { env: { ...env(), PATH, ...extra }, stdout: "pipe", stderr: "pipe" });
      const kill = setTimeout(() => proc.kill("SIGKILL"), 5_000);
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(kill);
      return { out, err, code, ms: Date.now() - t0 };
    };
    try {
      for (const extra of [{}, { ORCA_RUN_BYPASS: "1" }] as Record<string, string>[]) {
        const r = await timed([join(copy, "bun"), "--version"], `${copy}:${WORKER}`, extra);
        expect(r.code).toBe(127);
        expect(r.err).toContain("bun: command not found");
        expect(r.ms).toBeLessThan(2_000);
      }
      // With the real bun after both, the copy finds it, not the other shim.
      const ok = await timed([join(copy, "bun"), "--version"], `${copy}:${WORKER}:${dirname(process.execPath)}:/usr/bin:/bin`);
      expect(ok.code).toBe(0);
      expect(ok.out.trim()).toBe(Bun.version);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  test("HQ15: with no bridge, orca-run warns and runs the command anyway", async () => {
    const r = await run([join(WORKER, "orca-run"), "--", "eslint", "x"], { ORCA_URL: "http://127.0.0.1:9" });
    expect(r.code).toBe(0);
    expect(r.err).toContain("running without a slot");
    expect(r.out).toContain("eslint x");
  });
});
