// The conversation with a branch's agent — or the orchestrator's — as ONE chat: the durable turns
// from the bridge's store (GET /api/turns), your messages as bubbles on the right, the agent's
// replies under its name on the left, with the follow-up composer below. Every surface renders it:
// the Agent page's Chat tab, a card's terminal modal, and the orchestrator's panel and page — only
// their sizing and the composer's wiring differ (ChatPanel's props). It is NOT a live shell — it
// renders the turns Orca already records.
//
// Orca still hosts no chat *runtime* — the composer fires the same headless one-shot every board
// action uses.
import { createContext, memo, startTransition, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlarmClock, ArrowDown, ArrowLeft, Bot, Check, ChevronRight, CloudMoon, Cog, Copy, Loader2, Quote as QuoteIcon, X } from "lucide-react";
import { isScheduledWake } from "../../../shared/scheduledWake";
import { isReflection } from "../../../shared/memory";
import { cn, PipContext } from "@/lib/utils";
import { navigate } from "@/lib/route";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { AgentStep, AgentTurn, OriginMessage, TurnOrigin } from "../../../shared/agent";
import { agentMessageFrom, isAgentMessage } from "../../../shared/agents";
import { agentSide, chatOwner, entryPill, entryTurn, inMainChat, mergePills, roomUnseen, roomsOf, routeLabel, routeOf, sameSide, sideLabel, stripAgentWrapper, type RoomEntry, type RoomPill, type Side } from "../../../shared/rooms";
import { persistedKey, usePersisted } from "@/lib/persisted";
import { api, type QueuedMessage } from "../api";
import { followUp, modelFor, previewsEnabled, refresh, setCardModel, type Row } from "../store";
import { ORCHESTRATOR_REPO, RECENT_FULL, TAIL_WINDOW, reportShots, turnHandoffs, TURN_PAGE_SIZE, WORKER_EVENT_MARKER, agentsMarker, attachmentRefs, isImageName, quoteMarkdown, splitSecretRefs, withoutAttachmentList, type AttachmentRef, anchoredScrollTop, capWindow, chatItems, chatPlaceholder, firedLabel, longMessage, newestMessages, splitMessages, longReply, revealAbove, revealBelow, windowRange, type TurnWindow, asTurnPage, atBottom, dayLabel, formatDuration, isWorkerEvent, mergeLatestPage, prependOlderPage, promptInstruction, sameDay, unlandedSends, undeliveredQueued, composerHistory, integrationPreview, integrationState, anchorShift, eagerFrom, estimateItemHeight, withNotices, ORIGIN_MISSING, originAskedBy, originAt, originHead, originSkippedText, originTimeLabel, type AgentMention } from "../workstream";
import { HandoffWidget } from "./Handoffs";
import { FormCard } from "@/components/FormCard";
import { stickToTail } from "@/lib/stickToTail";
import { turnForms } from "../../../shared/forms";
import { integrationMessage, shownPlace, type IntegrationMessage } from "../../../shared/integrations";
import { useCatchAllLabels } from "@/lib/catchAllLabels";
import { useNotifications } from "@/lib/notificationStore";
import { AddToPersonButton } from "@/components/SenderPerson";
import type { Notice } from "../../../shared/inbox";
import { BrandIcon, brandTitle } from "@/components/BrandIcon";
import { activityCounts, closeOpenMarkdown, createHold, runLabel, stepDuration, stepInFlight, stepKey, stepRow, stepRuns, toolDetail, toolLabel, workedLabel, workSteps, type StepStatus } from "../steps";
import { agentLabel, groupSteps, outcomeLead, withoutFinalEcho } from "../../../shared/agent";
import { ChatComposer } from "@/components/ChatComposer";
import { useSlashCommands } from "@/components/SlashCommands";
import { ComposerAttachment } from "@/components/ComposerAttachment";
import { ExpandableImage } from "@/components/ExpandableImage";
import { ShotThumbs } from "@/components/Screenshots";
import { snippetPre } from "@/components/Snippet";
import { copyText } from "@/lib/dialogs";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { useServerIdentity } from "@/lib/identity";
import { openOrchestrator } from "@/lib/orchestratorOpen";
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
/** Every fenced code block is a snippet card with a Copy button (components/Snippet.tsx). */
const chatComponents = { img: markdownImg, ...tableComponents, pre: snippetPre({ img: markdownImg, ...tableComponents }) };

/** A quote's left border, as a thin rounded pill instead of typography's square-edged bar: the
 *  native border can't take a border-radius on one side alone, so this drops it (`border-s-0`) and
 *  draws the bar as a `::before` pill instead — same soft neutral-600 (muted, theme-aware like the
 *  text/border classes beside it) in both bubble and reply, light and dark. */
const QUOTE_PILL = "prose-blockquote:relative prose-blockquote:border-s-0 " +
  "prose-blockquote:before:absolute prose-blockquote:before:inset-y-0.5 prose-blockquote:before:start-0 " +
  "prose-blockquote:before:w-1 prose-blockquote:before:rounded-full prose-blockquote:before:bg-neutral-600 prose-blockquote:before:content-['']";

/** Markdown inside the terminal-styled log: prose spacing and readable lists, but sized and coloured
 *  to sit in the chat's window rather than looking like a pasted document. `tone` overrides the body
 *  text colour (a worker report's folded body reads dimmer than a turn's own reply) without forking
 *  the renderer, its table handling, or its prose setup. `breaks` (the user's own bubble): a plain
 *  single newline, as typed, becomes a visible line break — CommonMark otherwise joins it to the
 *  next line as one paragraph, which read wrong for a typed message that was never meant as prose.
 *  `memo`: parsing markdown is the costliest thing a chat render does (measured: ~300ms commits
 *  re-parsing a long orchestrator thread on every open and close of its panel), and the text of a
 *  finished turn never changes. */
const ChatMarkdown = memo(({ children, tone = "text-neutral-300", breaks, outside }: { children: string; tone?: string; breaks?: boolean; outside?: boolean }) => (
  // wrap-anywhere: the agent's prose is full of unbreakable tokens (`branch/names-with-hashes`,
  // paths, run ids) that are wider than a narrow window, and one of them made the whole log scroll
  // sideways. Code BLOCKS are exempt — they keep their lines and scroll inside themselves.
  // prose-strong: Tailwind typography's own --tw-prose-bold var resolves to --tw-prose-invert-bold,
  // which the .prose class sets to a literal white (baked in from its gray theme) directly on this
  // element — a declaration .log-themed's ancestor-level remap can never reach, since an element's
  // own matching rule always beats an inherited custom property. That made bold text render
  // white-on-white in light theme. Route it through Tailwind's own (correctly remapped) neutral-200
  // token instead, like prose-headings/prose-code/prose-a already do. The same bug hits every other
  // --tw-prose-invert-* var .prose declares a literal default for — blockquote, hr, table borders,
  // figcaption — even though styles.css maps them too: the map is dead weight, never read. Quotes
  // rendered near-white text on a near-black bar, in a light-blue user bubble, until routed the
  // same way.
  <div className={cn("prose prose-invert prose-sm max-w-none wrap-anywhere prose-pre:wrap-normal",
    "prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 prose-headings:text-neutral-200",
    "prose-li:my-0.5 prose-ul:my-1 prose-ol:my-1",
    "prose-strong:text-neutral-200",
    "prose-code:text-sky-300 prose-code:before:content-none prose-code:after:content-none",
    "prose-pre:bg-neutral-900 prose-pre:text-[11px] prose-pre:text-neutral-200 prose-a:text-sky-400",
    "prose-blockquote:text-neutral-400", QUOTE_PILL,
    "prose-hr:border-neutral-800 prose-th:border-neutral-800 prose-td:border-neutral-800 prose-figcaption:text-neutral-500",
    tone)}>
    <ReactMarkdown remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]} components={outside ? outsideComponents : chatComponents}>{children}</ReactMarkdown>
  </div>
));

