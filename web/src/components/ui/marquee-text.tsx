// A truncated title that reveals its end on hover, then eases back on leave — shadcn-style: a thin
// component that measures and sets two CSS custom properties, plain CSS in styles.css does the rest
// (the same pattern as the notification toast stack's --y/--swipe-x). Only text that really overflows
// its box moves (lib/marquee.ts isTruncated, off the real scrollWidth/clientWidth); a short title just
// sits there, unchanged. The moving text is an inline-block (CSS transform needs one), so a real
// ellipsis can't land partway into it — a right-edge fade stands in for it instead.
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { isTruncated, marqueeDuration } from "@/lib/marquee";

export function MarqueeText({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflow(isTruncated(el.scrollWidth, el.clientWidth) ? el.scrollWidth - el.clientWidth : 0);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children]);

  const style = overflow > 0
    ? ({ "--marquee-distance": `-${overflow}px`, "--marquee-duration": `${marqueeDuration(overflow)}ms` } as CSSProperties)
    : undefined;
  return (
    <span ref={ref} data-slot="marquee-text" data-overflowing={overflow > 0 || undefined}
      className={cn("block min-w-0 overflow-hidden whitespace-nowrap", className)} style={style}>
      <span data-slot="marquee-text-inner" className="inline-block">{children}</span>
    </span>
  );
}
