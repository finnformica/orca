// The health watchdog (deploy/health-check.sh, docs/RECOVERY.md): a bridge that is alive but does
// not answer is restarted after 3 failed /api/config checks in a row — never in its first 2
// minutes after a start, never under a deploy. Driven against fake `systemctl`, `curl` and
// `logger` on PATH (the PATH-shim pattern of tests/helpers.ts) and the real `flock` for the lock.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../deploy/health-check.sh");
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orca-health-"));
  const bin = async (name: string, body: string) => {
    await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(dir, name), 0o755);
  };
  // The unit is `orca`, or a slot of deploy/orca@.service when "$SHIM/slot" names one (a or b).
  await bin("systemctl", `case "$*" in
  "show -p ActiveState --value orca"|"show -p ActiveState --value orca@"[ab]) cat "$SHIM/orca-state" ;;
  "show -p ActiveEnterTimestampMonotonic --value orca"|"show -p ActiveEnterTimestampMonotonic --value orca@"[ab]) cat "$SHIM/orca-start" ;;
  "show -p ActiveState --value orca-autodeploy.service") cat "$SHIM/autodeploy-state" ;;
  "is-active -q orca@"[ab]) [ "$(cat "$SHIM/slot" 2>/dev/null)" = "\${3#orca@}" ] ;;
  "restart orca"|"restart orca@"[ab]) echo "restart $2" >> "$SHIM/calls" ;;
  "show -p ActiveState --value user@"*) cat "$SHIM/manager-state" ;;
  "restart user@"*) echo "$2" >> "$SHIM/manager-calls" ;;
esac`);
  await writeFile(join(dir, "manager-state"), "active\n");
  await mkdir(join(dir, "linger"));
  await bin("curl", `exit "$(cat "$SHIM/curl-exit")"`);
  await bin("logger", `echo "$*" >> "$SHIM/journal"`);
  await writeFile(join(dir, "uptime"), "1000.00 900.00\n"); // up 1000 s
  await set({ state: "active", startedS: 400, autodeploy: "inactive", curlExit: 28 }); // 600 s old, no answer
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function set(o: { state?: string; startedS?: number; autodeploy?: string; curlExit?: number }): Promise<void> {
  if (o.state !== undefined) await writeFile(join(dir, "orca-state"), `${o.state}\n`);
  if (o.startedS !== undefined) await writeFile(join(dir, "orca-start"), `${o.startedS * 1_000_000}\n`);
  if (o.autodeploy !== undefined) await writeFile(join(dir, "autodeploy-state"), `${o.autodeploy}\n`);
  if (o.curlExit !== undefined) await writeFile(join(dir, "curl-exit"), `${o.curlExit}\n`);
}
function check(env: Record<string, string> = {}): number {
  const r = Bun.spawnSync(["bash", SCRIPT], {
    env: {
      ...process.env, PATH: `${dir}:${process.env.PATH}`, SHIM: dir,
      ORCA_HEALTH_STATE: join(dir, "state"), ORCA_UPTIME_FILE: join(dir, "uptime"),
      ORCA_DEPLOY_LOCK: join(dir, "deploy.lock"), ORCA_HEALTH_URL: "http://127.0.0.1:1/api/config",
      ORCA_USER: userInfo().username, ORCA_LINGER_DIR: join(dir, "linger"), ...env,
    },
  });
  return r.exitCode;
}
const read = (f: string) => readFile(join(dir, f), "utf8").catch(() => "");
const restarts = async () => (await read("calls")).split("\n").filter(Boolean).length;

test("three failed checks in a row restart orca and log each step to the journal", async () => {
  expect(check()).toBe(0);
  expect(check()).toBe(0);
  expect(await restarts()).toBe(0);
  expect(check()).toBe(0);
  expect(await restarts()).toBe(1);
  const journal = await read("journal");
  expect(journal).toContain("-t orca-health -- no answer from http://127.0.0.1:1/api/config within 10 s (1 of 3)");
  expect(journal).toContain("(3 of 3)");
  expect(journal).toContain("restarting orca after 3 failed checks in a row");
  // The count starts again after a restart.
  check(); check();
  expect(await restarts()).toBe(1);
});

test("with a slot of deploy/orca@.service live, that slot is the one restarted", async () => {
  await writeFile(join(dir, "slot"), "b\n");
  check(); check(); check();
  expect(await read("calls")).toBe("restart orca@b\n");
  expect(await read("journal")).toContain("restarting orca@b after 3 failed checks in a row");
});

test("an answer clears the count, so only failures IN A ROW restart orca", async () => {
  check(); check();
  await set({ curlExit: 0 });
  check();
  await set({ curlExit: 28 });
  check(); check();
  expect(await restarts()).toBe(0);
});

test("no check in the first 2 minutes after a start (boot or deploy)", async () => {
  await set({ startedS: 950 }); // started 50 s ago
  check(); check(); check(); check();
  expect(await restarts()).toBe(0);
  expect(await read("journal")).toBe("");
});

test("no check while orca is not active: Restart=always owns a process that exited", async () => {
  await set({ state: "activating" });
  check(); check(); check();
  expect(await restarts()).toBe(0);
});

test("no check while the autodeploy service runs", async () => {
  await set({ autodeploy: "activating" });
  check(); check(); check();
  expect(await restarts()).toBe(0);
});

test.skipIf(!Bun.which("flock"))("no check while a deploy holds the deploy lock", async () => {
  await writeFile(join(dir, "deploy.lock"), "");
  // A deploy that holds the lock for 1 s (a kill leaves the lock with flock's child, so let it end).
  const holder = Bun.spawn(["flock", join(dir, "deploy.lock"), "sleep", "1"]);
  await new Promise((r) => setTimeout(r, 200)); // let flock take the lock
  check(); check(); check();
  expect(await restarts()).toBe(0);
  await holder.exited;
  check(); check(); check(); // the lock is free again: the watchdog acts
  expect(await restarts()).toBe(1);
});

test("a missing lock file is not created (root must not own the orca user's lock)", async () => {
  check();
  expect(await Bun.file(join(dir, "deploy.lock")).exists()).toBe(false);
});

// The orca user's systemd manager: on 2026-10-18 a memcg OOM killed it, and every agent scope failed
// for 9 hours. The watchdog restarts it, as root, whatever state the bridge is in.
test("a failed user manager is restarted and logged, when lingering is on", async () => {
  await writeFile(join(dir, "linger", userInfo().username), "");
  await writeFile(join(dir, "manager-state"), "failed\n");
  await set({ curlExit: 0 });
  check();
  const uid = process.getuid?.() ?? 0;
  expect((await read("manager-calls")).trim()).toBe(`user@${uid}.service`);
  expect(await read("journal")).toContain(`user@${uid}.service is failed (lingering is on for ${userInfo().username}): restarting it`);
});

test("no restart of a user manager that runs, or starts, or when lingering is off", async () => {
  await writeFile(join(dir, "manager-state"), "inactive\n");
  check(); // lingering off: no user manager is expected
  await writeFile(join(dir, "linger", userInfo().username), "");
  for (const state of ["active", "activating", "reloading"]) {
    await writeFile(join(dir, "manager-state"), `${state}\n`);
    check();
  }
  expect(await read("manager-calls")).toBe("");
});
