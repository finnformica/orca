// Degraded local mode: the laptop keeps working while the shared Postgres (on the cloud box) is
// unreachable. The day it hung, the laptop's bridge died at `db.open()` and `bun --watch` never re-ran
// it. These drive the real pieces end to end:
//   - the bridge BOOTS with ORCA_DATABASE_URL pointing at a closed port and answers /api/config from
//     the state dir's cached config, reporting the database unreachable;
//   - an agent run (a fake `claude` on PATH) in that state completes, its turn journaled to the outbox;
//   - the SAME database URL becoming reachable (a TCP forwarder in front of the test Postgres, closed
//     then opened) replays the journal: the turn lands under its run id, once, steps included;
//   - placement keeps local work local without the inventory;
//   - the dev launcher's supervisor restarts a crashing child.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as outbox from "../server/outbox";
import { placement } from "../server/verbs";
import type { RepoConfig } from "../server/config";
import { supervise } from "../scripts/supervise";
import { makeScratchRepo } from "./helpers";
import { freshSchema, type TestDb } from "./pg";
import { run } from "../server/run";
import { native } from "./happydom";

// The preload swaps in happy-dom's CORS-enforcing fetch for component tests; this talks to a real bridge.
const get = (url: string) => native.fetch(url);

const ROOT = join(import.meta.dir, "..");

let state: string;
let shim: string;
let repo: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};

/** A port nothing listens on (bound once to learn a free number, then released). */
function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

type Pipe = { peer?: Bun.Socket<Pipe>; pending: Uint8Array[] };
/** Write all of `data`, queueing what the socket doesn't take now (flushed on drain). */
function send(sock: Bun.Socket<Pipe>, data: Uint8Array): void {
  if (sock.data.pending.length) { sock.data.pending.push(data); return; }
  const n = sock.write(data);
  if (n < data.length) sock.data.pending.push(data.subarray(Math.max(n, 0)));
}
function drain(sock: Bun.Socket<Pipe>): void {
  while (sock.data.pending.length) {
    const head = sock.data.pending[0]!;
    const n = sock.write(head);
    if (n < head.length) { sock.data.pending[0] = head.subarray(Math.max(n, 0)); return; }
    sock.data.pending.shift();
  }
}

/** A plain TCP forwarder on `port` → the test Postgres: "the database is back" without changing the
 *  URL the journal was written for. */
function forwarder(port: number, target: { hostname: string; port: number }) {
  return Bun.listen<Pipe>({
    hostname: "127.0.0.1", port,
    socket: {
      open(client) {
        client.data = { pending: [] };
        const early: Uint8Array[] = [];
        client.data.peer = undefined;
        (client.data as Pipe & { early?: Uint8Array[] }).early = early;
        void Bun.connect<Pipe>({
          ...target,
          socket: {
            open(up) {
              up.data = { peer: client, pending: [] };
              client.data.peer = up;
              for (const b of early) send(up, b);
            },
            data(up, d) { send(up.data.peer!, new Uint8Array(d)); },
            drain,
            close(up) { up.data.peer?.end(); },
            error(up) { up.data.peer?.end(); },
          },
        }).catch(() => client.end());
      },
      data(client, d) {
        const bytes = new Uint8Array(d);
        if (client.data.peer) send(client.data.peer, bytes);
        else (client.data as Pipe & { early?: Uint8Array[] }).early!.push(bytes);
      },
      drain,
      close(client) { client.data.peer?.end(); },
      error(client) { client.data.peer?.end(); },
    },
  });
}

/** The test schema's URL, re-pointed at `port` on loopback (same search_path, so the same schema). */
const viaPort = (url: string, port: number) => { const u = new URL(url); u.hostname = "127.0.0.1"; u.port = String(port); return u.toString(); };

beforeEach(async () => {
  prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_INSTANCE", "ORCA_PREVIEW_BRIDGE"].map((k) => [k, process.env[k]]));
  state = await mkdtemp(join(tmpdir(), "orca-degraded-"));
  shim = await mkdtemp(join(tmpdir(), "orca-claude-"));
  repo = await makeScratchRepo();
  process.env.ORCA_STATE_DIR = state;
  process.env.PATH = `${shim}:${prev.PATH}`;
  process.env.ORCA_INSTANCE = "local";
  pg = await freshSchema("degraded");
  // A fake claude: one step of text, then the result.
  await writeFile(join(shim, "claude"), `#!/bin/sh
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"working offline"}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","result":"## Outcome\\\\nDone without the database.","is_error":false}'
`);
  await chmod(join(shim, "claude"), 0o755);
});
afterEach(async () => {
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, repo]) await rm(d, { recursive: true, force: true });
});

