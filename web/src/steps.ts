// How a stored tool step reads in the chat. The bridge records a call as it came in — id, name, the
// whole input — and never a label, so what a tool LOOKS like is decided here, at render time: a new
// tool renders without touching the database, and the same row can be relabelled later. Pure.
import type { AgentStep } from "../../shared/agent";
import { formatDuration } from "./workstream";

const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** The one-line summary a tool call shows collapsed: `Running: bun test`, `Editing foo.ts`. Covers
 *  Claude's tools, Codex's item types, and Cursor's `*ToolCall` names; anything unknown falls back to
 *  the tool name plus whatever looks like its subject. */
export function toolLabel(step: AgentStep): string {
  if (step.text) return step.text; // rows written before content parts carried a pre-rendered label
  const i = (step.input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === "string" && (i[k] as string).trim() ? (i[k] as string) : undefined);
  const file = (s("file_path") ?? s("path") ?? s("filePath"))?.split("/").pop();
  const command = s("command");
  const query = s("query") ?? s("pattern");
  switch (step.name) {
    case "Read": case "readFile": return file ? `Reading ${file}` : "Reading a file";
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": case "file_change": case "editFile": case "writeFile":
      return file ? `Editing ${file}` : "Editing a file";
    case "Bash": case "command_execution": case "shell": return command ? `Running: ${oneLine(command, 120)}` : "Running a command";
    case "Grep": return query ? `Searching for ${oneLine(query, 60)}` : "Searching";
    case "Glob": return "Finding files";
    case "Task": return "Delegating to a subagent";
    case "WebFetch": case "WebSearch": case "web_search": return `Searching the web${query ? `: ${oneLine(query, 60)}` : ""}`;
    case "mcp_tool_call": return `Using ${s("tool") ?? "an MCP tool"}`;
    default: {
      const subject = command ?? file ?? query;
      return subject ? `${step.name}: ${oneLine(subject, 120)}` : `Using ${step.name ?? "a tool"}`;
    }
  }
}

/** The call's full input for the expanded view. A command reads best bare; anything else as JSON, so
 *  an Edit's old/new strings or an MCP call's arguments are all there — that's what the row stores. */
export function toolDetail(step: AgentStep): string | undefined {
  if (step.detail) return step.detail; // rows written before `input` was kept
  if (step.input === undefined || step.input === null) return undefined;
  if (typeof step.input === "string") return step.input;
  const i = step.input as Record<string, unknown>;
  const keys = Object.keys(i);
  if (keys.length === 1 && typeof i[keys[0]!] === "string") return i[keys[0]!] as string;
  return keys.length ? JSON.stringify(i, null, 2) : undefined;
}

/** What sort of work a step is, for the live activity block's counts and grouping. Unknown tools get
 *  their own kind per name, so two different MCP tools never merge into one run. */
