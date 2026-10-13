// The durable chat history. Unlike the leases and the ledger (advisory operational state), this IS
// app state — a deliberate reversal of the original "no DB" rule, made once the conversation became
// something worth keeping rather than a cache of the last run.
//
// Why it exists: an agent's response lived only in `runs` (an in-memory Map in server/agent.ts) until
// a browser poll happened to collect it. A bridge restart, a closed tab, or simply a fast follow-up
// overwriting the map entry before the next 8s poll all destroyed the turn permanently. The fix is to
// write the turn where the data already is — at launch, and again at exit.
//
// POSTGRES, not SQLite: the database is becoming the shared source of truth for more than one Orca
// instance (a cloud box and a laptop, each executing its own worktrees against one database), which a
// file on one host cannot be. `Bun.SQL` ships with the runtime, so this costs no dependency. The API
// is async throughout — see `recordTurn` in agent.ts for how the one fire-and-forget caller keeps its
// synchronous signature.
//
// EVERY table carries `user_id` from the first migration. There is no auth yet (see `currentUser`)
// and exactly one user, but retrofitting row-level scoping later would mean revisiting every query in
// the codebase — so the column goes in now, while it is free.
//
// Retention is the point. Nothing is deleted: a finished workstream is ARCHIVED, so the conversations
// most worth chaining from (the ones whose branches got merged and reaped) survive. Turn granularity
// is prompt + final response + structured outcome — what you'd feed a model — not the provider's raw
// event stream, which is far larger, mostly tool output, and already kept by the provider itself.
// `raw_ref` points back at that deep transcript for anything that needs it later.
//
// Contains prompts and responses in plaintext: keep the database off the public internet (it is
// reached over the tailnet) and never inside a worktree, so it can't leak into a diff or PR.
import { statSync } from "fs";
import { hostname } from "os";
import { join } from "path";
import type { AgentOutcome, AgentProvider, AgentTurn, StopReason, TurnCheck, TurnSource } from "../shared/agent";
import * as bus from "./bus";
import type { Notification, NotificationInput } from "../shared/notifications";

export type TurnStatus = "running" | "done" | "error" | "stopped";

/** Whose data this request touches. A constant until auth exists: the MVP has exactly one user, but
 *  every query is already scoped by it, so adding real identity later replaces THIS function and
 *  nothing else. (Tailscale can supply the identity when that time comes.) */
export function currentUser(): string {
  return process.env.ORCA_USER || "me";
}

/** Where the database lives. Local dev and the deployed instance differ only by this string. */
const databaseUrl = (): string => process.env.ORCA_DATABASE_URL || "postgres://localhost:5432/orca";

let handle: Bun.SQL | null = null;
let handleUrl: string | null = null;
let ready: Promise<void> | null = null;

/** The connection pool, migrated on first use. Lazy so ORCA_DATABASE_URL can be set after import —
 *  and so a test that repoints it gets a fresh pool rather than the previous one's.
 *
 *  `idleTimeout`/`maxLifetime`/`connectionTimeout` (seconds) recycle pooled connections on OUR
 *  schedule rather than finding out the hard way: a laptop that sleeps for a while comes back to a
 *  remote Postgres that already dropped every connection it was holding, and the pool otherwise only
 *  discovers that on the next query (see `run`, below). */
export function db(): Bun.SQL {
  const url = databaseUrl();
  if (handle && handleUrl === url) return handle;
  void handle?.end();
  handle = new Bun.SQL(url, { idleTimeout: 30, maxLifetime: 3600, connectionTimeout: 10 });
  handleUrl = url;
  ready = migrate(handle);
  return handle;
}

/** The pool, with migrations applied. Every query goes through this. */
export async function open(): Promise<Bun.SQL> {
  const sql = db();
  await ready;
  return sql;
}

/** Close the pool (tests, so a repointed database opens cleanly). */
export async function close(): Promise<void> {
  const closing = handle;
  handle = null;
  handleUrl = null;
  ready = null;
  await closing?.end().catch(() => {});
}

/** Whether `err` is the pool finding out, mid-query, that the remote end is gone — the laptop-sleep
 *  case: Bun.SQL's own pooled connections survive the sleep in JS-land but the remote Postgres (or
 *  something in between) has long since dropped them, so the first query after waking fails with
 *  `ERR_POSTGRES_CONNECTION_CLOSED` (and, depending on how the drop was noticed, sometimes surfaces
 *  as a plain ECONNRESET/EPIPE instead). A connection the SERVER killed outright — `pg_terminate_
 *  backend`, a restart — means the same thing but arrives as the generic `ERR_POSTGRES_SERVER_ERROR`
 *  with "terminating connection" in the message, so it's matched by text rather than code; a bad
 *  query (a constraint violation, say) is also `ERR_POSTGRES_SERVER_ERROR` but never says that, so
 *  this stays narrow. A `pg_terminate_backend` landing while the socket is mid read/write (rather
 *  than idle) instead surfaces as Bun's own `ERR_POSTGRES_EXPECTED_REQUEST` ("Failed to read data",
 *  from its internal `handleClose`) — same dropped connection, a driver-level code instead of a
 *  server message, caught on `code` alone since that shape never carries a legitimate query error.
 *  Not every Postgres error — a bad query must still throw. */
function isDroppedConnection(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code === "ERR_POSTGRES_CONNECTION_CLOSED" || code === "ERR_POSTGRES_EXPECTED_REQUEST") return true;
  if (/Connection closed|ECONNRESET|EPIPE/.test(err.message)) return true;
  return code === "ERR_POSTGRES_SERVER_ERROR" && /terminating connection|administrator command/i.test(err.message);
}

/** Every exported query goes through here rather than calling `open()` itself, so the one retry
 *  policy lives in one place instead of a catch block hand-copied into every function. On a dropped
 *  connection, the pool is discarded and reopened and `fn` is retried exactly once against the fresh
 *  pool — including a `sql.begin(...)` inside `fn`, which re-runs the WHOLE transaction rather than
 *  resuming it, since a dropped connection mid-transaction has already rolled it back. A second
 *  failure (dropped connection or otherwise) is not retried again and surfaces to the caller.
 *  Exported so a test can drive it directly with a real dropped connection (`tests/pg.ts`), rather
 *  than only through whichever exported function happens to run one query. */
export async function withRetry<T>(fn: (sql: Bun.SQL) => Promise<T>): Promise<T> {
  try {
    return await fn(await open());
  } catch (err) {
    if (!isDroppedConnection(err)) throw err;
    console.error("[db] connection dropped, reopening pool:", err instanceof Error ? err.message : err);
    await close();
    return fn(await open());
  }
}

// Numbered, append-only steps recorded in `migration`. Never change what an applied step DOES — add
// another. (SQLite's `PRAGMA user_version` did this job before; Postgres needs the table, but the
// discipline is identical, and deliberately not a migration framework.)
//
// A step's identity is its id AND its `name`. Keying on the id alone let two parallel branches each
// append "the next id": one branch's 13 and 14 reached the shared database first, and main's 13 (the
// `running_agents` column) was then skipped as "already applied" — every metrics sample failed. The
// runner now compares the recorded name with the code's before it applies anything (`planMigrations`).
// `idempotent` steps are safe to run again — every statement is IF NOT EXISTS — so a recorded-but-
// foreign id is healed by simply running main; a step that is not (an UPDATE whose re-run would
// change later data) refuses to start instead. Write new steps idempotently wherever Postgres allows.
export type MigrationStep = { id: number; name: string; idempotent: boolean; sql: string };

