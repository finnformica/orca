// Per-workstream preview: spins up each configured service (frontend, backend, …) via `sh -lc`
// so shell scripts + env prefixes work. Services for one workstream are tracked together, keyed by
// the worktree path, and started in the background on OS-verified free ports.
//
// Two hazards this guards against, both of which manifested as "the link works but shows stale
// code / then goes red":
//   1. Orphaned servers. `proc.kill()` on the `sh -lc` wrapper doesn't reap the node (nest/vite)
//      grandchildren, and a bridge restart drops the in-memory map entirely — so servers pile up,
//      holding ports and serving old code. Because the key IS the worktree path, we `pkill -f` that
//      path to reap them before (re)starting.
//   2. Port collisions. Picking a port from the in-memory map alone hands out ports those orphans
//      (or anything else on the machine) still hold, so the new server crashes on bind. We probe
//      the OS for a genuinely free port instead.
import { closeSync, openSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { portFree } from "./net";
import type { PreviewService, RepoConfig } from "./config";
import * as git from "./git";
import * as previewdb from "./previewdb";
import * as docker from "./docker";
import { githubEnv, scrubbedEnv } from "./env";
import { cwdInWorktree, listenerPids, processCwd } from "./proc";
import { readJsonSync, statePath, writeJsonSync } from "./state";
import * as tsserve from "./tsserve";

/** A stable, Postgres-identifier-safe database name for one preview (keyed by its worktree path), so
 *  the `{db}` placeholder in a preview command resolves to a per-worktree database on the shared
 *  server. Deterministic (a restart/re-spin of the same worktree targets the same DB), unique (an
 *  8+ char hash of the full path avoids collisions when two branches slug alike), and matches
 *  MikroORM's `^[a-z][a-z0-9_]{0,62}$`: lowercase, leading letter (`orca_`), ≤63 chars. */
export function previewDbName(key: string): string {
  const slug = (key.split("/").pop() ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "preview";
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 10);
  return `orca_${slug}_${hash}`;
}

// Adopted svcs (re-surfaced after an ungraceful bridge exit) have no proc handle / log fd — we
// only know their port, and reap them via killPort. Owned svcs (started this run) have both.
// `https` = the HTTPS port `tailscale serve` maps to this service on `httpsHost` (server/tsserve.ts);
// with `httpsNext`, https + 1 maps to port + 1 as well.
type Https = { https?: number; httpsHost?: string; httpsNext?: boolean };
type Svc = { name: string; port: number; open: boolean; proc?: Bun.Subprocess; logPath: string; logFd?: number; exited: boolean; startedAt: number; onStop?: string; everUp: boolean } & Https;
type SavedSvc = { name: string; port: number; open: boolean; logPath: string; startedAt: number; onStop?: string } & Https;
/** Host the browser should use for preview links (ORCA_PREVIEW_HOST, e.g. the tailnet name of the
 *  box). Defaults to localhost, which is correct for a laptop instance. */
export const previewHost = (): string => process.env.ORCA_PREVIEW_HOST || "localhost";
/** The address a preview's services bind (ORCA_PREVIEW_BIND): loopback on a laptop; on a box reached
 *  over the tailnet, that interface — `{bind}` in a preview command. */
export const previewBind = (): string => process.env.ORCA_PREVIEW_BIND || "127.0.0.1";
/** The host in a preview's `url` — the OWNER's address, which any device on the tailnet can reach:
 *  ORCA_PREVIEW_HOST, else this instance's address from the config's `instances`, else localhost. */
export function ownerHost(instances: Record<string, string> | undefined, self: string): string {
  if (process.env.ORCA_PREVIEW_HOST) return process.env.ORCA_PREVIEW_HOST;
  try { return instances?.[self] ? new URL(instances[self]!).hostname : "localhost"; } catch { return "localhost"; }
}

/** Which preview databases belong to no live worktree. Pure, so the selection — the part whose
 *  failure mode is dropping a database someone is using — is testable without a Postgres. */
export function orphanPreviewDbs(existing: string[], liveWorktreePaths: string[]): string[] {
  const keep = new Set(liveWorktreePaths.map(previewDbName));
  return existing.filter((name) => !keep.has(name));
}

/** `url` is the owner's address (what a phone or the box's own page opens); `localUrl`, when set, is
 *  the same service on the ANSWERING bridge's loopback (its own preview bound to 127.0.0.1, or a
 *  forward in server/forward.ts) — what a page served from localhost opens, for a secure context. */
export type SvcStatus = { name: string; port: number; url: string; localUrl?: string; open: boolean; running: boolean; ready: boolean; error?: string; startedAt: number };

const previews = new Map<string, Svc[]>();

// Registry sidecar: the port↔service map for each worktree, so a crashed/hard-killed bridge (whose
// SIGINT/SIGTERM killAll never ran) can re-adopt its still-running dev servers on the next boot
// instead of orphaning them + forcing a re-spin. Only ports still responding are re-adopted.
// Per host, in the state dir (it was tmpdir(), shared by every instance on one host and written
// non-atomically); the legacy file is still read once so an upgrade re-adopts what it listed.
const reg = () => statePath("previews.json");
const LEGACY_REG = join(tmpdir(), "orca-previews.json");
function persist(): void {
  const data: Record<string, SavedSvc[]> = {};
  // onStop persists so a preview re-adopted after a bridge restart still drops its DB on teardown;
  // the HTTPS ports so its serve entries are still removed.
  for (const [key, svcs] of previews) data[key] = svcs.map(({ name, port, open, logPath, startedAt, onStop, https, httpsHost, httpsNext }) => ({ name, port, open, logPath, startedAt, onStop, https, httpsHost, httpsNext }));
  try { writeJsonSync(reg(), data); } catch { /* best effort */ }
}

/** Re-adopt preview servers that outlived an ungraceful bridge exit; drop entries whose ports are
 *  dead. Call once on boot, before serving. */
export async function reattach(): Promise<void> {
  let data: Record<string, SavedSvc[]>;
  const read = readJsonSync<typeof data>(reg()) ?? readJsonSync<typeof data>(LEGACY_REG);
  if (!read) return; // no registry yet / unreadable
  data = read;
  for (const [key, svcs] of Object.entries(data)) {
    const live: Svc[] = [];
    for (const s of svcs) {
      if (!(await portReady(s.port))) { unserve(s); continue; } // dead → drop
      // Only re-adopt if the server on that port is actually running IN this worktree. Ports get
      // reassigned across restarts, so a responding port may now be a DIFFERENT worktree's server —
      // adopting it would make this card serve someone else's code ("none of my changes"). If it's
      // foreign, leave it alone (its own key will re-adopt it) rather than adopt or kill it.
      const pid = listenerPids(s.port)[0];
      if (pid && cwdInWorktree(processCwd(pid), key)) live.push({ ...s, exited: false, everUp: true }); // re-adopted only because its port responded
      else unserve(s); // its serve entries point at nothing (a foreign server's own key serves it)
    }
    if (live.length) previews.set(key, live);
  }
  persist(); // rewrite pruned of the dead / foreign
}

// Pick a random port in the range. With a wide range (~90k) two previews launched close together
// colliding is ~1/rangeSize, so there's no need to reserve/track assigned ports — just re-roll if
// the OS says the chosen one is already in use.
export async function freePort(range: [number, number]): Promise<number> {
  const [min, max] = range;
  for (let i = 0; i < 20; i++) {
    const p = min + Math.floor(Math.random() * (max - min + 1));
    if (await portFree(p)) return p;
  }
  throw new Error(`no free port in ${min}–${max}`);
}

/** Kill whatever is listening on a port — precise reaping of a tracked service's actual listener
 *  (the node/bun grandchild the sh wrapper's kill misses), regardless of process tree. */
function killPort(port: number): void {
  for (const pid of listenerPids(port)) { try { process.kill(pid); } catch { /* gone */ } }
}

/** Reap dev servers left running inside this worktree by a PRIOR run (their ports are unknown after
 *  a bridge restart). Deliberately narrow — matches only processes launched from the worktree's
 *  node_modules (vite/nest), NOT a shell/editor/agent that merely has the path in its args. */
function killWorktree(cwd: string): void {
  try { Bun.spawnSync(["pkill", "-f", `${cwd}.*node_modules`]); } catch { /* nothing matched */ }
}

/** Kill a process AND all its descendants (leaves first). The `sh -lc` preview wrapper backgrounds
 *  a reseed subshell (`( until curl … ; do sleep 2; done; invite… ) &`) whose argv has no worktree
 *  path or `node_modules` token — so neither proc.kill() (the sh only) nor killWorktree (argv match)
 *  reaps it, and it polls a dead port forever after a stop/restart. Walking the pid tree catches it.
 *  macOS Bun.spawn has no process-group option, hence the manual pgrep walk. */
export function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  const kids = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString().trim().split("\n").filter(Boolean);
  for (const k of kids) killTree(Number(k), signal);
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

/** What a preview command's placeholders expand to. Pure, so the URL and env logic is testable.
 *  - `{port}` this service's port; `{svc:name}` another's port; `{db}` the preview's database.
 *  - `{host}` the plain host the browser reaches a preview at; `{bind}` what services listen on.
 *  - `{url:name}` the URL the browser opens for a service: `https://<ts.net name>:<https port>` when
 *    the preview is served over HTTPS (server/tsserve.ts), else `http://{host}:{svc:name}`.
 *  - `{hosts}` every host name the browser may use, comma-separated — for a dev server's allowed hosts. */
export type CommandContext = { name: string; ports: Record<string, number>; db: string; host: string; bind: string; https?: { host: string; ports: Record<string, number> } };
export function expandCommand(command: string, c: CommandContext): string {
  const url = (n: string): string => c.https?.ports[n] !== undefined ? `https://${c.https.host}:${c.https.ports[n]}` : `http://${c.host}:${c.ports[n] ?? ""}`;
  const hosts = [...new Set([c.host, ...(c.https ? [c.https.host] : [])])].join(",");
  return command
    .replace(/\{port\}/g, String(c.ports[c.name]))
    .replace(/\{svc:(\w+)\}/g, (_, n) => String(c.ports[n] ?? ""))
    .replace(/\{url:(\w+)\}/g, (_, n) => url(n))
    .replace(/\{hosts\}/g, hosts)
    .replace(/\{db\}/g, c.db)
    // `{host}` is what the BROWSER reaches the preview at (a frontend's backend URL); `{bind}` is
    // what the service listens on. The same on a laptop (localhost); not on a box.
    .replace(/\{host\}/g, c.host)
    .replace(/\{bind\}/g, c.bind);
}

/** The ports one service's HTTPS needs: its own, and port + 1 for `httpsNextPort` (e.g. branch-demo's
 *  collab socket, which the frontend reaches at the backend URL's port + 1). */
const httpsSpan = (s: { httpsNextPort?: boolean }): number => (s.httpsNextPort ? 2 : 1);

/** Pick an HTTPS port per service in `range` (the tailnet ACL admits only that range): for a service
 *  with `httpsNextPort`, a pair H, H + 1. Never a port in `taken` (this preview's own ports, other
 *  previews' HTTPS ports) or one `free` says the OS holds (a serve entry listens, so it counts). */
export async function pickHttpsPorts(services: { name: string; httpsNextPort?: boolean }[], range: [number, number], taken: Set<number>, free: (p: number) => Promise<boolean> = portFree): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const used = new Set(taken);
  const [min, max] = range;
  for (const s of services) {
    const span = httpsSpan(s);
    let found: number | undefined;
    for (let i = 0; i < 40 && found === undefined; i++) {
      const p = min + Math.floor(Math.random() * (max - min + 2 - span));
      const ports = Array.from({ length: span }, (_, k) => p + k);
      if (ports.some((q) => used.has(q))) continue;
      if ((await Promise.all(ports.map(free))).every(Boolean)) found = p;
    }
    if (found === undefined) throw new Error(`no free HTTPS port in ${min}–${max}`);
    for (let k = 0; k < span; k++) used.add(found + k);
    out[s.name] = found;
  }
  return out;
}

