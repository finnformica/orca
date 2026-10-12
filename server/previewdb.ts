// Thin adapter onto the Postgres that hosts per-preview databases — listing orphan candidates (for
// server/preview.ts's reaper) and dropping one. Connects the same way scripts/preview-db.sh does:
// DB_HOST/DB_PORT/DB_MASTER_USER/PGPASSWORD read from a repo's own `.env` (never a value on argv),
// mirroring server/pushTemplate.ts's own psql adapter — so there are now two call sites instead of a
// shared helper neither owns, which is still less than teaching preview-db.sh a `list` subcommand it
// has to validate DB-free.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "./pushTemplate";
import { run } from "./run";

const SCRIPT = join(import.meta.dir, "../scripts/preview-db.sh");

function pgEnv(envPath: string): Record<string, string> {
  const vars = parseEnv(readFileSync(envPath, "utf8"));
  const get = (k: string) => vars.get(k)?.value;
  const pg: Record<string, string> = {
    PGHOST: get("DB_HOST") ?? "localhost",
    PGPORT: get("DB_PORT") ?? "5432",
    PGUSER: get("DB_MASTER_USER") ?? "postgres",
    PGDATABASE: "postgres",
  };
  if (get("PGPASSWORD")) pg.PGPASSWORD = get("PGPASSWORD")!;
  return pg;
}

async function psql(pg: Record<string, string>, query: string): Promise<string> {
  const proc = Bun.spawn(["psql", "-X", "-v", "ON_ERROR_STOP=1", "-tAc", query], { env: { ...process.env, ...pg }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`psql failed (exit ${code}): ${err.trim() || out.trim()}`);
  return out.trim();
}

export type PreviewDbCandidate = { name: string; ageMs: number };

/**
 * Every `orca_*` database on the Postgres named by `envPath` (a repo's own `.env`), with its
 * approximate age — the modification time of its data directory, via `pg_stat_file` (the admin user
 * preview-db.sh requires is a superuser, so this is readable). Not a real "created at" — an idle
 * orphan's directory mtime IS its age, which is all the reaper needs (skip anything too young to be
 * an orphan rather than a preview mid-clone).
 */
export async function orphanCandidates(envPath: string): Promise<PreviewDbCandidate[]> {
  const pg = pgEnv(envPath);
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
