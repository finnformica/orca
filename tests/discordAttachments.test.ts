// `orca post --attach`: files on an outbound post, through the REAL integrations core — the `orca`
// command, `orca post`, the router, the stored delivery, the dispatcher and its retry — to the
// Discord adapter, which sends them as multipart/form-data with `payload_json`. Discord is a REST
// stub that reads the form. An adapter with no file support refuses; it never drops the files.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { createServer } from "http";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import * as db from "../server/db";
import * as attachments from "../server/attachments";
import * as orchestrator from "../server/orchestrator";
import * as router from "../server/integrations/router";
import * as dispatcher from "../server/integrations/dispatcher";
import * as store from "../server/integrations/store";
import { DISCORD_CAPS, DISCORD_MAX_FILE_BYTES, discordAdapter, multipartBody } from "../server/integrations/adapters/discord";
import { WEBHOOK_CAPS } from "../server/integrations/adapters/webhook";
import type { Adapter, Connection } from "../server/integrations/adapter";
import { attachmentRefusal, digestEnvelope, type Envelope } from "../shared/integrations";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO } from "../web/src/workstream";
import type { OrcaConfig } from "../server/config";
import { native, nativeUpload } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

// Bun's own fetch, FormData and File: the adapter builds the form a deployed bridge sends.
const dom = { fetch: globalThis.fetch, Response: globalThis.Response, FormData: globalThis.FormData, File: globalThis.File };
beforeAll(() => { Object.assign(globalThis, native, nativeUpload); });
afterAll(() => { Object.assign(globalThis, dom); });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const cfg = { repos: [] } as unknown as OrcaConfig;

describe("attachment limits and the multipart body (pure)", () => {
  test("attachmentRefusal: none, no file support, too many, too large", () => {
    expect(attachmentRefusal("webhook", WEBHOOK_CAPS, [])).toBeUndefined();
    expect(attachmentRefusal("webhook", WEBHOOK_CAPS, [{ name: "a.png" }])).toStartWith("attachments not supported: the webhook adapter cannot send files");
    expect(attachmentRefusal("discord", DISCORD_CAPS, Array.from({ length: 10 }, (_, i) => ({ name: `${i}.png`, bytes: 1 })))).toBeUndefined();
    expect(attachmentRefusal("discord", DISCORD_CAPS, Array.from({ length: 11 }, (_, i) => ({ name: `${i}.png`, bytes: 1 })))).toBe("too many attachments: 11, discord takes at most 10 in one message");
    expect(attachmentRefusal("discord", DISCORD_CAPS, [{ name: "big.png", bytes: DISCORD_MAX_FILE_BYTES + 1 }])).toBe("attachment too large: big.png is 10 MB, discord takes at most 10 MB a file");
  });

  test("multipartBody: payload_json names each file, files[n] carries the bytes", async () => {
    const form = multipartBody({ content: "hi" }, [{ name: "a.png", type: "image/png", bytes: PNG }, { name: "b.txt", type: "text/plain", bytes: new TextEncoder().encode("x") }]);
    expect(JSON.parse(String(form.get("payload_json")))).toEqual({ content: "hi", attachments: [{ id: 0, filename: "a.png" }, { id: 1, filename: "b.txt" }] });
    const f0 = form.get("files[0]") as File;
    expect(f0.name).toBe("a.png");
    expect(f0.type).toBe("image/png");
    expect(new Uint8Array(await f0.arrayBuffer())).toEqual(PNG);
  });

  test("a digest keeps its events' attachments", () => {
    const e = (key: string, attachments?: string[]): Envelope => ({ id: key, key, topic: "orca.message", at: 1, source: { adapter: "orca" }, text: key, ...(attachments ? { attachments } : {}) });
    expect(digestEnvelope([e("a", ["r1"]), e("b"), e("c", ["r2", "r1"])], "k").attachments).toEqual(["r1", "r2"]);
  });
});

test("the orca command collects a repeated --attach on post", async () => {
  let got: unknown;
  const bridge = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; }).on("end", () => { got = JSON.parse(body); res.end('{"text":"ok"}'); });
  });
  await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
  try {
    const run = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/orca"), "post", "--link", "L1", "--attach", "/tmp/a.png", "--attach", "id-2", "Look:"], {
      env: { ...process.env, ORCA_URL: `http://127.0.0.1:${(bridge.address() as AddressInfo).port}` }, stdout: "pipe",
    });
    expect((await new Response(run.stdout).text()).trim()).toBe("ok");
    expect(got).toEqual({ verb: "post", args: { link: "L1", attach: ["/tmp/a.png", "id-2"], _: ["Look:"], _cwd: process.cwd() } });
  } finally {
    bridge.close();
  }
});

