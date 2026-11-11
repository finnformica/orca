// Forms with secret fields and the secret store, end to end against Postgres (a fresh schema): `orca
// ask-form` → the card's submit → the orchestrator's wake; the store (AES-256-GCM, the key from
// ORCA_SECRETS_KEY or the state dir); `orca secret list|pipe|env|delete` with the audit; and the scrub
// of tool output, transcripts, turns and channel posts. A channel gets only a link to the Orca chat.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import * as agent from "../server/agent";
import { secretEnvNote } from "../server/agent";
import { handleSecrets, type SecretRouteDeps } from "../server/secretRoutes";
import { parseSecretShows, showFresh, turnSecretShows } from "../shared/secretShow";
import type { Adapter } from "../server/integrations/adapter";
import { grantRefusal, type Envelope, type OutboundMessage, type Target } from "../shared/integrations";
import type { AgentStep, AgentTurn } from "../shared/agent";
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

// ---- looser handling (2026-11-10): public secrets, Reveal, `orca secret show`, `--secret` for workers ----

describe("public secrets", () => {
  // Not a real id: the shape of an OAuth client id the user marked public.
  const CLIENT_ID = "fake-client-0000-1111-2222";
  test("the reply scrub skips a public value; channel posts still mask it; mark switches it", async () => {
    await secrets.store({ name: "client_id", value: CLIENT_ID, who: "t", public: true });
    await secrets.store({ name: "api_key", value: VALUE, who: "t" });
    const link = `https://auth.example/authorize?client_id=${CLIENT_ID}&key=${VALUE}`;
    // Replies, transcripts and tool output: the link still works, the private key does not leak.
    expect(secrets.scrub(link)).toBe("https://auth.example/authorize?client_id=fake-client-0000-1111-2222&key=[secret api_key]");
    const runId = "run-public-1";
    await outbox.startTurn({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH, runId, provider: "claude", instruction: "auth link", prompt: "p", startedAt: Date.now() });
    await outbox.finishTurn(runId, { status: "done", response: `Open ${link}`, finishedAt: Date.now() });
    expect((await db.turns(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH))[0]!.response).toContain(`client_id=${CLIENT_ID}&key=[secret api_key]`);
    // A pipe of a public value comes back whole.
    expect((await exitOf(orchestrator.tool(cfg, "secret", { _: ["pipe", "client_id"], "--": ["cat"] }))).text).toBe(CLIENT_ID);

    // A channel never gets a stored value, a public one included.
    expect(secrets.scrubValueAll({ text: link }).text).toBe("https://auth.example/authorize?client_id=[secret client_id]&key=[secret api_key]");
    await orchestrator.tool(cfg, "post", { link: "D1", _: [`open ${link}`] });
    await dispatcher.dispatchOnce();
    expect(sent.at(-1)!.msg.text).not.toContain(CLIENT_ID);
    expect(sent.at(-1)!.msg.text).not.toContain(VALUE);

    // `orca secret mark` (either flag order), the list and the audit.
    expect(await orchestrator.tool(cfg, "secret", { _: ["list"] })).toContain("client_id · public · scope default");
    expect(await orchestrator.tool(cfg, "secret", { _: ["mark", "client_id"], private: "" })).toContain("Marked client_id private");
    expect(secrets.scrub(link)).not.toContain(CLIENT_ID);
    expect(await orchestrator.tool(cfg, "secret", { _: ["mark"], public: "client_id" })).toContain("Marked client_id public");
    expect(secrets.scrub(link)).toContain(CLIENT_ID);
    await expect(orchestrator.tool(cfg, "secret", { _: ["mark", "client_id"], public: "", private: "" })).rejects.toThrow("usage: orca secret mark");
    expect((await db.secretUses()).slice(0, 2).map((u) => u.action)).toEqual(["mark public", "mark private"]);
    // A new value for a public secret keeps the flag; the refresh reads it back from the table.
    await secrets.store({ name: "client_id", value: `${CLIENT_ID}-v2`, who: "t" });
    expect((await db.secrets()).find((s) => s.name === "client_id")!.public).toBe(true);
    await secrets.refresh();
    expect(secrets.scrub(`${CLIENT_ID}-v2`)).toBe(`${CLIENT_ID}-v2`);
  });

  test("a form's secret field takes public: true, stored public; other types refuse it", async () => {
    const out = await orchestrator.tool(cfg, "ask-form", { title: "OAuth app", fields: JSON.stringify([{ name: "client_id", label: "Client id", type: "secret", public: true }, { name: "client_secret", label: "Client secret", type: "secret" }]) });
    const id = out.match(/orca-form:\/\/([\w-]+)/)![1]!;
    const f = await forms.submit(id, { client_id: CLIENT_ID, client_secret: VALUE }, async () => {});
    expect(f.answers).toEqual({ client_id: { name: "client_id", stored: true, public: true }, client_secret: { name: "client_secret", stored: true } });
    expect((await db.secrets()).map((s) => [s.name, s.public])).toEqual([["client_id", true], ["client_secret", false]]);
    await expect(orchestrator.tool(cfg, "ask-form", { title: "x", fields: JSON.stringify([{ name: "a", label: "A", type: "text", public: true }]) })).rejects.toThrow('only a secret field takes "public"');
  });
});

