// Forms with secret fields and the secret store, end to end against Postgres (a fresh schema): `orca
// ask-form` → the card's submit → the orchestrator's wake; the store (AES-256-GCM, the key from
// ORCA_SECRETS_KEY or the state dir); `orca secret list|pipe|env|delete` with the audit; and the scrub
// of tool output, transcripts, turns and channel posts. A channel gets only a link to the Orca chat.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as forms from "../server/forms";
import * as orchestrator from "../server/orchestrator";
import * as secrets from "../server/secrets";
import * as transcript from "../server/transcript";
import * as outbox from "../server/outbox";
import * as router from "../server/integrations/router";
import * as dispatcher from "../server/integrations/dispatcher";
import * as store from "../server/integrations/store";
import { agentEnv } from "../server/env";
import type { Adapter } from "../server/integrations/adapter";
import { grantRefusal, type Envelope, type OutboundMessage, type Target } from "../shared/integrations";
import type { AgentStep } from "../shared/agent";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO } from "../web/src/workstream";
import type { OrcaConfig } from "../server/config";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";
import { EVERY_TYPE } from "./formFixture";

const dom = { fetch: globalThis.fetch, Response: globalThis.Response };
beforeAll(() => { Object.assign(globalThis, native); orchestrator.postWait.ms = 0; });
afterAll(() => { Object.assign(globalThis, dom); });

const cfg = { repos: [{ name: "r", repoPath: "/nope", worktreeRoot: "/nope", baseBranch: "main", previewServices: [] }] } as unknown as OrcaConfig;
// Not a real credential: a value with the shape of one, so the scrub and the guard see it.
const VALUE = "sk-test-FAKE0000secret0000value";

let pg: TestDb;
let stateDir: string;
let prev: Record<string, string | undefined> = {};
const sent: { target: Target; msg: OutboundMessage }[] = [];
const web: Envelope[] = [];
const fake: Adapter = {
  kind: "discord", caps: { inbound: "socket", outbound: true, threads: true, edits: false, reactions: false, attachments: false, maxTextLength: 10_000 },
  start: async () => {}, stop: async () => {}, health: async () => ({ ok: true }),
  send: async (target, msg) => { sent.push({ target, msg }); return { ok: true, externalMsgId: `m${sent.length}` }; },
};

/** The output of a tool call that answers with an exit code (`orca secret pipe|env`). */
async function exitOf(p: Promise<string>): Promise<{ text: string; exitCode: number }> {
  try { await p; } catch (e) { if (e instanceof orchestrator.ToolExit) return { text: e.text, exitCode: e.exitCode }; throw e; }
  throw new Error("expected a ToolExit");
}

