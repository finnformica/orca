// deploy/autodeploy.sh against a scratch "origin" + "box checkout" repo pair, with systemd, bun
// and the orchestrator/config HTTP calls stubbed on PATH (helpers.ts PATH-shim style). `sudo` is
// also a trivial passthrough shim here — the script's own privilege model (deploy/
// orca-autodeploy.sudoers) is a production concern, not something this hermetic test exercises.
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../server/run";

const SCRIPT = join(import.meta.dir, "../deploy/autodeploy.sh");

async function makeOrigin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-origin-"));
  await run(["git", "init", "-q", "-b", "main", dir]);
  await run(["git", "-C", dir, "config", "user.email", "test@orca.dev"]);
  await run(["git", "-C", dir, "config", "user.name", "Orca Test"]);
  // advanceOrigin pushes a new commit onto this repo's checked-out `main` from a second clone.
  await run(["git", "-C", dir, "config", "receive.denyCurrentBranch", "ignore"]);
  await writeFile(join(dir, "README.md"), "# scratch\n");
  await run(["git", "-C", dir, "add", "."]);
  await run(["git", "-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

async function cloneBox(origin: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-box-"));
  await run(["git", "clone", "-q", origin, dir]);
  await run(["git", "-C", dir, "config", "user.email", "test@orca.dev"]);
  await run(["git", "-C", dir, "config", "user.name", "Orca Test"]);
  return dir;
}

/** Push a new commit to `origin` via a throwaway second clone, and return its sha. */
async function advanceOrigin(origin: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "orca-push-"));
  await run(["git", "clone", "-q", origin, scratch]);
  await run(["git", "-C", scratch, "config", "user.email", "test@orca.dev"]);
  await run(["git", "-C", scratch, "config", "user.name", "Orca Test"]);
  await writeFile(join(scratch, "CHANGED.md"), "new\n");
  await run(["git", "-C", scratch, "add", "."]);
  await run(["git", "-C", scratch, "commit", "-q", "-m", "change"]);
  await run(["git", "-C", scratch, "push", "-q", "origin", "main"]);
  return (await run(["git", "-C", scratch, "rev-parse", "HEAD"])).trim();
}

const headOf = async (repo: string) => (await run(["git", "-C", repo, "rev-parse", "HEAD"])).trim();

/** A PATH dir with sudo (passthrough), systemctl, bun and curl shims, driven entirely by args/env
 *  so each test controls behaviour without touching the real binaries of the same name. Each step
 *  appends a marker to `trace` so a test can assert ordering (pull happens for real, via git — its
 *  completion is inferred from ORCA_TEST_EXPECT_HEAD already matching inside the bun shim). */