export const MIGRATIONS: MigrationStep[] = [
  {
    id: 1,
    name: "workstream-and-turn",
    idempotent: true,
    sql: `
      CREATE TABLE IF NOT EXISTS workstream (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at BIGINT NOT NULL,
        archived_at BIGINT
      );
      -- Only ONE live workstream per (user, repo, branch). Archived rows are exempt, so a branch name
      -- can be reused after its predecessor is merged without colliding with the dead one's history.
      CREATE UNIQUE INDEX IF NOT EXISTS workstream_live ON workstream (user_id, repo, branch)
        WHERE archived_at IS NULL;

      CREATE TABLE IF NOT EXISTS turn (
        id BIGSERIAL PRIMARY KEY,
        workstream_id BIGINT NOT NULL REFERENCES workstream(id),
        user_id TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT,
        structured JSONB,
        session_id TEXT,
        raw_ref TEXT,
        started_at BIGINT NOT NULL,
        finished_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS turn_ws ON turn (workstream_id, started_at);
    `,
  },
  {
    id: 2,
    name: "repo-and-app-config",
    idempotent: true,
    sql: `
      -- One row per managed repo, so adding a project is an insert rather than a redeploy. The
      -- RepoConfig lives as JSONB because its shape is the app's and grows regularly; a column per
      -- field would mean a migration per field for no query we actually run.
      CREATE TABLE IF NOT EXISTS repo_config (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        config JSONB NOT NULL,
        position INT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS repo_config_name ON repo_config (user_id, name);

      -- The handful of settings that aren't per-repo (port range, stale hours, run timeout).
      CREATE TABLE IF NOT EXISTS app_config (
        user_id TEXT PRIMARY KEY,
        config JSONB NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `,
  },
  {
    id: 3,
    name: "repo-features-backfill",
    idempotent: false,
    // Per-repo opt-ins default to OFF, but a repo configured BEFORE they existed was already doing
    // all of this — so record what it was doing rather than silently switching it off underneath a
    // working board. New repos start closed; existing ones become explicit and revocable.
    // `previews` is only turned on where the repo actually defines services, and Slack only where a
    // channel is set, so the backfill grants nothing the repo wasn't already able to do.
    sql: `
      UPDATE repo_config SET config = config
        || jsonb_build_object(
             'features', jsonb_build_object(
               'slack',            config ? 'slackChannel',
               'followAutomation', true,
               'aiPrDescription',  true,
               'autoMerge',        true,
               'previews',         COALESCE(jsonb_array_length(config->'previewServices') > 0, false),
               'aiTitles',         true
             ),
             'agentPermissionMode', 'bypass',
             'providers', COALESCE(config->'providers', '["claude","codex","cursor"]'::jsonb)
           )
        WHERE NOT config ? 'features';
    `,
  },
  {
    id: 4,
    name: "worktree-inventory-and-instance",
    idempotent: true,
    // What each instance can see. The board used to be computed live from the local filesystem on
    // every poll, which stops working the moment a second instance owns some of the worktrees: the
    // laptop cannot stat the cloud box's disk. Each instance PUBLISHES what it sees instead, and the
    // board is served from here — so an instance that is asleep leaves its rows stale rather than
    // making the whole board slow or empty.
    sql: `
      CREATE TABLE IF NOT EXISTS worktree_inventory (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        instance TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        data JSONB NOT NULL,
        seen_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS worktree_inventory_key
        ON worktree_inventory (user_id, instance, repo, branch);

      -- Liveness, so the board can say "this machine last checked in 40 minutes ago" instead of
      -- silently presenting stale rows as current.
      CREATE TABLE IF NOT EXISTS instance (
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        seen_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, name)
      );
    `,
  },
  {
    id: 5,
    name: "turn-step",
    idempotent: true,
    // The agent's recorded steps. These lived as JSONL files under the state dir, which is right for
    // one machine and wrong for two: a transcript on the cloud box's disk cannot be read by a board
    // open on the laptop, so opening that conversation showed nothing. Making the database the source
    // of truth has to include the steps, or "the same conversation from either machine" isn't true.
    //
    // `seq` is per run and unique, which also makes ingestion idempotent — a retried write cannot
    // duplicate a step.
    sql: `
      CREATE TABLE IF NOT EXISTS turn_step (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        seq INT NOT NULL,
        step JSONB NOT NULL,
        at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS turn_step_key ON turn_step (run_id, seq);
    `,
  },
  {
    id: 6,
    name: "turn-instance",
    idempotent: true,
    // Which instance ran a turn. Without it, startup reconciliation is dangerous once two instances
    // share a database: leases are per-instance state, so instance B sees instance A's live runs as
    // orphans with no lease and closes them mid-flight. (Found by running a second instance locally —
    // it printed "closed 1 turn(s) left running by a previous bridge" while the first was working.)
    // Backfilled to this instance, which is correct for a single-machine history.
    sql: `
      ALTER TABLE turn ADD COLUMN IF NOT EXISTS instance TEXT;
      CREATE INDEX IF NOT EXISTS turn_instance ON turn (user_id, instance) WHERE finished_at IS NULL;
    `,
  },
  {
    id: 7,
    name: "queued-message",
    idempotent: true,
    // Instructions typed while a run is in flight. The composer has always invited this ("The agent
    // is working — queue the next instruction…") and then rejected it with a 409, so the message was
    // simply lost. Queued here and dispatched when the run finishes.
    //
    // In the database rather than in memory because the point is that it survives: a bridge restart
    // between typing and dispatch is exactly when losing the message would be most galling.
    sql: `
      CREATE TABLE IF NOT EXISTS queued_message (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        instruction TEXT NOT NULL,
        attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
        provider TEXT,
        created_at BIGINT NOT NULL,
        dispatched_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS queued_message_pending ON queued_message (user_id, repo, branch)
        WHERE dispatched_at IS NULL;
    `,
  },
  {
    id: 8,
    name: "turn-instruction",
    idempotent: true,
    // What the user actually typed, separate from the prompt the CLI was given. `prompt` is the
    // instruction wrapped in scenario scaffolding and the outcome contract; the chat used to strip
    // that back out by searching for known marker lines, which failed for any prompt shape the list
    // didn't know and showed the whole prompt. Nullable: rows from before this keep using the
    // marker fallback.
    sql: `ALTER TABLE turn ADD COLUMN IF NOT EXISTS instruction TEXT`,
  },
  {
    id: 9,
    name: "turn-stop-reason",
    idempotent: true,
    // Why the turn ended (shared/agent.ts StopReason). `status` says whether it finished; this says
    // how — end_turn / budget_reached / interrupted / error — so a list of conversations can be
    // filtered on it. Nullable: older rows infer it from status at read time.
    sql: `ALTER TABLE turn ADD COLUMN IF NOT EXISTS stop_reason TEXT`,
  },
  {
    id: 10,
    name: "turn-check",
    idempotent: true,
    // Orca's own post-run verification (shared/agent.ts TurnCheck): the repo's check command run in
    // the worktree after a run that committed, with the output tail as evidence. Nullable: most
    // turns commit nothing, and repos without a checkCommand never get one.
    sql: `ALTER TABLE turn ADD COLUMN IF NOT EXISTS "check" JSONB`,
  },
  {
    id: 11,
    name: "instance-metric",
    idempotent: true,
    // Machine metrics over time (server/health.ts's sampler): each instance writes ITS OWN vitals
    // once a minute, so the header chip can graph the other box's last day from either machine.
    // Pruned to 30 days by the writer; ~43k rows per instance at most.
    sql: `
      CREATE TABLE IF NOT EXISTS instance_metric (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        instance TEXT NOT NULL,
        at TIMESTAMPTZ NOT NULL,
        cpu_pct DOUBLE PRECISION NOT NULL,
        load1 DOUBLE PRECISION NOT NULL,
        mem_used_gb DOUBLE PRECISION NOT NULL,
        mem_total_gb DOUBLE PRECISION NOT NULL,
        disk_used_gb DOUBLE PRECISION
      );
      CREATE INDEX IF NOT EXISTS instance_metric_instance_at ON instance_metric (instance, at);
    `,
  },
  {
    id: 12,
    name: "preview-inventory",
    idempotent: true,
    // Running previews, published by the instance that runs them (the worktree_inventory pattern),
    // so the running-previews menu on any machine — a phone pointed at the box included — lists
    // every instance's previews. Keyed by the preview key (a worktree path), not a branch: a
    // base-branch ("test master") preview has none.
    sql: `
      CREATE TABLE IF NOT EXISTS preview_inventory (
        user_id TEXT NOT NULL,
        instance TEXT NOT NULL,
        key TEXT NOT NULL,
        data JSONB NOT NULL,
        seen_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, instance, key)
      );
    `,
  },
  {
    id: 13,
    name: "instance-metric-running-agents",
    idempotent: true,
    // How many agents were live on this instance at sample time, alongside its cpu/mem (the Usage
    // dashboard overlays it on the CPU/memory graphs). Nullable: rows written before this migration
    // have none; metricHistory reads them back as 0 rather than null.
    sql: `ALTER TABLE instance_metric ADD COLUMN IF NOT EXISTS running_agents INTEGER`,
  },
  {
    id: 14,
    name: "migration-name",
    idempotent: true,
    // The name half of a step's identity (above). The runner itself adds this column before it reads
    // the table — it needs the names to plan — so on a running database this step is a no-op that
    // records the column in the ledger like every other schema change.
    sql: `ALTER TABLE migration ADD COLUMN IF NOT EXISTS name TEXT`,
  },
  {
    // 15, not 13: two branches open alongside this one each add a step too (usage → 13, insights →
    // 14), and migrate() skips ids already applied without needing them contiguous, so a gap is
    // harmless whichever lands first. Never renumber an applied step.
    id: 15,
    name: "notification",
    idempotent: true,
    // Idempotent because this table ALREADY EXISTED on the shared database before this step ran on
    // main: an unmerged branch's bridge had created it under another id (the collision the names
    // above exist to catch). A plain CREATE TABLE crashed both bridges at boot on 2026-10-13.
    // The notification centre (shared/notifications.ts): one flat row per event — an agent that
    // finished, asked for input, failed or was stopped; a check that failed; a PR whose CI fails or
    // that conflicts; a preview that came up or didn't. Written ONCE by the instance where it
    // happened and read by every instance, so both machines show the same centre. `key` is the
    // event's identity: a run adopted after a restart, or a repo answered by two instances, must not
    // produce a second row, and a unique index makes that a no-op insert rather than a check.
    // Pruned to 30 days by the writer, like instance_metric.
    sql: `
      CREATE TABLE IF NOT EXISTS notification (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        instance TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        link JSONB,
        created_at BIGINT NOT NULL,
        read_at BIGINT,
        dismissed_at BIGINT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS notification_key ON notification (user_id, key);
      CREATE INDEX IF NOT EXISTS notification_recent ON notification (user_id, created_at DESC);
    `,
  },
  {
    // 18, not 16: #152 and the instance-charts branch were open with 16 and 17 when this was written.
    id: 18,
    name: "turn-source",
    idempotent: true,
    // Who an orchestrator turn answers (shared/agent.ts TurnSource): `human` (you spoke) or `agents`
    // (woken by worker reports alone), so the chat can split its Chat and Agents channels. The backfill
    // reads it off the stored instruction the way the wake built it — every message a
    // `[worker finished]` report → agents — falling back to the prompt's `## New` section for rows from
    // before `instruction` existed. Idempotent: it only fills NULLs. Nullable: a worker's turns stay
    // NULL, and the browser infers a NULL from the text the same way.
    sql: `
      ALTER TABLE turn ADD COLUMN IF NOT EXISTS source TEXT;
      UPDATE turn t SET source = CASE
          WHEN COALESCE(t.instruction, substring(t.prompt from '## New\\n(.*)$')) ~ '^\\[worker finished\\]'
           AND COALESCE(t.instruction, substring(t.prompt from '## New\\n(.*)$')) !~ '\\n\\n(?!\\[worker finished\\])'
          THEN 'agents' ELSE 'human' END
        FROM workstream w
        WHERE w.id = t.workstream_id AND w.repo = '@orca' AND w.branch = 'orchestrator' AND t.source IS NULL;
    `,
  },
];

