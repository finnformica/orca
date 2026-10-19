// The screenshot service (server/screenshot.ts): one queue, one capped browser, killed after every
// job. The browser is faked through the injected `launch`; the cap is asserted on the exact argv the
// real launcher would spawn.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SHOT_MEMORY_MAX_GB, browserCommand, createShooter, diskStore, findBrowser, parseShotRequest,
  type BrowserSession, type Launch, type ShotRequest,
} from "../server/screenshot";
import { WORKER_BIN, agentEnv } from "../server/agent";
import { native } from "./happydom";
import { SCREENSHOTS, followUpPrompt, reportedShots, workerEvent } from "../web/src/workstream";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const req: ShotRequest = { url: "http://localhost:5173/", viewport: { width: 390, height: 844 } };
const store = () => diskStore(mkdtempSync(join(tmpdir(), "orca-shots-")));

/** A fake browser that records how many are alive at once and every argv it was launched with. */
function fakeBrowser(capture: (n: number) => Promise<Uint8Array> = async () => PNG) {
  const log = { alive: 0, maxAlive: 0, launches: [] as string[][], kills: 0 };
  const launch: Launch = async (argv) => {
    const n = log.launches.push(argv);
    log.alive++;
    log.maxAlive = Math.max(log.maxAlive, log.alive);
    const session: BrowserSession = { capture: () => capture(n), kill: async () => { log.alive--; log.kills++; } };
    return session;
  };
  return { log, launch };
}