/** Remove a service's serve entries. */
function unserve(s: Https): void {
  if (s.https === undefined) return;
  tsserve.remove(s.https);
  if (s.httpsNext) tsserve.remove(s.https + 1);
}

/** Serve every service over HTTPS. Undefined (nothing left behind) when it can't. */
async function serveHttps(services: PreviewService[], ports: Record<string, number>, portRange: [number, number]): Promise<{ host: string; ports: Record<string, number> } | undefined> {
  const host = tsserve.httpsHost();
  if (!host) return undefined;
  const taken = new Set<number>();
  for (const s of services) { taken.add(ports[s.name]!); if (s.httpsNextPort) taken.add(ports[s.name]! + 1); }
  for (const svcs of previews.values()) for (const s of svcs) if (s.https !== undefined) { taken.add(s.https); if (s.httpsNext) taken.add(s.https + 1); }
  let https: Record<string, number>;
  try { https = await pickHttpsPorts(services, portRange, taken); } catch (e) { console.error(`orca: preview https: ${e instanceof Error ? e.message : e}`); return undefined; }
  const added: Https[] = [];
  for (const s of services) {
    const one: Https = { https: https[s.name]!, httpsNext: s.httpsNextPort === true };
    const ok = tsserve.add(one.https!, ports[s.name]!) && (!one.httpsNext || tsserve.add(one.https! + 1, ports[s.name]! + 1));
    added.push(one);
    if (!ok) { for (const a of added) unserve(a); return undefined; } // plain http, as before
  }
  return { host, ports: https };
}

