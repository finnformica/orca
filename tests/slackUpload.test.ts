// Slack's own file upload (server/integrations/adapters/slack.ts `uploadFiles`): the two-step
// external upload (files.getUploadURLExternal, a raw POST to the returned upload_url, then
// files.completeUploadExternal) that `orca post --attach` to a Slack link, and `orca slack post
// --attach` (server/slackTool.ts), both go through. Real Postgres for the attachment table; Slack's
// Web API and the upload host are a stubbed global.fetch keyed by URL. No real Slack.
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as db from "../server/db";
import { loadSlackFiles, missingScopeHint, SLACK_CAPS, slackAdapter, uploadFiles, type SlackUploadFile } from "../server/integrations/adapters/slack";
import type { Connection } from "../server/integrations/adapter";
import { attachmentRefusal } from "../shared/integrations";
import { freshSchema, type TestDb } from "./pg";

const API = "https://slack.com/api/";
type FakeRoute = (method: string, body: Record<string, unknown>) => unknown;

/** Slack's Web API plus the upload host, routed by URL — the same pattern as tests/slackTool.test.ts. */
async function withSlack<T>(slack: Record<string, FakeRoute>, upload: (url: string, init: RequestInit) => Response | Promise<Response>, body: () => Promise<T>): Promise<T> {
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
    return upload(u, init);
  }) as typeof fetch;
  try { return await body(); } finally { globalThis.fetch = orig; }
}

let pg: TestDb;
let prev: Record<string, string | undefined>;
beforeEach(async () => {
  prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL };
  pg = await freshSchema("slackupload");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const FILE: SlackUploadFile = { name: "cat.png", type: "image/png", bytes: new TextEncoder().encode("fake png bytes") };
const UPLOAD_URL = "https://files.slack.com/upload/v1/abc123";

test("uploadFiles calls the three endpoints in order, with the text as initial_comment", async () => {
  const calls: string[] = [];
  const out = await withSlack(
    {
      "files.getUploadURLExternal": (_m, p) => {
        calls.push("getUploadURLExternal");
        expect(p.filename).toBe("cat.png");
        expect(Number(p.length)).toBe(FILE.bytes.byteLength);
        return { ok: true, upload_url: UPLOAD_URL, file_id: "F999" };
      },
      "files.completeUploadExternal": (_m, p) => {
        calls.push("completeUploadExternal");
        expect(p.files).toEqual([{ id: "F999", title: "cat.png" }]);
        expect(p.channel_id).toBe("C1");
        expect(p.thread_ts).toBe("123.456");
        expect(p.initial_comment).toBe("Look:");
        return { ok: true, files: [{ id: "F999", title: "cat.png" }] };
      },
    },
    (url) => { calls.push("upload"); expect(url).toBe(UPLOAD_URL); return new Response("", { status: 200 }); },
    () => uploadFiles("xoxp-test", [FILE], { channel: "C1", threadTs: "123.456", initialComment: "Look:" }),
  );
  expect(calls).toEqual(["getUploadURLExternal", "upload", "completeUploadExternal"]);
  expect(out.ok).toBe(true);
});

test("uploadFiles with no text or thread leaves those fields out, and no files.info is called", async () => {
  const seen: Record<string, unknown>[] = [];
  await withSlack(
    { "files.getUploadURLExternal": () => ({ ok: true, upload_url: UPLOAD_URL, file_id: "F1" }), "files.completeUploadExternal": (_m, p) => { seen.push(p); return { ok: true }; } },
    () => new Response("", { status: 200 }),
    () => uploadFiles("xoxp-test", [FILE], { channel: "C1" }),
  );
  expect(seen).toEqual([{ files: [{ id: "F1", title: "cat.png" }], channel_id: "C1" }]);
});

test("uploadFiles passes a missing_scope answer through untouched; missingScopeHint words it", async () => {
  const out = await withSlack(
    { "files.getUploadURLExternal": () => ({ ok: false, error: "missing_scope", needed: "files:write" }) },
    () => new Response("never called", { status: 500 }),
    () => uploadFiles("xoxp-test", [FILE], { channel: "C1" }),
  );
  expect(out).toEqual({ ok: false, error: "missing_scope", needed: "files:write" });
  expect(missingScopeHint(out)).toBe(" (the user token needs the scope files:write; see docs/integrations/slack.md)");
  expect(missingScopeHint({ error: "missing_scope" })).toBe(" (the user token needs the scope files:write; see docs/integrations/slack.md)"); // no `needed`: falls back
  expect(missingScopeHint({ error: "channel_not_found" })).toBe("");
});

test("a non-200 upload response ends the flow before completeUploadExternal", async () => {
  let completed = false;
  const out = await withSlack(
    { "files.getUploadURLExternal": () => ({ ok: true, upload_url: UPLOAD_URL, file_id: "F1" }), "files.completeUploadExternal": () => { completed = true; return { ok: true }; } },
    () => new Response("forbidden", { status: 403 }),
    () => uploadFiles("xoxp-test", [FILE], { channel: "C1" }),
  );
  expect(out).toMatchObject({ ok: false, error: expect.stringContaining("http 403") });
  expect(completed).toBe(false);
});

test("loadSlackFiles: a size over the cap is refused, a gone attachment ends the send", async () => {
  await db.addAttachment({ id: "11111111-1111-1111-1111-111111111111", filename: "a.png", mimeType: "image/png", bytes: new Uint8Array(10) });
  expect(await loadSlackFiles(["orca-attachment://11111111-1111-1111-1111-111111111111/a.png"])).toEqual([{ name: "a.png", type: "image/png", bytes: new Uint8Array(10) }]);
  expect(await loadSlackFiles(["orca-attachment://00000000-0000-0000-0000-000000000000/gone.png"])).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining("is gone") });

  const refusal = attachmentRefusal("slack", SLACK_CAPS, [{ name: "big.png", bytes: SLACK_CAPS.maxAttachmentBytes! + 1 }]);
  expect(refusal).toContain("attachment too large: big.png");
});

