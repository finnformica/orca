// The Usage card's hover switch: take a hydra login out of its rotation, or put it back, from
// `setProfileEnabled` (server/usage.ts) — `hydra enable|disable <name>`, refusing a name hydra
// doesn't currently report. Driven through the real module with a fake `hydra` on PATH (the same
// PATH-shim pattern as tests/hydraUsage.test.ts), whose `status --json` reflects the last
// enable/disable it was told to run, so the refreshed list in the response is genuinely refreshed.
// `refreshProfile` (the Stale row's fix) is driven the same way: a fake `hydra refresh NAME --force`
// clears the login's "token stale" state, same validation and shape as setProfileEnabled. Its token is
// simulated (`token`: valid / expired / dead / 429): `refresh` answers the way hydra's does for it,
// and `exec` — the renew launch — logs its argv, cwd and CLAUDE_CONFIG_DIR and renews an expired one.
// No real claude is ever launched.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshProfile, renewStaleLogins, setProfileEnabled } from "../server/usage";

let shim: string | undefined;
let prevPath: string | undefined;
afterEach(async () => {
  if (prevPath !== undefined) process.env.PATH = prevPath;
  prevPath = undefined;
  if (shim) await rm(shim, { recursive: true, force: true });
  shim = undefined;
});

const PROFILE = (state: string) => `{"profiles":[{"name":"work","dir":"/d","email":"w@x","signed_in":true,"disabled":false,"fetched_at":0,"source":"api","auth":"ok","locked":false,"session":{"pct":10,"resets":1000,"severity":"normal"},"weekly":{"pct":5,"resets":1000,"severity":"normal"},"fable":null,"state":"${state}"}]}`;

/** A fake `hydra` whose `status --json` reports "work" as disabled once `disable work` has run
 *  (and "ok" again after `enable work`) — so a caller re-reading status after the toggle sees it
 *  actually took effect, the same as the real CLI. Every enable/disable call is appended to a log. */
async function installFakeHydra(): Promise<void> {
  shim = await mkdtemp(join(tmpdir(), "orca-hydra-profile-"));
  await writeFile(join(shim, "status.ok"), PROFILE("ok"));
  await writeFile(join(shim, "status.disabled"), PROFILE("disabled"));
  await writeFile(join(shim, "status.stale"), PROFILE("token stale — refreshes on next launch"));
  await writeFile(join(shim, "state"), "ok");
  await writeFile(join(shim, "calls.log"), "");
  await writeFile(join(shim, "token"), "valid");
  await writeFile(join(shim, "hydra"), `#!/bin/sh
DIR="${shim}"
case "$1 $2" in
  "status --json") cat "$DIR/status.$(cat "$DIR/state")" ;;
esac
case "$1" in
  enable) echo "enable $2" >> "$DIR/calls.log"; echo ok > "$DIR/state" ;;
  disable) echo "disable $2" >> "$DIR/calls.log"; echo disabled > "$DIR/state" ;;
  refresh) echo "refresh $2 $3" >> "$DIR/calls.log"
    case "$(cat "$DIR/token")" in
      valid) echo ok > "$DIR/state"; printf '%-12s ok\\n' "$2" ;;
      429) printf '%-12s rate-limited\\n' "$2" ;;
      *) echo stale > "$DIR/state"; printf '%-12s stale\\n' "$2" ;;
    esac ;;
  exec) shift; echo "exec $*" >> "$DIR/calls.log"; echo "$PWD" > "$DIR/exec.cwd"; echo "\${CLAUDE_CONFIG_DIR-unset}" > "$DIR/exec.ccd"
    case "$(cat "$DIR/token")" in expired) echo valid > "$DIR/token"; exit 0 ;; dead) exit 1 ;; esac ;;
esac
`);
  await chmod(join(shim, "hydra"), 0o755);
  prevPath = process.env.PATH;
  process.env.PATH = `${shim}:${prevPath}`;
}

test("disable/enable are invoked with the right name, and the returned list reflects the toggle", async () => {
  await installFakeHydra();
  const disabled = await setProfileEnabled("work", false);
  expect(await readFile(join(shim!, "calls.log"), "utf8")).toBe("disable work\n");
  expect(disabled.find((p) => p.name === "work")?.state).toBe("disabled");

  const enabled = await setProfileEnabled("work", true);
  expect(await readFile(join(shim!, "calls.log"), "utf8")).toBe("disable work\nenable work\n");
  expect(enabled.find((p) => p.name === "work")?.state).toBe("ok");
});

test("a name hydra doesn't currently report is refused without ever shelling out to enable/disable", async () => {
  await installFakeHydra();
  await expect(setProfileEnabled("nope", false)).rejects.toThrow(/"nope" is not a hydra login/);
  expect(await readFile(join(shim!, "calls.log"), "utf8")).toBe(""); // never invoked
});

