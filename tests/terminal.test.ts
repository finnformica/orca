// The instance web terminal (server/terminal.ts): a real shell over a WebSocket. These cases drive a
// real Bun server, a real PTY and real WebSocket clients — only the config and (for a tailnet peer)
// Tailscale's answer are supplied. They pin the four gates: who may connect, off unless Settings
// turned it on, at most two shells, and the idle close.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import * as db from "../server/db";
import { configDocument, invalidateConfig, loadConfig, parseConfigDocument, saveConfigDocument, setInstanceTerminal, type OrcaConfig } from "../server/config";
import * as terminal from "../server/terminal";
import { TERMINAL_KEYS, ctrlChord, terminalClosedText, terminalSocketUrl } from "../web/src/workstream";
import { freshSchema, type TestDb } from "./pg";
import { native } from "./happydom";

// Bun's own fetch / Response / WebSocket for this file: the server and its relay run on them.
const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
beforeAll(() => { for (const k of ["fetch", "Response", "WebSocket"] as const) { saved[k] = g[k]; g[k] = native[k]; } });
afterAll(() => { Object.assign(g, saved); });

const HERE = "box";
let server: Server<terminal.TerminalData> | undefined;
let cfg: Pick<OrcaConfig, "terminal" | "instances">;
const open: WebSocket[] = [];

function serve(deps: Partial<terminal.UpgradeDeps> = {}): string {
  server = Bun.serve<terminal.TerminalData>({
    port: 0, hostname: "127.0.0.1",
    websocket: terminal.websocket,
    fetch: (req, srv) => terminal.upgrade(req, srv, { config: async () => cfg as OrcaConfig, here: HERE, ...deps }),
  });
  return `ws://127.0.0.1:${server.port}${terminal.PATH}`;
}

afterEach(async () => {
  for (const ws of open.splice(0)) ws.close();
  await Bun.sleep(50);
  server?.stop(true);
  server = undefined;
});

/** A client that collects output and resolves `closed` with the close code + reason. */
function connect(url: string, headers?: Record<string, string>) {
  const ws = new WebSocket(url, headers ? { headers } as unknown as string[] : undefined);
  ws.binaryType = "arraybuffer";
  open.push(ws);
  let out = "";
  const decoder = new TextDecoder();
  ws.onmessage = (e) => { out += typeof e.data === "string" ? e.data : decoder.decode(e.data as ArrayBuffer); };
  const closed = new Promise<{ code: number; reason: string }>((r) => { ws.onclose = (e) => r({ code: e.code, reason: e.reason }); });
  const opened = new Promise<boolean>((r) => { ws.onopen = () => r(true); ws.onerror = () => r(false); });
  const until = async (text: string, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!out.includes(text) && Date.now() < end) await Bun.sleep(20);
    return out.includes(text);
  };
  const send = (d: string) => void opened.then((ok) => ok && ws.send(JSON.stringify({ t: "i", d })));
  return { ws, closed, opened, until, send, get out() { return out; } };
}

