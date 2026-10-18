// The conversation with a branch's agent — or the orchestrator's — as ONE chat: the durable turns
// from the bridge's store (GET /api/turns), your messages as bubbles on the right, the agent's
// replies under its name on the left, with the follow-up composer below. Every surface renders it:
// the Agent page's Chat tab, a card's terminal modal, and the orchestrator's panel and page — only
// their sizing and the composer's wiring differ (ChatPanel's props). It is NOT a live shell — it
// renders the turns Orca already records.
//
// Orca still hosts no chat *runtime* — the composer fires the same headless one-shot every board
// action uses.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Bot, Check, ChevronRight, Cog, Copy, Loader2, Paperclip, Quote as QuoteIcon, X } from "lucide-react";
import { cn, PipContext } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentStep, AgentTurn } from "../../../shared/agent";
import { api, type QueuedMessage } from "../api";
import { followUp, modelFor, refresh, setCardModel, type Row } from "../store";
import { RECENT_FULL, TAIL_WINDOW, reportShots, TURN_PAGE_SIZE, WORKER_EVENT_MARKER, agentsMarker, attachmentRefs, isImageName, quoteMarkdown, withoutAttachmentList, type AttachmentRef, anchoredScrollTop, capWindow, chatItems, chatPlaceholder, longMessage, newestMessages, splitMessages, longReply, revealAbove, revealBelow, windowRange, type TurnWindow, asTurnPage, atBottom, dayLabel, formatDuration, isWorkerEvent, mergeLatestPage, prependOlderPage, promptInstruction, sameDay, unlandedSends, undeliveredQueued, composerHistory } from "../workstream";
import { activityCounts, closeOpenMarkdown, createHold, runLabel, stepDuration, stepInFlight, stepKey, stepRow, stepRuns, toolDetail, toolLabel, workedLabel, workSteps, type StepStatus } from "../steps";
import { agentLabel, groupSteps, withoutFinalEcho } from "../../../shared/agent";
import { ChatComposer } from "@/components/ChatComposer";
import { ExpandableImage } from "@/components/ExpandableImage";
import { ShotThumbs } from "@/components/Screenshots";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import { subscribeTurns } from "@/lib/events";
import { onRefresh } from "@/lib/refresh";
import { onOrchestratorDelivered, useOrchestratorOutbox } from "@/lib/orchestratorOutbox";
import { ChatControls, type ChatControlsProps } from "@/components/ChatControls";
import type { OrchestratorPrefill } from "@/lib/atoms";
import { apiUrl } from "@/lib/server";

// How close to the bottom still counts as "following". A few pixels of slack absorbs sub-pixel
// rounding and the composer resizing, so following doesn't switch off on its own.
const FOLLOW_SLACK = 48;
// How close to the top (px) fetches the next older page.
const OLDER_THRESHOLD = 160;

/** Placeholder lines sized like a turn, while a page is in flight — nothing shifts when it lands. */
const ChatSkeleton = ({ rows }: { rows: number }) => (
  <div className="w-full animate-pulse space-y-3" data-slot="chat-skeleton" aria-hidden="true">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="space-y-1.5">
        <div className="h-3 w-2/5 rounded bg-neutral-800" />
        <div className="h-3 w-4/5 rounded bg-neutral-800/70" />
        <div className="h-3 w-3/5 rounded bg-neutral-800/50" />
      </div>
    ))}
  </div>
);

/** A markdown image (a worker's `![…](/api/screenshots/<id>)` link, or any other image URL a reply
 *  embeds) through the same lightbox + copy button as every other image, instead of react-markdown's
 *  bare `<img>` — capped to a readable size inline, full size on click. */
const markdownImg = ({ src, alt }: { src?: string; alt?: string }) =>
  src ? <ExpandableImage src={apiUrl(src)} alt={alt ?? ""} imgClassName="max-h-80 max-w-full rounded-md border object-contain" /> : null;

/** A markdown table wrapped so it scrolls sideways inside itself (overflow-x-auto, max-w-full)
 *  instead of squashing its columns or widening the page — a table of more than a couple of
 *  columns is wider than the chat panel, let alone a popped-out window or a phone. Each cell gets
 *  a minimum width so a column never gets squeezed unreadably thin; a short cell (a number, a
 *  single word) still renders at its own natural width — min-width is a floor, not a fixed size —
 *  while longer text wraps inside the column instead of stretching it further. */
const markdownTable = ({ children }: { children?: ReactNode }) => (
  <div className="max-w-full overflow-x-auto">
    <table>{children}</table>
  </div>
);
const markdownCell = (Tag: "th" | "td") => ({ children }: { children?: ReactNode }) =>
  <Tag className="min-w-32">{children}</Tag>;
const tableComponents = { table: markdownTable, th: markdownCell("th"), td: markdownCell("td") };

/** Markdown inside the terminal-styled log: prose spacing and readable lists, but sized and coloured
 *  to sit in the chat's window rather than looking like a pasted document. `tone` overrides the body
 *  text colour (a worker report's folded body reads dimmer than a turn's own reply) without forking
 *  the renderer, its table handling, or its prose setup. */
const ChatMarkdown = ({ children, tone = "text-neutral-300" }: { children: string; tone?: string }) => (
  // wrap-anywhere: the agent's prose is full of unbreakable tokens (`branch/names-with-hashes`,
  // paths, run ids) that are wider than a narrow window, and one of them made the whole log scroll
  // sideways. Code BLOCKS are exempt — they keep their lines and scroll inside themselves.
  // prose-strong: Tailwind typography's own --tw-prose-bold var resolves to --tw-prose-invert-bold,
  // which the .prose class sets to a literal white (baked in from its gray theme) directly on this
  // element — a declaration .log-themed's ancestor-level remap can never reach, since an element's
  // own matching rule always beats an inherited custom property. That made bold text render
  // white-on-white in light theme. Route it through Tailwind's own (correctly remapped) neutral-200
  // token instead, like prose-headings/prose-code/prose-a already do.
  <div className={cn("prose prose-invert prose-sm max-w-none wrap-anywhere prose-pre:wrap-normal",
    "prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 prose-headings:text-neutral-200",
    "prose-li:my-0.5 prose-ul:my-1 prose-ol:my-1",
    "prose-strong:text-neutral-200",
    "prose-code:text-sky-300 prose-code:before:content-none prose-code:after:content-none",
    "prose-pre:bg-neutral-900 prose-pre:text-[11px] prose-a:text-sky-400", tone)}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: markdownImg, ...tableComponents }}>{children}</ReactMarkdown>
  </div>
);

/** Markdown for a single Facet item (Remaining / Decisions / Verification / Commits): same renderer
 *  and prose palette as ChatMarkdown, but a paragraph renders inline rather than as its own <p> — the
 *  facet's <ul> already supplies the item's spacing, so a block margin on top would double it up. A
 *  nested sub-bullet or a stray `##` sub-heading the parser kept verbatim (see shared/agent.ts
 *  sectionValue) still renders as its own block — a real nested list, or a heading — beneath the
 *  item's text. */
