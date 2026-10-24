// The Gmail adapter (server/integrations/adapters/gmail.ts, docs/integrations/gmail.md): "Connect with
// Google" (code + PKCE, the refresh token in the secret store), the History API poll from a cursor
// with Gmail's own query match, the mail gate, a reply in the Gmail thread, a revoked grant ("reconnect
// needed") and `orca gmail search|read`. Real Postgres, the real registry, router, dispatcher and
// secret store; Google is a fake OAuth + Gmail API on loopback (Bun.serve). No real Google call.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as secrets from "../server/secrets";
import * as router from "../server/integrations/router";
import * as dispatcher from "../server/integrations/dispatcher";
import * as registry from "../server/integrations/registry";
import * as store from "../server/integrations/store";
import * as admin from "../server/integrations/admin";
import { agentEnv } from "../server/env";
import * as secretRefs from "../server/integrations/secretRefs";
import type { Connection } from "../server/integrations/adapter";
import { parseMail } from "../server/integrations/adapters/email/mime";
import { defaultQuery, GMAIL_CAPS, GMAIL_VERBS, gmailConfig, gmailGate, matchQuery, scopeWords } from "../server/integrations/adapters/gmail";
import { authorizeUrl, CALLBACK_PATH, endpoints, fromBase64Url, GOOGLE, pkce, SCOPE, consentScopes, missingScopes, scopesFor, tokenError } from "../server/integrations/adapters/gmail/google";
import * as oauth from "../server/integrations/adapters/gmail/oauth";
import { gmailTool } from "../server/gmailTool";
import * as orchestrator from "../server/orchestrator";
import { grantRefusal, integrationAccessRefusal } from "../shared/integrations";
import { connectOriginProblem } from "../shared/integrationSettings";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const dom = { fetch: globalThis.fetch, Response: globalThis.Response };
beforeAll(() => { Object.assign(globalThis, native); });
afterAll(() => { Object.assign(globalThis, dom); });

const until = async <T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 5_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

const ACCOUNT = "finn@example.com";
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const s256 = (v: string) => createHash("sha256").update(v).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** One RFC 822 mail as Gmail's `raw` holds it. */
function rfc822(o: { id: string; from?: string; to?: string; subject?: string; text?: string; auth?: string; extra?: string[] }): string {
  return [
    ...(o.auth === "" ? [] : [`Authentication-Results: mx.google.com; ${o.auth ?? "dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com"}`]),
    `From: ${o.from ?? "Ana Lee <ana@example.com>"}`, `To: ${o.to ?? "finn+orca@example.com"}`, `Subject: ${o.subject ?? "Fix the login"}`,
    `Date: Sat, 24 Oct 2026 10:00:00 +0000`, `Message-ID: ${o.id}`, ...(o.extra ?? []), "Content-Type: text/plain; charset=utf-8", "", o.text ?? "The login form is broken. Please look.",
  ].join("\r\n");
}

type FakeMsg = { id: string; threadId: string; labelIds: string[]; raw: string; messageId: string; matches: boolean; internalDate: string };

