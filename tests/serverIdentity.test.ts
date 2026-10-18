// The server identity (shared/serverIdentity.ts): the display name and theme colour that tell two
// Orca servers apart. Pure rules, the identity on GET /api/servers' self row, and the config store:
// only Settings' setter writes it, and the other writers of the document keep it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as db from "../server/db";
import { configDocument, invalidateConfig, loadConfig, parseConfigDocument, saveConfigDocument, setInstanceTerminal, setServerIdentity } from "../server/config";
import { withIdentity, type ServersAnswer } from "../server/servers";
import {
  GRID_HUES, IDENTITY_COLORS, colorFromName, colorGrid, contrast, faviconSvg, hexToOklch, identityUpdate, markColor, normalizeColor, oklchToHex, pageTitle,
  resolveIdentity, serverIdentityProblems, themeCss, themeTones,
} from "../shared/serverIdentity";
import { freshSchema } from "./pg";

test("ID1: with nothing set, the name is the host name and the colour is a preset derived from it, stable", () => {
  const presets = IDENTITY_COLORS.map((c) => c.value as string);
  expect(presets.length).toBe(8);
  expect(resolveIdentity(undefined, "orca-flow-box")).toEqual({ label: "orca-flow-box", color: colorFromName("orca-flow-box") });
  expect(presets).toContain(colorFromName("orca-flow-box"));
  expect(colorFromName("Personal")).toBe(colorFromName(" personal ")); // case and spaces do not change it
  // Two names, two colours (the work and personal box names).
  expect(colorFromName("orca-flow-box")).not.toBe(colorFromName("orca-personal-box"));
  // A stored name takes the colour of the NAME shown; a stored colour wins.
  expect(resolveIdentity({ name: "Work" }, "orca-flow-box")).toEqual({ label: "Work", color: colorFromName("Work") });
  expect(resolveIdentity({ name: " ", color: "#ABC" }, "box")).toEqual({ label: "box", color: "#aabbcc" });
});

test("ID2: validation and the stored form of an edit", () => {
  expect(normalizeColor("#2F6FEB")).toBe("#2f6feb");
  expect(normalizeColor("blue")).toBeUndefined();
  expect(serverIdentityProblems(undefined)).toEqual([]);
  expect(serverIdentityProblems({ name: "Work", color: "#2f6feb" })).toEqual([]);
  expect(serverIdentityProblems({ color: "red" })).toEqual(["serverIdentity.color must be a colour such as #2f6feb"]);
  expect(serverIdentityProblems({ name: "x".repeat(41) })).toHaveLength(1);
  expect(serverIdentityProblems([])).toHaveLength(1);
  expect(identityUpdate("  Personal ", "#1F9D55")).toEqual({ name: "Personal", color: "#1f9d55" });
  expect(identityUpdate("", "")).toBeNull(); // both cleared: back to the defaults
  expect(identityUpdate("Work", "")).toEqual({ name: "Work" });
});

test("ID3: the title keeps Orca first; the favicon keeps the black circle, the orca takes the theme colour", () => {
  expect(pageTitle("Personal")).toBe("Orca | Personal");
  expect(pageTitle(undefined)).toBe("Orca");
  const svg = faviconSvg("#1f9d55");
  expect(svg).toContain('<circle cx="12" cy="12" r="12" fill="#000000"/>');
  expect(svg).toContain(`<path fill="${markColor("#1f9d55")}"`);
  for (const c of IDENTITY_COLORS) expect(contrast(markColor(c.value), "#000000")).toBeGreaterThanOrEqual(4.5); // the orca reads on black
  const file = readFileSync(new URL("../web/public/favicon.svg", import.meta.url), "utf8");
  const mark = (s: string) => s.match(/ d="([^"]+)"/)![1];
  expect(mark(svg)).toBe(mark(file)); // the same shape
  expect(svg).toContain('transform="translate(3.48 4.25) scale(0.7)"');
});

test("ID4: GET /api/servers' self row carries the identity; the name stays the Tailscale host name", () => {
  const answer: ServersAnswer = { enabled: true, source: "self", tailscaleApi: false, self: { name: "orca-flow-box", url: "http://orca-flow-box:8787" }, servers: [] };
  expect(withIdentity(answer, undefined).self).toEqual({ name: "orca-flow-box", url: "http://orca-flow-box:8787", label: "orca-flow-box", color: colorFromName("orca-flow-box"), identity: {} });
  expect(withIdentity(answer, { name: "Work", color: "#2f6feb" }).self).toMatchObject({ name: "orca-flow-box", label: "Work", color: "#2f6feb", identity: { name: "Work", color: "#2f6feb" } });
});

