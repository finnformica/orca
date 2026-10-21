// The server switcher (server/servers.ts): discovery of the other Orca servers, CORS for their pages
// only, and the Tailscale whois check that lets a user device in and keeps a server (a tagged node)
// out. The `tailscale` CLI is a fake script on ORCA_TAILSCALE_BIN and the Tailscale API is a fake
// Bun.serve on TS_API_URL — no network, no tailnet.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forwardedHeaders, listServers, resetServerCaches, serverGate, withSelf, serverSwitcherProblems, trustedOrigin, type ServerSwitcherConfig,
} from "../server/servers";
import { parseConfigDocument } from "../server/config";
import { native } from "./happydom";

// Bun's own fetch/Request/Response, not happy-dom's: this drives the bridge's network code, and
// happy-dom's Request drops the Origin header (a forbidden header in a browser). Put back after.
const domGlobals = Object.fromEntries(Object.keys(native).map((k) => [k, (globalThis as Record<string, unknown>)[k]]));
Object.assign(globalThis, native);

const dir = mkdtempSync(join(tmpdir(), "orca-servers-"));
const callLog = join(dir, "calls.log");
const bin = join(dir, "tailscale");
// `status --json` names this node; `whois --json <ip>` answers from whois-<ip>.json, else fails.
writeFileSync(bin, `#!/bin/sh
echo "$*" >> "${callLog}"
if [ "$1" = status ]; then echo '{"Self":{"DNSName":"box-a.tail1234.ts.net."}}'; exit 0; fi
if [ "$1" = whois ] && [ -f "${dir}/whois-$3.json" ]; then cat "${dir}/whois-$3.json"; exit 0; fi
echo "no such peer" >&2; exit 1
`);
chmodSync(bin, 0o755);
const whois = (ip: string, body: unknown) => writeFileSync(join(dir, `whois-${ip}.json`), JSON.stringify(body));
const calls = () => (existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean) : []);

whois("100.64.0.5", { Node: { Name: "finns-laptop.tail1234.ts.net.", Tags: [] }, UserProfile: { LoginName: "finn@example.com" } });
whois("100.64.0.9", { Node: { Name: "box-b.tail1234.ts.net.", Tags: ["tag:orca"] }, UserProfile: { LoginName: "tagged-devices" } });

const SAVED = ["ORCA_TAILSCALE_BIN", "ORCA_SERVER_URL", "ORCA_INSTANCE", "TS_OAUTH_CLIENT_ID", "TS_OAUTH_CLIENT_SECRET", "TS_API_URL"] as const;
const saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));

// The fake Tailscale API: an OAuth token endpoint and the device list.
let apiHits = { token: 0, devices: 0 };
let lastTokenBody = "";
let lastAuth = "";
let failDevices = false;
const now = Date.now();
const api = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "POST" && u.pathname === "/api/v2/oauth/token") {
      apiHits.token++;
      lastTokenBody = await req.text();
      return Response.json({ access_token: "tok-123", token_type: "Bearer", expires_in: 3600 });
    }
    if (req.method === "GET" && u.pathname === "/api/v2/tailnet/-/devices") {
      apiHits.devices++;
      lastAuth = req.headers.get("authorization") ?? "";
      if (failDevices) return new Response("nope", { status: 500 });
      return Response.json({ devices: [
        { name: "box-a.tail1234.ts.net", hostname: "box-a", tags: ["tag:orca"], connectedToControl: true },
        { name: "box-b.tail1234.ts.net", hostname: "box-b", tags: ["tag:orca"], connectedToControl: false, lastSeen: new Date(now - 3_600_000).toISOString() },
        { name: "smf.tail1234.ts.net", hostname: "smf", tags: ["tag:orca"], lastSeen: new Date(now - 30_000).toISOString() },
        { name: "finns-laptop.tail1234.ts.net", hostname: "finns-laptop", connectedToControl: true },
        { name: "db.tail1234.ts.net", hostname: "db", tags: ["tag:db"], connectedToControl: true },
      ] });
    }
    return new Response("not found", { status: 404 });
  },
});

