// The conversation with a branch's agent, rendered as a terminal-style log: the durable turns from
// the bridge's store (GET /api/turns) shown in a dark monospace window, with the follow-up composer
// below to send the next message. It is NOT a live shell — it renders the turns Orca already records,
// styled like a terminal. Opened from the card's terminal button (see TerminalDialog); the old
// detail-page Chat tab is gone.
//
// Orca still hosts no chat *runtime* — the composer fires the same headless one-shot every board
// action uses.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Bot } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentStep, AgentTurn } from "../../../shared/agent";
import { api, type QueuedMessage } from "../api";
import { followUp, modelFor, refresh, setCardModel, type Row } from "../store";
import { modelLabel } from "../../../shared/models";
import { TURN_PAGE_SIZE, WORKER_EVENT_MARKER, anchoredScrollTop, asTurnPage, atBottom, dayLabel, isWorkerEvent, mergeLatestPage, prependOlderPage, promptInstruction, sameDay } from "../workstream";
import { toolDetail, toolLabel } from "../steps";
import { agentLabel, groupSteps, withoutFinalEcho } from "../../../shared/agent";
import { ChatComposer } from "@/components/ChatComposer";
import { subscribeTurns } from "@/lib/events";
import { ChatControls, type ChatControlsProps } from "@/components/ChatControls";
import type { OrchestratorPrefill } from "@/lib/atoms";

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

/** Markdown inside the terminal-styled log: prose spacing and readable lists, but sized and coloured
 *  to sit in the dark window rather than looking like a pasted document. */
const ChatMarkdown = ({ children }: { children: string }) => (
  // wrap-anywhere: the agent's prose is full of unbreakable tokens (`branch/names-with-hashes`,
  // paths, run ids) that are wider than a narrow window, and one of them made the whole log scroll
  // sideways. Code BLOCKS are exempt — they keep their lines and scroll inside themselves.
  <div className="prose prose-invert prose-sm max-w-none wrap-anywhere text-neutral-300 prose-pre:wrap-normal
    prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 prose-headings:text-neutral-200
    prose-li:my-0.5 prose-ul:my-1 prose-ol:my-1
    prose-code:text-sky-300 prose-code:before:content-none prose-code:after:content-none
    prose-pre:bg-neutral-900 prose-pre:text-[11px] prose-a:text-sky-400">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
  </div>
);

/** One recorded step of the agent's run. Text reads as the agent talking; thinking is dimmed and
 *  italic; a tool call is a collapsed `⏵ Running: bun test` that expands to its full input and
 *  output. Collapsed-by-default is what keeps a 200-step run readable — the CLI does the same. The
 *  one exception is a call still in flight on a live run: it's open while its input is what there is
 *  to watch, and folds itself the moment its result lands. A click overrides either way. */
function Step({ step, live }: { step: AgentStep; live: boolean }) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (live && !step.done);
  // The agent's narration is prose — headings, lists, the occasional table — and reading a scoping
  // report in a monospace block is miserable. Tool output below stays monospace, because that one
  // genuinely is terminal output.
  if (step.kind === "text") return <ChatMarkdown>{step.text ?? ""}</ChatMarkdown>;
  if (step.kind === "thinking") return <div className="italic opacity-70"><ChatMarkdown>{step.text ?? ""}</ChatMarkdown></div>;
  // A tool call carries its own result (see groupSteps), so EVERYTHING it produced is behind this
  // one toggle — input and output. Nothing spills into the log unopened; the narration above is the
  // readable thread, and a tool's detail is there when you want it.
  const body = [toolDetail(step), step.output].filter(Boolean).join("\n\n");
  return (
    <div>
      <button
        type="button"
        onClick={() => setToggled(!open)}
        disabled={!body}
        className={`flex w-full gap-1.5 text-left ${step.isError ? "text-red-400" : "text-sky-400"} ${body ? "hover:text-sky-300" : "cursor-default"}`}
      >
        <span className="shrink-0 select-none">{body ? (open ? "⏷" : "⏵") : "·"}</span>
        <span className="min-w-0 break-words">{toolLabel(step)}{live && !step.done ? "…" : ""}</span>
      </button>
      {open && body && (
        <pre className="ml-4 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border-l border-neutral-800 pl-2 text-[11px] text-neutral-500">{body}</pre>
      )}
    </div>
  );
}

