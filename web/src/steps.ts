// How a stored tool step reads in the chat. The bridge records a call as it came in — id, name, the
// whole input — and never a label, so what a tool LOOKS like is decided here, at render time: a new
// tool renders without touching the database, and the same row can be relabelled later. Pure.
import type { AgentStep } from "../../shared/agent";

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
  if (n === 1) return run.kind === "text" || run.kind === "thinking" ? oneLine(run.steps[0]!.text ?? "", 200) : toolLabel(run.steps[0]!);
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

/** The step count a finished turn's summary chip shows: the tool calls and messages, not thinking. */
export const workSteps = (steps: AgentStep[]) => steps.filter((s) => s.kind !== "thinking").length;