/** `https`: the repo needs a secure context (`previewSecureContext`). On a machine that serves
 *  previews over HTTPS (`tsserve.enabled`), each service then gets an HTTPS port on the tailnet. */
export async function start(key: string, cwd: string, services: PreviewService[], portRange: [number, number], opts: { https?: boolean } = {}): Promise<void> {
  stop(key); // reap tracked procs + orphaned servers for this worktree so we never serve stale code
  const ports: Record<string, number> = {};
  for (const s of services) ports[s.name] = await freePort(portRange);
  const db = previewDbName(key); // this preview's own database name — `{db}` in commands / onStop
  const https = opts.https && tsserve.enabled(previewBind()) ? await serveHttps(services, ports, portRange) : undefined;
  const svcs: Svc[] = services.map((s) => {
    const cmd = expandCommand(s.command, { name: s.name, ports, db, host: previewHost(), bind: previewBind(), https });
    const logPath = join(tmpdir(), `orca-preview-${key.replace(/[^\w]+/g, "_")}-${s.name}.log`);
    const logFd = openSync(logPath, "w"); // capture output so a failed service is diagnosable
    const proc = Bun.spawn(["sh", "-lc", cmd], { cwd, env: scrubbedEnv(githubEnv(cwd)), stdout: logFd, stderr: logFd });
    const onStop = s.onStop?.replace(/\{db\}/g, db); // resolved now; runs at teardown (stop with teardown=true)
    const tls: Https = https ? { https: https.ports[s.name], httpsHost: https.host, httpsNext: s.httpsNextPort === true } : {};
    const svc: Svc = { name: s.name, port: ports[s.name]!, open: s.open ?? false, proc, logPath, logFd, exited: false, startedAt: Date.now(), onStop, everUp: false, ...tls };
    void proc.exited.then(() => { svc.exited = true; });
    return svc;
  });
  previews.set(key, svcs);
  persist();
}