export type MigrationMismatch = { id: number; recorded: string; expected: string; idempotent: boolean };

/** What the runner decided for one database. */
export type MigrationPlan = {
  /** Applied in id order, each in its own transaction: never recorded; recorded under another name
   *  but idempotent; or recorded with NO name and idempotent — a row from before names existed can't
   *  be verified, and re-running an idempotent step costs nothing. */
  run: MigrationStep[];
  /** Recorded with no name and NOT idempotent: trusted (it predates names) and named in place. */
  stamp: MigrationStep[];
  /** The id is recorded under a DIFFERENT name — another branch's step got there first. */
  mismatches: MigrationMismatch[];
  /** The mismatches re-running can't heal: the bridge refuses to start. */
  refused: MigrationMismatch[];
  /** Recorded ids with no step in this code (a foreign branch's, or a newer main's). */
  unknown: { id: number; name: string | null }[];
};

/** Pure: what to do, given the steps in code and the `migration` rows recorded. */
export function planMigrations(steps: MigrationStep[], recorded: { id: number; name: string | null }[]): MigrationPlan {
  const byId = new Map(recorded.map((r) => [Number(r.id), r.name ?? null]));
  const plan: MigrationPlan = { run: [], stamp: [], mismatches: [], refused: [], unknown: [] };
  for (const step of steps) {
    if (!byId.has(step.id)) { plan.run.push(step); continue; }
    const name = byId.get(step.id) ?? null;
    if (name === step.name) continue;
    if (name === null) { (step.idempotent ? plan.run : plan.stamp).push(step); continue; }
    const mismatch = { id: step.id, recorded: name, expected: step.name, idempotent: step.idempotent };
    plan.mismatches.push(mismatch);
    if (step.idempotent) plan.run.push(step); else plan.refused.push(mismatch);
  }
  const known = new Set(steps.map((s) => s.id));
  plan.unknown = recorded.filter((r) => !known.has(Number(r.id))).map((r) => ({ id: Number(r.id), name: r.name ?? null }));
  return plan;
}

/** One line per mismatch — the startup log, `/api/diagnostics` and `bun run db:check` all say it the
 *  same way. */
export function describeMismatch(m: MigrationMismatch): string {
  return `migration ${m.id} is recorded as "${m.recorded}" but this code's ${m.id} is "${m.expected}" — `
    + (m.idempotent ? "not treated as applied; re-running it (idempotent)" : "it is not idempotent, so it cannot be re-run safely");
}

/** Thrown when the database can't be brought to this code's schema without a human. */
export class MigrationRefused extends Error {}

function refusal(refused: MigrationMismatch[]): MigrationRefused {
  return new MigrationRefused([
    "orca: refusing to start — the database's migration ledger disagrees with this code:",
    ...refused.map((m) => `  ${describeMismatch(m)}`),
    "Another branch applied its own step under the same id. Apply this code's step by hand (its SQL is",
    "MIGRATIONS in server/db.ts), then record it: UPDATE migration SET name = '<expected>' WHERE id = <id>;",
    "then restart. `bun run db:check` prints the ledger. Never point a worktree's bridge or tests at the",
    "shared database — a migration id is reserved only by merging to main.",
  ].join("\n"));
}

/** Under `bun test`, the only database a test may migrate is its own `orca_test_*` schema
 *  (tests/pg.ts). A worktree has a copied `.env` whose ORCA_DATABASE_URL is the SHARED database, and
 *  Bun loads it into the test process — so a test that forgot to repoint the URL would migrate it. */
export function testDatabaseRefusal(url: string, nodeEnv = process.env.NODE_ENV): string | undefined {
  if (nodeEnv !== "test") return undefined;
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { /* keep it raw */ }
  if (/search_path=orca_test_/.test(decoded)) return undefined;
  return "orca: refusing to open a non-test database under `bun test` — point ORCA_DATABASE_URL at a "
    + "schema from tests/pg.ts's freshSchema(), never the shared one";
}

/** Whether this checkout is a linked git worktree (`.git` is a file there, a directory in the main
 *  checkout). A worktree's bridge applying ITS branch's migrations to the shared database is how a
 *  foreign step took main's id; `ORCA_ALLOW_WORKTREE_MIGRATIONS=1` is for a worktree whose database
 *  is genuinely its own. */
function inLinkedWorktree(): boolean {
  try { return statSync(join(import.meta.dir, "..", ".git")).isFile(); } catch { return false; }
}

let lastReport: (MigrationPlan & { at: number }) | undefined;
/** The last migration pass on this process's database, for `/api/diagnostics`. */
export const migrationReport = () => lastReport;

/** The recorded ledger, tolerating a database the runner has never touched or one from before names. */
export async function recordedMigrations(sql: Bun.SQL): Promise<{ id: number; name: string | null }[]> {
  const [exists] = await sql`SELECT to_regclass('migration') AS t`;
  if (!exists?.t) return [];
  return (await sql`SELECT * FROM migration ORDER BY id`).map((r: { id: number; name?: string | null }) => ({ id: Number(r.id), name: r.name ?? null }));
}

