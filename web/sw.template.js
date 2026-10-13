// Orca's service worker — the installed app opens instantly and says so when it is offline. Rendered
// to dist/sw.js by `vite build` (web/vite.config.ts serviceWorkerSource), which fills in the build id
// and the exact list of files that build wrote, so every deploy is a new worker. Only registered from
// a production build (lib/sw.ts).
//
// What it touches, and what it never does:
// - /api/* (the event stream included), /version.json and /sw.js are NOT intercepted: live data and the
//   new-build check always go to the network, as if there were no worker.
// - A page load is answered from THIS build's cached shell (index.html), so it is instant and its
//   hashed bundle is always the one cached beside it; no shell and no network → offline.html.
// - /assets/* are content-hashed: cache first. Other same-origin files (icons, manifest): cached, then
//   refreshed in the background.
// - A new build's worker installs and WAITS. The page's new-build banner asks it to take over
//   ("skip-waiting") and reloads once it has — never mid-session on its own.
const BUILD = "__ORCA_BUILD__";
const PRECACHE = ["__ORCA_PRECACHE__"];
const CACHE = `orca-${BUILD}`;
const SHELL = "/index.html";
const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("orca-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

/** "network" = not intercepted at all. */
function strategy(request) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return "network";
  if (url.pathname.startsWith("/api/") || url.pathname === "/version.json" || url.pathname === "/sw.js") return "network";
  if (request.mode === "navigate") return "shell";
  if (url.pathname.startsWith("/assets/")) return "cache-first";
  return "revalidate";
}

async function fromNetwork(request, cache) {
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function handle(kind, request) {
  const cache = await caches.open(CACHE);
  if (kind === "shell") {
    const shell = await cache.match(SHELL);
    if (shell) return shell;
    try { return await fetch(request); } catch { return (await cache.match(OFFLINE)) ?? new Response("Orca is offline.", { status: 503, headers: { "Content-Type": "text/plain" } }); }
  }
  const cached = await cache.match(request);
  if (kind === "cache-first") return cached ?? fromNetwork(request, cache);
  const fresh = fromNetwork(request, cache).catch(() => cached ?? Response.error());
  return cached ?? fresh;
}

self.addEventListener("fetch", (event) => {
  const kind = strategy(event.request);
  if (kind !== "network") event.respondWith(handle(kind, event.request));
});
