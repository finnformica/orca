// Orca's one bit of on-disk *operational* state — NOT app/business state (that stays in git, gh, and
// the browser's localStorage; see CLAUDE.md). Two things live here: per-worktree run leases (so a
// restarted bridge won't launch a second agent over a still-live one) and the bounded run ledger
// (observability). Both are advisory: if a file is missing or unreadable the system must degrade —
// reclaim the lease, drop the ledger record — never refuse a legitimate run. Kept OUT of every
// worktree so it can't leak into a diff or PR body.
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, readdirSync } from "fs";

/** Root for operational state. Overridable so tests (and parallel checkouts) get an isolated dir. */
export function stateDir(): string {
  return process.env.ORCA_STATE_DIR || join(homedir(), ".orca");
}

/** Absolute path under the state dir, creating the parent directory on demand. */
export function statePath(...parts: string[]): string {
  const full = join(stateDir(), ...parts);
  mkdirSync(join(full, ".."), { recursive: true });
  return full;
}

/** Atomic write: a torn read during a poll would corrupt the JSON, so write a temp file and rename
 *  it into place (rename is atomic on the same filesystem). Synchronous so callers stay non-async. */
export function writeAtomicSync(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
export const writeJsonSync = (path: string, value: unknown): void => writeAtomicSync(path, JSON.stringify(value));

/** Persist a cross-provider handoff seed for a branch so the interactive CLI can start a NEW native
 *  session already primed with the portable transcript — the maxed/previous model is never resumed.
 *  Lives under the state dir, never a worktree, so it can't leak into a diff or PR. Returns the
 *  absolute path for the shell to `cat`. Atomic write so a concurrent read never sees a torn file. */
export function writeHandoffFile(repo: string, branch: string, content: string): string {
  const name = `${repo}--${branch}`.replace(/[^\w.-]+/g, "-");
  const path = statePath("handoff", `${name}.md`);
  writeAtomicSync(path, content);
  return path;
}

/** Read + parse JSON, or `undefined` if the file is missing or corrupt (never throws). */
export function readJsonSync<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Every `*.json` file in `dir` that `accept` takes (by name), parsed, in name order — a missing dir
 *  is empty, and an unreadable or corrupt file is skipped (never throws). */
export function readJsonDir<T>(dir: string, accept: (name: string) => boolean = () => true): { file: string; value: T }[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith(".json") && accept(n)).sort()
    .map((n) => ({ file: join(dir, n), value: readJsonSync<T>(join(dir, n)) }))
    .filter((e): e is { file: string; value: T } => e.value !== undefined);
}
