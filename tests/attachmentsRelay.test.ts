// Attachments across two REAL bridges (server/index.ts as subprocesses), one shared Postgres schema,
// two state dirs — the laptop (A, where the browser uploads) and the box (B, where the agent runs).
// Pins what Finn hit on main: an agent on the box was handed the laptop's temp path and couldn't open
// the screenshot. Now the upload goes into Postgres via A's real multipart route, B writes the file
// into ITS OWN state dir before the agent starts, and the prompt the CLI receives names that path —
// never a reference, never A's dir, never a /var/folders path. Covers a direct launch on B, the
// orchestratorOn proxy (a message sent to A, woken on B), the chat's view of the turn, and serving
// the bytes back from either instance.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import { freePort } from "../server/preview";
import { withAttachments } from "../web/src/workstream";
import { makeScratchRepo } from "./helpers";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const fetch = native.fetch; // happy-dom's preloaded fetch CORS-blocks a real port
const ROOT = join(import.meta.dir, "..");

let laptop: string, box: string, shim: string, repo: string, log: string;
let pg: TestDb;
let A: string, B: string;
const procs: Bun.Subprocess[] = [];

const PNG = new Uint8Array(200).map((_, i) => (i * 7) % 256);

async function bridge(name: string, state: string, port: number) {
  const env = { ...process.env, ORCA_STATE_DIR: state, ORCA_DATABASE_URL: pg.url, PATH: `${shim}:${process.env.PATH}`, ORCA_API_PORT: String(port), ORCA_BIND: "127.0.0.1", ORCA_INSTANCE: name, ORCA_ALLOW_WORKTREE_MIGRATIONS: "1" } as Record<string, string>;
  delete env.NODE_ENV;
  for (const k of ["ORCA_PREVIEW_HOST", "ORCA_PREVIEW_BIND", "SLACK_TOKEN"]) delete env[k];
  procs.push(Bun.spawn(["bun", "run", join(ROOT, "server", "index.ts")], { cwd: ROOT, env, stdout: "ignore", stderr: "inherit" }));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) return base; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${name} never came up`);
}

beforeAll(async () => {
  laptop = await mkdtemp(join(tmpdir(), "orca-relay-laptop-"));
  box = await mkdtemp(join(tmpdir(), "orca-relay-box-"));
  shim = await mkdtemp(join(tmpdir(), "orca-relay-claude-"));
  log = join(shim, "prompts.log");
  repo = await makeScratchRepo();
  // A fake claude that appends the prompt it was given (its last argument) to one log, then succeeds.
  await writeFile(join(shim, "claude"), `#!/bin/sh\nfor a; do last="$a"; done\nprintf '%s\\n<<END>>\\n' "$last" >> "${log}"\nprintf '{"type":"result","subtype":"success","result":"seen","is_error":false}'\n`);
  await chmod(join(shim, "claude"), 0o755);
  pg = await freshSchema("attrelay");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  const [pa, pb] = [await freePort([20_000, 40_000]), await freePort([40_001, 60_000])];
  A = `http://127.0.0.1:${pa}`; B = `http://127.0.0.1:${pb}`;
  await db.saveConfig({
    repos: [{ name: "r", config: { repoPath: repo, worktreeRoot: repo, baseBranch: "main", previewServices: [], providers: ["claude"] } }],
    app: { portRange: [30000, 40000], staleHours: 24, instances: { laptop: A, box: B }, orchestratorOn: "box" },
  });
  await db.close();
  await bridge("laptop", laptop, pa);
  await bridge("box", box, pb);
}, 60_000);

afterAll(async () => {
  for (const p of procs) p.kill();
  await db.close();
  await pg.drop();
  for (const d of [laptop, box, shim, repo]) await rm(d, { recursive: true, force: true });
});

/** POST files to the real multipart route, the body built the way a browser sends it (the happy-dom
 *  preload swaps in a FormData that Bun's own fetch can't serialize). */
async function upload(base: string, files: { name: string; type: string; bytes: Uint8Array }[]): Promise<Response> {
  const boundary = `----orca${crypto.randomUUID()}`;
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const f of files) {
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`), f.bytes, enc.encode("\r\n"));
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { body.set(p, at); at += p.byteLength; }
  return fetch(`${base}/api/attachments`, { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body });
}

/** The prompt the fake CLI received that contains `marker`. */
async function promptWith(marker: string): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const hit = existsSync(log) ? (await readFile(log, "utf8")).split("\n<<END>>\n").find((p) => p.includes(marker)) : undefined;
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no prompt containing ${marker}`);
}