beforeEach(() => {
  process.env.ORCA_TAILSCALE_BIN = bin;
  process.env.ORCA_INSTANCE = "box-a";
  process.env.ORCA_SERVER_URL = "http://box-a.tail1234.ts.net:8787";
  delete process.env.TS_OAUTH_CLIENT_ID;
  delete process.env.TS_OAUTH_CLIENT_SECRET;
  process.env.TS_API_URL = `http://127.0.0.1:${api.port}`;
  apiHits = { token: 0, devices: 0 };
  failDevices = false;
  writeFileSync(callLog, "");
  resetServerCaches();
});
afterEach(() => {
  for (const k of SAVED) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});
afterAll(() => { api.stop(true); Object.assign(globalThis, domGlobals); });

const SELF = "http://box-a.tail1234.ts.net:8787";
const OTHER = "http://box-b.tail1234.ts.net:8787";
const ON: ServerSwitcherConfig = { enabled: true, servers: [{ name: "box-a", url: SELF }, { name: "box-b", url: OTHER }] };
const req = (method: string, origin?: string, path = "/api/agents") =>
  new Request(`${SELF}${path}`, { method, headers: origin ? { origin } : {} });
/** A stub `/api` handler that counts its calls. */
function handler(res = () => Response.json({ ok: true }, { headers: { "x-orca-database": "ok" } })) {
  const h = { calls: 0, next: async () => { h.calls++; return res(); } };
  return h;
}

test("discovery from the Tailscale API: only tagged devices, MagicDNS url, online, self first; cached 60s", async () => {
  process.env.TS_OAUTH_CLIENT_ID = "cid";
  process.env.TS_OAUTH_CLIENT_SECRET = "csecret";
  const answer = await listServers({ enabled: true, port: 8787 }, now);
  expect(answer).toEqual({
    enabled: true,
    self: { name: "box-a", url: SELF },
    source: "tailscale",
    tailscaleApi: true,
    servers: [
      { name: "box-a", url: SELF, online: true, self: true },
      { name: "box-b", url: OTHER, online: false, self: false },
      { name: "smf", url: "http://smf.tail1234.ts.net:8787", online: true, self: false },
    ],
  });
  const form = new URLSearchParams(lastTokenBody);
  expect(form.get("grant_type")).toBe("client_credentials");
  expect(form.get("scope")).toBe("devices:core:read");
  expect(lastAuth).toBe("Bearer tok-123");
  await listServers({ enabled: true, port: 8787 }, now + 30_000);
  expect(apiHits.devices).toBe(1);
  await listServers({ enabled: true, port: 8787 }, now + 61_000);
  expect(apiHits.devices).toBe(2);
});

test("discovery takes the tag and port from the config", async () => {
  process.env.TS_OAUTH_CLIENT_ID = "cid";
  process.env.TS_OAUTH_CLIENT_SECRET = "csecret";
  process.env.ORCA_SERVER_URL = "http://box-a.tail1234.ts.net:9000";
  const answer = await listServers({ enabled: true, tag: "tag:db", port: 9000 }, now);
  expect(answer.servers.map((s) => s.url)).toEqual(["http://box-a.tail1234.ts.net:9000", "http://db.tail1234.ts.net:9000"]);
});

test("discovery from the config list when no OAuth client is set; self is added when absent", async () => {
  const answer = await listServers({ enabled: true, servers: [{ name: "smf", url: "http://smf.tail1234.ts.net:8787" }] }, now);
  expect(apiHits.token).toBe(0);
  expect(answer.source).toBe("config");
  expect(answer.tailscaleApi).toBe(false); // the browser then adds the servers it knows, and shows the env hint
  expect(answer.servers).toEqual([
    { name: "box-a", url: SELF, online: true, self: true },
    { name: "smf", url: "http://smf.tail1234.ts.net:8787", online: true, self: false },
  ]);
});

test("a failed Tailscale API call falls back to the config list", async () => {
  process.env.TS_OAUTH_CLIENT_ID = "cid";
  process.env.TS_OAUTH_CLIENT_SECRET = "csecret";
  failDevices = true;
  const answer = await listServers(ON, now);
  expect(answer.source).toBe("config");
  expect(answer.servers.map((s) => [s.name, s.self])).toEqual([["box-a", true], ["box-b", false]]);
});

test("self comes from the local tailscale status when ORCA_SERVER_URL is unset", async () => {
  delete process.env.ORCA_SERVER_URL;
  const answer = await listServers({ enabled: false }, now);
  expect(answer).toEqual({ enabled: false, self: { name: "box-a", url: SELF }, source: "self", tailscaleApi: false, servers: [{ name: "box-a", url: SELF, online: true, self: true }] });
});