// A dev server whose port NEVER answered within this long is wedged, not slow: `nest --watch` (the
// backend dev script) does NOT exit on a boot failure — it stays alive waiting for a file change — so
// "process alive" never clears on its own, and the card would spin on "Starting…" forever. Well above a
// cold boot (worktree npm-install self-heal + nest/vite compile) so a healthy slow start is never
// false-flagged. ponytail: a constant; make it configurable if a repo ever legitimately needs longer.
export const BOOT_TIMEOUT_MS = 180_000;

/** Whether a service counts as running/ready. The boot timeout applies ONLY before a service has ever
 *  bound its port (`everUp`): a fresh backend that never comes up is wedged and reaped. Once it HAS been
 *  up, a failed probe is a transient blip (e.g. the event loop blocked on a long request) — it stays
 *  running (only an actual process exit, via `alive`, marks it down), so a busy live server is never
 *  reaped, which would drop its per-preview DB. Pure, so both cases are testable without spawning. */
export function svcHealth(alive: boolean, up: boolean, everUp: boolean, startedAt: number, now: number): { running: boolean; ready: boolean } {
  const wedged = alive && !up && !everUp && now - startedAt > BOOT_TIMEOUT_MS;
  const running = alive && !wedged;
  return { running, ready: running && up };
}

