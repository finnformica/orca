// Orca's secrets (server/env.ts ORCA_SECRETS) never reach a process that runs code Orca doesn't own:
// a preview's dev server and its onStop, a provider session asked for a PR body, the screenshot
// browser, git (whose hooks live in an agent-edited worktree). Each is driven for real, with a
// stand-in binary that writes its environment to a file. Orca's OWN preview still gets its
// database URL — scripts/preview-orca.sh reads it from its install's `.env`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ORCA_SECRETS, agentEnv, scrubbedEnv, WORKER_BIN } from "../server/env";
import * as preview from "../server/preview";
import { describePr } from "../server/agent";
import { cdpLaunch } from "../server/screenshot";
import { run, runCmd } from "../server/run";

const dir = mkdtempSync(join(tmpdir(), "orca-env-scrub-"));
const SECRET = "s3cret-value";
const saved: Record<string, string | undefined> = {};
const KEYS = [...ORCA_SECRETS, "PATH", "ORCA_STATE_DIR"];

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of ORCA_SECRETS) process.env[k] = SECRET;
  process.env.ORCA_STATE_DIR = join(dir, "state"); // the preview registry lands here, not the host's
});
afterAll(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

/** The KEY=value lines a stand-in wrote, as a map. */
const envOf = (file: string): Record<string, string> =>
  Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const expectScrubbed = (env: Record<string, string>) => {
  expect(env.PATH).toBeTruthy(); // the dump is real, not empty
  for (const k of ORCA_SECRETS) expect(env[k]).toBeUndefined();
};
async function waitFor(file: string): Promise<void> {
  for (let i = 0; i < 100 && !existsSync(file); i++) await Bun.sleep(50);
}

test("scrubbedEnv drops every secret, lays extra over, removes an undefined key, keeps a named one", () => {
  process.env.ORCA_SCRUB_PROBE = "x";
  try {
    const env = scrubbedEnv({ A: "1", ORCA_SCRUB_PROBE: undefined });
    for (const k of ORCA_SECRETS) expect(env[k]).toBeUndefined();
    expect(env.A).toBe("1");
    expect("ORCA_SCRUB_PROBE" in env).toBe(false);
    expect(scrubbedEnv({}, { keep: ["ORCA_DATABASE_URL"] }).ORCA_DATABASE_URL).toBe(SECRET);
    expect(agentEnv().PATH!.split(":")[0]).toBe(WORKER_BIN);
    for (const k of ORCA_SECRETS) expect(agentEnv()[k]).toBeUndefined();
  } finally { delete process.env.ORCA_SCRUB_PROBE; }
});

test("a preview service and its onStop run without Orca's secrets", async () => {
  const wt = join(dir, "wt");
  mkdirSync(wt, { recursive: true });
  await preview.start(wt, wt, [{ name: "web", command: "env > svc.env; sleep 30", onStop: "env > stop.env" }], [41000, 41999]);
  try {
    await waitFor(join(wt, "svc.env"));
    expectScrubbed(envOf(join(wt, "svc.env")));
  } finally { preview.stop(wt, true); }
  expectScrubbed(envOf(join(wt, "stop.env")));
});

test("a provider session asked for the PR body (commandOutput) runs without Orca's secrets", async () => {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nenv > "${join(dir, "claude.env")}"\necho '{"result":"Body"}'\n`);
  chmodSync(join(bin, "claude"), 0o755);
  process.env.PATH = `${bin}:${saved.PATH}`;
  try {
    expect(await describePr("claude", "describe it", { cwd: dir, resume: "sess-1" })).toBe("Body");
  } finally { process.env.PATH = saved.PATH; }
  const env = envOf(join(dir, "claude.env"));
  expectScrubbed(env);
  expect(env.PATH!.split(":")[0]).toBe(WORKER_BIN);
});

test("the screenshot browser is launched without Orca's secrets", async () => {
  const out = join(dir, "browser.env");
  const argv = ["sh", "-c", `env > "${out}"`]; // exits at once: cdpLaunch rejects "exited before it was ready"
  await expect(cdpLaunch(argv, { XDG_RUNTIME_DIR: "/run/x" }, "unit", new AbortController().signal)).rejects.toThrow("before it was ready");
  const env = envOf(out);
  expectScrubbed(env);
  expect(env.XDG_RUNTIME_DIR).toBe("/run/x"); // the scope env still rides along
});

test("git (and its hooks) run without Orca's secrets; runCmd times out and allows failure", async () => {
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  await run(["git", "init", "-q"], repo);
  writeFileSync(join(repo, ".git", "hooks", "pre-commit"), `#!/bin/sh\nenv > "${join(dir, "hook.env")}"\n`);
  chmodSync(join(repo, ".git", "hooks", "pre-commit"), 0o755);
  await run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], repo);
  expectScrubbed(envOf(join(dir, "hook.env")));
  expect((await runCmd(["sh", "-c", "exit 3"], { allowFail: true })).code).toBe(3);
  await expect(runCmd(["sleep", "5"], { timeoutMs: 100 })).rejects.toThrow("timed out");
});

test("Orca's own preview bridge still gets its database URL, from its install's .env", async () => {
  // A copy of the script in a stand-in install: <install>/scripts/preview-orca.sh beside <install>/.env.
  const install = join(dir, "install");
  mkdirSync(join(install, "scripts"), { recursive: true });
  copyFileSync(join(import.meta.dir, "..", "scripts", "preview-orca.sh"), join(install, "scripts", "preview-orca.sh"));
  writeFileSync(join(install, ".env"), `SLACK_TOKEN=nope\nexport ORCA_DATABASE_URL="postgres://box:5432/orca"\n`);
  // The worktree has no server/db.ts, so the script takes its forward-to-main path and execs `bun`:
  // a stand-in that records what it was given.
  const bin = join(dir, "fakebun");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "bun"), `#!/bin/sh\nenv > "${join(dir, "orca-preview.env")}"\n`);
  chmodSync(join(bin, "bun"), 0o755);
  const wt = join(dir, "orca-wt");
  mkdirSync(wt, { recursive: true });
  const proc = Bun.spawn(["bash", join(install, "scripts", "preview-orca.sh"), "41234"], {
    cwd: wt, env: scrubbedEnv({ PATH: `${bin}:${saved.PATH}` }), stdout: "ignore", stderr: "ignore",
  });
  await proc.exited;
  const env = envOf(join(dir, "orca-preview.env"));
  expect(env.ORCA_DATABASE_URL).toBe("postgres://box:5432/orca");
  expect(env.SLACK_TOKEN).toBeUndefined(); // only the database URL is read back
});
