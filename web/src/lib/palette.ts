// The command palette's pure half: fuzzy scoring, ranking (recent first), keyboard movement. The
// component (components/CommandPalette.tsx) only builds the items and runs the chosen one.
export type PaletteGroup = "Workstreams" | "Pull requests" | "Pages" | "Actions";
export type PaletteItem = {
  id: string; // stable across renders — what "recent" remembers
  group: PaletteGroup;
  label: string;
  hint?: string; // right-aligned meta: a repo, a branch, a shortcut
  keywords?: string; // searched as well as the label, never shown
};

/** How well `query` matches `text`, or null for no match. Every query character must appear in
 *  order (a subsequence); an exact match beats a prefix, a prefix beats a word start, contiguous
 *  runs beat scattered letters, and an earlier match beats a later one. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase(), t = text.toLowerCase();
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return (/[\s/#:._-]/.test(t[at - 1] ?? " ") ? 600 : 400) - at;
  let score = 0, ti = 0, prev = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    score += i === prev + 1 ? 10 : /[\s/#:._-]/.test(t[i - 1] ?? " ") ? 6 : 1;
    prev = i; ti = i + 1;
  }
  return score - prev / 100;
}

const itemScore = (q: string, item: PaletteItem): number | null => {
  const a = fuzzyScore(q, item.label), b = item.keywords ? fuzzyScore(q, item.keywords) : null;
  if (a === null) return b === null ? null : b - 1; // a keyword hit ranks just under the same label hit
  return b === null ? a : Math.max(a, b - 1);
};

/** The list the palette shows. No query: recently run items first (most recent first), then every
 *  other item in its given order. A query: matches only, best first; a recent item wins a tie. */
export function rankPalette(items: PaletteItem[], query: string, recent: string[] = []): PaletteItem[] {
  const rank = (id: string) => { const i = recent.indexOf(id); return i < 0 ? Infinity : i; };
  if (!query.trim()) {
    const recents = items.filter((i) => rank(i.id) !== Infinity).sort((a, b) => rank(a.id) - rank(b.id));
    return [...recents, ...items.filter((i) => rank(i.id) === Infinity)];
  }
  return items
    .map((item, order) => ({ item, order, s: itemScore(query, item) }))
    .filter((x): x is { item: PaletteItem; order: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || rank(a.item.id) - rank(b.item.id) || a.order - b.order)
    .map((x) => x.item);
}

/** Remember `id` as the most recent, deduplicated, at most `max` kept. */
export const pushRecent = (recent: string[], id: string, max = 8): string[] => [id, ...recent.filter((r) => r !== id)].slice(0, max);

/** ↑/↓ in the list: wraps at both ends; an empty list has no selection (0). */
export const moveSelection = (idx: number, delta: number, len: number): number => (len ? (((idx + delta) % len) + len) % len : 0);

/** The orchestrator composer's text after a prefill: what you typed in the entry, after whatever
 *  draft the box already held (on its own line), so opening it with text never loses a draft. */
export const joinPrefill = (base: string, text: string): string => (!text ? base : base.trim() ? `${base.replace(/\s+$/, "")}\n${text}` : text);
