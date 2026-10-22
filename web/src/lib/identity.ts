// The ACTIVE server's identity (shared/serverIdentity.ts): the server this tab talks to — the
// switcher's chosen base, else the home server — never simply the origin that served the page. It
// is read from that server's GET /api/servers `self` row through `apiFetch`, so a chosen server
// answers cross-origin like every other call. The last answer is kept per base, so the reload after
// a switch paints the right name and colour before the first fetch lands.
//
// Applied to the document in one place (`applyIdentity`): `--server` and `--server-mark` on <html>,
// one style sheet with every theme tone for both modes (`themeCss`: the sidebar, primary buttons,
// links, focus rings, the selection, and the tinted surfaces, text and borders every shadcn
// component reads), the page title (`Orca | Personal`) and the favicon (the black
// circle a very dark shade of the theme colour, the orca the colour). Neutral sets no theme at all.
import { useSyncExternalStore } from "react";
import { apiBase, apiFetch, identityOf, PROBE_TIMEOUT_MS, type ServersAnswer } from "./server";
import { persistedKey, readPersisted, writePersisted } from "./persisted";
import { faviconSvg, isNeutral, markBg, markColor, pageTitle, themeCss, type ServerIdentityConfig } from "../../../shared/serverIdentity";

export type ActiveIdentity = {
  /** The display name. */
  label: string;
  color: string;
  /** The Tailscale host name: the default display name. */
  host: string;
  /** What is stored (empty: every field is the default). */
  stored: ServerIdentityConfig;
};

const isIdentity = (v: unknown): v is ActiveIdentity =>
  !!v && typeof v === "object" && typeof (v as ActiveIdentity).label === "string" && typeof (v as ActiveIdentity).color === "string"
  && typeof (v as ActiveIdentity).host === "string" && !!(v as ActiveIdentity).stored && typeof (v as ActiveIdentity).stored === "object";

const key = () => persistedKey("server.identity", apiBase() || "home");
const stored = () => readPersisted<ActiveIdentity | null>(key(), null, (v): v is ActiveIdentity | null => v === null || isIdentity(v));
let current: ActiveIdentity | null = stored();
const subs = new Set<() => void>();

/** The identity of a GET /api/servers answer. Pure. */
export function activeIdentityOf(answer: ServersAnswer): ActiveIdentity {
  const { label, color } = identityOf(answer.self);
  return { label, color, host: answer.self.name, stored: answer.self.identity ?? {} };
}

const THEME_ID = "orca-server-theme";

/** Put the identity on the document: the theme, the title, the favicon. */
export function applyIdentity(id: ActiveIdentity | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Neutral sets nothing: styles.css's defaults are the neutral look.
  const themed = id && !isNeutral(id.color) ? id : null;
  if (themed) {
    root.style.setProperty("--server", themed.color);
    root.style.setProperty("--server-mark", markColor(themed.color));
    root.style.setProperty("--server-mark-bg", markBg(themed.color));
  } else for (const v of ["--server", "--server-mark", "--server-mark-bg"]) root.style.removeProperty(v);
  let sheet = document.getElementById(THEME_ID);
  if (themed) {
    if (!sheet) { sheet = document.createElement("style"); sheet.id = THEME_ID; document.head.appendChild(sheet); }
    sheet.textContent = themeCss(themed.color);
  } else sheet?.remove();
  document.title = pageTitle(id?.label);
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon) icon.href = id ? `data:image/svg+xml,${encodeURIComponent(faviconSvg(id.color))}` : "/favicon.svg";
}
applyIdentity(current);

function set(next: ActiveIdentity): void {
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  writePersisted(key(), next);
  applyIdentity(next);
  subs.forEach((f) => f());
}

/** Ask the active server for its identity. A failure keeps what is shown. A short timeout, like
 *  `probeServer`'s: this polls every minute, and a hung request must never pile up. */
export async function loadIdentity(): Promise<void> {
  try {
    const r = await apiFetch("/api/servers", { cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!r.ok) return;
    const v = await r.json() as ServersAnswer;
    if (v?.self && typeof v.self.name === "string") set(activeIdentityOf(v));
  } catch { /* offline: the cached identity stays */ }
}

export const useServerIdentity = (): ActiveIdentity | null =>
  useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => current);

/** Tests: read the identity again from storage (none after localStorage.clear()). */
export function _resetIdentity(): void { current = stored(); applyIdentity(current); }