export type StepKind = "command" | "read" | "edit" | "search" | "web" | "agent" | "text" | "thinking" | `tool:${string}`;
export function stepKind(step: AgentStep): StepKind {
  if (step.kind === "text") return "text";
  if (step.kind === "thinking") return "thinking";
  switch (step.name) {
    case "Bash": case "command_execution": case "shell": return "command";
    case "Read": case "readFile": return "read";
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": case "file_change": case "editFile": case "writeFile": return "edit";
    case "Grep": case "Glob": return "search";
    case "WebFetch": case "WebSearch": case "web_search": return "web";
    case "Task": return "agent";
    default: return `tool:${step.name ?? "tool"}`;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A run of consecutive same-kind steps (`Read` ×3), as the activity block lists them. Text and
 *  thinking never merge: each is its own message. */
export type StepRun = { kind: StepKind; steps: AgentStep[] };
export function stepRuns(steps: AgentStep[]): StepRun[] {
  const runs: StepRun[] = [];
  for (const step of steps) {
    const kind = stepKind(step);
    const last = runs.at(-1);
    if (last && last.kind === kind && kind !== "text" && kind !== "thinking") last.steps.push(step);
    else runs.push({ kind, steps: [step] });
  }
  return runs;
}

/** One line for a run: a single step reads as its own label (`Reading notes.md`); several read as a
 *  count (`Read 3 files`, `Ran 2 commands`). */
export function runLabel(run: StepRun): string {
  const n = run.steps.length;
  if (n === 1) return run.kind === "text" || run.kind === "thinking" ? oneLine(plainText(run.steps[0]!.text ?? ""), 200) : toolLabel(run.steps[0]!);
  switch (run.kind) {
    case "command": return `Ran ${plural(n, "command")}`;
    case "read": return `Read ${plural(n, "file")}`;
    case "edit": return `Edited ${plural(n, "file")}`;
    case "search": return `Searched ${plural(n, "time")}`;
    case "web": return `Searched the web ${plural(n, "time")}`;
    case "agent": return `Delegated to ${plural(n, "subagent")}`;
    default: return `${run.steps[0]!.name ?? "tool"} ×${n}`;
  }
}

/** The count line under the live header: `6 commands, 3 files read, 2 searches`. Tool calls only,
 *  in a fixed order so the line doesn't reshuffle as steps land. Empty when no tool has run. */
export function activityCounts(steps: AgentStep[]): string {
  const n = new Map<string, number>();
  for (const s of steps) {
    if (s.kind !== "tool") continue;
    const k = stepKind(s);
    const key = k.startsWith("tool:") ? "other" : k;
    n.set(key, (n.get(key) ?? 0) + 1);
  }
  const parts: [string, (c: number) => string][] = [
    ["command", (c) => plural(c, "command")],
    ["read", (c) => `${plural(c, "file")} read`],
    ["edit", (c) => `${plural(c, "edit")}`],
    ["search", (c) => plural(c, "search", "searches")],
    ["web", (c) => plural(c, "web search", "web searches")],
    ["agent", (c) => plural(c, "subagent")],
    ["other", (c) => plural(c, "other tool")],
  ];
  return parts.filter(([k]) => n.has(k)).map(([k, f]) => f(n.get(k)!)).join(", ");
}

/** The call in progress: the NEWEST tool call with no result yet — not merely the last step, which
 *  can be a message written while a call runs, or a parallel call that already returned. */
export function stepInFlight(steps: AgentStep[]): AgentStep | undefined {
  return steps.findLast((s) => s.kind === "tool" && !s.done);
}

/** The live header's verb: the call in progress (`Running: orca board`), else `Thinking`. */
export function currentActivity(steps: AgentStep[]): string {
  const step = stepInFlight(steps);
  return step ? toolLabel(step) : "Thinking";
}

/** A stable key for one call across renders (groupSteps copies its steps each time): its id, else
 *  when it started and what it is. */
export const stepKey = (step: AgentStep) => step.id ?? `${step.at}:${step.name ?? step.kind}`;

/** The shortest duration a row shows (ms). A result that lands in the same batch as its call
 *  reads as near zero, which says nothing. */
export const MIN_DURATION_MS = 100;

/** One tool call as a row of the EXPANDED list — the real call, never a run's summary: a command as
 *  its own text (shown monospace), a read or an edit by its file name, anything else by its label.
 *  `status` is `running` only while the turn is live; `ms` only once its result landed, and only from MIN_DURATION_MS up. */
export type StepStatus = "running" | "done" | "failed";
export type StepRowView = { verb?: string; text: string; mono: boolean; status: StepStatus; ms?: number };
export function stepRow(step: AgentStep, live: boolean): StepRowView {
  const i = (step.input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === "string" && (i[k] as string).trim() ? (i[k] as string) : undefined);
  const status: StepStatus = step.isError ? "failed" : !step.done && live ? "running" : "done";
  const took = step.done && step.doneAt !== undefined ? step.doneAt - step.at : undefined;
  const ms = took !== undefined && took >= MIN_DURATION_MS ? took : undefined; // under it the row read `0.0s`
  const file = (s("file_path") ?? s("path") ?? s("filePath"))?.split("/").pop();
  const kind = step.text ? undefined : stepKind(step); // a pre-rendered label row keeps its label
  if (kind === "command" && s("command")) return { text: oneLine(s("command")!, 500), mono: true, status, ms };
  if ((kind === "read" || kind === "edit") && file) return { verb: kind === "read" ? "Read" : "Edit", text: file, mono: true, status, ms };
  return { text: toolLabel(step), mono: false, status, ms };
}

/** A call's duration on its row: tenths under a second (a fast command is not `0s`), else as the
 *  timer reads. */
export const stepDuration = (ms: number) => (ms < 1000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms));

/** How long the live header holds what it shows before it may switch (ms). Fast commands made the
 *  label flick between `Running: …` and `Thinking` several times a second. */
export const HOLD_MS = 400;

/** What the header shows and since when. */
export type Held<T> = { shown: T; since: number };

/** The hold-before-switch decision. A new value replaces the shown one only once the shown one has
 *  been up for `minMs`; before that the shown one stays and `wakeIn` says when to ask again — with
 *  the NEWEST wanted value then, so a value that came and went inside the hold never shows. Pure. */
export function holdNext<T>(state: Held<T>, want: T, now: number, minMs = HOLD_MS): { state: Held<T>; wakeIn?: number } {
  if (Object.is(want, state.shown)) return { state };
  const up = now - state.since;
  if (up >= minMs) return { state: { shown: want, since: now } };
  return { state, wakeIn: minMs - up };
}

export type HoldClock = { now: () => number; set: (f: () => void, ms: number) => unknown; clear: (t: unknown) => void };
const realClock: HoldClock = { now: () => Date.now(), set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };

/** `holdNext` with its one timer: `want(v)` on every change, `onShow` when the shown value switches.
 *  The clock is injected so a test drives it with fake time. */
export function createHold<T>(initial: T, onShow: (v: T) => void, minMs = HOLD_MS, clock: HoldClock = realClock) {
  let state: Held<T> = { shown: initial, since: clock.now() };
  let wanted = initial;
  let timer: unknown;
  const step = () => {
    timer = undefined;
    const next = holdNext(state, wanted, clock.now(), minMs);
    const changed = !Object.is(next.state.shown, state.shown);
    state = next.state;
    if (next.wakeIn !== undefined) timer = clock.set(step, next.wakeIn);
    if (changed) onShow(state.shown);
  };
  return {
    want(v: T) { wanted = v; if (timer === undefined) step(); }, // a pending wake reads the newest `wanted`
    stop() { if (timer !== undefined) clock.clear(timer); timer = undefined; },
    get shown() { return state.shown; },
  };
}

/** The step count a finished turn's summary chip shows: the tool calls and messages, not thinking. */
export const workSteps = (steps: AgentStep[]) => steps.filter((s) => s.kind !== "thinking").length;

/** A finished turn's summary chip: `Worked for 1m 12s · 9 steps`. The steps part only when there is a
 *  count — an older turn arrives without its steps, and `0 steps` or a bare `steps` says nothing. */
export function workedLabel(ms: number | undefined, steps: number): string {
  const took = ms === undefined ? "Worked" : `Worked for ${formatDuration(ms)}`;
  return steps > 0 ? `${took} · ${steps} step${steps === 1 ? "" : "s"}` : took;
}

/** Streamed markdown, closed so it renders as it will once whole: an open code fence, inline code
 *  span or bold run is closed at the end, and an opener with nothing after it yet is dropped. Without
 *  this, `**bold` shows its asterisks until the closing pair arrives, then flips — a flicker per
 *  delta. A fence keeps its content as code while it streams. Pure. */
export function closeOpenMarkdown(md: string): string {
  const fences = md.match(/^ {0,3}(```|~~~)/gm) ?? [];
  if (fences.length % 2) return /^ {0,3}(```|~~~)[^\n]*$/.test(md.split("\n").at(-1)!) ? md : `${md}\n${fences.at(-1)!.trim()}`;
  // Only the prose after the last closed fence can hold an open inline span.
  const lastFence = md.search(/^ {0,3}(```|~~~)[^\n]*\n?(?![\s\S]*^ {0,3}(```|~~~))/m);
  const head = lastFence >= 0 ? md.slice(0, md.indexOf("\n", lastFence) + 1 || md.length) : "";
  let tail = md.slice(head.length);
  if ((tail.match(/`/g) ?? []).length % 2) {
    tail = tail.endsWith("`") ? tail.slice(0, -1) : `${tail}\``;
  }
  // Bold outside inline code: count `**` pairs with the code spans taken out.
  const bold = (tail.replace(/`[^`]*`/g, "").match(/\*\*/g) ?? []).length;
  if (bold % 2) tail = /\*\*\s*$/.test(tail) ? tail.replace(/\*\*\s*$/, "") : `${tail.trimEnd()}**`;
  return head + tail;
}

/** Markdown as one plain line, for a faded row: headings, list markers, quotes, emphasis, code
 *  marks and fences go; a link keeps its text. Pure. */
export function plainText(md: string): string {
  return md
    .replace(/^ {0,3}(```|~~~).*$/gm, "")          // fence lines
    .replace(/^ {0,3}#{1,6}\s+/gm, "")              // headings
    .replace(/^\s*>\s?/gm, "")                      // quotes
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")      // list markers
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")      // links and images: the text
    .replace(/(\*\*|__)(.+?)\1/g, "$2")             // bold
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2") // italic
    .replace(/`+/g, "")                             // code marks
    .replace(/\*\*|__/g, "")                        // an open bold
    .replace(/\s+/g, " ")
    .trim();
}
