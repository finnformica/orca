// ONE bridge per instance runs the background duties: orchestrator wakes and drains, run-finished
// reporting, the merge queue, cleanup and the reaper, autofix and PR upkeep, the publish loops,
// lease adoption. Every other bridge on that instance serves HTTP only.
//
// Why (incident 2026-10-14): four full bridges started by hand from finished workstreams' worktrees
// (for screenshots, instead of scripts/preview-orca.sh) kept running on the shared database after
// their worktrees were deleted. Stale code with full duties: one woke the orchestrator with PATH
// naming the deleted worktree's bin/ and ORCA_URL its own port, and any of them could have merged,
// reaped or addressed PRs. Defence in depth:
//  1. a Postgres session advisory lock per instance (`pg_try_advisory_lock`, no schema) — the holder
//     is primary; a bridge that can't take it logs that it is secondary and retries, so a restart's
//     new process takes over once the old one's connection closes;
//  2. a bridge whose code lives under a `.worktrees/` path never even tries, unless `ORCA_PRIMARY=1`;
//  3. `watchSource`: a bridge whose own source directory disappears exits.
// The lock rides its OWN one-connection client, not db.ts's pool: the pool recycles connections
// (idleTimeout/maxLifetime) and a session lock dies with its connection.
import { existsSync } from "fs";
import { join } from "path";
import { instanceName, previewBridge } from "./db";

/** How often a secondary retries the lock, and a primary re-asserts it (a dropped connection loses it). */
export const PRIMARY_RETRY_MS = Number(process.env.ORCA_PRIMARY_RETRY_MS) || 5_000;
export const PRIMARY_HEARTBEAT_MS = 30_000;
/** How often a bridge checks that its own source directory still exists. */
export const SOURCE_WATCH_MS = Number(process.env.ORCA_SOURCE_WATCH_MS) || 20_000;

const SOURCE_DIR = import.meta.dir;

/** Why a bridge whose code is at `dir` may not run background duties at all, or undefined. A bridge
 *  inside a `.worktrees/` checkout is a worker's (or a stray), never the instance's own. */
export function worktreeRefusal(dir: string = SOURCE_DIR, env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.ORCA_PRIMARY === "1") return undefined;
  if (!/(^|\/)\.worktrees\//.test(dir)) return undefined;
  return `started from a worktree (${dir}); set ORCA_PRIMARY=1 to allow background duties`;
}

let elected = false;
let primary = false;
let reason = "not elected yet";
let client: Bun.SQL | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners: (() => unknown)[] = [];
let fired = false;

/** Whether THIS process may run background duties. True in a process that never ran the election
 *  (a test calling the orchestrator in-process, a script): the guard is the bridge's, not the code's. */
export const held = (): boolean => !elected || primary;

/** For /api/health and /api/diagnostics. */
export const state = (): { primary: boolean; reason: string } => ({ primary: elected ? primary : true, reason: elected ? reason : "no election" });

/** Run `fn` once, the first time this process becomes primary (or now, if it already is). */
export function onPrimary(fn: () => unknown): void {
  if (fired) { void Promise.resolve().then(fn).catch((e) => console.error("orca: primary duty failed", e)); return; }
  listeners.push(fn);
}

function become(next: boolean, why: string): void {
  if (next !== primary || why !== reason) console.log(next ? `orca: primary for instance ${instanceName()} — running background duties` : `orca: secondary bridge (${why}) — serving HTTP only, no background duties`);
  primary = next;
  reason = why;
  if (next && !fired) {
    fired = true;
    for (const fn of listeners.splice(0)) void Promise.resolve().then(fn).catch((e) => console.error("orca: primary duty failed", e));
  }
}

/** The lock key: per instance, and per schema so parallel test schemas on one server never contend. */
async function tryLock(): Promise<boolean> {
  const url = process.env.ORCA_DATABASE_URL || "postgres://localhost:5432/orca";
  client ??= new Bun.SQL(url, { max: 1, idleTimeout: 0, maxLifetime: 0, connectionTimeout: Number(process.env.ORCA_DB_CONNECT_TIMEOUT_S) || 5 });
  const key = `orca-primary:${instanceName()}`;
  // Re-entrant: a primary re-asserting gets true again on the same session; on a NEW session (the
  // old one dropped) it is true only if nobody else took it meanwhile.
  const [row] = await client`SELECT pg_try_advisory_lock(hashtext(${key} || ':' || current_schema())) AS got`;
  return Boolean(row?.got);
}

async function attempt(): Promise<void> {
  try {
    const got = await tryLock();
    become(got, got ? "holds the instance lock" : `another bridge holds instance ${instanceName()}'s lock`);
  } catch (e) {
    // The connection is gone (database down, dropped): the lock went with it. A fresh client next time.
    void client?.end().catch(() => {});
    client = null;
    become(false, `database unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  timer = setTimeout(() => void attempt(), primary ? PRIMARY_HEARTBEAT_MS : PRIMARY_RETRY_MS);
  timer.unref();
}

/** Start the election (server/index.ts, once). A preview bridge or a worktree's bridge never takes
 *  part — it is secondary for its whole life. */
export function elect(): void {
  if (elected) return;
  elected = true;
  const refused = previewBridge() ? "a branch preview's bridge" : worktreeRefusal();
  if (refused) { become(false, refused); return; }
  void attempt();
}

/** Let the lock go (shutdown): the next bridge takes it at once rather than at its next retry. */
export async function release(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const c = client;
  client = null;
  primary = false;
  await c?.end().catch(() => {});
}

/** Call `onGone` once if `dir` (this bridge's own source) stops existing — a worktree reaped under a
 *  bridge somebody started by hand. Checks a file in it, so an emptied directory counts too. */
export function watchSource(onGone: () => unknown, dir: string = SOURCE_DIR, ms = SOURCE_WATCH_MS): ReturnType<typeof setInterval> {
  const probe = join(dir, "index.ts");
  const t = setInterval(() => {
    if (existsSync(probe)) return;
    clearInterval(t);
    console.error(`orca: this bridge's source (${dir}) is gone — exiting`);
    void onGone();
  }, ms);
  t.unref();
  return t;
}

/** The main install (the repository's primary checkout, never a linked worktree) and its `bin/`, for
 *  the orchestrator's PATH: `git rev-parse --git-common-dir` from this file names the main checkout's
 *  `.git` even from a worktree. Verified to hold `bin/orca`; falls back to this checkout's own when
 *  that does (a tarball deploy with no .git). Throws when neither has it — a wake with no `orca`
 *  command is the incident, not a degraded mode. */
export function mainBin(dir: string = SOURCE_DIR): string {
  const out = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, stderr: "ignore" });
  const common = out.success ? out.stdout.toString().trim() : "";
  const candidates = [common ? join(common, "..", "bin") : "", join(dir, "..", "bin")].filter(Boolean);
  for (const bin of candidates) if (existsSync(join(bin, "orca"))) return bin;
  throw new Error(`no orca command found (looked in ${candidates.join(", ")})`);
}
