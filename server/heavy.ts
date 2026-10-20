// The box-wide queue for HEAVY commands: test runners, linters on a whole repo, tsc, builds, e2e
// suites. Agents on one box ran Playwright, Jest and a frontend build at the same time; on a 4 vCPU
// 15.7 GB box that OOM-killed runs in orca-agents.slice and pinned the CPU. This is orca-shot's
// queue (server/screenshot.ts) generalised to N slots:
//   1. Limits: per kind (e2e, test, lint, build, migrate, serve), in total, and a CPU budget over the
//      kinds' CPU costs (`heavyQueue` in the app config).
//   2. A slot is tied to the run: to the CLI's held request (a killed `orca-run` drops it), to the
//      agent run that asked (`releaseRun` at its exit), and to the CLI's pid (a sweep).
//   3. A max wait in the queue and a max run time, after which the slot is taken back.
//   4. Memory: each kind has a memory cap, and the running caps never pass the agents' slice
//      MemoryMax minus `HEAVY_MEMORY_RESERVE_GB`. With systemd, each granted command runs in its own
//      scope with its kind's cap.
// The CLI is `bin/worker/orca-run`; the shims beside it (bin/worker/.heavy-shim) route the heavy
// tools, package scripts and test scripts through it.

// Finn's decision (2026-10-19): no CPUQuota on orca-agents.slice. This queue is the ONLY CPU control,
// so it covers every heavy task and its defaults keep the box under about 3 busy CPUs (4 vCPU box):
// each kind has a CPU cost, and the running costs never pass `cpuBudget`.
export const HEAVY_KINDS = ["e2e", "test", "lint", "build", "migrate", "serve"] as const;
export type HeavyKind = (typeof HEAVY_KINDS)[number];
export type HeavyLimits = Record<HeavyKind, number> & { total: number };
export type PerKind = Record<HeavyKind, number>;

/** How many of each kind may run at once, and of all kinds together. */
export const DEFAULT_HEAVY_LIMITS: HeavyLimits = { e2e: 1, test: 2, lint: 2, build: 1, migrate: 1, serve: 2, total: 4 };
/** The CPUs one command of each kind is expected to keep busy. `serve`: a local backend or frontend
 *  for a test, mostly idle; `migrate`: one database client. */
export const DEFAULT_HEAVY_CPU: PerKind = { e2e: 1.5, test: 1, lint: 1, build: 1.5, migrate: 0.5, serve: 0.5 };
/** The sum of the running costs never passes this (a 4 vCPU box keeps one CPU for the rest). */
export const DEFAULT_CPU_BUDGET = 3;
export const DEFAULT_MAX_WAIT_MS = 20 * 60_000;
/** A server for a test runs as long as the tests; everything else gets 30 minutes. */
export const DEFAULT_MAX_RUN_MS: PerKind = { e2e: 30 * 60_000, test: 30 * 60_000, lint: 30 * 60_000, build: 30 * 60_000, migrate: 30 * 60_000, serve: 60 * 60_000 };
/** The memory cap of one granted command's own scope, per kind. A cap below a command's working set
 *  is worse than none: at 3 GB a frontend `tsc --noEmit` (about 3.5 GB anon) lost every file page and
 *  re-read node_modules from EBS for minutes (2026-10-19 18:40: iowait 80 %, load 9 on 4 CPUs). */
export const DEFAULT_HEAVY_MEMORY_GB: PerKind = { e2e: 6, test: 4, lint: 6, build: 6, migrate: 2, serve: 2 };
/** The slice memory that the queue leaves for the agents themselves and everything else in it. */
export const HEAVY_MEMORY_RESERVE_GB = 3;
export const HEAVY_CPU_WEIGHT = 50;

/** The app config's `heavyQueue`. Each field is optional; a missing one takes the default.
 *  `maxRunMinutes` is one number for every kind, or a number per kind. */