describe("the reveal route (Settings > Secrets and the show card)", () => {
  const routeCfg = { instances: { local: "http://127.0.0.1:8787" } } as unknown as OrcaConfig;
  const browser = { origin: "http://127.0.0.1:8787", host: "127.0.0.1:8787", "sec-fetch-site": "same-origin", "content-type": "application/json" };
  async function reveal(body: Record<string, unknown>, headers: Record<string, string>, remote = "127.0.0.1", identify?: SecretRouteDeps["identify"]) {
    const url = new URL("http://127.0.0.1:8787/api/secrets/reveal");
    const res = await handleSecrets(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }), url, body, { cfg: routeCfg, remote, ...(identify ? { identify } : {}) });
    return { status: res!.status, data: await res!.json() as Record<string, unknown>, cache: res!.headers.get("cache-control") };
  }

  test("only the owner's browser page gets a value; an agent's call, another page or another device is refused", async () => {
    await secrets.store({ name: "api_key", value: VALUE, who: "t" });
    const ok = await reveal({ ref: "api_key" }, browser);
    expect(ok).toEqual({ status: 200, data: { ref: "api_key", value: VALUE }, cache: "no-store" });
    expect((await db.secretUses())[0]).toMatchObject({ action: "reveal", command: "Settings > Secrets", who: "user (loopback)" });

    // bin/orca or curl from a worker: no Origin.
    const { origin: _o, ...noOrigin } = browser;
    expect((await reveal({ ref: "api_key" }, noOrigin)).data.error).toContain("no Origin header");
    // A forged Origin without the browser's own Sec-Fetch-Site.
    const { "sec-fetch-site": _s, ...noFetchSite } = browser;
    expect((await reveal({ ref: "api_key" }, noFetchSite)).status).toBe(403);
    expect((await reveal({ ref: "api_key" }, { ...browser, "sec-fetch-site": "cross-site" })).status).toBe(403);
    // A page on another host.
    expect((await reveal({ ref: "api_key" }, { ...browser, origin: "https://evil.example", host: "127.0.0.1:8787" })).data.error).toContain("cross-origin");
    // Not loopback and not the tailnet; a local proxy that forwards such a caller.
    expect((await reveal({ ref: "api_key" }, browser, "203.0.113.5")).data.error).toContain("not on the tailnet");
    expect((await reveal({ ref: "api_key" }, { ...browser, "x-forwarded-for": "203.0.113.5" })).status).toBe(403);
    // A tailnet device that is not the owner's (the terminal's check, injected here).
    const refused = await reveal({ ref: "api_key" }, browser, "100.100.1.1", async () => ({ ok: false, reason: "ana@x is not this machine's owner" }));
    expect(refused).toMatchObject({ status: 403, data: { error: "Reveal refused: ana@x is not this machine's owner." } });
    const owner = await reveal({ ref: "api_key" }, browser, "100.100.1.2", async () => ({ ok: true, who: "finn@x" }));
    expect(owner.data.value).toBe(VALUE);
    // Every refusal kept the value out; only the two allowed calls wrote an audit row.
    expect((await db.secretUses()).filter((u) => u.action === "reveal")).toHaveLength(2);
    // GET is not a reveal; an unknown name is a 404.
    const url = new URL("http://127.0.0.1:8787/api/secrets/reveal");
    expect((await handleSecrets(new Request(url), url, {}, { cfg: routeCfg, remote: "127.0.0.1" }))!.status).toBe(405);
    expect((await reveal({ ref: "nope" }, browser)).status).toBe(404);
  });
});

