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

/** The stored colour that means "no theme": the old neutral look — the grey sidebar, the black
 *  mark with a white orca, no tint anywhere. */
export const NEUTRAL = "neutral";
export const isNeutral = (color: string | undefined): boolean => color === NEUTRAL;

/** A stored theme: `NEUTRAL`, or a colour as `normalizeColor` reads it. */
export const normalizeTheme = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().toLowerCase() === NEUTRAL ? NEUTRAL : normalizeColor(v);

/** A CSS background for a swatch of the theme: Neutral is half white, half black. */
export const swatchBackground = (color: string): string =>
  isNeutral(color) ? "linear-gradient(135deg, #ffffff 50%, #111111 50%)" : color;

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
  return { label, color: normalizeTheme(stored?.color) ?? colorFromName(label) };
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
  if (s.color !== undefined && !normalizeTheme(s.color)) errors.push(`serverIdentity.color must be a colour such as #2f6feb, or "${NEUTRAL}"`);
  return errors;
}

/** The stored form of an edit: trimmed, an empty name or colour cleared, an empty identity null. */
export function identityUpdate(name: unknown, color: unknown): ServerIdentityConfig | null {
  const out: ServerIdentityConfig = {};
  const n = typeof name === "string" ? name.trim() : "";
  if (n) out.name = n.slice(0, IDENTITY_NAME_MAX);
  const c = normalizeTheme(color);
  if (c) out.color = c;
  return Object.keys(out).length ? out : null;
}

const ORCA_PATH = "M2.6 12.1C2.6 9.7 5.5 8 9 8L11.4 3L13.8 8C16.6 8 18.7 8.6 20.3 9.5L22.6 6.3L21 11L22.6 15.7L20.3 12.5C17.5 13.6 10.5 14.2 4.4 13.5C3.3 13.37 2.6 12.9 2.6 12.1ZM5.9 9.25a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0 -3Z";

// ---- Theme tones (Slack's workspace theme): every tone comes from the one server colour. Each tone
// keeps the colour's hue and fixes the lightness in OKLCH (chroma capped), so any custom colour gives
// the same contrast as a preset. Light mode gets a deep sidebar; dark mode a darker, greyer one.