export type HeavyQueueConfig = {
  limits?: Partial<HeavyLimits>;
  cpu?: Partial<PerKind>;
  cpuBudget?: number;
  maxWaitMinutes?: number;
  maxRunMinutes?: number | Partial<PerKind>;
  /** One cap for every kind, or a cap per kind (GB). */
  memoryMaxGb?: number | Partial<PerKind>;
};

/** `memoryBudgetGb`: the running caps never pass it; undefined = no memory budget. */
export type HeavySettings = { limits: HeavyLimits; cpu: PerKind; cpuBudget: number; maxWaitMs: number; maxRunMs: PerKind; memoryMaxGb: PerKind; memoryBudgetGb?: number };

/** One number for every kind, or a number per kind, over the defaults. Pure. */
function perKind(v: number | Partial<PerKind> | undefined, defaults: PerKind, scale = 1): PerKind {
  const out = { ...defaults };
  for (const k of HEAVY_KINDS) {
    const n = typeof v === "number" ? v : v?.[k];
    if (n !== undefined) out[k] = n * scale;
  }
  return out;
}

/** The memory budget for the running caps: the agents' slice MemoryMax minus the reserve. No slice
 *  limit (0 or unknown) means no budget. Pure. */
export function heavyMemoryBudgetGb(sliceMaxGb: number | undefined): number | undefined {
  return sliceMaxGb && sliceMaxGb > 0 ? oneDecimal(Math.max(0, sliceMaxGb - HEAVY_MEMORY_RESERVE_GB)) : undefined;
}