describe("orca secret show", () => {
  test("the tool result, the stored transcript and the linked turn hold only the mask and a token; the card's token reveals it", async () => {
    await secrets.store({ name: "api_key", value: VALUE, who: "t" });
    // What the bridge returns to the agent (server/index.ts scrubs every tool answer).
    const out = secrets.scrub(await orchestrator.tool(cfg, "secret", { _: ["show", "api_key"] }));
    expect(out).toContain("Shown to the user in the Orca chat: [secret api_key]");
    expect(out).not.toContain(VALUE);
    const [show] = parseSecretShows(out);
    expect(show!.ref).toBe("api_key");
    expect((await db.secretUses())[0]).toMatchObject({ action: "show", who: "chief" });

    // The run's transcript: the tool result step as stored, and the agent's reply after it.
    const runId = "run-show-1";
    await outbox.startTurn({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH, runId, provider: "claude", instruction: "show me my api key", prompt: "p", startedAt: Date.now() });
    await transcript.append(runId, [
      { at: Date.now(), kind: "tool", id: "t1", name: "Bash", input: { command: "orca secret show api_key" } } as AgentStep,
      { at: Date.now(), kind: "result", id: "t1", output: out } as AgentStep,
    ]);
    await outbox.finishTurn(runId, { status: "done", response: "Here it is: [secret api_key] (see the card).", finishedAt: Date.now() });
    const stored = JSON.stringify({ steps: await db.steps(runId), turns: await db.turns(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH) });
    expect(stored).not.toContain(VALUE);
    expect(stored).toContain("[secret api_key]");

    // /api/turns links the token (checked) to its turn; the chat's card shows it.
    const turns = [{ id: runId }, { id: "run-other" }] as AgentTurn[];
    await secrets.linkTurns(turns);
    expect(turns[0]!.secretShows).toEqual([show!.token]);
    expect(turns[1]!.secretShows).toBeUndefined();
    expect(turnSecretShows({ steps: [{ kind: "result", output: out }] }).map((s) => s.ref)).toEqual(["api_key"]);
    expect(turnSecretShows({ steps: [{ kind: "text", output: out }] })).toEqual([]); // a reply's text is no show

    // The card sends the token to the reveal route: a real one reveals, a forged mac does not.
    const browser = { origin: "http://127.0.0.1:8787", host: "127.0.0.1:8787", "sec-fetch-site": "same-origin" };
    const routeCfg = { instances: { local: "http://127.0.0.1:8787" } } as unknown as OrcaConfig;
    const call = async (token: string) => {
      const url = new URL("http://127.0.0.1:8787/api/secrets/reveal");
      const res = (await handleSecrets(new Request(url, { method: "POST", headers: browser }), url, { token }, { cfg: routeCfg, remote: "127.0.0.1" }))!;
      return { status: res.status, data: await res.json() as Record<string, unknown> };
    };
    expect((await call(show!.token)).data).toEqual({ ref: "api_key", value: VALUE });
    const forged = show!.token.replace(/~[0-9a-f]{16}$/, "~0000000000000000");
    expect((await call(forged)).status).toBe(403);
    await secrets.linkTurns(turns); // a forged token in a step links nothing
    expect(secrets.verifyShowToken(forged)).toBeUndefined();

    // Fresh: the card shows the value at once; a day later it waits for Reveal.
    expect(showFresh(show!.at, show!.at + 60_000)).toBe(true);
    expect(showFresh(show!.at, show!.at + 86_400_000)).toBe(false);
    await expect(orchestrator.tool(cfg, "secret", { _: ["show", "nope"] })).rejects.toThrow('no secret "nope"');
    expect(grantRefusal({ level: "admin", repos: ["r"], linkId: "D1" }, "secret", { _: ["show"] })).toContain("needs your own chat");
  });
});

