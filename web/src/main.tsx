import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { registerServiceWorker } from "./lib/sw";
import "./lib/motionProbe"; // `?probe=motion`: a timing log of the dock slide (off otherwise)
import { QueryClientProvider } from "@tanstack/react-query";
import { firstRenderDone, queryClient, startPersistence } from "./lib/queryClient";

// The app's one QueryClient (lib/queryClient.ts). The last chats and Inbox it saw are read from disk
// first — at most a short wait — so the installed app opens on them after the phone ended it, while
// every view refetches. `Rendered` comes after <App />, so its effect runs after every page effect:
// the page's own fetches go out before the board store's first load (lib/queryClient.ts).
function Rendered() {
  useEffect(firstRenderDone, []);
  return null;
}
void startPersistence().finally(() => createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Rendered />
    </QueryClientProvider>
  </StrictMode>,
));

// The installed app's offline shell (production builds only — see lib/sw.ts).
registerServiceWorker(typeof __ORCA_BUILD__ === "undefined" ? undefined : __ORCA_BUILD__);
