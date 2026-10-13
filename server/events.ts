// The browser's ONE live feed: every chat's steps and turn events, multiplexed on a single
// Server-Sent Events stream per tab. The client fans events out by repo/branch (web/src/lib/events.ts).
//
// Why one stream and not one per chat: the bridge is plain HTTP/1.1 (the tailnet has no certs, so no
// HTTP/2), and a browser allows SIX connections per host — shared by every tab. Each open chat held
// one forever, so a few chats across a couple of tabs left nothing for fetches: the PR page sat on
// "Loading…" (or never got its HTML) until a stream closed.
//
// The bus is per process, so this stream also RELAYS the other instances' buses, server to server
// (no browser limit there): a chat on the laptop for a cloud workstream hears the cloud's events
// through the laptop. A relay asks with `?local=1`, so instances never relay each other in a loop.
import * as bus from "./bus";

const RETRY_MS = 3_000;
/** The events relayed from another instance (its `ready` and keep-alives are dropped). */
export const RELAYED = ["step", "turn", "notification"] as const;

/** The stream. `upstreams` are the other instances' base URLs (empty for a `?local=1` relay). An
 *  upstream that drops is retried; when it comes back, a `ready` tells the client to catch up from
 *  its cursors, since anything published there in between was missed. */
export function eventStream(req: Request, upstreams: string[]): Response {
  let close = () => {};
  const stream = new ReadableStream<string>({
    start(controller) {
      let open = true;
      const send = (frame: string) => { if (open) try { controller.enqueue(frame); } catch { close(); } };
      const event = (name: string, data: unknown) => send(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      event("ready", {});
      // A comment line every 25s keeps proxies (and some browsers) from reaping an idle stream.
      const keepAlive = setInterval(() => send(": keep-alive\n\n"), 25_000);
      const off = bus.subscribe((e) => {
        if (e.kind === "step") event("step", { repo: e.repo, branch: e.branch, runId: e.runId, steps: e.steps });
        else if (e.kind === "turn") event("turn", { repo: e.repo, branch: e.branch, runId: e.runId });
        else event("notification", e.notification);
      });
      const aborts = new AbortController();
      close = () => {
        if (!open) return;
        open = false;
        clearInterval(keepAlive);
        off();
        aborts.abort();
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", close); // tab closed / hidden
      for (const base of upstreams) void relay(base, aborts.signal, send, () => event("ready", {}));
    },
    cancel() { close(); },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

/** Pipe another instance's local events into this stream, whole frames only (a half-written frame
 *  interleaved with a local one would corrupt both). Its `ready` and keep-alives are dropped — this
 *  stream has its own — except that a RE-connect is announced, so the client catches up. */
async function relay(base: string, signal: AbortSignal, send: (frame: string) => void, resync: () => void): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      const res = await fetch(new URL("/api/events?local=1", base), { signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      if (attempt++ > 0) resync(); // anything published while we were apart was missed
      const decoder = new TextDecoder();
      let buf = "";
      const reader = res.body.getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        buf += decoder.decode(r.value, { stream: true });
        let end: number;
        while ((end = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, end + 2);
          buf = buf.slice(end + 2);
          if (RELAYED.some((name) => frame.startsWith(`event: ${name}\n`))) send(frame);
        }
      }
    } catch { attempt++; /* unreachable or dropped — retry below */ }
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}