/** A fake Google: the OAuth token + revoke endpoints and the Gmail API, enough for the adapter. */
function fakeGoogle() {
  const st = {
    codes: new Map<string, { challenge: string; scope: string }>(),
    refresh: new Map<string, { revoked: boolean; scope: string }>(),
    access: new Set<string>(),
    messages: [] as FakeMsg[],
    history: [] as { id: number; added: string[] }[],
    historyId: 100,
    sent: [] as { raw: string; threadId?: string }[],
    log: [] as string[],
    nextRefresh: "1//rt-one-refresh-token",
    expireHistory: false,
    n: 0,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/token") {
        const f = new URLSearchParams(await req.text());
        st.log.push(`token ${f.get("grant_type")}`);
        if (f.get("client_id") !== "cid" || f.get("client_secret") !== "client-secret") return Response.json({ error: "invalid_client" }, { status: 401 });
        if (f.get("grant_type") === "authorization_code") {
          const c = st.codes.get(f.get("code") ?? "");
          if (!c || s256(f.get("code_verifier") ?? "") !== c.challenge || !f.get("redirect_uri")?.endsWith(CALLBACK_PATH)) return Response.json({ error: "invalid_grant", error_description: "Bad code or verifier" }, { status: 400 });
          st.codes.delete(f.get("code")!);
          const at = `at-${++st.n}`; st.access.add(at);
          st.refresh.set(st.nextRefresh, { revoked: false, scope: c.scope });
          return Response.json({ access_token: at, expires_in: 3599, refresh_token: st.nextRefresh, scope: c.scope, token_type: "Bearer" });
        }
        const r = st.refresh.get(f.get("refresh_token") ?? "");
        if (!r || r.revoked) return Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 });
        const at = `at-${++st.n}`; st.access.add(at);
        return Response.json({ access_token: at, expires_in: 3599, scope: r.scope, token_type: "Bearer" });
      }
      if (u.pathname === "/revoke") {
        const t = new URLSearchParams(await req.text()).get("token") ?? "";
        st.log.push("revoke");
        const r = st.refresh.get(t); if (r) r.revoked = true;
        return new Response("", { status: r ? 200 : 400 });
      }
      const auth = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!st.access.has(auth)) return Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 });
      const path = u.pathname.replace("/gmail/v1/users/me/", "");
      st.log.push(`${req.method} ${path}${u.searchParams.get("format") ? ` ${u.searchParams.get("format")}` : ""}`);
      if (path === "profile") return Response.json({ emailAddress: ACCOUNT, historyId: String(st.historyId) });
      if (path === "history") {
        if (st.expireHistory) return Response.json({ error: { code: 404, message: "Requested entity was not found." } }, { status: 404 });
        expect(u.searchParams.getAll("historyTypes")).toEqual(["messageAdded", "labelAdded"]);
        const from = Number(u.searchParams.get("startHistoryId"));
        const hs = st.history.filter((h) => h.id > from);
        return Response.json({ historyId: String(st.historyId), history: hs.map((h) => ({ id: String(h.id), messagesAdded: h.added.map((id) => ({ message: { id, threadId: st.messages.find((m) => m.id === id)!.threadId } })) })) });
      }
      if (path === "messages" && req.method === "GET") {
        const q = u.searchParams.get("q") ?? "";
        st.log.push(`q ${q}`);
        const want = [...q.matchAll(/rfc822msgid:(\S+?)(?=[\s}]|$)/g)].map((m) => `<${m[1]}>`);
        const sent = /\bin:sent\b/.test(q);
        const hits = want.length
          ? st.messages.filter((m) => want.includes(m.messageId) && (sent ? m.labelIds.includes("SENT") : m.matches))
          : st.messages.filter((m) => !m.labelIds.includes("SENT") || m.labelIds.includes("INBOX"));
        return Response.json({ messages: hits.slice(0, Number(u.searchParams.get("maxResults") ?? 100)).map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: hits.length });
      }
      if (path === "messages/send") {
        const b = await req.json() as { raw: string; threadId?: string };
        st.sent.push(b);
        const raw = Buffer.from(fromBase64Url(b.raw)).toString("utf8");
        const mid = /^Message-ID: (.+)$/m.exec(raw)![1]!.trim();
        const id = `sent-${st.sent.length}`;
        const threadId = b.threadId ?? `t-${id}`;
        st.messages.push({ id, threadId, labelIds: ["SENT"], raw: b.raw, messageId: mid, matches: false, internalDate: String(Date.now()) });
        return Response.json({ id, threadId, labelIds: ["SENT"] });
      }
      const one = /^messages\/([\w-]+)$/.exec(path);
      if (one) {
        const m = st.messages.find((x) => x.id === one[1]);
        if (!m) return Response.json({ error: { code: 404, message: "Not Found" } }, { status: 404 });
        const base = { id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: m.internalDate, snippet: "The login form is broken" };
        if (u.searchParams.get("format") === "raw") return Response.json({ ...base, raw: m.raw });
        const raw = Buffer.from(fromBase64Url(m.raw)).toString("utf8");
        const names = u.searchParams.getAll("metadataHeaders").map((h) => h.toLowerCase());
        const headers = raw.split("\r\n\r\n")[0]!.split("\r\n").map((l) => { const i = l.indexOf(":"); return { name: l.slice(0, i), value: l.slice(i + 1).trim() }; }).filter((h) => names.includes(h.name.toLowerCase()));
        return Response.json({ ...base, payload: { headers } });
      }
      const thread = /^threads\/([\w-]+)$/.exec(path);
      if (thread) {
        const ms = st.messages.filter((m) => m.threadId === thread[1]);
        return Response.json({ id: thread[1], messages: ms.map((m) => {
          const raw = Buffer.from(fromBase64Url(m.raw)).toString("utf8");
          const heads = raw.split("\r\n\r\n")[0]!.split("\r\n").map((l) => { const i = l.indexOf(":"); return { name: l.slice(0, i), value: l.slice(i + 1).trim() }; });
          return { id: m.id, threadId: m.threadId, payload: { headers: heads.filter((h) => ["message-id", "references", "subject"].includes(h.name.toLowerCase())) } };
        }) });
      }
      return Response.json({ error: { code: 404, message: `no fake for ${path}` } }, { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    st, base,
    /** Gmail gets a new mail: a message and a history record. */
    deliver(o: Parameters<typeof rfc822>[0] & { gid: string; threadId?: string; labels?: string[]; matches?: boolean }) {
      st.messages.push({ id: o.gid, threadId: o.threadId ?? `t-${o.gid}`, labelIds: o.labels ?? ["INBOX", "UNREAD"], raw: b64url(rfc822(o)), messageId: o.id, matches: o.matches ?? true, internalDate: String(Date.UTC(2026, 9, 24, 10)) });
      st.history.push({ id: ++st.historyId, added: [o.gid] });
    },
    /** The user at Google's consent screen: allow, and send the browser back with a code. */
    consent(url: string, scope?: string): URLSearchParams {
      const u = new URL(url);
      const code = `code-${++st.n}`;
      st.codes.set(code, { challenge: u.searchParams.get("code_challenge")!, scope: scope ?? u.searchParams.get("scope")! });
      return new URLSearchParams({ code, state: u.searchParams.get("state")!, scope: u.searchParams.get("scope")! });
    },
    expireAccessTokens() { st.access.clear(); },
    stop: () => server.stop(true),
  };
}

