// The ONE way anything on this box takes a screenshot. Workers can't see the UI they build: after an
// OOM (server/cgroup.ts has the incident) headless browsers are off-limits to them, so every UI PR
// shipped unseen. This puts exactly one browser behind the bridge, bounded three ways:
//   1. A queue: one capture at a time, box-wide — N workers asking at once wait, they never fan out
//      into N Chromiums.
//   2. A memory ceiling: the browser runs in its own systemd scope (`cgroup.scopedCommand`, the same
//      wrapper agent runs get) with `SHOT_MEMORY_MAX_GB` and no swap, so a runaway page is OOM-killed
//      inside that scope alone.
//   3. A timeout, and a fresh browser per job that is killed when the job ends (done, failed or timed
//      out) — nothing idles holding memory between shots.
// No dependency: the browser is driven over the Chrome DevTools Protocol on a WebSocket, which Bun
// has built in. The PNG lands in an `AttachmentStore` — on disk under the state dir for now, behind
// an interface so it can move to Postgres with the other attachments (PR #152).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import * as cgroup from "./cgroup";
import { stateDir } from "./state";
import { killTree } from "./preview";
import { scrubbedEnv } from "./env";

export const SHOT_MEMORY_MAX_GB = 1.5;
export const SHOT_CPU_WEIGHT = 50;
export const SHOT_TIMEOUT_MS = 45_000;
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

export type ShotStep = { click: string } | { hover: string } | { scroll: number | string } | { wait: number } | { waitFor: string } | { press: string };
export type ShotRequest = {
  url: string;
  viewport?: { width: number; height: number };
  dark?: boolean;
  /** CSS selector to wait for after load, before the steps. */
  waitFor?: string;
  /** Run in order after load: click a selector (a real mouse click, see `clickSelector`), press a
   *  named key, scroll to a y offset or a selector, wait ms, wait for a selector. */
  steps?: ShotStep[];
  fullPage?: boolean;
  /** Free text kept in the file name (`before`, `after`), so a report can say which is which. */
  label?: string;
  /** Return the page's exceptions, console errors and warnings, and failed requests with the shot. */
  console?: boolean;
};
export type Shot = { id: string; path: string; bytes: number; label?: string; console?: string[] };

/** The origin of a plain-http URL that is not loopback, else undefined. Such a page is not a
 *  secure context, so `crypto.randomUUID` and other APIs are missing and an app like branch-demo
 *  renders blank. The capture browser treats this origin as secure, so a shot shows what the same
 *  preview shows on localhost. Pure. */
export function insecureOrigin(url: string): string | undefined {
  const u = new URL(url);
  if (u.protocol !== "http:") return undefined;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host)) return undefined;
  return u.origin;
}

/** Where shots are kept. Disk today; the interface is all a caller sees, so Postgres can replace it. */
export interface AttachmentStore {
  put(name: string, data: Uint8Array): Promise<{ id: string; path: string }>;
  /** Absolute path of a stored attachment, or undefined when there is none by that id. */
  path(id: string): string | undefined;
}

export function diskStore(dir = join(stateDir(), "attachments", "shots")): AttachmentStore {
  return {
    async put(name, data) {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, name);
      await Bun.write(path, data);
      return { id: name.replace(/\.png$/, ""), path };
    },
    path(id) {
      if (!/^shot-[\w-]+$/.test(id)) return undefined; // never a path out of the dir
      const path = join(dir, `${id}.png`);
      return existsSync(path) ? path : undefined;
    },
  };
}