beforeEach(async () => {
  prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE, ORCA_STATE_DIR: process.env.ORCA_STATE_DIR, ORCA_SECRETS_KEY: process.env.ORCA_SECRETS_KEY, ORCA_TAILSCALE_BIN: process.env.ORCA_TAILSCALE_BIN, ORCA_SERVER_URL: process.env.ORCA_SERVER_URL };
  process.env.ORCA_INSTANCE = "local";
  process.env.ORCA_TAILSCALE_BIN = "/nonexistent/tailscale";
  process.env.ORCA_SERVER_URL = "https://orca.example";
  delete process.env.ORCA_SECRETS_KEY;
  stateDir = await mkdtemp(join(tmpdir(), "orca-secrets-"));
  process.env.ORCA_STATE_DIR = stateDir;
  pg = await freshSchema("secrets");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  router.resetPace();
  dispatcher.resetPace();
  sent.length = 0;
  web.length = 0;
  dispatcher.configure({ adapter: (id) => (id === "discord-me" ? fake : undefined), web: async (e) => { web.push(e); return { ok: true }; } });
  dispatcher.setRunning(() => ["discord-me"]);
  await store.addIntegration({ id: "discord-me", kind: "discord", name: "Discord", instance: "local", config: {}, enabled: true });
  await store.addLink({ id: "D1", integrationId: "discord-me", externalId: "C1", label: "#me", level: "work", repos: ["r"], requireMention: false });
  await secrets.refresh(); // the scrub cache from this (empty) schema, not the last test's
});
afterEach(async () => {
  dispatcher.configure({ adapter: () => undefined });
  dispatcher.setRunning(() => []);
  await db.close();
  await pg.drop();
  await rm(stateDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("ask-form → submit → wake", () => {
  test("the form card's flow: a link on Discord, the answers as JSON, each secret stored and never in the wake", async () => {
    await store.addSubscription({ topicPattern: "orca.question", filter: {}, targetKind: "link", targetId: "D1", digestSeconds: 0 });
    const out = await orchestrator.tool(cfg, "ask-form", { title: "Set up billing", intro: "Two minutes.", fields: JSON.stringify(EVERY_TYPE) });
    const id = out.match(/orca-form:\/\/([\w-]+)/)![1]!;
    expect(out).toContain('Asked: form "Set up billing" with 11 fields.');
    expect(out).toContain("Secret fields (api_key)");

    // Discord gets only a link to the Orca chat: no field, so no secret field either.
    await dispatcher.dispatchOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg.text).toBe("The orchestrator asks you to fill in a form: Set up billing.\nTwo minutes.\nOpen the Orca chat to answer: https://orca.example/orchestrator");
    expect(sent[0]!.msg.text).not.toContain("API key");
    expect(web.map((e) => e.topic)).toEqual(["orca.question"]); // the bell and the Inbox

    // The card reads the form; invalid answers are refused with each field's message.
    expect((await forms.one(id))).toMatchObject({ state: "open", title: "Set up billing" });
    const wakes: string[] = [];
    const wake = async (t: string) => { wakes.push(t); };
    const bad = await forms.submit(id, { project: "" }, wake).catch((e) => e as forms.FormError);
    expect(bad).toBeInstanceOf(forms.FormError);
    expect((bad as forms.FormError).status).toBe(400);
    expect((bad as forms.FormError).errors).toMatchObject({ project: "is required", agree: "is required", api_key: "is required" });

    const values = { project: "orca", replicas: "3", region: "eu-west-2", features: ["auth"], agree: true, api_key: VALUE };
    const done = await forms.submit(id, values, wake);
    expect(done.state).toBe("submitted");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain('"project": "orca"');
    expect(wakes[0]).toContain('"replicas": 3');
    expect(wakes[0]).toContain('"name": "billing/api_key"');
    expect(wakes[0]).not.toContain(VALUE);
    // Neither the form row nor the secret row holds the value in clear.
    expect(JSON.stringify(await db.form(id))).not.toContain(VALUE);
    const [row] = await db.secretCiphers();
    expect(row).toMatchObject({ scope: "billing", name: "api_key", source: `form ${id}` });
    expect(row!.ciphertext).not.toContain(VALUE);
    expect(secrets.decrypt(row!.ciphertext)).toBe(VALUE);

    // A second submit (a double click) neither stores nor wakes again.
    expect((await forms.submit(id, values, wake).catch((e) => e as forms.FormError) as forms.FormError).status).toBe(409);
    expect(wakes).toHaveLength(1);
  });

  test("cancel wakes the orchestrator with no answers; a bad spec is refused before anything is asked", async () => {
    const out = await orchestrator.tool(cfg, "ask-form", { title: "Pick one", fields: '[{"name":"x","label":"X","type":"select","options":["a","b"]}]' });
    const id = out.match(/orca-form:\/\/([\w-]+)/)![1]!;
    const wakes: string[] = [];
    await forms.cancel(id, async (t) => { wakes.push(t); });
    expect(wakes).toEqual([`[form cancelled] Pick one (form ${id}): the user cancelled the form. No answers were given.`]);
    expect((await forms.one(id))?.state).toBe("cancelled");
    await expect(orchestrator.tool(cfg, "ask-form", { title: "t", fields: '[{"name":"k","label":"K","type":"secret","default":"x"}]' })).rejects.toThrow('a secret field takes no "default"');
    await expect(orchestrator.tool(cfg, "ask-form", { title: "t", fields: "{not json" })).rejects.toThrow("--fields is not valid JSON");
    await expect(orchestrator.tool(cfg, "ask-form", { title: "t" })).rejects.toThrow("--fields is required");
  });

  test("--fields @file is read from the caller's cwd", async () => {
    await Bun.write(join(stateDir, "form.json"), JSON.stringify([{ name: "email", label: "Email", type: "email", required: true }]));
    expect(await orchestrator.tool(cfg, "ask-form", { title: "Contact", fields: "@form.json", _cwd: stateDir })).toContain("with 1 field.");
  });
});

describe("the secret store", () => {
  test("the key is made on first use in the state dir (mode 0600), or comes from ORCA_SECRETS_KEY; agents never get it", async () => {
    const k = secrets.key();
    expect(k.source).toBe("file");
    expect(((await stat(join(stateDir, "secrets.key"))).mode & 0o777)).toBe(0o600);
    expect(secrets.keyInfo().source).toBe(join(stateDir, "secrets.key"));
    process.env.ORCA_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
    expect(secrets.key()).toMatchObject({ source: "env" });
    expect(secrets.key().id).not.toBe(k.id);
    expect(agentEnv().ORCA_SECRETS_KEY).toBeUndefined();
  });

  test("list shows names, never values; pipe and env give the value to one command, scrubbed back, with an audit row", async () => {
    await secrets.store({ name: "api_key", value: VALUE, who: "user (form)" });
    const list = await orchestrator.tool(cfg, "secret", { _: ["list"] });
    expect(list).toContain("api_key · scope default · created ");
    expect(list).toContain("last used never");
    expect(list).not.toContain(VALUE);

    // pipe: the value on stdin. The command echoes it; the agent sees its name.
    const piped = await exitOf(orchestrator.tool(cfg, "secret", { _: ["pipe", "api_key"], "--": ["sh", "-c", "printf 'got:'; cat"] }));
    expect(piped.exitCode).toBe(0);
    expect(piped.text).toContain("got:[secret api_key]");
    expect(piped.text).not.toContain(VALUE);

    // env: the value in that one command's env (default name: the name in capitals), and its exit code.
    const env = await exitOf(orchestrator.tool(cfg, "secret", { _: ["env", "api_key"], "--": ["sh", "-c", "echo \"key=$API_KEY\"; echo oops >&2; exit 3"] }));
    expect(env).toEqual({ text: "key=[secret api_key]\noops\n", exitCode: 3 });
    const named = await exitOf(orchestrator.tool(cfg, "secret", { _: ["env", "api_key=TOKEN"], "--": ["sh", "-c", "test -n \"$TOKEN\" && test -z \"$API_KEY\" && echo only TOKEN"] }));
    expect(named).toEqual({ text: "only TOKEN\n", exitCode: 0 });
    expect(process.env.API_KEY).toBeUndefined(); // never the bridge's own env

    const uses = await db.secretUses();
    expect(uses.map((u) => [u.action, u.command, u.who])).toEqual([["env", "sh", "orchestrator"], ["env", "sh", "orchestrator"], ["pipe", "sh", "orchestrator"], ["store", undefined, "user (form)"]]);
    expect((await db.secrets())[0]!.lastUsedAt).toBeGreaterThan(0);

    // Usage errors and an unknown name.
    await expect(orchestrator.tool(cfg, "secret", { _: ["pipe", "api_key"] })).rejects.toThrow("the command is required after --");
    await expect(orchestrator.tool(cfg, "secret", { _: ["pipe", "nope"], "--": ["true"] })).rejects.toThrow('no secret "nope"');
    await expect(orchestrator.tool(cfg, "secret", { _: ["env", "api_key=1BAD"], "--": ["true"] })).rejects.toThrow("not a valid environment variable name");
  });

  test("a bare name in two scopes is ambiguous; delete removes it and writes the audit", async () => {
    await secrets.store({ name: "token", value: "aaaaaaaa1", who: "t" });
    await secrets.store({ scope: "chat", name: "token", value: "bbbbbbbb2", who: "t" });
    await expect(orchestrator.tool(cfg, "secret", { _: ["pipe", "token"], "--": ["cat"] })).rejects.toThrow('"token" is in more than one scope: name one of chat/token, token');
    expect((await exitOf(orchestrator.tool(cfg, "secret", { _: ["pipe", "chat/token"], "--": ["cat"] }))).text).toBe("[secret chat/token]");
    expect(await orchestrator.tool(cfg, "secret", { _: ["delete", "chat/token"] })).toBe("Deleted secret chat/token.");
    expect((await db.secrets()).map((s) => `${s.scope}/${s.name}`)).toEqual(["default/token"]);
    expect((await db.secretUses())[0]).toMatchObject({ action: "delete", scope: "chat", name: "token", who: "orchestrator" });
    // Deleted: no longer scrubbed, no longer usable.
    expect(secrets.scrub("x bbbbbbbb2")).toBe("x bbbbbbbb2");
    await expect(orchestrator.tool(cfg, "secret", { _: ["pipe", "chat/token"], "--": ["cat"] })).rejects.toThrow('no secret "chat/token"');
  });

  test("a secret stored with another key is listed but not used, with the reason", async () => {
    process.env.ORCA_SECRETS_KEY = Buffer.alloc(32, 1).toString("base64");
    await secrets.store({ name: "other", value: "cccccccc3", who: "t" });
    process.env.ORCA_SECRETS_KEY = Buffer.alloc(32, 2).toString("base64");
    expect(await orchestrator.tool(cfg, "secret", { _: ["list"] })).toContain("stored with another key");
    await expect(orchestrator.tool(cfg, "secret", { _: ["pipe", "other"], "--": ["cat"] })).rejects.toThrow("Set ORCA_SECRETS_KEY to the same key on every instance");
  });

  test("an outside sender's wake cannot touch the store; ask-form is allowed like ask-user", () => {
    const ask = { level: "ask" as const, repos: [], linkId: "D1" };
    const admin = { level: "admin" as const, repos: ["r"], linkId: "D1" };
    expect(grantRefusal(ask, "ask-form")).toBeUndefined();
    for (const g of [ask, admin]) for (const sub of ["list", "pipe", "env", "delete"]) expect(grantRefusal(g, "secret", { _: [sub] })).toContain("needs your own chat");
  });
});

describe("scrub", () => {
  test("a stored value never reaches a transcript, a turn or a channel post", async () => {
    await secrets.store({ name: "api_key", value: VALUE, who: "t" });
    // A transcript step (a tool result that printed it) and the published copy.
    const runId = "run-scrub-1";
    await outbox.startTurn({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH, runId, provider: "claude", instruction: `use ${VALUE}`, prompt: `prompt ${VALUE}`, startedAt: Date.now() });
    const published = await transcript.append(runId, [{ at: Date.now(), kind: "result", id: "t1", output: `curl -H "Bearer ${VALUE}"` } as AgentStep, { at: Date.now(), kind: "tool", id: "t2", name: "Bash", input: { command: `echo ${VALUE}` } } as AgentStep]);
    expect(JSON.stringify(published)).not.toContain(VALUE);
    await outbox.finishTurn(runId, { status: "done", response: `Done with ${VALUE}.`, structured: { outcome: `used ${VALUE}` } as never, finishedAt: Date.now() });
    const stored = JSON.stringify({ steps: await db.steps(runId), turns: await db.turns(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH) });
    expect(stored).not.toContain(VALUE);
    expect(stored).toContain("[secret api_key]");

    // A channel post (`orca post`) that carries it goes out scrubbed.
    await orchestrator.tool(cfg, "post", { link: "D1", _: [`the key is ${VALUE}`] });
    await dispatcher.dispatchOnce();
    expect(sent.at(-1)!.msg.text).toBe("the key is [secret api_key]");

    // The cache another instance's store fills: refresh reads it back from the table.
    await secrets.refresh();
    expect(secrets.scrub(VALUE)).toBe("[secret api_key]");
  });
});