test("on by default: with no serverSwitcher block, /api/servers is on and a tailnet Orca origin gets CORS", async () => {
  const answer = await listServers(undefined, now);
  expect(answer.enabled).toBe(true);
  expect(answer.source).toBe("config");
  const pre = await serverGate(req("OPTIONS", OTHER), "100.64.0.5", undefined, handler().next);
  expect(pre.status).toBe(204);
});

test("feature off (enabled: false): /api/servers is only self, and the gate adds no CORS header and runs no whois", async () => {
  process.env.TS_OAUTH_CLIENT_ID = "cid";
  process.env.TS_OAUTH_CLIENT_SECRET = "csecret";
  const off = await listServers({ ...ON, enabled: false }, now);
  expect(off.servers).toEqual([{ name: "box-a", url: SELF, online: true, self: true }]);
  expect(apiHits.token).toBe(0);
  for (const cfg of [{ ...ON, enabled: false }]) {
    const h = handler();
    const res = await serverGate(req("GET", OTHER), "100.64.0.9", cfg, h.next);
    expect(res.status).toBe(200);
    expect(h.calls).toBe(1);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await serverGate(req("OPTIONS", OTHER), "100.64.0.9", cfg, h.next);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  }
  expect(calls().filter((c) => c.startsWith("whois"))).toEqual([]);
});

test("no Origin and same-origin calls pass through unchanged, with no whois", async () => {
  for (const r of [req("POST"), req("POST", SELF), new Request("http://127.0.0.1:8787/api/agents", { method: "POST", headers: { origin: "http://127.0.0.1:8787" } })]) {
    const h = handler();
    const inner = await h.next();
    h.calls = 0;
    const res = await serverGate(r, "100.64.0.9", ON, h.next);
    expect(h.calls).toBe(1);
    expect([...res.headers.entries()]).toEqual([...inner.headers.entries()]);
  }
  expect(calls().filter((c) => c.startsWith("whois"))).toEqual([]);
});

test("an origin not in the list gets no CORS header and no whois", async () => {
  const h = handler();
  const res = await serverGate(req("GET", "http://evil.example:8787"), "100.64.0.5", ON, h.next);
  expect(h.calls).toBe(1);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  const pre = await serverGate(req("OPTIONS", "http://localhost:5173"), "100.64.0.5", ON, h.next);
  expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  expect(calls().filter((c) => c.startsWith("whois"))).toEqual([]);
});

test("trustedOrigin: a listed origin, or an Orca page on this tailnet on the Orca port (pure)", () => {
  const ok = (o: string) => trustedOrigin(o, [OTHER], "tail1234.ts.net", 8787);
  expect(ok(OTHER)).toBe(true);
  expect(ok("http://box-c.tail1234.ts.net:8787")).toBe(true); // MagicDNS name, not in the list
  expect(ok("http://box-c:8787")).toBe(true); // the MagicDNS short name a phone types
  expect(ok("http://100.101.1.2:8787")).toBe(true); // a Tailscale address
  expect(ok("https://box-c.tail1234.ts.net")).toBe(true); // tailscale serve
  expect(ok("http://box-c.tail1234.ts.net:5173")).toBe(false); // a preview on the box: agent code
  expect(ok("http://box-c.other.ts.net:8787")).toBe(false); // another tailnet
  expect(ok("http://evil.example:8787")).toBe(false);
  expect(ok("http://192.168.1.4:8787")).toBe(false);
  expect(ok("http://100.12.0.1:8787")).toBe(false); // public, not 100.64.0.0/10
  expect(trustedOrigin("http://box-c.tail1234.ts.net:8787", [], undefined, 8787)).toBe(false); // no tailnet known here
});

test("trustedOrigin: localhost/127.0.0.1 is trusted on the API port and the Vite dev port only", () => {
  const ok = (o: string) => trustedOrigin(o, [], "tail1234.ts.net", 8787, 8788);
  expect(ok("http://localhost:8787")).toBe(true); // the API port, called straight (no dev app)
  expect(ok("http://localhost:8788")).toBe(true); // the Vite dev port: the laptop dev app
  expect(ok("http://127.0.0.1:8787")).toBe(true);
  expect(ok("http://127.0.0.1:8788")).toBe(true);
  expect(ok("http://localhost:5173")).toBe(false); // some other local app on this machine
  expect(ok("http://127.0.0.1:3000")).toBe(false);
  expect(ok("https://localhost:8787")).toBe(false); // the http(s) rule stays unix: no HTTPS localhost
  // A different uiPort is honoured, not hardcoded.
  expect(trustedOrigin("http://localhost:9999", [], "tail1234.ts.net", 8787, 9999)).toBe(true);
});

