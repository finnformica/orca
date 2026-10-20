// The app-wide standard for truncated text, mounted ONCE at the root (App): a mouse hover over any
// `truncate` element that really overflows scrolls it from start to end and back (lib/marquee
// marqueeTruncatedOnHover), so the whole value can be read. Text that fits never moves. With
// prefers-reduced-motion nothing scrolls: the project's Tip opens over the element with its full
// text. A phone has no hover: a tap expands the text (lib/viewport expandTruncatedOnTap). No call
// site wraps its text — a new `truncate` gets the behaviour for free.
import { useEffect, useState } from "react";
import { Tip } from "@/components/ui/tip";
import { marqueeTruncatedOnHover, type OverflowTipState } from "@/lib/marquee";

export function OverflowText() {
  const [tip, setTip] = useState<OverflowTipState>(null);
  useEffect(() => marqueeTruncatedOnHover(window, setTip), []);
  if (!tip) return null;
  const r = tip.el.getBoundingClientRect();
  // An invisible anchor over the element's box: the Tip positions against it, and it takes no pointer.
  return (
    <Tip open wrap label={tip.text} side="top" className="pointer-events-none fixed"
      style={{ left: r.left, top: r.top, width: r.width, height: r.height }}>
      <span data-slot="overflow-tip-anchor" aria-hidden="true" />
    </Tip>
  );
}
