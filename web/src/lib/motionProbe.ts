// A timing log for the dock's open / close slide, with no DevTools: load any page with
// `?probe=motion`, open or close a docked panel, and a small box at the top left reports each slide —
// its length, its frames, the longest frame, and how far the page frame and the quick-ask pill were
// from the card edge in the worst frame. The same numbers go to the console and to
// `performance.measure("dock-slide")`. Off without the query: nothing is installed.
type Sample = { t: number; dock: number; frameGap: number; pillGap: number };

const $ = (slot: string) => document.querySelector<HTMLElement>(`[data-slot="${slot}"]`);

/** One slide's summary, pure so a test can read it. `frameGap`: the page frame's width minus the
 *  column's (0 when the content follows the card; the held width while it is held). `pillGap`: the
 *  pill strip's right edge minus the page card's (0 when it moves with the card). */
export function summarizeSlide(samples: Sample[], ms: number): string {
  if (!samples.length) return `slide ${Math.round(ms)}ms, no frames`;
  const gaps = samples.slice(1).map((s, i) => s.t - samples[i]!.t);
  const max = (xs: number[]) => xs.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  const widths = new Set(samples.map((s) => Math.round(s.dock)));
  const first = Math.round(samples[0]!.dock), last = Math.round(samples[samples.length - 1]!.dock);
  return [
    `slide ${first}→${last} ${Math.round(ms)}ms`,
    `${samples.length} frames, ${widths.size} widths`,
    `frame max ${gaps.length ? Math.round(max(gaps)) : 0}ms mean ${gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0}ms`,
    `page≠col max ${Math.round(max(samples.map((s) => s.frameGap)))}px`,
    `pill≠card max ${Math.round(max(samples.map((s) => s.pillGap)))}px`,
  ].join(" · ");
}

function install() {
  const out = document.createElement("pre");
  out.dataset.slot = "motion-probe";
  out.style.cssText = "position:fixed;top:4px;left:4px;z-index:2147483647;margin:0;padding:4px 6px;font:11px/1.4 monospace;background:#000c;color:#fff;pointer-events:none;white-space:pre";
  out.textContent = "motion probe: waiting for a slide";
  document.body.appendChild(out);
  const lines: string[] = [];
  let run: Sample[] | null = null;
  let t0 = 0;
  const isDock = (e: Event) => (e as TransitionEvent).propertyName === "width" && (e.target as HTMLElement).dataset?.slot === "dock";
  const sample = (t: number) => {
    const dock = $("dock"), col = $("page-scroll"), frame = $("page-frame"), card = $("shell-card"), pill = $("quick-ask");
    if (!dock || !col || !frame || !card) return;
    const c = card.getBoundingClientRect();
    run!.push({ t, dock: dock.getBoundingClientRect().width, frameGap: frame.getBoundingClientRect().width - col.clientWidth,
      pillGap: pill ? pill.getBoundingClientRect().right - c.right : 0 });
  };
  const tick = (t: number) => { if (!run) return; sample(t); requestAnimationFrame(tick); };
  document.addEventListener("transitionrun", (e) => {
    if (!isDock(e) || run) return;
    run = []; t0 = performance.now();
    performance.mark("dock-slide-start");
    requestAnimationFrame(tick);
  }, true);
  const end = (e: Event) => {
    if (!isDock(e) || !run) return;
    sample(performance.now());
    performance.mark("dock-slide-end");
    performance.measure("dock-slide", "dock-slide-start", "dock-slide-end");
    const line = summarizeSlide(run, performance.now() - t0);
    run = null;
    console.log(`[motion] ${line}`);
    lines.push(line);
    out.textContent = lines.slice(-4).join("\n");
  };
  document.addEventListener("transitionend", end, true);
  document.addEventListener("transitioncancel", end, true);
}

if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("probe") === "motion") install();
