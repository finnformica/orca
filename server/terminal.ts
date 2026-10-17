// The instance web terminal: a real shell on this machine, in the browser (xterm.js), over ONE
// WebSocket per session — so Finn can run `gh auth login` for a second account from his phone.
//
// It is the one place the bridge hands out a shell, so every gate is here and every gate is on the
// server:
//  - OFF unless the app config's `terminal[<instance>]` is true, which only Settings' route writes
//    (`/api/config/terminal`; a pasted config document keeps the stored value, the file never seeds
//    it, and the orchestrator's `orca` command has no verb for it).
//  - The owner only. The API has no auth of its own: it is reached over loopback or the tailnet, and
//    nothing else. A shell needs more than "can reach the port", so a tailnet peer must be a USER
//    device (never a tagged node: a server never gets another server's shell) of this machine's
//    owner (`tailscale whois`): the same Tailscale user as this machine, or — on a tagged machine,
//    whose own user is Tailscale's `tagged-devices` — a login in `serverSwitcher.allowedLogins`.
//  - A browser's Origin must be a known Orca page: the host it connects to, an `instances` address,
//    or a server the switcher lists (a WebSocket is not covered by the same-origin policy, so
//    without this any page Finn opens could open a shell on loopback).
//  - At most MAX_SESSIONS shells per instance; a shell with no input for IDLE_MS is closed.
//  - The PTY is closed (the shell SIGHUPed, then killed) when its socket closes, for any reason.
//  - Start and end are logged (who, instance, time). Keystrokes and output are NEVER logged.
//
// Each machine serves ONLY its own shell. The browser connects to that machine's bridge directly (the
// panel reads its address from `/api/config`'s `instanceUrls`); a bridge never relays a terminal to
// another box — box-to-box traffic is blocked on purpose — so a request that names another instance
// is closed with the reason.
import type { Server, ServerWebSocket } from "bun";
import type { OrcaConfig } from "./config";
import { agentEnv } from "./env";
import { runCmd } from "./run";

export const MAX_SESSIONS = 2;
export const IDLE_MS = 30 * 60_000;
export const PATH = "/api/terminal";

/** Close codes the browser shows as a reason (4000-4999 are the application's). */
export const CLOSE = { off: 4403, limit: 4429, idle: 4408, exited: 4000, elsewhere: 4421 } as const;

/** Is this instance's terminal turned on? Off unless the config says exactly `true`. */
export const terminalEnabled = (cfg: Pick<OrcaConfig, "terminal">, instance: string): boolean => cfg.terminal?.[instance] === true;

const unmap = (addr: string) => addr.replace(/^::ffff:/i, "");
export const isLoopback = (addr: string): boolean => {
  const a = unmap(addr);
  return a === "::1" || /^127\./.test(a);
};
/** Tailscale's address ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export const isTailnet = (addr: string): boolean => {
  const a = unmap(addr).toLowerCase();
  const m = /^100\.(\d+)\./.exec(a);
  if (m) return Number(m[1]) >= 64 && Number(m[1]) <= 127;
  return a.startsWith("fd7a:115c:a1e0:");
};

const hostnameOf = (url: string): string | null => {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase(); } catch { return null; }
};
/** A browser's Origin must name the host it connects to, or one of `trusted` — the other Orca pages
 *  (`instances` addresses, the switcher's servers) that open this machine's terminal directly. The
 *  host name decides, any port (the dev UI and the bridge are on two). No Origin is a non-browser
 *  client (a test, a script on the tailnet — the identity gate still applies). */
export function originAllowed(origin: string | null, host: string | null, trusted: string[] = []): boolean {
  if (!origin) return true;
  const o = hostnameOf(origin);
  if (!o) return false;
  if (host && o === hostnameOf(`http://${host}`)) return true;
  return trusted.some((t) => hostnameOf(t) === o);
}

