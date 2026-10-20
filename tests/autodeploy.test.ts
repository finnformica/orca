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

/** Like advanceOrigin, but the commit also touches package.json — the "a PR added a dependency"
 *  case that must trigger `bun install` on the box before the build. */
async function advanceOriginWithDeps(origin: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "orca-push-"));
  await run(["git", "clone", "-q", origin, scratch]);
  await run(["git", "-C", scratch, "config", "user.email", "test@orca.dev"]);
  await run(["git", "-C", scratch, "config", "user.name", "Orca Test"]);
  await writeFile(join(scratch, "package.json"), JSON.stringify({ name: "scratch", dependencies: { x: "1.0.0" } }));
  await run(["git", "-C", scratch, "add", "."]);
  await run(["git", "-C", scratch, "commit", "-q", "-m", "add dependency"]);
  await run(["git", "-C", scratch, "push", "-q", "origin", "main"]);
  return (await run(["git", "-C", scratch, "rev-parse", "HEAD"])).trim();
}

const headOf = async (repo: string) => (await run(["git", "-C", repo, "rev-parse", "HEAD"])).trim();

/** A PATH dir with sudo (passthrough), systemctl, bun and curl shims, driven entirely by args/env
 *  so each test controls behaviour without touching the real binaries of the same name. Each step
 *  appends a marker to `trace` so a test can assert ordering (pull happens for real, via git — its
 *  completion is inferred from ORCA_TEST_EXPECT_HEAD already matching inside the bun shim). */
async function makeShimDir(opts: {
  trace: string;
  bunExit?: number;
  installExit?: number;
  orchestratorRunning?: boolean;
  kickstartExit?: number;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-ad-shim-"));
  const { trace, bunExit = 0, installExit = 0, orchestratorRunning = false, kickstartExit = 0 } = opts;

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
      'if [ "$1 $2" = "install --frozen-lockfile" ]; then',
      `  echo bun-install-ran >> "${trace}"`,
      `  [ ${installExit} -eq 0 ] && echo bun-install-ok >> "${trace}"`,
      `  exit ${installExit}`,
      "fi",
      'if [ "$1 $2" = "run build" ]; then',
      `  if [ -n "\${ORCA_TEST_EXPECT_HEAD:-}" ]; then`,
      '    actual="$(git -C "$ORCA_TEST_REPO" rev-parse HEAD)"',
      `    [ "\${actual}" = "\${ORCA_TEST_EXPECT_HEAD}" ] && echo pull-before-build >> "${trace}"`,
      "  fi",
      `  echo bun-build-ran >> "${trace}"`,
      `  [ ${bunExit} -eq 0 ] && echo bun-build-ok >> "${trace}"`,
      `  exit ${bunExit}`,
      "fi",
      "exit 1",
    ].join("\n") + "\n",
  );

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

  // launchd mode's restart (a Mac). Records its args; the installer's bootstrap/bootout go here too.
  await writeFile(
    join(dir, "launchctl"),
    [
      "#!/bin/sh",
      'if [ "$1" = "kickstart" ]; then',
      `  grep -q bun-build-ok "${trace}" 2>/dev/null && echo build-before-restart >> "${trace}"`,
      `  echo "launchctl-kickstart $2 $3" >> "${trace}"`,
      `  exit ${kickstartExit}`,
      "fi",
      `echo "launchctl $*" >> "${trace}"`,
    ].join("\n") + "\n",
  );

  for (const bin of ["sudo", "systemctl", "bun", "curl", "launchctl"]) await chmod(join(dir, bin), 0o755);
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

test("behind + a live agent lease (not the orchestrator): proceeds — a worker lease is not busy", async () => {
  // agent.adoptLeases re-adopts a worker's run after a restart, so only an orchestrator wake
  // (checked separately below) should hold a deploy back.
  const { origin, box, state, trace } = await setup();
  const newHead = await advanceOrigin(origin);
  await mkdir(join(state, "leases"), { recursive: true });
  await writeFile(join(state, "leases", "x.json"), JSON.stringify({ pid: process.pid }));
  const shim = await makeShimDir({ trace });

  const { log } = await runScript({ ...baseEnv(box, state, shim), ORCA_TEST_REPO: box, ORCA_TEST_EXPECT_HEAD: newHead });
  expect(log).toContain(`deployed ${newHead.slice(0, 12)}`);
  expect(await headOf(box)).toBe(newHead);
});