const FacetMarkdown = ({ children }: { children: string }) => (
  <div className="prose prose-invert prose-sm max-w-none wrap-anywhere text-neutral-300
    prose-headings:mt-1 prose-headings:mb-0.5 prose-headings:text-xs prose-headings:text-neutral-200
    prose-li:my-0.5 prose-ul:my-1 prose-ol:my-1
    prose-strong:text-neutral-200
    prose-code:text-sky-300 prose-code:before:content-none prose-code:after:content-none
    prose-pre:bg-neutral-900 prose-pre:text-[11px] prose-a:text-sky-400">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ p: ({ children: c }) => <>{c}</>, img: markdownImg, ...tableComponents }}>{children}</ReactMarkdown>
  </div>
);

/** Open/closed with the height animated: a grid row going 1fr ↔ 0fr animates to the content's own
 *  height with nothing measured, and the opacity rides along (~200ms; none under reduced motion).
 *  Closed content stays mounted until the fold has played, then leaves the DOM. */
function Fold({ open, slot, children }: { open: boolean; slot?: string; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), FOLD_MS + 50);
    return () => clearTimeout(t);
  }, [open]);
  return (
    <div data-slot={slot} data-open={open || undefined} aria-hidden={!open || undefined}
      className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
      <div className="min-h-0 overflow-hidden">{(open || mounted) && children}</div>
    </div>
  );
}
const FOLD_MS = 200;

/** The current time, ticking each second while `on` — the live block's elapsed timer. */
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** What the live header shows, held for at least HOLD_MS before it switches (`createHold`), so a
 *  run of fast commands doesn't flick the label between a command and `Thinking`. */
function useHeld<T>(want: T): T {
  const [shown, setShown] = useState(want);
  const hold = useRef<ReturnType<typeof createHold<T>> | null>(null);
  hold.current ??= createHold(want, setShown);
  useEffect(() => { hold.current!.want(want); }, [want]);
  useEffect(() => () => hold.current?.stop(), []);
  return shown;
}

/** One line of text that cross-fades when it changes: the old text fades up and out over the new
 *  one, which fades up and in, in ONE grid cell — so the line never changes height. The `label-*`
 *  classes are in styles.css (none under reduced motion). */
function CrossFade({ text, slot }: { text: string; slot?: string }) {
  const [s, setS] = useState<{ text: string; n: number; gone: string | null }>({ text, n: 0, gone: null });
  if (s.text !== text) setS({ text, n: s.n + 1, gone: s.text });
  useEffect(() => {
    if (s.gone === null) return;
    const t = setTimeout(() => setS((v) => ({ ...v, gone: null })), LABEL_FADE_MS);
    return () => clearTimeout(t);
  }, [s.n, s.gone]);
  return (
    <span className="grid min-w-0 flex-1">
      {s.gone !== null && <span key={`out-${s.n}`} aria-hidden="true" className="label-out truncate [grid-area:1/1]">{s.gone}</span>}
      <span key={`in-${s.n}`} data-slot={slot} className={cn("truncate [grid-area:1/1]", s.n > 0 && "label-in")}>{text}</span>
    </span>
  );
}
const LABEL_FADE_MS = 200;

const STATUS_ICON: Record<StepStatus, ReactNode> = {
  running: <Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />,
  done: <Check className="size-3 shrink-0 opacity-60" />,
  failed: <X className="size-3 shrink-0 text-red-400" />,
};

/** One step in the full (expanded) list. A tool call is its REAL call on one line — the command
 *  itself in monospace, or a read / edit by its file name — with its status (running, done, failed)
 *  and how long it took; its input and output open on a click. Text reads as the agent talking
 *  (markdown, never code); thinking is dimmed and italic. Nothing opens by itself. */