/** The Orca pages a browser may open this machine's terminal from, besides its own host: every
 *  configured instance address and, with the switcher on, every server it lists. */
export async function trustedOrigins(cfg: Pick<OrcaConfig, "instances" | "serverSwitcher">): Promise<string[]> {
  const out = Object.values(cfg.instances ?? {});
  if (cfg.serverSwitcher?.enabled) {
    const { listServers } = await import("./servers");
    const answer = await listServers(cfg.serverSwitcher).catch(() => null);
    for (const s of answer?.servers ?? []) out.push(s.url);
  }
  return out;
}

/** The address to identify. A request from loopback that carries `x-forwarded-for` came through a
 *  local proxy (Vite's, in dev and in a branch preview), so the forwarded caller is the one to check
 *  — else a tailnet peer reaching the proxy would pass as loopback. Only loopback may say so. */
export function callerAddress(remote: string | undefined, headers: Headers): string | undefined {
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return remote && isLoopback(remote) && fwd ? fwd : remote;
}

export type Identity = { ok: true; who: string } | { ok: false; reason: string };
/** A tailnet address → its node's user (id + login) and whether the node is tagged, or null when
 *  Tailscale can't say. */
export type Whois = (addr: string) => Promise<{ userId: string; login: string; tagged?: boolean } | null>;
/** This machine's own Tailscale user id and whether it is a tagged node, or null when Tailscale
 *  isn't running. */
export type SelfUser = () => Promise<{ userId: string; tagged?: boolean } | null>;

/** Who is asking. Loopback is this machine's own user (the bridge's own browser, the Vite proxy).
 *  A tailnet peer must be an untagged user device, and the owner: on an untagged machine, a node of
 *  the same Tailscale user; on a tagged machine (its user is Tailscale's `tagged-devices`, so no
 *  device matches it), a login in `owners` — `serverSwitcher.allowedLogins`. Anything else is refused. */
export async function identify(addr: string | undefined, whois: Whois = tailscaleWhois, self: SelfUser = tailscaleSelf, owners: string[] = []): Promise<Identity> {
  if (!addr) return { ok: false, reason: "no remote address" };
  if (isLoopback(addr)) return { ok: true, who: "loopback" };
  if (!isTailnet(addr)) return { ok: false, reason: `${addr} is not on the tailnet` };
  const [peer, mine] = await Promise.all([whois(unmap(addr)), self()]);
  if (!peer || !mine) return { ok: false, reason: `tailscale cannot identify ${addr}` };
  if (peer.tagged) return { ok: false, reason: `${addr} is a tagged node (a server), not a user device` };
  if (mine.tagged) {
    if (!owners.length) return { ok: false, reason: "this machine is a tagged node: name its owner in serverSwitcher.allowedLogins" };
    if (!owners.includes(peer.login)) return { ok: false, reason: `${peer.login} is not in serverSwitcher.allowedLogins` };
  } else if (peer.userId !== mine.userId) return { ok: false, reason: `${peer.login} is not this machine's owner` };
  return { ok: true, who: peer.login };
}

const tailscaleJson = async (args: string[]): Promise<Record<string, unknown> | null> => {
  if (!Bun.which("tailscale")) return null;
  const r = await runCmd(["tailscale", ...args], { timeoutMs: 5_000, allowFail: true });
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout) as Record<string, unknown>; } catch { return null; }
};
const tailscaleWhois: Whois = async (addr) => {
  const j = await tailscaleJson(["whois", "--json", addr]);
  const node = j?.Node as { User?: number; Tags?: string[] } | undefined;
  const login = (j?.UserProfile as { LoginName?: string } | undefined)?.LoginName;
  return node?.User ? { userId: String(node.User), login: login ?? String(node.User), tagged: Boolean(node.Tags?.length) } : null;
};
let selfInfo: { userId: string; tagged: boolean } | null = null;
const tailscaleSelf: SelfUser = async () => {
  if (selfInfo) return selfInfo;
  const j = await tailscaleJson(["status", "--json"]);
  const me = j?.Self as { UserID?: number; Tags?: string[] } | undefined;
  return (selfInfo = me?.UserID ? { userId: String(me.UserID), tagged: Boolean(me.Tags?.length) } : null);
};

