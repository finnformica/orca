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
// which is deterministic: the write Bun already has in flight fails outright.
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

  const admin = new Bun.SQL(pg.url);
  // Kill the FIRST attempt's connection the moment it's actually running — then stop, so the
  // retry's own connection goes through untouched.
  const killOnce = killNextActive(admin, appName);

  const { result, lines } = await captureErrors(() =>
    db.withRetry(async (s) => s`select pg_sleep(0.1), 1 + 1 as two`));
  await killOnce;
  await admin.end();

  expect(result[0]?.two).toBe(2); // the retried query actually ran, on a working connection
  expect(lines.filter((l) => l.includes("[db] connection dropped"))).toHaveLength(1);
});

test("a second drop on the retry is not retried again — it surfaces to the caller", async () => {
  const appName = `orca-test-dbreconnect-double-${process.pid}`;
  useTaggedSchema(appName);
  await db.close();

  const killer = new Bun.SQL(pg.url);
  let killing = true;
  const killLoop = killWhileActive(killer, appName, () => killing);

  const { result: caught, lines } = await captureErrors(async () => {
    try {
      await db.withRetry(async (sql) => sql`select pg_sleep(0.1), 1`);
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