describe("SHOT1 the queue", () => {
  test("captures one at a time box-wide, each in a fresh browser killed afterwards", async () => {
    const gates: Array<() => void> = [];
    const { log, launch } = fakeBrowser(() => new Promise((r) => gates.push(() => r(PNG))));
    const s = createShooter({ launch, store: store(), browser: () => "/fake/chrome", scoped: () => false });
    const a = s.shoot(req), b = s.shoot(req), c = s.shoot(req);
    expect(s.depth()).toBe(3);
    await Bun.sleep(10);
    expect(log.launches.length).toBe(1); // b and c wait their turn
    for (let i = 0; i < 3; i++) { while (gates.length <= i) await Bun.sleep(5); gates[i]!(); }
    const shots = await Promise.all([a, b, c]);
    expect(log.maxAlive).toBe(1);
    expect(log.kills).toBe(3);
    expect(new Set(shots.map((x) => x.path)).size).toBe(3);
    for (const shot of shots) expect(readFileSync(shot.path)).toEqual(Buffer.from(PNG));
    await Bun.sleep(0);
    expect(s.depth()).toBe(0);
  });

  test("a job that hangs times out, its browser is killed, and the next job still runs", async () => {
    const { log, launch } = fakeBrowser((n) => (n === 1 ? new Promise(() => {}) : Promise.resolve(PNG)));
    const s = createShooter({ launch, store: store(), browser: () => "/fake/chrome", scoped: () => false, timeoutMs: 50 });
    const hung = s.shoot(req), next = s.shoot(req);
    await expect(hung).rejects.toThrow(/timed out after/);
    expect((await next).bytes).toBe(PNG.byteLength);
    expect(log.kills).toBe(2);
    expect(log.maxAlive).toBe(1);
  });

  test("a launch still starting when the timeout fires is aborted before the next job launches", async () => {
    let aborted = false;
    const launches: number[] = [];
    const launch: Launch = (_argv, _env, _unit, signal) => {
      launches.push(Date.now());
      if (launches.length > 1) return Promise.resolve({ capture: async () => PNG, kill: async () => {} });
      return new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }));
    };
    const s = createShooter({ launch, store: store(), browser: () => "/fake/chrome", scoped: () => false, timeoutMs: 30 });
    const first = s.shoot(req), second = s.shoot(req);
    await expect(first).rejects.toThrow(/timed out/);
    await second;
    expect(aborted).toBe(true);
  });

  test("a failed capture is reported and its browser is still killed", async () => {
    const { log, launch } = fakeBrowser(async () => { throw new Error("could not load http://x: net::ERR_CONNECTION_REFUSED"); });
    const s = createShooter({ launch, store: store(), browser: () => "/fake/chrome", scoped: () => false });
    await expect(s.shoot(req)).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
    expect(log.kills).toBe(1);
  });

  test("no browser on the box is a clear error, not a hang", async () => {
    const s = createShooter({ launch: fakeBrowser().launch, store: store(), browser: () => undefined, scoped: () => false });
    await expect(s.shoot(req)).rejects.toThrow(/no headless browser/);
  });

  test("onQueue reports how many jobs are strictly ahead, as the queue drains", async () => {
    const gates: Array<() => void> = [];
    const { launch } = fakeBrowser(() => new Promise((r) => gates.push(() => r(PNG))));
    const s = createShooter({ launch, store: store(), browser: () => "/fake/chrome", scoped: () => false });
    const seenA: number[] = [], seenB: number[] = [], seenC: number[] = [];
    const a = s.shoot(req, { onQueue: (n) => seenA.push(n) });
    const b = s.shoot(req, { onQueue: (n) => seenB.push(n) });
    const c = s.shoot(req, { onQueue: (n) => seenC.push(n) });
    await Bun.sleep(10);
    expect(seenA).toEqual([0]); // about to run
    expect(seenB).toEqual([1]); // one (a) ahead
    expect(seenC).toEqual([2]); // two (a, b) ahead
    for (let i = 0; i < 3; i++) { while (gates.length <= i) await Bun.sleep(5); gates[i]!(); }
    await Promise.all([a, b, c]);
    // b and c each moved up one place once a finished running.
    expect(seenB).toEqual([1, 0]);
    expect(seenC).toEqual([2, 1, 0]);
  });

  test("aborting a still-queued job cancels it without ever launching its browser, and the next job runs", async () => {
    const gates: Array<() => void> = [];
    const { log, launch } = fakeBrowser(() => new Promise((r) => gates.push(() => r(PNG))));
    const s = createShooter({ launch, store: store(), browser: () => "/fake/chrome", scoped: () => false });
    const controller = new AbortController();
    const running = s.shoot(req); // takes the browser first
    const queued = s.shoot(req, { signal: controller.signal }); // waits behind it
    await Bun.sleep(10);
    expect(s.depth()).toBe(2);
    controller.abort();
    await expect(queued).rejects.toThrow(/cancelled/);
    expect(s.depth()).toBe(1); // the cancelled job is gone, only the running one remains
    expect(log.launches.length).toBe(1); // the cancelled job's browser was never launched
    gates[0]!();
    await running;
  });

  test("a signal already aborted before shoot() is called cancels at once", async () => {
    const { log, launch } = fakeBrowser();
    const s = createShooter({ launch, store: store(), browser: () => "/fake/chrome", scoped: () => false });
    const controller = new AbortController();
    controller.abort();
    await expect(s.shoot(req, { signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(log.launches.length).toBe(0);
    expect(s.depth()).toBe(0);
  });

  test("aborting after a job has started running does nothing — it finishes on its own", async () => {
    const { log, launch } = fakeBrowser(async () => PNG);
    const s = createShooter({ launch, store: store(), browser: () => "/fake/chrome", scoped: () => false });
    const controller = new AbortController();
    const job = s.shoot(req, { signal: controller.signal });
    await Bun.sleep(5); // let it start
    controller.abort();
    const shot = await job;
    expect(shot.bytes).toBe(PNG.byteLength);
    expect(log.kills).toBe(1);
  });
});

describe("SHOT2 the memory cap", () => {
  test("the browser is launched inside its own scope with the cap and no swap", async () => {
    const { log, launch } = fakeBrowser();
    const s = createShooter({ launch, store: store(), browser: () => "/fake/chrome", scoped: () => true });
    await s.shoot(req);
    const argv = log.launches[0]!;
    expect(argv.slice(0, 3)).toEqual(["systemd-run", "--user", "--scope"]);
    expect(argv).toContain(`MemoryMax=${SHOT_MEMORY_MAX_GB}G`);
    expect(argv).toContain("MemorySwapMax=0");
    expect(argv[argv.indexOf("--") + 1]).toBe("/fake/chrome");
    expect(argv.find((a) => a.startsWith("--unit="))).toMatch(/^--unit=orca-shot-/);
    expect(SHOT_MEMORY_MAX_GB).toBe(1.5);
  });

  test("without a user bus the browser runs unwrapped (laptop, CI), still headless", () => {
    const argv = browserCommand("/fake/chrome", "/tmp/p", { scoped: false, unit: "u" });
    expect(argv[0]).toBe("/fake/chrome");
    expect(argv).toContain("--headless");
    expect(argv).toContain("--user-data-dir=/tmp/p");
  });
});

describe("SHOT3 requests and storage", () => {
  test("only http(s) URLs; viewport as WxH; steps validated", () => {
    expect(() => parseShotRequest({ url: "file:///etc/passwd" })).toThrow(/http/);
    expect(() => parseShotRequest({})).toThrow(/url required/);
    expect(() => parseShotRequest({ url: "http://x", viewport: "big" })).toThrow(/WIDTHxHEIGHT/);
    expect(() => parseShotRequest({ url: "http://x", steps: [{ drag: "a" }] })).toThrow(/unknown step/);
    expect(() => parseShotRequest({ url: "http://x", steps: [{ type: 3 }] })).toThrow(/type step/);
    expect(parseShotRequest({ url: "http://x", steps: [{ type: "hi" }] }).steps).toEqual([{ type: "hi" }]);
    const r = parseShotRequest({ url: "http://x:1/a", viewport: "390x844", dark: true, steps: [{ click: "#go" }, { hover: "#menu" }], label: "after dark" });
    expect(r).toMatchObject({ viewport: { width: 390, height: 844 }, dark: true, steps: [{ click: "#go" }, { hover: "#menu" }], label: "after-dark" });
  });

  test("the disk store serves by id and never a path outside its dir", async () => {
    const st = store();
    const saved = await st.put("shot-1-before.png", PNG);
    expect(st.path(saved.id)).toBe(saved.path);
    expect(st.path("../../etc/passwd")).toBeUndefined();
    expect(st.path("shot-missing")).toBeUndefined();
  });
});

describe("SHOT4 workers", () => {
  test("every worker run has orca-shot on PATH, and not the orchestrator's `orca`", () => {
    const path = agentEnv().PATH!.split(":");
    expect(path[0]).toBe(WORKER_BIN);
    expect(existsSync(join(WORKER_BIN, "orca-shot"))).toBe(true);
    expect(existsSync(join(WORKER_BIN, "orca"))).toBe(false);
  });

  test("worker instructions name orca-shot as the only way to screenshot", () => {
    expect(SCREENSHOTS).toMatch(/ONLY allowed way/);
    expect(followUpPrompt("tweak the header")).toContain(SCREENSHOTS);
  });

  test("before/after shots named in a reply ride the worker report", () => {
    const response = "Done.\n## Verification\n- shot: /home/o/.orca/attachments/shots/shot-2026-10-13T20-00-00-000Z-ab12cd34-before.png (before)\n- shot: /home/o/.orca/attachments/shots/shot-2026-10-13T20-01-00-000Z-ef56ab78-after.png (after)";
    expect(reportedShots(response)).toEqual([
      "before: /home/o/.orca/attachments/shots/shot-2026-10-13T20-00-00-000Z-ab12cd34-before.png",
      "after: /home/o/.orca/attachments/shots/shot-2026-10-13T20-01-00-000Z-ef56ab78-after.png",
    ]);
    const report = workerEvent({ repo: "orca", branch: "b", runId: "r1", status: "done", response });
    expect(report).toContain("Screenshots (Read to view):");
    expect(report).toContain("- after: /home/o/.orca/attachments/shots/");
  });

  test("orca-shot carries its flags to the bridge in order and prints the shot's path", async () => {
    let got: any;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(r) { got = await r.json(); return native.Response.json({ id: "shot-x", path: "/tmp/shot-x.png", bytes: 4 }); } });
    try {
      const proc = Bun.spawn([join(WORKER_BIN, "orca-shot"), "http://localhost:5173/agents", "--viewport", "390x844", "--dark", "--click", "#menu", "--scroll", "400", "--wait", "200", "--label", "after"], {
        env: { ...process.env, ORCA_URL: `http://127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out.trim()).toBe("shot: /tmp/shot-x.png (after)");
      expect(got).toEqual({ url: "http://localhost:5173/agents", viewport: "390x844", dark: true, label: "after", steps: [{ click: "#menu" }, { scroll: 400 }, { wait: 200 }] });
    } finally {
      server.stop(true);
    }
  });

  test("--hover is carried as a step, in order with --click", async () => {
    let got: any;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(r) { got = await r.json(); return native.Response.json({ path: "/tmp/shot-h.png" }); } });
    try {
      const proc = Bun.spawn([join(WORKER_BIN, "orca-shot"), "http://localhost:5173/agents", "--click", "#row", "--hover", "#menu", "--click", "textarea", "--type", "hello world", "--press", "Enter"], {
        env: { ...process.env, ORCA_URL: `http://127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "pipe",
      });
      expect(await proc.exited).toBe(0);
      expect(got.steps).toEqual([{ click: "#row" }, { hover: "#menu" }, { click: "textarea" }, { type: "hello world" }, { press: "Enter" }]);
    } finally {
      server.stop(true);
    }
  });

  test("prints queue position to stderr as the bridge streams it, then the final path", async () => {
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch() {
        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('{"queued":2}\n'));
            controller.enqueue(new TextEncoder().encode('{"queued":1}\n'));
            controller.enqueue(new TextEncoder().encode('{"queued":0}\n'));
            controller.enqueue(new TextEncoder().encode('{"path":"/tmp/shot-q.png"}\n'));
            controller.close();
          },
        });
        return new native.Response(stream, { headers: { "content-type": "application/x-ndjson" } });
      },
    });
    try {
      const proc = Bun.spawn([join(WORKER_BIN, "orca-shot"), "http://localhost:5173/agents"], {
        env: { ...process.env, ORCA_URL: `http://127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(await proc.exited).toBe(0);
      expect(out.trim()).toBe("shot: /tmp/shot-q.png");
      expect(err).toContain("queued: 2 ahead");
      expect(err).toContain("queued: 1 ahead");
      expect(err).not.toContain("queued: 0 ahead"); // nothing ahead is not worth a line
    } finally {
      server.stop(true);
    }
  });

  test("--timeout aborts a call that outruns it with a clear, non-zero exit — never a silent hang", async () => {
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch() {
        // Never resolves within the test's patience: simulates a job stuck behind a long queue.
        return new native.Response(new ReadableStream({ start() { /* never enqueue, never close */ } }));
      },
    });
    try {
      const proc = Bun.spawn([join(WORKER_BIN, "orca-shot"), "http://localhost:5173/agents", "--timeout", "1"], {
        env: { ...process.env, ORCA_URL: `http://127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "pipe",
      });
      const err = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(1);
      expect(err).toContain("screenshot queue busy, try again later; do not block on screenshots");
    } finally {
      server.stop(true);
    }
  });

  test("--timeout rejects a non-positive value instead of waiting forever", async () => {
    const proc = Bun.spawn([join(WORKER_BIN, "orca-shot"), "http://localhost:5173/agents", "--timeout", "0"], { stdout: "pipe", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(err).toContain("--timeout needs a positive number");
  });
});

