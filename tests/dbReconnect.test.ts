// The laptop-sleep case (server/db.ts `withRetry`): the remote Postgres drops every pooled
// connection while the lid is closed, and the pool otherwise only finds out on the next query —
// which failed outright and stayed noisy until the pool happened to recover on its own. These
// cases drive a REAL dropped connection (via `pg_terminate_backend` from a second client, not a
// mock) through `withRetry` and pin: one reconnect is silent to the caller, logged once, and a
// SECOND failure on the retry is not retried again.
//
// Killing a connection while it's IDLE races Bun's own pool, which notices a graceful
// server-side termination on its own and quietly swaps in a fresh connection before the next
// query is even sent — nothing for `withRetry` to do, and nothing for the test to observe. So
// every case here runs a `pg_sleep`-delayed query and kills the backend while it is `active`,
// which is deterministic: the write Bun already has in flight fails outright — PROVIDED the first
// connection against the fresh schema is already past `migrate()` (server/db.ts): that's a chain of
// one transaction per step, each its own round trip, and on a brand-new schema it is itself
// "active" for a stretch before the test's own query ever dispatches. A single-shot kill loop
// (`killNextActive`, test 1) takes the FIRST active backend it sees, which raced the migration far
// more often than the intended query — the retry's own fresh `migrate()` then ran clean, so the
// test still passed (one drop logged, the query answered two), just not for the reason its name
// says, and the loop occasionally caught neither phase and logged none. `warmUp()` runs `db.open()`
// once, unraced, before any killer starts, so the only "active" window left for one to catch is the
// query it's named for. Half a second of `pg_sleep`, not the 100ms this started as, leaves comfortable
// margin for the killer's own `pg_stat_activity` round trip against that one window.
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as db from "../server/db";
import { freshSchema, type TestDb } from "./pg";

let pg: TestDb;
let prevDbUrl: string | undefined;

beforeEach(async () => {
  prevDbUrl = process.env.ORCA_DATABASE_URL;
  pg = await freshSchema("dbreconnect");
});
afterEach(async () => {
  await db.close();
  await pg.drop();
  if (prevDbUrl === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prevDbUrl;
});

/** Point ORCA_DATABASE_URL at the schema, tagged with a unique `application_name` so a kill loop
 *  can target exactly this test's connections and nothing another test file is using at the same
 *  time against the same throwaway Postgres. */
function useTaggedSchema(appName: string): void {
  process.env.ORCA_DATABASE_URL = `${pg.url}&application_name=${encodeURIComponent(appName)}`;
}

/** Open the pool and run its migrations now, on the tagged schema, before any killer starts polling
 *  — otherwise a kill loop's first "active" sighting is as likely to be a migration step as the
 *  test's own query (see the file header). The connection this opens stays pooled and warm, so the
 *  test's own query runs on it (or a sibling from the same pool) with nothing left to migrate. */
async function warmUp(): Promise<void> {
  await db.open();
}

/** Kill the next backend tagged `appName` to go `active` (i.e. actually running a query) and stop.
 *  Used once per attempt we want to fail — the caller controls how many attempts that covers by
 *  how long it keeps calling/awaiting this against a query it kept busy with `pg_sleep`. */
async function killNextActive(admin: Bun.SQL, appName: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const rows = await admin`
      select pg_terminate_backend(pid) from pg_stat_activity
      where application_name = ${appName} and pid <> pg_backend_pid() and state = 'active'`;
    if (rows.length) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`no active backend tagged ${appName} appeared in time`);
}

/** Kill every backend tagged `appName` as it goes active, for as long as `keepKilling` is true —
 *  for proving a SECOND attempt also fails, where one kill isn't enough. */
function killWhileActive(admin: Bun.SQL, appName: string, keepKilling: () => boolean): Promise<void> {
  return (async () => {
    while (keepKilling()) {
      await admin`
        select pg_terminate_backend(pid) from pg_stat_activity
        where application_name = ${appName} and pid <> pg_backend_pid() and state = 'active'`
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
}

/** Swap `console.error` for the duration of `fn`, returning what it logged. */
async function captureErrors<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.error = original;
  }
}

test("a dropped connection is reopened and the query retried once, logged a single line", async () => {
  const appName = `orca-test-dbreconnect-single-${process.pid}`;
  useTaggedSchema(appName);
  await db.close();
  await warmUp();

  const admin = new Bun.SQL(pg.url);
  // Kill the FIRST attempt's connection the moment it's actually running — then stop, so the
  // retry's own connection goes through untouched.
  const killOnce = killNextActive(admin, appName);

  const { result, lines } = await captureErrors(() =>
    db.withRetry(async (s) => s`select pg_sleep(0.5), 1 + 1 as two`));
  await killOnce;
  await admin.end();

  expect(result[0]?.two).toBe(2); // the retried query actually ran, on a working connection
  expect(lines.filter((l) => l.includes("[db] connection dropped"))).toHaveLength(1);
});

test("a second drop on the retry is not retried again — it surfaces to the caller", async () => {
  const appName = `orca-test-dbreconnect-double-${process.pid}`;
  useTaggedSchema(appName);
  await db.close();
  await warmUp();

  const killer = new Bun.SQL(pg.url);
  let killing = true;
  const killLoop = killWhileActive(killer, appName, () => killing);

  const { result: caught, lines } = await captureErrors(async () => {
    try {
      await db.withRetry(async (sql) => sql`select pg_sleep(0.5), 1`);
      return undefined;
    } catch (err) {
      return err;
    }
  });
  killing = false;
  await killLoop;
  await killer.end();

  expect(caught).toBeInstanceOf(Error); // the retry's own failure propagates…
  expect(lines).toHaveLength(1); // …without a second "reconnecting" line for a retry that wasn't attempted
});