async function migrate(sql: Bun.SQL): Promise<void> {
  const notTest = testDatabaseRefusal(handleUrl ?? databaseUrl());
  if (notTest) throw new Error(notTest);
  await sql`CREATE TABLE IF NOT EXISTS migration (id INT PRIMARY KEY, applied_at BIGINT NOT NULL)`;
  // Before reading: planning needs the names (step 14 records the same column in the ledger).
  await sql`ALTER TABLE migration ADD COLUMN IF NOT EXISTS name TEXT`;
  const plan = planMigrations(MIGRATIONS, await recordedMigrations(sql));
  lastReport = { ...plan, at: Date.now() };
  for (const m of plan.mismatches) console.error(`orca: MIGRATION MISMATCH — ${describeMismatch(m)}`);
  for (const u of plan.unknown) console.error(`orca: migration ${u.id}${u.name ? ` ("${u.name}")` : ""} is recorded but this code has no such step — a branch ahead of this one, or another branch's`);
  if (plan.refused.length) throw refusal(plan.refused);
  if (plan.run.length && process.env.NODE_ENV !== "test" && inLinkedWorktree() && process.env.ORCA_ALLOW_WORKTREE_MIGRATIONS !== "1") {
    throw new MigrationRefused(`orca: refusing to apply migration(s) ${plan.run.map((s) => s.id).join(", ")} from a git worktree — `
      + "this database may be the shared one, and a migration id is reserved only by merging to main. "
      + "Point ORCA_DATABASE_URL at a database of your own and set ORCA_ALLOW_WORKTREE_MIGRATIONS=1.");
  }
  for (const step of plan.run) {
    // One transaction per step: a half-applied migration is the single failure mode that would need a
    // human, so make it impossible rather than recoverable. Upsert, so a re-run step takes its id back.
    await sql.begin(async (tx: Bun.SQL) => {
      await tx.unsafe(step.sql);
      await tx`INSERT INTO migration (id, applied_at, name) VALUES (${step.id}, ${Date.now()}, ${step.name})
        ON CONFLICT (id) DO UPDATE SET applied_at = EXCLUDED.applied_at, name = EXCLUDED.name`;
    });
  }
  for (const step of plan.stamp) await sql`UPDATE migration SET name = ${step.name} WHERE id = ${step.id} AND name IS NULL`;
}

// ---- workstreams ----

/** The id of the live workstream for (user, repo, branch), creating it if absent. Stable across
 *  branch renames and archival — this is the id future features (links, summaries) reference. */
export async function workstreamId(repo: string, branch: string): Promise<number> {
  return withRetry(async (sql) => {
    const user = currentUser();
    const found = await sql`
      SELECT id FROM workstream
      WHERE user_id = ${user} AND repo = ${repo} AND branch = ${branch} AND archived_at IS NULL`;
    if (found.length) return Number(found[0].id);
    // Let the database resolve the race rather than the gap between SELECT and INSERT. Creating a card
    // writes its enrichment and launches an agent at the same moment, so two callers arrive here
    // together, both find nothing, and both insert — one then violated `workstream_live` and, because a
    // history write must never break a run, was swallowed. The visible symptom was a conversation with
    // no turns: the agent worked, its steps were recorded, and the chat had nothing to hang them on.
    //
    // The conflict target must name the partial index's predicate, since only LIVE workstreams are
    // unique (an archived branch may be reused).
    const created = await sql`
      INSERT INTO workstream (user_id, repo, branch, created_at)
      VALUES (${user}, ${repo}, ${branch}, ${Date.now()})
      ON CONFLICT (user_id, repo, branch) WHERE archived_at IS NULL DO NOTHING
      RETURNING id`;
    if (created.length) return Number(created[0].id);
    // The other caller won; its row is the one to use.
    const existing = await sql`
      SELECT id FROM workstream
      WHERE user_id = ${user} AND repo = ${repo} AND branch = ${branch} AND archived_at IS NULL`;
    if (existing.length) return Number(existing[0].id);
    throw new Error(`workstream for ${repo}:${branch} could not be created or found`);
  });
}

/** The client's enrichment fields, stored as one opaque JSON blob per workstream. Deliberately NOT
 *  columns: the shape is the client's (`Enrichment` in web/src/store.ts) and grows regularly, and a
 *  column per field would mean a migration per field for no query we actually run. */
export type Fields = Record<string, unknown>;

/** Every live workstream in a repo, keyed by branch. Archived ones are excluded — they're history,
 *  not board state. */
export async function enrichment(repo: string): Promise<Record<string, Fields>> {
  return withRetry(async (sql) => {
    const rows = await sql`
      SELECT branch, data FROM workstream
      WHERE user_id = ${currentUser()} AND repo = ${repo} AND archived_at IS NULL AND branch IS NOT NULL`;
    const out: Record<string, Fields> = {};
    for (const r of rows as { branch: string; data: Fields }[]) out[r.branch] = r.data ?? {};
    return out;
  });
}

/** Merge `fields` into a workstream's blob, creating it if absent. `null` (or `undefined`) deletes
 *  that key — the client's patch semantics use `undefined` to clear a field (e.g. `followSig`), and
 *  JSON.stringify drops undefined keys entirely, so deletion travels over the wire as null. */
export async function patchEnrichment(repo: string, branch: string, fields: Fields): Promise<void> {
  return withRetry(async (sql) => {
    const id = await workstreamId(repo, branch);
    const rows = await sql`SELECT data FROM workstream WHERE id = ${id}`;
    const current: Fields = (rows[0]?.data as Fields) ?? {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) delete current[k]; else current[k] = v;
    }
    await sql`UPDATE workstream SET data = ${current} WHERE id = ${id}`;
  });
}

/** One-shot adoption of a browser's existing localStorage enrichment. Only fills workstreams that
 *  have no data yet, so re-running it can't overwrite anything the DB already owns. */
export async function importEnrichment(entries: { repo: string; branch: string; fields: Fields }[]): Promise<number> {
  return withRetry(async (sql) => {
    let imported = 0;
    for (const e of entries) {
      if (!e.repo || !e.branch) continue;
      const id = await workstreamId(e.repo, e.branch);
      const rows = await sql`SELECT data FROM workstream WHERE id = ${id}`;
      if (Object.keys((rows[0]?.data as Fields) ?? {}).length) continue; // already owned by the DB
      // Keep `transcript` IN the blob, exactly as persistAgentEnrichment keeps writing it going
      // forward. The store's resume guard and cross-provider handoff both read enrich.transcript, so
      // stripping it on migration would blind them for any card mid-flight at upgrade time.
      await sql`UPDATE workstream SET data = ${e.fields ?? {}} WHERE id = ${id}`;
      imported++;
    }
    return imported;
  });
}

// ---- turns ----

type TurnRow = {
  run_id: string; provider: string; status: string; instruction: string | null; prompt: string; response: string | null;
  structured: AgentOutcome | null; session_id: string | null; stop_reason: string | null; check: TurnCheck | null;
  source?: string | null;
  started_at: string | number; finished_at: string | number | null;
};

const toTurn = (r: TurnRow): AgentTurn => ({
  id: r.run_id,
  provider: r.provider as AgentProvider,
  instruction: r.instruction ?? undefined,
  prompt: r.prompt,
  response: r.response ?? "",
  structured: r.structured ?? undefined,
  sessionId: r.session_id ?? undefined,
  failed: r.status === "error" ? true : undefined,
  stopped: r.status === "stopped" ? true : undefined,
  // Rows before the column infer it from status; a running turn has none yet.
  check: r.check ?? undefined,
  source: (r.source as TurnSource | null | undefined) ?? undefined,
  stopReason: (r.stop_reason as StopReason | null)
    ?? (r.status === "done" ? "end_turn" : r.status === "error" ? "error" : r.status === "stopped" ? "interrupted" : undefined),
  startedAt: Number(r.started_at),
  finishedAt: r.finished_at === null || r.finished_at === undefined ? undefined : Number(r.finished_at),
});

/** Record a turn the moment its run launches, so a run whose bridge dies is visible as an
 *  interrupted turn instead of vanishing. Keyed by runId, so a fast follow-up can't overwrite the
 *  previous turn the way the in-memory map (keyed by worktree path) did. */
export async function startTurn(input: {
  repo: string; branch: string; runId: string; provider: AgentProvider;
  instruction?: string; prompt: string; sessionId?: string; startedAt: number; source?: TurnSource;
}): Promise<void> {
  return withRetry(async (sql) => {
    const id = await workstreamId(input.repo, input.branch);
    await sql`
      INSERT INTO turn (workstream_id, user_id, instance, run_id, provider, status, instruction, prompt, session_id, raw_ref, started_at, source)
      VALUES (${id}, ${currentUser()}, ${instanceName()}, ${input.runId}, ${input.provider}, 'running', ${input.instruction ?? null}, ${input.prompt},
              ${input.sessionId ?? null}, ${input.sessionId ?? null}, ${input.startedAt}, ${input.source ?? null})
      ON CONFLICT (run_id) DO NOTHING`;
    bus.publish({ kind: "turn", runId: input.runId, repo: input.repo, branch: input.branch });
  });
}

/** Complete the turn started by `startTurn`. The session id is re-supplied because Codex and Cursor
 *  only reveal theirs mid-run.
 *
 *  If the start write never landed — it is fire-and-forget-ish and swallows failures, so a database
 *  blip at launch loses it — this RESCUES the turn instead of updating nothing. That case is not
 *  hypothetical: a run once recorded 226 steps with no turn to hang them on, so the conversation was
 *  invisible even though everything about it was on disk. `identity` is what makes the insert
 *  possible; the exit handler has it, so the rescue costs nothing. */
