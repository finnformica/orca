// The caveman A/B trial (github.com/JuliusBrussee/caveman, binaries bin-v4.0.1), judged 2026-10-22.
// A repo with `agentProxy: "caveman"` sends its Claude worker runs through the local caveman proxy
// (server/caveman.ts); every other repo is the control. The decisions and the report are pure, here,
// so a test pins them without a proxy or a database.

/** One finished worker run, as the trial log (`~/.orca/trial/caveman.jsonl`) records it. Counts and
 *  sizes only — never a prompt, a response or a secret, like the run ledger. */
export type TrialRow = {
  at: number; // when the run finished (ms)
  repo: string;
  provider: string;
  /** The run went through the caveman proxy. */
  caveman: boolean;
  /** The repo asked for caveman, but this run went direct: why (the proxy did not start, …). */
  fallback?: string;
  status: "done" | "error" | "stopped";
  durationMs?: number;
  inputTokens?: number; // fresh input, not cached
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  model?: string;
  action?: string;
  mode?: string;
  runId?: string;
};

/** The proxy a repo asks for. Only `caveman` exists. */
export type AgentProxy = "caveman";

/** Does this run go through caveman? Only a Claude worker in a repo that opted in: the orchestrator
 *  (its own pointer, never a configured repo) and every other provider stay direct. */
export function wantsCaveman(input: { agentProxy?: AgentProxy; provider: string; repo?: string; orchestratorRepo: string }): boolean {
  return input.agentProxy === "caveman" && input.provider === "claude" && input.repo !== input.orchestratorRepo;
}

/** The instruction of the one direct retry after a caveman run failed for a reason the trial could
 *  have caused. A run that starts with it never queues another (no loop). */
export const CAVEMAN_RETRY_MARKER = "The previous run went through the caveman proxy and failed.";
export const cavemanRetryInstruction = (error: string): string =>
  `${CAVEMAN_RETRY_MARKER} Orca turned the proxy off and runs you direct now. The error was:\n\n${error.slice(0, 300)}\n\nContinue where you left off.`;

/** Text in a failed run that points at the API connection, not at the work. */
const API_FAILURE = /API Error|ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|Unable to connect|connection (?:refused|reset|error)|\b5\d\d\b/i;

/** Should a failed caveman run be retried direct? Yes when the proxy is no longer healthy, or the
 *  error reads like an API connection failure. Never for a stop, a retry, or a run that went direct. */
export function retryDirect(input: { caveman: boolean; ok: boolean; stopped: boolean; instruction?: string; proxyHealthy: boolean; error?: string }): boolean {
  if (!input.caveman || input.ok || input.stopped) return false;
  if (input.instruction?.startsWith(CAVEMAN_RETRY_MARKER)) return false;
  return !input.proxyHealthy || API_FAILURE.test(input.error ?? "");
}

export type ArmSummary = {
  runs: number;
  failed: number;
  failureRate: number; // 0..1
  fallbacks: number;
  inputMedian: number; // all input: fresh + cache read + cache creation
  inputTotal: number;
  freshInputTotal: number;
  outputMedian: number;
  outputTotal: number;
  costTotal: number;
  costMedian: number;
  durationMedianMs: number;
};

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
export const allInput = (r: TrialRow): number => (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheCreationTokens ?? 0);

/** The two arms over [from, to): Claude runs only, so the arms compare one provider. A stopped run is
 *  counted but is not a failure — you stopped it. */
export function summarizeTrial(rows: TrialRow[], range: { from: number; to: number }): { on: ArmSummary; off: ArmSummary } {
  const inRange = rows.filter((r) => r && r.provider === "claude" && r.at >= range.from && r.at < range.to);
  const arm = (list: TrialRow[]): ArmSummary => {
    const failed = list.filter((r) => r.status === "error").length;
    return {
      runs: list.length,
      failed,
      failureRate: list.length ? failed / list.length : 0,
      fallbacks: list.filter((r) => r.fallback).length,
      inputMedian: median(list.map(allInput)),
      inputTotal: sum(list.map(allInput)),
      freshInputTotal: sum(list.map((r) => r.inputTokens ?? 0)),
      outputMedian: median(list.map((r) => r.outputTokens ?? 0)),
      outputTotal: sum(list.map((r) => r.outputTokens ?? 0)),
      costTotal: sum(list.map((r) => r.costUsd ?? 0)),
      costMedian: median(list.map((r) => r.costUsd ?? 0)),
      durationMedianMs: median(list.map((r) => r.durationMs ?? 0)),
    };
  };
  return { on: arm(inRange.filter((r) => r.caveman)), off: arm(inRange.filter((r) => !r.caveman)) };
}

/** The report as plain text, in STE. */
export function renderTrialReport(rows: TrialRow[], range: { from: number; to: number }, startedAt?: number): string {
  const { on, off } = summarizeTrial(rows, range);
  const n = (x: number) => Math.round(x).toLocaleString("en-US");
  const usd = (x: number) => `$${x.toFixed(2)}`;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const min = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
  const lines: [string, (a: ArmSummary) => string][] = [
    ["Runs", (a) => n(a.runs)],
    ["Failed runs", (a) => `${n(a.failed)} (${pct(a.failureRate)})`],
    ["Direct fallbacks", (a) => n(a.fallbacks)],
    ["Input tokens, median", (a) => n(a.inputMedian)],
    ["Input tokens, total", (a) => n(a.inputTotal)],
    ["Fresh input tokens, total", (a) => n(a.freshInputTotal)],
    ["Output tokens, median", (a) => n(a.outputMedian)],
    ["Output tokens, total", (a) => n(a.outputTotal)],
    ["Cost, median", (a) => usd(a.costMedian)],
    ["Cost, total", (a) => usd(a.costTotal)],
    ["Duration, median", (a) => min(a.durationMedianMs)],
  ];
  const width = Math.max(...lines.map(([l]) => l.length));
  const col = 18;
  const out = [
    "Caveman trial report",
    `Trial start: ${startedAt ? new Date(startedAt).toISOString() : "not recorded on this host"}`,
    `Range: ${new Date(range.from).toISOString()} to ${new Date(range.to).toISOString()}`,
    "Claude runs only. Input tokens include cache reads and cache writes.",
    "",
    `${"".padEnd(width)}  ${"Caveman on".padStart(col)}  ${"Caveman off".padStart(col)}`,
    ...lines.map(([label, f]) => `${label.padEnd(width)}  ${f(on).padStart(col)}  ${f(off).padStart(col)}`),
  ];
  if (off.fallbacks) out.push("", "A direct fallback is a trial-repo run that went direct. It counts under Caveman off.");
  return out.join("\n");
}
