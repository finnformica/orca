// The installed app's service worker (web/sw.template.js, rendered to dist/sw.js by vite.config's
// serviceWorkerSource) run for real in a fake worker scope: in-memory caches, a network that can go
// down. It must precache this build's shell, open pages from it, cache hashed assets, show the offline
// page with nothing to serve, NEVER intercept /api (the event stream included) or the new-build check,
// and only take over when the page asks (skip-waiting). Then the page's side, lib/sw.ts.
import { describe, expect, test } from "bun:test";
import { serviceWorkerSource } from "../web/vite.config";
import { applyUpdate, registerServiceWorker } from "@/lib/sw";
import { native } from "./happydom";

const ORIGIN = "http://orca.test";
const Res = native.Response;
type Req = { url: string; method: string; mode?: string };

function boot(build = "b1", files = ["assets/index-abc.js", "assets/index-abc.css", "index.html", "version.json", "assets/index-abc.js.map"]) {
  const src = serviceWorkerSource(build, files);
  const stores = new Map<string, Map<string, Response>>();
  const network = { up: true, hits: [] as string[] };
  const key = (r: string | Req) => new URL(typeof r === "string" ? r : r.url, ORIGIN).href;
  const net = async (r: string | Req) => {
    const url = key(r);
    network.hits.push(new URL(url).pathname);
    if (!network.up) throw new TypeError("offline");
    return new Res(`net:${new URL(url).pathname}`, { status: 200 });
  };
  const open = async (name: string) => {
    const m = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, m);
    return {
      match: async (r: string | Req) => m.get(key(r))?.clone(),
      put: async (r: string | Req, res: Response) => { m.set(key(r), res); },
      addAll: async (urls: string[]) => { for (const u of urls) m.set(key(u), await net(u)); },
    };
  };
  const caches = { open, keys: async () => [...stores.keys()], delete: async (n: string) => stores.delete(n) };
  const handlers = new Map<string, (e: unknown) => void>();
  const self = {
    location: { origin: ORIGIN }, skipped: 0, claimed: 0,
    addEventListener: (t: string, h: (e: unknown) => void) => handlers.set(t, h),
    skipWaiting() { this.skipped++; }, clients: { claim: async () => { self.claimed++; } },
  };
  new Function("self", "caches", "fetch", "Response", src)(self, caches, net, Res);
  const fire = async (type: string, extra: Record<string, unknown> = {}) => {
    let responded: Promise<Response> | undefined, waited: Promise<unknown> | undefined;
    handlers.get(type)!({ ...extra, respondWith: (p: Promise<Response>) => { responded = p; }, waitUntil: (p: Promise<unknown>) => { waited = p; } });
    await waited;
    return responded;
  };
  const get = (path: string, mode = "cors", method = "GET") => fire("fetch", { request: { url: `${ORIGIN}${path}`, method, mode } });
  return { src, stores, network, self, fire, get };
}

