// `orca slack …` (server/slackTool.ts): read, search, post and the new `file` verb
// (docs/integrations/slack.md §7). Real Postgres for attachments (server/attachments.ts); Slack's
// Web API and the file's own download host are a stubbed global.fetch, keyed by URL. No real Slack.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import { ATTACHMENT_MAX_BYTES, resetSlackToolCache, SLACK_USAGE, SLACK_VERBS, slackTool } from "../server/slackTool";
import { freshSchema, type TestDb } from "./pg";

const API = "https://slack.com/api/";

type FakeRoute = (method: string, body: Record<string, unknown>) => unknown;

/** Slack's Web API (form or JSON body, `API + method`) plus whatever host a file's own download URL
 *  names — a single stubbed `fetch`, since both `slackRead`/`slackApi` and the file download call the
 *  global one directly. Everything not explicitly routed answers `{ ok: false }` (Slack's own shape
 *  for an unmocked method) or a 404. */
async function withSlack<T>(slack: Record<string, FakeRoute>, download: (url: string, init: RequestInit) => Response | Promise<Response>, body: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
    const u = String(url);
    if (u.startsWith(API)) {
      const method = u.slice(API.length);
      const route = slack[method];
      if (!route) return Response.json({ ok: false, error: `no fake route for ${method}` });
      const raw = typeof init.body === "string" ? init.body : "";
      const asJson = String((init.headers as Record<string, string> | undefined)?.["content-type"] ?? "").includes("json");
      const params = asJson ? (JSON.parse(raw || "{}") as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(raw));
      return Response.json(route(method, params));
    }
    return download(u, init);
  }) as typeof fetch;
  try { return await body(); } finally { globalThis.fetch = orig; }
}

let stateDir: string;
let pg: TestDb;
let prev: Record<string, string | undefined>;

beforeEach(async () => {
  prev = { ORCA_STATE_DIR: process.env.ORCA_STATE_DIR, ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL };
  stateDir = await mkdtemp(join(tmpdir(), "orca-slacktool-"));
  process.env.ORCA_STATE_DIR = stateDir;
  pg = await freshSchema("slacktool");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  resetSlackToolCache();
});
afterEach(async () => {
  await db.close();
  await pg.drop();
  await rm(stateDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const env = { SLACK_TOKEN: "xoxp-test" };
const FILE = { id: "F0123ABC", name: "invoice.pdf", mimetype: "application/pdf", size: 18, url_private_download: "https://files.slack.com/files-pri/T1-F1/invoice.pdf" };

test("SLACK_VERBS declares file as a read verb; it is in the usage text", () => {
  expect(SLACK_VERBS.file).toBe("read");
  expect(SLACK_USAGE).toContain("orca slack file <file id>");
});

test("read prints a message's files underneath it: id, name, mimetype, size", async () => {
  const out = await withSlack(
    {
      "conversations.history": () => ({ ok: true, messages: [{ type: "message", user: "U1", ts: "1700000000.000100", text: "see attached", files: [FILE] }] }),
      "users.info": () => ({ ok: false, error: "not_mocked" }),
    },
    () => new Response("never called", { status: 500 }),
    () => slackTool({ _: ["read", "C1"] }, { env }),
  );
  expect(out).toContain("see attached");
  expect(out).toContain("    file: F0123ABC · invoice.pdf · application/pdf · 1 KB");
});

test("search prints a match's files underneath it", async () => {
  const out = await withSlack(
    {
      "search.messages": () => ({ ok: true, messages: { matches: [{ ts: "1700000000.000100", text: "see attached", user: "U1", channel: { id: "C1", name: "eng" }, files: [FILE] }], total: 1 } }),
    },
    () => new Response("never called", { status: 500 }),
    () => slackTool({ _: ["search", "invoice"] }, { env }),
  );
  expect(out).toContain("see attached");
  expect(out).toContain("file: F0123ABC · invoice.pdf · application/pdf · 1 KB");
});

test("file: files.info then the download, stored as an Orca attachment; --out copies it too", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.4 fake invoice bytes");
  let seenAuth: string | null = null;
  const out = await withSlack(
    { "files.info": (_m, p) => (p.file === FILE.id ? { ok: true, file: FILE } : { ok: false, error: "file_not_found" }) },
    (url, init) => {
      seenAuth = (init.headers as Record<string, string>)?.authorization ?? null;
      expect(url).toBe(FILE.url_private_download);
      return new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } });
    },
    () => slackTool({ _: ["file", FILE.id], out: join(stateDir, "out") }, { env }),
  );
  expect(seenAuth ?? "").toBe("Bearer xoxp-test");
  expect(out).toContain("name: invoice.pdf");
  expect(out).toContain("type: application/pdf");
  expect(out).toContain(`size: ${Math.ceil(bytes.byteLength / 1024)} KB`);
  const attId = out.split("\n").find((l) => l.startsWith("attachment: "))!.slice("attachment: ".length);
  expect(await db.attachment(attId)).toMatchObject({ filename: "invoice.pdf", mimeType: "application/pdf", bytes });
  const copied = out.split("\n").find((l) => l.startsWith("copied to: "))!.slice("copied to: ".length);
  expect(new Uint8Array(await Bun.file(copied).arrayBuffer())).toEqual(bytes);
  expect(out).toContain(`Pass --attach ${attId} to orca send`);
});