async function portReady(port: number): Promise<boolean> {
  try {
    // 2s (not 700ms): under boot load a healthy dev server can be slow to answer the first request,
    // and a too-tight timeout makes "ready" flap on/off — which reads as flakiness.
    await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(2000) });
    return true; // any HTTP response means the server is up
  } catch {
    return false; // connection refused / timeout — not up yet
  }
}

const tail = async (path: string, max = 1500): Promise<string> => {
  try { return (await Bun.file(path).text()).slice(-max).trim(); } catch { return ""; }
};

/** The tail of each service's log whatever its state — `status` carries one only for a dead service,
 *  and a boot that is failing slowly (a DB setup error under a live wrapper) is read from here. */
export const logs = (key: string, max = 3000): Promise<{ name: string; log: string }[]> =>
  Promise.all((previews.get(key) ?? []).map(async (s) => ({ name: s.name, log: await tail(s.logPath, max) })));

export async function status(key: string, host = previewHost()): Promise<SvcStatus[]> {
  const svcs = previews.get(key) ?? [];
  return Promise.all(svcs.map(async (s) => {
    const up = await portReady(s.port);
    // Every service binds a port, so readiness = the port actually responds — for the backend too,
    // not just "the process is alive". The link/iframe therefore waits for the full stack (~10s for
    // the backend) instead of appearing the instant the frontend is up. Adopted svcs have no proc
    // handle, so their liveness IS the port responding. A service that NEVER binds its port past
    // BOOT_TIMEOUT_MS is wedged (crash-looping under --watch) → svcHealth reports it not-running so the
    // client reaps it; a service that HAS been up is never reaped on a probe blip (see everUp).
    if (up) s.everUp = true;
    const { running, ready } = svcHealth(s.proc ? !s.exited : up, up, s.everUp, s.startedAt, Date.now());
    // The URL is what the BROWSER opens, so it must name a host the browser can reach: `localhost`
    // is right when Orca runs on your machine and wrong the moment it runs on a box you reach over a
    // tailnet. The readiness probe below stays on localhost — that one runs here.
    // `localUrl` only when the service is on this machine's loopback; bound to a tailnet address,
    // localhost would not reach it.
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(previewBind());
    // Served over HTTPS (server/tsserve.ts): that is the URL every viewer but a localhost page opens.
    const url = s.https !== undefined && s.httpsHost ? `https://${s.httpsHost}:${s.https}` : `http://${host}:${s.port}`;
    return { name: s.name, port: s.port, url, ...(loopback ? { localUrl: `http://localhost:${s.port}` } : {}), open: s.open, running, ready, error: running ? undefined : await tail(s.logPath), startedAt: s.startedAt };
  }));
}