/** An outside sender's message (Discord, Slack, email…): the chat's markdown, but an image is a link,
 *  never loaded — a stranger's message must not make this browser fetch a remote URL. */
const outsideImg = ({ src, alt }: { src?: string | Blob; alt?: string }) =>
  typeof src === "string" ? <a href={src} target="_blank" rel="noreferrer">{alt || src}</a> : <>{alt}</>;
const outsideComponents = { ...chatComponents, img: outsideImg };
// One line: every block renders inline, so the line keeps its height and its `truncate`.
const inlineBlock = ({ children: c }: { children?: ReactNode }) => <>{c}</>;
const inlineComponents = { ...outsideComponents, p: inlineBlock, ul: inlineBlock, ol: inlineBlock, li: inlineBlock, blockquote: inlineBlock, h1: inlineBlock, h2: inlineBlock, h3: inlineBlock, h4: inlineBlock, h5: inlineBlock, h6: inlineBlock, pre: inlineBlock };

/** The one-line preview of an outside message: the SAME markdown as its expanded body (bold, code,
 *  links), inline. The preview is clipped, so a cut `**` or backtick is closed first. */
const InlineMarkdown = memo(({ children }: { children: string }) => (
  <span data-slot="inline-markdown" className="[&_code]:font-mono [&_code]:text-sky-300 [&_strong]:text-foreground [&_strong]:font-semibold [&_a]:text-sky-400">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={inlineComponents}>{closeOpenMarkdown(children)}</ReactMarkdown>
  </span>
));

/** Markdown for a single Facet item (Remaining / Decisions / Verification / Commits): same renderer
 *  and prose palette as ChatMarkdown, but a paragraph renders inline rather than as its own <p> — the
 *  facet's <ul> already supplies the item's spacing, so a block margin on top would double it up. A
 *  nested sub-bullet or a stray `##` sub-heading the parser kept verbatim (see shared/agent.ts
 *  sectionValue) still renders as its own block — a real nested list, or a heading — beneath the
 *  item's text. */
const FacetMarkdown = memo(({ children }: { children: string }) => (
  <div className={`prose prose-invert prose-sm max-w-none wrap-anywhere text-neutral-300
    prose-headings:mt-1 prose-headings:mb-0.5 prose-headings:text-xs prose-headings:text-neutral-200
    prose-li:my-0.5 prose-ul:my-1 prose-ol:my-1
    prose-strong:text-neutral-200
    prose-code:text-sky-300 prose-code:before:content-none prose-code:after:content-none
    prose-pre:bg-neutral-900 prose-pre:text-[11px] prose-pre:text-neutral-200 prose-a:text-sky-400
    prose-blockquote:text-neutral-400 ${QUOTE_PILL}
    prose-hr:border-neutral-800 prose-th:border-neutral-800 prose-td:border-neutral-800 prose-figcaption:text-neutral-500`}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ ...chatComponents, p: ({ children: c }) => <>{c}</> }}>{children}</ReactMarkdown>
  </div>
));

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

/** One line of text that cross-fades when it changes: the old line and the new line run their
 *  animations TOGETHER, same duration and easing (LABEL_FADE_MS) — the old one translates up and
 *  OUT while it fades, the new one translates up and IN while it fades, so neither sits fully
 *  opaque over the other and the text never overlaps. Both sit in ONE grid cell with a fixed line
 *  height and `overflow-hidden`, so the line never changes height and nothing sliding leaks outside
 *  it. The box takes 1.2em of layout, but its one grid row is 2.2em (taller than the ~1.625em line
 *  it inherits) and runs into a `box-content` padding that an equal negative margin cancels — split
 *  EVENLY above and below (not bottom-only), so the padding/margin trick itself doesn't move the
 *  box's own centre. A row bigger than its container still anchors at the container's START by
 *  default, not its centre, so `content-center` re-centres the oversized row on the box, and
 *  `items-center` then centres the real line within that row — together putting the line's own
 *  centre exactly on the box's centre, matching a sibling (the header's spinner) centred on ITS
 *  own box. (`items-center` alone left the row's own placement un-centred, and the label still
 *  read low against the spinner.) The `label-*` classes are in styles.css (a plain opacity
 *  cross-fade under reduced motion). */
