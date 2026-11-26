// The Postgres restart of 2026-11-26 (docs/RECOVERY.md): needrestart restarted postgresql@18-main.
// A live query got FATAL 57P01 ("terminating connection due to administrator command"), `withRetry`
// reopened the pool WHILE Postgres was shutting down, the reopen got FATAL 57P03 ("the database
// system is shutting down"), and every query after that failed with the same 57P03 for two hours,
// although Postgres was back two seconds later. The pool's `ready` (its migrate promise) was kept
// rejected, and `open()` awaited it again on every call.
//
// A real Postgres restart is not possible here (the test Postgres is shared), so a small TCP proxy
// stands in front of it and plays the restart on the wire: it ends a live query with a 57P01
// ErrorResponse, answers new connects with a 57P03 one, then passes traffic through again. Bun.SQL,
// `withRetry`, the pool and the background probe are the real ones.
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as db from "../server/db";
import { freshSchema, type TestDb } from "./pg";

const BASE = new URL(process.env.ORCA_TEST_DATABASE_URL || "postgres://localhost:5432/postgres");

let pg: TestDb;
let prevDbUrl: string | undefined;
let proxy: Proxy | null = null;

beforeEach(async () => {
  prevDbUrl = process.env.ORCA_DATABASE_URL;
  pg = await freshSchema("pgrestart");
});
afterEach(async () => {
  await db.close();
  proxy?.stop();
  proxy = null;
  await pg.drop();
  if (prevDbUrl === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prevDbUrl;
});

/** A Postgres ErrorResponse message ('E'), severity FATAL — what a backend sends before it closes. */
function fatal(sqlstate: string, message: string): Uint8Array {
  const enc = new TextEncoder();
  const fields = [["S", "FATAL"], ["V", "FATAL"], ["C", sqlstate], ["M", message]];
  const body = [...fields.flatMap(([k, v]) => [...enc.encode(k!), ...enc.encode(v!), 0]), 0];
  const out = new Uint8Array(5 + body.length);
  out[0] = 0x45; // 'E'
  new DataView(out.buffer).setInt32(1, 4 + body.length);
  out.set(body, 5);
  return out;
}

type Mode = "up" | { sqlstate: string; message: string };
type Side = { pending: Uint8Array[]; write: (d: Uint8Array) => void };
type Proxy = { url: string; mode: Mode; shutdown: () => void; stop: () => void };

/** A TCP proxy to the test Postgres. Mode "up" passes bytes through. Any other mode answers each new
 *  connect's startup message with that FATAL error and closes, as a Postgres that is shutting down
 *  (57P03) does. `shutdown()` ends every live connection with 57P01, as a fast shutdown does. */
function startProxy(schemaUrl: string): Proxy {
  type Conn = { client: Bun.Socket<Conn>; upstream?: Bun.Socket<unknown>; toUpstream: Uint8Array[]; refused: boolean; out: Side };
  const live = new Set<Conn>();
  const writer = (sock: () => Bun.Socket<any> | undefined): Side => {
    const side: Side = {
      pending: [],
      write: (d) => {
        const s = sock();
        if (!s) return;
        if (side.pending.length) { side.pending.push(d); return; }
        const n = s.write(d);
        if (n < d.length) side.pending.push(d.subarray(Math.max(0, n)));
      },
    };
    return side;
  };
  const flush = (s: Bun.Socket<any>, side: Side) => {
    while (side.pending.length) {
      const d = side.pending[0]!;
      const n = s.write(d);
      if (n < d.length) { side.pending[0] = d.subarray(Math.max(0, n)); return; }
      side.pending.shift();
    }
  };
  const state: Proxy = { url: "", mode: "up", shutdown: () => {}, stop: () => {} };
  const server = Bun.listen<Conn>({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(client) {
        const conn: Conn = { client, toUpstream: [], refused: state.mode !== "up", out: undefined as unknown as Side };
        conn.out = writer(() => conn.client);
        client.data = conn;
        live.add(conn);
        if (conn.refused) return;
        const upWriter = writer(() => conn.upstream);
        (conn as Conn & { up: Side }).up = upWriter;
        void Bun.connect({
          hostname: BASE.hostname, port: Number(BASE.port || 5432),
          socket: {
            open(up) {
              conn.upstream = up;
              for (const d of conn.toUpstream) upWriter.write(d);
              conn.toUpstream = [];
            },
            data(_up, d) { conn.out.write(new Uint8Array(d)); },
            drain(up) { flush(up, upWriter); },
            close() { conn.client.end(); },
            error() { conn.client.end(); },
          },
        }).catch(() => conn.client.end());
      },
      data(client, d) {
        const conn = client.data;
        const bytes = new Uint8Array(d);
        if (conn.refused) {
          // An SSLRequest (length 8, code 80877103) gets 'N'; the startup message gets the FATAL.
          if (bytes.length === 8 && new DataView(bytes.buffer, bytes.byteOffset).getInt32(4) === 80877103) { client.write("N"); return; }
          const m = state.mode as { sqlstate: string; message: string };
          client.write(fatal(m.sqlstate, m.message));
          client.end();
          return;
        }
        if (!conn.upstream) { conn.toUpstream.push(bytes); return; }
        (conn as Conn & { up: Side }).up.write(bytes);
      },
      drain(client) { flush(client, client.data.out); },
      close(client) { live.delete(client.data); client.data.upstream?.end(); },
      error(client) { client.data.upstream?.end(); },
    },
  });
  const u = new URL(schemaUrl);
  u.hostname = "127.0.0.1";
  u.port = String(server.port);
  state.url = u.toString();
  state.shutdown = () => {
    state.mode = { sqlstate: "57P03", message: "the database system is shutting down" };
    for (const conn of live) {
      if (conn.refused) continue;
      conn.upstream?.end();
      conn.upstream = undefined;
      conn.client.write(fatal("57P01", "terminating connection due to administrator command"));
      conn.client.end();
    }
  };
  state.stop = () => {
    for (const conn of live) { conn.upstream?.end(); conn.client.end(); }
    server.stop(true);
  };
  return state;
}

