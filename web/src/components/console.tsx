// Vercel's building blocks, in the Geist tokens (styles.css): a hairline card with a header row, a
// usage ring, a status dot, an environment-style pill, a details grid and a line chart. Every page
// of the console is assembled from these, so the look is decided in one place.
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { niceMax, sparklineSegments, timeTicks, usageZone } from "../workstream";

/** A card: hairline border, no shadow, a 48px header row with the title left and controls right. */
export function VCard({ title, aside, children, className, slot, bodyClass }: {
  title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; slot?: string; bodyClass?: string;
}) {
  return (
    <section data-slot={slot} className={cn("bg-card overflow-hidden rounded-xl border", className)}>
      {(title || aside) && (
        <header className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
          <h3 className="truncate text-sm font-medium">{title}</h3>
          {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

/** A section heading above a card, the way Vercel titles "Usage" / "Projects". */
export const SectionTitle = ({ children, aside }: { children: ReactNode; aside?: ReactNode }) => (
  <div className="mb-3 flex items-center justify-between gap-3">
    <h2 className="text-sm font-medium">{children}</h2>
    {aside}
  </div>
);

const ZONE_STROKE = { ok: "var(--geist-blue)", warn: "var(--geist-amber)", danger: "var(--geist-red)" } as const;

/** Vercel's usage ring: a thin circle filled to `pct`, blue until the caution zone. */
export function Ring({ pct, size = 16 }: { pct: number; size?: number }) {
  const r = 6.5, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct));
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className="shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="stroke-border" />
      {p > 0 && <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" stroke={ZONE_STROKE[usageZone(p)]} strokeDasharray={`${(p / 100) * c} ${c}`} strokeLinecap="round" />}
    </svg>
  );
}

export type DotTone = "ready" | "error" | "warning" | "building" | "queued" | "neutral";
const DOT_CLASS: Record<DotTone, string> = {
  ready: "bg-geist-teal",
  error: "bg-geist-red",
  warning: "bg-geist-amber",
  building: "bg-geist-amber animate-pulse",
  queued: "bg-geist-blue",
  neutral: "bg-geist-gray",
};
/** Vercel's status dot: Ready teal, Error red, Building amber (pulsing), Queued blue, idle gray. */
export const StatusDot = ({ tone, className, title }: { tone: DotTone; className?: string; title?: string }) => (
  <span data-slot="status-dot" data-tone={tone} title={title} className={cn("inline-block size-2.5 shrink-0 rounded-full", DOT_CLASS[tone], className)} />
);

/** An environment-style pill (Production / Preview): rounded, hairline, an optional leading icon. */
export function Pill({ children, tone = "default", slot, title }: { children: ReactNode; tone?: "default" | "blue" | "green" | "amber" | "red"; slot?: string; title?: string }) {
  const tones = {
    default: "text-foreground border",
    blue: "border-transparent bg-geist-blue/15 text-geist-blue",
    green: "border-transparent bg-geist-green/15 text-geist-green",
    amber: "border-transparent bg-geist-amber/15 text-geist-warning-fg",
    red: "border-transparent bg-geist-red/15 text-geist-red",
  };
  return (
    <span data-slot={slot ?? "pill"} title={title} className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium whitespace-nowrap [&>svg]:size-3", tones[tone])}>
      {children}
    </span>
  );
}

/** A label over a value — the cells of Vercel's details grids ("Created", "Status", …). */
export const Detail = ({ label, children, slot }: { label: string; children: ReactNode; slot?: string }) => (
  <div data-slot={slot} className="min-w-0">
    <div className="text-muted-foreground mb-1 text-xs">{label}</div>
    <div className="flex min-w-0 items-center gap-1.5 text-sm">{children}</div>
  </div>
);

/** A filter / segmented chip — the "6h | 24h | 7d" range picker and the like. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex h-7 items-center rounded-md border p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}
          className={cn("h-full rounded-[5px] px-2 text-xs font-medium transition-colors", value === o.value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A line chart with a y-axis (0 → a round max), time ticks under it and a hover readout — Vercel's
 *  Observability graphs. Gaps in the samples (a box that was down) break the line. */
export function LineChart({ points, from, to, max, fmt, axis = fmt, label, slot, color = "var(--geist-blue)", height = 120 }: {
  points: { at: number; v: number }[]; from: number; to: number; max?: number; fmt: (v: number) => string;
  /** The y-axis labels' format, when the readout's is too long for the gutter ("36G", not "36.0 GB"). */
  axis?: (v: number) => string;
  label: string; slot?: string; color?: string; height?: number;
}) {
  const W = 600, H = height;
  const top = max ?? niceMax(Math.max(0, ...points.map((p) => p.v)) * 1.1);
  const [hover, setHover] = useState<{ at: number; v: number } | null>(null);
  const last = points[points.length - 1];
  const shown = hover ?? last;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!points.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const at = from + ((e.clientX - r.left) / (r.width || W)) * (to - from);
    setHover(points.reduce((a, b) => (Math.abs(b.at - at) < Math.abs(a.at - at) ? b : a)));
  };
  const x = (at: number) => ((at - from) / Math.max(1, to - from)) * W;
  const segs = sparklineSegments(points, { from, to, max: top, w: W, h: H, gapMs: Math.max(5 * 60_000, (to - from) / 150) });
  return (
    <figure data-slot={slot} className="min-w-0">
      <figcaption className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-xs">{label}</span>
        <span data-slot="chart-value" className="text-sm font-medium tabular-nums">
          {shown ? fmt(shown.v) : "—"}
          {hover && <span className="text-muted-foreground ml-1 text-xs font-normal">at {new Date(hover.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>}
        </span>
      </figcaption>
      <div className="flex gap-2">
        <div className="text-muted-foreground flex w-8 shrink-0 flex-col justify-between text-right font-mono text-[10px] whitespace-nowrap tabular-nums" style={{ height: H }}>
          <span className="-translate-y-1/2">{axis(top)}</span><span>{axis(top / 2)}</span><span className="translate-y-1/2">{axis(0)}</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} className="w-full min-w-0 overflow-visible" role="img"
          aria-label={`${label}${last ? `, now ${fmt(last.v)}` : ", no samples"}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {[0, 0.5, 1].map((f) => <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} className="stroke-border" strokeWidth={1} strokeDasharray={f === 1 ? undefined : "3 3"} vectorEffect="non-scaling-stroke" />)}
          {segs.map((pts, i) => <polyline key={i} points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
          {hover && <line x1={x(hover.at)} x2={x(hover.at)} y1={0} y2={H} className="stroke-muted-foreground" strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      <div className="text-muted-foreground mt-1 flex justify-between pl-10 font-mono text-[10px]">
        {timeTicks(from, to, 4).map((t) => <span key={t.at}>{t.label}</span>)}
      </div>
    </figure>
  );
}

/** The empty state inside a card (Vercel's centred icon + sentence). */
export const Empty = ({ children, icon }: { children: ReactNode; icon?: ReactNode }) => (
  <div className="text-muted-foreground flex flex-col items-center gap-3 px-6 py-10 text-center text-sm">
    {icon && <span className="rounded-full border p-2.5 [&>svg]:size-4">{icon}</span>}
    {children}
  </div>
);