describe("orca post --attach on the integrations core (Postgres)", () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  const conn: Connection = { id: "discord", kind: "discord", name: "Discord", instance: "local", config: {}, secretRef: "ORCA_SECRET_DISCORD_TEST", enabled: true };
  const hookConn: Connection = { id: "hook", kind: "webhook", name: "Hook", instance: "local", config: {}, secretRef: "ORCA_SECRET_HOOK_TEST", enabled: true };
  // The Slack adapter is receive-only: a post to its link stays in Orca, files or not.
  const slackConn: Connection = { id: "slack", kind: "slack", name: "Slack", instance: "local", config: {}, secretRef: "ORCA_SECRET_SLACK_TEST", enabled: true };
  /** Each Discord message POST: its payload and its files; the first `fail` answers are 503. */
  let posts: { path: string; multipart: boolean; payload: Record<string, unknown>; files: { name: string; type: string; bytes: Uint8Array }[] }[];
  let fail = 0;
  let hookSends: unknown[];

  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE, ORCA_STATE_DIR: process.env.ORCA_STATE_DIR };
    process.env.ORCA_INSTANCE = "local";
    process.env.ORCA_STATE_DIR = mkdtempSync(join(tmpdir(), "orca-attach-state-"));
    process.env.ORCA_SECRET_DISCORD_TEST = "tok";
    pg = await freshSchema("discordattach");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    router.resetPace();
    dispatcher.resetPace();
    posts = [];
    fail = 0;
    hookSends = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const path = String(url).replace("https://discord.com/api/v10", "");
      const multipart = init?.body instanceof FormData;
      const form = multipart ? init!.body as FormData : undefined;
      const payload = form ? JSON.parse(String(form.get("payload_json"))) : JSON.parse(String(init?.body ?? "{}"));
      const files = form ? await Promise.all([...form.entries()].filter(([k]) => k.startsWith("files[")).map(async ([, v]) => {
        const f = v as unknown as File;
        return { name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) };
      })) : [];
      if (fail-- > 0) return new Response(JSON.stringify({ message: "Service Unavailable" }), { status: 503 });
      posts.push({ path, multipart, payload, files });
      return new Response(JSON.stringify({ id: String(100 + posts.length) }), { status: 200 });
    }) as typeof fetch;
    await store.addIntegration(conn);
    await store.addIntegration(hookConn);
    await store.addIntegration(slackConn);
    await store.addLink({ id: "L1", integrationId: "discord", externalId: "C1", label: "#site", level: "work", repos: ["r"], requireMention: true });
    await store.addLink({ id: "H1", integrationId: "hook", externalId: "hook", label: "hook", level: "work", repos: ["r"], requireMention: true });
    await store.addLink({ id: "S1", integrationId: "slack", externalId: "CS", label: "#slack", level: "work", repos: ["r"], requireMention: true });
    const discord = discordAdapter(conn);
    // The webhook's real caps (no files); a send that reached it would be a dropped file.
    const hook: Adapter = { kind: "webhook", caps: WEBHOOK_CAPS, start: async () => {}, stop: async () => {}, health: async () => ({ ok: true }), send: async (_t, m) => { hookSends.push(m); return { ok: true }; } };
    dispatcher.configure({ adapter: (id) => (id === "discord" ? discord : id === "hook" ? hook : undefined) });
    dispatcher.setRunning(() => ["discord", "hook"]);
  });
  afterEach(async () => {
    globalThis.fetch = native.fetch;
    dispatcher.configure({ adapter: () => undefined });
    dispatcher.setRunning(() => []);
    await db.close();
    await pg.drop();
    delete process.env.ORCA_SECRET_DISCORD_TEST;
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test("a path and an id go as files with payload_json; a failed send retries with the same bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-attach-"));
    writeFileSync(join(dir, "shot.png"), PNG);
    const [ref] = await attachments.store([new File([new TextEncoder().encode("notes")], "notes.txt", { type: "text/plain" })]);
    const id = ref!.match(/([0-9a-f-]{36})/)![1]!;
    const out = await orchestrator.tool(cfg, "post", { link: "L1", attach: [join(dir, "shot.png"), id], _: ["The", "new", "footer."] });
    expect(out).toContain("with 2 attachments");
    // The delivery stores only refs, so the bytes come from the attachment table at each send.
    const [queued] = await store.deliveries({ state: "pending" });
    expect(queued!.envelope.attachments).toEqual([expect.stringMatching(/^orca-attachment:\/\/[0-9a-f-]{36}\/shot\.png$/), ref]);

    fail = 1; // the first send is a 503: retryable
    await dispatcher.dispatchOnce();
    expect(posts).toEqual([]);
    const [retry] = await store.deliveries({ state: "failed" }); // waits for its retry
    expect(retry).toMatchObject({ attempts: 1, lastError: "503 Service Unavailable" });

    await dispatcher.dispatchOnce(Date.now() + 60_000);
    expect(posts).toEqual([{
      path: "/channels/C1/messages", multipart: true,
      payload: { content: "The new footer.", allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: "shot.png" }, { id: 1, filename: "notes.txt" }] },
      files: [{ name: "shot.png", type: "application/octet-stream", bytes: PNG }, { name: "notes.txt", type: expect.stringMatching(/^text\/plain/), bytes: new TextEncoder().encode("notes") }],
    }]);
    expect(await store.deliveries({ state: "sent" })).toHaveLength(1);
  });

  test("a post with no files stays plain JSON", async () => {
    await orchestrator.tool(cfg, "post", { link: "L1", _: ["Plain."] });
    await dispatcher.dispatchOnce();
    expect(posts).toEqual([{ path: "/channels/C1/messages", multipart: false, payload: { content: "Plain.", allowed_mentions: { parse: [] } }, files: [] }]);
  });

  test("orca post refuses before it queues: too many files, a file too large, a secret, no file support", async () => {
    const refs = await attachments.store(Array.from({ length: 11 }, (_, i) => new File([PNG], `${i}.png`, { type: "image/png" })));
    await expect(orchestrator.tool(cfg, "post", { link: "L1", attach: refs, _: ["x"] })).rejects.toThrow("too many attachments: 11, discord takes at most 10");
    const [big] = await attachments.store([new File([new Uint8Array(DISCORD_MAX_FILE_BYTES + 1)], "big.png")]);
    await expect(orchestrator.tool(cfg, "post", { link: "L1", attach: big, _: ["x"] })).rejects.toThrow("attachment too large: big.png");
    const [secret] = await attachments.store([new File([new TextEncoder().encode("ok\ntoken=xoxb-1234567890-abcdef\n")], "env.txt")]);
    await expect(orchestrator.tool(cfg, "post", { link: "L1", attach: secret, _: ["x"] })).rejects.toThrow("env.txt line 2 looks like a Slack token");
    await expect(orchestrator.tool(cfg, "post", { link: "H1", attach: refs[0], _: ["x"] })).rejects.toThrow("attachments not supported: the webhook adapter cannot send files");
    await expect(orchestrator.tool(cfg, "post", { link: "S1", attach: refs[0], _: ["x"] })).rejects.toThrow("Slack is receive-only");
    expect(await store.deliveries({})).toEqual([]);
  });

  test("the dispatcher ends a delivery whose adapter has no file support, and never calls send", async () => {
    const [ref] = await attachments.store([new File([PNG], "a.png")]);
    const r = await router.post((await store.link("H1"))!, "Look", { attachments: [ref!] });
    await dispatcher.dispatchOnce();
    expect(hookSends).toEqual([]);
    expect(await store.deliveries({ state: "dead" })).toEqual([expect.objectContaining({ id: r.delivery, attempts: 1, lastError: expect.stringContaining("attachments not supported: the webhook adapter") })]);
  });

  test("a file the attachment table lost ends the Discord send with a clear error", async () => {
    await router.post((await store.link("L1"))!, "Look", { attachments: ["orca-attachment://00000000-0000-0000-0000-000000000000/gone.png"] });
    await dispatcher.dispatchOnce();
    expect(posts).toEqual([]);
    expect(await store.deliveries({ state: "dead" })).toEqual([expect.objectContaining({ lastError: expect.stringContaining("is gone") })]);
  });

  test("a wake from an outside message attaches ids only, never a path", async () => {
    await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakeGrant: { level: "work", repos: ["r"], linkId: "L1" } as never });
    await expect(orchestrator.tool(cfg, "post", { link: "L1", attach: "/etc/hostname", _: ["x"] })).rejects.toThrow("may attach only an attachment id");
    const [ref] = await attachments.store([new File([PNG], "a.png", { type: "image/png" })]);
    expect(await orchestrator.tool(cfg, "post", { link: "L1", attach: ref!.match(/([0-9a-f-]{36})/)![1]!, _: ["x"] })).toContain("with 1 attachment");
  });
});