/** Every tracked preview, keyed by worktree path, with live status — for the running-previews menu.
 *  Not repo-scoped: the map spans all repos, keyed by absolute path.
 *  Only reflects previews started by THIS bridge process (the in-memory `previews` map) — previews
 *  orphaned by a prior bridge aren't listed, by design. */
export async function list(host = previewHost()): Promise<{ key: string; svcs: SvcStatus[] }[]> {
  return Promise.all([...previews.keys()].map(async (key) => ({ key, svcs: await status(key, host) })));
}

/** Stop a preview's services. `teardown` = an explicit Discard / preview-stop (not the reap-before-
 *  restart, and not shutdown): only then do we run each service's onStop, so a per-preview database is
 *  dropped when you're done with the branch — but never on a routine restart, which would drop the DB
 *  out from under a re-spin. onStop runs with the worktree (still present at this point) as cwd. */
export function stop(key: string, teardown = false): void {
  const svcs = previews.get(key) ?? [];
  if (teardown) {
    for (const s of svcs) {
      if (!s.onStop) continue;
      // Best-effort and synchronous: a drop-database is quick, and the worktree it needs (env + drop
      // script) is still on disk here — callers remove it only after stop() returns.
      try { Bun.spawnSync(["sh", "-lc", s.onStop], { cwd: key, env: scrubbedEnv(), stdout: "ignore", stderr: "ignore" }); } catch { /* best effort */ }
    }
  }
  for (const s of svcs) {
    if (s.proc?.pid) { try { killTree(s.proc.pid); } catch { /* gone */ } } // reap the sh wrapper + ALL its children (nest/vite + the backgrounded reseed loop)
    else { try { s.proc?.kill(); } catch { /* already gone / adopted, no handle */ } }
    killPort(s.port); // precise: reap the actual listener the sh-wrapper kill (or adoption) leaves behind
    unserve(s); // its HTTPS entries on the tailnet
    if (s.logFd !== undefined) { try { closeSync(s.logFd); } catch { /* already closed */ } }
  }
  killWorktree(key); // key === worktree path; sweeps orphans from a prior run (narrow pattern)
  previews.delete(key);
  persist();
}

/** Kill all preview services — call on server shutdown. Not a teardown: leaves per-preview DBs intact
 *  so a restart re-spins against them (they're dropped only on an explicit Discard / preview-stop). */
export function killAll(): void {
  for (const key of [...previews.keys()]) stop(key);
}

// --- orphan preview-DB / stale test-container reaper -----------------------------------------
//
// onStop drops a preview's own database when it is torn down deliberately, but a preview that dies
// with a bridge crash, a `reapWorktrees`'d worktree, or a worker's own test run leaves its database
// behind — nothing else collects it (one instance had 8 of them totalling ~6.6 GB). Run at startup
// and hourly from server/index.ts; every failure is logged and otherwise ignored, never surfaced to
// a caller — a reaper that can crash the bridge is worse than no reaper.

/** A preview mid-clone is never older than this; a database younger than it is left for the next
 *  pass rather than treated as a settled orphan. */
const DB_GRACE_MS = 2 * 60 * 60 * 1000;
/** branch-demo's test harness containers routinely run a few minutes; anything past this is a run
 *  that never cleaned up after itself. */
const CONTAINER_STALE_MS = 3 * 60 * 60 * 1000;

export type ReapReport = { at: number; droppedDbs: string[]; removedContainers: string[] };
let lastReap: ReapReport | undefined;
/** The reaper's last pass, for /api/diagnostics — undefined until one has run. */
export const lastReapReport = (): ReapReport | undefined => lastReap;

/** Where a repo's preview-Postgres admin credentials live: the directory holding the `.env`
 *  `copyToWorktree` names (e.g. "backend/.env") — the same file a live preview's {db} commands read.
 *  A repo with no such entry has no per-preview database to reap. */