test("D1 the bridge boots without the database and answers /api/config from the cached config", async () => {
  const dbUrl = `postgres://127.0.0.1:${freePort()}/orca`;
  // The cache a previous (connected) run left behind, tagged with the database it came from.
  process.env.ORCA_DATABASE_URL = dbUrl;
  const key = db.databaseKey();
  await writeFile(join(state, "config.cache.json"), JSON.stringify({
    db: key,
    config: {
      repos: [{ name: "r", repoPath: repo, worktreeRoot: join(repo, ".worktrees"), baseBranch: "main", previewServices: [] }],
      portRange: [30000, 31000], staleHours: 24, instances: { local: "http://127.0.0.1:1", cloud: "http://127.0.0.1:2" },
    },
  }));
  const port = freePort();
  const proc = Bun.spawn(["bun", "--env-file=/dev/null", "server/index.ts"], {
    cwd: ROOT, stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ORCA_DATABASE_URL: dbUrl, ORCA_STATE_DIR: state, ORCA_API_PORT: String(port), ORCA_BIND: "127.0.0.1", ORCA_INSTANCE: "local" },
  });
  try {
    let res: Response | undefined;
    for (let i = 0; i < 200 && !res; i++) {
      res = await get(`http://127.0.0.1:${port}/api/config`).catch(() => undefined);
      if (!res) await Bun.sleep(50);
    }
    expect(res?.status).toBe(200);
    const cfg = (await res!.json()) as { repos: { name: string }[]; instances: string[]; database: string };
    expect(cfg.repos.map((r) => r.name)).toEqual(["r"]);
    expect(cfg.instances).toEqual(["local", "cloud"]);
    expect(cfg.database).toMatch(/^unreachable since \d{4}-\d\d-\d\dT/);
    const health = (await (await get(`http://127.0.0.1:${port}/api/health`)).json()) as { database: string };
    expect(health.database).toMatch(/^unreachable since /);
    // A DB-backed read degrades to empty + the marker, rather than a 500.
    const turns = await get(`http://127.0.0.1:${port}/api/turns?repo=r&branch=b&limit=50`);
    expect(turns.status).toBe(200);
    expect(turns.headers.get("x-orca-database")).toMatch(/^unreachable since /);
    expect(await turns.json()).toEqual({ turns: [], older: null, dbUnavailable: true });
    const queued = await get(`http://127.0.0.1:${port}/api/queued?repo=r&branch=b`);
    expect(queued.status).toBe(200);
    expect(await queued.json()).toEqual([]);
    expect(proc.exitCode).toBeNull(); // still up
  } finally {
    proc.kill();
    await proc.exited;
  }
}, 30_000);

test("D2 a run with the database down completes, is journaled, and replays once when it is back", async () => {
  const port = freePort();
  const target = new URL(pg.url);
  process.env.ORCA_DATABASE_URL = viaPort(pg.url, port);
  await db.close();

  const receipt = await agent.runAgent(repo, "do it offline", { repo: "r", branch: "feat", provider: "claude", instruction: "do it offline" });
  for (let i = 0; i < 400 && agent.isRunning(repo); i++) await Bun.sleep(25);
  await agent.flushHistory();
  expect(agent.status(repo).status).toBe("done");
  expect(db.databaseStatus()).toMatch(/^unreachable since /);

  // Journaled under its run id: the start, the step, the finish.
  const file = join(state, "outbox", `${receipt.runId}.json`);
  expect(existsSync(file)).toBe(true);
  const journal = JSON.parse(await readFile(file, "utf8")) as outbox.RunJournal;
  expect(journal.start?.instruction).toBe("do it offline");
  expect(journal.finish?.status).toBe("done");
  expect(journal.steps.length).toBeGreaterThan(0);
  // What the chat shows meanwhile (the local route's source).
  const local = outbox.turns("r", "feat");
  expect(local.map((t) => t.id)).toEqual([receipt.runId]);
  expect(local[0]!.response).toContain("Done without the database.");
  // An enrichment write queues the same way.
  expect(await outbox.patchEnrichment("r", "feat", { title: "Offline work" })).toEqual({ queued: true });

  // The database comes back on the SAME url; the probe replays the outbox.
  const proxy = forwarder(port, { hostname: target.hostname === "localhost" ? "127.0.0.1" : target.hostname, port: Number(target.port || 5432) });
  try {
    expect(await db.probe()).toBe(true);
    expect(db.databaseStatus()).toBe("ok");
    const turns = await db.turns("r", "feat");
    expect(turns.map((t) => t.id)).toEqual([receipt.runId]);
    expect(turns[0]!.response).toContain("Done without the database.");
    expect(turns[0]!.instruction).toBe("do it offline");
    const steps = await db.steps(receipt.runId);
    expect(steps.length).toBe(journal.steps.length);
    expect((await db.enrichment("r")).feat?.title).toBe("Offline work");
    expect((await readdir(join(state, "outbox"))).filter((f) => f.endsWith(".json"))).toEqual([]);

    // A second replay (say the first was interrupted after writing) adds nothing.
    await writeFile(file, JSON.stringify(journal));
    await outbox.replay();
    expect((await db.turns("r", "feat")).length).toBe(1);
    expect((await db.steps(receipt.runId)).length).toBe(journal.steps.length);
  } finally {
    await db.close();
    proxy.stop(true);
  }
}, 30_000);