/** The agent's recorded steps for a turn. Shown in FULL while the run is live — that's the terminal
 *  feel, watching it work — and folded to a `⏵ 127 steps` line once it has answered: the answer is
 *  what a finished turn is about, and a long run's trail belongs behind a toggle until you go looking
 *  for how it got there. (It was open by default once; with a hundred-step run above every answer,
 *  the conversation was unreadable.) */
function Steps({ steps: raw, live, load }: { steps: AgentStep[]; live: boolean; load?: () => Promise<AgentStep[]> }) {
  const [open, setOpen] = useState(false);
  // An older turn arrives without its steps (the bridge sends them for the newest turns only);
  // they are fetched the first time it is unfolded.
  const [fetched, setFetched] = useState<AgentStep[] | null>(null);
  const steps = groupSteps(fetched ?? raw); // fold each tool result into its call — one toggle per tool use
  if (!steps.length && !load) return null;
  if (!steps.length && load && !fetched) {
    return (
      <div className="mb-1.5">
        <button type="button" onClick={() => { void load().then((s) => { setFetched(s); setOpen(true); }); }} className="text-[10px] tracking-widest text-neutral-500 uppercase hover:text-neutral-300">⏵ steps</button>
      </div>
    );
  }
  const body = <div className="space-y-1">{steps.map((s, i) => <Step key={i} step={s} live={live} />)}</div>;
  if (live) return body;
  return (
    <div className="mb-1.5">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-[10px] tracking-widest text-neutral-500 uppercase hover:text-neutral-300">
        {open ? "⏷" : "⏵"} {steps.length} step{steps.length === 1 ? "" : "s"}
      </button>
      {open && <div className="mt-1 border-l border-neutral-800 pl-2">{body}</div>}
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
    <ul className="space-y-0.5">
      {items.map((v, i) => <li key={i} className="break-words">· {v}</li>)}
    </ul>
  </div>
);

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
    <div className="mb-3 opacity-60">
      <div className="flex gap-2 text-emerald-400">
        <span className="shrink-0 select-none">❯</span>
        <span className="min-w-0 whitespace-pre-wrap break-words">{message.instruction}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-4 text-[10px] tracking-widest text-neutral-500 uppercase">
        <span>queued — sends when the current run finishes</span>
        <button type="button" onClick={onCancel} className="tracking-normal text-neutral-400 normal-case hover:text-red-400">cancel</button>
      </div>
    </div>
  );
}

/** The orchestrator's wake messages that were worker reports, not something you typed: each shown
 *  as one muted system line (what finished, how), with the full report behind a toggle. Only when
 *  EVERY part of the instruction is a report — a wake that also carried your message stays a prompt. */
function WorkerReports({ instruction }: { instruction: string }) {
  const parts = instruction.split("\n\n");
  return (
    <div data-slot="worker-reports" className="space-y-0.5 text-neutral-500">
      {parts.map((part, i) => (
        <details key={i}>
          <summary className="cursor-pointer select-none">⚙ {part.split("\n")[0]!.slice(WORKER_EVENT_MARKER.length).trim()}</summary>
          <pre className="mt-1 ml-4 whitespace-pre-wrap break-words text-neutral-600">{part.split("\n").slice(1).join("\n")}</pre>
        </details>
      ))}
    </div>
  );
}

/** One exchange: the instruction shown as a shell command (`❯ …`), the agent's output below it. */
const stampOf = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");

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

/** The agent's side of a turn — live steps and the cursor while it runs; folded steps, the output and
 *  Orca's check once it has answered. Shared by both stylings. */
function Reply({ turn, loadSteps }: { turn: AgentTurn; loadSteps?: () => Promise<AgentStep[]> }) {
  // A turn is written at launch, so an interrupted run (bridge restart, kill) stays visible as an
  // unfinished exchange rather than vanishing.
  if (!turn.finishedAt) {
    return (
      <div className="space-y-1 text-neutral-500">
        {/* The run's steps as they land — this is the live view. A turn with none yet (a non-claude
            provider, or the first seconds) still shows the cursor. */}
        <Steps steps={turn.steps ?? []} live />
        <span>▋ working…</span>
      </div>
    );
  }
  return (
    <>
      {/* The final message is the turn's response, rendered by Output — not twice. */}
      <Steps steps={withoutFinalEcho(turn.steps ?? [], turn.response)} live={false} load={turn.steps ? undefined : loadSteps} />
      <Output turn={turn} />
      {turn.check && <CheckVerdict check={turn.check} />}
    </>
  );
}