describe("decisions (pure)", () => {
  test("the config: client id required, auth checked by default, form strings parsed", () => {
    expect(gmailConfig({})).toEqual({ error: expect.stringContaining("clientId") });
    expect(gmailConfig({ clientId: "cid" })).toEqual({ config: { clientId: "cid", pollSeconds: 30, allowedSenders: [], checkAuth: true, keepQuoted: false } });
    expect(gmailConfig({ clientId: "cid", checkAuth: "false", pollSeconds: "30", allowedSenders: "Ana@Example.com, @acme.test", query: "label:work" }))
      .toMatchObject({ config: { checkAuth: false, pollSeconds: 30, allowedSenders: ["ana@example.com", "@acme.test"], query: "label:work" } });
    // The poll interval: 30 s by default, never below 10 s (only the tests' fake Gmail may go faster).
    expect(gmailConfig({ clientId: "cid", pollSeconds: "5" })).toMatchObject({ config: { pollSeconds: 10 } });
    expect(gmailConfig({ clientId: "cid", pollSeconds: "45" })).toMatchObject({ config: { pollSeconds: 45 } });
    expect(gmailConfig({ clientId: "cid", pollSeconds: "0.05", apiUrl: "http://127.0.0.1:1" })).toMatchObject({ config: { pollSeconds: 0.05 } });
  });

  test("scopes follow access: read = openid, userinfo.email, gmail.readonly; read-write adds gmail.send; never modify", () => {
    expect(scopesFor("read")).toEqual(["openid", "https://www.googleapis.com/auth/userinfo.email", SCOPE.readonly]);
    expect(scopesFor("read-write")).toEqual([...scopesFor("read"), SCOPE.send]);
    expect([...scopesFor("read"), ...scopesFor("read-write")].join(" ")).not.toMatch(/modify|compose/);
    expect(scopeWords([SCOPE.readonly])).toBe("read only");
    expect(scopeWords([SCOPE.readonly, SCOPE.send])).toBe("read + send");
    // The account's access comes from the access policy's field on the row; without it, read.
    expect(oauth.gmailAccess({ kind: "gmail" })).toBe("read");
    expect(oauth.gmailAccess({ kind: "gmail", access: "read-write" })).toBe("read-write");
    expect(GMAIL_CAPS.outbound).toBe(false);
    expect(GMAIL_VERBS).toEqual({ search: "read", read: "read" });
  });

  test("incremental consent: a switch to read-write asks Google only for gmail.send; a first or refused grant asks for all", () => {
    const read = scopesFor("read");
    expect(consentScopes("read")).toEqual(read); // first connect
    expect(consentScopes("read-write", read)).toEqual([SCOPE.send]); // the upgrade: only the extra scope
    expect(consentScopes("read-write", read, true)).toEqual(scopesFor("read-write")); // reconnect needed: all
    expect(consentScopes("read", read)).toEqual(read); // a plain reconnect: the same set
    expect(missingScopes("read-write", read)).toEqual([SCOPE.send]);
    expect(missingScopes("read-write", scopesFor("read-write"))).toEqual([]);
    // The card: missing scopes only for a connected account.
    expect(oauth.cardOAuth({ kind: "gmail", access: "read-write" }, { account: ACCOUNT, scopes: read })?.missing).toEqual([SCOPE.send]);
    expect(oauth.cardOAuth({ kind: "gmail" }, { account: ACCOUNT, scopes: read })?.missing).toEqual([]);
    expect(oauth.cardOAuth({ kind: "gmail", access: "read-write" }, null)).toBeUndefined();
  });

  test("the redirect origin: https on a domain name only; plain http, localhost and IPs are refused with where to go", () => {
    expect(connectOriginProblem("https://orca.example.ts.net")).toBeUndefined();
    expect(connectOriginProblem("https://orca.example.ts.net:8443")).toBeUndefined();
    expect(connectOriginProblem("http://orca.example.ts.net", "https://orca.example.ts.net")).toBe("Connect with Google works only from Orca's https address: Google refuses a redirect to http://orca.example.ts.net (plain http). Open https://orca.example.ts.net/integrations and connect there.");
    expect(connectOriginProblem("http://127.0.0.1:8787")).toContain("(plain http)");
    expect(connectOriginProblem("https://localhost:8787")).toContain("(localhost)");
    expect(connectOriginProblem("https://100.64.0.1")).toContain("(an IP address)");
    expect(connectOriginProblem("https://orca.example.ts.net/integrations")).toContain("is not an origin");
    expect(connectOriginProblem(undefined)).toContain("is not one");
  });

  test("the core's account policy: Gmail declares both verbs as reads, and a read account still searches and reads", () => {
    expect(registry.verbsFor("gmail")).toEqual({ search: "read", read: "read" });
    for (const verb of ["search", "read"]) expect(integrationAccessRefusal({ id: "gm", kind: "gmail", access: "read" }, verb, registry.verbsFor("gmail"))).toBeUndefined();
    expect(integrationAccessRefusal({ id: "gm", kind: "gmail", access: "read" }, "send", registry.verbsFor("gmail"))).toContain("has read access");
  });

  test("PKCE: S256 of the verifier; the consent URL asks for offline access with the challenge", () => {
    const p = pkce();
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.challenge).toBe(s256(p.verifier));
    const u = new URL(authorizeUrl({ auth: GOOGLE.auth }, { clientId: "cid", redirectUri: `https://orca.example.ts.net${CALLBACK_PATH}`, scopes: scopesFor("read"), state: "gm~abc", challenge: p.challenge }));
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "cid", redirect_uri: "https://orca.example.ts.net/api/integrations/oauth/google/callback", response_type: "code", scope: scopesFor("read").join(" "),
      state: "gm~abc", code_challenge: p.challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent", include_granted_scopes: "true",
    });
    expect(endpoints({})).toEqual({ auth: GOOGLE.auth, token: GOOGLE.token, revoke: GOOGLE.revoke, api: GOOGLE.api });
  });

  test("a token error: invalid_grant means reconnect; a 5xx is retryable; the text never holds the request", () => {
    expect(tokenError(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })).toMatchObject({ reconnect: true, retryable: false });
    expect(tokenError(503, {})).toMatchObject({ reconnect: false, retryable: true });
    expect(tokenError(401, { error: "invalid_client" }).message).toContain("client secret");
  });

  test("the default query is the Orca label or the +orca alias; a match query adds the new Message-IDs as one OR group", () => {
    expect(defaultQuery("Finn@Example.com")).toBe("label:Orca OR to:finn+orca@example.com");
    expect(matchQuery("label:Orca", ["<a@x>", "<b@y>"])).toBe("(label:Orca) {rfc822msgid:a@x rfc822msgid:b@y}");
  });

  test("the mail gate: drafts, sent copies, automated mail, unlisted and unauthenticated senders stay out; a note to your own alias is in", () => {
    const cfg = { allowedSenders: [] as string[], checkAuth: true };
    const m = (o: Parameters<typeof rfc822>[0]) => parseMail(new TextEncoder().encode(rfc822(o)));
    expect(gmailGate(m({ id: "<1@x>" }), ["INBOX"], cfg, ACCOUNT)).toBeUndefined();
    expect(gmailGate(m({ id: "<1@x>" }), ["DRAFT"], cfg, ACCOUNT)).toBe("a draft");
    expect(gmailGate(m({ id: "<1@x>", from: ACCOUNT }), ["SENT"], cfg, ACCOUNT)).toContain("you sent");
    expect(gmailGate(m({ id: "<1@x>", extra: ["Auto-Submitted: auto-generated"] }), ["INBOX"], cfg, ACCOUNT)).toContain("automated");
    expect(gmailGate(m({ id: "<1@x>" }), ["INBOX"], { ...cfg, allowedSenders: ["@acme.test"] }, ACCOUNT)).toContain("not in allowedSenders");
    expect(gmailGate(m({ id: "<1@x>", auth: "dkim=fail; spf=fail smtp.mailfrom=evil.test" }), ["INBOX"], cfg, ACCOUNT)).toContain("no aligned pass");
    expect(gmailGate(m({ id: "<1@x>", auth: "dkim=fail" }), ["INBOX"], { ...cfg, checkAuth: false }, ACCOUNT)).toBeUndefined();
    expect(gmailGate(m({ id: "<1@x>", from: ACCOUNT, auth: "" }), ["SENT", "INBOX"], cfg, ACCOUNT)).toBeUndefined();
  });

  test("orca gmail is the owner's own chat only: every outside grant is refused", () => {
    for (const level of ["notify", "ask", "work", "admin"] as const) expect(grantRefusal({ level, repos: ["r"], linkId: "L" }, "gmail", { _: ["search", "x"] })).toContain("needs your own chat");
    expect(grantRefusal({ level: "full", repos: [] }, "gmail", { _: ["read", "m1"] })).toBeUndefined();
  });

  test("the Google client secret never reaches an agent", () => {
    process.env.ORCA_SECRET_GOOGLE_OAUTH = "client-secret";
    try { expect(agentEnv().ORCA_SECRET_GOOGLE_OAUTH).toBeUndefined(); } finally { delete process.env.ORCA_SECRET_GOOGLE_OAUTH; }
  });
});