test("ID5: Settings' setter stores it in the app config; the terminal switch and a re-saved document keep it", async () => {
  const prev = process.env.ORCA_DATABASE_URL;
  const pg = await freshSchema("identity");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  invalidateConfig();
  try {
    const doc = { repos: [{ name: "app", repoPath: "/tmp/app", worktreeRoot: "/tmp/app/.worktrees", baseBranch: "main" }], portRange: [30000, 40000], staleHours: 24 };
    await saveConfigDocument(parseConfigDocument(doc).config!);
    expect((await loadConfig()).serverIdentity).toBeUndefined();
    await setInstanceTerminal("box", true);
    await setServerIdentity({ name: "Personal", color: "#1f9d55" });
    invalidateConfig();
    let cfg = await loadConfig();
    expect(cfg.serverIdentity).toEqual({ name: "Personal", color: "#1f9d55" });
    expect(cfg.terminal).toEqual({ box: true }); // the setter keeps the terminal flag
    await setInstanceTerminal("box", false); // and the terminal setter keeps the identity
    invalidateConfig();
    cfg = await loadConfig();
    expect(cfg.serverIdentity).toEqual({ name: "Personal", color: "#1f9d55" });
    // The stored document round-trips it (repo add and account edits re-save the parsed document).
    const parsed = parseConfigDocument(await configDocument());
    expect(parsed.errors).toEqual([]);
    expect(parsed.config!.serverIdentity).toEqual({ name: "Personal", color: "#1f9d55" });
    expect(parseConfigDocument({ ...doc, serverIdentity: { color: "nope" } }).errors).toEqual(["serverIdentity.color must be a colour such as #2f6feb"]);
    await setServerIdentity(null);
    invalidateConfig();
    expect((await loadConfig()).serverIdentity).toBeUndefined();
  } finally {
    await db.close();
    await pg.drop();
    if (prev === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prev;
    invalidateConfig();
  }
});

test("ID6: every theme tone comes from the one colour, and its text keeps WCAG AA contrast in both modes", () => {
  expect(oklchToHex(hexToOklch("#2f6feb"))).toBe("#2f6feb"); // the OKLCH round trip is exact
  // Every preset, plus custom colours at the edges: pure yellow, black, white, grey.
  for (const color of [...IDENTITY_COLORS.map((c) => c.value), "#ffff00", "#000000", "#ffffff", "#8f8f8f"]) {
    for (const mode of ["light", "dark"] as const) {
      const t = themeTones(color, mode);
      const page = mode === "light" ? "#f9f9f8" : "#111111";
      const at = `${color} ${mode}`;
      expect([at, contrast(t["sb-fg"], t["sb-bg"]) >= 7]).toEqual([at, true]);
      expect([at, contrast(t["sb-muted"], t["sb-bg"]) >= 4.5]).toEqual([at, true]);
      expect([at, contrast(t["sb-muted"], t["sb-hover"]) >= 4.5]).toEqual([at, true]);
      expect([at, contrast(t["sb-active-fg"], t["sb-active"]) >= 4.5]).toEqual([at, true]);
      expect([at, contrast(t["primary-foreground"], t.primary) >= 4.5]).toEqual([at, true]);
      expect([at, contrast(t.link, page) >= 4.5]).toEqual([at, true]);
      // The content wash keeps the page's text readable; selected controls and headings too.
      const [text, muted] = mode === "light" ? ["#222222", "#666666"] : ["#e8e8e8", "#9e9e9e"];
      expect([at, contrast(text, t.background) >= 12]).toEqual([at, true]);
      expect([at, contrast(muted, t.background) >= 4.5]).toEqual([at, true]);
      expect([at, contrast(t.heading, t.background) >= 7]).toEqual([at, true]);
      expect([at, contrast(t["selected-fg"], t.selected) >= 4.5]).toEqual([at, true]);
      expect([at, contrast(text, t.selected) >= 4.5]).toEqual([at, true]); // a selected row's own text
      // The wash is faint: the page is still near white / near black.
      expect([at, Math.abs(hexToOklch(t.background).l - hexToOklch(page).l) < 0.03]).toEqual([at, true]);
    }
    // Dark mode's sidebar is darker and less saturated than light mode's.
    const [light, dark] = [hexToOklch(themeTones(color, "light")["sb-bg"]), hexToOklch(themeTones(color, "dark")["sb-bg"])];
    expect(dark.l).toBeLessThan(light.l);
    expect(dark.c).toBeLessThanOrEqual(light.c + 1e-3);
  }
  // The hue is the server colour's: a green server gets a green sidebar.
  expect(Math.abs(hexToOklch(themeTones("#1f9d55", "light")["sb-bg"]).h - hexToOklch("#1f9d55").h)).toBeLessThan(6);
  const css = themeCss("#7c4ddb");
  expect(css).toMatch(/^:root:root\{--primary:#[0-9a-f]{6};.*\}:root:root\.dark\{--primary:#[0-9a-f]{6};.*\}$/);
  expect(css).toContain(`--sb-bg:${themeTones("#7c4ddb", "dark")["sb-bg"]};`);
});

test("ID7: the picker's grid — the 8 presets plus 2 hues as the base row, each with 3 tints and 2 shades", () => {
  const grid = colorGrid();
  expect(grid.map((col) => col[0]!.value)).toEqual(GRID_HUES.map((h) => h.value));
  expect(grid.slice(0, 8).map((col) => col[0]!.value)).toEqual(IDENTITY_COLORS.map((c) => c.value)); // the presets lead
  expect(IDENTITY_COLORS.length).toBe(8); // colorFromName indexes it: a new preset moves every Auto colour
  expect(grid.every((col) => col.length === 6)).toBe(true);
  expect(new Set(grid.flat().map((c) => c.value)).size).toBe(60);
  for (const col of grid) {
    const l = col.map((c) => hexToOklch(c.value).l);
    expect(l[1]! > l[2]! && l[2]! > l[3]! && l[3]! > l[0]! && l[0]! > l[4]! && l[4]! > l[5]!).toBe(true); // tints lighter, shades darker
    expect(col.every((c) => normalizeColor(c.value) === c.value)).toBe(true);
  }
  expect(grid[0]![1]!.label).toBe("Blue, lighter 3");
});
