// The server identity (shared/serverIdentity.ts): the display name and theme colour that tell two
// Orca servers apart. Pure rules, the identity on GET /api/servers' self row, and the config store:
// only Settings' setter writes it, and the other writers of the document keep it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as db from "../server/db";
import { configDocument, invalidateConfig, loadConfig, parseConfigDocument, saveConfigDocument, setInstanceTerminal, setServerIdentity } from "../server/config";
import { withIdentity, type ServersAnswer } from "../server/servers";
import {
  IDENTITY_COLORS, colorFromName, faviconSvg, identityUpdate, normalizeColor, pageTitle, resolveIdentity, serverIdentityProblems,
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

test("ID3: the title keeps Orca first; the favicon is favicon.svg's mark on the theme colour", () => {
  expect(pageTitle("Personal")).toBe("Orca | Personal");
  expect(pageTitle(undefined)).toBe("Orca");
  const svg = faviconSvg("#1f9d55");
  expect(svg).toContain('fill="#1f9d55"');
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