test("the adapter's send(): attachments reach uploadFiles instead of chat.postMessage", async () => {
  const conn: Connection = { id: "slack", kind: "slack", name: "Slack", instance: "local", config: {}, secretRef: "ORCA_SECRET_SLACK_UPLOAD_TEST", enabled: true };
  process.env.ORCA_SECRET_SLACK_UPLOAD_TEST = "xoxp-test";
  try {
    await db.addAttachment({ id: "22222222-2222-2222-2222-222222222222", filename: "shot.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) });
    const calls: string[] = [];
    const r = await withSlack(
      {
        "files.getUploadURLExternal": () => { calls.push("getUploadURLExternal"); return { ok: true, upload_url: UPLOAD_URL, file_id: "F1" }; },
        "files.completeUploadExternal": (_m, p) => { calls.push("completeUploadExternal"); expect(p.initial_comment).toBe("Look:"); expect(p.channel_id).toBe("C1"); return { ok: true }; },
        "chat.postMessage": () => { calls.push("chat.postMessage"); return { ok: true, ts: "999.000", channel: "C1" }; },
      },
      () => { calls.push("upload"); return new Response("", { status: 200 }); },
      () => slackAdapter(conn).send({ externalId: "C1" }, { text: "Look:", attachments: ["orca-attachment://22222222-2222-2222-2222-222222222222/shot.png"] }, "k1"),
    );
    expect(calls).toEqual(["getUploadURLExternal", "upload", "completeUploadExternal"]); // never chat.postMessage
    expect(r).toEqual({ ok: true });
  } finally { delete process.env.ORCA_SECRET_SLACK_UPLOAD_TEST; }
});

test("the adapter's send(): an existing thread's key is kept; a brand-new post gets no thread (completeUploadExternal names no ts)", async () => {
  const conn: Connection = { id: "slack", kind: "slack", name: "Slack", instance: "local", config: {}, secretRef: "ORCA_SECRET_SLACK_UPLOAD_TEST", enabled: true };
  process.env.ORCA_SECRET_SLACK_UPLOAD_TEST = "xoxp-test";
  try {
    await db.addAttachment({ id: "33333333-3333-3333-3333-333333333333", filename: "a.png", mimeType: "image/png", bytes: new Uint8Array([1]) });
    const ref = "orca-attachment://33333333-3333-3333-3333-333333333333/a.png";
    const routes = { "files.getUploadURLExternal": () => ({ ok: true, upload_url: UPLOAD_URL, file_id: "F1" }), "files.completeUploadExternal": () => ({ ok: true }) };
    const noThread = await withSlack(routes, () => new Response("", { status: 200 }), () => slackAdapter(conn).send({ externalId: "C1" }, { text: "hi", attachments: [ref] }, "k1"));
    expect(noThread).toEqual({ ok: true }); // no ts to build a thread key from
    const kept = await withSlack(routes, () => new Response("", { status: 200 }), () => slackAdapter(conn).send({ externalId: "C1", threadId: "C1:123.456" }, { text: "hi", attachments: [ref] }, "k2"));
    expect(kept).toEqual({ ok: true, threadId: "C1:123.456" }); // an existing thread is kept as given
  } finally { delete process.env.ORCA_SECRET_SLACK_UPLOAD_TEST; }
});

test("the adapter's send(): a missing_scope answer is worded with the scope and the setup doc", async () => {
  const conn: Connection = { id: "slack", kind: "slack", name: "Slack", instance: "local", config: {}, secretRef: "ORCA_SECRET_SLACK_UPLOAD_TEST", enabled: true };
  process.env.ORCA_SECRET_SLACK_UPLOAD_TEST = "xoxp-test";
  try {
    await db.addAttachment({ id: "44444444-4444-4444-4444-444444444444", filename: "a.png", mimeType: "image/png", bytes: new Uint8Array([1]) });
    const r = await withSlack(
      { "files.getUploadURLExternal": () => ({ ok: false, error: "missing_scope", needed: "files:write" }) },
      () => new Response("never called", { status: 500 }),
      () => slackAdapter(conn).send({ externalId: "C1" }, { text: "hi", attachments: ["orca-attachment://44444444-4444-4444-4444-444444444444/a.png"] }, "k1"),
    );
    expect(r).toMatchObject({ ok: false, retryable: false, error: "missing_scope (the user token needs the scope files:write; see docs/integrations/slack.md)" });
  } finally { delete process.env.ORCA_SECRET_SLACK_UPLOAD_TEST; }
});

test("editing a message to add files is refused, not silently ignored", async () => {
  const conn: Connection = { id: "slack", kind: "slack", name: "Slack", instance: "local", config: {}, secretRef: "ORCA_SECRET_SLACK_UPLOAD_TEST", enabled: true };
  process.env.ORCA_SECRET_SLACK_UPLOAD_TEST = "xoxp-test";
  try {
    const r = await slackAdapter(conn).send({ externalId: "C1", messageId: "1.0" }, { text: "hi", edit: true, attachments: ["orca-attachment://55555555-5555-5555-5555-555555555555/a.png"] }, "k1");
    expect(r).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining("not supported") });
  } finally { delete process.env.ORCA_SECRET_SLACK_UPLOAD_TEST; }
});