/** Validate and normalise a request body. Throws a message fit for the caller. Pure. */
export function parseShotRequest(body: any): ShotRequest {
  if (!body || typeof body.url !== "string") throw new Error("url required");
  let u: URL;
  try { u = new URL(body.url); } catch { throw new Error(`not a URL: ${body.url}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs can be captured");
  const viewport = typeof body.viewport === "string" ? parseViewport(body.viewport) : body.viewport;
  if (viewport && !(viewport.width > 0 && viewport.height > 0 && viewport.width <= 4000 && viewport.height <= 4000)) {
    throw new Error("viewport must be WIDTHxHEIGHT, each 1–4000");
  }
  const steps: ShotStep[] = Array.isArray(body.steps) ? body.steps : [];
  for (const s of steps) {
    if (!s || typeof s !== "object" || !("click" in s || "hover" in s || "scroll" in s || "wait" in s || "waitFor" in s || "press" in s)) throw new Error(`unknown step: ${JSON.stringify(s)}`);
  }
  return {
    url: u.toString(), viewport: viewport ?? DEFAULT_VIEWPORT, dark: !!body.dark,
    waitFor: typeof body.waitFor === "string" && body.waitFor ? body.waitFor : undefined,
    steps, fullPage: !!body.fullPage,
    label: typeof body.label === "string" && body.label ? body.label.replace(/[^\w-]+/g, "-").slice(0, 40) : undefined,
    console: !!body.console,
  };
}

export function parseViewport(v: string): { width: number; height: number } {
  const m = v.trim().match(/^(\d+)x(\d+)$/i);
  if (!m) throw new Error(`viewport must be WIDTHxHEIGHT (e.g. 390x844), got ${v}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** The headless browser binary: `ORCA_SHOT_BROWSER`, else the newest Playwright headless shell in
 *  the cache, else one on PATH. With `full`, the newest full Chromium in the cache comes first: the
 *  headless shell ignores `--unsafely-treat-insecure-origin-as-secure` (seen on 156), Chromium does. */
export function findBrowser(env: Record<string, string | undefined> = process.env, opts: { full?: boolean } = {}): string | undefined {
  if (env.ORCA_SHOT_BROWSER) return env.ORCA_SHOT_BROWSER;
  const cache = join(homedir(), ".cache", "ms-playwright");
  const builds = [
    ...(opts.full ? [{ prefix: "chromium-", bin: join("chrome-linux64", "chrome") }] : []),
    { prefix: "chromium_headless_shell-", bin: join("chrome-headless-shell-linux64", "chrome-headless-shell") },
  ];
  try {
    const dirs = readdirSync(cache).sort().reverse();
    for (const b of builds) {
      for (const d of dirs.filter((d) => d.startsWith(b.prefix))) {
        const p = join(cache, d, b.bin);
        if (existsSync(p)) return p;
      }
    }
  } catch { /* no cache */ }
  for (const b of ["chrome-headless-shell", "chromium", "chromium-browser", "google-chrome"]) {
    const p = Bun.which(b);
    if (p) return p;
  }
  return undefined;
}

/** The exact command a capture launches: the browser wrapped in its own capped scope. Pure, so the
 *  test pins the cap without a real systemd or browser. */
export function browserCommand(binary: string, profileDir: string, opts: { scoped: boolean; unit: string; memoryMaxGb?: number; secureOrigin?: string }): string[] {
  return cgroup.scopedCommand([
    binary, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
    "--hide-scrollbars", "--mute-audio", "--disable-extensions", "--remote-debugging-port=0",
    // Chrome refuses a DevTools WebSocket upgrade whose Origin header isn't on an allow-list (a
    // DNS-rebinding guard) — this process has no origin of its own to be on it, so allow any; the
    // debugging port is ephemeral, loopback-only and torn down with the browser after one capture.
    "--remote-allow-origins=*",
    // Each job has a fresh browser, so the flag covers this one URL's origin only (`insecureOrigin`).
    ...(opts.secureOrigin ? [`--unsafely-treat-insecure-origin-as-secure=${opts.secureOrigin}`] : []),
    `--user-data-dir=${profileDir}`, "about:blank",
  ], { available: opts.scoped, memoryMaxGb: opts.memoryMaxGb ?? SHOT_MEMORY_MAX_GB, cpuWeight: SHOT_CPU_WEIGHT, unit: opts.unit });
}

/** One running browser: capture one page, then be killed. */
export interface BrowserSession {
  /** `log` collects the page's errors when `req.console` is set. */
  capture(req: ShotRequest, log: string[]): Promise<Uint8Array>;
  kill(): Promise<void>;
}
/** Start the browser. When `signal` aborts (the job timed out) before it is up, the launch must kill
 *  what it started and reject — the queue moves on only once the browser is gone. */
export type Launch = (argv: string[], env: Record<string, string>, unit: string, signal: AbortSignal) => Promise<BrowserSession>;

/** Options on one request: a signal that cancels it while it is still queued (never once it has
 *  started — a browser already launched runs to completion or its own SHOT_TIMEOUT_MS), and a
 *  callback fed how many jobs are strictly ahead of it each time the queue changes. */
export type ShootOpts = { signal?: AbortSignal; onQueue?: (ahead: number) => void };

export type Shooter = {
  shoot(req: ShotRequest, opts?: ShootOpts): Promise<Shot>;
  /** Jobs waiting plus the one running. */
  depth(): number;
};

/** The queue. Every dependency is injectable, so the tests drive it with a fake browser. */
export function createShooter(deps: {
  launch?: Launch; store?: AttachmentStore; browser?: () => string | undefined; scoped?: () => boolean;
  timeoutMs?: number; memoryMaxGb?: number;
} = {}): Shooter {
  const launch = deps.launch ?? cdpLaunch;
  const store = deps.store ?? diskStore();
  const timeoutMs = deps.timeoutMs ?? SHOT_TIMEOUT_MS;

  // A real array rather than a promise chain, so a queued (not yet started) job can be pulled back
  // out and its caller told why — a worker's Bash call that gave up waiting must not leave a browser
  // launching behind it, and the next job must still run right on its heels.
  type Job = { req: ShotRequest; resolve: (s: Shot) => void; reject: (e: Error) => void; onQueue?: (ahead: number) => void; started: boolean; lastReported?: number };
  const queue: Job[] = [];
  let draining = false;

  // Called after every push and every shift. Only a job whose position actually changed is told —
  // otherwise a third job joining the queue would re-notify every job already waiting ahead of it.
  function reportQueue() {
    queue.forEach((job, i) => {
      if (job.started || job.lastReported === i) return;
      job.lastReported = i;
      job.onQueue?.(i);
    });
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const job = queue[0]!;
        job.started = true;
        try {
          job.resolve(await run(job.req));
        } catch (e) {
          job.reject(e as Error);
        }
        queue.shift();
        reportQueue();
      }
    } finally {
      draining = false;
    }
  }

  async function run(req: ShotRequest): Promise<Shot> {
    const secureOrigin = insecureOrigin(req.url);
    const binary = deps.browser ? deps.browser() : findBrowser(process.env, { full: !!secureOrigin });
    if (!binary) throw new Error("no headless browser on this box (set ORCA_SHOT_BROWSER)");
    const scoped = (deps.scoped ?? (() => cgroup.available()))();
    const id = `shot-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}${req.label ? `-${req.label}` : ""}`;
    const unit = `orca-${id}`;
    const profile = mkdtempSync(join(tmpdir(), "orca-shot-"));
    const argv = browserCommand(binary, profile, { scoped, unit, memoryMaxGb: deps.memoryMaxGb, secureOrigin });
    const log: string[] = [];
    const abort = new AbortController();
    const launching = launch(argv, scoped ? cgroup.runtimeEnv() : {}, unit, abort.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error(`screenshot timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      });
      const png = await Promise.race([launching.then((session) => session.capture(req, log)), timeout]);
      const saved = await store.put(`${id}.png`, png);
      return { ...saved, bytes: png.byteLength, label: req.label, ...(req.console ? { console: log } : {}) };
    } catch (e) {
      // A browser killed by its cgroup's OOM killer reads as a dropped socket; say what happened.
      if (scoped && await cgroup.wasOomKilled(unit, { ...process.env, ...cgroup.runtimeEnv() })) {
        throw new Error(`browser ran out of memory (${deps.memoryMaxGb ?? SHOT_MEMORY_MAX_GB} GB ceiling)`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
      // Killed after EVERY job — done, failed or timed out — and awaited, so the next job in the
      // queue never overlaps this browser. A launch the timeout aborted kills itself and rejects.
      await launching.then((session) => session.kill()).catch(() => {});
      rmSync(profile, { recursive: true, force: true });
    }
  }

  return {
    shoot(req, opts = {}) {
      return new Promise<Shot>((resolve, reject) => {
        const job: Job = { req, resolve, reject, onQueue: opts.onQueue, started: false };
        const cancel = () => {
          if (job.started) return; // already running (or launching); let it finish on its own
          const i = queue.indexOf(job);
          if (i >= 0) queue.splice(i, 1);
          reject(new Error("cancelled before it started"));
          reportQueue();
        };
        if (opts.signal?.aborted) { cancel(); return; }
        opts.signal?.addEventListener("abort", cancel, { once: true });
        queue.push(job);
        reportQueue();
        void drain();
      });
    },
    depth: () => queue.length,
  };
}

// ---- the real browser, over CDP ----

/** How long `kill` waits for a plain SIGTERM before escalating to SIGKILL, and how long it then
 *  waits for THAT before giving up — a browser that ignores SIGTERM (seen on some sandboxed CI
 *  runners) must never hang this job's cleanup forever: every later job in the queue, and the
 *  caller's own promise, is waiting on it to resolve. */
const KILL_GRACE_MS = 3_000;
const KILL_FINAL_MS = 2_000;

/** Spawn the (scoped) browser, read its DevTools URL from stderr, and drive one page. */
export const cdpLaunch: Launch = async (argv, env, unit, signal) => {
  const proc = Bun.spawn(argv, { env: scrubbedEnv(env), stdout: "ignore", stderr: "pipe" });
  const kill = async () => {
    killTree(proc.pid);
    if (argv[0] === "systemd-run") {
      // The scope holds every renderer the browser forked; stopping it kills them all.
      Bun.spawnSync(["systemctl", "--user", "stop", `${unit}.scope`], { env: scrubbedEnv(env), stderr: "ignore" });
    }
    const diedOnTerm = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(KILL_GRACE_MS).then(() => false),
    ]);
    if (diedOnTerm) return;
    killTree(proc.pid, "SIGKILL");
    await Promise.race([proc.exited, Bun.sleep(KILL_FINAL_MS)]).catch(() => {});
  };
  const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  aborted.catch(() => {}); // an abort after the browser is up is the caller's kill, not an error here
  try {
    const wsUrl = await Promise.race([devtoolsUrl(proc), aborted]);
    const cdp = await Promise.race([connect(wsUrl), aborted]);
    return { capture: (req, log) => capture(cdp, req, log), kill: async () => { cdp.close(); await kill(); } };
  } catch (e) {
    await kill();
    throw e;
  }
};

async function devtoolsUrl(proc: Bun.Subprocess<"ignore", "ignore", "pipe">): Promise<string> {
  const reader = proc.stderr.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`browser exited before it was ready: ${buf.slice(-500)}`);
    buf += dec.decode(value);
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      void (async () => { try { while (!(await reader.read()).done); } catch { /* gone */ } })(); // keep draining
      return m[1]!;
    }
  }
}

type Cdp = { send(method: string, params?: object, sessionId?: string): Promise<any>; once(method: string, sessionId?: string): Promise<any>; on(listener: (method: string, params: any) => void): void; close(): void };

/** At most this many console lines, each cut to CONSOLE_LINE_MAX characters. */
const CONSOLE_MAX = 50;
const CONSOLE_LINE_MAX = 500;

/** One line for a CDP event a reader of `--console` needs, else undefined. Pure. */
export function consoleLine(method: string, p: any, urls: Map<string, string>): string | undefined {
  if (method === "Network.requestWillBeSent") { urls.set(p.requestId, p.request.url); return undefined; }
  const line = method === "Runtime.exceptionThrown" ? `exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`
    : method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "warning")
      ? `console.${p.type}: ${p.args.map((a: any) => a.value ?? a.description ?? "").join(" ")}`
    : method === "Log.entryAdded" && (p.entry.level === "error" || p.entry.level === "warning") ? `${p.entry.level}: ${p.entry.text}`
    : method === "Network.loadingFailed" && !p.canceled ? `request failed: ${p.errorText} ${urls.get(p.requestId) ?? ""}`
    : method === "Network.responseReceived" && p.response.status >= 400 ? `HTTP ${p.response.status} ${p.response.url}`
    : undefined;
  return line?.trim().slice(0, CONSOLE_LINE_MAX);
}

function connect(url: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let next = 0;
    const calls = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const waiters: Array<{ method: string; sessionId?: string; resolve: (v: any) => void }> = [];
    const listeners: Array<(method: string, params: any) => void> = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const c = calls.get(msg.id);
        calls.delete(msg.id);
        if (msg.error) c?.reject(new Error(`${msg.error.message}`));
        else c?.resolve(msg.result);
      } else {
        const i = waiters.findIndex((w) => w.method === msg.method && w.sessionId === msg.sessionId);
        if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg.params);
        for (const l of listeners) l(msg.method, msg.params);
      }
    };
    ws.onerror = () => reject(new Error("could not connect to the browser"));
    ws.onclose = () => { for (const c of calls.values()) c.reject(new Error("browser connection closed")); calls.clear(); };
    ws.onopen = () => resolve({
      send(method, params = {}, sessionId) {
        const id = ++next;
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        return new Promise((res, rej) => calls.set(id, { resolve: res, reject: rej }));
      },
      once(method, sessionId) { return new Promise((res) => waiters.push({ method, sessionId, resolve: res })); },
      on(listener) { listeners.push(listener); },
      close() { try { ws.close(); } catch { /* closed */ } },
    });
  });
}

async function capture(cdp: Cdp, req: ShotRequest, log: string[]): Promise<Uint8Array> {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method: string, params?: object) => cdp.send(method, params, sessionId);
  const vp = req.viewport ?? DEFAULT_VIEWPORT;
  await s("Page.enable");
  if (req.console) {
    const urls = new Map<string, string>();
    cdp.on((method, params) => {
      const line = log.length < CONSOLE_MAX ? consoleLine(method, params, urls) : undefined;
      if (line) log.push(line);
    });
    for (const domain of ["Runtime", "Log", "Network"]) await s(`${domain}.enable`);
  }
  await s("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.width < 768 });
  await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: req.dark ? "dark" : "light" }] });
  const loaded = cdp.once("Page.loadEventFired", sessionId);
  const nav = await s("Page.navigate", { url: req.url });
  if (nav.errorText) throw new Error(`could not load ${req.url}: ${nav.errorText}`);
  await loaded;
  const evaluate = async (expression: string) => (await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const waitFor = async (selector: string) => {
    const ok = await evaluate(`new Promise((r) => { const t0 = Date.now(); const f = () => document.querySelector(${JSON.stringify(selector)}) ? r(true) : Date.now() - t0 > 15000 ? r(false) : setTimeout(f, 100); f(); })`);
    if (!ok) throw new Error(`timed out waiting for ${selector}`);
  };
  if (req.waitFor) await waitFor(req.waitFor);
  for (const step of req.steps ?? []) {
    if ("click" in step) {
      await waitFor(step.click);
      await clickSelector(s, evaluate, step.click);
    } else if ("press" in step) {
      await pressKey(s, step.press);
    } else if ("hover" in step) {
      await waitFor(step.hover);
      const { x, y } = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(step.hover)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await Bun.sleep(300); // a hover card's own transition
    } else if ("scroll" in step) {
      await evaluate(typeof step.scroll === "number" ? `window.scrollTo(0, ${step.scroll})` : `document.querySelector(${JSON.stringify(step.scroll)})?.scrollIntoView()`);
    } else if ("wait" in step) {
      await Bun.sleep(Math.min(Math.max(0, Number(step.wait) || 0), 10_000));
    } else {
      await waitFor(step.waitFor);
    }
  }
  await Bun.sleep(300); // a settle for fonts and the last transition
  const { data } = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: !!req.fullPage });
  return Uint8Array.from(Buffer.from(data, "base64"));
}

/** A real mouse click on a selector: move, press and release at its centre over CDP, which fires the
 *  whole pointerdown/mousedown/pointerup/mouseup/click sequence a real user's click would — unlike
 *  `el.click()`, which fires only `click` and never opens a Radix UI menu (it opens on pointerdown).
 *  Falls back to dispatching that same sequence as JS events directly on the element when it has no
 *  visible box to click (zero-size, or still off-screen after scrolling it into view). */
async function clickSelector(s: (method: string, params?: object) => Promise<any>, evaluate: (expr: string) => Promise<any>, selector: string): Promise<void> {
  const sel = JSON.stringify(selector);
  const point = await evaluate(`(() => {
    const el = document.querySelector(${sel});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (point) {
    await s("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await s("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
    await s("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
    return;
  }
  await evaluate(`(() => {
    const el = document.querySelector(${sel});
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
    el.click();
  })()`);
}

/** Enough of each named key for a page's keydown handler to recognise it — codes/keyCodes copied
 *  from the DOM `KeyboardEvent` spec. Any other single character falls back to its own letter/digit. */
const NAMED_KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
};

function keyDescriptor(name: string): { key: string; code: string; keyCode: number; text?: string } {
  const named = NAMED_KEYS[name];
  if (named) return named;
  if (name.length === 1) return { key: name, code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0), text: name };
  throw new Error(`unknown --press key: ${name}`);
}

/** Dispatch a named key (`ArrowDown`, `Enter`, …) as a real keydown/keyup pair over CDP, for a Radix
 *  menu's own keyboard handling once --click has opened it. */
async function pressKey(s: (method: string, params?: object) => Promise<any>, name: string): Promise<void> {
  const d = keyDescriptor(name);
  const base = { key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode };
  await s("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(d.text ? { text: d.text } : {}) });
  await s("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

let shared: Shooter | undefined;
/** The bridge's one queue. */
export const shooter = (): Shooter => (shared ??= createShooter());
