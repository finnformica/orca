// A GitHub-style identicon for a named agent: a 5×5 grid, mirrored left to right, in one colour.
// Pure and dependency-free, so the web draws it (components/AgentAvatar) and a test pins it.
//
// The seed (the agent's name) is hashed with FNV-1a, 32 bits. Bits 0–14 are the 15 cells of the
// left three columns (column-major: bit c*5+r is column c, row r); columns 3 and 4 mirror 1 and 0.
// Bits 15–31 give the hue. Saturation and lightness are fixed, so every colour reads on the light
// and the dark theme alike. A hash whose 15 cell bits are all 0 lights the centre cell, so an icon
// is never empty.

export const IDENTICON_SIZE = 5;
/** Fixed saturation and lightness (%): mid enough to read on white and on near-black. */
export const IDENTICON_S = 60;
export const IDENTICON_L = 50;

/** FNV-1a, 32 bits, over the UTF-8 bytes of `s`. Unsigned. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export type Identicon = {
  /** 25 cells, row-major (index r*5+c); true = filled. Each row is a palindrome. */
  cells: boolean[];
  /** 0–359. */
  hue: number;
  /** The fill, `hsl(<hue> 60% 50%)`. */
  color: string;
};

export function identicon(seed: string): Identicon {
  const h = fnv1a(seed);
  let bits = h & 0x7fff;
  if (bits === 0) bits = 1 << (2 * IDENTICON_SIZE + 2); // column 2, row 2: the centre
  const cells: boolean[] = [];
  for (let r = 0; r < IDENTICON_SIZE; r++) {
    for (let c = 0; c < IDENTICON_SIZE; c++) {
      const col = c < 3 ? c : IDENTICON_SIZE - 1 - c;
      cells.push(((bits >>> (col * IDENTICON_SIZE + r)) & 1) === 1);
    }
  }
  const hue = Math.floor(((h >>> 15) / 0x20000) * 360);
  return { cells, hue, color: `hsl(${hue} ${IDENTICON_S}% ${IDENTICON_L}%)` };
}