export async function finishTurn(runId: string, input: {
  status: TurnStatus; response?: string; structured?: AgentOutcome; stopReason?: StopReason;
  sessionId?: string; finishedAt: number;
  identity?: { repo: string; branch: string; provider: AgentProvider; instruction?: string; prompt: string; startedAt: number; source?: TurnSource };
}): Promise<void> {
  return withRetry(async (sql) => {
    // Return the owning branch in the same round trip, so the bus event can be addressed to the chat
    // stream watching it without a second lookup on a hot path.
    const rows = await sql`
      WITH updated AS (
        UPDATE turn SET
          status = ${input.status},
          response = ${input.response ?? null},
          structured = ${input.structured ?? null},
          stop_reason = ${input.stopReason ?? null},
          session_id = COALESCE(${input.sessionId ?? null}, session_id),
          raw_ref = COALESCE(${input.sessionId ?? null}, raw_ref),
          finished_at = ${input.finishedAt}
        WHERE run_id = ${runId}
        RETURNING workstream_id
      )
      SELECT w.repo, w.branch FROM updated JOIN workstream w ON w.id = updated.workstream_id`;
    let owner = rows[0] as { repo: string; branch: string | null } | undefined;
    if (!owner && input.identity) {
      // Nothing to update: the start write was lost. Write the whole turn now — the run happened, and
      // its steps are already recorded against this run id.
      const { repo, branch, provider, instruction, prompt, startedAt, source } = input.identity;
      const workstream = await workstreamId(repo, branch);
      await sql`
        INSERT INTO turn (workstream_id, user_id, instance, run_id, provider, status, instruction, prompt, response,
                          structured, stop_reason, session_id, raw_ref, started_at, finished_at, source)
        VALUES (${workstream}, ${currentUser()}, ${instanceName()}, ${runId}, ${provider}, ${input.status},
                ${instruction ?? null}, ${prompt}, ${input.response ?? null}, ${input.structured ?? null}, ${input.stopReason ?? null},
                ${input.sessionId ?? null}, ${input.sessionId ?? null}, ${startedAt}, ${input.finishedAt}, ${source ?? null})
        ON CONFLICT (run_id) DO NOTHING`;
      owner = { repo, branch };
    }
    if (owner?.branch) bus.publish({ kind: "turn", runId, repo: owner.repo, branch: owner.branch });
  });
}

/** Replace a finished turn's outcome with Orca's own account of why it died (an orchestrator wake
 *  that was cut off). The cost cap keeps its own stop reason; everything else is an `error`. */
export async function failTurn(runId: string, response: string): Promise<void> {
  return withRetry(async (sql) => {
    const rows = await sql`
      WITH updated AS (
        UPDATE turn SET status = 'error', response = ${response}, structured = NULL,
          stop_reason = CASE WHEN stop_reason = 'budget_reached' THEN stop_reason ELSE 'error' END
        WHERE run_id = ${runId} RETURNING workstream_id
      )
      SELECT w.repo, w.branch FROM updated JOIN workstream w ON w.id = updated.workstream_id`;
    const owner = rows[0] as { repo: string; branch: string | null } | undefined;
    if (owner?.branch) bus.publish({ kind: "turn", runId, repo: owner.repo, branch: owner.branch });
  });
}

/** Attach Orca's verification to a finished turn, and wake the chat watching its branch. */
export async function setCheck(runId: string, check: TurnCheck): Promise<void> {
  return withRetry(async (sql) => {
    const rows = await sql`
      WITH updated AS (UPDATE turn SET "check" = ${check} WHERE run_id = ${runId} RETURNING workstream_id)
      SELECT w.repo, w.branch FROM updated JOIN workstream w ON w.id = updated.workstream_id`;
    const owner = rows[0] as { repo: string; branch: string | null } | undefined;
    if (owner?.branch) bus.publish({ kind: "turn", runId, repo: owner.repo, branch: owner.branch });
  });
}

/** Close out turns left `running` by a process that is no longer alive — a bridge killed mid-run
 *  writes the turn at launch and never reaches its exit handler, so the turn renders `▋ working…`
 *  forever. Call at startup with the run ids that still hold a live lease; everything else is an
 *  orphan. Returns how many were closed.
 *
 *  Scoped to THIS instance's turns, because leases are per-instance state: another machine's live
 *  runs hold no lease here, and closing them would kill a working board from a machine that has
 *  nothing to do with it. Rows predating the instance column belong to whoever is reconciling — a
 *  single-machine history, which is what they are. */
export async function reconcileRunning(
  liveRunIds: Set<string>,
  // Given an orphan, try to recover what it actually did from the provider's own session file. Passed
  // in rather than imported so this module keeps knowing nothing about providers.
  recover?: (turn: { runId: string; sessionId?: string }) => Promise<{ response?: string; structured?: AgentOutcome } | undefined>,
): Promise<{ closed: number; recovered: number }> {
  return withRetry(async (sql) => {
    const stuck = await sql`
      SELECT run_id, session_id FROM turn
      WHERE user_id = ${currentUser()} AND status = 'running'
        AND (instance IS NULL OR instance = ${instanceName()})`;
    const orphans = (stuck as { run_id: string; session_id: string | null }[])
      .filter((t) => !liveRunIds.has(t.run_id));
    let recovered = 0;
    for (const { run_id, session_id } of orphans) {
      // The run itself may well have finished its work — the bridge just wasn't there to hear it.
      const found = await recover?.({ runId: run_id, sessionId: session_id ?? undefined }).catch(() => undefined);
      if (found?.response) {
        recovered++;
        await finishTurn(run_id, { status: "done", response: found.response, structured: found.structured, finishedAt: Date.now() });
      } else {
        await finishTurn(run_id, { status: "error", response: "The bridge stopped before this run finished.", finishedAt: Date.now() });
      }
    }
    return { closed: orphans.length, recovered };
  });
}

/** The (repo, branch) a run's turn belongs to, or undefined if the runId is unknown. */
export async function turnOwner(runId: string): Promise<{ repo: string; branch: string } | undefined> {
  return withRetry(async (sql) => {
    const rows = await sql`
      SELECT w.repo, w.branch FROM turn t JOIN workstream w ON w.id = t.workstream_id
      WHERE t.run_id = ${runId} AND t.user_id = ${currentUser()}`;
    const row = rows[0] as { repo: string; branch: string | null } | undefined;
    return row?.branch ? { repo: row.repo, branch: row.branch } : undefined;
  });
}

/** Every turn for a branch's live workstream, oldest→newest. */
export async function turns(repo: string, branch: string): Promise<AgentTurn[]> {
  return withRetry(async (sql) => {
    const rows = await sql`
      SELECT t.* FROM turn t JOIN workstream w ON w.id = t.workstream_id
      WHERE w.user_id = ${currentUser()} AND w.repo = ${repo} AND w.branch = ${branch}
        AND w.archived_at IS NULL
      ORDER BY t.started_at, t.id`;
    return (rows as TurnRow[]).map(toTurn);
  });
}

/** A cursor into a conversation: the position of the oldest turn a page holds, as
 *  `<started_at>~<run_id>` — the same key the conversation is ordered by, so a page boundary is
 *  exact even when two turns share a millisecond. Opaque to the client. */
export type TurnCursor = string;
export type TurnPage = { turns: AgentTurn[]; older: TurnCursor | null };

/** The newest `limit` turns of a conversation (oldest first, as `turns()` orders them), or the
 *  `limit` turns before `before` — the cursor a previous page returned. `older` is the cursor for
 *  the next page back, null once the conversation's first turn is in hand. The orchestrator's
 *  conversation runs to hundreds of turns, and the chat shows its tail first. */
export async function turnPage(repo: string, branch: string, opts: { limit?: number; before?: TurnCursor } = {}): Promise<TurnPage> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
  const cursor = parseCursor(opts.before);
  return withRetry(async (sql) => {
  const rows = cursor
    ? await sql`
      SELECT t.* FROM turn t JOIN workstream w ON w.id = t.workstream_id
      WHERE w.user_id = ${currentUser()} AND w.repo = ${repo} AND w.branch = ${branch}
        AND w.archived_at IS NULL
        AND (t.started_at < ${cursor.startedAt} OR (t.started_at = ${cursor.startedAt} AND t.id < ${cursor.id}))
      ORDER BY t.started_at DESC, t.id DESC LIMIT ${limit + 1}`
    : await sql`
      SELECT t.* FROM turn t JOIN workstream w ON w.id = t.workstream_id
      WHERE w.user_id = ${currentUser()} AND w.repo = ${repo} AND w.branch = ${branch}
        AND w.archived_at IS NULL
      ORDER BY t.started_at DESC, t.id DESC LIMIT ${limit + 1}`;
  const got = rows as (TurnRow & { id: string | number })[];
  const hasMore = got.length > limit;
  const page = got.slice(0, limit).reverse();
  const oldest = page[0];
  return {
    turns: page.map(toTurn),
    older: hasMore && oldest ? `${Number(oldest.started_at)}~${String(oldest.id)}` : null,
  };
  });
}

