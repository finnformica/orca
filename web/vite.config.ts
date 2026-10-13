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
const buildVersion = (): Plugin => ({
  name: "orca-build-version",
  apply: "build",
  generateBundle() { this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: BUILD_ID }) }); },
});

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss(), buildVersion()],
  define: { __ORCA_BUILD__: JSON.stringify(command === "build" ? BUILD_ID : "dev") },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: Number(process.env.ORCA_UI_PORT ?? 8788),
    allowedHosts: allowedHosts(process.env),
    // HTTP /api only. The interactive terminal's WebSocket does NOT go through here: Vite runs under
    // Bun (the Node-is-blocked rule), and Bun's proxy doesn't complete WS upgrades, so the terminal
    // connects straight to the bridge port instead (see Terminal.tsx / apiPort in /api/config).
    proxy: { "/api": `http://localhost:${API_PORT}` },
  },
}));
