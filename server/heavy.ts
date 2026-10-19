// The box-wide queue for HEAVY commands: test runners, linters on a whole repo, tsc, builds, e2e
// suites. Agents on one box ran Playwright, Jest and a frontend build at the same time; on a 4 vCPU
// 15.7 GB box that OOM-killed runs in orca-agents.slice and pinned the CPU. This is orca-shot's
// queue (server/screenshot.ts) generalised to N slots:
//   1. Limits: per kind (e2e, test, lint, build, migrate, serve), in total, and a CPU budget over the
//      kinds' CPU costs (`heavyQueue` in the app config).
//   2. A slot is tied to the run: to the CLI's held request (a killed `orca-run` drops it), to the
//      agent run that asked (`releaseRun` at its exit), and to the CLI's pid (a sweep).
//   3. A max wait in the queue and a max run time, after which the slot is taken back.
//   4. Optional: each granted command runs in its own memory-capped systemd scope.
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
/** The memory cap of one granted command's own scope. */
export const DEFAULT_HEAVY_MEMORY_MAX_GB = 3;
export const HEAVY_CPU_WEIGHT = 50;

/** The app config's `heavyQueue`. Each field is optional; a missing one takes the default.
 *  `maxRunMinutes` is one number for every kind, or a number per kind. */
export type HeavyQueueConfig = {
  limits?: Partial<HeavyLimits>;
  cpu?: Partial<PerKind>;
  cpuBudget?: number;
  maxWaitMinutes?: number;
  maxRunMinutes?: number | Partial<PerKind>;
  memoryMaxGb?: number;
};

export type HeavySettings = { limits: HeavyLimits; cpu: PerKind; cpuBudget: number; maxWaitMs: number; maxRunMs: PerKind; memoryMaxGb: number };

/** Config → settings with every default filled in. Pure. */
export function heavySettings(cfg: HeavyQueueConfig | undefined): HeavySettings {
  const run = cfg?.maxRunMinutes;
  const maxRunMs = { ...DEFAULT_MAX_RUN_MS };
  for (const k of HEAVY_KINDS) {
    const m = typeof run === "number" ? run : run?.[k];
    if (m !== undefined) maxRunMs[k] = m * 60_000;
  }
  return {
    limits: { ...DEFAULT_HEAVY_LIMITS, ...(cfg?.limits ?? {}) },
    cpu: { ...DEFAULT_HEAVY_CPU, ...(cfg?.cpu ?? {}) },
    cpuBudget: cfg?.cpuBudget ?? DEFAULT_CPU_BUDGET,
    maxWaitMs: cfg?.maxWaitMinutes !== undefined ? cfg.maxWaitMinutes * 60_000 : DEFAULT_MAX_WAIT_MS,
    maxRunMs,
    memoryMaxGb: cfg?.memoryMaxGb ?? DEFAULT_HEAVY_MEMORY_MAX_GB,
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
  for (const key of ["cpu", ...(isObj(o.maxRunMinutes) ? ["maxRunMinutes"] : [])]) {
    if (o[key] === undefined) continue;
    if (!isObj(o[key])) { errors.push(`heavyQueue.${key} must be an object`); continue; }
    for (const [k, n] of Object.entries(o[key] as object)) {
      if (!isHeavyKind(k)) errors.push(`heavyQueue.${key}.${k} is not a kind (${kinds})`);
      else if (!(typeof n === "number" && n > 0)) errors.push(`heavyQueue.${key}.${k} must be a positive number`);
    }
  }
  for (const k of ["cpuBudget", "maxWaitMinutes", "memoryMaxGb", ...(isObj(o.maxRunMinutes) ? [] : ["maxRunMinutes"])]) {
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

/** `cpu`: the kind's CPU cost, set when the slot is granted. */
export type HeavyEntry = HeavyRequest & { id: string; queuedAt: number; startedAt?: number; unit?: string; cpu?: number };
export type HeavyView = { running: HeavyEntry[]; queued: HeavyEntry[]; limits: HeavyLimits; cpu: { used: number; budget: number } };

/** Why a slot came back. `done` and `client-gone` are ordinary; the others stop the command. */
export type ReleaseReason = "done" | "client-gone" | "run-ended" | "max-run" | "pid-dead";

export type Grant = {
  id: string;
  /** The CPUs this slot counts for in the budget. */
  cpu: number;
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
  // the CPU budget are shared, so a job that does not fit them stops the scan: a small job never
  // passes a large one, which then never starves. A job that costs more than the whole budget runs
  // when nothing else does.
  function pump() {
    const { limits, cpu, cpuBudget } = settings();
    for (let i = 0; i < queue.length && running.size < limits.total;) {
      const job = queue[i]!;
      const kind = job.entry.kind;
      if (countKind(kind) >= limits[kind]) { i++; continue; }
      if (running.size > 0 && cpuUsed() + cpu[kind] > cpuBudget + 1e-9) break;
      drop(job);
      job.entry.startedAt = now();
      job.entry.cpu = cpu[kind];
      const slot: Slot = { entry: job.entry, released: false };
      running.set(job.entry.id, slot);
      job.grant({
        id: job.entry.id,
        cpu: cpu[kind],
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
    if (reason !== "done" && reason !== "client-gone") {
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
      const { limits, cpuBudget } = settings();
      return { running: [...running.values()].map((s) => ({ ...s.entry })), queued: queue.map((j) => ({ ...j.entry })), limits, cpu: { used: Math.round(cpuUsed() * 100) / 100, budget: cpuBudget } };
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
    "-p", `MemoryMax=${opts.memoryMaxGb}G`, "-p", "MemorySwapMax=0", "-p", `CPUWeight=${HEAVY_CPU_WEIGHT}`, "--",
  ];
}

/** The answer to `POST /api/heavy`: NDJSON, `{queued: N}` while waiting, then `{granted, unit,
 *  prefix, env, maxRunMs}`, then a heartbeat every `beatMs` until the slot is back; `{revoked}` if
 *  the bridge takes it back, `{error}` if it never comes. The slot lives as long as the request: a
 *  dropped connection (a killed `orca-run`) frees it. */
export function acquireResponse(manager: SlotManager, request: HeavyRequest, signal: AbortSignal, grantInfo: {
  maxRunMs: number; env: Record<string, string>; prefix: (unit: string) => string[]; beatMs?: number;
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
      write({ granted: grant.id, unit: grant.unit, maxRunMs: grantInfo.maxRunMs, prefix: grantInfo.prefix(grant.unit), env: grantInfo.env, cpus: grant.cpu });
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