test("file: a redirect to another host is refused", async () => {
  await expect(withSlack(
    { "files.info": () => ({ ok: true, file: FILE }) },
    () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } }),
    () => slackTool({ _: ["file", FILE.id] }, { env }),
  )).rejects.toThrow("redirected off files.slack.com to evil.example.com");
});

test("file: a redirect on the same host is followed", async () => {
  const bytes = new TextEncoder().encode("ok");
  let calls = 0;
  const out = await withSlack(
    { "files.info": () => ({ ok: true, file: FILE }) },
    () => {
      calls++;
      return calls === 1
        ? new Response(null, { status: 302, headers: { location: "https://files.slack.com/files-pri/T1-F1/real-invoice.pdf" } })
        : new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } });
    },
    () => slackTool({ _: ["file", FILE.id] }, { env }),
  );
  expect(calls).toBe(2);
  expect(out).toContain("attachment: ");
});

test("missing_scope on files.info names the scope and points to the docs", async () => {
  await expect(withSlack(
    { "files.info": () => ({ ok: false, error: "missing_scope", needed: "files:read" }) },
    () => new Response("never called", { status: 500 }),
    () => slackTool({ _: ["file", FILE.id] }, { env }),
  )).rejects.toThrow("files.info: missing_scope (the user token needs the scope files:read; see docs/integrations/slack.md)");
});

test("a text/html download body means the token cannot read the file", async () => {
  await expect(withSlack(
    { "files.info": () => ({ ok: true, file: FILE }) },
    () => new Response("<html><body>Sign in to Slack</body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    () => slackTool({ _: ["file", FILE.id] }, { env }),
  )).rejects.toThrow("Slack sent a web page instead of the file: the user token cannot read it (the user token needs the scope files:read; see docs/integrations/slack.md)");
});

test("a file over the cap is refused before any download is attempted", async () => {
  let downloaded = false;
  const big = { ...FILE, size: ATTACHMENT_MAX_BYTES + 1 };
  await expect(withSlack(
    { "files.info": () => ({ ok: true, file: big }) },
    () => { downloaded = true; return new Response("x"); },
    () => slackTool({ _: ["file", FILE.id] }, { env }),
  )).rejects.toThrow(`over the ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB cap for orca slack file`);
  expect(downloaded).toBe(false);
});

const UPLOAD_URL = "https://files.slack.com/upload/v1/abc123";

test("post --attach: the two-step upload, the text as initial_comment; chat.postMessage is not called", async () => {
  await db.addAttachment({ id: "66666666-6666-6666-6666-666666666666", filename: "shot.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) });
  const calls: string[] = [];
  const out = await withSlack(
    {
      "files.getUploadURLExternal": (_m, p) => { calls.push("getUploadURLExternal"); expect(p.filename).toBe("shot.png"); return { ok: true, upload_url: UPLOAD_URL, file_id: "F1" }; },
      "files.completeUploadExternal": (_m, p) => { calls.push("completeUploadExternal"); expect(p.initial_comment).toBe("Look at this"); expect(p.channel_id).toBe("C1"); return { ok: true }; },
      "chat.postMessage": () => { calls.push("chat.postMessage"); return { ok: true, ts: "1.0", channel: "C1" }; },
    },
    () => { calls.push("upload"); return new Response("", { status: 200 }); },
    () => slackTool({ _: ["post", "C1", "Look", "at", "this"], attach: "66666666-6666-6666-6666-666666666666" }, { env }),
  );
  expect(calls).toEqual(["getUploadURLExternal", "upload", "completeUploadExternal"]);
  expect(out).toContain("Posted 1 file to C1 as the user, with the text as the comment.");
});

test("post --attach: missing_scope on the upload names the scope and the docs", async () => {
  await db.addAttachment({ id: "77777777-7777-7777-7777-777777777777", filename: "shot.png", mimeType: "image/png", bytes: new Uint8Array([1]) });
  await expect(withSlack(
    { "files.getUploadURLExternal": () => ({ ok: false, error: "missing_scope", needed: "files:write" }) },
    () => new Response("never called", { status: 500 }),
    () => slackTool({ _: ["post", "C1", "Look:"], attach: "77777777-7777-7777-7777-777777777777" }, { env }),
  )).rejects.toThrow("files upload: missing_scope (the user token needs the scope files:write; see docs/integrations/slack.md)");
});

test("post --attach: a file over the cap is refused before any Slack call", async () => {
  await db.addAttachment({ id: "88888888-8888-8888-8888-888888888888", filename: "big.png", mimeType: "image/png", bytes: new Uint8Array(ATTACHMENT_MAX_BYTES + 1) });
  let called = false;
  await expect(withSlack(
    { "files.getUploadURLExternal": () => { called = true; return { ok: true, upload_url: UPLOAD_URL, file_id: "F1" }; } },
    () => new Response("", { status: 200 }),
    () => slackTool({ _: ["post", "C1", "Look:"], attach: "88888888-8888-8888-8888-888888888888" }, { env }),
  )).rejects.toThrow("attachment too large: big.png");
  expect(called).toBe(false);
});

test("post with no --attach still posts plain text with chat.postMessage (unchanged)", async () => {
  const out = await withSlack(
    { "chat.postMessage": (_m, p) => { expect(p.text).toBe("hello"); return { ok: true, ts: "1.0", channel: "C1" }; } },
    () => new Response("never called", { status: 500 }),
    () => slackTool({ _: ["post", "C1", "hello"] }, { env }),
  );
  expect(out).toContain("Posted to C1 as the user (ts 1.0)");
});
