import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { API_PORT } from "../server/ports";

// Vite 5 checks the Host header on every request (including the HMR websocket upgrade) against
// server.allowedHosts — localhost and bare IPs are always allowed, but a tailnet name (e.g.
// "orca-box.tail622bd5.ts.net") is not, so a preview opened over Tailscale 403s with "Blocked
// request" unless that name is listed explicitly. An env var alone does nothing: Vite has no
// built-in __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS — it must be read here and placed into
// server.allowedHosts. ORCA_PREVIEW_HOST is the name a preview command embeds in URLs; the
// __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS env var covers any other host the preview command wants
// to allow (comma-separated). Never `true` — that disables the check entirely.
export const allowedHosts = (env: NodeJS.ProcessEnv): string[] =>
  [env.ORCA_PREVIEW_HOST, ...(env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS?.split(",") ?? [])]
    .map((h) => h?.trim())
    .filter((h): h is string => !!h);

// Every `vite build` gets an id, baked into the bundle (__ORCA_BUILD__) and written to
// dist/version.json. An open tab polls that file (served uncached) and offers a refresh when it names
// a different build — the deploy has moved on under it. `vite serve` has no id: HMR covers it.
const BUILD_ID = new Date().toISOString();
// The same build also writes dist/sw.js (the installed app's service worker, web/sw.template.js) with
// that id and the files to precache: everything the bundle wrote, plus the public files the shell
// needs offline. A new build is therefore a new worker, which waits for the banner's Refresh.
const SW_PUBLIC = ["/index.html", "/offline.html", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png", "/apple-touch-icon.png"];
/** dist/sw.js for a build: the template with its id and precache list filled in. Pure (bar the read). */
export function serviceWorkerSource(build: string, bundleFiles: string[]): string {
  const files = bundleFiles.filter((f) => !f.endsWith(".map") && f !== "version.json" && f !== "index.html").map((f) => `/${f}`);
  const precache = [...new Set([...SW_PUBLIC, ...files])].sort();
  return readFileSync(new URL("./sw.template.js", import.meta.url), "utf8")
    .replace('"__ORCA_BUILD__"', JSON.stringify(build))
    .replace('["__ORCA_PRECACHE__"]', JSON.stringify(precache));
}
const buildVersion = (): Plugin => ({
  name: "orca-build-version",
  apply: "build",
  generateBundle() { this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: BUILD_ID }) }); },
  writeBundle(options, bundle) { writeFileSync(join(options.dir!, "sw.js"), serviceWorkerSource(BUILD_ID, Object.keys(bundle))); },
});

// Dev only, until the server's GET /api/servers lands (the server-switch-api workstream): the bridge
// is asked first, and only when it has no such route does this answer a mock list — this server as
// "Work", and an offline "SMF" — so the server menu has rows to show. Once the bridge answers, its
// list wins and this does nothing.
export const MOCK_SERVERS = (origin: string) => ({
  self: { name: "Work", url: origin },
  servers: [
    { name: "Work", url: origin, online: true, self: true },
    { name: "SMF", url: "http://smf-box.invalid:8787", online: false, self: false },
  ],
});
const mockServers = (): Plugin => ({
  name: "orca-mock-servers",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/api/servers", async (req, res, next) => {
      try {
        const r = await fetch(`http://localhost:${API_PORT}/api/servers`);
        if (r.ok && r.headers.get("content-type")?.includes("json")) return next();
      } catch { /* bridge down: the mock below */ }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(MOCK_SERVERS(`http://${req.headers.host ?? "localhost"}`)));
    });
  },
});

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss(), buildVersion(), mockServers()],
  define: {
    __ORCA_BUILD__: JSON.stringify(command === "build" ? BUILD_ID : "dev"),
    // A branch preview (scripts/preview-orca.sh) sets ORCA_PREVIEW_UI=1 so the page labels its bridge.
    __ORCA_PREVIEW__: JSON.stringify(process.env.ORCA_PREVIEW_UI === "1"),
  },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: Number(process.env.ORCA_UI_PORT ?? 8788),
    allowedHosts: allowedHosts(process.env),
    // HTTP /api only. The interactive terminal's WebSocket does NOT go through here: Vite runs under
    // Bun (the Node-is-blocked rule), and Bun's proxy doesn't complete WS upgrades, so the terminal
    // connects straight to the bridge port instead (see Terminal.tsx / apiPort in /api/config).
    // `xfwd` names the real caller to the bridge, which identifies it before a terminal toggle
    // (server/terminal.ts callerAddress) — through the proxy every request is otherwise loopback.
    proxy: { "/api": { target: `http://localhost:${API_PORT}`, xfwd: true } },
  },
}));