// ---- sessions ----

type PtyData = {
  kind: "pty"; who: string; instance: string; cols: number; rows: number; idleMs: number; enabled: () => Promise<boolean>;
  /** Messages that arrived while `open` still checked the flag — replayed once the shell exists. */
  early: (string | Buffer<ArrayBuffer>)[];
  /** Close at once with this reason (a request for another machine's shell). */
  refuse?: { code: number; reason: string };
};
export type TerminalData = PtyData;
type Session = { proc: Bun.Subprocess; idle?: ReturnType<typeof setTimeout>; startedAt: number; ended?: string };

const sessions = new Map<ServerWebSocket<TerminalData>, Session>();

/** Live shells on this instance (the session limit counts these). */
export const liveSessions = (): number => sessions.size;

const log = (event: "start" | "end" | "refused", d: { who: string; instance: string }, extra = "") =>
  console.log(`orca: terminal ${event} who=${d.who} instance=${d.instance} at=${new Date().toISOString()}${extra ? ` ${extra}` : ""}`);

export type UpgradeDeps = {
  config: () => Promise<OrcaConfig>;
  /** This instance's name. */
  here: string;
  identify?: (addr: string | undefined, owners: string[]) => Promise<Identity>;
  idleMs?: number;
};

const dims = (v: string | null, fallback: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

/** The `/api/terminal?instance=&cols=&rows=` upgrade. A refusal of WHO is an HTTP 403 (no socket);
 *  a refusal of WHAT (off, full) opens the socket and closes it with a reason the browser can show. */
export async function upgrade(req: Request, server: Server<TerminalData>, deps: UpgradeDeps): Promise<Response | undefined> {
  const url = new URL(req.url);
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return Response.json({ error: "expected a WebSocket upgrade" }, { status: 426 });
  const cfg = await deps.config();
  if (!originAllowed(req.headers.get("origin"), req.headers.get("host"), await trustedOrigins(cfg))) return Response.json({ error: "cross-origin terminal request refused" }, { status: 403 });
  const owners = cfg.serverSwitcher?.allowedLogins ?? [];
  const id = await (deps.identify ? deps.identify(callerAddress(server.requestIP(req)?.address, req.headers), owners)
    : identify(callerAddress(server.requestIP(req)?.address, req.headers), undefined, undefined, owners));
  if (!id.ok) {
    log("refused", { who: "unknown", instance: deps.here }, `reason="${id.reason}"`);
    return Response.json({ error: `terminal refused: ${id.reason}` }, { status: 403 });
  }
  const instance = url.searchParams.get("instance") || deps.here;
  const data: PtyData = {
    kind: "pty", who: id.who, instance, idleMs: deps.idleMs ?? IDLE_MS,
    cols: dims(url.searchParams.get("cols"), 80, 500), rows: dims(url.searchParams.get("rows"), 24, 200),
    // Read again at open: the config may change between the check below and the socket opening.
    enabled: async () => terminalEnabled(await deps.config(), instance),
    early: [],
    // Never a relay: another machine's shell is that machine's bridge's to serve.
    ...(instance === deps.here ? {} : { refuse: { code: CLOSE.elsewhere, reason: `this is ${deps.here}; open ${instance}'s terminal on ${instance}'s own server` } }),
  };
  return server.upgrade(req, { data }) ? undefined : Response.json({ error: "upgrade failed" }, { status: 400 });
}

/** Messages from the browser: `{t:"i",d}` input, `{t:"r",c,r}` resize. Output goes back as binary. */
type ClientMessage = { t: "i"; d: string } | { t: "r"; c: number; r: number };

function end(ws: ServerWebSocket<TerminalData>, reason: string): void {
  const s = sessions.get(ws);
  if (!s || s.ended) return;
  s.ended = reason;
  clearTimeout(s.idle);
  sessions.delete(ws);
  // SIGHUP is what a closing terminal sends; a shell that ignores it is killed shortly after.
  try { s.proc.kill("SIGHUP"); } catch { /* gone */ }
  const kill = setTimeout(() => { try { s.proc.kill("SIGKILL"); } catch { /* gone */ } }, 2_000);
  void s.proc.exited.then(() => clearTimeout(kill));
  try { s.proc.terminal?.close(); } catch { /* closed */ }
  log("end", ws.data, `reason=${reason} seconds=${Math.round((Date.now() - s.startedAt) / 1000)}`);
}

function touch(ws: ServerWebSocket<TerminalData>, s: Session, idleMs: number): void {
  clearTimeout(s.idle);
  s.idle = setTimeout(() => { end(ws, "idle"); ws.close(CLOSE.idle, `closed after ${Math.round(idleMs / 60_000)} minutes with no input`); }, idleMs);
}

async function openPty(ws: ServerWebSocket<TerminalData>): Promise<void> {
  const d = ws.data;
  if (d.refuse) {
    log("refused", d, "reason=elsewhere");
    return ws.close(d.refuse.code, d.refuse.reason);
  }
  if (!(await d.enabled())) {
    log("refused", d, "reason=off");
    return ws.close(CLOSE.off, `the terminal is off for ${d.instance} — turn it on in Settings`);
  }
  if (sessions.size >= MAX_SESSIONS) {
    log("refused", d, "reason=limit");
    return ws.close(CLOSE.limit, `${d.instance} already has ${MAX_SESSIONS} terminal sessions — close one first`);
  }
  if (ws.readyState !== 1) return; // the browser left while we checked
  const home = process.env.HOME || "/";
  const shell = process.env.SHELL || "/bin/bash";
  // The service user's own shell, in its home, with the PATH (and the secret-free environment) every
  // agent gets. Interactive, not login: a login shell's profile may rewrite that PATH.
  const proc = Bun.spawn([shell, "-i"], {
    cwd: home,
    env: { ...agentEnv(), HOME: home, TERM: "xterm-256color", COLORTERM: "truecolor" },
    terminal: {
      cols: d.cols, rows: d.rows,
      data: (_t, bytes) => { if (ws.readyState === 1) ws.sendBinary(bytes); },
    },
  });
  const s: Session = { proc, startedAt: Date.now() };
  sessions.set(ws, s);
  touch(ws, s, d.idleMs);
  log("start", d, `pid=${proc.pid}`);
  for (const m of d.early.splice(0)) websocket.message!(ws, m);
  void proc.exited.then((code) => {
    if (!sessions.has(ws)) return;
    end(ws, "exited");
    ws.close(CLOSE.exited, `shell exited (${code})`);
  });
}

/** Bun.serve's `websocket` handlers for the terminal (the only WebSocket the bridge serves). */
export const websocket: Bun.WebSocketHandler<TerminalData> = {
  open(ws) {
    void openPty(ws);
  },
  message(ws, raw) {
    const s = sessions.get(ws);
    if (!s) { if (ws.data.early.length < 100) ws.data.early.push(raw); return; }
    let msg: ClientMessage;
    try { msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as ClientMessage; } catch { return; }
    if (msg.t === "i" && typeof msg.d === "string") {
      s.proc.terminal?.write(msg.d);
      touch(ws, s, ws.data.idleMs);
    } else if (msg.t === "r" && Number.isInteger(msg.c) && Number.isInteger(msg.r) && msg.c > 0 && msg.r > 0) {
      s.proc.terminal?.resize(Math.min(msg.c, 500), Math.min(msg.r, 200));
    }
  },
  close(ws) {
    end(ws, "socket closed");
  },
};
