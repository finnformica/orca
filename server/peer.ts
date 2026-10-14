// Is another Orca instance there at all? A laptop that is asleep or off the tailnet does not REFUSE
// a connection — its tailnet address black-holes the SYN, so a plain fetch hangs until the OS gives
// up (over a minute). Every request that reached for it (the usage merge on every /api/usage, a
// `?instance=local` health read, a forward to a worktree on the laptop) hung that long, and each one
// held one of the browser's six HTTP/1.1 connections the whole time: two tabs and the page could not
// load at all. A response timeout can't tell "slow" (a forwarded `gh` call) from "gone", so this asks
// the narrower question — does a TCP connect succeed within CONNECT_MS? — and remembers the answer:
// a peer found down is skipped for DOWN_MS (one 2s wait, then instant), one found up isn't re-probed
// for UP_MS.

export const CONNECT_MS = 2_000;
export const DOWN_MS = 30_000;
export const UP_MS = 15_000;

const known = new Map<string, { up: boolean; until: number }>();
const inflight = new Map<string, Promise<boolean>>();

/** Can a TCP connection to `base`'s host:port be opened within `ms`? Never throws. */
async function connects(base: URL, ms: number): Promise<boolean> {
  const port = Number(base.port) || (base.protocol === "https:" ? 443 : 80);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = Bun.connect({
    hostname: base.hostname, port,
    socket: { open(s) { s.end(); }, data() {}, error() {}, connectError() {} },
  }).then((s) => { s.end(); return true; }, () => false);
  const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try { return await Promise.race([attempt, late]); } finally { clearTimeout(timer); }
}

let probe: (base: URL, ms: number) => Promise<boolean> = connects;
/** Swap the connect probe (tests whose peer is a stubbed `fetch` on a host that doesn't exist). */
export function setProbe(fn?: (base: URL, ms: number) => Promise<boolean>): void { probe = fn ?? connects; resetPeers(); }

/** Is the instance at `base` reachable? Cached (down for DOWN_MS, up for UP_MS); concurrent callers
 *  share one probe. */
export async function reachable(base: string, ms = CONNECT_MS): Promise<boolean> {
  let url: URL;
  try { url = new URL(base); } catch { return false; }
  const key = url.origin;
  const hit = known.get(key);
  if (hit && hit.until > Date.now()) return hit.up;
  const pending = inflight.get(key);
  if (pending) return pending;
  const answer = probe(url, ms).then((up) => {
    known.set(key, { up, until: Date.now() + (up ? UP_MS : DOWN_MS) });
    inflight.delete(key);
    return up;
  });
  inflight.set(key, answer);
  return answer;
}

/** A fetch to a peer failed outright (not an HTTP error): treat it as down until re-probed. */
export function markDown(base: string): void {
  try { known.set(new URL(base).origin, { up: false, until: Date.now() + DOWN_MS }); } catch { /* bad base */ }
}

/** Forget every cached answer (tests). */
export function resetPeers(): void { known.clear(); inflight.clear(); }
