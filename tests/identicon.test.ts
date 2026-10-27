// The named agents' identicons (shared/identicon): FNV-1a, a mirrored 5×5 grid, a hue from the
// other bits, fixed saturation and lightness, never an empty grid.
import { describe, expect, test } from "bun:test";
import { IDENTICON_L, IDENTICON_S, fnv1a, identicon } from "../shared/identicon";

describe("fnv1a", () => {
  test("is FNV-1a 32-bit over UTF-8 (the published test vectors)", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });
  test("hashes UTF-8 bytes, not UTF-16 code units", () => {
    expect(fnv1a("é")).not.toBe(fnv1a("é".normalize("NFD")));
    expect(fnv1a("é")).toBe(fnv1a("é"));
  });
});

describe("identicon", () => {
  const names = ["chief", "assistant", "research", "reviewer", "ops", "a", "b", "Finn's helper", "研究"];

  test("is stable for one name and differs between names", () => {
    expect(identicon("research")).toEqual(identicon("research"));
    const keys = new Set(names.map((n) => JSON.stringify(identicon(n))));
    expect(keys.size).toBe(names.length);
  });

  test("25 cells, each row mirrored left to right", () => {
    for (const n of names) {
      const { cells } = identicon(n);
      expect(cells).toHaveLength(25);
      for (let r = 0; r < 5; r++) {
        const row = cells.slice(r * 5, r * 5 + 5);
        expect(row).toEqual([...row].reverse());
      }
    }
  });

  test("the cells are the low 15 bits of the hash, column by column", () => {
    const h = fnv1a("research");
    const { cells } = identicon("research");
    for (let c = 0; c < 3; c++) for (let r = 0; r < 5; r++) expect(cells[r * 5 + c]).toBe(((h >>> (c * 5 + r)) & 1) === 1);
  });

  test("the colour is the hue from the high bits at fixed saturation and lightness", () => {
    for (const n of names) {
      const { hue, color } = identicon(n);
      expect(hue).toBe(Math.floor(((fnv1a(n) >>> 15) / 0x20000) * 360));
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(color).toBe(`hsl(${hue} ${IDENTICON_S}% ${IDENTICON_L}%)`);
    }
  });

  test("never all cells off: a hash with no cell bits lights the centre", () => {
    // Find a seed whose low 15 bits are 0 (about 1 in 32768).
    let seed = "";
    for (let i = 0; i < 2_000_000 && !seed; i++) if ((fnv1a(`s${i}`) & 0x7fff) === 0) seed = `s${i}`;
    expect(seed).not.toBe("");
    const { cells } = identicon(seed);
    expect(cells.filter(Boolean)).toHaveLength(1);
    expect(cells[12]).toBe(true);
    for (const n of names) expect(identicon(n).cells.some(Boolean)).toBe(true);
  });
});