/** A cursor is `<started_at>~<turn.id>` (the row's surrogate id, not the run id — it is what the
 *  ORDER BY breaks ties on). Anything malformed reads as "no cursor": the newest page. */
function parseCursor(c?: string): { startedAt: number; id: number } | null {
  if (!c) return null;
  const at = c.indexOf("~");
  if (at < 0) return null;
  const startedAt = Number(c.slice(0, at)), id = Number(c.slice(at + 1));
  return Number.isFinite(startedAt) && Number.isFinite(id) ? { startedAt, id } : null;
}

/** Mark a workstream finished without deleting anything — merged/discarded branches keep their
 *  history so future features can summarise and chain from them. */
export async function archive(repo: string, branch: string): Promise<void> {
  return withRetry(async (sql) => {
    await sql`
      UPDATE workstream SET archived_at = ${Date.now()}
      WHERE user_id = ${currentUser()} AND repo = ${repo} AND branch = ${branch} AND archived_at IS NULL`;
  });
}

// ---- conversations, read across workstreams (the orchestrator's memory of past work) ----

export type Conversation = { id: number; repo: string; branch: string; title?: string; archived: boolean; turns: number; lastAt?: number };

/** Every conversation, newest activity first — ARCHIVED ones included, because the conversations
 *  most worth chaining from are exactly the ones whose branches got merged and reaped. */
export async function conversations(limit = 40): Promise<Conversation[]> {
  return withRetry(async (sql) => {
    const rows = await sql`
      SELECT w.id, w.repo, w.branch, w.data->>'title' AS title, w.archived_at, COUNT(t.id) AS turns, MAX(t.started_at) AS last_at
      FROM workstream w JOIN turn t ON t.workstream_id = w.id
      WHERE w.user_id = ${currentUser()} AND w.branch IS NOT NULL
      GROUP BY w.id ORDER BY MAX(t.started_at) DESC LIMIT ${limit}`;
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id), repo: String(r.repo), branch: String(r.branch), title: (r.title as string) ?? undefined,
      archived: r.archived_at !== null, turns: Number(r.turns), lastAt: r.last_at === null ? undefined : Number(r.last_at),
    }));
  });
}

/** Full-text search over what was asked and what was answered, across every conversation.
 *  ponytail: Postgres full-text with no index — a sequential scan over prompt+response is fine at
 *  one user's history; add a GIN index on the tsvector (or embeddings) when this is measurably slow. */
export async function searchTurns(query: string, limit = 15): Promise<(Conversation & { runId: string; turn: AgentTurn })[]> {
  return withRetry(async (sql) => {
    const rows = await sql`
      SELECT t.*, w.id AS ws_id, w.repo, w.branch, w.data->>'title' AS title, w.archived_at
      FROM turn t JOIN workstream w ON w.id = t.workstream_id
      WHERE t.user_id = ${currentUser()} AND w.branch IS NOT NULL
        AND to_tsvector('english', coalesce(t.instruction, '') || ' ' || coalesce(t.response, ''))
            @@ websearch_to_tsquery('english', ${query})
      ORDER BY t.started_at DESC LIMIT ${limit}`;
    return (rows as (TurnRow & Record<string, unknown>)[]).map((r) => ({
      id: Number(r.ws_id), repo: String(r.repo), branch: String(r.branch), title: (r.title as string) ?? undefined,
      archived: r.archived_at !== null, turns: 0, runId: r.run_id, turn: toTurn(r),
    }));
  });
}

/** A conversation's turns by its workstream id — works for an archived one, which `turns` (keyed by
 *  the live branch pointer) cannot reach. */
export async function conversationTurns(id: number): Promise<AgentTurn[]> {
  return withRetry(async (sql) => {
    const rows = await sql`
      SELECT * FROM turn WHERE workstream_id = ${id} AND user_id = ${currentUser()} ORDER BY started_at, id`;
    return (rows as TurnRow[]).map(toTurn);
  });
}

/** One turn by run id, wherever it lives. */
export async function turn(runId: string): Promise<AgentTurn | undefined> {
  return withRetry(async (sql) => {
    const rows = await sql`SELECT * FROM turn WHERE run_id = ${runId} AND user_id = ${currentUser()}`;
    return rows.length ? toTurn(rows[0] as TurnRow) : undefined;
  });
}

// ---- config ----

/** Every repo this user manages, in display order. Empty means "not configured yet" — the caller
 *  seeds from the checked-in file on first boot (see config.ts). */
export async function repoConfigs(): Promise<{ name: string; config: Fields }[]> {
  return withRetry(async (sql) => {
    const rows = await sql`
      SELECT name, config FROM repo_config WHERE user_id = ${currentUser()}
      ORDER BY position, name`;
    return (rows as { name: string; config: Fields }[]).map((r) => ({ name: r.name, config: r.config ?? {} }));
  });
}

/** The non-repo settings (port range, stale hours, run timeout). */
export async function appConfig(): Promise<Fields> {
  return withRetry(async (sql) => {
    const rows = await sql`SELECT config FROM app_config WHERE user_id = ${currentUser()}`;
    return (rows[0]?.config as Fields) ?? {};
  });
}

/** Replace this user's whole configuration — the document is the unit, the way a wrangler.toml is.
 *  Repos absent from the document are REMOVED, so the row set always matches what you pasted. Runs in
 *  one transaction: a half-applied config would leave the board pointing at repos that don't exist. */
export async function saveConfig(input: { repos: { name: string; config: Fields }[]; app: Fields }): Promise<void> {
  return withRetry(async (sql) => {
    const user = currentUser();
    const now = Date.now();
    // The document replaces the row set wholesale — repos absent from it are gone — so this is a
    // delete-then-insert rather than a diff. `created_at` is carried over for repos that survive, so a
    // paste doesn't rewrite the history of projects it didn't change.
    await sql.begin(async (tx: Bun.SQL) => {
      const existing = await tx`SELECT name, created_at FROM repo_config WHERE user_id = ${user}`;
      const createdAt = new Map((existing as { name: string; created_at: string }[])
        .map((r) => [r.name, Number(r.created_at)]));
      await tx`DELETE FROM repo_config WHERE user_id = ${user}`;
      for (const [position, r] of input.repos.entries()) {
        await tx`
          INSERT INTO repo_config (user_id, name, config, position, created_at, updated_at)
          VALUES (${user}, ${r.name}, ${r.config}, ${position}, ${createdAt.get(r.name) ?? now}, ${now})`;
      }
      await tx`
        INSERT INTO app_config (user_id, config, updated_at) VALUES (${user}, ${input.app}, ${now})
        ON CONFLICT (user_id) DO UPDATE SET config = EXCLUDED.config, updated_at = ${now}`;
    });
  });
}


// ---- instances + inventory ----

/** This process's identity. Two Orca instances share one database, so every row they publish says
 *  which machine it came from. Defaults to the machine's hostname (os.hostname(), not the HOSTNAME
 *  shell variable — that one isn't exported under systemd, so every server would have been "local"). */
export function instanceName(): string {
  return process.env.ORCA_INSTANCE || hostname();
}

/** Publish what THIS instance can see of a repo, and mark it alive.
 *
 *  Upsert-then-sweep rather than delete-then-insert. The board polls per repo, and two polls can
 *  overlap (a second browser tab, a manual refresh landing on the interval): both would DELETE, both
 *  would INSERT, and the second lost the race to the unique key — "duplicate key value violates
 *  worktree_inventory_key". It was harmless (publishing is advisory and the error was caught) but it
 *  meant one of the two polls published nothing.
 *
 *  Stamping every row with the same `now` and then deleting anything older sweeps branches that have
 *  gone away without needing to name them — which also avoids binding an array, since a concurrent
 *  publish would otherwise have to agree on the list. */
