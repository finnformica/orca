// End-to-end: a worker killed by its own memory ceiling (CLAUDE.md "Per-worker memory ceiling",
// server/cgroup.ts) is reported as out-of-memory, not a bare "exit 137" — 137 is plain SIGKILL from
// anything, so the turn and the ledger only call it OOM once the scope itself (a fake `systemctl`,
// standing in for the kernel's cgroup OOM killer) says so. Driven through the real `agent.launch()`
// with fake `systemd-run` / `systemctl` / `claude` on PATH and a real Postgres — the same harness as
// tests/stopReason.test.ts, extended to make `cgroup.available()` true without a real systemd.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as ledger from "../server/ledger";
import { freshSchema, type TestDb } from "./pg";

let dir: string;
let shim: string;
let runtimeDir: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};

// `systemd-run --user --scope ... -- <cmd>` re-executed for real: strip everything up to the first
// `--` and run what's left, so the wrapped `claude` shim actually runs under this fake.
const SYSTEMD_RUN_SHIM = `#!/usr/bin/env bash
args=()
found=0
for a in "$@"; do
  if [ "$found" = "1" ]; then args+=("$a"); fi
  [ "$a" = "--" ] && found=1
done
exec "\${args[@]}"
`;

const uid = process.getuid?.() ?? 0;
const sliceDir = `user.slice/user-${uid}.slice/user@${uid}.service/orca.slice/orca-agents.slice`;
const agentsEvents = () => join(dir, "cgroup", sliceDir, "memory.events.local");
const userEvents = () => join(dir, "cgroup", `user.slice/user-${uid}.slice/memory.events.local`);

beforeEach(async () => {
  prev = { ORCA_STATE_DIR: process.env.ORCA_STATE_DIR, ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, SLACK_TOKEN: process.env.SLACK_TOKEN, ORCA_TEST_FORCE_CGROUP_LINUX: process.env.ORCA_TEST_FORCE_CGROUP_LINUX, ORCA_CGROUP_ROOT: process.env.ORCA_CGROUP_ROOT, ORCA_AGENTS_SLICE_MAX_GB: process.env.ORCA_AGENTS_SLICE_MAX_GB };
  dir = await mkdtemp(join(tmpdir(), "orca-oom-"));
  shim = await mkdtemp(join(tmpdir(), "orca-oom-shim-"));
  runtimeDir = await mkdtemp(join(tmpdir(), "orca-oom-runtime-"));
  await writeFile(join(runtimeDir, "bus"), ""); // stands in for the real user-bus socket
  await writeFile(join(shim, "systemd-run"), SYSTEMD_RUN_SHIM);
  await chmod(join(shim, "systemd-run"), 0o755);
  // A SIGKILL to itself, same exit code (137) a kernel OOM kill leaves behind.
  await writeFile(join(shim, "claude"), "#!/bin/sh\nkill -9 $$\n");
  await chmod(join(shim, "claude"), 0o755);
  process.env.ORCA_STATE_DIR = dir;
  process.env.PATH = `${shim}:${prev.PATH}`;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.SLACK_TOKEN = "xoxp-secret";
  // server/agent.ts calls cgroup.available() with no `platform` override, so off Linux (macOS) it
  // would read false regardless of the PATH/bus shims below — force the Linux path for this test only.
  process.env.ORCA_TEST_FORCE_CGROUP_LINUX = "1";
  // A fake cgroup tree: the agents' slice and the user slice, each with no OOM yet.
  process.env.ORCA_CGROUP_ROOT = join(dir, "cgroup");
  process.env.ORCA_AGENTS_SLICE_MAX_GB = "2";
  await mkdir(join(dir, "cgroup", sliceDir), { recursive: true });
  await writeFile(agentsEvents(), "oom 0\n");
  await writeFile(userEvents(), "oom 0\n");
  ledger.clear();
  pg = await freshSchema("oom");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(dir, { recursive: true, force: true });
  await rm(shim, { recursive: true, force: true });
  await rm(runtimeDir, { recursive: true, force: true });
});

