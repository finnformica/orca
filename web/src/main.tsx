import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { registerServiceWorker } from "./lib/sw";
import "./lib/motionProbe"; // `?probe=motion`: a timing log of the dock slide (off otherwise)
import { cacheHydrate } from "./lib/cache";

// The last chats and Inbox this app saw (lib/cache.ts) are read from disk first — at most a short wait
// — so the installed app opens on them after the phone ended it, while every view refetches.
void cacheHydrate().finally(() => createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
));

// The installed app's offline shell (production builds only — see lib/sw.ts).
registerServiceWorker(typeof __ORCA_BUILD__ === "undefined" ? undefined : __ORCA_BUILD__);
