import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { registerServiceWorker } from "./lib/sw";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The installed app's offline shell (production builds only — see lib/sw.ts).
registerServiceWorker(typeof __ORCA_BUILD__ === "undefined" ? undefined : __ORCA_BUILD__);