/** A CPU or GB figure to one decimal at most: 4.1 - 3 is 1.0999999999999996 in floating point. Pure. */
export function oneDecimal(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Config → settings with every default filled in. `sliceMaxGb`: the agents' slice MemoryMax when
 *  the commands run in capped scopes inside it. Pure. */
export function heavySettings(cfg: HeavyQueueConfig | undefined, sliceMaxGb?: number): HeavySettings {
  const memoryBudgetGb = heavyMemoryBudgetGb(sliceMaxGb);
  return {
    limits: { ...DEFAULT_HEAVY_LIMITS, ...(cfg?.limits ?? {}) },
    cpu: { ...DEFAULT_HEAVY_CPU, ...(cfg?.cpu ?? {}) },
    cpuBudget: cfg?.cpuBudget ?? DEFAULT_CPU_BUDGET,
    maxWaitMs: cfg?.maxWaitMinutes !== undefined ? cfg.maxWaitMinutes * 60_000 : DEFAULT_MAX_WAIT_MS,
    maxRunMs: perKind(cfg?.maxRunMinutes, DEFAULT_MAX_RUN_MS, 60_000),
    memoryMaxGb: perKind(cfg?.memoryMaxGb, DEFAULT_HEAVY_MEMORY_GB),
    ...(memoryBudgetGb === undefined ? {} : { memoryBudgetGb }),
  };
}

/** Problems with a `heavyQueue` value, for config validation. Pure. */
export function heavyQueueProblems(v: unknown): string[] {
  if (v === undefined) return [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["heavyQueue must be an object"];
  const o = v as Record<string, unknown>;
  const errors: string[] = [];
  const isObj = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
  const kinds = HEAVY_KINDS.join(", ");
  if (o.limits !== undefined) {
    if (!isObj(o.limits)) errors.push("heavyQueue.limits must be an object");
    else for (const [k, n] of Object.entries(o.limits as object)) {
      if (![...HEAVY_KINDS, "total"].includes(k)) errors.push(`heavyQueue.limits.${k} is not a kind (${kinds}, total)`);
      else if (!(Number.isInteger(n) && (n as number) >= 1)) errors.push(`heavyQueue.limits.${k} must be a whole number of at least 1`);
    }
  }
  const perKindKeys = ["maxRunMinutes", "memoryMaxGb"];
  for (const key of ["cpu", ...perKindKeys.filter((k) => isObj(o[k]))]) {
    if (o[key] === undefined) continue;
    if (!isObj(o[key])) { errors.push(`heavyQueue.${key} must be an object`); continue; }
    for (const [k, n] of Object.entries(o[key] as object)) {
      if (!isHeavyKind(k)) errors.push(`heavyQueue.${key}.${k} is not a kind (${kinds})`);
      else if (!(typeof n === "number" && n > 0)) errors.push(`heavyQueue.${key}.${k} must be a positive number`);
    }
  }
  for (const k of ["cpuBudget", "maxWaitMinutes", ...perKindKeys.filter((k) => !isObj(o[k]))]) {
    if (o[k] !== undefined && !(typeof o[k] === "number" && (o[k] as number) > 0)) errors.push(`heavyQueue.${k} must be a positive number`);
  }
  return errors;
}

export function isHeavyKind(k: unknown): k is HeavyKind {
  return typeof k === "string" && (HEAVY_KINDS as readonly string[]).includes(k);
}

/** Who asks and for what. Only `kind` and `command` are required. */
export type HeavyRequest = {
  kind: HeavyKind;
  /** The command line, for the view. Never run by the bridge. */
  command: string;
  /** The agent run that asked (ORCA_RUN_ID in a worker's env). */
  runId?: string;
  repo?: string;
  branch?: string;
  cwd?: string;
  /** The `orca-run` process. A dead pid frees the slot. */
  pid?: number;
};

/** `cpu` and `memoryGb`: the kind's CPU cost and memory cap, set when the slot is granted.
 *  `overBudget`: its cap alone passes the memory budget, so it was granted only with nothing else running. */
export type HeavyEntry = HeavyRequest & { id: string; queuedAt: number; startedAt?: number; unit?: string; cpu?: number; memoryGb?: number; overBudget?: boolean };
/** `memory.budget`: absent when there is no memory budget. */
export type HeavyView = { running: HeavyEntry[]; queued: HeavyEntry[]; limits: HeavyLimits; cpu: { used: number; budget: number }; memory: { used: number; budget?: number } };

/** Why a slot came back. `done` and `client-gone` are ordinary; the others stop the command. */
export type ReleaseReason = "done" | "client-gone" | "run-ended" | "max-run" | "pid-dead";

export type Grant = {
  id: string;
  /** The CPUs this slot counts for in the budget. */
  cpu: number;
  /** The memory cap of the command's scope (GB); it counts for this in the memory budget. */
  memoryGb: number;
  /** The cap alone passes the memory budget: it runs alone, and says so. */
  overBudget?: boolean;
  /** The systemd unit the command may run in (the CLI wraps it when the scope is available). */
  unit: string;
  /** Set once the slot is back. Idempotent. */
  release(reason?: ReleaseReason): void;
  /** Called once when the bridge takes the slot back (not for `done`/`client-gone`). */
  onRevoke(fn: (reason: ReleaseReason) => void): void;
};

export type AcquireOpts = { signal?: AbortSignal; onQueue?: (ahead: number) => void };

export class HeavyWaitTimeout extends Error {}

export type SlotManager = {
  acquire(req: HeavyRequest, opts?: AcquireOpts): Promise<Grant>;
  /** Give a slot back by id (the CLI's normal end). Unknown ids are a no-op. */
  release(id: string): void;
  /** Free every slot (and queued job) of an agent run that ended. Returns how many slots it freed. */
  releaseRun(runId: string): number;
  /** Free slots past the max run time or with a dead client. index.ts calls it on a timer. */
  sweep(): void;
  view(): HeavyView;
};

/** The slot manager. Every dependency is injectable, so the tests drive it with a fake clock. */
export function createSlotManager(deps: {
  settings?: () => HeavySettings;
  now?: () => number;
  /** Is this pid alive? Default: `process.kill(pid, 0)`. */
  alive?: (pid: number) => boolean;
  /** Stop a command whose slot was revoked: its scope unit and its client. */
  stop?: (entry: HeavyEntry, reason: ReleaseReason) => void;
} = {}): SlotManager {
  const settings = deps.settings ?? (() => heavySettings(undefined));
  const now = deps.now ?? Date.now;
  const alive = deps.alive ?? pidAlive;

  type Job = { entry: HeavyEntry; grant: (g: Grant) => void; fail: (e: Error) => void; onQueue?: (ahead: number) => void; lastAhead?: number; timer?: ReturnType<typeof setTimeout>; cleanup?: () => void };
  type Slot = { entry: HeavyEntry; released: boolean; revoke?: (r: ReleaseReason) => void };
  const queue: Job[] = [];
  const running = new Map<string, Slot>();

  const countKind = (k: HeavyKind) => [...running.values()].filter((s) => s.entry.kind === k).length;
  const cpuUsed = () => [...running.values()].reduce((n, s) => n + (s.entry.cpu ?? 0), 0);
  const memoryUsed = () => [...running.values()].reduce((n, s) => n + (s.entry.memoryGb ?? 0), 0);

  function report() {
    queue.forEach((job, i) => {
      if (job.lastAhead === i) return;
      job.lastAhead = i;
      job.onQueue?.(i);
    });
  }

  function drop(job: Job) {
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
    clearTimeout(job.timer);
    job.cleanup?.();
  }

  // FIFO, with one exception: a job whose own kind is full does not block a later job of another
  // kind (a queued e2e run must not hold back a lint run while the e2e slot is busy). The total and
  // the CPU and memory budgets are shared, so a job that does not fit them stops the scan: a small
  // job never passes a large one, which then never starves. A job that costs more than a whole
  // budget runs when nothing else does.
  function pump() {
    const { limits, cpu, cpuBudget, memoryMaxGb, memoryBudgetGb } = settings();
    for (let i = 0; i < queue.length && running.size < limits.total;) {
      const job = queue[i]!;
      const kind = job.entry.kind;
      if (countKind(kind) >= limits[kind]) { i++; continue; }
      if (running.size > 0 && cpuUsed() + cpu[kind] > cpuBudget + 1e-9) break;
      if (running.size > 0 && memoryBudgetGb !== undefined && memoryUsed() + memoryMaxGb[kind] > memoryBudgetGb + 1e-9) break;
      drop(job);
      job.entry.startedAt = now();
      job.entry.cpu = cpu[kind];
      job.entry.memoryGb = memoryMaxGb[kind];
      // Granted alone (running.size was 0) with a cap above the whole budget: it must not wait
      // forever, but the overrun is shown on the card and printed by orca-run, never silent.
      const overBudget = memoryBudgetGb !== undefined && memoryMaxGb[kind] > memoryBudgetGb + 1e-9;
      if (overBudget) job.entry.overBudget = true;
      const slot: Slot = { entry: job.entry, released: false };
      running.set(job.entry.id, slot);
      job.grant({
        id: job.entry.id,
        cpu: cpu[kind],
        memoryGb: memoryMaxGb[kind],
        ...(overBudget ? { overBudget } : {}),
        unit: job.entry.unit!,
        release: (reason = "done") => free(job.entry.id, reason),
        onRevoke: (fn) => { slot.revoke = fn; },
      });
    }
    report();
  }

  function free(id: string, reason: ReleaseReason) {
    const slot = running.get(id);
    if (!slot || slot.released) return;
    slot.released = true;
    running.delete(id);
    // "client-gone" is ordinary (a network blip; `orca-run` is likely still watching its own child)
    // UNLESS its pid is no longer alive: the caller itself exited — killed along with the agent run
    // that started it, or crashed outright — and its command, already moved into its OWN transient
    // scope by `systemd-run --scope`, survives the dead parent reparented to pid 1. Nothing else will
    // ever stop that scope, so this is the one place that must.
    const callerGone = reason === "client-gone" && slot.entry.pid !== undefined && !alive(slot.entry.pid);
    if ((reason !== "done" && reason !== "client-gone") || callerGone) {
      try { slot.revoke?.(reason); } catch { /* a listener must not stop the queue */ }
      try { deps.stop?.(slot.entry, reason); } catch { /* the stop is best effort */ }
    }
    pump();
  }

  return {
    acquire(req, opts = {}) {
      return new Promise<Grant>((resolve, reject) => {
        const id = `heavy-${crypto.randomUUID().slice(0, 8)}`;
        const entry: HeavyEntry = { ...req, id, queuedAt: now(), unit: `orca-heavy-${id.slice(6)}` };
        const job: Job = { entry, grant: resolve, fail: reject, onQueue: opts.onQueue };
        if (opts.signal?.aborted) return reject(new Error("cancelled"));
        const onAbort = () => { drop(job); reject(new Error("cancelled")); report(); };
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        job.cleanup = () => opts.signal?.removeEventListener("abort", onAbort);
        const wait = settings().maxWaitMs;
        job.timer = setTimeout(() => {
          drop(job);
          reject(new HeavyWaitTimeout(`waited ${Math.round(wait / 60_000)} min for a ${entry.kind} slot; the box is busy, try again later`));
          report();
        }, wait);
        queue.push(job);
        pump();
      });
    },
    release(id) { free(id, "done"); },
    releaseRun(runId) {
      for (const job of queue.filter((j) => j.entry.runId === runId)) {
        drop(job);
        job.fail(new Error("the agent run ended"));
      }
      const ids = [...running.values()].filter((s) => s.entry.runId === runId).map((s) => s.entry.id);
      for (const id of ids) free(id, "run-ended");
      report();
      return ids.length;
    },
    sweep() {
      const { maxRunMs } = settings();
      for (const slot of [...running.values()]) {
        if (slot.entry.startedAt !== undefined && now() - slot.entry.startedAt > maxRunMs[slot.entry.kind]) free(slot.entry.id, "max-run");
        else if (slot.entry.pid !== undefined && !alive(slot.entry.pid)) free(slot.entry.id, "pid-dead");
      }
    },
    view() {
      const { limits, cpuBudget, memoryBudgetGb } = settings();
      return {
        running: [...running.values()].map((s) => ({ ...s.entry })), queued: queue.map((j) => ({ ...j.entry })), limits,
        cpu: { used: oneDecimal(cpuUsed()), budget: oneDecimal(cpuBudget) },
        memory: { used: oneDecimal(memoryUsed()), ...(memoryBudgetGb === undefined ? {} : { budget: oneDecimal(memoryBudgetGb) }) },
      };
    },
  };
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The argv prefix that runs a granted command in its own capped scope. Empty when the scope is not
 *  available. Pure. */
export function scopePrefix(opts: { available: boolean; unit: string; memoryMaxGb: number; slice?: string }): string[] {
  if (!opts.available) return [];
  return [
    "systemd-run", "--user", "--scope", "--quiet", `--unit=${opts.unit}`, ...(opts.slice ? [`--slice=${opts.slice}`] : []),
    // Whole MB, as limitAgentsSlice writes it: a config's 1.1 never becomes "1.1000000000000001G".
    "-p", `MemoryMax=${Math.floor(opts.memoryMaxGb * 1024)}M`, "-p", "MemorySwapMax=0", "-p", `CPUWeight=${HEAVY_CPU_WEIGHT}`, "--",
  ];
}

/** The answer to `POST /api/heavy`: NDJSON, `{queued: N}` while waiting, then `{granted, unit,
 *  prefix, env, maxRunMs}`, then a heartbeat every `beatMs` until the slot is back; `{revoked}` if
 *  the bridge takes it back, `{error}` if it never comes. The slot lives as long as the request: a
 *  dropped connection (a killed `orca-run`) frees it. */
export function acquireResponse(manager: SlotManager, request: HeavyRequest, signal: AbortSignal, grantInfo: {
  maxRunMs: number; env: Record<string, string>; prefix: (unit: string, memoryGb: number) => string[]; beatMs?: number;
}): Response {
  const encoder = new TextEncoder();
  let grant: Grant | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  const gone = () => { clearInterval(beat); grant?.release("client-gone"); };
  signal.addEventListener("abort", gone, { once: true });
  const stream = new ReadableStream({
    async start(controller) {
      let last: unknown = { queued: 0 };
      const write = (obj: unknown) => { last = obj; try { controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`)); } catch { gone(); } };
      const close = () => { clearInterval(beat); try { controller.close(); } catch { /* already closed */ } };
      // A line every 20s keeps the held connection inside Bun's idleTimeout.
      beat = setInterval(() => write(last), grantInfo.beatMs ?? 20_000);
      try {
        grant = await manager.acquire(request, { signal, onQueue: (ahead) => write({ queued: ahead }) });
      } catch (e) {
        write({ error: (e as Error).message });
        return close();
      }
      if (signal.aborted) return grant.release("client-gone");
      grant.onRevoke((reason) => { write({ revoked: reason }); close(); });
      write({ granted: grant.id, unit: grant.unit, maxRunMs: grantInfo.maxRunMs, prefix: grantInfo.prefix(grant.unit, grant.memoryGb), env: grantInfo.env, cpus: grant.cpu, memoryGb: grant.memoryGb, ...(grant.overBudget ? { overBudget: true } : {}) });
    },
    cancel() { gone(); },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
}

// ---- the bridge's one manager ----
let manager: SlotManager | undefined;
let current: HeavySettings = heavySettings(undefined);
/** index.ts sets the settings from the config on each request that reads it. */
export function setSettings(s: HeavySettings): void { current = s; }
export function slots(): SlotManager {
  manager ??= createSlotManager({ settings: () => current, stop: stopEntry });
  return manager;
}

/** A revoked slot's command: stop its scope (the whole tree) and its `orca-run` client. */
function stopEntry(entry: HeavyEntry): void {
  if (entry.unit) {
    try {
      Bun.spawn(["systemctl", "--user", "stop", `${entry.unit}.scope`], { stdout: "ignore", stderr: "ignore", env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}` } });
    } catch { /* no systemctl */ }
  }
  if (entry.pid) { try { process.kill(entry.pid, "SIGTERM"); } catch { /* already gone */ } }
}

// ---- failed scopes ----

/** The UNIT column of a `systemctl --user list-units --state=failed --no-legend --plain` line (the
 *  DESCRIPTION column may hold spaces). Pure. */
export function parseFailedHeavyUnits(stdout: string): string[] {
  return stdout.split("\n").map((l) => l.trim().split(/\s+/)[0])
    .filter((u): u is string => !!u && /^orca-heavy-[^.]+\.scope$/.test(u));
}

export type SystemctlRun = (cmd: string[]) => Promise<{ stdout: string; code: number }>;

/** `systemctl --user list-units` otherwise shows an `orca-heavy-*.scope` as failed forever — a
 *  stopped scope, or one whose command was killed outright, both leave systemd's failed-unit
 *  bookkeeping behind. This clears it for each one already in that state. It never stops a
 *  scope that is still running: `--state=failed` lists only units systemd has already marked so. */
export async function clearFailedHeavyScopes(deps: { run?: SystemctlRun } = {}): Promise<string[]> {
  const run = deps.run ?? defaultSystemctl;
  const listed = await run(["systemctl", "--user", "list-units", "--state=failed", "--no-legend", "--plain", "orca-heavy-*.scope"]).catch(() => undefined);
  if (!listed || listed.code !== 0) return [];
  const units = parseFailedHeavyUnits(listed.stdout);
  for (const unit of units) await run(["systemctl", "--user", "reset-failed", unit]).catch(() => undefined);
  return units;
}

async function defaultSystemctl(cmd: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}` } });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, code };
  } catch {
    return { stdout: "", code: 1 }; // no systemctl
  }
}