test("the auth gate: loopback and the owner's tailnet nodes only, never a cross-origin page", async () => {
  // Who: pure, with Tailscale's answers supplied.
  const whois: terminal.Whois = async (a) => a === "100.98.1.2" ? { userId: "7", login: "finn@github" } : { userId: "9", login: "guest@github" };
  const self = async () => "7";
  expect(await terminal.identify("127.0.0.1", whois, self)).toEqual({ ok: true, who: "loopback" });
  expect(await terminal.identify("::ffff:127.0.0.1", whois, self)).toEqual({ ok: true, who: "loopback" });
  expect(await terminal.identify("100.98.1.2", whois, self)).toEqual({ ok: true, who: "finn@github" });
  expect(await terminal.identify("100.98.1.3", whois, self)).toMatchObject({ ok: false, reason: expect.stringContaining("guest@github is not this machine's owner") });
  expect(await terminal.identify("192.168.1.20", whois, self)).toMatchObject({ ok: false, reason: expect.stringContaining("not on the tailnet") });
  expect(await terminal.identify("100.98.1.2", async () => null, self)).toMatchObject({ ok: false });
  expect(await terminal.identify(undefined, whois, self)).toMatchObject({ ok: false });
  // A local proxy's forwarded caller is the one identified; only loopback may forward.
  expect(terminal.callerAddress("127.0.0.1", new Headers({ "x-forwarded-for": "100.98.1.3" }))).toBe("100.98.1.3");
  expect(terminal.callerAddress("100.98.1.3", new Headers({ "x-forwarded-for": "127.0.0.1" }))).toBe("100.98.1.3");
  expect(terminal.originAllowed("http://orca-box:5173", "orca-box:8787")).toBe(true);
  expect(terminal.originAllowed("https://evil.example", "127.0.0.1:8787")).toBe(false);
  expect(terminal.originAllowed(null, "127.0.0.1:8787")).toBe(true);

  // Over the wire: a refused caller gets a 403 and no socket, before the config is even read.
  cfg = { terminal: { [HERE]: true } };
  const url = serve();
  const cross = await fetch(url.replace("ws:", "http:"), { headers: { upgrade: "websocket", connection: "upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", origin: "https://evil.example" } });
  expect(cross.status).toBe(403);
  server!.stop(true);
  const stranger = serve({ identify: async () => ({ ok: false, reason: "guest@github is not this machine's owner" }) });
  const refused = connect(stranger);
  expect(await refused.opened).toBe(false);
  expect(terminal.liveSessions()).toBe(0);
});

test("off by default: no flag, or anything but true, closes the socket with the reason", async () => {
  expect(terminal.terminalEnabled({}, HERE)).toBe(false);
  expect(terminal.terminalEnabled({ terminal: { [HERE]: "true" as unknown as boolean } }, HERE)).toBe(false);
  expect(terminal.terminalEnabled({ terminal: { other: true } }, HERE)).toBe(false);
  cfg = {};
  const c = connect(serve());
  const { code, reason } = await c.closed;
  expect(code).toBe(terminal.CLOSE.off);
  expect(reason).toContain("turn it on in Settings");
  expect(terminal.liveSessions()).toBe(0);
});

test("a shell runs in the service user's home with the agents' PATH, resizes, and dies with its socket", async () => {
  cfg = { terminal: { [HERE]: true } };
  const c = connect(`${serve()}?cols=40&rows=10`);
  expect(await c.opened).toBe(true);
  c.send("stty size; pwd; echo \"path=$PATH\"\n");
  expect(await c.until("10 40")).toBe(true);
  expect(await c.until(process.env.HOME!)).toBe(true);
  expect(await c.until("bin/worker")).toBe(true);
  c.ws.send(JSON.stringify({ t: "r", c: 50, r: 12 }));
  await Bun.sleep(100);
  c.send("stty size\n");
  expect(await c.until("12 50")).toBe(true);
  expect(terminal.liveSessions()).toBe(1);
  c.ws.close();
  await c.closed;
  for (let i = 0; i < 50 && terminal.liveSessions(); i++) await Bun.sleep(20);
  expect(terminal.liveSessions()).toBe(0);
});

test("at most two shells per instance; closing one frees a place", async () => {
  cfg = { terminal: { [HERE]: true } };
  const url = serve();
  const a = connect(url), b = connect(url);
  a.send("echo one-ready\n"); b.send("echo two-ready\n");
  expect(await a.until("one-ready")).toBe(true);
  expect(await b.until("two-ready")).toBe(true);
  const third = connect(url);
  const { code, reason } = await third.closed;
  expect(code).toBe(terminal.CLOSE.limit);
  expect(reason).toContain("2 terminal sessions");
  a.ws.close();
  await a.closed;
  for (let i = 0; i < 50 && terminal.liveSessions() > 1; i++) await Bun.sleep(20);
  const fourth = connect(url);
  fourth.send("echo again-ready\n");
  expect(await fourth.until("again-ready")).toBe(true);
});

test("a shell with no input for the idle time is closed and its process ended", async () => {
  cfg = { terminal: { [HERE]: true } };
  const c = connect(serve({ idleMs: 400 }));
  c.send("echo $$\n");
  expect(await c.until("\n")).toBe(true);
  const { code } = await c.closed;
  expect(code).toBe(terminal.CLOSE.idle);
  expect(terminal.liveSessions()).toBe(0);
});

