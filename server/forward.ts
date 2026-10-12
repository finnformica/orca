// A preview running on ANOTHER instance, reached from this machine's browser as `localhost`.
//
// Why: the branch-demo frontend (and anything using crypto.randomUUID, service workers, etc.) only
// works in a SECURE CONTEXT — `localhost` counts, a plain-http tailnet name does not, so a cloud
// preview opened at http://orca-box.…:port rendered a blank page. HTTPS over the tailnet needs
// certs the Tailscale account doesn't grant. So when this instance relays a preview from its owner,
// it forwards the service's port on loopback here and hands the browser http://localhost:<port>.
// Plain TCP, so Vite's HMR websocket rides it unchanged. One forward per port, same number both
// ends (the box's port range is the same config), dropped when the preview is stopped.
import type { Socket, TCPSocketListener } from "bun";

type Up = { sock?: Socket<unknown>; pending: Uint8Array[] };
type Down = { up: Up; down: Uint8Array[] }; // bytes for the browser waiting on the local socket's drain

// Write what's queued, keeping whatever the socket didn't take for its next `drain` — a Vite chunk
// is megabytes, and a write that only partly lands would otherwise corrupt the stream.
function flush(to: Socket<unknown>, pending: Uint8Array[]): void {
  while (pending.length) {
    const chunk = pending[0]!;
    const n = to.write(chunk);
    if (n < chunk.byteLength) { pending[0] = chunk.subarray(Math.max(n, 0)); return; }
    pending.shift();
  }
}

const live = new Map<number, TCPSocketListener<Down>>();
const byKey = new Map<string, number[]>(); // preview key → the ports forwarded for it

/** Listen on 127.0.0.1:<port> and pipe each connection to host:<remotePort>. Idempotent. Returns
 *  false when the port can't be taken here (a local preview has it) — the caller keeps the remote URL. */
export function ensure(port: number, host: string, remotePort = port): boolean {
  if (live.has(port)) return true;
  try {
    const server = Bun.listen<Down>({
      hostname: "127.0.0.1", port,
      socket: {
        open(s) {
          const up: Up = { pending: [] };
          s.data = { up, down: [] };
          Bun.connect<unknown>({
            hostname: host, port: remotePort,
            socket: {
              open(u) { up.sock = u; flush(u, up.pending); },
              data(_, d) { s.data.down.push(d); flush(s, s.data.down); },
              drain() { flush(up.sock!, up.pending); },
              close() { s.end(); },
              error() { s.end(); },
            },
          }).catch(() => s.end());
        },
        data(s, d) { s.data.up.pending.push(d); if (s.data.up.sock) flush(s.data.up.sock, s.data.up.pending); },
        drain(s) { flush(s, s.data.down); },
        close(s) { s.data.up.sock?.end(); },
        error(s) { s.data.up.sock?.end(); },
      },
    });
    live.set(port, server);
    return true;
  } catch {
    return false;
  }
}

export function drop(port: number): void {
  live.get(port)?.stop(true);
  live.delete(port);
}

/** Rewrite a relayed preview status: the service the browser opens gets a loopback forward and a
 *  localhost URL; the rest keep the owner's URL (the frontend reaches the backend by that, and a
 *  page on http://localhost may call another http origin). */
export function localize<T extends { port: number; url: string; open: boolean }>(key: string, svcs: T[], host: string): T[] {
  const ports: number[] = [];
  const out = svcs.map((s) => {
    if (!s.open || !ensure(s.port, host)) return s;
    ports.push(s.port);
    return { ...s, url: `http://localhost:${s.port}` };
  });
  if (ports.length) byKey.set(key, ports);
  return out;
}

export function release(key: string): void {
  for (const p of byKey.get(key) ?? []) drop(p);
  byKey.delete(key);
}