function envFileFor(repo: RepoConfig): { dir: string; path: string } | undefined {
  const rel = (repo.copyToWorktree ?? []).find((p) => p.endsWith(".env"));
  if (!rel) return undefined;
  return { dir: join(repo.repoPath, dirname(rel)), path: join(repo.repoPath, rel) };
}

/**
 * Drop orphan preview databases and remove stale test containers across every given repo (the ones
 * checked out on this instance — see verbs.repoHere). Pure selection (orphanPreviewDbs) decides what
 * counts as an orphan; this is the IO shell around it. Call at startup, then hourly. `dryRun` reports
 * what it WOULD drop/remove and touches nothing; `liveFrom` (default `repos`) are the repos whose
 * worktrees count as live — scripts/preview-gc.ts narrows `repos` but keeps every repo's live.
 */
export async function reap(
  repos: RepoConfig[],
  opts: { dbGraceMs?: number; containerStaleMs?: number; dryRun?: boolean; liveFrom?: RepoConfig[] } = {},
): Promise<ReapReport> {
  const dbGraceMs = opts.dbGraceMs ?? DB_GRACE_MS;
  const containerStaleMs = opts.containerStaleMs ?? CONTAINER_STALE_MS;
  const droppedDbs: string[] = [];
  const removedContainers: string[] = [];

  // Live = every worktree every repo on this instance still has, plus every preview this bridge is
  // tracking (owned or re-adopted) — belt and suspenders for a key not yet reflected in `git worktree
  // list` (e.g. a worktree removal and this pass racing).
  const live = new Set<string>(previews.keys());
  for (const repo of opts.liveFrom ?? repos) {
    try {
      for (const w of await git.listWorktrees(repo.repoPath, repo.worktreeRoot)) live.add(w.worktreePath);
    } catch (e) { console.error(`orca: reap: couldn't list worktrees for ${repo.name}`, e); }
  }
  const liveWorktreePaths = [...live];

  const seenEnv = new Set<string>();
  for (const repo of repos) {
    const env = envFileFor(repo);
    if (!env || seenEnv.has(env.path)) continue;
    seenEnv.add(env.path);
    try {
      const candidates = await previewdb.orphanCandidates(env.path);
      const orphans = new Set(orphanPreviewDbs(candidates.map((c) => c.name), liveWorktreePaths));
      for (const c of candidates) {
        if (!orphans.has(c.name) || c.ageMs < dbGraceMs) continue;
        try {
          if (!opts.dryRun) await previewdb.dropPreviewDb(env.dir, c.name);
          droppedDbs.push(c.name);
          if (!opts.dryRun) console.log(`orca: reaped orphan preview db ${c.name}`);
        } catch (e) { console.error(`orca: reap: failed to drop preview db ${c.name}`, e); }
      }
    } catch (e) { console.error(`orca: reap: failed to list preview dbs for ${repo.name}`, e); }
  }

  const seenPrefix = new Set<string>();
  for (const repo of repos) {
    const prefix = repo.testContainerPrefix;
    if (!prefix || seenPrefix.has(prefix)) continue;
    seenPrefix.add(prefix);
    try {
      for (const c of await docker.listContainers(prefix)) {
        if (Date.now() - c.createdAt < containerStaleMs) continue;
        try {
          if (!opts.dryRun) await docker.removeContainer(c.name);
          removedContainers.push(c.name);
          if (!opts.dryRun) console.log(`orca: reaped stale test container ${c.name}`);
        } catch (e) { console.error(`orca: reap: failed to remove container ${c.name}`, e); }
      }
    } catch (e) { console.error(`orca: reap: failed to list containers for prefix ${prefix}`, e); }
  }

  const report = { at: Date.now(), droppedDbs, removedContainers };
  if (!opts.dryRun) lastReap = report;
  return report;
}