async function captureErrors<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const [origErr, origLog] = [console.error, console.log];
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { return { result: await fn(), lines }; } finally { console.error = origErr; console.log = origLog; }
}

/** Point the bridge at the proxy, with the schema already migrated (directly, not through it). */
async function behindProxy(): Promise<Proxy> {
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  await db.open();
  const p = startProxy(pg.url);
  process.env.ORCA_DATABASE_URL = p.url;
  await db.close();
  await db.open();
  return p;
}

const selectOne = () => db.withRetry(async (s) => s`select 1 as one`);

/** Run `select 1` until it answers, up to `ms`. The bridge itself must recover: nothing here
 *  closes the pool or restarts anything. */
async function answersWithin(ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await selectOne())[0]?.one === 1) return true; } catch { /* still down */ }
    await Bun.sleep(100);
  }
  return false;
}

test("a Postgres restart (57P01 on a live query, then 57P03 on the reopen) recovers by itself once Postgres is back", async () => {
  proxy = await behindProxy();
  expect((await selectOne())[0]?.one).toBe(1);

  const { result: caught, lines } = await captureErrors(async () => {
    const running = db.withRetry(async (s) => s`select pg_sleep(0.5), 1 as one`).catch((e: unknown) => e);
    await Bun.sleep(150); // the query is on the wire
    proxy!.shutdown(); // the fast shutdown: 57P01 to the live query, 57P03 to every new connect
    const err = await running;
    // While Postgres is shutting down, every query fails — fast, as the outage it is.
    const during = await selectOne().catch((e: unknown) => e);
    expect(during).toBeInstanceOf(db.DbUnavailable);
    expect(await db.ping().catch((e: unknown) => e)).toBeInstanceOf(db.DbUnavailable); // the watchdog's check fails
    proxy!.mode = "up"; // Postgres is up again
    expect(await answersWithin(5_000)).toBe(true); // the background probe found it; no restart of anything
    return err;
  });
  expect(caught).toBeInstanceOf(db.DbUnavailable);
  expect(db.unavailableSince()).toBeNull();
  await db.ping(); // GET /api/health/db's check passes again too
  expect(lines.filter((l) => l.includes("[db] connection dropped"))).toHaveLength(1);
  expect(lines.filter((l) => l.includes("orca: database unreachable ("))).toHaveLength(1);
  expect(lines.some((l) => l.includes("the database system is shutting down"))).toBe(true);
  expect(lines.some((l) => l.includes("orca: database reachable again"))).toBe(true);
});

test("a Postgres that is starting up (57P03) is an outage too, and the next query after it works", async () => {
  proxy = await behindProxy();
  proxy.mode = { sqlstate: "57P03", message: "the database system is starting up" };
  await db.close(); // the next query needs a fresh connect
  const { lines } = await captureErrors(async () => {
    expect(await selectOne().catch((e: unknown) => e)).toBeInstanceOf(db.DbUnavailable);
    proxy!.mode = "up";
    expect(await answersWithin(5_000)).toBe(true);
  });
  expect(lines.some((l) => l.includes("orca: database reachable again"))).toBe(true);
});

// The root cause, apart from the error classes: a pool whose first connect failed with ANY error the
// classifier does not know was kept, with its rejected migrate promise, and every later `open()`
// awaited that same promise again. Now a failed pool is dropped, so the next query connects again.
test("a pool whose connect failed with an unknown error is not kept: the next query connects again", async () => {
  proxy = await behindProxy();
  proxy.mode = { sqlstate: "XX000", message: "some error no classifier knows" };
  await db.close();
  const first = await selectOne().catch((e: unknown) => e);
  expect(first).toBeInstanceOf(Error);
  expect(first).not.toBeInstanceOf(db.DbUnavailable);
  expect(String((first as Error).message)).toContain("some error no classifier knows");
  proxy.mode = "up";
  expect((await selectOne())[0]?.one).toBe(1); // at once: no outage was declared, nothing to wait for
});

test("57P01, 57P02 and 57P03 are database errors: shutdown and crash drop a connection, 'shutting down' and 'starting up' are an outage", () => {
  const pgErr = (errno: string, message: string) => Object.assign(new Error(message), { name: "PostgresError", code: "ERR_POSTGRES_SERVER_ERROR", errno });
  const admin = pgErr("57P01", "terminating connection due to administrator command");
  const crash = pgErr("57P02", "terminating connection because of crash of another server process");
  const shutting = pgErr("57P03", "the database system is shutting down");
  const starting = pgErr("57P03", "the database system is starting up");
  expect(db.isDroppedConnection(admin)).toBe(true);
  expect(db.isDroppedConnection(crash)).toBe(true);
  expect(db.isConnectFailure(shutting)).toBe(true);
  expect(db.isConnectFailure(starting)).toBe(true);
  // By SQLSTATE alone too (a server with another lc_messages words them differently).
  expect(db.isConnectFailure(pgErr("57P03", "das Datenbanksystem fährt herunter"))).toBe(true);
  expect(db.isDroppedConnection(pgErr("57P02", "Verbindung wird abgebrochen"))).toBe(true);
  for (const e of [admin, crash, shutting, starting]) expect(db.isDbError(e)).toBe(true);
  expect(db.isDbError(pgErr("23505", "duplicate key value violates unique constraint"))).toBe(false);
});