test("forwardedHeaders: drops Origin/Referer/Sec-Fetch-* so a server-to-server forward never looks like a cross-origin browser call", () => {
  const headers = new Headers({
    origin: "http://box-b.tail1234.ts.net:8787", referer: "http://box-b.tail1234.ts.net:8787/board",
    "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty",
    "content-type": "application/json", cookie: "a=b",
  });
  const out = forwardedHeaders(headers);
  for (const h of ["origin", "referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"]) expect(out.has(h)).toBe(false);
  expect(out.get("content-type")).toBe("application/json"); // everything else rides along unchanged
  expect(out.get("cookie")).toBe("a=b");
  expect(headers.has("origin")).toBe(true); // the input is untouched
});

test("a forwarded request (dropped Origin) is read by serverGate as having none, and passes through with no whois", async () => {
  const h = handler();
  const forwarded = new Request(req("GET", OTHER).url, { headers: forwardedHeaders(req("GET", OTHER).headers) });
  const res = await serverGate(forwarded, "100.64.0.9", ON, h.next); // 100.64.0.9 is box-b itself: a tagged node
  expect(h.calls).toBe(1);
  expect(res.status).toBe(200);
  expect(calls().filter((c) => c.startsWith("whois"))).toEqual([]); // no cross-origin check ran at all
});

test("serverGate: a loopback caller is the owner's own browser — accepted with no whois", async () => {
  for (const ip of ["127.0.0.1", "::ffff:127.0.0.1", "::1"]) {
    const h = handler();
    const res = await serverGate(req("POST", OTHER), ip, ON, h.next);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(OTHER);
  }
  expect(calls().filter((c) => c.startsWith("whois"))).toEqual([]);
});

test("serverGate: a localhost origin on the API or Vite dev port gets CORS after whois, like a tailnet page", async () => {
  const h = handler();
  const fromDevApp = await serverGate(req("GET", "http://localhost:8788"), "100.64.0.5", {}, h.next);
  expect(fromDevApp.status).toBe(200);
  expect(fromDevApp.headers.get("access-control-allow-origin")).toBe("http://localhost:8788");
  const fromApiPort = await serverGate(req("GET", "http://localhost:8787"), "100.64.0.5", {}, h.next);
  expect(fromApiPort.headers.get("access-control-allow-origin")).toBe("http://localhost:8787");
  // Still a tagged node (a box, not a user device): the whois check still refuses it.
  const fromBox = await serverGate(req("GET", "http://localhost:8788"), "100.64.0.9", {}, h.next);
  expect(fromBox.status).toBe(403);
  // Not an Orca port: no CORS header at all.
  const wrongPort = await serverGate(req("GET", "http://localhost:5173"), "100.64.0.5", {}, h.next);
  expect(wrongPort.headers.get("access-control-allow-origin")).toBeNull();
});

test("with no API and no list, a page from the other box (same tailnet) gets CORS after whois", async () => {
  const h = handler();
  const pageOfB = "http://orca-personal-box:8787";
  const res = await serverGate(req("GET", pageOfB, "/api/servers"), "100.64.0.5", {}, h.next);
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe(pageOfB);
  const server = await serverGate(req("GET", pageOfB, "/api/servers"), "100.64.0.9", {}, h.next);
  expect(server.status).toBe(403); // a box (tagged node) is still refused
  expect(h.calls).toBe(1);
});

test("preflight from a listed origin: 204 with the CORS headers", async () => {
  const h = handler();
  const res = await serverGate(req("OPTIONS", OTHER), "100.64.0.5", ON, h.next);
  expect(res.status).toBe(204);
  expect(h.calls).toBe(0);
  expect(res.headers.get("access-control-allow-origin")).toBe(OTHER);
  expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, DELETE, OPTIONS");
  expect(res.headers.get("access-control-allow-headers")).toBe("content-type");
  expect(res.headers.get("vary")).toBe("Origin");
});