test("another instance's terminal relays through this bridge, and its own gate decides", async () => {
  // The target instance ("laptop"): its own server, its own flag.
  const laptop = Bun.serve<terminal.TerminalData>({
    port: 0, hostname: "127.0.0.1", websocket: terminal.websocket,
    fetch: (req, srv) => terminal.upgrade(req, srv, { config: async () => ({ terminal: { laptop: laptopOn } }) as unknown as OrcaConfig, here: "laptop" }),
  });
  let laptopOn = true;
  try {
    cfg = { terminal: {}, instances: { laptop: `http://127.0.0.1:${laptop.port}` } };
    const url = `${serve()}?instance=laptop&cols=30&rows=7`;
    const c = connect(url);
    c.send("stty size; echo relayed-$((40+2))\n");
    expect(await c.until("7 30")).toBe(true);
    expect(await c.until("relayed-42")).toBe(true);
    c.ws.close();
    await c.closed;
    // Off on the target: its refusal reaches the browser through the relay.
    laptopOn = false;
    const off = connect(url);
    const { code, reason } = await off.closed;
    expect(code).toBe(terminal.CLOSE.off);
    expect(reason).toContain("laptop");
  } finally {
    laptop.stop(true);
  }
});

// ---- the flag: only Settings' route writes it ----

let pg: TestDb;
let prevDbUrl: string | undefined;
const doc = (over: Record<string, unknown> = {}) => ({
  repos: [{ name: "app", repoPath: "/tmp/app", worktreeRoot: "/tmp/app/.worktrees", baseBranch: "main" }],
  portRange: [30000, 40000], staleHours: 24, ...over,
});
test("Settings sets the flag; a pasted config document can not", async () => {
  prevDbUrl = process.env.ORCA_DATABASE_URL;
  pg = await freshSchema("terminalflag");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  invalidateConfig();
  try {
    // A document that names `terminal` does not carry it.
    expect(parseConfigDocument(doc({ terminal: { box: true } })).config!.terminal).toBeUndefined();
    await saveConfigDocument(parseConfigDocument(doc()).config!);
    expect((await loadConfig()).terminal).toBeUndefined();
    await setInstanceTerminal("box", true);
    invalidateConfig();
    expect((await loadConfig()).terminal).toEqual({ box: true });
    expect((await configDocument()).repos).toMatchObject([{ name: "app" }]); // nothing else changed
    await setInstanceTerminal("box", false);
    invalidateConfig();
    expect((await loadConfig()).terminal).toBeUndefined();
  } finally {
    await db.close();
    await pg.drop();
    if (prevDbUrl === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prevDbUrl;
    invalidateConfig();
  }
});

test("the phone's extra keys and Ctrl send the bytes a terminal expects", () => {
  expect(TERMINAL_KEYS.map((k) => k.label)).toEqual(["Esc", "Tab", "Ctrl", "←", "↑", "↓", "→", "Paste"]);
  expect(TERMINAL_KEYS.find((k) => k.id === "esc")!.send).toBe("\x1b");
  expect(TERMINAL_KEYS.find((k) => k.id === "up")!.send).toBe("\x1b[A");
  expect(ctrlChord("c")).toBe("\x03");
  expect(ctrlChord("D")).toBe("\x04");
  expect(ctrlChord("[")).toBe("\x1b");
  expect(ctrlChord("5")).toBe("5");
  expect(ctrlChord("ls")).toBe("ls");
  expect(terminalSocketUrl({ protocol: "http:", hostname: "orca-box" }, "8787", "local", 52, 30)).toBe("ws://orca-box:8787/api/terminal?instance=local&cols=52&rows=30");
  expect(terminalSocketUrl({ protocol: "https:", hostname: "::1" }, "", "cloud", 80, 24)).toBe("wss://[::1]/api/terminal?instance=cloud&cols=80&rows=24");
  expect(terminalClosedText(4403, "the terminal is off for cloud — turn it on in Settings")).toContain("Settings");
  expect(terminalClosedText(1006, "")).toContain("not allowed");
});
