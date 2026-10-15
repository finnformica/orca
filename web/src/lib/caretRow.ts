// Where the caret sits within ONE logical line of a <textarea> once the box's own layout wraps that
// line onto several visual rows. A textarea has no per-row API, so this measures it the way every
// caret-position library does: a hidden clone holding just that line's text (the box's text-affecting
// CSS copied over, so it wraps identically), a marker span at the caret, and the marker's offsetTop
// divided by the line height. Used only by the composer's ↑/↓ history recall (workstream.ts
// `historyKey`'s `firstVisualRow`/`lastVisualRow`) — a logical line with no newline can still be
// several rows once it soft-wraps, which the "\n" check alone can't see.
const MIRROR_PROPS = [
  "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "tabSize",
] as const;

/** The visual row (0-based) the offset falls on within `lineText`, and how many rows it wraps to —
 *  or null when there's nothing to measure (no real layout, e.g. a test DOM with no font metrics),
 *  in which case the caller should treat the line as a single row. */
export function lineVisualRow(el: HTMLTextAreaElement, lineText: string, offset: number): { row: number; rowCount: number } | null {
  if (typeof document === "undefined") return null;
  const elStyle = getComputedStyle(el);
  const mirror = document.createElement("div");
  for (const prop of MIRROR_PROPS) mirror.style.setProperty(cssPropName(prop), elStyle.getPropertyValue(cssPropName(prop)));
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.height = "auto";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.append(
    document.createTextNode(lineText.slice(0, offset)),
    marker,
    document.createTextNode(lineText.slice(offset) || "​"),
  );
  document.body.appendChild(mirror);
  const lineHeight = parseFloat(getComputedStyle(mirror).lineHeight || "") || marker.offsetHeight;
  const result = lineHeight ? { row: Math.round(marker.offsetTop / lineHeight), rowCount: Math.max(1, Math.round(mirror.scrollHeight / lineHeight)) } : null;
  document.body.removeChild(mirror);
  return result;
}

function cssPropName(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
