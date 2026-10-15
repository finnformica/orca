// Thin adapter onto the Postgres that hosts per-preview databases — listing orphan candidates (for
// server/preview.ts's reaper) and dropping one. Connects the same way scripts/preview-db.sh does:
// DB_HOST/DB_PORT/DB_MASTER_USER/PGPASSWORD read from a repo's own `.env` (never a value on argv).
// It owns the env-file parser and the psql connection that server/pushTemplate.ts also uses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run, runCmd } from "./run";

const SCRIPT = join(import.meta.dir, "../scripts/preview-db.sh");

type EnvLine = { value: string; line: string };
/** KEY=value lines (optionally `export`ed, quotes stripped for comparison); the raw line is kept so a
 *  copied variable is written exactly as the file has it. Last assignment wins, as dotenv/bash. */
export function parseEnv(text: string): Map<string, EnvLine> {
  const out = new Map<string, EnvLine>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const raw = m[2]!.trim();
    out.set(m[1]!, { value: raw.match(/^(['"])(.*)\1$/)?.[2] ?? raw, line: line.replace(/^\s*export\s+/, "") });
  }
  return out;
}

/** The libpq env for the Postgres a repo's env file names (preview-db.sh's DB_HOST/DB_PORT/
 *  DB_MASTER_USER/PGPASSWORD) — on the environment, never argv. An empty value takes the default. */
export function pgEnv(envText: string): Record<string, string> {
  const vars = parseEnv(envText);
  const get = (k: string) => vars.get(k)?.value || undefined;
  const pg: Record<string, string> = {
    PGHOST: get("DB_HOST") ?? "localhost",
    PGPORT: get("DB_PORT") ?? "5432",
    PGUSER: get("DB_MASTER_USER") ?? "postgres",
    PGDATABASE: "postgres",
  };
  if (get("PGPASSWORD")) pg.PGPASSWORD = get("PGPASSWORD")!;
  return pg;
}

/** One psql query (tuples only, unaligned), trimmed. */
export async function psql(pg: Record<string, string>, query: string): Promise<string> {
  return (await runCmd(["psql", "-X", "-v", "ON_ERROR_STOP=1", "-tAc", query], { env: pg })).stdout.trim();
}

export type PreviewDbCandidate = { name: string; ageMs: number };

/**
 * Every `orca_*` database on the Postgres named by `envPath` (a repo's own `.env`), with its
 * approximate age — the modification time of its data directory, via `pg_stat_file` (the admin user
 * preview-db.sh requires is a superuser, so this is readable). Not a real "created at" — an idle
 * orphan's directory mtime IS its age, which is all the reaper needs (skip anything too young to be
 * an orphan rather than a preview mid-clone). Coarse: the mtime is whole seconds and the age is
 * floored, so a brand-new database can read up to 1s old — fine against the 2h grace, not a 1s one.
 */
export async function orphanCandidates(envPath: string): Promise<PreviewDbCandidate[]> {
  const pg = pgEnv(readFileSync(envPath, "utf8"));
  const query = "SELECT datname || '|' || floor(extract(epoch from now() - coalesce((pg_stat_file('base/' || oid, true)).modification, now()))) FROM pg_database WHERE datname ~ '^orca_'";
  const out = await psql(pg, query);
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [name, age] = line.split("|");
    return { name: name!, ageMs: Math.max(0, Number(age ?? 0)) * 1000 };
  });
}

/** Drop one orphan preview database via the repo's own preview-db.sh — same guardrails (orca_* only,
 *  a valid identifier) as a live preview's teardown runs. `envDir` is the directory holding the
 *  `.env` the script reads (its cwd); a drop needs nothing else the script normally expects (no
 *  scripts/migrate-local.sh call, unlike `create`). */
export async function dropPreviewDb(envDir: string, name: string): Promise<void> {
  await run(["bash", SCRIPT, "drop", name], envDir);
}