export async function publishInventory(repo: string, worktrees: { branch: string; data: Fields }[]): Promise<void> {
  return withRetry(async (sql) => {
    const user = currentUser();
    const instance = instanceName();
    const now = Date.now();
    await sql.begin(async (tx: Bun.SQL) => {
      for (const w of worktrees) {
        await tx`
          INSERT INTO worktree_inventory (user_id, instance, repo, branch, data, seen_at)
          VALUES (${user}, ${instance}, ${repo}, ${w.branch}, ${w.data}, ${now})
          ON CONFLICT (user_id, instance, repo, branch)
          DO UPDATE SET data = EXCLUDED.data, seen_at = EXCLUDED.seen_at`;
      }
      // Anything this publish didn't touch is a branch this instance no longer has. `<` not `<=`, so a
      // concurrent publish stamping the same millisecond can't sweep the other's rows.
      await tx`
        DELETE FROM worktree_inventory
        WHERE user_id = ${user} AND instance = ${instance} AND repo = ${repo} AND seen_at < ${now}`;
      await tx`
        INSERT INTO instance (user_id, name, seen_at) VALUES (${user}, ${instance}, ${now})
        ON CONFLICT (user_id, name) DO UPDATE SET seen_at = ${now}`;
    });
  });
}

/** Everything every instance can see of a repo, newest sighting first per branch. Each row carries
 *  the instance that reported it and how long ago, so the board can mark stale machines. */
export async function inventory(repo: string): Promise<{ instance: string; branch: string; data: Fields; seenAt: number }[]> {
  return withRetry(async (sql) => {
    const rows = await sql`
      SELECT instance, branch, data, seen_at FROM worktree_inventory
      WHERE user_id = ${currentUser()} AND repo = ${repo}
      ORDER BY seen_at DESC`;
    return (rows as { instance: string; branch: string; data: Fields; seen_at: string }[])
      .map((r) => ({ instance: r.instance, branch: r.branch, data: r.data ?? {}, seenAt: Number(r.seen_at) }));
  });
}

/** Publish THIS instance's running previews (upsert-then-sweep, as `publishInventory`): a preview
 *  this publish didn't name has stopped. */
export async function publishPreviews(previews: { key: string; data: Fields }[]): Promise<void> {
  return withRetry(async (sql) => {
    const user = currentUser();
    const instance = instanceName();
    const now = Date.now();
    await sql.begin(async (tx: Bun.SQL) => {
      for (const p of previews) {
        await tx`
          INSERT INTO preview_inventory (user_id, instance, key, data, seen_at)
          VALUES (${user}, ${instance}, ${p.key}, ${p.data}, ${now})
          ON CONFLICT (user_id, instance, key) DO UPDATE SET data = EXCLUDED.data, seen_at = EXCLUDED.seen_at`;
      }
      await tx`DELETE FROM preview_inventory WHERE user_id = ${user} AND instance = ${instance} AND seen_at < ${now}`;
    });
  });
}

/** Every instance's published previews, each with who runs it and when it was last reported. */
export async function previewInventory(): Promise<{ instance: string; key: string; data: Fields; seenAt: number }[]> {
  return withRetry(async (sql) => {
    const rows = await sql`
      SELECT instance, key, data, seen_at FROM preview_inventory WHERE user_id = ${currentUser()} ORDER BY instance, key`;
    return (rows as { instance: string; key: string; data: Fields; seen_at: string }[])
      .map((r) => ({ instance: r.instance, key: r.key, data: r.data ?? {}, seenAt: Number(r.seen_at) }));
  });
}

/** Forget a stopped preview's placement (`previewInstance` in its workstream's enrichment), found by
 *  key — the stop route knows the key, not the repo or branch. */
export async function clearPreviewPlacement(key: string): Promise<void> {
  return withRetry(async (sql) => {
    await sql`
      UPDATE workstream SET data = data - 'previewInstance'
      WHERE user_id = ${currentUser()} AND data -> 'previewInstance' ->> 'key' = ${key}`;
  });
}

/** Every instance that has ever checked in, with its last sighting. */
export async function instances(): Promise<{ name: string; seenAt: number }[]> {
  return withRetry(async (sql) => {
    const rows = await sql`SELECT name, seen_at FROM instance WHERE user_id = ${currentUser()} ORDER BY name`;
    return (rows as { name: string; seen_at: string }[]).map((r) => ({ name: r.name, seenAt: Number(r.seen_at) }));
  });
}

// ---- instance metrics (the health chip's history) ----

export type MetricPoint = { at: number; cpuPct: number; load1: number; memUsedGb: number; memTotalGb: number; diskUsedGb?: number; runningAgents: number };

/** How long a metric row is kept. */
export const METRIC_RETENTION_MS = 30 * 24 * 3_600_000;

/** Record one sample of THIS instance's vitals, and drop its rows past retention in the same breath —
 *  a delete per insert is cheap on the (instance, at) index, and it needs no second timer. Each
 *  instance prunes only its own rows: the other may be on an older build, but never on someone
 *  else's timer. `at` is injectable for tests. */
export async function recordMetric(p: Omit<MetricPoint, "at">, at = Date.now()): Promise<void> {
  return withRetry(async (sql) => {
    const instance = instanceName();
    // `instance_metric` has no unique constraint on (instance, at) — a retry that re-ran just the
    // INSERT after the DELETE dropped mid-connection would leave a duplicate sample in the graph.
    // One transaction makes the pair atomic, so `withRetry`'s whole-callback retry redoes both or
    // neither.
    await sql.begin(async (tx: Bun.SQL) => {
      await tx`
        INSERT INTO instance_metric (user_id, instance, at, cpu_pct, load1, mem_used_gb, mem_total_gb, disk_used_gb, running_agents)
        VALUES (${currentUser()}, ${instance}, ${new Date(at)}, ${p.cpuPct}, ${p.load1}, ${p.memUsedGb}, ${p.memTotalGb}, ${p.diskUsedGb ?? null}, ${p.runningAgents})`;
      await tx`DELETE FROM instance_metric WHERE instance = ${instance} AND at < ${new Date(at - METRIC_RETENTION_MS)}`;
    });
  });
}

/** An instance's samples over the last `hours`, oldest first. */
export async function metricHistory(instance: string, hours: number, now = Date.now()): Promise<MetricPoint[]> {
  return withRetry(async (sql) => {
    const rows = await sql`
      SELECT at, cpu_pct, load1, mem_used_gb, mem_total_gb, disk_used_gb, running_agents FROM instance_metric
      WHERE user_id = ${currentUser()} AND instance = ${instance} AND at >= ${new Date(now - hours * 3_600_000)}
      ORDER BY at`;
    return (rows as { at: Date; cpu_pct: number; load1: number; mem_used_gb: number; mem_total_gb: number; disk_used_gb: number | null; running_agents: number | null }[]).map((r) => ({
      at: new Date(r.at).getTime(), cpuPct: Number(r.cpu_pct), load1: Number(r.load1), memUsedGb: Number(r.mem_used_gb), memTotalGb: Number(r.mem_total_gb),
      runningAgents: r.running_agents == null ? 0 : Number(r.running_agents),
      ...(r.disk_used_gb == null ? {} : { diskUsedGb: Number(r.disk_used_gb) }),
    }));
  });
}

// ---- steps (the agent's thought process) ----

/** Append steps to a run, numbered from `startSeq`. The unique (run_id, seq) index makes this
 *  idempotent: a retried write collides rather than duplicating. Returns how many landed. */
export async function appendSteps(runId: string, startSeq: number, steps: Fields[]): Promise<number> {
  if (!steps.length) return 0;
  return withRetry(async (sql) => {
    const user = currentUser();
    const now = Date.now();
    let written = 0;
    for (const [i, step] of steps.entries()) {
      const rows = await sql`
        INSERT INTO turn_step (user_id, run_id, seq, step, at)
        VALUES (${user}, ${runId}, ${startSeq + i}, ${step}, ${now})
        ON CONFLICT (run_id, seq) DO NOTHING
        RETURNING id`;
      if (rows.length) written++;
    }
    return written;
  });
}

/** The next sequence number for a run — read once per run, then tracked in memory by the caller. */
export async function nextStepSeq(runId: string): Promise<number> {
  return withRetry(async (sql) => {
    const rows = await sql`SELECT COALESCE(MAX(seq), 0) AS max FROM turn_step WHERE run_id = ${runId}`;
    return Number(rows[0]?.max ?? 0) + 1;
  });
}

/** A run's steps, oldest first. `tail` returns only the last N; `afterSeq` only what's newer, which
 *  is how a chat stream watching a run on ANOTHER instance catches up without refetching. */
