// The agent scope (server/cgroup.ts): every agent process starts with a POSITIVE OOM score, scoped
// or not (the bridge keeps -500), every scope runs in orca-agents.slice with the limit the bridge
// sets, and a dead user manager is reported once while the run starts unscoped. Driven through the
// real `agent.launch()` with fake `systemd-run` / `systemctl` / `claude` on PATH, a fake user bus and
// lingering dir, and a real Postgres (the harness of tests/oom.test.ts).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as cgroup from "../server/cgroup";
import { freshSchema, type TestDb } from "./pg";

const linux = process.platform === "linux";

let dir: string, shim: string, runtime: string, linger: string, log: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};
const ENV_KEYS = ["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "XDG_RUNTIME_DIR", "ORCA_TEST_FORCE_CGROUP_LINUX", "ORCA_LINGER_DIR", "ORCA_AGENTS_SLICE_MAX_GB"];

async function bin(name: string, body: string): Promise<void> {
  await writeFile(join(shim, name), `#!/bin/sh\n${body}\n`);
  await chmod(join(shim, name), 0o755);
}
/** `systemctl`: the user manager answers (or not), set-property and the scope's Result are logged. */
async function fakeSystemctl(o: { manager?: "running" | "dead"; result?: string } = {}): Promise<void> {
  await bin("systemctl", `echo "systemctl $*" >> "${log}"
case "$*" in
  *"is-system-running") ${o.manager === "dead" ? `echo "Failed to connect to bus: Connection refused" >&2; exit 1` : "echo running"} ;;
  *"set-property"*) exit 0 ;;
  *"-p Result --value") echo '${o.result ?? "success"}' ;;
  *) exit 1 ;;
esac`);
}
/** `claude`: writes its own OOM score and then runs `then` (default: a clean result). */
async function fakeClaude(then = `printf '{"type":"result","subtype":"success","result":"done","is_error":false}'`): Promise<void> {
  await bin("claude", `cat /proc/self/oom_score_adj > "${dir}/adj" 2>/dev/null\n${then}`);
}

beforeEach(async () => {
  prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = await mkdtemp(join(tmpdir(), "orca-scope-"));
  shim = await mkdtemp(join(tmpdir(), "orca-scope-shim-"));
  runtime = await mkdtemp(join(tmpdir(), "orca-scope-run-"));
  linger = await mkdtemp(join(tmpdir(), "orca-scope-linger-"));
  log = join(dir, "calls.log");
  await writeFile(log, "");
  await writeFile(join(runtime, "bus"), "");
  // `systemd-run ... -- <cmd>`: log the argv, then run what follows `--`, as the real one does.
  await bin("systemd-run", `echo "systemd-run $*" >> "${log}"
found=0; for a in "$@"; do shift; if [ "$a" = "--" ]; then found=1; break; fi; done
exec "$@"`);
  await fakeSystemctl();
  await fakeClaude();
  Object.assign(process.env, {
    ORCA_STATE_DIR: dir, PATH: `${shim}:${prev.PATH}`, XDG_RUNTIME_DIR: runtime, ORCA_TEST_FORCE_CGROUP_LINUX: "1",
    ORCA_LINGER_DIR: linger, ORCA_AGENTS_SLICE_MAX_GB: "2",
  });
  cgroup.noteUserManager({ ok: true });
  pg = await freshSchema("scope");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  cgroup.onUserManagerDown(undefined);
  cgroup.noteUserManager({ ok: true });
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [dir, shim, runtime, linger]) await rm(d, { recursive: true, force: true });
});

async function run(branch: string, opts: Partial<agent.LaunchOptions> = {}) {
  const wt = join(dir, branch);
  await mkdir(wt, { recursive: true });
  return { wt, receipt: await agent.runAgent(wt, "go", { repo: "r", branch, provider: "claude", ...opts }) };
}
async function finished(branch: string, repo = "r") {
  for (let i = 0; i < 400 && !(await db.turns(repo, branch))[0]?.finishedAt; i++) await new Promise((r) => setTimeout(r, 25));
  return (await db.turns(repo, branch))[0]!;
}
const calls = () => readFile(log, "utf8");

test.skipIf(!linux)("a scoped run is in orca-agents.slice with OOM score 500, and the bridge caps the slice first", async () => {
  await run("scoped");
  const turn = await finished("scoped");
  expect(turn.response).toBe("done");
  expect((await readFile(join(dir, "adj"), "utf8")).trim()).toBe("500"); // not the bridge's (inherited) score
  const c = await calls();
  expect(c).toContain("systemctl --user set-property --runtime orca-agents.slice MemoryMax=2048M");
  expect(c).toMatch(/systemd-run --user --scope --quiet --unit=orca-run-\S+ --slice=orca-agents\.slice -p MemoryMax=4G/);
  expect(c.indexOf("set-property")).toBeLessThan(c.indexOf("systemd-run"));
});

test.skipIf(!linux)("unscoped (no user bus, lingering off: a laptop or CI): the agent still gets OOM score 500", async () => {
  await rm(join(runtime, "bus"));
  await run("plain");
  await finished("plain");
  expect((await readFile(join(dir, "adj"), "utf8")).trim()).toBe("500");
  expect(await calls()).not.toContain("systemd-run");
  expect(cgroup.userManagerDown()).toBeUndefined(); // no lingering: no user manager expected, nothing is down
});

test("a dead user manager: reported once, notified with the run's card, and the run starts unscoped", async () => {
  await writeFile(join(linger, userInfo().username), "");
  await fakeSystemctl({ manager: "dead" });
  const heard: { reason: string; repo?: string; branch?: string }[] = [];
  cgroup.onUserManagerDown((d, r) => heard.push({ reason: d.reason, ...r }));
  await run("down-1");
  expect((await finished("down-1")).response).toBe("done"); // the run still ran
  await run("down-2");
  await finished("down-2");
  expect(await calls()).not.toContain("systemd-run"); // unscoped: no scope without a user manager
  expect(heard).toEqual([{ reason: "Failed to connect to bus: Connection refused", repo: "r", branch: "down-1" }]); // once, not per run
  expect(cgroup.userManagerDown()?.reason).toBe("Failed to connect to bus: Connection refused");
  // Back (the health watchdog restarted it): the next launch clears the state and is scoped again.
  await fakeSystemctl({ manager: "running" });
  await run("back");
  await finished("back");
  expect(cgroup.userManagerDown()).toBeUndefined();
  expect(await calls()).toContain("systemd-run");
});

test("lingering on but no bus socket at all: down, with the path in the reason", async () => {
  await writeFile(join(linger, userInfo().username), "");
  await rm(join(runtime, "bus"));
  await run("nobus");
  await finished("nobus");
  expect(cgroup.userManagerDown()?.reason).toBe(`no user bus at ${runtime}/bus`);
});