test("D3 placement keeps a worktree on this disk local without the inventory", async () => {
  process.env.ORCA_DATABASE_URL = viaPort(pg.url, freePort());
  await db.close();
  const root = join(repo, ".worktrees");
  await run(["git", "worktree", "add", "-q", "-b", "local-work", join(root, "local-work")], repo);
  const cfg: RepoConfig = { name: "r", repoPath: repo, worktreeRoot: root, baseBranch: "main", previewServices: [], runsOn: "cloud" };
  expect(await placement(cfg, { branch: "local-work" })).toBe("local");
  expect(await placement(cfg, { worktreePath: join(root, "local-work") })).toBe("local");
  expect(await placement(cfg, { branch: "somewhere-else" })).toBe("cloud"); // not here: the repo's default
});

test("D5 a branch preview's read-only bridge never replays the outbox; the real bridge does", async () => {
  // A preview bridge (ORCA_PREVIEW_BRIDGE=1, scripts/preview-orca.sh) shares this machine's state dir
  // but refuses every write — the main bridge's journal is the main bridge's to replay.
  const port = freePort();
  const target = new URL(pg.url);
  const pgAt = { hostname: target.hostname === "localhost" ? "127.0.0.1" : target.hostname, port: Number(target.port || 5432) };
  // The schema exists already (the real bridge migrated it); the preview bridge never migrates.
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.turns("r", "feat");
  process.env.ORCA_DATABASE_URL = viaPort(pg.url, port);
  await db.close();

  // An outage: a turn is journaled.
  const runId = crypto.randomUUID();
  expect(await outbox.startTurn({ repo: "r", branch: "feat", runId, provider: "claude", instruction: "offline", prompt: "offline", startedAt: Date.now() })).toBe("outbox");
  const file = join(state, "outbox", `${runId}.json`);
  let proxy = forwarder(port, pgAt);
  try {
    // Back, under a preview bridge: reachable, but nothing written and the journal kept.
    process.env.ORCA_PREVIEW_BRIDGE = "1";
    expect(await db.probe()).toBe(true);
    expect(await db.turns("r", "feat")).toEqual([]);
    expect(existsSync(file)).toBe(true);

    // Down again, then back under the real bridge: its reconnect replays the journal.
    delete process.env.ORCA_PREVIEW_BRIDGE;
    proxy.stop(true);
    await db.close();
    await expect(db.turns("r", "feat")).rejects.toBeInstanceOf(db.DbUnavailable);
    proxy = forwarder(port, pgAt);
    expect(await db.probe()).toBe(true);
    expect((await db.turns("r", "feat")).map((t) => t.id)).toEqual([runId]);
    expect(existsSync(file)).toBe(false);
  } finally {
    await db.close();
    proxy.stop(true);
  }
}, 30_000);

test("D4 the dev launcher's supervisor restarts a crashing bridge, and restarts on demand", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-supervise-"));
  try {
    const log = join(dir, "starts");
    const crash = join(dir, "crash.ts");
    await writeFile(crash, `import { appendFileSync } from "fs"; appendFileSync(${JSON.stringify(log)}, "start\\n"); throw new Error("database hung");`);
    const lines: string[] = [];
    const sup = supervise(["bun", crash], { minBackoffMs: 20, maxBackoffMs: 40, stdio: "ignore", log: (l) => lines.push(l), name: "bridge" });
    for (let i = 0; i < 200 && (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length < 3; i++) await Bun.sleep(25);
    await sup.stop();
    expect((await readFile(log, "utf8")).split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toMatch(/bridge exited \(code 1\) — restarting/);

    // A long-running child restarts at once on restart() (a watched file changed).
    const slow = join(dir, "slow.ts");
    const slowLog = join(dir, "slow-starts");
    await writeFile(slow, `import { appendFileSync } from "fs"; appendFileSync(${JSON.stringify(slowLog)}, "start\\n"); setInterval(() => {}, 1000);`);
    const sup2 = supervise(["bun", slow], { minBackoffMs: 10_000, stdio: "ignore", log: () => {} });
    for (let i = 0; i < 200 && !existsSync(slowLog); i++) await Bun.sleep(25);
    sup2.restart();
    for (let i = 0; i < 200 && (await readFile(slowLog, "utf8")).split("\n").filter(Boolean).length < 2; i++) await Bun.sleep(25);
    expect(sup2.starts).toBe(2);
    await sup2.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