test("behind + busy (orchestrator mid-wake): deferred", async () => {
  const { origin, box, state, trace } = await setup();
  await advanceOrigin(origin);
  const shim = await makeShimDir({ trace, orchestratorRunning: true });
  const { log } = await runScript(baseEnv(box, state, shim));
  expect(log).toContain("deferred: busy");
  expect(await readFile(trace, "utf8")).toBe("");
});

test.skipIf(!Bun.which("flock"))("behind + another deploy holds the deploy lock: deferred, no pull, no restart", async () => {
  // The lock also keeps the health watchdog (deploy/health-check.sh) off the bridge under a deploy.
  const { origin, box, state, trace } = await setup();
  const before = await headOf(box);
  await advanceOrigin(origin);
  const shim = await makeShimDir({ trace });
  await writeFile(join(state, "deploy.lock"), "");
  const holder = Bun.spawn(["flock", join(state, "deploy.lock"), "sleep", "2"]);
  await new Promise((r) => setTimeout(r, 200)); // let flock take the lock
  const { log } = await runScript(baseEnv(box, state, shim));
  await holder.exited;
  expect(log).toContain("deferred: another deploy holds");
  expect(await headOf(box)).toBe(before);
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

test("package.json changed: bun install runs before build and restart", async () => {
  const { origin, box, state, trace } = await setup();
  const newHead = await advanceOriginWithDeps(origin);
  const shim = await makeShimDir({ trace });

  const { log } = await runScript({ ...baseEnv(box, state, shim), ORCA_TEST_REPO: box, ORCA_TEST_EXPECT_HEAD: newHead });

  expect(log).toContain(`deployed ${newHead.slice(0, 12)}`);
  expect((await readFile(trace, "utf8")).trim().split("\n")).toEqual([
    "bun-install-ran",
    "bun-install-ok",
    "pull-before-build",
    "bun-build-ran",
    "bun-build-ok",
    "build-before-restart",
    "systemctl-restart",
  ]);
});

test("no dependency change: bun install is skipped", async () => {
  const { origin, box, state, trace } = await setup();
  await advanceOrigin(origin);
  const shim = await makeShimDir({ trace });

  await runScript(baseEnv(box, state, shim));
  expect(await readFile(trace, "utf8")).not.toContain("bun-install-ran");
});

test("bun install fails: no build, no restart, old build keeps serving, failure logged", async () => {
  const { origin, box, state, trace } = await setup();
  await advanceOriginWithDeps(origin);
  const shim = await makeShimDir({ trace, installExit: 1 });

  const { log } = await runScript(baseEnv(box, state, shim));
  expect(log).toContain("bun install failed, not restarting");
  const traceContent = await readFile(trace, "utf8");
  expect(traceContent).toContain("bun-install-ran");
  expect(traceContent).not.toContain("bun-build-ran");
  expect(traceContent).not.toContain("systemctl-restart");
});

// --- launchd mode: a Mac's own checkout (docs/SETUP.md "Local machine") ---

const localEnv = (box: string, state: string, shimDir: string) => ({
  ...baseEnv(box, state, shimDir),
  ORCA_AUTODEPLOY_MODE: "launchd",
  ORCA_LAUNCHD_LABEL: "dev.orca.bridge",
});
const uid = () => String(process.getuid?.() ?? 0);
const traceLines = async (trace: string) => (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean);

test("launchd: behind + idle: pull, build, then kickstart the bridge agent (never systemctl)", async () => {
  const { origin, box, state, trace } = await setup();
  const newHead = await advanceOrigin(origin);
  const shim = await makeShimDir({ trace });

  const { log } = await runScript({ ...localEnv(box, state, shim), ORCA_TEST_REPO: box, ORCA_TEST_EXPECT_HEAD: newHead });

  expect(log).toContain(`deployed ${newHead.slice(0, 12)}`);
  expect(await headOf(box)).toBe(newHead);
  expect(await traceLines(trace)).toEqual([
    "pull-before-build",
    "bun-build-ran",
    "bun-build-ok",
    "build-before-restart",
    `launchctl-kickstart -k gui/${uid()}/dev.orca.bridge`,
  ]);
});

test("launchd: up to date: no-op", async () => {
  const { box, state, trace } = await setup();
  const shim = await makeShimDir({ trace });
  const { log } = await runScript(localEnv(box, state, shim));
  expect(log).toContain("up to date");
  expect(await readFile(trace, "utf8")).toBe("");
});

test("launchd: checkout on another branch: skipped, nothing pulled, nothing restarted", async () => {
  const { origin, box, state, trace } = await setup();
  await advanceOrigin(origin);
  await run(["git", "-C", box, "checkout", "-q", "-b", "my-feature"]);
  const before = await headOf(box);
  const shim = await makeShimDir({ trace });

  const { code, log } = await runScript(localEnv(box, state, shim));
  expect(code).toBe(0);
  expect(log).toContain("skipped:");
  expect(log).toContain("on my-feature, not main");
  expect(await headOf(box)).toBe(before);
  expect(await readFile(trace, "utf8")).toBe("");
});

test("launchd: detached HEAD: skipped", async () => {
  const { origin, box, state, trace } = await setup();
  await advanceOrigin(origin);
  await run(["git", "-C", box, "checkout", "-q", "--detach"]);
  const shim = await makeShimDir({ trace });
  const { log } = await runScript(localEnv(box, state, shim));
  expect(log).toContain("on a detached HEAD, not main");
  expect(await readFile(trace, "utf8")).toBe("");
});

test("launchd: uncommitted change to a tracked file: skipped, the change is untouched", async () => {
  const { origin, box, state, trace } = await setup();
  await advanceOrigin(origin);
  const before = await headOf(box);
  await writeFile(join(box, "README.md"), "# my edit\n");
  const shim = await makeShimDir({ trace });

  const { log } = await runScript(localEnv(box, state, shim));
  expect(log).toContain("skipped:");
  expect(log).toContain("uncommitted changes");
  expect(await headOf(box)).toBe(before);
  expect(await readFile(join(box, "README.md"), "utf8")).toBe("# my edit\n");
  expect(await readFile(trace, "utf8")).toBe("");
});

test("launchd: an untracked file alone does not block a deploy", async () => {
  const { origin, box, state, trace } = await setup();
  const newHead = await advanceOrigin(origin);
  await writeFile(join(box, "scratch-notes.txt"), "mine\n");
  const shim = await makeShimDir({ trace });

  const { log } = await runScript(localEnv(box, state, shim));
  expect(log).toContain(`deployed ${newHead.slice(0, 12)}`);
  expect(await readFile(join(box, "scratch-notes.txt"), "utf8")).toBe("mine\n");
});

test("launchd: orchestrator mid-wake: deferred", async () => {
  const { origin, box, state, trace } = await setup();
  await advanceOrigin(origin);
  const shim = await makeShimDir({ trace, orchestratorRunning: true });
  const { log } = await runScript(localEnv(box, state, shim));
  expect(log).toContain("deferred: busy");
  expect(await readFile(trace, "utf8")).toBe("");
});

test("launchd: package.json changed: install, build, kickstart; no change: no install", async () => {
  const withDeps = await setup();
  await advanceOriginWithDeps(withDeps.origin);
  await runScript(localEnv(withDeps.box, withDeps.state, await makeShimDir({ trace: withDeps.trace })));
  const lines = await traceLines(withDeps.trace);
  expect(lines[0]).toBe("bun-install-ran");
  expect(lines.at(-1)).toStartWith("launchctl-kickstart");

  const noDeps = await setup();
  await advanceOrigin(noDeps.origin);
  await runScript(localEnv(noDeps.box, noDeps.state, await makeShimDir({ trace: noDeps.trace })));
  expect(await readFile(noDeps.trace, "utf8")).not.toContain("bun-install-ran");
});

test("launchd: failed install or build: no kickstart, failure logged", async () => {
  const install = await setup();
  await advanceOriginWithDeps(install.origin);
  const r1 = await runScript(localEnv(install.box, install.state, await makeShimDir({ trace: install.trace, installExit: 1 })));
  expect(r1.log).toContain("bun install failed, not restarting");
  expect(await readFile(install.trace, "utf8")).not.toContain("launchctl-kickstart");

  const build = await setup();
  await advanceOrigin(build.origin);
  const r2 = await runScript(localEnv(build.box, build.state, await makeShimDir({ trace: build.trace, bunExit: 1 })));
  expect(r2.log).toContain("build failed, not restarting");
  expect(await readFile(build.trace, "utf8")).not.toContain("launchctl-kickstart");
});

test("launchd: kickstart fails (agent not loaded): error logged, exit 1", async () => {
  const { origin, box, state, trace } = await setup();
  await advanceOrigin(origin);
  const shim = await makeShimDir({ trace, kickstartExit: 113 });
  const { code, log } = await runScript(localEnv(box, state, shim));
  expect(code).toBe(1);
  expect(log).toContain("error: launchctl kickstart of dev.orca.bridge failed");
});

// --- deploy/install-local-autodeploy.sh ---

const INSTALLER = join(import.meta.dir, "../deploy/install-local-autodeploy.sh");

test("installer: builds, writes both LaunchAgents, loads them; --uninstall removes them", async () => {
  const { box, state, trace } = await setup();
  await writeFile(join(box, ".env"), "ORCA_API_PORT=9911\n");
  const shim = await makeShimDir({ trace });
  const agents = await mkdtemp(join(tmpdir(), "orca-agents-"));
  const env = { ...process.env, ORCA_REPO: box, ORCA_STATE_DIR: state, ORCA_LAUNCH_AGENTS_DIR: agents, PATH: `${shim}:${process.env.PATH}` };

  const p = Bun.spawn(["bash", INSTALLER], { env, stdout: "ignore", stderr: "pipe" });
  expect(await p.exited).toBe(0);

  const bridge = await readFile(join(agents, "dev.orca.bridge.plist"), "utf8");
  expect(bridge).toContain("<string>server/index.ts</string>");
  expect(bridge).toContain(`<key>WorkingDirectory</key><string>${box}</string>`);
  expect(bridge).toContain("<key>KeepAlive</key><true/>");
  const deploy = await readFile(join(agents, "dev.orca.autodeploy.plist"), "utf8");
  expect(deploy).toContain(`<string>${box}/deploy/autodeploy.sh</string>`);
  expect(deploy).toContain("<key>ORCA_AUTODEPLOY_MODE</key><string>launchd</string>");
  expect(deploy).toContain("<key>ORCA_BRIDGE_URL</key><string>http://127.0.0.1:9911</string>");
  expect(deploy).toContain("<key>StartInterval</key><integer>60</integer>");
  // Neither agent carries the checkout's ORCA_* secrets: the bridge reads .env itself.
  expect(bridge).not.toContain("ORCA_");

  const lines = await traceLines(trace);
  expect(lines.indexOf("bun-build-ok")).toBeLessThan(lines.findIndex((l) => l.startsWith("launchctl bootstrap")));
  expect(lines).toContain(`launchctl bootstrap gui/${uid()} ${join(agents, "dev.orca.bridge.plist")}`);
  expect(lines).toContain(`launchctl bootstrap gui/${uid()} ${join(agents, "dev.orca.autodeploy.plist")}`);

  const u = Bun.spawn(["bash", INSTALLER, "--uninstall"], { env, stdout: "ignore", stderr: "pipe" });
  expect(await u.exited).toBe(0);
  expect(await Bun.file(join(agents, "dev.orca.bridge.plist")).exists()).toBe(false);
  expect(await Bun.file(join(agents, "dev.orca.autodeploy.plist")).exists()).toBe(false);
  expect(await traceLines(trace)).toContain(`launchctl bootout gui/${uid()}/dev.orca.autodeploy`);
});