async function fakeSystemctl(reply: string): Promise<void> {
  // A live user manager (cgroup.userManagerCheck asks it before every scoped launch), and the scope's Result.
  await writeFile(join(shim, "systemctl"), `#!/bin/sh\ncase "$*" in\n  *"is-system-running") echo running ;;\n  *"show "*"-p Result --value") echo '${reply}' ;;\n  *) exit 1 ;;\nesac\n`);
  await chmod(join(shim, "systemctl"), 0o755);
}
async function run(branch: string): Promise<void> {
  const wt = join(dir, branch);
  await mkdir(wt, { recursive: true });
  await agent.runAgent(wt, "go", { repo: "r", branch, provider: "claude" });
}
async function finished(branch: string) {
  for (let i = 0; i < 400 && !(await db.turns("r", branch))[0]?.finishedAt; i++) await new Promise((r) => setTimeout(r, 25));
  return (await db.turns("r", branch))[0]!;
}

test("a run OOM-killed in its scope reports it on the turn and the ledger — not a bare exit code", async () => {
  await fakeSystemctl("oom-kill"); // the scope's own Result, as the kernel's cgroup OOM killer leaves it
  await run("oomed");
  const turn = await finished("oomed");
  expect(turn.failed).toBe(true);
  expect(turn.stopReason).toBe("error");
  expect(turn.response).toContain("out of memory");
  expect(turn.response).toContain("4 GB"); // the default ceiling (agentMemoryMaxGb unset)
  const entry = ledger.all().at(-1);
  expect(entry?.status).toBe("error");
  expect(entry?.errorKind).toBe("oom");
});

test("plain SIGKILL at the same exit code is NOT reported as OOM when the scope says it wasn't", async () => {
  await fakeSystemctl("success"); // the scope exited some other way — a plain kill, not the kernel's OOM killer
  await run("killed");
  const turn = await finished("killed");
  expect(turn.failed).toBe(true);
  expect(turn.response).not.toContain("out of memory");
  const entry = ledger.all().at(-1);
  expect(entry?.errorKind).not.toBe("oom");
});

test("a custom agentMemoryMaxGb is reflected in both the wrapped command and the OOM message", async () => {
  await fakeSystemctl("oom-kill");
  const wt = join(dir, "custom");
  await mkdir(wt, { recursive: true });
  await agent.runAgent(wt, "go", { repo: "r", branch: "custom", provider: "claude", memoryMaxGb: 8 });
  const turn = await finished("custom");
  expect(turn.response).toContain("8 GB");
});

// The limit that killed a run (cgroup.oomCause): an `oom` counter in memory.events.local that rose
// while the run was alive names it, so a slice OOM is not a bare "exit 137".
async function fakeClaude(script: string): Promise<void> {
  await writeFile(join(shim, "claude"), `#!/bin/sh\n${script}\n`);
  await chmod(join(shim, "claude"), 0o755);
}

test("killed while the agents' slice hit its own limit: the error names the slice", async () => {
  await fakeSystemctl("oom-kill");
  await fakeClaude(`echo 'oom 1' > "${agentsEvents()}"; kill -9 $$`);
  await run("slice-oom");
  expect((await finished("slice-oom")).response).toBe("out of memory: agents slice limit (2 GB, all agent runs together)");
});

test("killed while the user slice hit a limit, the scope itself fine: still named", async () => {
  await fakeSystemctl("success");
  await fakeClaude(`echo 'oom 1' > "${userEvents()}"; kill -9 $$`);
  await run("user-oom");
  expect((await finished("user-oom")).response).toContain("out of memory: user slice limit");
});

test("a run that ends but had a process OOM-killed (a git push hook's build) gets a note", async () => {
  await fakeSystemctl("oom-kill");
  await fakeClaude(`printf '{"type":"result","subtype":"success","result":"done","is_error":false}'`);
  await run("hook-oom");
  const turn = await finished("hook-oom");
  expect(turn.failed).toBeUndefined();
  expect(turn.response).toContain("a process of this run was killed — out of memory (4 GB ceiling)");
  expect(turn.response).toContain("check that the push happened");
});
