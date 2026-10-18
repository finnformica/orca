// A server's identity: the display name and theme colour that tell two Orca servers apart (a work
// box and a personal one), like a Slack workspace's name and theme. It is Orca metadata in the app
// config (`serverIdentity`), never the Tailscale machine name or the OS hostname. With nothing set,
// the name is the server's Tailscale host name and the colour comes from that name, so a new server
// has an identity with no setup. Pure: the bridge and the web app both import it.

export type ServerIdentityConfig = { name?: string; color?: string };
/** The identity a server shows: always both fields. */
export type ServerIdentity = { label: string; color: string };

/** The preset theme colours. Each is mid-tone, so it reads on the light and the dark background. */
export const IDENTITY_COLORS = [
  { name: "Blue", value: "#2f6feb" },
  { name: "Green", value: "#1f9d55" },
  { name: "Teal", value: "#0e9f9a" },
  { name: "Purple", value: "#7c4ddb" },
  { name: "Aubergine", value: "#8e3b8a" },
  { name: "Pink", value: "#d6407f" },
  { name: "Orange", value: "#e0700b" },
  { name: "Red", value: "#d9453f" },
] as const;

export const IDENTITY_NAME_MAX = 40;

/** A `#rrggbb` colour in lower case, or undefined. A 3-digit `#rgb` is expanded. */
export function normalizeColor(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${[...s.slice(1)].map((c) => c + c).join("")}`;
  return undefined;
}

/** The preset colour a name maps to (FNV-1a over the lower-case name), so the default is stable. */
export function colorFromName(name: string): string {
  let h = 0x811c9dc5;
  for (const ch of name.trim().toLowerCase()) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return IDENTITY_COLORS[h % IDENTITY_COLORS.length]!.value;
}

/** The identity to show: the stored name, else `fallbackName` (the Tailscale host name); the stored
 *  colour, else the colour of the shown name. */
export function resolveIdentity(stored: ServerIdentityConfig | undefined, fallbackName: string): ServerIdentity {
  const label = stored?.name?.trim() || fallbackName;
  return { label, color: normalizeColor(stored?.color) ?? colorFromName(label) };
}

/** Validation for the app config's `serverIdentity`. */
export function serverIdentityProblems(v: unknown): string[] {
  if (v === undefined) return [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["serverIdentity must be an object { name?, color? }"];
  const s = v as Record<string, unknown>;
  const errors: string[] = [];
  if (s.name !== undefined && !(typeof s.name === "string" && s.name.trim().length <= IDENTITY_NAME_MAX)) {
    errors.push(`serverIdentity.name must be text of at most ${IDENTITY_NAME_MAX} characters`);
  }
  if (s.color !== undefined && !normalizeColor(s.color)) errors.push("serverIdentity.color must be a colour such as #2f6feb");
  return errors;
}

/** The stored form of an edit: trimmed, an empty name or colour cleared, an empty identity null. */
export function identityUpdate(name: unknown, color: unknown): ServerIdentityConfig | null {
  const out: ServerIdentityConfig = {};
  const n = typeof name === "string" ? name.trim() : "";
  if (n) out.name = n.slice(0, IDENTITY_NAME_MAX);
  const c = normalizeColor(color);
  if (c) out.color = c;
  return Object.keys(out).length ? out : null;
}

const ORCA_PATH = "M2.6 12.1C2.6 9.7 5.5 8 9 8L11.4 3L13.8 8C16.6 8 18.7 8.6 20.3 9.5L22.6 6.3L21 11L22.6 15.7L20.3 12.5C17.5 13.6 10.5 14.2 4.4 13.5C3.3 13.37 2.6 12.9 2.6 12.1ZM5.9 9.25a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0 -3Z";

/** web/public/favicon.svg with the circle in `color`: the same mark, the same white shape. */
export function faviconSvg(color: string): string {
  const fill = normalizeColor(color) ?? "#000000";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="${fill}"/>`
    + `<path fill="#fff" stroke="#fff" stroke-width="0.9" stroke-linejoin="round" fill-rule="evenodd" transform="translate(3.48 4.25) scale(0.7)" d="${ORCA_PATH}"/></svg>`;
}

/** The page title: Orca first, then the server's name. */
export const pageTitle = (label: string | undefined): string => (label ? `Orca | ${label}` : "Orca");