describe("service worker (sw.js)", () => {
  test("the build fills in its id and precaches the shell, offline page and every built file — not maps or version.json", () => {
    const { src } = boot("2026-10-13T09:00:00.000Z");
    expect(src).toContain('const BUILD = "2026-10-13T09:00:00.000Z";');
    const precache = JSON.parse(src.match(/const PRECACHE = (\[.*\]);/)![1]!) as string[];
    expect(precache).toContain("/index.html");
    expect(precache).toContain("/offline.html");
    expect(precache).toContain("/assets/index-abc.js");
    expect(precache).toContain("/assets/index-abc.css");
    expect(precache).not.toContain("/version.json");
    expect(precache.some((f) => f.endsWith(".map"))).toBe(false);
  });

  test("install precaches into this build's cache; activate drops older builds' caches only, and claims", async () => {
    const sw = boot("b2");
    sw.stores.set("orca-b1", new Map());
    sw.stores.set("someone-else", new Map());
    await sw.fire("install");
    expect(sw.stores.get("orca-b2")!.has(`${ORIGIN}/index.html`)).toBe(true);
    await sw.fire("activate");
    expect([...sw.stores.keys()].sort()).toEqual(["orca-b2", "someone-else"]);
    expect(sw.self.claimed).toBe(1);
  });

  test("never intercepted: /api (the event stream too), the new-build check, sw.js itself, writes, other origins", async () => {
    const sw = boot();
    await sw.fire("install");
    for (const path of ["/api/agents?repo=r", "/api/events", "/version.json", "/sw.js"]) expect(await sw.get(path)).toBeUndefined();
    expect(await sw.get("/index.html", "cors", "POST")).toBeUndefined();
    expect(await sw.fire("fetch", { request: { url: "https://fonts.googleapis.com/css2", method: "GET", mode: "cors" } })).toBeUndefined();
  });

  test("a page opens from this build's cached shell, instantly, even with the network down", async () => {
    const sw = boot();
    await sw.fire("install");
    sw.network.hits = [];
    sw.network.up = false;
    const res = await sw.get("/agents?status=running", "navigate");
    expect(await res!.text()).toBe("net:/index.html"); // the precached copy
    expect(sw.network.hits).toEqual([]);
  });

  test("no shell and no network: the offline page", async () => {
    const sw = boot();
    sw.stores.set("orca-b1", new Map([[`${ORIGIN}/offline.html`, new Res("offline page")]]));
    sw.network.up = false;
    expect(await (await sw.get("/", "navigate"))!.text()).toBe("offline page");
  });

  test("hashed assets: cache first; one not yet cached is fetched once and kept", async () => {
    const sw = boot();
    await sw.fire("install");
    sw.network.hits = [];
    expect(await (await sw.get("/assets/index-abc.js"))!.text()).toBe("net:/assets/index-abc.js");
    expect(sw.network.hits).toEqual([]);
    await sw.get("/assets/lazy-xyz.js");
    await sw.get("/assets/lazy-xyz.js");
    expect(sw.network.hits).toEqual(["/assets/lazy-xyz.js"]);
  });

  test("it takes over only when the page asks", async () => {
    const sw = boot();
    await sw.fire("message", { data: "something else" });
    expect(sw.self.skipped).toBe(0);
    await sw.fire("message", { data: "skip-waiting" });
    expect(sw.self.skipped).toBe(1);
  });
});

describe("the page's side (lib/sw.ts)", () => {
  const fakeWin = (secure: boolean) => {
    const registered: string[] = [];
    let onLoad = () => {};
    const win = {
      isSecureContext: secure,
      navigator: { serviceWorker: { register: async (u: string) => { registered.push(u); } } },
      addEventListener: (_: string, h: () => void) => { onLoad = h; },
    } as unknown as Window;
    return { win, registered, load: () => onLoad() };
  };

  test("registered only from a production build in a secure context", () => {
    for (const [build, secure, want] of [["b1", true, ["/sw.js"]], ["dev", true, []], [undefined, true, []], ["b1", false, []]] as const) {
      const f = fakeWin(secure);
      registerServiceWorker(build, f.win);
      f.load();
      expect(f.registered).toEqual([...want]);
    }
  });

  const fakeReg = (waitingAfterUpdate: boolean) => {
    const posted: unknown[] = [];
    const listeners: (() => void)[] = [];
    const waiting = { postMessage: (m: unknown) => posted.push(m) };
    const reg = { waiting: null as typeof waiting | null, update: async () => { if (waitingAfterUpdate) setTimeout(() => { reg.waiting = waiting; }, 150); } };
    const nav = { serviceWorker: { getRegistration: async () => reg, addEventListener: (_: string, l: () => void) => listeners.push(l) } } as unknown as Parameters<typeof applyUpdate>[0];
    return { reg, nav, posted, takeOver: () => listeners.forEach((l) => l()) };
  };

  test("Refresh on the new-build banner: the waiting worker is told to skip waiting, and the page reloads once it controls", async () => {
    const f = fakeReg(true);
    let reloads = 0;
    await applyUpdate(f.nav, () => { reloads++; }, 2000);
    expect(f.posted).toEqual(["skip-waiting"]);
    expect(reloads).toBe(0); // not before the new worker has taken over
    f.takeOver();
    expect(reloads).toBe(1);
  });

  test("no worker (http, dev) or none arriving: a plain reload", async () => {
    let reloads = 0;
    await applyUpdate({ serviceWorker: { getRegistration: async () => undefined } } as unknown as Parameters<typeof applyUpdate>[0], () => { reloads++; });
    await applyUpdate({} as Parameters<typeof applyUpdate>[0], () => { reloads++; });
    const f = fakeReg(false);
    await applyUpdate(f.nav, () => { reloads++; }, 300);
    expect(reloads).toBe(3);
    expect(f.posted).toEqual([]);
  });
});