const listed = (prompt: string) => prompt.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));

function assertBoxLocal(prompt: string) {
  expect(prompt).not.toContain("orca-attachment://");
  expect(prompt).not.toContain(laptop);
  expect(prompt).not.toContain("/var/folders");
}

test("uploaded through A's route, launched on B: B materialises the file first and the prompt names B's local path", async () => {
  const res = await upload(A, [{ name: "Screen Shot.png", type: "image/png", bytes: PNG }, { name: "notes.txt", type: "text/plain", bytes: new TextEncoder().encode("hello") }]);
  expect(res.status).toBe(200);
  const { paths: refs } = await res.json() as { paths: string[] };
  expect(refs).toHaveLength(2);
  for (const r of refs) expect(r).toStartWith("orca-attachment://"); // a reference, not A's host path
  expect(existsSync(join(laptop, "attachments"))).toBe(false); // the upload wrote nothing to A's disk

  const run = await fetch(`${B}/api/agent`, {
    method: "POST",
    body: JSON.stringify({ repo: "r", key: repo, worktree: repo, branch: "feat", action: "followup", instruction: "direct-launch: what's wrong here?", prompt: withAttachments("direct-launch: what's wrong here?", refs) }),
  }).then((r) => r.json());
  expect(run.status).toBe("running");

  const prompt = await promptWith("direct-launch");
  assertBoxLocal(prompt);
  const [png, txt] = listed(prompt);
  expect(png).toStartWith(join(box, "attachments"));
  expect(txt).toStartWith(join(box, "attachments"));
  // On disk before the agent started (the CLI was handed the path), with the uploaded bytes.
  expect(new Uint8Array(await readFile(png!))).toEqual(PNG);
  expect(await readFile(txt!, "utf8")).toBe("hello");

  // The chat's view: the turn carries its files (prompt blanked), and either instance serves them.
  for (let i = 0; i < 200 && !(await db.turns("r", "feat")).every((t) => t.finishedAt); i++) await new Promise((r) => setTimeout(r, 25));
  const { turns } = await fetch(`${A}/api/turns?repo=r&branch=feat&limit=50`).then((r) => r.json()) as { turns: { instruction: string; prompt: string; attachments?: { id: string; name: string }[] }[] };
  expect(turns[0]!.instruction).toBe("direct-launch: what's wrong here?");
  expect(turns[0]!.prompt).toBe("");
  expect(turns[0]!.attachments).toEqual([
    { id: refs[0]!.split("/")[2]!, name: "Screen-Shot.png" },
    { id: refs[1]!.split("/")[2]!, name: "notes.txt" },
  ]);
  for (const base of [A, B]) {
    const file = await fetch(`${base}/api/attachments/${turns[0]!.attachments![0]!.id}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
  }
  expect((await fetch(`${B}/api/attachments/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
});

test("an orchestrator message sent to A is proxied to B (orchestratorOn) and its wake prompt names B's local path", async () => {
  const { paths: [ref] } = await upload(A, [{ name: "bug.png", type: "image/png", bytes: PNG }]).then((r) => r.json()) as { paths: string[] };
  const sent = await fetch(`${A}/api/orchestrator/message`, { method: "POST", body: JSON.stringify({ text: "orchestrator-relay: look at this", attachments: [ref] }) });
  expect(sent.status).toBe(200);
  const prompt = await promptWith("orchestrator-relay");
  assertBoxLocal(prompt);
  const path = listed(prompt).find((l) => l.endsWith("bug.png"));
  expect(path).toStartWith(join(box, "attachments"));
  expect(new Uint8Array(await readFile(path!))).toEqual(PNG);
});

test("a file over 20 MB is refused by the route with a 413 and nothing is stored", async () => {
  const res = await upload(A, [{ name: "huge.bin", type: "application/octet-stream", bytes: new Uint8Array(20 * 1024 * 1024 + 1) }]);
  expect(res.status).toBe(413);
  expect((await res.json()).error).toContain("capped at 20 MB");
  const rows = await db.withRetry((sql) => sql`SELECT count(*)::int AS n FROM attachment WHERE filename = 'huge.bin'`);
  expect((rows as { n: number }[])[0]!.n).toBe(0);
});