const clockOf = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "");

/** The "chat" styling (the orchestrator's panel): a modern assistant chat rather than a terminal log.
 *  What you said is a tinted bubble on the right; the orchestrator answers on the left under its
 *  name, in readable prose; its tool steps and worker reports stay folded; the time shows on hover
 *  (and days are grouped by the divider ChatPanel draws). Colours are the theme's tokens, so it
 *  follows light and dark like the rest of the console. */
function ChatTurn({ turn, loadSteps }: { turn: AgentTurn; loadSteps?: () => Promise<AgentStep[]> }) {
  const instruction = turn.instruction ?? promptInstruction(turn.prompt);
  const reports = instruction.split("\n\n").every(isWorkerEvent);
  const time = clockOf(turn.startedAt);
  return (
    <div className="mb-4" data-slot="chat-turn" data-failed={turn.failed || undefined} data-style="chat">
      {reports ? (
        // Worker reports that woke it: a compact, folded system line — not something you said.
        <div className="mb-2 text-[11px]"><WorkerReports instruction={instruction} /></div>
      ) : (
        <div className="group mb-2 flex justify-end" data-slot="chat-user">
          <div className="max-w-[85%]">
            <div className="bg-accent text-foreground rounded-lg px-3 py-2 whitespace-pre-wrap break-words">{instruction}</div>
            <div className="text-muted-foreground mt-0.5 text-right text-[10px] opacity-0 transition-opacity group-hover:opacity-100" data-slot="turn-time">{time}</div>
          </div>
        </div>
      )}
      <div className="group flex gap-2" data-slot="chat-reply">
        <span className="bg-accent text-foreground mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full" aria-hidden="true"><Bot className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-muted-foreground mb-0.5 flex items-baseline gap-2 text-[11px]">
            <span className="text-foreground font-medium">Orchestrator</span>
            {turn.failed ? <span className="text-red-400">failed</span> : turn.stopped ? <span className="text-amber-400">stopped by you</span> : null}
            <span className="opacity-0 transition-opacity group-hover:opacity-100" data-slot="turn-time">{clockOf(turn.finishedAt) || time}</span>
          </div>
          <Reply turn={turn} loadSteps={loadSteps} />
        </div>
      </div>
    </div>
  );
}

/** `stamped`: the Agent page's log mode — a time gutter, and failed / warned turns tinted the way
 *  Vercel tints error and warning lines in Build Logs. */
function Turn({ turn, loadSteps, stamped }: { turn: AgentTurn; loadSteps?: () => Promise<AgentStep[]>; stamped?: boolean }) {
  const instruction = turn.instruction ?? promptInstruction(turn.prompt);
  const tint = !stamped ? "" : turn.failed ? "bg-red-500/10 -mx-3 px-3" : turn.stopped || (turn.check && !turn.check.ok) ? "bg-amber-500/10 -mx-3 px-3" : "";
  const body = (
    <div className={`mb-3 ${tint}`} data-slot="chat-turn" data-failed={turn.failed || undefined}>
      {instruction.split("\n\n").every(isWorkerEvent) ? <WorkerReports instruction={instruction} /> : (
        <div className="flex gap-2 text-emerald-400">
          <span className="shrink-0 select-none">❯</span>
          {/* What you typed, recorded with the turn. Turns from before that was stored fall back to
              trimming the scaffolding off the prompt by its known marker lines. */}
          <span className="min-w-0 whitespace-pre-wrap break-words">{instruction}</span>
        </div>
      )}
      <div className="mt-1 pl-4">
        <div className="text-[10px] tracking-widest text-neutral-500 uppercase">
          {agentLabel(turn.provider)}{turn.failed ? " · failed" : turn.stopped ? " · stopped by you" : ""}
        </div>
        <Reply turn={turn} loadSteps={loadSteps} />
      </div>
    </div>
  );
  if (!stamped) return body;
  return (
    <div className="flex gap-3">
      <span className="w-16 shrink-0 pt-px text-neutral-500 tabular-nums select-none" data-slot="turn-time">{stampOf(turn.startedAt)}</span>
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  );
}