function StepRow({ step, live }: { step: AgentStep; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (step.kind === "text") return <div data-slot="step-text"><ChatMarkdown>{step.text ?? ""}</ChatMarkdown></div>;
  if (step.kind === "thinking") return <div className="italic opacity-70"><ChatMarkdown>{step.text ?? ""}</ChatMarkdown></div>;
  const body = [toolDetail(step), step.output].filter(Boolean).join("\n\n");
  const row = stepRow(step, live);
  return (
    <div data-slot="step-tool" data-status={row.status}>
      <button type="button" onClick={() => setOpen((v) => !v)} disabled={!body}
        className={cn("flex w-full min-w-0 items-center gap-1.5 text-left", row.status === "failed" ? "text-red-400" : "text-muted-foreground", body ? "hover:text-foreground" : "cursor-default")}>
        <ChevronRight className={cn("size-3 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90", !body && "invisible")} />
        <span className="sr-only">{row.status}</span>
        {STATUS_ICON[row.status]}
        {row.verb && <span className="shrink-0">{row.verb}</span>}
        <span className={cn("min-w-0 flex-1 truncate", row.mono && "font-mono text-[11px]")} data-slot="step-call">{row.text}</span>
        {row.ms !== undefined && <span className="shrink-0 tabular-nums opacity-70" data-slot="step-duration">{stepDuration(row.ms)}</span>}
      </button>
      {open && body && (
        <pre className="text-muted-foreground mt-0.5 ml-4.5 max-h-64 overflow-auto rounded border-l pl-2 text-[11px] whitespace-pre-wrap break-words">{body}</pre>
      )}
    </div>
  );
}

/** How a turn shows its work — ONE block, modelled on Claude Code's. While the run is live: a header
 *  with the call in flight and an elapsed timer, a count line (`6 commands, 3 files read`) and the
 *  last few runs of steps, faded, one line each. When the answer lands the block is NOT removed: it
 *  folds (height + opacity) into a one-line `Worked for 1m 12s · 9 steps` chip in the same place, so
 *  the answer arrives below it with no jump. The chip stays on past turns; its chevron (or the live
 *  header) opens the full list. (It was a row per tool call, its input open while in flight — a wall
 *  of blue commands that then vanished at once.) */
function Activity({ steps: given, live, startedAt, finishedAt, load }: {
  steps: AgentStep[]; live: boolean; startedAt?: number; finishedAt?: number; load?: () => Promise<AgentStep[]>;
}) {
  const [open, setOpen] = useState(false);
  // An older turn arrives without its steps (the bridge sends them for the newest turns only);
  // they are fetched the first time it is unfolded.
  const [fetched, setFetched] = useState<AgentStep[] | null>(null);
  const steps = fetched ? groupSteps(fetched) : given;
  const now = useNow(live);
  // The header names the call in progress — held a moment before it switches (useHeld), so fast
  // commands don't flick it to `Thinking` and back. The trail leaves out what the header names.
  const inFlight = stepInFlight(steps);
  const heldKey = useHeld(inFlight ? stepKey(inFlight) : "");
  if (!steps.length && !(load && !live)) return null;

  const heldStep = heldKey ? steps.find((s) => s.kind === "tool" && stepKey(s) === heldKey) : undefined;
  const current = heldStep ? toolLabel(heldStep) : "Thinking";
  const header = new Set([heldKey, inFlight ? stepKey(inFlight) : ""]);
  const trail = stepRuns(steps.filter((s) => !(s.kind === "tool" && header.has(stepKey(s))) && s.kind !== "thinking")).slice(-3);
  const counts = activityCounts(steps);
  const toggle = () => {
    if (!steps.length && load && !fetched) void load().then((s) => { setFetched(s); setOpen(true); });
    else setOpen((v) => !v);
  };
  const chevron = <ChevronRight className={cn("size-3 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />;
  return (
    <div className="mb-1.5 text-[12px]" data-slot="turn-activity" data-live={live || undefined}>
      <Fold open={live} slot="activity-live">
        <div className="bg-accent/50 rounded-md px-2.5 py-1.5">
          <button type="button" onClick={toggle} className="flex w-full min-w-0 items-center gap-2 text-left" data-slot="activity-head">
            <Loader2 className="text-muted-foreground size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
            <span className="text-foreground flex min-w-0 flex-1"><CrossFade text={`${current}…`} slot="activity-current" /></span>
            {startedAt ? <span className="text-muted-foreground shrink-0 tabular-nums" data-slot="activity-elapsed">{formatDuration(now - startedAt)}</span> : null}
            <span className="text-muted-foreground">{chevron}</span>
          </button>
          {/* The count line and the trail open together on the first step, and the trail keeps room
              for its three rows, so a row that lands slides in without pushing the chat down. */}
          <Fold open={Boolean(counts || trail.length)}>
            <div className="text-muted-foreground mt-0.5 truncate pl-5.5 text-[11px] leading-4" data-slot="activity-counts">{counts || "\u00a0"}</div>
            {!open && (
              <ul className="mt-1 min-h-[52px] space-y-0.5 pl-5.5 text-[11px] leading-4 opacity-60" data-slot="activity-trail">
                {trail.map((run) => (
                  <li key={stepKey(run.steps[0]!)} className={cn("step-in truncate", run.kind === "text" ? "text-foreground" : "text-muted-foreground")}>{runLabel(run)}</li>
                ))}
              </ul>
            )}
          </Fold>
        </div>
      </Fold>
      <Fold open={!live} slot="activity-summary">
        <button type="button" onClick={toggle} className="text-muted-foreground hover:text-foreground inline-flex max-w-full items-center gap-1 text-[11px]" data-slot="activity-chip">
          {chevron}
          <span className="truncate">{workedLabel(startedAt && finishedAt ? finishedAt - startedAt : undefined, workSteps(steps))}</span>
        </button>
      </Fold>
      <Fold open={open} slot="activity-steps">
        {/* Every step on its own row — the real calls, not the trail's `Ran 3 commands` again. */}
        <div className="mt-1 space-y-0.5 border-l pl-2" data-slot="activity-list">
          {steps.map((s, i) => <div key={`${stepKey(s)}-${i}`} className={cn(live && "step-in")}><StepRow step={s} live={live} /></div>)}
        </div>
      </Fold>
    </div>
  );
}

/** A completed turn's agent output. Structured outcomes render as labelled sections; anything else is
 *  the raw final message as monospace text. Terminal palette, so it reads on the dark window. */
function Output({ turn }: { turn: AgentTurn }) {
  if (turn.failed) return <pre className="whitespace-pre-wrap break-words text-red-400">{turn.response || "exited without output"}</pre>;
  // Stopped is amber, not red: you interrupted it, the work so far stands, and the session is still
  // resumable — replying in the composer redirects it rather than starting over.
  if (turn.stopped) return <pre className="whitespace-pre-wrap break-words text-amber-400">{turn.response || "Stopped."}</pre>;
  const s = turn.structured;
  if (!s) return <ChatMarkdown>{turn.response || "_(no output)_"}</ChatMarkdown>;
  return (
    <div className="space-y-1.5 text-neutral-300">
      {s.outcome && <ChatMarkdown>{s.outcome}</ChatMarkdown>}
      {s.remaining.length > 0 && <Facet title="Remaining" items={s.remaining} tone="text-amber-400" />}
      {s.decisions.length > 0 && <Facet title="Decisions" items={s.decisions} tone="text-neutral-400" />}
      {s.verification.length > 0 && <Facet title="Verification" items={s.verification} tone="text-neutral-400" />}
      {s.commits.length > 0 && <Facet title="Commits" items={s.commits} tone="text-sky-400" />}
    </div>
  );
}

const Facet = ({ title, items, tone }: { title: string; items: string[]; tone: string }) => (
  <div>
    <div className={`text-[10px] tracking-widest uppercase ${tone}`}>{title}</div>
    <ul className="list-disc space-y-0.5 pl-4 marker:text-neutral-600">
      {items.map((v, i) => <li key={i} className="break-words pl-0.5"><FacetMarkdown>{v}</FacetMarkdown></li>)}
    </ul>
  </div>
);

/** The files a message carried: a thumbnail for an image, a named chip for anything else. Each opens
 *  the stored file from the bridge (`/api/attachments/<id>`, read from Postgres), so it works from
 *  any instance, whichever one took the upload. */
export function Attachments({ files, className = "" }: { files: AttachmentRef[]; className?: string }) {
  if (!files.length) return null;
  // Just the images, in order: the other images this message carried are this one's lightbox gallery.
  const images = files.filter((f) => isImageName(f.name)).map((f) => ({ src: apiUrl(`/api/attachments/${f.id}`), alt: f.name }));
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`} data-slot="message-attachments">
      {files.map((f) => {
        const href = apiUrl(`/api/attachments/${f.id}`);
        const imgIndex = images.findIndex((im) => im.src === href);
        return isImageName(f.name) ? (
          <ExpandableImage key={f.id} src={href} alt={f.name} downloadName={f.name}
            gallery={images.length > 1 ? { images, index: imgIndex } : undefined}
            imgClassName="max-h-32 max-w-48 rounded-md border object-cover" />
        ) : (
          <a key={f.id} href={href} target="_blank" rel="noreferrer" data-slot="attachment-file"
            className="bg-muted text-foreground hover:bg-accent inline-flex max-w-56 items-center gap-1 rounded-md border px-2 py-1 text-[11px]">
            <Paperclip className="size-3 shrink-0" /><span className="truncate">{f.name}</span>
          </a>
        );
      })}
    </div>
  );
}

/** Copy (the message's raw markdown, with a brief "Copied" confirmation) and Quote (insert it into
 *  the composer as a blockquote) for one message. Hidden until the message is hovered, but stays
 *  reachable: visible while a button inside has focus (keyboard), and always on a touch screen,
 *  which has no hover to reveal it. */
function MessageActions({ text, onQuote, className }: { text: string; onQuote: () => void; className?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard unavailable */ }
  };
  const btn = "text-muted-foreground hover:text-foreground";
  return (
    <div
      data-slot="message-actions"
      className={cn("flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100", className)}
    >
      <Tip label={copied ? "Copied" : "Copy"}>
        <Button type="button" size="icon" variant="ghost" className={cn("size-6", btn)} aria-label="Copy message" onClick={() => void onCopy()}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </Tip>
      <Tip label="Quote">
        <Button type="button" size="icon" variant="ghost" className={cn("size-6", btn)} aria-label="Quote message" onClick={onQuote}>
          <QuoteIcon className="size-3.5" />
        </Button>
      </Tip>
    </div>
  );
}

/** An instruction typed while the agent was working. It hasn't been sent yet — shown so it's visibly
 *  waiting rather than silently in limbo, and cancellable while it still is. */
function Queued({ message, onCancel }: { message: QueuedMessage; onCancel: () => void }) {
  // A worker report waiting for the batch (or your next message) is a system line, like a delivered one.
  if (isWorkerEvent(message.instruction)) {
    return (
      <div className="mb-1 text-neutral-500" data-slot="worker-report-held">
        ⚙ {message.instruction.split("\n")[0]!.slice(WORKER_EVENT_MARKER.length).trim()}
        <span className="ml-2 text-[10px] tracking-widest uppercase">held for the batch</span>
      </div>
    );
  }
  return (
    <div className="mb-4 flex justify-end opacity-60" data-slot="chat-queued">
      <div className="max-w-[85%]">
        <div className="bg-accent text-foreground rounded-lg px-3 py-2 whitespace-pre-wrap break-words">{withoutAttachmentList(message.instruction)}</div>
        <Attachments files={attachmentRefs((message.attachments ?? []).join("\n"))} className="mt-1 justify-end" />
        <div className="text-muted-foreground mt-1 flex items-center justify-end gap-2 text-[10px] tracking-widest uppercase">
          <span>queued — sends when the current run finishes</span>
          <button type="button" onClick={onCancel} className="tracking-normal normal-case hover:text-red-400">cancel</button>
        </div>
      </div>
    </div>
  );
}

/** The orchestrator's wake messages that were worker reports, not something you typed: each shown
 *  as one muted system line (what finished, how), with the full report behind a toggle. Only when
 *  EVERY part of the instruction is a report — a wake that also carried your message stays a prompt. */
function WorkerReports({ parts }: { parts: string[] }) {
  return (
    <div data-slot="worker-reports" className="space-y-0.5 text-neutral-500">
      {parts.map((part, i) => (
        <details key={i}>
          <summary className="cursor-pointer select-none">⚙ {part.split("\n")[0]!.slice(WORKER_EVENT_MARKER.length).trim()}</summary>
          <ReportBody body={part.split("\n").slice(1).join("\n")} />
        </details>
      ))}
    </div>
  );
}

/** A report's text, its `Screenshots (Read to view):` paths drawn as thumbnails instead. Rendered as
 *  markdown, not raw text — a worker's report is model output in the same prose/table/list markdown
 *  as its own reply, and a raw `<pre>` once showed a report's table as unrendered `| a | b |` text. */
function ReportBody({ body }: { body: string }) {
  const { text, shots } = reportShots(body);
  return (
    <>
      <div className="mt-1 ml-4"><ChatMarkdown tone="text-neutral-600">{text}</ChatMarkdown></div>
      <ShotThumbs shots={shots} className="mt-2 ml-4" />
    </>
  );
}

/** Orca's verification of the commit — deterministic evidence, shown apart from the agent's own
 *  Verification section. Output folds like a tool result. */
const CheckVerdict = ({ check }: { check: NonNullable<AgentTurn["check"]> }) => (
  <details className={`mt-1 ${check.ok ? "text-emerald-400" : "text-red-400"}`} data-slot="turn-check">
    <summary className="cursor-pointer select-none">
      {check.ok ? "✓" : "✗"} {check.command} {check.ok ? "passed" : `failed (exit ${check.exitCode})`}
    </summary>
    <pre className="mt-1 whitespace-pre-wrap break-words text-neutral-400">{check.output || "(no output)"}</pre>
  </details>
);

/** Each running turn's streamed reply text, by run id (ChatPanel's `drafts`) — a context, so it reaches
 *  the reply under either styling without threading through every turn component. */
const DraftContext = createContext<Record<string, string>>({});
const omit = (d: Record<string, string>, ...ids: string[]) => {
  const next = { ...d };
  for (const id of ids) delete next[id];
  return next;
};

/** The agent's side of a turn — the activity block, then the text: while it runs, the message being
 *  written; once it has answered, the output and Orca's check. The block sits at ONE place in both
 *  states, so it stays mounted and folds when the turn finishes. Shared by both stylings. */
function Reply({ turn, loadSteps, compact }: { turn: AgentTurn; loadSteps?: () => Promise<AgentStep[]>; compact?: boolean }) {
  const draft = useContext(DraftContext)[turn.id];
  // A turn is written at launch, so an interrupted run (bridge restart, kill) stays visible as an
  // unfinished exchange rather than vanishing.
  const live = !turn.finishedAt;
  const all = groupSteps(live ? turn.steps ?? [] : withoutFinalEcho(turn.steps ?? [], turn.response));
  // Live, a message after the last call is the text being written — maybe the answer — so it reads
  // below the block, where the answer lands, not inside it.
  const tail = live && all.at(-1)?.kind === "text" ? all.at(-1) : undefined;
  const work = tail ? all.slice(0, -1) : all;
  return (
    <>
      <Activity steps={work} live={live} startedAt={turn.startedAt} finishedAt={turn.finishedAt} load={turn.steps ? undefined : loadSteps} />
      {live ? (
        <div className="space-y-1 text-neutral-500">
          {tail && <ChatMarkdown>{tail.text ?? ""}</ChatMarkdown>}
          {/* The message being written, as it streams — replaced by its step once it is whole. */}
          {/* Rendered as markdown like the finished answer, closed first so a half-sent `**` or fence
              renders as it will once whole, not as glyphs that flip on the next delta. */}
          {draft && <div data-slot="turn-draft"><ChatMarkdown>{closeOpenMarkdown(draft)}</ChatMarkdown></div>}
          {(!work.length || draft) && <span>▋ {draft || tail ? "" : "working…"}</span>}
        </div>
      ) : (
        <>
          {/* An old turn (compact) shows its answer's first lines; the activity chip above stays outside. */}
          <Clamp on={Boolean(compact && longReply(turn))}><Output turn={turn} /></Clamp>
          {turn.check && <CheckVerdict check={turn.check} />}
        </>
      )}
    </>
  );
}

const clockOf = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "");

/** One exchange, as a modern assistant chat rather than a terminal log. What you said is a tinted
 *  bubble on the right; the agent (`author`: the orchestrator, else the turn's provider) answers on
 *  the left under its name, in readable prose; its tool steps and worker reports stay folded; the time shows on hover
 *  (and days are grouped by the divider ChatPanel draws). Colours are the theme's tokens, so it
 *  follows light and dark like the rest of the console. */
function ChatTurn({ turn, loadSteps, compact, newestSaid, onQuote, author }: { turn: AgentTurn; loadSteps?: () => Promise<AgentStep[]>; compact?: boolean; newestSaid?: boolean; onQuote: (text: string) => void; author?: string }) {
  const parts = splitMessages(turn.instruction ?? promptInstruction(turn.prompt));
  // A wake that carried your messages AND worker reports: your words in bubbles — one per message you
  // sent, however many one wake drained — and the reports folded.
  const reports = parts.filter(isWorkerEvent), said = parts.filter((p) => !isWorkerEvent(p));
  // Each message's files: an orchestrator wake carries their references in the instruction (one set
  // per message); an agent chat's instruction is the typed text alone, its files read off the prompt.
  const inline = attachmentRefs(turn.instruction ?? "").length > 0;
  const filesOf = (text: string, i: number) => inline ? attachmentRefs(text) : i === said.length - 1 ? turn.attachments ?? [] : [];
  const time = clockOf(turn.startedAt);
  return (
    <div className="mb-4" data-slot="chat-turn" data-failed={turn.failed || undefined}>
      {/* Worker reports that woke it, split out of what you said: a collapsed block of their own. */}
      {reports.length > 0 && (
        <WorkerBlock slot="turn-reports" className="mb-2"
          label={reports.length === 1 ? `Worker report · ${reportTitle(reports[0]!)}` : `${reports.length} worker reports`}>
          <WorkerReports parts={reports} />
        </WorkerBlock>
      )}
      {said.map((text, i) => {
        const clean = withoutAttachmentList(text);
        return (
          <div key={i} className="group mb-2 flex justify-end" data-slot="chat-user">
            <div className="max-w-[85%]">
              {clean && <div data-slot="chat-user-text" className="bg-accent text-foreground rounded-lg px-3 py-2 whitespace-pre-wrap break-words">
                {/* A long message is cut to its first lines, like an old reply. */}
                {/* …except your newest message, which is always in full. */}
                <Clamp on={!(newestSaid && i === said.length - 1) && longMessage(clean)} cut="max-h-[9rem]">{clean}</Clamp>
              </div>}
              <Attachments files={filesOf(text, i)} className="mt-1 justify-end" />
              <div className="mt-0.5 flex items-center justify-end gap-1.5">
                {clean && <MessageActions text={clean} onQuote={() => onQuote(clean)} />}
                {i === said.length - 1 && <div className="text-muted-foreground text-[10px] opacity-0 transition-opacity group-hover:opacity-100" data-slot="turn-time">{time}</div>}
              </div>
            </div>
          </div>
        );
      })}
      <div className="group flex gap-2" data-slot="chat-reply">
        <span className="bg-accent text-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-full" aria-hidden="true"><Bot className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          {/* One line the avatar's height: the name, then Copy / Quote right beside it (not after the
              hover-only time, whose reserved width left them floating off on their own), then the time. */}
          <div data-slot="chat-reply-head" className="text-muted-foreground mb-0.5 flex h-6 items-center gap-2 text-[11px]">
            <span className="text-foreground font-medium">{author ?? agentLabel(turn.provider)}</span>
            {turn.failed ? <span className="text-red-400">failed</span> : turn.stopped ? <span className="text-amber-400">stopped by you</span> : null}
            {turn.finishedAt && turn.response && <MessageActions text={turn.response} onQuote={() => onQuote(turn.response)} className="-mx-1" />}
            <span className="opacity-0 transition-opacity group-hover:opacity-100" data-slot="turn-time">{clockOf(turn.finishedAt) || time}</span>
          </div>
          <Reply turn={turn} loadSteps={loadSteps} compact={compact} />
        </div>
      </div>
    </div>
  );
}

/** An old turn's reply, cut to its first lines with a Show more — the history reads as a list of
 *  exchanges, not a wall of past answers. The newest RECENT_FULL turns always render in full. */
function Clamp({ on, children, cut = "max-h-[4.5rem]" }: { on: boolean; children: React.ReactNode; cut?: string }) {
  const [open, setOpen] = useState(false);
  // Once shown in full (it was the newest), it stays in full while mounted: when a newer message
  // arrives it must not shrink under the reader. It clamps the next time it mounts.
  const [held, setHeld] = useState(!on);
  useEffect(() => { if (!on) setHeld(true); }, [on]);
  if (!on || held) return <>{children}</>;
  return (
    <div data-slot="turn-clamp" data-open={open || undefined}>
      <div className={open ? "" : cn(cut, "overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]")}>{children}</div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-muted-foreground hover:text-foreground mt-0.5 text-[11px]">
        {open ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

const reportTitle = (report: string) => report.split("\n")[0]!.slice(WORKER_EVENT_MARKER.length).trim();

/** Worker traffic in the orchestrator's chat, split out of your conversation: its own tinted card,
 *  collapsed to one ⚙ line by default, opening in place. */
function WorkerBlock({ label, slot, className, children }: { label: string; slot: string; className?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-slot={slot} data-open={open || undefined} className={cn("border-geist-blue/20 bg-geist-blue/5 rounded-md border text-[12px]", className)}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left">
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <Cog className="text-geist-blue size-3.5 shrink-0" />
        <span className="min-w-0 truncate" data-slot="worker-block-label">{label}</span>
      </button>
      {open && <div className="border-geist-blue/20 border-t px-2.5 pt-2">{children}</div>}
    </div>
  );
}

/** A run of worker-driven turns (reports in, its replies out, nothing you said) as ONE collapsed
 *  block — "3 worker reports · 2 replies" — that opens to the turns, so you know they happened
 *  without the bulk. */
function AgentsMarker({ turns, render }: { turns: AgentTurn[]; render: (t: AgentTurn) => React.ReactNode }) {
  const span = [clockOf(turns[0]!.startedAt), clockOf(turns[turns.length - 1]!.finishedAt)].filter(Boolean).join("–");
  return (
    <WorkerBlock slot="agents-marker" className="mb-4" label={`${agentsMarker(turns)}${span ? ` · ${span}` : ""}`}>
      {turns.map(render)}
    </WorkerBlock>
  );
}

/** `send` replaces the follow-up launch for a conversation that isn't a branch's agent — the
 *  orchestrator's, which goes to its own route. The composer's toolbar always carries the model
 *  picker and the context ring (ChatControls); `controls` supplies their values when they don't come
 *  from the row's card. Everything else — the turns, steps, attachments, worker reports, queued and
 *  sending messages, scrolling, the composer — is the same on every surface. */
export function ChatPanel({ row, send, controls, prefill, outbox, author, size = "panel", autoFocus }: {
  row: Row; send?: (text: string, images: File[]) => Promise<void>; controls?: ChatControlsProps;
  /** The orchestrator's chat: its "sending…" messages are the shared outbox (lib/orchestratorOutbox) —
   *  every entry point's, not only this composer's — and `send` is expected to go through it. */
  outbox?: boolean;
  /** Text for the composer from outside it (the orchestrator's entry) — see ChatComposer. */
  prefill?: OrchestratorPrefill | null;
  /** The name replies are shown under; by default each turn's provider ("Claude"). */
  author?: string;
  /** "page": the Agent page's Chat tab, a wide column — roomier padding. "panel": everything else
   *  (the modal, the orchestrator's panel and page), where width is scarce. */
  size?: "panel" | "page";
  /** Focus the composer on mount (the Agent page's Chat tab — see below). */
  autoFocus?: boolean;
}) {
  // See ChatComposer's own note: inside the orchestrator's PiP window, `max-md:` reads that window's
  // own (often narrow) width, not the main one.
  const pip = useContext(PipContext);
  const deliver = send ?? ((text: string, images: File[]) => followUp(row, text, images));
  // Messages on their way to the bridge. Sending one launches an agent — an upload, a worktree
  // lookup, the board snapshot the orchestrator is handed — which takes seconds, and a log that
  // shows nothing until then reads as "it didn't go". So the message is drawn at once and replaced
  // by the real turn (or queued entry) when the bridge answers; on failure it is withdrawn and the
  // composer puts the text back.
  const [sending, setSending] = useState<{ id: number; text: string; attachments?: AttachmentRef[] }[]>([]);
  const sendSeq = useRef(0);
  const outgoing = useOrchestratorOutbox(Boolean(outbox));
  // A message's Quote button: append it to the composer as a blockquote, without losing whatever
  // draft is already there. `insertSeq` makes every click its own event even quoting the same text
  // twice in a row.
  const [insert, setInsert] = useState<{ text: string; seq: number } | null>(null);
  const insertSeq = useRef(0);
  const onQuote = (text: string) => setInsert({ text: quoteMarkdown(text), seq: ++insertSeq.current });
  const submit = async (text: string, images: File[]) => {
    const id = ++sendSeq.current;
    follow.current = true; // you just spoke: jump to it, wherever you had scrolled
    if (!outbox) setSending((s) => [...s, { id, text }]); // the outbox draws it otherwise
    try {
      await deliver(text, images);
      if (!outbox) { // the outbox's delivered hook (below) has already re-read both
        await loadLatest();
        await loadQueued(); // it may have been held rather than launched
      }
    } finally {
      setSending((s) => s.filter((m) => m.id !== id));
    }
  };
  // The conversation is PAGED: the newest TURN_PAGE_SIZE turns on open, and one more page each time
  // you reach the top (`older` is the cursor for it, null once the first turn is loaded). The
  // orchestrator's conversation is hundreds of turns and used to load whole — megabytes over the
  // tailnet and a long first render — to show the last few.
  const [turns, setTurns] = useState<AgentTurn[] | null>(null);
  const [older, setOlder] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [dbDown, setDbDown] = useState(false); // answered from the bridge's local journal, not the database
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true); // at the bottom → keep following; scrolled up → leave the reader be
  const [atTail, setAtTail] = useState(true); // `follow`, as state, for the jump-to-latest button
  const [unseen, setUnseen] = useState(false); // something arrived below while you were scrolled up
  const turnsRef = useRef<AgentTurn[] | null>(null); // read by the tail without re-arming it
  const olderRef = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);
  const anchor = useRef<{ top: number; height: number } | null>(null); // scroll position to restore after a prepend
  // The MOUNTED window over the loaded turns (workstream.ts: CHAT_WINDOW, capWindow). Paging bounds
  // what is fetched; this bounds the DOM, so a conversation scrolled far back stays light.
  const [win, setWin] = useState<TurnWindow>(TAIL_WINDOW);
  const winRef = useRef(win);
  winRef.current = win;
  const toTail = useRef(false); // jump-to-latest: scroll down once the window is back at the tail
  const cursors = useRef(new Map<string, number>()); // per-run high-water mark, for reconnect catch-up
  const latestAsked = useRef(0), latestApplied = useRef(0); // loadLatest's request order (see there)
  // Reply text streaming in for a running turn (claude's partial messages), by run id — shown under
  // its steps until the whole message lands as a step, or the turn finishes.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const running = row.agentStatus === "running";
  /** (Re)fetch the newest page. What was already loaded above it stays; a turn the page re-delivers
   *  (now finished) takes its fresh form. The first fetch also sets where the older pages start. */
  const loadLatest = async () => {
    // The newest REQUEST wins, not the last answer: a page fetched while a run was still running can
    // answer after the one its finish triggered, and applying it put the turn back to `working…` with
    // nothing left to fetch again — the reply "only appeared once I sent another message".
    const ticket = ++latestAsked.current;
    // asTurnPage again at the render boundary: whatever answered (an older bridge sends an array),
    // nothing undefined reaches `turns`, which must be null (loading) or a list.
    const raw = await api.turnPage(row.repo, row.branch, { limit: TURN_PAGE_SIZE }).catch(() => null);
    if (!raw || ticket < latestApplied.current) return;
    latestApplied.current = ticket;
    setDbDown(Boolean((raw as { dbUnavailable?: boolean }).dbUnavailable));
    const page = asTurnPage<AgentTurn>(raw);
    const had = turnsRef.current;
    if (!had || !had.length) { olderRef.current = page.older; setOlder(page.older); }
    // A page turn without steps (past the newest few the bridge ships them for) keeps the ones
    // already pushed or caught up, rather than folding them away.
    setTurns((prev) => {
      if (!prev) return page.turns;
      const had = new Map(prev.map((t) => [t.id, t.steps]));
      return mergeLatestPage(prev, page.turns.map((t) => (t.steps || !had.get(t.id) ? t : { ...t, steps: had.get(t.id) })));
    });
  };
  /** The page before the oldest loaded turn, put in front of it with the scroll position anchored on
   *  what you were reading (useLayoutEffect below). */
  const loadOlder = async () => {
    const before = olderRef.current;
    if (!before || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const page = asTurnPage<AgentTurn>(await api.turnPage(row.repo, row.branch, { limit: TURN_PAGE_SIZE, before }));
      const el = scroller.current;
      if (el) anchor.current = { top: el.scrollTop, height: el.scrollHeight };
      olderRef.current = page.older;
      setOlder(page.older);
      setTurns((prev) => prependOlderPage(page.turns, prev ?? []));
      setWin((w) => ({ ...w, first: null, dir: "up" })); // mount the page that arrived; the cap trims below
    } catch { /* the affordance stays; a scroll or click tries again */ } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };
  // Content was added ABOVE the viewport: move the scroller by the same amount, so the turn you were
  // reading doesn't jump. Layout effect: before the browser paints the shifted content.
  // The same for content REMOVED above (the window trimming its top), which moves it the other way.
  useLayoutEffect(() => {
    const a = anchor.current, el = scroller.current;
    if (a && el) {
      anchor.current = null;
      el.scrollTop = anchoredScrollTop(a.top, a.height, el.scrollHeight);
    }
    // Then hold the window to its cap — trimming one side per commit, so the anchor above stays exact:
    // the far side below needs no anchor; the top does, and is restored on the commit this causes.
    const capped = turns ? capWindow(turns, win) : null;
    if (capped) {
      if (capped.first !== win.first && el) anchor.current = { top: el.scrollTop, height: el.scrollHeight };
      setWin(capped);
    } else if (toTail.current && win.last === null && el) {
      toTail.current = false;
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [turns, win]);

  // The conversation loads once, then steps are PUSHED as the agent records them — that's the
  // terminal-like feel. They arrive on the tab's one shared stream (lib/events.ts), which carries
  // every instance's events, so there is one delivery path whether the agent runs on this machine or
  // in the cloud. An interrupted feed resumes from the cursor rather than refetching the whole
  // conversation.
  useEffect(() => {
    let live = true;
    const load = async () => { if (live) await loadLatest(); };
    void load();
    void loadQueued();

    const unsubscribe = subscribeTurns(row.repo, row.branch, {
      // A `turn` event means a run started or finished — either way the queue may have moved.
      turn: () => { void load(); void loadQueued(); },
      step: (runId, steps) => {
        // A whole message supersedes the text that streamed ahead of it.
        if (steps.some((st) => st.kind === "text")) setDrafts((d) => (runId in d ? omit(d, runId) : d));
        setTurns((prev) => prev?.map((t) => (t.id === runId ? { ...t, steps: [...(t.steps ?? []), ...steps] } : t)) ?? prev);
      },
      delta: (runId, text) => setDrafts((d) => ({ ...d, [runId]: (d[runId] ?? "") + text })),
      // We were disconnected (or the tab was hidden), so catch up from the cursor — anything
      // recorded while we were away would otherwise be silently missing.
      // The newest page is ALWAYS re-read: a turn that started or finished while we were away (or an
      // older interrupted turn sitting unfinished above it) is only visible that way.
      resync: () => void (async () => {
        const pending = turnsRef.current?.findLast((t) => !t.finishedAt);
        if (pending) {
          try {
            const cursor = cursors.current.get(pending.id) ?? pending.stepSeq ?? 0;
            const { steps, seq } = await api.turnSteps(row.repo, row.branch, pending.id, cursor);
            if (!live) return;
            if (steps.length) {
              cursors.current.set(pending.id, seq);
              setTurns((prev) => prev?.map((t) => (t.id === pending.id ? { ...t, steps: [...(t.steps ?? []), ...steps] } : t)) ?? prev);
            }
          } catch { /* the page below carries the turn's steps anyway */ }
        }
        await Promise.all([load(), loadQueued()]); // a message sent while we were away left the queue
      })(),
    });
    // "Refresh everything" re-reads the newest page and the queue, like a `turn` event.
    const offRefresh = onRefresh(() => Promise.all([load(), loadQueued()]));
    return () => { live = false; unsubscribe(); offRefresh(); };
  }, [row.repo, row.branch]);

  useEffect(() => {
    turnsRef.current = turns;
    setDrafts((d) => {
      const done = Object.keys(d).filter((id) => turns?.find((t) => t.id === id)?.finishedAt);
      return done.length ? omit(d, ...done) : d;
    });
  }, [turns]);

  // Follow the tail as output arrives, the way a terminal does — but only while the reader is AT the
  // bottom. Scrolling up to read something is an intent to stay there (a stream of steps yanking you
  // back down mid-read is the worst version of this), and returning to the bottom resumes following.
  // Keyed on `turns` itself, not its length, so appended steps scroll too.
  // Not following (you scrolled up to read): nothing moves, and a jump-to-latest button appears once
  // something new has arrived below. An older page landing above is not "new".
  useEffect(() => {
    if (follow.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    else if (!anchor.current && !loadingOlderRef.current) setUnseen(true);
  }, [turns, sending, outgoing]);
  // The scroller shrinking (the phone's keyboard opening, the composer growing) must not leave the
  // newest message under the composer: a reader at the tail stays at it.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (follow.current) el.scrollTo({ top: el.scrollHeight }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const jumpToLatest = () => {
    follow.current = true;
    setAtTail(true);
    setUnseen(false);
    if (winRef.current.last !== null) { toTail.current = true; setWin(TAIL_WINDOW); return; } // remount the tail, then go there
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  };
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  // Only the NEWEST read applies: a slow read from before a dispatch must not restore the entry.
  const queuedSeq = useRef(0);
  const loadQueued = () => {
    const seq = ++queuedSeq.current;
    return api.queued(row.repo, row.branch).then((q) => { if (seq === queuedSeq.current) setQueued(q); }).catch(() => {});
  };
  // The context ring's Compact button. `compacting` is the compact run's id ("" while the request is
  // in flight): pending until that turn arrives finished over the stream, then the ring is re-read.
  const [compacting, setCompacting] = useState<string | null>(null);
  const [compactError, setCompactError] = useState<string>();
  const onCompact = async () => {
    setCompactError(undefined);
    setCompacting("");
    try {
      setCompacting((await api.compact(row.repo, row.branch)).runId);
      await refresh();
    } catch (e) {
      setCompacting(null);
      setCompactError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    const done = compacting ? turns?.find((t) => t.id === compacting && t.finishedAt) : undefined;
    if (!done) return;
    setCompacting(null);
    if (done.failed) setCompactError(done.response || "Compaction failed.");
    void refresh(); // the card's ring reads the run's meta; the orchestrator's window polls its own
  }, [turns, compacting]);
  const [stopping, setStopping] = useState(false);
  // Stop, not Discard: kills the process but keeps the worktree, its commits, and the provider
  // session, so the next message resumes the same conversation and steers it somewhere else.
  const onStop = async () => {
    if (!row.worktreePath) return;
    setStopping(true);
    try {
      await api.stopAgent(row.worktreePath);
      await refresh(); // the card's running state drives this button and the composer's placeholder
    } finally {
      setStopping(false);
    }
  };
  // A message sent from anywhere else (quick-ask, the New-draft box) reached the bridge: re-read the
  // newest page and the queue BEFORE the outbox drops its "sending…" copy, so it never blinks out —
  // a message queued behind a busy wake publishes no event of its own.
  const reload = useRef(async () => {});
  reload.current = async () => { await loadLatest(); await loadQueued(); };
  useEffect(() => (outbox ? onOrchestratorDelivered(() => reload.current()) : undefined), [outbox]);
  // Not drawn once the bridge has recorded it — as the turn now running, or a queued entry.
  // A queued entry the loaded turns already show as delivered is not drawn, whatever the last read said.
  const pendingQueued = useMemo(() => undeliveredQueued(queued, turns), [queued, turns]);
  const unlanded = unlandedSends(outbox ? outgoing : sending, turns, queued);
  const history = useMemo(() => composerHistory(turns, queued, outbox ? outgoing : sending), [turns, queued, outbox, outgoing, sending]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const loaded = turnsRef.current ?? [];
    const range = windowRange(loaded, winRef.current);
    const below = loaded.length - range.end; // loaded, but unmounted below the window
    // At the bottom of the WINDOW is not the tail while newer turns are unmounted below it.
    const bottom = atBottom(el.scrollTop, el.scrollHeight, el.clientHeight, FOLLOW_SLACK);
    const tail = bottom && below === 0;
    follow.current = tail;
    if (tail !== atTail) setAtTail(tail);
    if (tail) setUnseen(false);
    if (el.scrollTop < OLDER_THRESHOLD) {
      // Near the top: remount the turns above the window if they are loaded, else fetch the next page.
      if (range.start > 0) { anchor.current = { top: el.scrollTop, height: el.scrollHeight }; setWin(revealAbove(loaded, winRef.current)); }
      else if (olderRef.current) void loadOlder();
    } else if (below > 0 && atBottom(el.scrollTop, el.scrollHeight, el.clientHeight, OLDER_THRESHOLD)) {
      setWin(revealBelow(loaded, winRef.current)); // added below the viewport: nothing to anchor
    }
  };
  const showAbove = () => {
    const el = scroller.current;
    if (el) anchor.current = { top: el.scrollTop, height: el.scrollHeight };
    setWin(revealAbove(turns ?? [], win));
  };

  // Compact is offered once the ring has a reading: only a Claude session reports one, and only a
  // Claude session can be compacted.
  const ctl = controls ?? {
    model: modelFor(row), onModel: (m: string) => setCardModel(row, m), ran: row.agentMeta?.model, contextPct: row.agentMeta?.contextPct,
  };
  // Only the mounted window renders.
  const range = windowRange(turns ?? [], win);
  const hiddenAbove = range.start, hiddenBelow = (turns?.length ?? 0) - range.end;
  const shownTurns = turns?.slice(range.start, range.end) ?? null;
  // Older turns render compact (chat styling): the newest RECENT_FULL in full, the rest cut to their
  // first lines; runs of automated wakes fold into one line.
  const position = new Map((turns ?? []).map((t, i) => [t.id, i]));
  const compactBefore = (turns?.length ?? 0) - RECENT_FULL;
  // Your newest message and the newest answer are never clamped or folded, at any age.
  const newest = newestMessages(turns ?? []);
  const stepsOf = (turn: AgentTurn) => () => api.turnSteps(row.repo, row.branch, turn.id, 0).then((r) => withoutFinalEcho(r.steps, turn.response));
  const chatTurn = (turn: AgentTurn) => <ChatTurn key={turn.id} turn={turn} loadSteps={stepsOf(turn)} compact={(position.get(turn.id) ?? 0) < compactBefore && turn !== newest.answer} newestSaid={turn === newest.said} onQuote={onQuote} author={author} />;
  const renderTurns = (list: AgentTurn[]) => {
    const items = chatItems(list, newest.answer);
    let prev: number | undefined;
    return items.map((item) => {
      const first = item.kind === "turn" ? item.turn : item.turns[0]!;
      const divider = first.startedAt && (prev === undefined || !sameDay(prev, first.startedAt));
      prev = (item.kind === "turn" ? item.turn : item.turns[item.turns.length - 1]!).startedAt ?? prev;
      return (
        <div key={first.id}>
          {divider && (
            <div className="text-muted-foreground my-3 flex items-center gap-3 text-[10px] tracking-widest uppercase" data-slot="chat-day">
              <span className="h-px flex-1 bg-border" /><span>{dayLabel(first.startedAt!)}</span><span className="h-px flex-1 bg-border" />
            </div>
          )}
          {item.kind === "turn" ? chatTurn(item.turn) : <AgentsMarker turns={item.turns} render={chatTurn} />}
        </div>
      );
    });
  };
  return (
    // log-themed: the page's theme (styles.css remaps the dark palette in light mode).
    <div className="log-themed flex h-full flex-col" data-slot="chat-panel" data-size={size}>
      <div
        ref={scroller}
        onScroll={onScroll}
        // overscroll-contain: hitting the chat's top or bottom must not hand the gesture to the page —
        // it did, and the page then kept scrolling when you turned back to scroll the chat up.
        className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain bg-neutral-950 leading-relaxed ${size === "page" ? "px-4 py-3 md:px-6" : "p-3"} font-sans text-[13px] text-neutral-200 [&_.prose]:text-[13px]`}
      >
        {running && (
          <div className="sticky top-0 z-10 -mt-1 mb-2 flex justify-end">
            <Tip label="Interrupt this run. The worktree, its commits, and the session are kept — reply below to redirect it.">
              <button
                type="button"
                onClick={onStop}
                disabled={stopping}
                className="rounded border border-amber-800 bg-neutral-950/90 px-2 py-0.5 text-[11px] text-amber-400 hover:border-amber-600 hover:text-amber-300 disabled:opacity-50"
              >
                {stopping ? "stopping…" : "■ stop"}
              </button>
            </Tip>
          </div>
        )}
        {dbDown && (
          <div role="status" data-slot="chat-db-down" className="mb-3 rounded-md bg-amber-950/60 px-2 py-1 text-[11px] text-amber-300">
            database unreachable — this conversation will sync when it is back
          </div>
        )}
        {/* Earlier pages: fetched as you near the top, or on a click (a page shorter than the window
            can't be scrolled). A skeleton while the page is in flight. */}
        {turns !== null && (older || hiddenAbove > 0) && (
          <div className="mb-3 flex justify-center" data-slot="chat-older">
            {loadingOlder ? <ChatSkeleton rows={2} /> : (
              <button type="button" onClick={() => (hiddenAbove > 0 ? showAbove() : void loadOlder())} className="rounded-md border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200">
                ↑ earlier turns
              </button>
            )}
          </div>
        )}
        {turns === null ? <ChatSkeleton rows={4} />
          : turns.length === 0 ? <p className="text-neutral-500">No history yet for <span className="text-neutral-300">{row.branch}</span>. Send a message below to start.</p>
          : <DraftContext.Provider value={drafts}>{renderTurns(shownTurns!)}</DraftContext.Provider>}
        {hiddenBelow > 0 && (
          <div className="mb-3 flex justify-center" data-slot="chat-newer">
            <button type="button" onClick={() => setWin(revealBelow(turns ?? [], win))} className="rounded-md border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200">
              ↓ {hiddenBelow} newer turn{hiddenBelow === 1 ? "" : "s"}
            </button>
          </div>
        )}
        {/* Not drawn once the real thing has arrived over the stream — the same text twice, one of
            them "sending", is worse than the moment's gap it would cover. */}
        {unlanded.map((m) => (
          <div key={m.id} className="mb-4" data-slot="chat-sending">
            <div className="mb-2 flex justify-end"><div className="bg-accent text-foreground max-w-[85%] rounded-lg px-3 py-2 whitespace-pre-wrap break-words opacity-70">{m.text}</div></div>
            <Attachments files={m.attachments ?? []} className="mb-2 justify-end" />
            <div className="text-muted-foreground pl-8 text-[11px]">▋ sending…</div>
          </div>
        ))}
        {pendingQueued.map((m) => (
          <Queued
            key={m.id}
            message={m}
            onCancel={() => void api.cancelQueued(row.repo, m.id).then(loadQueued)}
          />
        ))}
        {/* Scrolled up while the agent keeps talking: a way back down, instead of being dragged there. */}
        {!atTail && (
          <div className="sticky bottom-0 flex justify-center pointer-events-none">
            <button type="button" onClick={jumpToLatest} data-slot="chat-jump" data-unseen={unseen || undefined}
              className={`pointer-events-auto flex items-center gap-1 rounded-full border border-neutral-800 bg-neutral-900 px-2.5 py-1 font-sans text-[11px] shadow-menu hover:text-foreground ${unseen ? "text-sky-400" : "text-neutral-400"}`}>
              <ArrowDown className="size-3" />{unseen ? "New messages" : "Jump to latest"}
            </button>
          </div>
        )}
      </div>
      <div data-slot="chat-composer-dock" className={size === "page" ? "border-t p-4" : cn("border-t p-2", !pip && "max-md:p-3")}>
      <ChatComposer
        className="shadow-none"
        leading={<ChatControls {...ctl} compact={ctl.contextPct === undefined && compacting === null ? undefined
          : { onCompact, pending: compacting !== null, busy: running, error: compactError }} />}
        persistKey={`orca.chat.${row.repo}::${row.branch}`}
        repo={row.repo}
        insert={insert}
        placeholder={chatPlaceholder(running, row.repo)}
        // ↑/↓: what you sent in THIS chat, from its transcript, queue and outbox — the orchestrator's
        // included (it sends through the outbox, so `row.followUps` never had its messages).
        history={history}
        onSubmit={submit}
        prefill={prefill}
        // The Chat tab's own panel only ever mounts while that tab is active (Radix unmounts the
        // others), so focusing on mount covers opening it by click, by route, or via a
        // notification's `?reply` — one condition, not three.
        autoFocus={autoFocus}
        // Interrupt + message as ONE gesture, the way Managed Agents pairs user.interrupt with the
        // next user.message: the run is stopped and the text goes straight after it. If the process
        // hasn't exited by the time the message arrives it is queued and dispatched on exit, so the
        // order is the same either way.
        alt={running && row.worktreePath ? {
          label: "■ stop & send",
          title: "Interrupt the run and send this instead. The worktree, its commits, and the session are kept.",
          onSubmit: async (text, images) => {
            await api.stopAgent(row.worktreePath!);
            await submit(text, images);
            await refresh();
          },
        } : undefined}
      />
      </div>
    </div>
  );
}
