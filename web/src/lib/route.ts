// Minimal path-based routing — no router dependency. The URL is the source of truth. Both
// the Bun server and Vite dev do SPA fallback, so these paths serve index.html.
import { useSyncExternalStore } from "react";

export type PrTab = "overview" | "chat" | "files" | "checks" | "preview";
export type LocalTab = "overview" | "chat" | "files" | "preview";
/** The console's top-level pages, in the sidebar's order. "board" is the Overview at "/". */
export const PAGES = [
  "agents",
  "inbox",
  "previews",
  "integrations",
  "handoffs",
  "settings",
] as const;
export type Page = (typeof PAGES)[number];

/** Old page URLs and where they live now: Repos and GitHub are sections of Settings, Usage is the
 *  Overview's usage card, and Integrations is its own page. The URL is replaced, so Back skips it. */
export const REDIRECTS: Record<string, string> = {
  "/repos": "/settings#repos",
  "/github": "/settings#github",
  "/usage": "/",
  "/settings/integrations": "/integrations",
};
export const redirectFor = (pathname: string): string | undefined => REDIRECTS[pathname.replace(/\/+$/, "") || "/"];
export type Route =
  | { name: "board" }
  | { name: Page }
  | { name: "orchestrator" }
  | { name: "pr"; repo: string; number: number; sub: PrTab }
  | { name: "local"; repo: string; branch: string; sub: LocalTab };

function parse(): Route {
  // overview at "/"; the console pages at /agents, /integrations, /settings…; the orchestrator's own
  // routed page (narrow screens) at /orchestrator; PR detail at /{repo}/prs/{n}[/files|/checks];
  // local-session detail at /{repo}/local/{branch}[/files|/preview] (branch is URI-encoded — may contain "/")
  const to = redirectFor(location.pathname);
  if (to) history.replaceState(null, "", to);
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts[1] === "prs" && parts[2]) {
    return { name: "pr", repo: parts[0]!, number: Number(parts[2]), sub: (parts[3] as PrTab) ?? "overview" };
  }
  if (parts[1] === "local" && parts[2]) {
    return { name: "local", repo: parts[0]!, branch: decodeURIComponent(parts[2]), sub: (parts[3] as LocalTab) ?? "overview" };
  }
  if (parts[0] === "orchestrator" && parts.length === 1) return { name: "orchestrator" };
  if ((PAGES as readonly string[]).includes(parts[0] ?? "") && parts.length === 1) return { name: parts[0] as Page };
  return { name: "board" };
}

const listeners = new Set<() => void>();
let current: Route = parse(); // cached so getSnapshot returns a stable reference
const update = () => { current = parse(); listeners.forEach((l) => l()); };
window.addEventListener("popstate", update);

export function navigate(path: string, replace = false) {
  if (location.pathname + location.search === path) return; // the query counts: /agents?status=running ≠ /agents
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  update();
}

export const useRoute = (): Route =>
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);

/** The URL's query string ("?status=attention…"), re-read on every navigation — the Agents page's
 *  quick filters live here so a filtered view is a link. */
export const useSearch = (): string =>
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => location.search);