/** The Agent page's Chat tab reads smaller than the modal's terminal: your messages at 11px mono and
 *  the agent's replies (prose, which is 14px at prose-sm) at 12px. */
const LOG_TEXT = "font-mono text-[11px] [&_.prose]:text-[12px]";

/** `send` replaces the follow-up launch for a conversation that isn't a branch's agent — the
 *  orchestrator's, which goes to its own route. `flush` is for a host that IS the window (the
 *  orchestrator's popout): the log runs edge to edge with no frame of its own, and the composer sits
 *  on the SAME terminal background, so the window reads as one surface rather than a log with a
 *  differently coloured strip under it. The composer's toolbar always carries the model picker and
 *  the context ring (ChatControls); `controls` supplies their values when they don't come from the
 *  row's card. Everything else about the panel is the same. */
export function ChatPanel({ row, send, flush, controls, logBar, prefill, variant = "terminal" }: {
  row: Row; send?: (text: string, images: File[]) => Promise<void>; flush?: boolean; controls?: ChatControlsProps;
  /** "terminal" (default): the dark monospace log. "chat": the orchestrator panel's assistant-chat
   *  styling — bubbles, prose, day dividers, hover timestamps — in the page's theme (see ChatTurn). */
  variant?: "terminal" | "chat";
  /** Text for the composer from outside it (the orchestrator's entry) — see ChatComposer. */
  prefill?: OrchestratorPrefill | null;
  /** The Agent page's Chat tab: a slim toolbar (working indicator, error / warning counters, Find
   *  in chat) instead of a card header, and timestamped, tinted turns. */
  logBar?: boolean;
}) {
  const deliver = send ?? ((text: string, images: File[]) => followUp(row, text, images));
  // Messages on their way to the bridge. Sending one launches an agent — an upload, a worktree
  // lookup, the board snapshot the orchestrator is handed — which takes seconds, and a log that
  // shows nothing until then reads as "it didn't go". So the message is drawn at once and replaced
  // by the real turn (or queued entry) when the bridge answers; on failure it is withdrawn and the
  // composer puts the text back.
  const [sending, setSending] = useState<{ id: number; text: string }[]>([]);
  const sendSeq = useRef(0);
  const submit = async (text: string, images: File[]) => {
    const id = ++sendSeq.current;
    follow.current = true; // you just spoke: jump to it, wherever you had scrolled
    setSending((s) => [...s, { id, text }]);
    try {
      await deliver(text, images);
      await loadLatest();
      await loadQueued(); // it may have been held rather than launched
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
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true); // at the bottom → keep following; scrolled up → leave the reader be
  const [atTail, setAtTail] = useState(true); // `follow`, as state, for the jump-to-latest button
  const [unseen, setUnseen] = useState(false); // something arrived below while you were scrolled up
  const turnsRef = useRef<AgentTurn[] | null>(null); // read by the tail without re-arming it
  const olderRef = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);
  const anchor = useRef<{ top: number; height: number } | null>(null); // scroll position to restore after a prepend
  const cursors = useRef(new Map<string, number>()); // per-run high-water mark, for reconnect catch-up
  const running = row.agentStatus === "running";
  /** (Re)fetch the newest page. What was already loaded above it stays; a turn the page re-delivers
   *  (now finished) takes its fresh form. The first fetch also sets where the older pages start. */
  const loadLatest = async () => {
    // asTurnPage again at the render boundary: whatever answered (an older bridge sends an array),
    // nothing undefined reaches `turns`, which must be null (loading) or a list.
    const page = await api.turnPage(row.repo, row.branch, { limit: TURN_PAGE_SIZE }).then(asTurnPage<AgentTurn>).catch(() => null);
    if (!page) return;
    const had = turnsRef.current;
    if (!had || !had.length) { olderRef.current = page.older; setOlder(page.older); }
    setTurns(had ? mergeLatestPage(had, page.turns) : page.turns);
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
    } catch { /* the affordance stays; a scroll or click tries again */ } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };
  // Content was added ABOVE the viewport: move the scroller by the same amount, so the turn you were
  // reading doesn't jump. Layout effect: before the browser paints the shifted content.
  useLayoutEffect(() => {
    const a = anchor.current, el = scroller.current;
    if (!a || !el) return;
    anchor.current = null;
    el.scrollTop = anchoredScrollTop(a.top, a.height, el.scrollHeight);
  }, [turns]);

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
        setTurns((prev) => prev?.map((t) => (t.id === runId ? { ...t, steps: [...(t.steps ?? []), ...steps] } : t)) ?? prev);
      },
      // We were disconnected (or the tab was hidden), so catch up from the cursor — anything
      // recorded while we were away would otherwise be silently missing.
      resync: () => void (async () => {
        const pending = turnsRef.current?.find((t) => !t.finishedAt);
        if (!pending) return void load();
        try {
          const cursor = cursors.current.get(pending.id) ?? pending.stepSeq ?? 0;
          const { steps, seq, finished } = await api.turnSteps(row.repo, row.branch, pending.id, cursor);
          if (!live) return;
          if (steps.length) {
            cursors.current.set(pending.id, seq);
            setTurns((prev) => prev?.map((t) => (t.id === pending.id ? { ...t, steps: [...(t.steps ?? []), ...steps] } : t)) ?? prev);
          }
          if (finished) await load();
        } catch { void load(); }
      })(),
    });
    return () => { live = false; unsubscribe(); };
  }, [row.repo, row.branch]);

  useEffect(() => { turnsRef.current = turns; }, [turns]);

  // Follow the tail as output arrives, the way a terminal does — but only while the reader is AT the
  // bottom. Scrolling up to read something is an intent to stay there (a stream of steps yanking you
  // back down mid-read is the worst version of this), and returning to the bottom resumes following.
  // Keyed on `turns` itself, not its length, so appended steps scroll too.
  // Not following (you scrolled up to read): nothing moves, and a jump-to-latest button appears once
  // something new has arrived below. An older page landing above is not "new".
  useEffect(() => {
    if (follow.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    else if (!anchor.current && !loadingOlderRef.current) setUnseen(true);
  }, [turns, sending]);
  const jumpToLatest = () => {
    follow.current = true;
    setAtTail(true);
    setUnseen(false);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  };
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const loadQueued = () => api.queued(row.repo, row.branch).then(setQueued).catch(() => {});
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
  // Has the bridge already recorded this message — as the turn now running, or a queued entry?
  // (startsWith: attachments are appended to the instruction after the text.)
  const landed = (text: string) =>
    Boolean(turns?.some((t) => !t.finishedAt && t.instruction?.startsWith(text))) || queued.some((m) => m.instruction.startsWith(text));
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const tail = atBottom(el.scrollTop, el.scrollHeight, el.clientHeight, FOLLOW_SLACK);
    follow.current = tail;
    if (tail !== atTail) setAtTail(tail);
    if (tail) setUnseen(false);
    // Near the top with more history behind: fetch the next page before you hit the edge.
    if (el.scrollTop < OLDER_THRESHOLD && olderRef.current) void loadOlder();
  };

  // Compact is offered once the ring has a reading: only a Claude session reports one, and only a
  // Claude session can be compacted.
  const ctl = controls ?? {
    model: modelFor(row), onModel: (m: string) => setCardModel(row, m), ran: row.agentMeta?.model, contextPct: row.agentMeta?.contextPct,
  };
  const chatStyle = variant === "chat";
  const renderTurn = (turn: AgentTurn, i: number, list: AgentTurn[]) => {
    const loadSteps = () => api.turnSteps(row.repo, row.branch, turn.id, 0).then((r) => withoutFinalEcho(r.steps, turn.response));
    if (!chatStyle) return <Turn key={turn.id} turn={turn} stamped={logBar} loadSteps={loadSteps} />;
    const prev = i > 0 ? list[i - 1]!.startedAt : undefined;
    const divider = turn.startedAt && (prev === undefined || !sameDay(prev, turn.startedAt));
    return (
      <div key={turn.id}>
        {divider && (
          <div className="text-muted-foreground my-3 flex items-center gap-3 text-[10px] tracking-widest uppercase" data-slot="chat-day">
            <span className="h-px flex-1 bg-border" /><span>{dayLabel(turn.startedAt!)}</span><span className="h-px flex-1 bg-border" />
          </div>
        )}
        <ChatTurn turn={turn} loadSteps={loadSteps} />
      </div>
    );
  };
  return (
    <div className={`flex h-full flex-col ${flush || logBar ? "" : "gap-3"} ${logBar || chatStyle ? "log-themed" : ""}`} data-variant={variant}>
      <div
        ref={scroller}
        onScroll={onScroll}
        className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-neutral-950 leading-relaxed ${logBar ? "px-4 py-3 md:px-6" : "p-3"} text-neutral-200 ${chatStyle ? "font-sans text-[13px] [&_.prose]:text-[13px]" : logBar ? LOG_TEXT : "font-mono text-xs"} ${flush || logBar ? "" : "rounded-md border border-neutral-800"}`}
      >
        {running && (
          <div className="sticky top-0 z-10 -mt-1 mb-2 flex justify-end">
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              className="rounded border border-amber-800 bg-neutral-950/90 px-2 py-0.5 text-[11px] text-amber-400 hover:border-amber-600 hover:text-amber-300 disabled:opacity-50"
              title="Interrupt this run. The worktree, its commits, and the session are kept — reply below to redirect it."
            >
              {stopping ? "stopping…" : "■ stop"}
            </button>
          </div>
        )}
        {/* Earlier pages: fetched as you near the top, or on a click (a page shorter than the window
            can't be scrolled). A skeleton while the page is in flight. */}
        {turns !== null && older && (
          <div className="mb-3 flex justify-center" data-slot="chat-older">
            {loadingOlder ? <ChatSkeleton rows={2} /> : (
              <button type="button" onClick={() => void loadOlder()} className="rounded-md border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200">
                ↑ earlier turns
              </button>
            )}
          </div>
        )}
        {turns === null ? <ChatSkeleton rows={4} />
          : turns.length === 0 ? <p className="text-neutral-500">No history yet for <span className="text-neutral-300">{row.branch}</span>. Send a message below to start.</p>
          : turns.map(renderTurn)}
        {/* Not drawn once the real thing has arrived over the stream — the same text twice, one of
            them "sending", is worse than the moment's gap it would cover. */}
        {sending.filter((m) => !landed(m.text)).map((m) => chatStyle ? (
          <div key={m.id} className="mb-4" data-slot="chat-sending">
            <div className="mb-2 flex justify-end"><div className="bg-accent text-foreground max-w-[85%] rounded-lg px-3 py-2 whitespace-pre-wrap break-words opacity-70">{m.text}</div></div>
            <div className="text-muted-foreground pl-8 text-[11px]">▋ sending…</div>
          </div>
        ) : (
          <div key={m.id} className="mb-3" data-slot="chat-sending">
            <div className="flex gap-2 text-emerald-400">
              <span className="shrink-0 select-none">❯</span>
              <span className="min-w-0 whitespace-pre-wrap break-words">{m.text}</span>
            </div>
            <div className="mt-1 pl-4 text-neutral-500">▋ sending…</div>
          </div>
        ))}
        {queued.map((m) => (
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
              className={`pointer-events-auto flex items-center gap-1 rounded-full border border-neutral-800 bg-neutral-900 px-2.5 py-1 font-sans text-[11px] shadow-menu hover:text-neutral-100 ${unseen ? "text-sky-400" : "text-neutral-400"}`}>
              <ArrowDown className="size-3" />{unseen ? "New messages" : "Jump to latest"}
            </button>
          </div>
        )}
      </div>
      {/* `dark` scopes the theme tokens: the composer's text and border must read on the terminal
          background whatever the page's theme is. */}
      <div className={chatStyle ? "border-t p-2" : flush ? "dark text-foreground bg-neutral-950 p-2 pt-0" : logBar ? "border-t p-4" : undefined}>
      <ChatComposer
        className={chatStyle ? "shadow-none" : flush ? "border-neutral-800 bg-neutral-950 shadow-none" : undefined}
        leading={<ChatControls {...ctl} compact={ctl.contextPct === undefined && compacting === null ? undefined
          : { onCompact, pending: compacting !== null, busy: running, error: compactError }} />}
        persistKey={`orca.chat.${row.repo}::${row.branch}`}
        repo={row.repo}
        placeholder={running ? "The agent is working — queue the next instruction…" : `Reply to ${modelLabel(modelFor(row))}…`}
        history={row.followUps}
        onSubmit={submit}
        prefill={prefill}
        // The Chat tab's own panel only ever mounts while that tab is active (Radix unmounts the
        // others), so focusing on mount covers opening it by click, by route, or via a
        // notification's `?reply` — one condition, not three.
        autoFocus={logBar}
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
