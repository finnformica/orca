// Attachments across instances (server/attachments.ts): an upload is stored in the shared database
// and answered as a reference; whichever instance launches the run writes the file into ITS OWN
// state dir and the agent gets that real path. Two state dirs stand in for the laptop and the box.
// Legacy messages holding a plain host path keep working where the file exists and say so where it
// doesn't. Real Postgres, a fake `claude` on PATH that records the prompt it was given.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import { AttachmentTooLarge, MAX_ATTACHMENT_BYTES, resolvePrompt, store } from "../server/attachments";
import { attachmentRefs, withAttachments, withoutAttachmentList } from "../web/src/workstream";
import { makeScratchRepo } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

let laptop: string;
let box: string;
let shim: string;
let repo: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};

beforeEach(async () => {
  prev = { ORCA_STATE_DIR: process.env.ORCA_STATE_DIR, ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, PATH: process.env.PATH };
  laptop = await mkdtemp(join(tmpdir(), "orca-att-laptop-"));
  box = await mkdtemp(join(tmpdir(), "orca-att-box-"));
  shim = await mkdtemp(join(tmpdir(), "orca-att-claude-"));
  repo = await makeScratchRepo();
  process.env.PATH = `${shim}:${prev.PATH}`;
  pg = await freshSchema("attachments");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [laptop, box, shim, repo]) await rm(d, { recursive: true, force: true });
});

const png = (n = 64) => new File([new Uint8Array(n).map((_, i) => i % 251)], "Screen Shot 1.png", { type: "image/png" });
const listed = (prompt: string) => prompt.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));

test("uploaded on the laptop, materialised on the box: a reference, not a host path, and the same bytes", async () => {
  process.env.ORCA_STATE_DIR = laptop;
  const [ref] = await store([png()]);
  expect(ref).toMatch(/^orca-attachment:\/\/[0-9a-f-]{36}\/Screen-Shot-1\.png$/);

  process.env.ORCA_STATE_DIR = box; // the message reaches the other instance
  const [path] = listed(await resolvePrompt(withAttachments("what's wrong here?", [ref!])));
  expect(path!.startsWith(join(box, "attachments"))).toBe(true);
  expect(new Uint8Array(await readFile(path!))).toEqual(new Uint8Array(await png().arrayBuffer()));

  // Cached by id: once on disk here, the database isn't needed again.
  await db.withRetry((sql) => sql`DELETE FROM attachment`);
  expect(listed(await resolvePrompt(withAttachments("again", [ref!])))).toEqual([path!]);
  // A reference the database no longer has (pruned) is noted, not handed over as a dead path.
  process.env.ORCA_STATE_DIR = laptop;
  expect(listed(await resolvePrompt(withAttachments("x", [ref!])))[0]).toContain("(unavailable on this machine");
});

test("a run launched on the box gets the box's local path in its prompt (queued, proxied and forwarded messages all launch here)", async () => {
  process.env.ORCA_STATE_DIR = laptop;
  const [ref] = await store([png()]);
  process.env.ORCA_STATE_DIR = box;
  const seen = join(shim, "prompt.txt");
  await writeFile(join(shim, "claude"), `#!/bin/sh\nfor a; do last="$a"; done\nprintf '%s' "$last" > ${seen}\nprintf '{"type":"result","subtype":"success","result":"ok","is_error":false}'\n`);
  await chmod(join(shim, "claude"), 0o755);
  await agent.runAgent(repo, withAttachments("look at this", [ref!]), { repo: "r", branch: "feat", provider: "claude", instruction: "look at this" });
  for (let i = 0; i < 200 && agent.isRunning(repo); i++) await new Promise((r) => setTimeout(r, 25));
  const prompt = await readFile(seen, "utf8");
  expect(prompt).not.toContain("orca-attachment://");
  const [path] = listed(prompt);
  expect(path!.startsWith(join(box, "attachments"))).toBe(true);
  expect((await readFile(path!)).byteLength).toBe(64);
});

test("legacy messages with a plain path: kept when the file is here, reduced to its name and marked unavailable when it isn't", async () => {
  process.env.ORCA_STATE_DIR = box;
  const here = join(box, "legacy.png");
  await writeFile(here, "x");
  const gone = "/var/folders/xy/T/orca-attachments/1234.png";
  const out = await resolvePrompt(withAttachments("see - /not/a/list/item", [here, gone]));
  expect(out.startsWith("see - /not/a/list/item")).toBe(true);
  const [a, b] = listed(out);
  expect(a).toBe(here);
  // Only the name: another machine's temp path must never reach the agent.
  expect(b).toStartWith("1234.png (unavailable on this machine");
  expect(out).not.toContain("/var/folders");
  expect(await resolvePrompt("no attachments at all")).toBe("no attachments at all");
});

test("a file over the cap refuses the whole upload and stores nothing", async () => {
  process.env.ORCA_STATE_DIR = laptop;
  const big = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "huge.bin");
  await expect(store([png(), big])).rejects.toBeInstanceOf(AttachmentTooLarge);
  const rows = await db.withRetry((sql) => sql`SELECT count(*)::int AS n FROM attachment`);
  expect((rows as { n: number }[])[0]!.n).toBe(0);
});

test("attachments older than 30 days are pruned by the writer", async () => {
  const now = Date.now();
  await db.addAttachment({ id: "11111111-1111-1111-1111-111111111111", filename: "old.png", mimeType: "image/png", bytes: new Uint8Array([1]) }, now - db.ATTACHMENT_RETENTION_MS - 1000);
  await db.addAttachment({ id: "22222222-2222-2222-2222-222222222222", filename: "new.png", mimeType: "image/png", bytes: new Uint8Array([2]) }, now);
  expect(await db.attachment("11111111-1111-1111-1111-111111111111")).toBeUndefined();
  expect(await db.attachment("22222222-2222-2222-2222-222222222222")).toMatchObject({ filename: "new.png", mimeType: "image/png", bytes: new Uint8Array([2]) });
});

test("the attachment migration is idempotent: re-running it on a migrated database is a no-op", async () => {
  const step = db.MIGRATIONS.find((s) => s.name === "attachment")!;
  expect(step.idempotent).toBe(true);
  await db.addAttachment({ id: "33333333-3333-3333-3333-333333333333", filename: "a.png", mimeType: "image/png", bytes: new Uint8Array([3]) });
  await db.withRetry((sql) => sql.unsafe(step.sql));
  expect(await db.attachment("33333333-3333-3333-3333-333333333333")).toBeDefined();
});

test("the chat's view of a message: its references parsed, the attachment list dropped from the text", () => {
  const ref = "orca-attachment://44444444-4444-4444-4444-444444444444/Screen-Shot.png";
  const sent = withAttachments("what's wrong here?", [ref, ref, "/tmp/legacy.txt"]);
  expect(attachmentRefs(sent)).toEqual([{ id: "44444444-4444-4444-4444-444444444444", name: "Screen-Shot.png" }]);
  expect(withoutAttachmentList(sent)).toBe("what's wrong here?");
  // The orchestrator joins a wake's messages with a blank line: only the list goes, the rest stays.
  expect(withoutAttachmentList(`${sent}\n\n⚙ worker report`)).toBe("what's wrong here?\n\n⚙ worker report");
  expect(withoutAttachmentList("no files")).toBe("no files");
});