test("no hydra on PATH refuses up front", async () => {
  const empty = await mkdtemp(join(tmpdir(), "orca-nohydra-"));
  prevPath = process.env.PATH;
  process.env.PATH = empty;
  try {
    await expect(setProfileEnabled("work", false)).rejects.toThrow(/hydra is not installed/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("refresh --force is invoked with the right name, and the returned list is no longer stale", async () => {
  await installFakeHydra();
  await writeFile(join(shim!, "state"), "stale");
  const refreshed = await refreshProfile("work");
  expect(await readFile(join(shim!, "calls.log"), "utf8")).toBe("refresh work --force\n");
  expect(refreshed.find((p) => p.name === "work")?.state).toBe("ok");
});

test("refresh refuses a name hydra doesn't currently report, without ever shelling out", async () => {
  await installFakeHydra();
  await expect(refreshProfile("nope")).rejects.toThrow(/"nope" is not a hydra login/);
  expect(await readFile(join(shim!, "calls.log"), "utf8")).toBe(""); // never invoked
});

test("refresh refuses up front with no hydra on PATH", async () => {
  const empty = await mkdtemp(join(tmpdir(), "orca-nohydra-refresh-"));
  prevPath = process.env.PATH;
  process.env.PATH = empty;
  try {
    await expect(refreshProfile("work")).rejects.toThrow(/hydra is not installed/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

const RENEW_ARGS = "exec work -p --model haiku --tools  --strict-mcp-config --disable-slash-commands --no-session-persistence ok";

test("stale → renew → ok: a lapsed access token is renewed by one minimal launch under the login, from an empty temp dir", async () => {
  await installFakeHydra();
  await writeFile(join(shim!, "state"), "stale");
  await writeFile(join(shim!, "token"), "expired");
  const prevDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/somewhere/else"; // hydra exec would ignore the login with it set
  try {
    const refreshed = await refreshProfile("work");
    expect(refreshed.find((p) => p.name === "work")?.state).toBe("ok");
  } finally {
    if (prevDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevDir;
  }
  expect(await readFile(join(shim!, "calls.log"), "utf8")).toBe(`refresh work --force\n${RENEW_ARGS}\nrefresh work --force\n`);
  expect((await readFile(join(shim!, "exec.ccd"), "utf8")).trim()).toBe("unset");
  const cwd = (await readFile(join(shim!, "exec.cwd"), "utf8")).trim();
  expect(cwd).toContain("orca-renew-"); // a fresh temp dir — never a repo, so no CLAUDE.md
  expect(cwd.startsWith(process.cwd())).toBe(false);
  expect(await Bun.file(cwd).exists()).toBe(false); // and removed afterwards
});

test("renew fails → the error says to run hydra login, naming the host", async () => {
  await installFakeHydra();
  await writeFile(join(shim!, "state"), "stale");
  await writeFile(join(shim!, "token"), "dead");
  await expect(refreshProfile("work", { host: "cloud" })).rejects.toThrow('Still stale after renewing — the refresh token itself has expired. Run "hydra login work" on cloud.');
  expect(await readFile(join(shim!, "calls.log"), "utf8")).toBe(`refresh work --force\n${RENEW_ARGS}\nrefresh work --force\n`);
});

test("a mocked launcher that renews nothing leaves the login stale → the hydra login message", async () => {
  await installFakeHydra();
  await writeFile(join(shim!, "state"), "stale");
  await writeFile(join(shim!, "token"), "expired");
  const renewed: string[] = [];
  await expect(refreshProfile("work", { renew: async (n) => { renewed.push(n); return true; } })).rejects.toThrow(/hydra login work/);
  expect(renewed).toEqual(["work"]);
});

test("429 → a rate-limited message, not the stale one, and no renew launch", async () => {
  await installFakeHydra();
  await writeFile(join(shim!, "state"), "stale");
  await writeFile(join(shim!, "token"), "429");
  const renewed: string[] = [];
  await expect(refreshProfile("work", { renew: async (n) => { renewed.push(n); return true; } })).rejects.toThrow(/rate-limiting work \(429\)/);
  expect(renewed).toEqual([]);
});

test("background renew runs only on the primary, and only for enabled stale logins", async () => {
  await installFakeHydra();
  const stale = JSON.parse(PROFILE("token stale — refreshes on next launch"));
  const off = { ...stale.profiles[0], name: "off", email: "o@x", disabled: true, state: "disabled" };
  const fine = { ...stale.profiles[0], name: "fine", email: "f@x", state: "ok" };
  await writeFile(join(shim!, "status.stale"), JSON.stringify({ profiles: [stale.profiles[0], off, fine] }));
  await writeFile(join(shim!, "state"), "stale");
  await writeFile(join(shim!, "token"), "expired");
  const renewed: string[] = [];
  const renew = async (n: string) => { renewed.push(n); await writeFile(join(shim!, "token"), "valid"); return true; };

  expect(await renewStaleLogins(() => false, { renew })).toEqual([]); // a secondary does nothing at all
  expect(renewed).toEqual([]);
  expect(await readFile(join(shim!, "calls.log"), "utf8")).toBe("");

  expect(await renewStaleLogins(() => true, { renew })).toEqual([{ name: "work", ok: true }]);
  expect(renewed).toEqual(["work"]); // not the disabled login, not the healthy one
  expect(await readFile(join(shim!, "calls.log"), "utf8")).toBe("refresh work --force\nrefresh work --force\n");
});