test("whois accepts a user device, and the verdict is cached per IP", async () => {
  const h = handler();
  const res = await serverGate(req("POST", OTHER), "::ffff:100.64.0.5", ON, h.next);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(res.headers.get("access-control-allow-origin")).toBe(OTHER);
  expect(res.headers.get("access-control-expose-headers")).toBe("x-orca-database");
  expect(res.headers.get("x-orca-database")).toBe("ok");
  await serverGate(req("GET", OTHER), "100.64.0.5", ON, h.next);
  expect(h.calls).toBe(2);
  expect(calls().filter((c) => c.startsWith("whois"))).toEqual(["whois --json 100.64.0.5"]);
});

test("whois refuses a tagged node (another server) with a 403 JSON error the page can read", async () => {
  const h = handler();
  const res = await serverGate(req("POST", OTHER), "100.64.0.9", ON, h.next);
  expect(res.status).toBe(403);
  expect(h.calls).toBe(0);
  expect(res.headers.get("access-control-allow-origin")).toBe(OTHER);
  expect((await res.json() as { error: string }).error).toContain("tagged node (tag:orca)");
});

test("whois refuses an unknown address and a login outside allowedLogins", async () => {
  const h = handler();
  const unknown = await serverGate(req("GET", OTHER), "100.64.0.77", ON, h.next);
  expect(unknown.status).toBe(403);
  expect((await unknown.json() as { error: string }).error).toContain("could not identify 100.64.0.77");
  const strict = await serverGate(req("GET", OTHER), "100.64.0.5", { ...ON, allowedLogins: ["someone@else.com"] }, h.next);
  expect(strict.status).toBe(403);
  expect((await strict.json() as { error: string }).error).toContain("finn@example.com is not in serverSwitcher.allowedLogins");
  expect(h.calls).toBe(0);
});

test("the /api/events stream works cross-origin: CORS header on a response that still streams", async () => {
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: (r, s) => serverGate(r, s.requestIP(r)?.address, ON, async () => {
      const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n")); } });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }),
  });
  whois("127.0.0.1", { Node: { Tags: [] }, UserProfile: { LoginName: "finn@example.com" } });
  try {
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/events`, { headers: { origin: OTHER, accept: "text/event-stream" }, signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(OTHER);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const { value } = await res.body!.getReader().read();
    expect(new TextDecoder().decode(value)).toContain("event: ready");
    ctrl.abort();
  } finally { server.stop(true); }
});

test("the config document validates serverSwitcher", () => {
  expect(serverSwitcherProblems(undefined)).toEqual([]);
  expect(serverSwitcherProblems(ON)).toEqual([]);
  expect(serverSwitcherProblems({ enabled: "yes", tag: "orca", port: 0, servers: [{ name: "x", url: "ftp://x" }], allowedLogins: [""], extra: 1 })).toEqual([
    "serverSwitcher.extra is not a known setting (enabled, tag, port, servers, allowedLogins)",
    "serverSwitcher.enabled must be true or false",
    "serverSwitcher.tag must be a Tailscale tag such as tag:orca",
    "serverSwitcher.port must be a port number",
    "serverSwitcher.servers must be a list of { name, url } with an http(s) url",
    "serverSwitcher.allowedLogins must be a list of Tailscale logins",
  ]);
  const repos = [{ name: "orca", repoPath: "/r", worktreeRoot: "/w", baseBranch: "main" }];
  expect(parseConfigDocument({ repos, serverSwitcher: ON }).config?.serverSwitcher).toEqual(ON);
  expect(parseConfigDocument({ repos, serverSwitcher: { enabled: 1 } }).errors).toEqual(["serverSwitcher.enabled must be true or false"]);
});

test("withSelf: a discovered row on this server's host is self on any scheme or port, and takes the self url", () => {
  const self = { name: "box-a", url: "https://box-a.tail.ts.net" };
  const rows = [
    { name: "box-b", url: "http://box-b.tail.ts.net:8787", online: true },
    { name: "box-a", url: "http://box-a.tail.ts.net:8787", online: false },
  ];
  expect(withSelf(rows, self)).toEqual([
    { name: "box-a", url: "https://box-a.tail.ts.net", online: true, self: true },
    { name: "box-b", url: "http://box-b.tail.ts.net:8787", online: true, self: false },
  ]);
});