function CrossFade({ text, slot }: { text: string; slot?: string }) {
  const [s, setS] = useState<{ text: string; n: number; gone: string | null }>({ text, n: 0, gone: null });
  if (s.text !== text) setS({ text, n: s.n + 1, gone: s.text });
  useEffect(() => {
    if (s.gone === null) return;
    const t = setTimeout(() => setS((v) => ({ ...v, gone: null })), LABEL_FADE_MS);
    return () => clearTimeout(t);
  }, [s.n, s.gone]);
  return (
    <span className="-my-[0.5em] box-content content-center grid h-[1.2em] min-w-0 flex-1 grid-rows-[2.2em] items-center overflow-hidden py-[0.5em]">
      {s.gone !== null && <span key={`out-${s.n}`} aria-hidden="true" data-slot={slot && `${slot}-out`} className="label-out truncate [grid-area:1/1]">{s.gone}</span>}
      <span key={`in-${s.n}`} data-slot={slot} className={cn("truncate [grid-area:1/1]", s.n > 0 && "label-in")}>{text}</span>
    </span>
  );
}
const LABEL_FADE_MS = 220;

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
          {/* The count line and the trail open together on the first step. The trail's height
              grows with its rows (never shrinks within a live turn, since steps only accumulate)
              and the growth itself is what animates \u2014 no space is reserved ahead of what is
              actually shown, so a short run leaves no gap below its last row. */}
          <Fold open={Boolean(counts || trail.length)}>
            <div className="text-muted-foreground mt-0.5 truncate pl-5.5 text-[11px] leading-4" data-slot="activity-counts">{counts || "\u00a0"}</div>
            {!open && (
              <ul className="mt-1 space-y-0.5 pl-5.5 text-[11px] leading-4 opacity-60 transition-[min-height] duration-200 ease-out motion-reduce:transition-none"
                style={trail.length ? { minHeight: `${trail.length * 18 - 2}px` } : undefined} data-slot="activity-trail">
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
  // What the reply says before its sections (a snippet to paste, often): `structured` has only the
  // sections. Without it, a snippet shown while the turn ran vanished when it finished.
  const lead = outcomeLead(turn.response ?? "");
  return (
    <div className="space-y-1.5 text-neutral-300">
      {lead && <div data-slot="turn-lead"><ChatMarkdown>{lead}</ChatMarkdown></div>}
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

/** The files a message carried: a thumbnail for an image, a named chip for anything else, and a
 *  lock chip for each stored secret (`secrets`: its references, never a value) — the composer's own
 *  attachment chips (ComposerAttachment), moved with the message. Each file opens the stored file
 *  from the bridge (`/api/attachments/<id>`, read from Postgres), so it works from any instance,
 *  whichever one took the upload. */
export function Attachments({ files, secrets = [], className = "" }: { files: AttachmentRef[]; secrets?: string[]; className?: string }) {
  if (!files.length && !secrets.length) return null;
  // Just the images, in order: the other images this message carried are this one's lightbox gallery.
  const images = files.filter((f) => isImageName(f.name)).map((f) => ({ src: apiUrl(`/api/attachments/${f.id}`), alt: f.name }));
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`} data-slot="message-attachments">
      {files.map((f) => {
        const href = apiUrl(`/api/attachments/${f.id}`);
        const imgIndex = images.findIndex((im) => im.src === href);
        return <ComposerAttachment key={f.id} look="chip" item={isImageName(f.name)
          ? { kind: "image", name: f.name, src: href, gallery: images.length > 1 ? { images, index: imgIndex } : undefined }
          : { kind: "file", name: f.name, href }} />;
      })}
      {secrets.map((ref) => <ComposerAttachment key={ref} look="chip" item={{ kind: "secret", name: ref }} />)}
    </div>
  );
}

/** Copy (the message's raw markdown, with a brief "Copied" confirmation) and Quote (insert it into
 *  the composer as a blockquote) for one message. Hidden until the message is hovered, but stays
 *  reachable: visible while a button inside has focus (keyboard), and always on a touch screen,
 *  which has no hover to reveal it. */
function MessageActions({ text, onQuote, className }: { text: string; onQuote?: () => void; className?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (await copyText(text, "message")) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
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
      {/* No Quote where there is no composer (a room is read only). */}
      {onQuote && (
        <Tip label="Quote">
          <Button type="button" size="icon" variant="ghost" className={cn("size-6", btn)} aria-label="Quote message" onClick={onQuote}>
            <QuoteIcon className="size-3.5" />
          </Button>
        </Tip>
      )}
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
  // An outside message waiting for its wake: the SAME card a delivered one gets (IntegrationCard),
  // faded, its state "queued". Open, it shows the message in full; the reply comes once it runs.
  const outside = integrationMessage(message.instruction);
  if (outside) {
    return (
      <IntegrationCard slot="integration-queued" pending messages={[outside]} time="" state="queued">
        <IntegrationMessages messages={[outside]} />
      </IntegrationCard>
    );
  }
  // Your message: the SAME bubble and markdown as a sent one (UserBubble), faded until it sends. Once
  // sent it is that bubble in its turn, without the fade.
  const text = withoutAttachmentList(message.instruction);
  return (
    <UserBubble slot="chat-queued" textSlot="chat-queued-text" pending className="mb-4" text={text} clamp={false}
      files={attachmentRefs((message.attachments ?? []).join("\n"))}
      footer={
        <div data-slot="queued-label" className="text-muted-foreground flex items-center justify-end gap-2 text-[10px] tracking-widest uppercase">
          <span className="text-right">queued — sends when the current run finishes</span>
          <button type="button" onClick={onCancel} className="tracking-normal normal-case hover:text-red-400">cancel</button>
        </div>
      } />
  );
}

/** What you said: a tinted bubble on the right, in markdown, with its files under it and a footer
 *  line. ONE component for a sent message (in its turn), one still sending, and a queued one
 *  (`pending`: faded, its footer the state label), so a message looks the same at every stage. */
function UserBubble({ text, files, clamp, footer, pending, slot = "chat-user", textSlot = "chat-user-text", className = "mb-2" }: {
  text: string; files: AttachmentRef[]; clamp: boolean; footer: ReactNode; pending?: boolean; slot?: string; textSlot?: string; className?: string;
}) {
  // A secret the message carries is a chip beside its files, never text in the bubble.
  const { text: shown, refs: secrets } = splitSecretRefs(text);
  return (
    <div className={cn("group flex justify-end", className)} data-slot={slot} data-pending={pending || undefined}>
      {/* Each child keeps its own width on the right: a queued message's long label must not widen
          its bubble past a sent one's. */}
      <div data-slot="user-bubble-column" className="flex max-w-[85%] flex-col items-end">
        {/* Pending: the message and its files fade; the queued label below stays readable.
            max-w-full: without it, a long blockquote holding an unbreakable code line (Quote on a
            reply with a fenced block) made this box shrink-to-fit the code's own width instead of
            the column's cap — the bubble grew past the chat column and its start ran under
            whatever sits beside it. The cap lets the code's own horizontal scroll (Snippet.tsx)
            take over instead, and prose text wraps normally again. */}
        {shown && <div data-slot={textSlot} className={cn("bg-accent text-foreground max-w-full rounded-lg px-3 py-2", pending && "opacity-60")}>
          <Clamp on={clamp} cut="max-h-[9rem]">
            <ChatMarkdown tone="text-foreground" breaks>{shown}</ChatMarkdown>
          </Clamp>
        </div>}
        <Attachments files={files} secrets={secrets} className={cn("mt-1 justify-end", pending && "opacity-60")} />
        <div className="mt-0.5">{footer}</div>
      </div>
    </div>
  );
}

/** The origin of a turn the orchestrator started: "Asked by Finn · 25 Oct 15:20", collapsed. It opens
 *  to each referenced message, quoted (`turn.originMessages`, joined by the bridge from the
 *  queue's rows; a row that is gone says so), and a link to the orchestrator's turn. An outside
 *  sender shows with its name and channel. For humans only: the worker never sees it. */
function TurnOriginQuote({ origin, messages }: { origin: TurnOrigin; messages: OriginMessage[] }) {
  const you = useServerIdentity()?.tailscaleUser?.name;
  const at = originAt(messages);
  const label = `${originHead(messages, you || "you")}${at !== undefined ? ` · ${originTimeLabel(at)}` : ""}`;
  const skipped = originSkippedText(origin);
  const open = () => {
    openOrchestrator();
    // Best effort: the wake's turn, when the orchestrator's chat has it mounted.
    setTimeout(() => document.querySelector(`[data-run-id="${CSS.escape(origin.wakeRunId)}"]`)?.scrollIntoView({ block: "center" }), 300);
  };
  return (
    <div className="mb-2 flex justify-end">
      <Accordion type="single" collapsible data-slot="turn-origin" className="w-full max-w-[85%] rounded-md border text-[12px]">
        <AccordionItem value="origin" className="border-b-0">
          <AccordionTrigger data-slot="turn-origin-label" className="text-muted-foreground hover:text-foreground gap-2 px-2.5 py-1.5 text-[12px] font-normal hover:no-underline">
            <span className="flex min-w-0 items-center gap-1.5"><QuoteIcon className="size-3.5 shrink-0" /><span className="truncate">{label}</span></span>
          </AccordionTrigger>
          <AccordionContent className="space-y-2 border-t px-2.5 pt-2 pb-2">
            {messages.map((m) => m.missing
              ? <div key={m.id} data-slot="turn-origin-missing" className="text-muted-foreground border-l-2 pl-3 italic">{ORIGIN_MISSING}</div>
              : (
                <blockquote key={m.id} data-slot="turn-origin-message" className="border-l-2 pl-3">
                  {m.from && messages.length > 1 && <div className="text-muted-foreground mb-0.5 text-[11px]">{originAskedBy([m])}</div>}
                  <ChatMarkdown tone="text-foreground" breaks>{m.text ?? ""}</ChatMarkdown>
                </blockquote>
              ))}
            {skipped && <div className="text-muted-foreground text-[11px]">{skipped}</div>}
            <Button variant="link" size="sm" className="h-auto p-0 text-[12px]" data-slot="turn-origin-link" onClick={open}>Open the orchestrator's turn</Button>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
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
          {(!work.length || draft) && (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
              {draft || tail ? "" : "working…"}
            </span>
          )}
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

// ONE formatter: `toLocaleTimeString` builds a new one on every call, and a chat render calls this per
// turn (it showed in the panel's open / close profile).
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const clockOf = (ms?: number) => (ms ? CLOCK.format(ms) : "");

/** One exchange, as a modern assistant chat rather than a terminal log. What you said is a tinted
 *  bubble on the right; the agent (`author`: the orchestrator, else the turn's provider) answers on
 *  the left under its name, in readable prose; its tool steps and worker reports stay folded; the time shows on hover
 *  (and days are grouped by the divider ChatPanel draws). Colours are the theme's tokens, so it
 *  follows light and dark like the rest of the console. */
// Memoized, with only stable props (the turn, flags, two stable callbacks): a re-render of the panel —
// every open sets a new composer prefill — must not render the whole thread again (measured: ~60ms per
// open with a long orchestrator thread at 4× CPU in production, ~250ms in dev).
// `saidBy` / `replyBy` are the speakers (shared/rooms.ts sideLabel): a room, or a turn that is not
// the person's, names who sent the messages; `replyBy: null` draws no reply (a message the other side
// has not answered). Primitive props, so the memo holds. Without them: you, and the agent (`author`).
const ChatTurn = memo(function ChatTurn({ turn, loadStepsFor, compact, newestSaid, onQuote, author, owner, saidBy, replyBy, source }: { turn: AgentTurn; loadStepsFor?: (turn: AgentTurn) => Promise<AgentStep[]>; compact?: boolean; newestSaid?: boolean; onQuote?: (text: string) => void; author?: string; owner?: Side; saidBy?: string; replyBy?: string | null; source?: string }) {
  const loadSteps = loadStepsFor && (() => loadStepsFor(turn));
  const parts = splitMessages(turn.instruction ?? promptInstruction(turn.prompt));
  // A wake that carried your messages AND worker reports: your words in bubbles — one per message you
  // sent, however many one wake drained — and the reports folded. Orca's own events (a PR's CI or
  // conflicts) have no grant, so they can share a wake with you: they get the activity card, never a bubble.
  const reports = parts.filter(isWorkerEvent), outside = parts.map(integrationMessage).filter((m): m is IntegrationMessage => Boolean(m));
  // A scheduled wake the agent set itself (`orca wake`): a system line, never a bubble of yours.
  // A reflection (shared/memory.ts) is Orca's own turn for the agent's memory: a system line too.
  const fired = parts.filter((p) => isScheduledWake(p) || isReflection(p));
  // Another agent's message (`orca ask`) in a wake that also carried yours: its own card with both
  // ends named, never your bubble. A wake of only such messages is in that agents' room instead.
  const asks = parts.filter(isAgentMessage);
  const said = parts.filter((p) => !isWorkerEvent(p) && !integrationMessage(p) && !isScheduledWake(p) && !isReflection(p) && !isAgentMessage(p));
  // Each message's files: an orchestrator wake carries their references in the instruction (one set
  // per message); an agent chat's instruction is the typed text alone, its files read off the prompt.
  const inline = attachmentRefs(turn.instruction ?? "").length > 0;
  const filesOf = (text: string, i: number) => inline ? attachmentRefs(text) : i === said.length - 1 ? turn.attachments ?? [] : [];
  const time = clockOf(turn.startedAt);
  return (
    <div className="mb-4" data-slot="chat-turn" data-run-id={turn.id} data-failed={turn.failed || undefined} data-source={source}>
      {/* Why the orchestrator started this turn: the person's words in its wake, above the brief. */}
      {turn.origin && <TurnOriginQuote origin={turn.origin} messages={turn.originMessages ?? turn.origin.messageIds.map((id) => ({ id, missing: true as const }))} />}
      {/* Worker reports that woke it, split out of what you said: a collapsed block of their own. */}
      {reports.length > 0 && (
        <WorkerBlock slot="turn-reports" className="mb-2"
          label={reports.length === 1 ? `Worker report · ${reportTitle(reports[0]!)}` : `${reports.length} worker reports`}>
          <WorkerReports parts={reports} />
        </WorkerBlock>
      )}
      {/* A fired message (a scheduled wake or a reflection pass) mixed into a wake with a worker
          report: a system line, not its own collapsed card — a pure-fired turn gets that instead
          (ChatItem's "fired" kind, FiredBlock below). */}
      {fired.map((text, i) => (
        <div key={`w${i}`} className="mb-1 flex items-center gap-1.5 text-xs text-neutral-500" data-slot="scheduled-wake">
          {isReflection(text) ? <CloudMoon className="size-3.5 shrink-0" aria-hidden /> : <AlarmClock className="size-3.5 shrink-0" aria-hidden />}
          <span className="truncate">{firedLabel(text)}</span>
        </div>
      ))}
      {asks.map((text, i) => <AgentAsk key={`a${i}`} text={text} to={owner} time={time} />)}
      {outside.length > 0 && (
        <IntegrationCard slot="turn-integration" messages={outside} time={time} state={integrationState(turn)}>
          <IntegrationMessages messages={outside} />
        </IntegrationCard>
      )}
      {saidBy && said.length > 0 && <div data-slot="chat-speaker" className="text-muted-foreground mb-0.5 text-right text-[11px]">{saidBy}</div>}
      {said.map((text, i) => {
        const clean = withoutAttachmentList(text);
        return (
          // A long message is cut to its first lines, like an old reply — except your newest message,
          // which is always in full.
          <UserBubble key={i} text={clean} files={filesOf(text, i)} clamp={!(newestSaid && i === said.length - 1) && longMessage(clean)}
            footer={
              <div className="flex items-center justify-end gap-1.5">
                {clean && <MessageActions text={clean} onQuote={onQuote && (() => onQuote(clean))} />}
                {i === said.length - 1 && <div className="text-muted-foreground text-[10px] opacity-0 transition-opacity group-hover:opacity-100" data-slot="turn-time">{time}</div>}
              </div>
            } />
        );
      })}
      {replyBy !== null && <div className="group flex gap-2" data-slot="chat-reply">
        <span className="bg-accent text-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-full" aria-hidden="true"><Bot className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          {/* One line the avatar's height: the name, then Copy / Quote right beside it (not after the
              hover-only time, whose reserved width left them floating off on their own), then the time. */}
          <div data-slot="chat-reply-head" className="text-muted-foreground mb-0.5 flex h-6 items-center gap-2 text-[11px]">
            <span className="text-foreground font-medium">{replyBy ?? author ?? agentLabel(turn.provider)}</span>
            {turn.failed ? <span className="text-red-400">failed</span> : turn.stopped ? <span className="text-amber-400">stopped by you</span> : null}
            {turn.finishedAt && turn.response && <MessageActions text={turn.response} onQuote={onQuote && (() => onQuote(turn.response))} className="-mx-1" />}
            <span className="opacity-0 transition-opacity group-hover:opacity-100" data-slot="turn-time">{clockOf(turn.finishedAt) || time}</span>
          </div>
          <Reply turn={turn} loadSteps={loadSteps} compact={compact} />
          {/* A pack this turn made (`orca handoff create`): review it and Send it here. */}
          {turnHandoffs(turn).map((id) => <HandoffWidget key={id} id={id} />)}
          {/* A form this turn asked (`orca ask-form`): fill it in here. */}
          {turnForms(turn).map((id) => <FormCard key={id} id={id} />)}
        </div>
      </div>}
    </div>
  );
});

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

// ---- lazy mount: only the items near the viewport render (workstream.ts: estimateItemHeight) ----
// One IntersectionObserver (rooted on the scroller) mounts an item as it comes within LAZY_MARGIN; one
// ResizeObserver records every item's height, so an item the window unmounts comes back as a box of
// its real height. Items that come near are mounted together, LAZY_BATCH_MS after the first, in ONE
// transition: each commit makes Chromium walk the whole chat again (pre-paint), and one commit per
// item made a scroll up through a cold thread drop a frame in five. An item already in view mounts
// at once. Chrome and Firefox hold the scroll position natively when an item above the
// viewport grows on mount (overflow-anchor); where that is missing (Safari) anchorShift does it.
// Find in page sees only the mounted items.
const LAZY_MARGIN = "1200px 0px";
const LAZY_BATCH_MS = 60;
type Lazy = {
  heights: Map<string, number>;
  /** Watch an item's height; and, with `show`, call it once the item is near the viewport. */
  observe: (el: Element, id: string, show?: () => void) => () => void;
  disconnect: () => void;
};
const LazyContext = createContext<Lazy | null>(null);
function createLazy(root: () => HTMLElement | null): Lazy | null {
  if (typeof IntersectionObserver === "undefined") return null;
  const heights = new Map<string, number>(), ids = new Map<Element, string>(), shows = new Map<Element, () => void>();
  const native = typeof CSS !== "undefined" && Boolean(CSS.supports?.("overflow-anchor", "auto"));
  let io: IntersectionObserver | null = null, ro: ResizeObserver | null = null;
  const due = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const now = [...due];
    due.clear();
    // A transition: React renders the markdown in time slices, so the scroll stays smooth meanwhile.
    startTransition(() => { for (const show of now) show(); });
  };
  const setup = () => {
    if (io) return;
    io = new IntersectionObserver((entries) => {
      const view = root()?.getBoundingClientRect();
      let inView = false;
      for (const e of entries) {
        const show = e.isIntersecting ? shows.get(e.target) : undefined;
        if (!show) continue;
        due.add(show);
        const r = e.boundingClientRect; // no layout (no rect, a 0-high root): nothing to wait for
        if (!view?.height || !r || (r.bottom > view.top && r.top < view.bottom)) inView = true;
      }
      if (!due.size) return;
      if (inView) flush();
      else timer ??= setTimeout(flush, LAZY_BATCH_MS);
    }, { root: root(), rootMargin: LAZY_MARGIN });
    if (typeof ResizeObserver === "undefined") return;
    ro = new ResizeObserver((entries) => {
      const el = root();
      const changes: { bottom: number; delta: number }[] = [];
      for (const e of entries) {
        const id = ids.get(e.target), h = (e.target as HTMLElement).offsetHeight;
        if (id === undefined || !h) continue; // 0: not laid out (a hidden panel) — keep the last height
        const was = heights.get(id);
        heights.set(id, h);
        if (!native && was !== undefined && was !== h) changes.push({ bottom: e.target.getBoundingClientRect().bottom, delta: h - was });
      }
      const shift = el && changes.length ? anchorShift(changes, el.getBoundingClientRect().top) : 0;
      if (el && shift) el.scrollTop += shift;
    });
  };
  return {
    heights,
    observe(el, id, show) {
      setup();
      ids.set(el, id);
      ro?.observe(el);
      if (show) { shows.set(el, show); io!.observe(el); }
      return () => {
        ro?.unobserve(el);
        ids.delete(el);
        if (show) { shows.delete(el); due.delete(show); io?.unobserve(el); }
      };
    },
    disconnect() { clearTimeout(timer); io?.disconnect(); ro?.disconnect(); },
  };
}
/** One item of the list: its content once near the viewport (or `eager`, the newest ones), before
 *  that an empty box of its last height or `estimate`. Once mounted it stays mounted. */
function LazyItem({ id, eager, estimate, children }: { id: string; eager: boolean; estimate: number; children: ReactNode }) {
  const lazy = useContext(LazyContext);
  const [shown, setShown] = useState(eager || !lazy);
  if (eager && !shown) setShown(true); // became one of the newest (the window moved back to the tail)
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!lazy || !ref.current) return;
    return lazy.observe(ref.current, id, shown ? undefined : () => setShown(true));
  }, [lazy, id, shown]);
  return shown ? <div ref={ref} data-slot="chat-item">{children}</div>
    : <div ref={ref} data-slot="chat-item" data-pending="" style={{ height: lazy?.heights.get(id) ?? estimate }} />;
}

const STATE_TONE = { answered: "text-geist-green", "in progress": "text-geist-blue", failed: "text-red-400", stopped: "text-amber-400" } as const;

/** The collapsed line of an outside message: logo, sender, place, one line of what they wrote, the
 *  time and the state. The same tinted card as worker traffic, with the service's logo for the ⚙. */
type CardState = keyof typeof STATE_TONE | "queued" | "notified";

function IntegrationHead({ m, more, time, state }: { m: IntegrationMessage; more: number; time: string; state: CardState }) {
  const place = shownPlace(m.place, useCatchAllLabels());
  return (
    <>
      <BrandIcon kind={m.adapter} className="size-3.5" />
      <span className="text-foreground shrink-0 font-medium" data-slot="integration-sender">{m.sender ?? brandTitle(m.adapter)}</span>
      {place && <span className="shrink-0" data-slot="integration-place">{place}</span>}
      <span className="min-w-0 flex-1 truncate" data-slot="integration-preview"><InlineMarkdown>{integrationPreview(m.text)}</InlineMarkdown>{more > 0 ? ` · +${more} more` : ""}</span>
      {time && <span className="shrink-0 text-[11px]">{time}</span>}
      <span data-slot="integration-state" className={cn("flex shrink-0 items-center gap-1 text-[11px]", state === "queued" || state === "notified" ? "" : STATE_TONE[state])}>
        {state === "in progress" && <Loader2 className="size-3 animate-spin" />}{state}
      </span>
    </>
  );
}

/** The tinted, collapsed activity card every background turn uses — an outside message, a scheduled
 *  wake, a reflection pass: one line (`head`) collapsed, the full body open in place. ONE shell, so
 *  every kind of "this happened without you" turn looks and behaves the same. */
function CollapsedCard({ slot, bodySlot, state, pending, dataAttrs, head, children }: {
  slot: string; bodySlot: string; state: CardState; pending?: boolean; dataAttrs?: Record<string, string>; head: ReactNode; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-slot={slot} data-state={state} data-open={open || undefined} data-pending={pending || undefined} {...dataAttrs}
      className={cn("border-geist-blue/20 bg-geist-blue/5 mb-4 rounded-md border text-[12px]", pending && "opacity-60")}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left">
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        {head}
      </button>
      {open && <div className="border-geist-blue/20 space-y-3 border-t px-2.5 py-2" data-slot={bodySlot}>{children}</div>}
    </div>
  );
}

/** The tinted card of an outside message (Discord, Slack, email…): ONE collapsed activity row that
 *  opens in place. A delivered message's wake (IntegrationBlock) and a queued one (Queued, `pending`:
 *  faded) are the same card, so it looks the same before and after it runs. */
function IntegrationCard({ slot, messages, time, state, pending, children }: {
  slot: string; messages: IntegrationMessage[]; time: string; state: CardState; pending?: boolean; children: ReactNode;
}) {
  return (
    <CollapsedCard slot={slot} bodySlot="integration-body" state={state} pending={pending} dataAttrs={{ "data-adapter": messages[0]!.adapter }}
      head={<IntegrationHead m={messages[0]!} more={messages.length - 1} time={time} state={state} />}>
      {children}
    </CollapsedCard>
  );
}

/** The collapsed line of a fired wake (a scheduled wake or a reflection pass): its icon, the
 *  summary, the time and the state — no sender, no place, unlike an outside message's. */
function FiredHead({ text, time, state }: { text: string; time: string; state: CardState }) {
  return (
    <>
      {isReflection(text) ? <CloudMoon className="size-3.5 shrink-0" aria-hidden /> : <AlarmClock className="size-3.5 shrink-0" aria-hidden />}
      <span className="min-w-0 flex-1 truncate" data-slot="fired-preview">{firedLabel(text)}</span>
      {time && <span className="shrink-0 text-[11px]">{time}</span>}
      <span data-slot="fired-state" className={cn("flex shrink-0 items-center gap-1 text-[11px]", state === "queued" || state === "notified" ? "" : STATE_TONE[state])}>
        {state === "in progress" && <Loader2 className="size-3 animate-spin" />}{state}
      </span>
    </>
  );
}

/** Each outside message in full, with a link to it: the open card's body. */
function IntegrationMessages({ messages }: { messages: IntegrationMessage[] }) {
  const labels = useCatchAllLabels();
  return messages.map((m, i) => (
    <div key={i} data-slot="integration-message">
      <div className="text-muted-foreground mb-0.5 flex items-center gap-1.5 text-[11px]">
        <BrandIcon kind={m.adapter} className="size-3" />
        <span className="text-foreground font-medium">{m.sender ?? brandTitle(m.adapter)}</span>
        <span data-slot="integration-message-place">{[shownPlace(m.place, labels), brandTitle(m.adapter)].filter(Boolean).join(" · ")}</span>
        {m.url && <a href={m.url} target="_blank" rel="noreferrer" className="hover:text-foreground underline-offset-2 hover:underline">Open in {brandTitle(m.adapter)}</a>}
      </div>
      <div data-slot="integration-message-text"><ChatMarkdown tone="text-foreground" breaks outside>{m.text}</ChatMarkdown></div>
    </div>
  ));
}

/** A wake an outside message caused: ONE collapsed activity row, never your bubble. Open, it shows
 *  each message in full with a link to it, then the orchestrator's answer — its folded steps (the
 *  `orca post --reply` among them) and its reply — so the bulk stays out of your conversation, like
 *  worker reports. */
const IntegrationBlock = memo(function IntegrationBlock({ turn, messages, loadStepsFor }: { turn: AgentTurn; messages: IntegrationMessage[]; loadStepsFor?: (turn: AgentTurn) => Promise<AgentStep[]> }) {
  return (
    <IntegrationCard slot="integration-activity" messages={messages} time={clockOf(turn.startedAt)} state={integrationState(turn)}>
      <IntegrationMessages messages={messages} />
      <div className="flex gap-2" data-slot="integration-reply">
        <span className="bg-accent text-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-full" aria-hidden="true"><Bot className="size-3" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-foreground mb-0.5 text-[11px] font-medium">Orca</div>
          <Reply turn={turn} loadSteps={loadStepsFor && (() => loadStepsFor(turn))} />
        </div>
      </div>
    </IntegrationCard>
  );
});

/** A wake the agent fired on itself — a scheduled wake or a reflection pass — with nothing else in
 *  it: ONE collapsed activity row, never your bubble, like an outside message's. Open, it shows the
 *  full trigger text, then the orchestrator's answer. A reflection links to its pass on the Memory
 *  page's Reflection tab. */
const FiredBlock = memo(function FiredBlock({ turn, messages, loadStepsFor }: { turn: AgentTurn; messages: string[]; loadStepsFor?: (turn: AgentTurn) => Promise<AgentStep[]> }) {
  const state = integrationState(turn);
  const reflection = messages.some(isReflection);
  return (
    <CollapsedCard slot="fired-activity" bodySlot="fired-body" state={state} dataAttrs={{ "data-kind": reflection ? "reflection" : "wake" }}
      head={<FiredHead text={messages[0]!} time={clockOf(turn.startedAt)} state={state} />}>
      {messages.map((text, i) => <div key={i} data-slot="fired-message" className="text-foreground whitespace-pre-wrap">{text}</div>)}
      {reflection && (
        <button type="button" data-slot="fired-memory-link" onClick={() => navigate("/memory?tab=reflection")}
          className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline">
          View reflection passes
        </button>
      )}
      <div className="flex gap-2" data-slot="fired-reply">
        <span className="bg-accent text-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-full" aria-hidden="true"><Bot className="size-3" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-foreground mb-0.5 text-[11px] font-medium">Orca</div>
          <Reply turn={turn} loadSteps={loadStepsFor && (() => loadStepsFor(turn))} />
        </div>
      </div>
    </CollapsedCard>
  );
});

/** A message shown to you that no agent took (shared/inbox.ts Notice: its link's Notify agent is
 *  off, or nothing routed it to one): the same card as an outside message's wake, state "notified",
 *  read-only. Open, it shows the message with its link, and Add to person for a sender with no person. */
const NoticeCard = memo(function NoticeCard({ notice: n }: { notice: Notice }) {
  const m: IntegrationMessage = { adapter: n.adapter, sender: n.sender.name, text: n.text, ...(n.place ? { place: n.place } : {}), ...(n.url ? { url: n.url } : {}) };
  return (
    <IntegrationCard slot="integration-notice" messages={[m]} time={clockOf(n.at)} state="notified">
      <IntegrationMessages messages={[m]} />
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-[11px]" data-slot="notice-footer">
        <span>Notification only. No agent ran.</span>
        {n.sender.externalId && !n.sender.personId && <AddToPersonButton sender={{ adapter: n.sender.adapter, externalId: n.sender.externalId, name: n.sender.name }} />}
      </div>
    </IntegrationCard>
  );
});

/** Re-reads the notices when a new outside message reaches the bell. Its own component, so a
 *  notification never re-renders the chat. */
function NoticeWatch({ onNew }: { onNew: () => void }) {
  const newest = useNotifications().list.find((x) => x.kind === "external_message")?.id;
  const latest = useRef(onNew);
  latest.current = onNew;
  useEffect(() => { if (newest !== undefined) latest.current(); }, [newest]);
  return null;
}

/** `send` replaces the follow-up launch for a conversation that isn't a branch's agent — the
 *  orchestrator's, which goes to its own route. The composer's toolbar always carries the model
 *  picker and the context ring (ChatControls); `controls` supplies their values when they don't come
 *  from the row's card. Everything else — the turns, steps, attachments, worker reports, queued and
 *  sending messages, scrolling, the composer — is the same on every surface. */
// ---- agent rooms (shared/rooms.ts, docs/design/agent-rooms.md) ----

/** What the chat places between its turns by time: a notice, or a room pill. */
type Placed = { id: string; at: number; notice?: Notice; pill?: RoomPill };

const isSeenMap = (v: unknown): v is Record<string, number> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((n) => typeof n === "number");

/** An agent's message to this chat's agent, in a wake that also carried yours: both ends named, the
 *  wrapper (`[from chief]`) stripped. */
function AgentAsk({ text, to, time }: { text: string; to?: Side; time: string }) {
  const from = agentMessageFrom(text);
  return (
    <div data-slot="agent-ask" className="mb-2 rounded-md border px-2.5 py-1.5 text-[12px]">
      <div className="text-muted-foreground mb-0.5 flex items-center gap-1.5 text-[11px]" data-slot="agent-ask-route">
        <Bot className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{from && to ? routeLabel(agentSide(from), to) : "From another agent"}</span>
        <span className="ml-auto shrink-0">{time}</span>
      </div>
      <ChatMarkdown tone="text-foreground" breaks>{stripAgentWrapper(text)}</ChatMarkdown>
    </div>
  );
}

/** Where agents talked, in your chat: "N messages with <agent>", opening the room. A brief's origin —
 *  the words you said that caused it — sits above it in your own lane. */
function RoomPillRow({ pill, unseen, onOpen }: { pill: RoomPill; unseen: boolean; onOpen: () => void }) {
  const peer = sideLabel(pill.peer);
  return (
    <div className="mb-4" data-slot="room-pill-row">
      {pill.person.map((m) => (
        <UserBubble key={m.id} text={m.text ?? ""} files={[]} clamp={longMessage(m.text ?? "")} slot="room-person" textSlot="room-person-text"
          footer={<div className="text-muted-foreground text-right text-[10px]">You · via {peer}</div>} />
      ))}
      <div className="flex justify-center">
        <Button type="button" variant="outline" size="sm" onClick={onOpen} data-slot="room-pill" data-room={pill.room}
          className="h-7 gap-1.5 rounded-full px-3 text-[12px] font-normal">
          <Bot className="size-3.5" aria-hidden />
          {pill.count} message{pill.count === 1 ? "" : "s"} with {peer}
          {unseen && <span data-slot="room-unseen" className="bg-geist-blue size-1.5 rounded-full" aria-label="new" />}
          <ChevronRight className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

export function ChatPanel({ row, send, controls, prefill, outbox, author, size = "panel", autoFocus, mention }: {
  row: Row; send?: (text: string, images: File[]) => Promise<void>; controls?: ChatControlsProps;
  /** The orchestrator's panel only: named agents for the composer's `@` picker. A send with recipient
   *  chips goes to `sendTo` (each chosen agent, only them), never to this chat; `onOpen` is the
   *  receipt's Open. */
  mention?: { agents: AgentMention[]; sendTo: (agents: string[], text: string, images: File[]) => Promise<unknown>; onOpen: (name: string) => void };
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
  const [insert, setInsert] = useState<{ text: string; seq: number; secrets?: string[]; files?: File[] } | null>(null);
  const insertSeq = useRef(0);
  const onQuote = useCallback((text: string) => setInsert({ text: quoteMarkdown(text), seq: ++insertSeq.current }), []);
  const submit = async (text: string, images: File[], recipients: string[] = []) => {
    // Recipient chips: the message goes to those agents only, so it is not drawn in this chat.
    if (mention && recipients.length) { await mention.sendTo(recipients, text, images); return; }
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
  // Inside the window, only the items near the viewport mount (LazyItem). Made once per panel.
  const [lazy] = useState(() => createLazy(() => scroller.current));
  useEffect(() => () => lazy?.disconnect(), [lazy]);
  const seek = useRef(0); // jump-to-latest's smooth scroll in flight (its ticket); a wheel or touch cancels it
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
    void loadRooms();
  };
  // The chat's rooms (shared/rooms.ts): agent-to-agent traffic, read with every fresh page. A failed
  // read keeps the last good list.
  const owner = useMemo(() => chatOwner(row.repo, row.branch), [row.repo, row.branch]);
  const [roomEntries, setRoomEntries] = useState<RoomEntry[]>([]);
  // "loading" until the first answer, then "ok" — or "failed", which keeps every turn in the chat.
  const [roomsState, setRoomsState] = useState<"loading" | "ok" | "failed">("loading");
  const loadRooms = async () => {
    const got = await Promise.resolve().then(() => api.rooms(row.repo, row.branch)).catch(() => null);
    if (got && Array.isArray(got.entries) && !got.dbUnavailable) { setRoomEntries(got.entries); setRoomsState("ok"); }
    else setRoomsState((s) => (s === "loading" ? "failed" : s));
  };
  // A turn leaves your chat only for a room that holds it (or while the rooms load): when the read
  // fails, or the turn is older than what it returned, it stays here. Nothing is lost.
  const roomRuns = useMemo(() => new Set(roomEntries.filter((e) => sameSide(e.chat, owner)).map((e) => e.id)), [roomEntries, owner]);
  const inChat = (t: AgentTurn) => inMainChat(owner, t) || roomsState === "failed" || (roomsState === "ok" && !roomRuns.has(t.id));
  const rooms = useMemo(() => roomsOf(owner, roomEntries), [owner, roomEntries]);
  const pills = useMemo(() => roomEntries.map((e) => entryPill(owner, e)), [roomEntries, owner]);
  // The open room: read only, drawn by the same transcript in this pane, with a Back button.
  const [openRoom, setOpenRoom] = useState<string | null>(null);
  const room = rooms.find((r) => r.id === openRoom);
  const roomLog = useRef<HTMLDivElement>(null);
  // A room opens at its newest message, like the chat.
  useLayoutEffect(() => { if (roomLog.current) roomLog.current.scrollTop = roomLog.current.scrollHeight; }, [room?.id, room?.entries.length]);
  const [seen, setSeen] = usePersisted<Record<string, number>>(persistedKey("roomSeen", `${row.repo}::${row.branch}`), {}, isSeenMap);
  // An open room is read: its newest message marks it seen.
  useEffect(() => {
    if (!room) return;
    if ((seen[room.id] ?? 0) < room.lastAt) setSeen({ ...seen, [room.id]: room.lastAt });
  }, [room, seen, setSeen]);
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
  // The scroller shrinking (the phone's keyboard opening, the composer growing) or its content growing
  // after it rendered (a form card or a handoff pack that loads) must not leave the newest message
  // below the fold: a reader at the tail stays at it (lib/stickToTail).
  useEffect(() => {
    const el = scroller.current;
    return el ? stickToTail(el, () => follow.current) : undefined;
  }, []);
  const jumpToLatest = () => {
    follow.current = true;
    setAtTail(true);
    setUnseen(false);
    if (winRef.current.last !== null) { toTail.current = true; setWin(TAIL_WINDOW); return; } // remount the tail, then go there
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    // Items that mount below the viewport on the way down make the end move: when the smooth scroll
    // stops short of it, finish the jump at once.
    const ticket = ++seek.current;
    const land = () => {
      if (seek.current !== ticket) return;
      seek.current++;
      if (!atBottom(el.scrollTop, el.scrollHeight, el.clientHeight, FOLLOW_SLACK)) el.scrollTo({ top: el.scrollHeight });
    };
    if ("onscrollend" in el) el.addEventListener("scrollend", land, { once: true });
    setTimeout(land, 1000); // no scrollend (Safari), or nothing to scroll
  };
  // The orchestrator's chat only: the notices since the oldest loaded turn (all of them once the
  // first turn is loaded), re-read when a new outside message reaches the bell (NoticeWatch).
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeSince = older ? turns?.[0]?.startedAt ?? Date.now() : 0;
  const loadNotices = useCallback(() => {
    if (outbox) api.inboxNotices(noticeSince).then((r) => setNotices(r.notices), () => {});
  }, [outbox, noticeSince]);
  useEffect(() => { loadNotices(); }, [loadNotices]);
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  // Only the NEWEST read applies: a slow read from before a dispatch must not restore the entry.
  const queuedSeq = useRef(0);
  const loadQueued = () => {
    const seq = ++queuedSeq.current;
    return api.queued(row.repo, row.branch).then((q) => { if (seq === queuedSeq.current) setQueued(q); }).catch(() => {});
  };
  // Cancel puts the message back in the composer as it was sent — the SAME append-after-draft,
  // caret-at-end mechanism as Quote (ChatComposer's `insert`), raw rather than as a blockquote — so a
  // cancelled message is never just lost. Its secret references come back as secret chips, and its
  // files, read back from the bridge as Files, as image and file chips (a send uploads them again).
  // Only once the cancel call itself has succeeded: a failed cancel must leave both the queue and the
  // composer exactly as they were. A file that cannot be read back is left out.
  const onCancelQueued = async (m: QueuedMessage) => {
    try {
      await api.cancelQueued(row.repo, m.id);
    } catch {
      return;
    }
    const { text, refs: secrets } = splitSecretRefs(withoutAttachmentList(m.instruction));
    const read = await Promise.allSettled(attachmentRefs([...m.attachments ?? [], m.instruction].join("\n")).map((f) => api.attachmentFile(f.id, f.name)));
    const files = read.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    setInsert({ text, secrets, files, seq: ++insertSeq.current });
    await loadQueued();
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
  // The composer's `/` menu: every command of this chat's kind; one that does not apply now is greyed out.
  const [modelOpen, setModelOpen] = useState(false);
  const orchestrator = row.repo === ORCHESTRATOR_REPO;
  const slash = useSlashCommands({
    row,
    ctx: {
      orchestrator, compactable: ctl.contextPct !== undefined && compacting === null, running, stoppable: Boolean(row.worktreePath),
      attach: true, queued: pendingQueued.length, previews: !orchestrator && previewsEnabled(row.repo),
      pr: Boolean(row.prNumber) && row.lane !== "DONE", mergeQueued: Boolean(row.mergeWhenGreen || row.autoMergeEnabled),
    },
    onCompact, onStop,
    // Drop, not cancel-and-restore: unlike a queued message's own ✕, the text does not come back.
    onClearQueue: async () => { for (const m of pendingQueued) await api.cancelQueued(row.repo, m.id); await loadQueued(); },
    openModel: () => setModelOpen(true),
  });
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
  const loadStepsFor = useCallback((turn: AgentTurn) => api.turnSteps(row.repo, row.branch, turn.id, 0).then((r) => withoutFinalEcho(r.steps, turn.response)), [row.repo, row.branch]);
  // Each turn carries its source (shared/rooms.ts route: person, agent, worker, Orca); one that is not
  // the person's names its sender over its messages, so your own words are the only unnamed lane.
  const chatTurn = (turn: AgentTurn) => {
    const { sender } = routeOf(owner, turn);
    return <ChatTurn key={turn.id} turn={turn} loadStepsFor={loadStepsFor} compact={(position.get(turn.id) ?? 0) < compactBefore && turn !== newest.answer} newestSaid={turn === newest.said} onQuote={onQuote} author={author} owner={owner}
      source={sender.kind} saidBy={sender.kind === "person" ? undefined : sideLabel(sender)} />;
  };
  // A room's turns: the same transcript, each side named, read only (no Quote, no composer).
  const roomTurn = (e: RoomEntry) => <ChatTurn key={e.id} turn={entryTurn(e) as AgentTurn} owner={owner} source={e.sender.kind}
    saidBy={sideLabel(e.sender)} replyBy={e.reply ? sideLabel(e.recipient) : null} />;
  const openRoomAt = (id: string) => {
    const r = rooms.find((x) => x.id === id);
    if (r) setSeen({ ...seen, [r.id]: Math.max(seen[r.id] ?? 0, r.lastAt) });
    setOpenRoom(id);
  };
  // The orchestrator's chat places notices between the mounted turns, by time: only those inside
  // the window's span, so one never sits beside turns it is not between.
  const noticeFrom = range.start > 0 || older ? shownTurns?.[0]?.startedAt ?? -Infinity : -Infinity;
  const noticeTo = hiddenBelow > 0 ? turns?.[range.end]?.startedAt ?? Infinity : Infinity;
  const renderTurns = (list: AgentTurn[]) => {
    // Notices and room pills are placed between the turns by time, the same way; a run of one room's
    // pills with nothing between becomes one.
    const placed: Placed[] = [...(outbox ? notices : []).map((n) => ({ id: n.id, at: n.at, notice: n })), ...pills.map((p) => ({ id: p.id, at: p.at, pill: p }))];
    const items = mergePills(withNotices(chatItems(list, newest.answer), placed, noticeFrom, noticeTo),
      (it) => (it.kind === "notice" ? it.notice.pill : undefined), (p) => ({ kind: "notice" as const, notice: { id: p.id, at: p.at, pill: p } }));
    // The newest items that fill about one and a half screens mount at once; the rest as they near
    // the viewport. Your newest message and the newest answer are full height (never compact).
    const estimates = items.map((item) => item.kind !== "turn" ? estimateItemHeight(0, { folded: true }) // a collapsed row: worker reports, an outside message, a notice
      : estimateItemHeight((item.turn.instruction?.length ?? 0) + (item.turn.response?.length ?? 0),
        { compact: (position.get(item.turn.id) ?? 0) < compactBefore && item.turn !== newest.answer }));
    const eager = eagerFrom(estimates, 1.5 * (scroller.current?.clientHeight || (typeof window === "undefined" ? 900 : window.innerHeight)));
    let prev: number | undefined;
    return items.map((item, i) => {
      const first = item.kind === "notice" ? { id: `notice:${item.notice.id}`, startedAt: item.notice.at } : item.kind === "agents" ? item.turns[0]! : item.turn;
      const divider = first.startedAt && (prev === undefined || !sameDay(prev, first.startedAt));
      prev = (item.kind === "notice" ? first : item.kind === "agents" ? item.turns[item.turns.length - 1]! : item.turn).startedAt ?? prev;
      return (
        <LazyItem key={first.id} id={first.id} eager={i >= eager} estimate={estimates[i]! + (divider ? 40 : 0)}>
          {divider && (
            <div className="text-muted-foreground my-3 flex items-center gap-3 text-[10px] tracking-widest uppercase" data-slot="chat-day">
              <span className="h-px flex-1 bg-border" /><span>{dayLabel(first.startedAt!)}</span><span className="h-px flex-1 bg-border" />
            </div>
          )}
          {item.kind === "notice" ? (item.notice.pill
              ? <RoomPillRow pill={item.notice.pill} unseen={roomUnseen(item.notice.pill.lastAt, seen[item.notice.pill.room])} onOpen={() => openRoomAt(item.notice.pill!.room)} />
              : <NoticeCard notice={item.notice.notice!} />)
            : item.kind === "turn" ? chatTurn(item.turn)
            : item.kind === "integration" ? <IntegrationBlock turn={item.turn} messages={item.messages} loadStepsFor={loadStepsFor} />
            : item.kind === "fired" ? <FiredBlock turn={item.turn} messages={item.messages} loadStepsFor={loadStepsFor} />
            : <AgentsMarker turns={item.turns} render={chatTurn} />}
        </LazyItem>
      );
    });
  };
  return (
    // log-themed: the page's theme (styles.css remaps the dark palette in light mode).
    <div className="log-themed flex h-full flex-col" data-slot="chat-panel" data-size={size}>
      {outbox && <NoticeWatch onNew={loadNotices} />}
      {room && (
        <div data-slot="room-head" className={cn("flex items-center gap-2 border-b py-1.5", size === "page" ? "px-4 md:px-6" : "px-3")}>
          <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[12px]" data-slot="room-back" onClick={() => setOpenRoom(null)}>
            <ArrowLeft className="size-3.5" aria-hidden />Back
          </Button>
          <span className="min-w-0 truncate text-[12px] font-medium" data-slot="room-title">Messages with {sideLabel(room.peer)}</span>
          <span className="text-muted-foreground ml-auto shrink-0 text-[11px]">{sideLabel(room.peer)} and {sideLabel(owner)} · read only</span>
        </div>
      )}
      {room && (
        <div data-slot="room-log" data-room={room.id} ref={roomLog}
          className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain leading-relaxed ${size === "page" ? "px-4 py-3 md:px-6" : "p-3"} font-sans text-[13px] text-neutral-200 [&_.prose]:text-[13px]`}>
          <DraftContext.Provider value={drafts}>{room.entries.map(roomTurn)}</DraftContext.Provider>
        </div>
      )}
      <div
        ref={scroller}
        hidden={Boolean(room)}
        data-slot="chat-log"
        onScroll={onScroll}
        onWheel={() => { seek.current++; }}
        onTouchStart={() => { seek.current++; }}
        // overscroll-contain: hitting the chat's top or bottom must not hand the gesture to the page —
        // it did, and the page then kept scrolling when you turned back to scroll the chat up.
        // No fill of its own: the log takes the surface of what holds it (docs/design/surfaces.md).
        className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain leading-relaxed ${size === "page" ? "px-4 py-3 md:px-6" : "p-3"} font-sans text-[13px] text-neutral-200 [&_.prose]:text-[13px]`}
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
          : <LazyContext.Provider value={lazy}><DraftContext.Provider value={drafts}>{renderTurns(shownTurns!.filter(inChat))}</DraftContext.Provider></LazyContext.Provider>}
        {hiddenBelow > 0 && (
          <div className="mb-3 flex justify-center" data-slot="chat-newer">
            <button type="button" onClick={() => setWin(revealBelow(turns ?? [], win))} className="rounded-md border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200">
              ↓ {hiddenBelow} newer turn{hiddenBelow === 1 ? "" : "s"}
            </button>
          </div>
        )}
        {/* Not drawn once the real thing has arrived over the stream — the same text twice, one of
            them "sending", is worse than the moment's gap it would cover. The SAME bubble and
            markdown as a sent or queued message (UserBubble), so a list, a link or a line break
            looks identical at every stage. */}
        {unlanded.map((m) => (
          <UserBubble key={m.id} slot="chat-sending" textSlot="chat-sending-text" pending className="mb-4" text={m.text} clamp={false}
            files={m.attachments ?? []}
            footer={<div className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px]">
              <Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />sending…
            </div>} />
        ))}
        {pendingQueued.map((m) => (
          <Queued
            key={m.id}
            message={m}
            onCancel={() => void onCancelQueued(m)}
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
      <div data-slot="chat-composer-dock" hidden={Boolean(room)} className={size === "page" ? "border-t p-4" : cn("border-t p-2", !pip && "max-md:p-3")}>
      <ChatComposer
        className="shadow-none"
        commands={slash.commands}
        top={slash.widget}
        leading={<ChatControls {...ctl} picker={{ open: modelOpen, onOpenChange: setModelOpen }} compact={ctl.contextPct === undefined && compacting === null ? undefined
          : { onCompact, pending: compacting !== null, busy: running, error: compactError }} />}
        persistKey={`orca.chat.${row.repo}::${row.branch}`}
        repo={row.repo}
        insert={insert}
        placeholder={chatPlaceholder(running, row.repo)}
        // ↑/↓: what you sent in THIS chat, from its transcript, queue and outbox — the orchestrator's
        // included (it sends through the outbox, so `row.followUps` never had its messages).
        history={history}
        onSubmit={submit}
        agents={mention?.agents}
        onOpenAgent={mention?.onOpen}
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
          onSubmit: async (text, images, recipients) => {
            await api.stopAgent(row.worktreePath!);
            await submit(text, images, recipients);
            await refresh();
          },
        } : undefined}
      />
      {slash.ui}
      </div>
    </div>
  );
}