async function makeShimDir(opts: { trace: string; bunExit?: number; orchestratorRunning?: boolean }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-ad-shim-"));
  const { trace, bunExit = 0, orchestratorRunning = false } = opts;

  // A passthrough that tolerates the one flag autodeploy.sh passes (-n): skip it, then exec the
  // real command so the systemctl/bun/curl shims below are what actually run.
  await writeFile(join(dir, "sudo"), `#!/bin/sh\n[ "$1" = "-n" ] && shift\nexec "$@"\n`);

  await writeFile(
    join(dir, "systemctl"),
    [
      "#!/bin/sh",
      'if [ "$1 $2" = "restart orca" ]; then',
      `  grep -q bun-build-ok "${trace}" 2>/dev/null && echo build-before-restart >> "${trace}"`,
      `  echo systemctl-restart >> "${trace}"`,
      "  exit 0",
      "fi",
      "exit 1",
    ].join("\n") + "\n",
  );

  await writeFile(
    join(dir, "bun"),
    [
      "#!/bin/sh",
      'if [ "$1 $2" = "run build" ]; then',
      `  if [ -n "\${ORCA_TEST_EXPECT_HEAD:-}" ]; then`,
      '    actual="$(git -C "$ORCA_TEST_REPO" rev-parse HEAD)"',
      `    [ "\${actual}" = "\${ORCA_TEST_EXPECT_HEAD}" ] && echo pull-before-build >> "${trace}"`,
      "  fi",
      `  echo bun-build-ran >> "${trace}"`,
      `  exit ${bunExit}`,
      "fi",
      "exit 1",
    ].join("\n") + "\n",
  );
  if (bunExit === 0) {
    // Only a successful build is allowed to unlock the restart — append its "ok" marker from a
    // second line the script itself never calls, kept simple by writing it straight into the shim.
    await writeFile(
      join(dir, "bun"),
      [
        "#!/bin/sh",
        'if [ "$1 $2" = "run build" ]; then',
        `  if [ -n "\${ORCA_TEST_EXPECT_HEAD:-}" ]; then`,
        '    actual="$(git -C "$ORCA_TEST_REPO" rev-parse HEAD)"',
        `    [ "\${actual}" = "\${ORCA_TEST_EXPECT_HEAD}" ] && echo pull-before-build >> "${trace}"`,
        "  fi",
        `  echo bun-build-ran >> "${trace}"`,
        `  echo bun-build-ok >> "${trace}"`,
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n") + "\n",
    );
  }

  const orchBody = orchestratorRunning ? '{"running":true}' : '{"running":false}';
  await writeFile(
    join(dir, "curl"),
    [
      "#!/bin/sh",
      // the URL is always the final argument in the two calls autodeploy.sh makes
      'for a in "$@"; do url="$a"; done',
      'case "$url" in',
      `  *api/orchestrator) printf '%s' '${orchBody}' ;;`,
      "  *api/config) printf '200' ;;",
      "  *) echo \"fake-curl: unhandled $*\" >&2; exit 1 ;;",
      "esac",
    ].join("\n") + "\n",
  );

  for (const bin of ["sudo", "systemctl", "bun", "curl"]) await chmod(join(dir, bin), 0o755);
  return dir;
}

async function runScript(env: Record<string, string>): Promise<{ code: number; log: string }> {
  const p = Bun.spawn(["bash", SCRIPT], { env: { ...process.env, ...env }, stdout: "ignore", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0 && code !== 1) throw new Error(`unexpected exit ${code}: ${await new Response(p.stderr).text()}`);
  let log = "";
  try {
    log = await readFile(join(env.ORCA_STATE_DIR!, "autodeploy.log"), "utf8");
  } catch {
    /* no log yet */
  }
  return { code, log };
}

async function setup() {
  const origin = await makeOrigin();
  const box = await cloneBox(origin);
  const state = await mkdtemp(join(tmpdir(), "orca-ad-state-"));
  const trace = join(await mkdtemp(join(tmpdir(), "orca-ad-trace-")), "trace.log");
  await writeFile(trace, "");
  return { origin, box, state, trace };
}

const baseEnv = (box: string, state: string, shimDir: string) => ({
  ORCA_REPO: box,
  ORCA_STATE_DIR: state,
  ORCA_BRIDGE_URL: "http://127.0.0.1:8787",
  PATH: `${shimDir}:${process.env.PATH}`,
});

test("up to date: no-op, no build, no restart", async () => {
  const { box, state, trace } = await setup();
  const shim = await makeShimDir({ trace });
  const { log } = await runScript(baseEnv(box, state, shim));
  expect(log).toContain("up to date");
  expect(await readFile(trace, "utf8")).toBe("");
});

test("behind + busy (a live agent lease): deferred, no pull, no build, no restart", async () => {
  const { origin, box, state, trace } = await setup();
  await advanceOrigin(origin);
  await mkdir(join(state, "leases"), { recursive: true });
  await writeFile(join(state, "leases", "x.json"), JSON.stringify({ pid: process.pid }));
  const shim = await makeShimDir({ trace });
  const headBefore = await headOf(box);

  const { log } = await runScript(baseEnv(box, state, shim));
  expect(log).toContain("deferred: busy");
  expect(await readFile(trace, "utf8")).toBe("");
  expect(await headOf(box)).toBe(headBefore);
});

test("behind + busy (orchestrator mid-wake): deferred", async () => {
  const { origin, box, state, trace } = await setup();
  await advanceOrigin(origin);
  const shim = await makeShimDir({ trace, orchestratorRunning: true });
  const { log } = await runScript(baseEnv(box, state, shim));
  expect(log).toContain("deferred: busy");
  expect(await readFile(trace, "utf8")).toBe("");
});

test("behind + idle: pull, build, restart in that order", async () => {
  const { origin, box, state, trace } = await setup();
  const newHead = await advanceOrigin(origin);
  const shim = await makeShimDir({ trace });

  const { log } = await runScript({ ...baseEnv(box, state, shim), ORCA_TEST_REPO: box, ORCA_TEST_EXPECT_HEAD: newHead });

  expect(log).toContain(`deployed ${newHead.slice(0, 12)}`);
  expect(await headOf(box)).toBe(newHead);
  expect((await readFile(trace, "utf8")).trim().split("\n")).toEqual([
    "pull-before-build",
    "bun-build-ran",
    "bun-build-ok",
    "build-before-restart",
    "systemctl-restart",
  ]);
});

test("build fails: no restart, old build keeps serving, failure logged", async () => {
  const { origin, box, state, trace } = await setup();
  await advanceOrigin(origin);
  const shim = await makeShimDir({ trace, bunExit: 1 });

  const { log } = await runScript(baseEnv(box, state, shim));
  expect(log).toContain("build failed, not restarting");
  const traceContent = await readFile(trace, "utf8");
  expect(traceContent).toContain("bun-build-ran");
  expect(traceContent).not.toContain("systemctl-restart");
});