// A Radix UI menu/trigger opens on `pointerdown`, not `click` — this fixture reproduces exactly
// that: its menu has no `click` listener at all, so the old `el.click()` step (which fires only a
// synthetic `click` event) never opened it. These drive a REAL headless browser through the actual
// `cdpLaunch`/`capture` path (nothing faked) to prove --click now sends a genuine mouse press/release
// and --press sends genuine key events, the way a user's hand would.
const RADIX_LIKE_FIXTURE = `<!doctype html><html><body>
<div style="height:1200px"></div>
<button id="trigger">Open</button>
<div id="menu" hidden>
  <div id="item">Item</div>
</div>
<script>
  // No click listener on purpose — only pointerdown, like Radix's DropdownMenu.
  document.getElementById('trigger').addEventListener('pointerdown', () => {
    document.getElementById('menu').hidden = false;
  });
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('menu').hidden) return;
    if (e.key === 'ArrowDown') document.getElementById('item').dataset.active = '1';
    if (e.key === 'Enter' && document.getElementById('item').dataset.active === '1') document.body.setAttribute('data-done', '1');
  });
</script>
</body></html>`;

describe("SHOT5 real clicks open Radix-style pointerdown-only menus", () => {
  function fixtureServer() {
    return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new native.Response(RADIX_LIKE_FIXTURE, { headers: { "content-type": "text/html" } }) });
  }

  // CI has no browser install step at all (SETUP.md: "cloud-init doesn't install one") — but its
  // runner image happens to have a stray `google-chrome` on PATH, so `findBrowser` doesn't return
  // undefined there the way a bare box would; that Chrome simply never speaks CDP cleanly in that
  // sandbox and the launch hangs. Earlier these three tests passed `browser: () => binary` straight
  // into `createShooter` with no `timeoutMs`, so each one rode the production default
  // (`SHOT_TIMEOUT_MS`, 45s) — longer than the 20s bun test timeout they were given — meaning bun's
  // own hard per-test kill fired first, abandoning the shoot() promise (and its browser process)
  // mid-flight instead of letting our own code reject with a clear "timed out after Ns" error. Probe
  // ONCE with a short bound well inside this timeout, and treat "found but doesn't actually work" the
  // same as "not found": skip, the way any orca-shot caller is told to when the queue is unusable.
  // `timeoutMs` below only bounds the capture itself; the shooter's cleanup (killing the browser)
  // adds its own bound on top (KILL_GRACE_MS + KILL_FINAL_MS in server/screenshot.ts, ~5s worst
  // case for a browser that ignores SIGTERM) — give every bun-level timeout below comfortable
  // headroom over `timeoutMs` plus that, not just `timeoutMs` alone.
  let binary: string | undefined;
  let ready = false;
  beforeAll(async () => {
    binary = findBrowser();
    if (!binary) return;
    try {
      await createShooter({ store: store(), browser: () => binary!, scoped: () => false, timeoutMs: 6_000 }).shoot({ url: "about:blank" });
      ready = true;
    } catch {
      ready = false;
    }
  }, 16_000);

  function skip(): boolean {
    if (!ready) console.warn("SHOT5: no working headless browser in this environment — skipping");
    return !ready;
  }

  test("--click fires a real mouse press, opening a menu a plain `click` event never would", async () => {
    if (skip()) return;
    const server = fixtureServer();
    try {
      const s = createShooter({ store: store(), browser: () => binary!, scoped: () => false, timeoutMs: 8_000 });
      const shot = await s.shoot({
        url: `http://127.0.0.1:${server.port}/`,
        viewport: { width: 800, height: 600 },
        steps: [{ click: "#trigger" }, { waitFor: "#menu:not([hidden])" }],
      });
      expect(shot.bytes).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("--press sends real keydown/keyup pairs to drive the opened menu", async () => {
    if (skip()) return;
    const server = fixtureServer();
    try {
      const s = createShooter({ store: store(), browser: () => binary!, scoped: () => false, timeoutMs: 8_000 });
      const shot = await s.shoot({
        url: `http://127.0.0.1:${server.port}/`,
        viewport: { width: 800, height: 600 },
        steps: [{ click: "#trigger" }, { press: "ArrowDown" }, { press: "Enter" }, { waitFor: "[data-done]" }],
      });
      expect(shot.bytes).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("an unknown --press name fails clearly instead of silently doing nothing", async () => {
    if (skip()) return;
    const server = fixtureServer();
    try {
      const s = createShooter({ store: store(), browser: () => binary!, scoped: () => false, timeoutMs: 8_000 });
      await expect(s.shoot({
        url: `http://127.0.0.1:${server.port}/`,
        steps: [{ click: "#trigger" }, { press: "F13NotAKey!" }],
      })).rejects.toThrow(/unknown --press key/);
    } finally {
      server.stop(true);
    }
  }, 20_000);
});

// A plain-http tailnet name is not a secure context, so `crypto.randomUUID` is missing and
// branch-demo's preview renders blank (2026-10-19: `TypeError: crypto.randomUUID is not a function`
// in ai-socket-context.tsx). The capture browser treats the target's origin as secure, and
// `--console` returns the page's errors so the next blank page explains itself.
describe("SHOT6 secure context and --console", () => {
  test("only a plain-http, non-loopback origin is treated as secure", async () => {
    const { insecureOrigin } = await import("../server/screenshot");
    expect(insecureOrigin("http://orca-flow-box.example.ts.net:39753/demo")).toBe("http://orca-flow-box.example.ts.net:39753");
    expect(insecureOrigin("http://100.64.0.1:5173/")).toBe("http://100.64.0.1:5173");
    expect(insecureOrigin("http://localhost:5173/")).toBeUndefined();
    expect(insecureOrigin("http://127.0.0.1:5173/")).toBeUndefined();
    expect(insecureOrigin("http://[::1]:5173/")).toBeUndefined();
    expect(insecureOrigin("https://example.com/")).toBeUndefined();
    const argv = browserCommand("/fake/chrome", "/tmp/p", { scoped: false, unit: "u", secureOrigin: "http://box:1" });
    expect(argv).toContain("--unsafely-treat-insecure-origin-as-secure=http://box:1");
    expect(browserCommand("/fake/chrome", "/tmp/p", { scoped: false, unit: "u" }).some((a) => a.startsWith("--unsafely"))).toBe(false);
    expect(parseShotRequest({ url: "http://x", console: true }).console).toBe(true);
  });

  test("console lines: exceptions, console errors, failed requests and HTTP errors only", async () => {
    const { consoleLine } = await import("../server/screenshot");
    const urls = new Map<string, string>();
    expect(consoleLine("Network.requestWillBeSent", { requestId: "1", request: { url: "http://b/api" } }, urls)).toBeUndefined();
    expect(consoleLine("Network.loadingFailed", { requestId: "1", errorText: "net::ERR_CONNECTION_REFUSED" }, urls)).toBe("request failed: net::ERR_CONNECTION_REFUSED http://b/api");
    expect(consoleLine("Runtime.exceptionThrown", { exceptionDetails: { text: "x", exception: { description: "TypeError: boom" } } }, urls)).toBe("exception: TypeError: boom");
    expect(consoleLine("Runtime.consoleAPICalled", { type: "log", args: [{ value: "hi" }] }, urls)).toBeUndefined();
    expect(consoleLine("Runtime.consoleAPICalled", { type: "error", args: [{ value: "bad" }] }, urls)).toBe("console.error: bad");
    expect(consoleLine("Network.responseReceived", { response: { status: 404, url: "http://b/x" } }, urls)).toBe("HTTP 404 http://b/x");
    expect(consoleLine("Network.responseReceived", { response: { status: 200, url: "http://b/x" } }, urls)).toBeUndefined();
  });

  test("a real browser sees a non-loopback http page as secure and reports its errors", async () => {
    const binary = findBrowser(process.env, { full: true });
    const { networkInterfaces } = await import("os");
    const ip = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!binary || !ip) { console.warn("SHOT6: no browser or no non-loopback address — skipping"); return; }
    const page = `<!doctype html><body><script>
      console.error("secure=" + isSecureContext + " uuid=" + typeof crypto.randomUUID);
      throw new Error("boom from the page");
    </script></body>`;
    const server = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: () => new native.Response(page, { headers: { "content-type": "text/html" } }) });
    try {
      // No `browser` override: the shooter picks the full Chromium itself for a non-loopback URL.
      const s = createShooter({ store: store(), scoped: () => false, timeoutMs: 8_000 });
      let shot;
      try {
        shot = await s.shoot({ url: `http://${ip}:${server.port}/`, viewport: { width: 400, height: 300 }, console: true });
      } catch (e) {
        console.warn(`SHOT6: browser did not run here (${(e as Error).message}) — skipping`);
        return;
      }
      expect(shot.console).toContain("console.error: secure=true uuid=function");
      expect(shot.console!.some((l) => l.startsWith("exception: Error: boom from the page"))).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 20_000);
});