export async function steps(runId: string, opts: { tail?: number; afterSeq?: number } = {}): Promise<{ seq: number; step: Fields }[]> {
  return withRetry(async (sql) => {
    const rows = opts.afterSeq !== undefined
      ? await sql`SELECT seq, step FROM turn_step WHERE run_id = ${runId} AND seq > ${opts.afterSeq} ORDER BY seq`
      : opts.tail !== undefined
        ? await sql`SELECT seq, step FROM (
              SELECT seq, step FROM turn_step WHERE run_id = ${runId} ORDER BY seq DESC LIMIT ${opts.tail}
            ) t ORDER BY seq`
        : await sql`SELECT seq, step FROM turn_step WHERE run_id = ${runId} ORDER BY seq`;
    return (rows as { seq: number; step: Fields }[]).map((r) => ({ seq: Number(r.seq), step: r.step }));
  });
}

/** Every recorded step of several runs in ONE round trip, grouped by run. The conversation view
 *  used one query per turn; with the database on the other machine (6ms away) a 300-turn
 *  conversation took seconds to open. */
export async function stepsForRuns(runIds: string[]): Promise<Map<string, { seq: number; step: Fields }[]>> {
  const out = new Map<string, { seq: number; step: Fields }[]>();
  if (!runIds.length) return out;
  return withRetry(async (sql) => {
    const rows = await sql`SELECT run_id, seq, step FROM turn_step WHERE run_id IN ${sql(runIds)} ORDER BY run_id, seq`;
    for (const r of rows as { run_id: string; seq: number; step: Fields }[]) {
      let list = out.get(r.run_id);
      if (!list) out.set(r.run_id, (list = []));
      list.push({ seq: Number(r.seq), step: r.step });
    }
    return out;
  });
}

// ---- queued messages ----

export type QueuedMessage = {
  id: number; repo: string; branch: string; worktreePath: string;
  instruction: string; attachments: string[]; provider?: string; createdAt: number;
};

/** Queue an instruction typed while a run was in flight. */
export async function queueMessage(input: Omit<QueuedMessage, "id" | "createdAt">): Promise<QueuedMessage> {
  return withRetry(async (sql) => {
    const rows = await sql`
      INSERT INTO queued_message (user_id, repo, branch, worktree_path, instruction, attachments, provider, created_at)
      VALUES (${currentUser()}, ${input.repo}, ${input.branch}, ${input.worktreePath}, ${input.instruction},
              ${input.attachments}, ${input.provider ?? null}, ${Date.now()})
      RETURNING id, created_at`;
    return { ...input, id: Number(rows[0].id), createdAt: Number(rows[0].created_at) };
  });
}

/** Undispatched messages for a branch, oldest first — shown in the chat so a queued instruction is
 *  visible rather than silently pending. */
export async function queuedMessages(repo: string, branch: string): Promise<QueuedMessage[]> {
  return withRetry(async (sql) => {
    const rows = await sql`
      SELECT id, repo, branch, worktree_path, instruction, attachments, provider, created_at
      FROM queued_message
      WHERE user_id = ${currentUser()} AND repo = ${repo} AND branch = ${branch} AND dispatched_at IS NULL
      ORDER BY id`;
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id), repo: String(r.repo), branch: String(r.branch), worktreePath: String(r.worktree_path),
      instruction: String(r.instruction), attachments: (r.attachments as string[]) ?? [],
      provider: (r.provider as string) ?? undefined, createdAt: Number(r.created_at),
    }));
  });
}

/** Undispatched messages per branch for a whole repo, in ONE query — the agents poll attaches the
 *  count to every row, so the board can flag a message held behind a run that isn't coming. */
export async function queuedCounts(repo: string): Promise<Map<string, number>> {
  return withRetry(async (sql) => {
    const rows = await sql`
      SELECT branch, count(*)::int AS n FROM queued_message
      WHERE user_id = ${currentUser()} AND repo = ${repo} AND dispatched_at IS NULL
      GROUP BY branch`;
    return new Map((rows as { branch: string; n: number }[]).map((r) => [r.branch, Number(r.n)]));
  });
}

/** Claim the next queued message for a branch, marking it dispatched in the same statement so two
 *  instances (or a restart racing itself) cannot send it twice. */
export async function claimQueuedMessage(repo: string, branch: string): Promise<QueuedMessage | undefined> {
  return withRetry(async (sql) => {
    const rows = await sql`
      UPDATE queued_message SET dispatched_at = ${Date.now()}
      WHERE id = (
        SELECT id FROM queued_message
        WHERE user_id = ${currentUser()} AND repo = ${repo} AND branch = ${branch} AND dispatched_at IS NULL
        ORDER BY id LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, repo, branch, worktree_path, instruction, attachments, provider, created_at`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r && {
      id: Number(r.id), repo: String(r.repo), branch: String(r.branch), worktreePath: String(r.worktree_path),
      instruction: String(r.instruction), attachments: (r.attachments as string[]) ?? [],
      provider: (r.provider as string) ?? undefined, createdAt: Number(r.created_at),
    };
  });
}

/** Drop a queued message before it is sent (the user changed their mind). */
export async function cancelQueuedMessage(id: number): Promise<void> {
  return withRetry(async (sql) => {
    await sql`DELETE FROM queued_message WHERE id = ${id} AND user_id = ${currentUser()} AND dispatched_at IS NULL`;
  });
}

/** Drop every undispatched message for a branch — so archiving a cancelled workstream can't be
 *  resurrected by a message that was queued behind its running agent. */
export async function dropQueuedMessages(repo: string, branch: string): Promise<void> {
  return withRetry(async (sql) => {
    await sql`
      DELETE FROM queued_message
      WHERE user_id = ${currentUser()} AND repo = ${repo} AND branch = ${branch} AND dispatched_at IS NULL`;
  });
}

// ---- notifications (the notification centre) ----

/** How long a notification row is kept. */
export const NOTIFICATION_RETENTION_MS = 30 * 24 * 3_600_000;

type NotificationRow = {
  id: string; instance: string; repo: string; branch: string | null; kind: Notification["kind"]; title: string; body: string;
  link: Notification["link"] | null; created_at: string; read_at: string | null;
};
const toNotification = (r: NotificationRow): Notification => ({
  id: Number(r.id), instance: r.instance, repo: r.repo, ...(r.branch ? { branch: r.branch } : {}), kind: r.kind, title: r.title, body: r.body,
  ...(r.link ? { link: r.link } : {}), createdAt: Number(r.created_at),
  ...(r.read_at ? { readAt: Number(r.read_at) } : {}),
});

/** Record one event, once: a second insert with the same `key` is a no-op and returns undefined, so
 *  the caller knows not to push it. The same statement prunes this user's rows past retention —
 *  cheap on the (user, created_at) index, and it needs no second timer. `at` is injectable for tests. */
export async function addNotification(input: NotificationInput, at = Date.now()): Promise<Notification | undefined> {
  const sql = await open();
  const user = currentUser();
  const rows = await sql`
    INSERT INTO notification (user_id, key, instance, repo, branch, kind, title, body, link, created_at)
    VALUES (${user}, ${input.key}, ${instanceName()}, ${input.repo}, ${input.branch ?? null}, ${input.kind}, ${input.title}, ${input.body}, ${input.link ?? null}, ${at})
    ON CONFLICT (user_id, key) DO NOTHING
    RETURNING id, instance, repo, branch, kind, title, body, link, created_at, read_at`;
  await sql`DELETE FROM notification WHERE user_id = ${user} AND created_at < ${at - NOTIFICATION_RETENTION_MS}`;
  const row = (rows as NotificationRow[])[0];
  return row ? toNotification(row) : undefined;
}

/** The centre's rows, read and unread, newest first. Nothing is deleted by you (`dismissed_at` is
 *  from when the centre had Clear: such a row is also read, so it shows under All like any other). `since` (ms) is the catch-up cursor after a dropped
 *  stream — rows created after it, read or not. */
export async function notifications(opts: { since?: number; limit?: number } = {}): Promise<Notification[]> {
  const sql = await open();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const rows = await sql`
    SELECT id, instance, repo, branch, kind, title, body, link, created_at, read_at FROM notification
    WHERE user_id = ${currentUser()} AND created_at > ${opts.since ?? 0}
    ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  return (rows as NotificationRow[]).map(toNotification);
}

/** Mark read: the given ids, or every unread one. Returns how many changed. */
export async function markNotificationsRead(ids: number[] | "all", at = Date.now()): Promise<number> {
  const sql = await open();
  const user = currentUser();
  const rows = ids === "all"
    ? await sql`UPDATE notification SET read_at = ${at} WHERE user_id = ${user} AND read_at IS NULL RETURNING id`
    : ids.length ? await sql`UPDATE notification SET read_at = ${at} WHERE user_id = ${user} AND read_at IS NULL AND id IN ${sql(ids)} RETURNING id` : [];
  return rows.length;
}
