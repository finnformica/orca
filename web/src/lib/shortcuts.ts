// The console's keyboard shortcuts: one table, one matcher (pure, so it's tested without a DOM),
// one listener (components/Shortcuts.tsx). The table also feeds the ? help sheet, the palette's
// hints and the tooltips, so a key can't be documented in one place and bound to another.
//
// Letters (C, F, O, ?) and ⌘B never fire while you type in a field or inside a modal dialog —
// they would eat a keystroke of the message. ⌘K and Esc work everywhere.
//
// Why O for the orchestrator, not ⌘J: ⌘J / Ctrl+J is the browser's Downloads in Chrome on Windows
// and Linux and in Firefox, and ⌘-chords are what a composer's text editing reaches for. A plain
// letter sits with C (new agent) and F (find), can't clash with any browser binding, and from inside
// a text field ⌘K → "Open orchestrator" is one more key.
export type ShortcutId = "palette" | "sidebar" | "new" | "orchestrator" | "find" | "help" | "escape";

export type KeyLike = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

export const SHORTCUTS: { id: ShortcutId; label: string; mod?: true; key: string }[] = [
  { id: "palette", label: "Command palette", mod: true, key: "K" },
  { id: "new", label: "New agent", key: "C" },
  { id: "orchestrator", label: "Ask the orchestrator", key: "O" },
  { id: "find", label: "Find agents", key: "F" },
  { id: "sidebar", label: "Collapse / expand the sidebar", mod: true, key: "B" },
  { id: "help", label: "Keyboard shortcuts", key: "?" },
  { id: "escape", label: "Close the open overlay", key: "Esc" },
];

export const isMacPlatform = (nav: { platform?: string; userAgent?: string } = typeof navigator === "undefined" ? {} : navigator): boolean =>
  /Mac|iPhone|iPad|iPod/.test(nav.platform || nav.userAgent || "");

/** How a shortcut is written for this platform: "⌘K" on a Mac, "Ctrl+K" elsewhere, "C" for a letter. */
export function shortcutLabel(id: ShortcutId, mac = isMacPlatform()): string {
  const s = SHORTCUTS.find((x) => x.id === id)!;
  return s.mod ? (mac ? `⌘${s.key}` : `Ctrl+${s.key}`) : s.key;
}

/** Is focus somewhere a keystroke is text: a field, an editable region, or a modal dialog's contents. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target && typeof (target as Element).closest === "function" ? (target as Element) : null;
  return !!el?.closest("input, textarea, select, [contenteditable=''], [contenteditable=true], dialog");
}

/** Which shortcut a keydown is, or null. `typing` = the target is a text field (isTypingTarget). */
export function matchShortcut(e: KeyLike, typing: boolean, mac = isMacPlatform()): ShortcutId | null {
  const mod = mac ? !!e.metaKey : !!e.ctrlKey;
  const otherMod = mac ? !!e.ctrlKey : !!e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === "Escape") return "escape";
  if (mod && !otherMod && !e.altKey && !e.shiftKey && key === "k") return "palette";
  if (typing) return null;
  if (mod && !otherMod && !e.altKey && !e.shiftKey && key === "b") return "sidebar";
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (key === "?") return "help";
  if (e.shiftKey) return null;
  return key === "c" ? "new" : key === "o" ? "orchestrator" : key === "f" ? "find" : null;
}