type Oklch = { l: number; c: number; h: number };
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const channels = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/** A `#rrggbb` colour in OKLCH. */
export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = channels(normalizeColor(hex) ?? "#000000").map(toLinear) as [number, number, number];
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.hypot(A, B);
  return { l: L, c, h: c < 1e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const A = c * Math.cos((h * Math.PI) / 180), B = c * Math.sin((h * Math.PI) / 180);
  const l3 = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m3 = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s3 = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

/** An OKLCH colour as `#rrggbb`. Out of the sRGB gamut, the chroma drops until it fits (the hue and
 *  the lightness stay). */
export function oklchToHex(o: Oklch): string {
  let { c } = o;
  let rgb = oklchToLinear({ ...o, c });
  for (let i = 0; i < 24 && rgb.some((v) => v < -1e-4 || v > 1 + 1e-4); i++) { c *= 0.9; rgb = oklchToLinear({ ...o, c }); }
  return `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, v))))) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG relative luminance of a `#rrggbb` colour. */
export const luminance = (hex: string): number => {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio of two `#rrggbb` colours (1 to 21). */
export const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

/** One tone: the server colour's hue at lightness `l`, its chroma scaled by `k` and capped at `max`. */
const tone = (o: Oklch, l: number, k: number, max: number) => oklchToHex({ l, c: Math.min(o.c * k, max), h: o.h });
const alpha = (hex: string, a: number) => `rgb(${channels(hex).map((v) => Math.round(v * 255)).join(" ")} / ${a})`;

/** The colour picker's grid (Word's theme colours): the base row is the 8 presets plus two more
 *  hues, and each column holds 3 tints and 2 shades of its hue, made in OKLCH. `IDENTITY_COLORS`
 *  stays 8 long: `colorFromName` indexes it, so a new preset would move every Auto colour. */
export const GRID_HUES = [...IDENTITY_COLORS, { name: "Gold", value: "#c28a00" }, { name: "Slate", value: "#5b6b7f" }] as const;
export type GridCell = { value: string; label: string };
const TINTS = [{ k: 0.75, c: 0.3, word: "lighter 3" }, { k: 0.5, c: 0.55, word: "lighter 2" }, { k: 0.25, c: 0.8, word: "lighter 1" }];
const SHADES = [{ k: 0.78, word: "darker 1" }, { k: 0.58, word: "darker 2" }];
/** One column per base hue: the base first, then lightest to darkest. */
export function colorGrid(): GridCell[][] {
  return GRID_HUES.map(({ name, value }) => {
    const o = hexToOklch(value);
    return [
      { value, label: name },
      ...TINTS.map((t) => ({ value: oklchToHex({ l: o.l + (0.97 - o.l) * t.k, c: o.c * t.c, h: o.h }), label: `${name}, ${t.word}` })),
      ...SHADES.map((t) => ({ value: oklchToHex({ l: o.l * t.k, c: o.c * (0.6 + 0.4 * t.k), h: o.h }), label: `${name}, ${t.word}` })),
    ];
  });
}

/** The orca's colour on the mark's circle: the server colour, lifted until it reads on the circle's
 *  very dark shade. Neutral: white. */
export function markColor(color: string): string {
  if (isNeutral(color)) return "#ffffff";
  const o = hexToOklch(normalizeColor(color) ?? "#8f8f8f");
  return o.l >= 0.68 ? normalizeColor(color) ?? "#8f8f8f" : oklchToHex({ ...o, l: 0.68 });
}

/** The mark's circle: a very dark, low-chroma shade of the server colour, so the circle and the
 *  orca read as one colour. Neutral: black. */
export function markBg(color: string): string {
  if (isNeutral(color)) return "#000000";
  const o = hexToOklch(normalizeColor(color) ?? "#8f8f8f");
  return oklchToHex({ l: 0.2, c: Math.min(o.c * 0.35, 0.045), h: o.h });
}

/** The CSS variables for one mode. The `sb-*` tones are the frame's: the sidebar, the top bar and
 *  the closed Ask pill (styles.css maps them onto the neutral tokens inside `[data-chrome]`). The
 *  others tint the rest of the app: a faint wash behind the content (`background`), selected
 *  controls and rows (`selected`), page headings, primary buttons, links, focus rings and the text
 *  selection. The surface, text and border tokens (`card`, `popover`, `muted`, `accent`, `border`,
 *  the `text-*` stops of the chat log…) are tinted neutrals: each one keeps the lightness of its
 *  neutral default in styles.css and takes a low chroma of the server hue, so every shadcn
 *  component (menus, popovers, dialogs, cards, chart frames) follows the theme with no class of its
 *  own. Status and chart series colours never change. */
export type ThemeTones = Record<
  "primary" | "primary-foreground" | "link" | "ring" | "selection" | "server-soft" | "server-fg"
  | "background" | "selected" | "selected-fg" | "heading"
  | "foreground" | "card" | "card-foreground" | "popover" | "popover-foreground"
  | "secondary" | "secondary-foreground" | "muted" | "muted-foreground" | "accent" | "accent-foreground"
  | "border" | "input" | "text-soft" | "text-faint" | "text-fainter"
  | "sb-bg" | "sb-fg" | "sb-muted" | "sb-hover" | "sb-field" | "sb-border" | "sb-active" | "sb-active-fg",
  string
>;

/** The tinted neutrals of one mode: the text, surface and border tokens. */
function neutrals(o: Oklch, mode: "light" | "dark") {
  if (mode === "light") {
    const fg = tone(o, 0.25, 0.3, 0.02), muted = tone(o, 0.955, 0.3, 0.012);
    return {
      foreground: fg, "card-foreground": fg, "popover-foreground": fg, "secondary-foreground": fg, "accent-foreground": fg,
      // Cards and menus stay near white on the wash; fills a step down from it.
      card: tone(o, 0.997, 0.1, 0.004), popover: tone(o, 0.997, 0.1, 0.004),
      secondary: muted, muted, accent: tone(o, 0.932, 0.4, 0.022),
      "muted-foreground": tone(o, 0.5, 0.4, 0.03),
      border: alpha(tone(o, 0.35, 0.8, 0.08), 0.14), input: alpha(tone(o, 0.35, 0.8, 0.08), 0.14),
      "text-soft": tone(o, 0.42, 0.35, 0.025), "text-faint": tone(o, 0.63, 0.3, 0.025), "text-fainter": tone(o, 0.63, 0.3, 0.025),
    };
  }
  const fg = tone(o, 0.931, 0.1, 0.01), muted = tone(o, 0.255, 0.35, 0.026);
  return {
    foreground: fg, "card-foreground": fg, "popover-foreground": fg, "secondary-foreground": fg, "accent-foreground": fg,
    // Each surface a step lighter than the one under it, as the neutral #111 / #161616 / #1c1c1c.
    card: tone(o, 0.205, 0.3, 0.022), popover: tone(o, 0.23, 0.3, 0.024),
    secondary: muted, muted, accent: muted,
    "muted-foreground": tone(o, 0.72, 0.2, 0.02),
    border: alpha(tone(o, 0.85, 0.4, 0.04), 0.13), input: alpha(tone(o, 0.85, 0.4, 0.04), 0.13),
    "text-soft": tone(o, 0.864, 0.15, 0.015), "text-faint": tone(o, 0.62, 0.2, 0.02), "text-fainter": tone(o, 0.535, 0.25, 0.022),
  };
}

export function themeTones(color: string, mode: "light" | "dark"): ThemeTones {
  const o = hexToOklch(normalizeColor(color) ?? "#8f8f8f");
  if (mode === "light") {
    const fg = tone(o, 0.97, 0.1, 0.012);
    return {
      ...neutrals(o, mode),
      primary: tone(o, 0.5, 1, 0.17), "primary-foreground": "#ffffff",
      link: tone(o, 0.48, 1, 0.16), "server-fg": tone(o, 0.48, 1, 0.16), ring: tone(o, 0.6, 1, 0.17),
      selection: alpha(tone(o, 0.7, 1, 0.14), 0.35), "server-soft": alpha(tone(o, 0.6, 1, 0.15), 0.14),
      // A very light wash behind the white cards; selected controls a soft fill with deep text.
      background: tone(o, 0.968, 0.2, 0.016), selected: tone(o, 0.92, 0.45, 0.055),
      "selected-fg": tone(o, 0.4, 1, 0.15), heading: tone(o, 0.3, 0.7, 0.09),
      // A deep shade, like Slack's aubergine: white text on it, the active page a brighter pill.
      "sb-bg": tone(o, 0.33, 0.8, 0.1), "sb-fg": fg, "sb-muted": tone(o, 0.83, 0.3, 0.035),
      "sb-hover": tone(o, 0.4, 0.8, 0.1), "sb-field": tone(o, 0.28, 0.8, 0.09), "sb-border": alpha("#ffffff", 0.14),
      "sb-active": tone(o, 0.52, 1, 0.15), "sb-active-fg": "#ffffff",
    };
  }
  const fg = tone(o, 0.93, 0.1, 0.01);
  return {
    ...neutrals(o, mode),
    primary: tone(o, 0.52, 0.85, 0.13), "primary-foreground": "#ffffff",
    link: tone(o, 0.8, 0.8, 0.11), "server-fg": tone(o, 0.8, 0.8, 0.11), ring: tone(o, 0.68, 0.85, 0.13),
    selection: alpha(tone(o, 0.55, 0.8, 0.12), 0.45), "server-soft": alpha(tone(o, 0.6, 0.8, 0.1), 0.2),
    // A dark tinted surface behind the tinted cards; selected controls a muted fill with light text.
    background: tone(o, 0.185, 0.3, 0.022), selected: tone(o, 0.31, 0.5, 0.06),
    "selected-fg": tone(o, 0.9, 0.3, 0.04), heading: tone(o, 0.95, 0.2, 0.025),
    // Darker and greyer than light mode's: a tint on near-black, never a bright block beside the page.
    "sb-bg": tone(o, 0.215, 0.4, 0.04), "sb-fg": fg, "sb-muted": tone(o, 0.74, 0.2, 0.02),
    "sb-hover": tone(o, 0.27, 0.45, 0.045), "sb-field": tone(o, 0.18, 0.4, 0.035), "sb-border": alpha("#ffffff", 0.09),
    "sb-active": tone(o, 0.36, 0.6, 0.075), "sb-active-fg": fg,
  };
}

/** The style sheet `applyIdentity` puts in the page: both modes' tones. `:root:root` outranks
 *  styles.css's `:root` / `.dark` defaults whatever order the two sheets load in. */
export function themeCss(color: string): string {
  if (isNeutral(color)) return ""; // styles.css's defaults are the neutral look
  const block = (t: ThemeTones) => Object.entries(t).map(([k, v]) => `--${k}:${v};`).join("");
  return `:root:root{${block(themeTones(color, "light"))}}:root:root.dark{${block(themeTones(color, "dark"))}}`;
}

/** web/public/favicon.svg's look in the server's theme: the circle a very dark shade of the colour
 *  (`markBg`), the orca the colour (lifted to read on it, `markColor`). Neutral: black and white. */
export function faviconSvg(color: string): string {
  const fill = markColor(color);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="${markBg(color)}"/>`
    + `<path fill="${fill}" stroke="${fill}" stroke-width="0.9" stroke-linejoin="round" fill-rule="evenodd" transform="translate(3.48 4.25) scale(0.7)" d="${ORCA_PATH}"/></svg>`;
}

/** The page title: Orca first, then the server's name. */
export const pageTitle = (label: string | undefined): string => (label ? `Orca | ${label}` : "Orca");
