// The Usage card's hover switch: take a hydra login out of its rotation, or put it back, from
// `setProfileEnabled` (server/usage.ts) — `hydra enable|disable <name>`, refusing a name hydra
// doesn't currently report. Driven through the real module with a fake `hydra` on PATH (the same
// PATH-shim pattern as tests/hydraUsage.test.ts), whose `status --json` reflects the last
// enable/disable it was told to run, so the refreshed list in the response is genuinely refreshed.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProfileEnabled } from "../server/usage";

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
  await writeFile(join(shim, "state"), "ok");
  await writeFile(join(shim, "calls.log"), "");
  await writeFile(join(shim, "hydra"), `#!/bin/sh
DIR="${shim}"
case "$1 $2" in
  "status --json") cat "$DIR/status.$(cat "$DIR/state")" ;;
esac
case "$1" in
  enable) echo "enable $2" >> "$DIR/calls.log"; echo ok > "$DIR/state" ;;
  disable) echo "disable $2" >> "$DIR/calls.log"; echo disabled > "$DIR/state" ;;
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
