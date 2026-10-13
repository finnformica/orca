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

export const SHOT_MEMORY_MAX_GB = 1.5;
export const SHOT_CPU_WEIGHT = 50;
export const SHOT_TIMEOUT_MS = 45_000;
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

export type ShotStep = { click: string } | { scroll: number | string } | { wait: number } | { waitFor: string };
export type ShotRequest = {
  url: string;
  viewport?: { width: number; height: number };
  dark?: boolean;
  /** CSS selector to wait for after load, before the steps. */
  waitFor?: string;
  /** Run in order after load: click a selector, scroll to a y offset or a selector, wait ms, wait for a selector. */
  steps?: ShotStep[];
  fullPage?: boolean;
  /** Free text kept in the file name (`before`, `after`), so a report can say which is which. */
  label?: string;
};
export type Shot = { id: string; path: string; bytes: number; label?: string };

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
    if (!s || typeof s !== "object" || !("click" in s || "scroll" in s || "wait" in s || "waitFor" in s)) throw new Error(`unknown step: ${JSON.stringify(s)}`);
  }
  return {
    url: u.toString(), viewport: viewport ?? DEFAULT_VIEWPORT, dark: !!body.dark,
    waitFor: typeof body.waitFor === "string" && body.waitFor ? body.waitFor : undefined,
    steps, fullPage: !!body.fullPage,
    label: typeof body.label === "string" && body.label ? body.label.replace(/[^\w-]+/g, "-").slice(0, 40) : undefined,
  };
}

export function parseViewport(v: string): { width: number; height: number } {
  const m = v.trim().match(/^(\d+)x(\d+)$/i);
  if (!m) throw new Error(`viewport must be WIDTHxHEIGHT (e.g. 390x844), got ${v}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** The headless browser binary: `ORCA_SHOT_BROWSER`, else the newest Playwright headless shell or
 *  Chromium in the cache, else one on PATH. */
export function findBrowser(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.ORCA_SHOT_BROWSER) return env.ORCA_SHOT_BROWSER;
  const cache = join(homedir(), ".cache", "ms-playwright");
  try {
    const dirs = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
    for (const d of dirs) {
      const p = join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
      if (existsSync(p)) return p;
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
export function browserCommand(binary: string, profileDir: string, opts: { scoped: boolean; unit: string; memoryMaxGb?: number }): string[] {
  return cgroup.scopedCommand([
    binary, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
    "--hide-scrollbars", "--mute-audio", "--disable-extensions", "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`, "about:blank",
  ], { available: opts.scoped, memoryMaxGb: opts.memoryMaxGb ?? SHOT_MEMORY_MAX_GB, cpuWeight: SHOT_CPU_WEIGHT, unit: opts.unit });
}

/** One running browser: capture one page, then be killed. */
export interface BrowserSession {
  capture(req: ShotRequest): Promise<Uint8Array>;
  kill(): Promise<void>;
}
/** Start the browser. When `signal` aborts (the job timed out) before it is up, the launch must kill
 *  what it started and reject — the queue moves on only once the browser is gone. */
export type Launch = (argv: string[], env: Record<string, string>, unit: string, signal: AbortSignal) => Promise<BrowserSession>;

export type Shooter = {
  shoot(req: ShotRequest): Promise<Shot>;
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
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  async function run(req: ShotRequest): Promise<Shot> {
    const binary = (deps.browser ?? findBrowser)();
    if (!binary) throw new Error("no headless browser on this box (set ORCA_SHOT_BROWSER)");
    const scoped = (deps.scoped ?? (() => cgroup.available()))();
    const id = `shot-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}${req.label ? `-${req.label}` : ""}`;
    const unit = `orca-${id}`;
    const profile = mkdtempSync(join(tmpdir(), "orca-shot-"));
    const argv = browserCommand(binary, profile, { scoped, unit, memoryMaxGb: deps.memoryMaxGb });
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
      const png = await Promise.race([launching.then((session) => session.capture(req)), timeout]);
      const saved = await store.put(`${id}.png`, png);
      return { ...saved, bytes: png.byteLength, label: req.label };
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
    shoot(req) {
      pending++;
      const job = tail.then(() => run(req));
      tail = job.catch(() => {}).finally(() => { pending--; });
      return job;
    },
    depth: () => pending,
  };
}

// ---- the real browser, over CDP ----

/** Spawn the (scoped) browser, read its DevTools URL from stderr, and drive one page. */
export const cdpLaunch: Launch = async (argv, env, unit, signal) => {
  const proc = Bun.spawn(argv, { env: { ...process.env, ...env }, stdout: "ignore", stderr: "pipe" });
  const kill = async () => {
    killTree(proc.pid);
    if (argv[0] === "systemd-run") {
      // The scope holds every renderer the browser forked; stopping it kills them all.
      Bun.spawnSync(["systemctl", "--user", "stop", `${unit}.scope`], { env: { ...process.env, ...env }, stderr: "ignore" });
    }
    await proc.exited.catch(() => {});
  };
  const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  aborted.catch(() => {}); // an abort after the browser is up is the caller's kill, not an error here
  try {
    const wsUrl = await Promise.race([devtoolsUrl(proc), aborted]);
    const cdp = await Promise.race([connect(wsUrl), aborted]);
    return { capture: (req) => capture(cdp, req), kill: async () => { cdp.close(); await kill(); } };
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

type Cdp = { send(method: string, params?: object, sessionId?: string): Promise<any>; once(method: string, sessionId?: string): Promise<any>; close(): void };

function connect(url: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let next = 0;
    const calls = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const waiters: Array<{ method: string; sessionId?: string; resolve: (v: any) => void }> = [];
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
      close() { try { ws.close(); } catch { /* closed */ } },
    });
  });
}

async function capture(cdp: Cdp, req: ShotRequest): Promise<Uint8Array> {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method: string, params?: object) => cdp.send(method, params, sessionId);
  const vp = req.viewport ?? DEFAULT_VIEWPORT;
  await s("Page.enable");
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
      await evaluate(`document.querySelector(${JSON.stringify(step.click)}).click()`);
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

let shared: Shooter | undefined;
/** The bridge's one queue. */
export const shooter = (): Shooter => (shared ??= createShooter());
