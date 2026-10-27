// linkToWorktree copies node_modules in a CHILD process and awaits it, so the bridge keeps answering.
// 2026-10-27: a `spawnSync` cp of 2.5 GB on ext4 held the event loop for 5+ minutes; /api/health,
// `orca board` and every worker's API call hung. Here a fake slow `cp` on PATH stands in for that
// copy, and a server in this same process must answer while it runs. Linux only (macOS clones).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod, lstat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import * as git from "../server/git";

// node:http on both ends: the DOM preload replaces fetch and Response with happy-dom's.
const getText = (url: string) => new Promise<string>((resolve, reject) => {
  get(url, (res) => { let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve(body)); }).on("error", reject);
});

const linux = process.platform === "linux";
let dir: string, prevPath: string | undefined;

beforeAll(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "orca-async-copy-")));
  prevPath = process.env.PATH;
});
afterAll(async () => {
  process.env.PATH = prevPath;
  await rm(dir, { recursive: true, force: true });
});

test.if(linux)("the copy runs at low priority: ionice -c3 and nice -n 19 around cp, when the box has them", () => {
  const cmd = git.treeCopyCommand("/a", "/b", "linux")!;
  expect(cmd.slice(-5)).toEqual(["cp", "-a", "--reflink=auto", "/a", "/b"]);
  if (Bun.which("nice")) expect(cmd.join(" ")).toContain("nice -n 19 cp");
  if (Bun.which("ionice")) expect(cmd.slice(0, 2)).toEqual(["ionice", "-c3"]);
  expect(git.treeCopyCommand("/a", "/b", "win32")).toBeNull();
});

test.if(linux)("the server answers while a slow node_modules copy runs; the worktree gets its own tree", async () => {
  const realCp = Bun.which("cp")!;
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const niceLog = join(dir, "nice.txt");
  // The fake cp: record its niceness, wait 1.5 s, then copy for real.
  await writeFile(join(bin, "cp"), `#!/bin/sh\nnice > "${niceLog}"\nsleep 1.5\nexec "${realCp}" "$@"\n`);
  await chmod(join(bin, "cp"), 0o755);
  process.env.PATH = `${bin}:${prevPath}`;

  const repo = join(dir, "repo"), wt = join(dir, "wt");
  await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  await mkdir(wt, { recursive: true });

  const server = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    let done = false;
    const started = Date.now();
    const copy = git.linkToWorktree(repo, wt, ["node_modules"]).then(() => { done = true; });
    expect(await getText(`http://127.0.0.1:${port}/api/health`)).toBe("ok");
    expect(Date.now() - started).toBeLessThan(1_000); // answered at once, not after the copy
    expect(done).toBe(false); // the copy is still running
    await copy;
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400); // it really was the slow cp
  } finally {
    server.close();
  }
  // A real directory, not a symlink: each worktree gets its own tree (the isolation rule).
  expect((await lstat(join(wt, "node_modules"))).isSymbolicLink()).toBe(false);
  expect(await readFile(join(wt, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  if (Bun.which("nice")) expect((await readFile(niceLog, "utf8")).trim()).toBe("19");
});
