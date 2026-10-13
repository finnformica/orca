// The tab's one live stream, server side (server/events.ts): this instance's bus, plus every other
// instance's relayed server-to-server — so the browser holds ONE connection however many chats are
// open, and a chat for a cloud workstream still hears the cloud. The other instance is a real second
// process (its own bus), as in production.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as bus from "../server/bus";
import { eventStream } from "../server/events";
import { native } from "./happydom";

// The preload swaps in happy-dom's fetch/Response for component tests; this is server code.
const dom = { fetch: globalThis.fetch, Response: globalThis.Response, AbortController: globalThis.AbortController };
beforeAll(() => { Object.assign(globalThis, { fetch: native.fetch, Response: native.Response, AbortController: native.AbortController }); });
afterAll(() => { Object.assign(globalThis, dom); });

const root = resolve(import.meta.dir, "..");
const procs: Bun.Subprocess[] = [];
afterAll(() => { for (const p of procs) p.kill(); });

/** Another instance: serves its LOCAL events, and publishes a turn event on POST /publish. */
async function startUpstream(dir: string, port: number): Promise<Bun.Subprocess> {
  const script = join(dir, "upstream.ts");
  await writeFile(script, `
    import * as bus from ${JSON.stringify(join(root, "server/bus.ts"))};
    import { eventStream } from ${JSON.stringify(join(root, "server/events.ts"))};
    const server = Bun.serve({ port: Number(process.argv[2]), hostname: "127.0.0.1", idleTimeout: 0, fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/api/events") return eventStream(req, []);
      bus.publish({ kind: "turn", runId: "cloud-run", repo: "branch-demo", branch: "on-cloud" });
      return new Response("ok");
    } });
    console.log(server.port);
  `);
  const proc = Bun.spawn(["bun", script, String(port)], { stdout: "pipe", stderr: "inherit" });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const { value } = await reader.read(); // the port, once it is listening
  reader.releaseLock();
  expect(Number(new TextDecoder().decode(value).trim())).toBeGreaterThan(0);
  return proc;
}

/** Read SSE frames off a response, waiting for one that matches. */
function frames(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const seen: string[] = [];
  return {
    seen,
    async until(match: (frame: string) => boolean, ms = 8_000): Promise<string> {
      const deadline = Date.now() + ms;
      for (;;) {
        const i = seen.findIndex(match);
        if (i >= 0) return seen.splice(i, 1)[0]!;
        if (Date.now() > deadline) throw new Error(`no matching frame; saw ${JSON.stringify(seen)}`);
        const r = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
        if (!r || r.done) continue;
        buf += decoder.decode(r.value, { stream: true });
        let end: number;
        while ((end = buf.indexOf("\n\n")) >= 0) { seen.push(buf.slice(0, end)); buf = buf.slice(end + 2); }
      }
    },
  };
}

test("one stream carries this instance's events and relays the other's; a relay that comes back says ready so chats catch up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-events-"));
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new native.Response() });
  const upPort = probe.port!;
  probe.stop(true);
  let upstream = await startUpstream(dir, upPort);
  const upBase = `http://127.0.0.1:${upPort}`;

  const local = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: (req) => eventStream(req, [upBase]) });
  const aborts = new AbortController();
  const res = await fetch(`http://127.0.0.1:${local.port}/api/events`, { signal: aborts.signal });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const feed = frames(res);
  await feed.until((f) => f.startsWith("event: ready"));

  // This instance's bus — tagged with repo/branch, since every chat in the tab shares the stream.
  bus.publish({ kind: "step", runId: "laptop-run", repo: "orca", branch: "feat", steps: [{ at: 1, kind: "text", text: "hi" }] });
  const step = await feed.until((f) => f.startsWith("event: step"));
  expect(JSON.parse(step.split("data: ")[1]!)).toMatchObject({ repo: "orca", branch: "feat", runId: "laptop-run" });
  // Streamed reply text rides the same stream (never stored, so it is only ever pushed).
  bus.publish({ kind: "delta", runId: "laptop-run", repo: "orca", branch: "feat", text: "Hel" });
  const delta = await feed.until((f) => f.startsWith("event: delta"));
  expect(JSON.parse(delta.split("data: ")[1]!)).toEqual({ repo: "orca", branch: "feat", runId: "laptop-run", text: "Hel" });

  // The other instance's bus, relayed (poke until the relay is connected).
  const relayed = async () => {
    for (let i = 0; i < 40; i++) {
      await fetch(`${upBase}/publish`, { method: "POST" }).catch(() => {});
      const f = await feed.until((x) => x.startsWith("event: turn"), 250).catch(() => null);
      if (f) return f;
    }
    throw new Error("never relayed");
  };
  expect(JSON.parse((await relayed()).split("data: ")[1]!)).toMatchObject({ repo: "branch-demo", branch: "on-cloud", runId: "cloud-run" });
  expect(feed.seen.some((f) => f.startsWith("event: ready"))).toBe(false); // the upstream's own `ready` is not passed on

  // The other instance restarts (a deploy): anything published in the gap was missed, so the stream
  // says `ready` again — the chats' cue to catch up from their cursors — and relaying resumes.
  upstream.kill();
  await upstream.exited;
  upstream = await startUpstream(dir, upPort);
  await feed.until((f) => f.startsWith("event: ready"), 10_000);
  await relayed();

  aborts.abort();
  local.stop(true);
}, 30_000);