describe("orca send|spawn --secret", () => {
  let shim: string;
  let prevPath: string | undefined;
  beforeEach(async () => {
    prevPath = process.env.PATH;
    shim = await mkdtemp(join(tmpdir(), "orca-claude-"));
    process.env.PATH = `${shim}:${prevPath}`;
  });
  afterEach(async () => {
    await agent.flushHistory();
    process.env.PATH = prevPath;
    await rm(shim, { recursive: true, force: true });
  });

  test("the value is in that worker run's env, masked in its transcript, turn and report; names only elsewhere", async () => {
    await secrets.store({ name: "test-api-key", value: VALUE, who: "t" });
    // A fake claude: it writes its env to a file (what the process really got), then echoes the key
    // in a tool result and in its reply, as a careless worker would.
    await writeFile(join(shim, "claude"), `#!/bin/sh
printf '%s|%s' "$TEST_API_KEY" "$MY_KEY" > "$PWD/env.out"
printf '%s' "$*" > "$PWD/args.out"
printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"curl -H %s"}}]}}\\n' "$TEST_API_KEY"
printf '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"200 OK for %s"}]}}\\n' "$TEST_API_KEY"
printf '{"type":"result","subtype":"success","result":"tested with %s","is_error":false}\\n' "$TEST_API_KEY"
`);
    await chmod(join(shim, "claude"), 0o755);
    const wt = join(stateDir, "wt-secret");
    await mkdir(wt, { recursive: true });
    await agent.runAgent(wt, "test the API", { repo: "r", branch: "feat", provider: "claude", secrets: ["test-api-key", "test-api-key=MY_KEY"] });
    for (let i = 0; i < 400 && !(await db.turns("r", "feat"))[0]?.finishedAt; i++) await new Promise((r) => setTimeout(r, 25));
    const turn = (await db.turns("r", "feat"))[0]!;

    expect(await readFile(join(wt, "env.out"), "utf8")).toBe(`${VALUE}|${VALUE}`);
    expect(process.env.TEST_API_KEY).toBeUndefined(); // never the bridge's own env
    expect(turn.response).toBe("tested with [secret test-api-key]");
    const stored = JSON.stringify({ steps: await db.steps(turn.id), turn });
    expect(stored).not.toContain(VALUE);
    // The prompt the CLI got names the variables, never a value.
    const args = await readFile(join(wt, "args.out"), "utf8");
    expect(args).toContain("$TEST_API_KEY: the stored secret test-api-key");
    expect(args).toContain("$MY_KEY: the stored secret test-api-key");
    expect(args).not.toContain(VALUE);
    expect((await db.secretUses()).filter((u) => u.action === "worker").map((u) => u.who)).toEqual(["worker r/feat", "worker r/feat"]);

    // The worker report the orchestrator gets is built from the raw reply: scrubbed on the way in.
    await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakes: orchestrator.MAX_WAKES }); // held, not a wake
    await orchestrator.report(cfg, `[worker finished] r/feat — done\nResponse: tested with ${VALUE}`);
    const held = await db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH);
    expect(held.at(-1)!.instruction).toContain("tested with [secret test-api-key]");
    expect(JSON.stringify(held)).not.toContain(VALUE);

    // A queued send keeps the NAMES in its row until it runs, never a value.
    const q = await db.queueMessage({ repo: "r", branch: "feat", worktreePath: wt, instruction: "again", attachments: [], provider: "claude", secrets: ["test-api-key=MY_KEY"] });
    expect((await db.queuedMessages("r", "feat")).find((m) => m.id === q.id)!.secrets).toEqual(["test-api-key=MY_KEY"]);
  });

  test("the tool checks every name before a launch, and an outside sender cannot use the flag", async () => {
    const brief = { repo: "r", title: "Try API", model: "claude-sonnet-5-5", objective: "o", output: "x", boundaries: "b" };
    await expect(orchestrator.tool(cfg, "spawn", { ...brief, secret: "nope" })).rejects.toThrow('no secret "nope"');
    await secrets.store({ name: "k1", value: VALUE, who: "t" });
    await expect(orchestrator.tool(cfg, "spawn", { ...brief, secret: ["k1", "k1"] })).rejects.toThrow("--secret sets K1 twice");
    await expect(orchestrator.tool(cfg, "send", { repo: "r", branch: "feat", secret: "", _: ["hi"] })).rejects.toThrow("--secret needs a name");
    expect(await secrets.checkSpecs(["k1", "k1=OTHER"])).toEqual(["k1 as $K1", "k1 as $OTHER"]);
    for (const verb of ["spawn", "send"]) {
      expect(grantRefusal({ level: "admin", repos: ["r"], linkId: "D1" }, verb, { repo: "r", secret: "k1" })).toContain(`"${verb} --secret" needs your own chat`);
      expect(grantRefusal({ level: "work", repos: ["r"], linkId: "D1" }, verb, { repo: "r" })).toBeUndefined();
    }
    expect(secretEnvNote(["k1=OTHER"])).toContain("$OTHER: the stored secret k1");
    expect(secretEnvNote(undefined)).toBe("");
  });
});