describe("against a fake Google", () => {
  let pg: TestDb;
  let g: ReturnType<typeof fakeGoogle>;
  let stateDir: string;
  let prev: Record<string, string | undefined>;
  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE, ORCA_STATE_DIR: process.env.ORCA_STATE_DIR, ORCA_SECRETS_KEY: process.env.ORCA_SECRETS_KEY };
    process.env.ORCA_INSTANCE = "local";
    delete process.env.ORCA_SECRETS_KEY;
    stateDir = await mkdtemp(join(tmpdir(), "orca-gmail-"));
    process.env.ORCA_STATE_DIR = stateDir;
    process.env.ORCA_SECRET_GOOGLE_OAUTH = "client-secret";
    pg = await freshSchema("gmail");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    router.resetPace();
    dispatcher.resetPace();
    oauth.resetTokens();
    secretRefs.clear();
    g = fakeGoogle();
  });
  afterEach(async () => {
    await registry.stopAll();
    dispatcher.configure({ adapter: () => undefined });
    dispatcher.setRunning(() => []);
    g.stop();
    await db.close();
    await pg.drop();
    await rm(stateDir, { recursive: true, force: true });
    delete process.env.ORCA_SECRET_GOOGLE_OAUTH;
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const conn = (extra: Record<string, unknown> = {}): Connection => ({
    id: "gm", kind: "gmail", name: "smfstudio", instance: "local", enabled: true, access: "read", events: "trigger",
    config: { clientId: "cid", pollSeconds: "0.05", authUrl: `${g.base}/auth`, tokenUrl: `${g.base}/token`, apiUrl: g.base, revokeUrl: `${g.base}/revoke`, ...extra },
  });
  const setup = async (extra: Record<string, unknown> = {}) => {
    const c = conn(extra);
    await store.addIntegration(c);
    await store.addLink({ id: "G1", integrationId: "gm", externalId: "ana@example.com", level: "work", repos: ["r"], requireMention: false });
    await store.addLink({ id: "GALL", integrationId: "gm", externalId: "*", level: "ask", repos: [], requireMention: false });
    await store.addPrincipal({ id: "ana", name: "Ana", maxLevel: "work" }, [{ adapter: "gmail", externalId: "ana@example.com" }]);
    return c;
  };
  const connect = async (origin = "https://orca.example.ts.net", id = "gm") => {
    const { url, redirectUri } = await oauth.begin(id, origin);
    expect(redirectUri).toBe(`${origin}${CALLBACK_PATH}`);
    return oauth.finish(g.consent(url));
  };
  const cursor = async () => JSON.parse((await store.cursor("gm")) ?? "{}") as { historyId?: string; account?: string };

  test("Connect with Google: PKCE, a one-use state, the refresh token encrypted in the secret store and nowhere else", async () => {
    await setup();
    const { url } = await oauth.begin("gm", "https://orca.example.ts.net");
    const q = new URL(url).searchParams;
    expect(url.startsWith(`${g.base}/auth?`)).toBe(true);
    expect(q.get("scope")).toBe(scopesFor("read").join(" ")); // a row with no access policy is read: no gmail.send
    expect(q.get("include_granted_scopes")).toBe("true");
    expect(q.get("state")).toMatch(/^gm~[0-9a-f]{32}$/);
    // The pending state is encrypted: the verifier is not in the database as text.
    const pending = (await store.cursor("gm:oauth"))!;
    expect(pending.startsWith("v1:")).toBe(true);

    // A forged callback (wrong state) is refused and leaves the real sign-in usable.
    const back = g.consent(url);
    const forged = new URLSearchParams(back); forged.set("state", "gm~00000000000000000000000000000000");
    await expect(oauth.finish(forged)).rejects.toMatchObject({ code: "state" });
    const r = await oauth.finish(back);
    expect(r).toMatchObject({ id: "gm", account: ACCOUNT, scopes: scopesFor("read") });
    expect(g.st.log).toContain("token authorization_code"); // the fake checked S256(verifier) = challenge
    await expect(oauth.finish(back)).rejects.toMatchObject({ code: "state" }); // one use

    // The refresh token: a stored secret in the integrations scope, ciphertext only.
    const rows = await secrets.list();
    expect(rows.map((x) => `${x.scope}/${x.name}`)).toEqual(["integrations/gmail.gm.refresh_token"]);
    const cipher = await db.withRetry(async (sql) => (await sql`SELECT ciphertext FROM secret`) as { ciphertext: string }[]);
    expect(cipher[0]!.ciphertext).not.toContain("1//rt-one-refresh-token");
    expect(await secrets.valueOf("integrations/gmail.gm.refresh_token")).toBe("1//rt-one-refresh-token");
    expect(secrets.scrub("token 1//rt-one-refresh-token leaked")).toBe("token [secret integrations/gmail.gm.refresh_token] leaked");
    const status = await db.withRetry(async (sql) => ((await sql`SELECT status FROM integration WHERE id = 'gm'`) as { status: unknown }[])[0]!.status);
    expect(JSON.stringify(status)).not.toContain("1//rt-one-refresh-token");
    expect(JSON.stringify(status)).not.toContain("at-");

    // Settings shows the account and the scopes on the card.
    const card = (await admin.overview()).integrations.find((c) => c.id === "gm")!;
    expect(card.oauth).toMatchObject({ account: ACCOUNT, scopes: scopesFor("read"), reconnect: null, missing: [] });
    expect((await admin.overview()).kinds.find((k) => k.kind === "gmail")).toMatchObject({ oauth: { provider: "google", label: "Connect with Google" }, switches: { checkAuth: true }, policyDefaults: { access: "read", events: "off" } });
  });

  test("the client secret by the core's shared secret refs: secret_ref secret:<scope>/<name> (a /secret value) wins over the env var", async () => {
    delete process.env.ORCA_SECRET_GOOGLE_OAUTH;
    await secrets.store({ scope: "chat", name: "google-oauth-secret", value: "client-secret", who: "test" });
    const c: Connection = { ...conn(), secretRef: "secret:chat/google-oauth-secret" };
    await store.addIntegration(c);
    expect((await connect()).account).toBe(ACCOUNT);
    process.env.ORCA_SECRET_GOOGLE_OAUTH = "wrong-secret";
    oauth.resetTokens();
    expect(await oauth.accessToken(c)).toMatch(/^at-/);
    await store.addIntegration({ ...conn(), id: "gm3", secretRef: "secret:chat/nope" });
    await expect(oauth.begin("gm3", "https://orca.example.ts.net")).rejects.toThrow('no secret "chat/nope"');
  });

  test("a missing client secret or client id fails at Start, before the user goes to Google; a denied consent says so", async () => {
    await setup();
    delete process.env.ORCA_SECRET_GOOGLE_OAUTH;
    await expect(oauth.begin("gm", "https://orca.example.ts.net")).rejects.toThrow("ORCA_SECRET_GOOGLE_OAUTH is not set");
    process.env.ORCA_SECRET_GOOGLE_OAUTH = "client-secret"; // the variable path: unchanged
    const { url } = await oauth.begin("gm", "https://orca.example.ts.net");
    const denied = new URLSearchParams({ error: "access_denied", state: new URL(url).searchParams.get("state")! });
    await expect(oauth.finish(denied)).rejects.toThrow("you did not allow access");
    await store.addIntegration({ ...conn({ clientId: "" }), id: "gm2" });
    await expect(oauth.begin("gm2", "https://x.ts.net")).rejects.toThrow("clientId");
    await expect(oauth.begin("gm", "not an origin")).rejects.toThrow("is not one");
    // Never the bridge's own loopback or plain http; the message names the https address to open.
    process.env.ORCA_SERVER_URL = "https://orca.example.ts.net";
    try {
      await expect(oauth.begin("gm", "http://127.0.0.1:8787")).rejects.toThrow("Open https://orca.example.ts.net/integrations and connect there.");
      await expect(oauth.begin("gm", "http://orca.example.ts.net")).rejects.toThrow("(plain http)");
    } finally { delete process.env.ORCA_SERVER_URL; }
    // A configured public base (redirectOrigin) wins over the page's origin.
    await store.addIntegration({ ...conn({ redirectOrigin: "https://orca.example.ts.net/" }), id: "gm4" });
    expect((await oauth.begin("gm4", "http://127.0.0.1:8787")).redirectUri).toBe(`https://orca.example.ts.net${CALLBACK_PATH}`);
    await store.addIntegration({ ...conn({ redirectOrigin: "http://orca.example.ts.net" }), id: "gm5" });
    await expect(oauth.begin("gm5", "https://orca.example.ts.net")).rejects.toThrow("config.redirectOrigin: ");
  });

  test("the poll: starts at now, reads only mail the query matches, gates it, and hands it to the core as ext.gmail.message", async () => {
    const c = await setup();
    g.deliver({ gid: "old", id: "<old@example.com>", text: "from before Orca listened" });
    expect(await registry.startOne(c)).toBe(true);
    // Not connected yet: a state on the card, not a failed start.
    await until(async () => (await registry.health()).gm?.detail?.includes("Connect with Google"));
    await connect();
    await until(async () => (await cursor()).historyId === "101");

    g.deliver({ gid: "m1", id: "<m1@example.com>", threadId: "t-a", subject: "Fix the login" });
    g.deliver({ gid: "m2", id: "<m2@example.com>", subject: "Your bank statement", matches: false }); // not for Orca
    g.deliver({ gid: "m3", id: "<m3@example.com>", auth: "dkim=fail; spf=fail smtp.mailfrom=evil.test" }); // forged
    g.deliver({ gid: "m4", id: "<m4@example.com>", from: ACCOUNT, to: "finn+orca@example.com", subject: "Note to self", auth: "", labels: ["SENT", "INBOX"] });
    const ev = await until(() => store.event("gmail:gm:m1"));
    expect(ev).toMatchObject({
      topic: "ext.gmail.message", title: "Fix the login", text: "Subject: Fix the login\n\nThe login form is broken. Please look.",
      source: { adapter: "gmail", integrationId: "gm", channel: "ana@example.com", linkId: "G1" },
      actor: { principalId: "ana", external: { adapter: "gmail", id: "ana@example.com", name: "Ana Lee" } },
      thread: { adapter: "gmail", externalId: "t-a", messageId: "m1" },
      grant: { level: "work", repos: ["r"] },
      link: { url: "https://mail.google.com/mail/u/finn%40example.com/#all/t-a" },
    });
    await until(() => store.event("gmail:gm:m4"));
    await until(async () => (await cursor()).historyId === "105");
    expect(await store.event("gmail:gm:m2")).toBeUndefined();
    expect(await store.event("gmail:gm:m3")).toBeUndefined();
    expect(await store.event("gmail:gm:old")).toBeUndefined();
    // Privacy: the mail the query did not match was never read, only its Message-ID header.
    expect(g.st.log).not.toContain("GET messages/m2 raw");
    expect(g.st.log).toContain("GET messages/m2 metadata");
    expect(g.st.log.some((l) => l.startsWith("q (label:Orca OR to:finn+orca@example.com) {rfc822msgid:m1@example.com"))).toBe(true);
    expect((await registry.health()).gm).toMatchObject({ kind: "gmail", ok: true, detail: expect.stringContaining(`watching ${ACCOUNT}`) });

    // A quiet tick is ONE users.history.list call and nothing else.
    const before = g.st.log.length;
    await Bun.sleep(300);
    const quiet = g.st.log.slice(before);
    expect(quiet.length).toBeGreaterThanOrEqual(2);
    expect(new Set(quiet)).toEqual(new Set(["GET history"]));

    // A cursor older than Gmail's history: resume from now, read nothing old.
    g.st.expireHistory = true;
    await until(async () => (await registry.health()).gm?.detail?.includes("history expired"));
  });

  test("read only: Orca sends no mail and makes no write call to Gmail (nothing is marked read), also for a subscribed event", async () => {
    const c = await setup();
    await connect();
    expect(await registry.startOne(c)).toBe(true);
    await until(async () => (await cursor()).historyId);
    g.deliver({ gid: "m1", id: "<m1@example.com>", subject: "Fix the login" });
    await until(() => store.event("gmail:gm:m1"));
    const adapter = registry.adapterFor("gm")!;
    expect(adapter.caps.outbound).toBe(false);
    expect(await adapter.send({ externalId: "ana@example.com", threadId: "t-m1" }, { text: "hi" }, "k1")).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining("send verb is not built") });
    dispatcher.configure({ adapter: (i) => registry.adapterFor(i) });
    dispatcher.setRunning(registry.runningIds);
    await store.addSubscription({ topicPattern: "orca.run.*", filter: { repo: "r" }, targetKind: "link", targetId: "G1" });
    await router.publish({ key: "run:1:finished", topic: "orca.run.finished", at: 1, source: { adapter: "orca" }, scope: { repo: "r", branch: "b" }, title: "Fix login", text: "Done." });
    await dispatcher.dispatchOnce();
    expect(g.st.sent).toHaveLength(0);
    // Every Gmail API call was a GET: no send, no modify, no label change.
    expect(g.st.log.filter((l) => /^(POST|PUT|PATCH|DELETE) /.test(l))).toEqual([]);
    expect(g.st.messages.find((m) => m.id === "m1")!.labelIds).toContain("UNREAD");
  });

  test("two named accounts: smfstudio (events trigger) wakes Orca; personal (events off) makes no Gmail call and brings no event", async () => {
    const c = await setup();
    const personal: Connection = { ...conn(), id: "personal", name: "personal", events: "off" };
    await store.addIntegration(personal);
    await store.addLink({ id: "P1", integrationId: "personal", externalId: "*", level: "ask", repos: [], requireMention: false });
    await connect();
    g.st.nextRefresh = "1//rt-personal-refresh-token";
    await connect("https://orca.example.ts.net", "personal");
    expect((await secrets.list()).map((x) => x.name).sort()).toEqual(["gmail.gm.refresh_token", "gmail.personal.refresh_token"]);

    expect(await registry.startOne(personal)).toBe(true);
    expect(await registry.startOne(c)).toBe(true);
    expect((await registry.health()).personal).toMatchObject({ ok: true, detail: "events off: no poll (orca gmail search and read still work)" });
    await until(async () => (await cursor()).historyId);
    g.deliver({ gid: "m1", id: "<m1@example.com>", subject: "Fix the login" });
    const ev = await until(() => store.event("gmail:gm:m1"));
    expect(ev.source.integrationId).toBe("gm");
    expect((await store.deliveries()).some((d) => d.envelope.key === ev.key && d.target.kind === "orchestrator")).toBe(true);
    await Bun.sleep(200);
    expect(await store.event("gmail:personal:m1")).toBeUndefined();
    expect(await store.cursor("personal")).toBeUndefined(); // it never polled
  });

  test("a revoked grant: the card says reconnect needed, Google is not asked again with that token, and a Reconnect brings it back", async () => {
    const c = await setup();
    await connect();
    expect(await registry.startOne(c)).toBe(true);
    await until(async () => (await registry.health()).gm?.ok);

    // The user removes Orca at myaccount.google.com: the refresh token is revoked, access tokens end.
    g.st.refresh.get("1//rt-one-refresh-token")!.revoked = true;
    g.expireAccessTokens();
    oauth.resetTokens(); // as after an hour: the cached access token has expired
    await until(async () => (await registry.health()).gm?.detail?.startsWith("reconnect needed"));
    const refreshes = () => g.st.log.filter((l) => l === "token refresh_token").length;
    const n = refreshes();
    await Bun.sleep(300); // several polls
    expect(refreshes()).toBe(n);
    const card = (await admin.overview()).integrations.find((x) => x.id === "gm")!;
    expect(card.oauth?.reconnect).toContain("reconnect needed");
    expect(card.health).toMatchObject({ ok: false });

    g.st.nextRefresh = "1//rt-two-refresh-token";
    await connect();
    await until(async () => (await registry.health()).gm?.ok);
    expect(await secrets.valueOf("integrations/gmail.gm.refresh_token")).toBe("1//rt-two-refresh-token");
    expect((await admin.overview()).integrations.find((x) => x.id === "gm")!.oauth).toMatchObject({ account: ACCOUNT, reconnect: null });
  });

  test("a new Gmail row is read + events off unless the form says otherwise; an edit keeps the stored policy", async () => {
    await admin.saveIntegration({ id: "personal", kind: "gmail", name: "personal", instance: "local", config: { clientId: "cid" } });
    expect(await store.integration("personal")).toMatchObject({ access: "read", events: "off" });
    await admin.saveIntegration({ id: "work", kind: "gmail", name: "work", instance: "local", config: { clientId: "cid" }, events: "trigger" });
    expect(await store.integration("work")).toMatchObject({ access: "read", events: "trigger" });
    await admin.setPolicy({ id: "personal", events: "record" });
    await admin.saveIntegration({ id: "personal", kind: "gmail", name: "Personal mail", instance: "local", config: { clientId: "cid" } });
    expect(await store.integration("personal")).toMatchObject({ name: "Personal mail", access: "read", events: "record" });
  });

  test("a switch to read-write asks Google ONLY for gmail.send (incremental); a switch to events trigger starts the poll at once", async () => {
    await setup();
    const personal: Connection = { ...conn(), id: "personal", name: "personal", events: "off" };
    await store.addIntegration(personal);
    await connect("https://orca.example.ts.net", "personal");
    expect(await registry.startOne(personal)).toBe(true);
    await until(async () => (await registry.health()).personal?.detail?.startsWith("events off"));
    expect((await admin.overview()).integrations.find((x) => x.id === "personal")!.oauth?.missing).toEqual([]);

    // Settings: Access → Read and write. The card asks for a reconnect; Google is asked for the one new scope.
    await admin.setPolicy({ id: "personal", access: "read-write" });
    expect((await admin.overview()).integrations.find((x) => x.id === "personal")!.oauth?.missing).toEqual([SCOPE.send]);
    const { url } = await oauth.begin("personal", "https://orca.example.ts.net");
    expect(new URL(url).searchParams.get("scope")).toBe(SCOPE.send);
    expect(new URL(url).searchParams.get("include_granted_scopes")).toBe("true");
    g.st.nextRefresh = "1//rt-personal-rw-refresh-token";
    const r = await oauth.finish(g.consent(url, [...scopesFor("read"), SCOPE.send].join(" ")));
    expect(r.scopes).toEqual(scopesFor("read-write"));
    expect((await admin.overview()).integrations.find((x) => x.id === "personal")!.oauth?.missing).toEqual([]);

    // Settings: Events → Wake an agent. The running adapter polls from its next tick, no restart.
    expect(await store.cursor("personal")).toBeUndefined();
    await admin.setPolicy({ id: "personal", events: "trigger" });
    await until(async () => (await store.cursor("personal")) !== undefined);
  });

  test("Disconnect and Remove revoke the grant at Google and delete the stored refresh token", async () => {
    await setup();
    await connect();
    expect(await oauth.disconnect("gm")).toEqual({ revoked: true });
    expect(g.st.refresh.get("1//rt-one-refresh-token")!.revoked).toBe(true);
    expect(await secrets.list()).toEqual([]);
    expect((await admin.overview()).integrations.find((x) => x.id === "gm")!.oauth).toBeUndefined();
    await expect(oauth.accessToken(conn())).rejects.toMatchObject({ code: "not_connected" });

    g.st.nextRefresh = "1//rt-three-refresh-token";
    await connect();
    await admin.removeIntegration("gm");
    expect(g.st.refresh.get("1//rt-three-refresh-token")!.revoked).toBe(true);
    expect(await secrets.list()).toEqual([]);
    expect(await store.cursor("gm:oauth")).toBeUndefined();
  });

  test("orca gmail search and read: the orchestrator reads the connected mailbox, read only", async () => {
    await setup();
    g.deliver({ gid: "m1", id: "<m1@example.com>", threadId: "t-a", subject: "Fix the login" });
    await expect(gmailTool({ _: ["search", "from:ana"] })).rejects.toThrow("Connect with Google");
    await connect();
    const found = await gmailTool({ _: ["search", "from:ana", "newer_than:7d"], limit: "5" });
    expect(found).toContain("1 message for \"from:ana newer_than:7d\":");
    expect(found).toContain("m1 · thread t-a");
    expect(found).toContain("Ana Lee <ana@example.com>");
    expect(g.st.log).toContain("q from:ana newer_than:7d");
    const one = await gmailTool({ _: ["read", "m1"] });
    expect(one).toContain("From: Ana Lee <ana@example.com>");
    expect(one).toContain("Subject: Fix the login");
    expect(one).toContain("The login form is broken. Please look.");
    expect(one.split("\n")[0]).toBe("Gmail account smfstudio (gm)");
    await expect(gmailTool({ _: ["send", "x"] })).rejects.toThrow("read only");
    await expect(gmailTool({ _: ["read", "m1"], account: "" })).rejects.toThrow("--account needs");

    // A second account: --account picks one by id or name (any case); none named is an error, never a guess.
    await store.addIntegration({ ...conn(), id: "personal", name: "personal", events: "off" });
    g.st.nextRefresh = "1//rt-personal-refresh-token";
    await connect("https://orca.example.ts.net", "personal");
    await expect(gmailTool({ _: ["read", "m1"] })).rejects.toThrow("2 gmail accounts are connected (gm (smfstudio), personal): name one with --account <id>");
    expect((await gmailTool({ _: ["read", "m1"], account: "personal" })).split("\n")[0]).toBe("Gmail account personal");
    expect((await gmailTool({ _: ["search", "from:ana"], account: "SMFStudio" })).split("\n")[0]).toBe("Gmail account smfstudio (gm)");
    await expect(gmailTool({ _: ["read", "m1"], account: "work" })).rejects.toThrow('no gmail account "work"');
    // Through the orchestrator's tool route: your own chat may, an outside sender may not.
    const cfg = { repos: [], portRange: [0, 0], staleHours: 1 } as never;
    expect(await orchestrator.tool(cfg, "gmail", { _: ["read", "m1"], account: "personal" })).toContain("Subject: Fix the login");
  });
});
