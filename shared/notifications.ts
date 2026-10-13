// The notification centre's vocabulary and the pure decisions behind it, shared by the server (which
// decides WHAT an event is and writes it once) and the web (which decides how to show it). Flat: one
// row per event, no threads. Pure — no IO, so both sides and the tests import it as is.
import { parseAgentOutcome, type AgentOutcome, type StopReason, type TurnCheck } from "./agent";

export const NOTIFICATION_KINDS = [
  "needs_input", "finished", "failed", "stopped", "check_failed", "pr_ci_failed", "pr_conflicts", "preview_ready", "preview_failed",
] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];

/** Where a notification leads. The in-app page for a workstream is derived by the web from repo +
 *  branch (its PR page once it has one, else its local page), so only what the web can't derive is
 *  stored: an external `url` (a preview), a PR number, or the orchestrator's window. */
export type NotificationLink = { url?: string; pr?: number; orchestrator?: boolean };

export type Notification = {
  id: number;
  /** The instance where the event happened (recorded once, by it). */
  instance: string;
  repo: string;
  branch?: string;
  kind: NotificationKind;
  /** The workstream's title (else its branch) — what the toast is headed with. */
  title: string;
  /** One line. */
  body: string;
  link?: NotificationLink;
  createdAt: number;
  readAt?: number;
  dismissedAt?: number;
};

/** What the emitter writes: a `key` makes the insert idempotent (unique per user), so a run that is
 *  finished twice (adopted after a restart, or the same repo answered by two instances) is one row. */
export type NotificationInput = Omit<Notification, "id" | "createdAt" | "readAt" | "dismissedAt" | "instance"> & { key: string };

export type KindMeta = {
  label: string;
  /** The toast stays until dismissed (a problem, or something waiting on you); else it auto-hides. */
  persistent: boolean;
  /** Worth a browser notification when the tab is hidden. */
  urgent: boolean;
  tone: "ready" | "error" | "warning" | "queued" | "neutral";
  /** The primary action's label. */
  action: string;
};

export const KIND_META: Record<NotificationKind, KindMeta> = {
  needs_input: { label: "Needs input", persistent: true, urgent: true, tone: "queued", action: "Open" },
  finished: { label: "Finished", persistent: false, urgent: false, tone: "ready", action: "Open" },
  failed: { label: "Failed", persistent: true, urgent: true, tone: "error", action: "Open" },
  stopped: { label: "Stopped", persistent: true, urgent: false, tone: "warning", action: "Open" },
  check_failed: { label: "Check failed", persistent: true, urgent: true, tone: "error", action: "Open" },
  pr_ci_failed: { label: "CI failing", persistent: true, urgent: false, tone: "error", action: "Open PR" },
  pr_conflicts: { label: "Conflicts", persistent: true, urgent: false, tone: "warning", action: "Open PR" },
  preview_ready: { label: "Preview ready", persistent: false, urgent: false, tone: "ready", action: "Open preview" },
  preview_failed: { label: "Preview failed", persistent: true, urgent: false, tone: "error", action: "Open" },
};

/** How long a non-persistent toast stays. */
export const TOAST_AUTO_HIDE_MS = 6_000;
/** A toast older than this when it arrives (a catch-up after a long absence) is not popped. */
export const TOAST_FRESH_MS = 10 * 60_000;

const oneLine = (text: string, max = 140): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The agent asked you something. Nobody has a cleaner signal than the reply itself (a question is
 *  still `end_turn`, see StopReason), so: a run blocked on a tool confirmation, or a reply whose last
 *  line is a question. The outcome's prose is preferred over the raw response when it exists. */
export function asksForInput(input: { stopReason?: StopReason; response?: string; outcome?: AgentOutcome }): boolean {
  if (input.stopReason === "requires_action") return true;
  const text = (input.outcome ? [input.outcome.outcome, ...input.outcome.remaining].join("\n") : input.response) ?? "";
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  return /\?\s*$/.test(last.replace(/[*_`]+$/, ""));
}

/** What a finished run is, as a notification — or nothing, for a run nobody needs telling about. */
export function runNotification(run: {
  repo: string; branch: string; runId: string; title?: string; status: "done" | "error" | "stopped";
  stopReason?: StopReason; response?: string; outcome?: AgentOutcome; error?: string;
  /** The orchestrator's own wake: only a problem or a question is reported. */
  orchestrator?: boolean;
  /** A queued follow-up (an autofix) took straight over: not idle, so no "finished". */
  continued?: boolean;
  /** A compact is housekeeping. */
  compact?: boolean;
}): NotificationInput | undefined {
  if (run.compact) return undefined;
  // The structured outcome when the caller has it, else parsed from the reply (the same sections).
  run = { ...run, outcome: run.outcome ?? (run.response ? parseAgentOutcome(run.response) : undefined) };
  const base = { repo: run.repo, branch: run.branch, title: run.title || run.branch, link: run.orchestrator ? { orchestrator: true } : undefined };
  if (run.status === "error") {
    return { ...base, kind: "failed", key: `run:${run.runId}:failed`, body: oneLine(run.error || run.response || "The run failed.") };
  }
  if (run.status === "stopped") {
    if (run.orchestrator) return undefined; // you pressed Stop on it; nothing to tell
    return { ...base, kind: "stopped", key: `run:${run.runId}:stopped`, body: "Stopped. The work so far stands; reply to redirect." };
  }
  if (asksForInput(run)) {
    const text = run.outcome ? [run.outcome.outcome, ...run.outcome.remaining].join("\n") : run.response ?? "";
    const last = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
    return { ...base, kind: "needs_input", key: `run:${run.runId}:needs_input`, body: oneLine(last) };
  }
  if (run.orchestrator || run.continued) return undefined;
  return { ...base, kind: "finished", key: `run:${run.runId}:finished`, body: oneLine(run.outcome?.outcome || run.response || "Done.") };
}

/** Orca's check failed over a run's commit. Separate from the run's own notification: a run can be
 *  "finished" by its own account and still have failed the gate — and an autofix continuing the
 *  branch does not make the failure less worth knowing. */
export function checkNotification(run: { repo: string; branch: string; runId: string; title?: string; check?: TurnCheck }): NotificationInput | undefined {
  if (!run.check || run.check.ok) return undefined;
  return {
    repo: run.repo, branch: run.branch, title: run.title || run.branch, kind: "check_failed", key: `check:${run.runId}`,
    body: oneLine(`${run.check.command} exited ${run.check.exitCode}`),
  };
}

/** A preview that came up (with the URL to open) or didn't. `startedAt` is in the key, so a re-spin
 *  of the same worktree is its own event. */
export function previewNotification(p: {
  repo: string; branch?: string; title: string; key: string; startedAt: number;
  ready: boolean; url?: string; error?: string;
}): NotificationInput {
  return p.ready
    ? { repo: p.repo, branch: p.branch, title: p.title, kind: "preview_ready", key: `preview:${p.key}:${p.startedAt}:ready`, body: p.url ? oneLine(p.url) : "Running.", link: p.url ? { url: p.url } : undefined }
    : { repo: p.repo, branch: p.branch, title: p.title, kind: "preview_failed", key: `preview:${p.key}:${p.startedAt}:failed`, body: oneLine(p.error || "A service did not come up.") };
}

/** What an open PR's state says, once per PR per set of failing checks (CI) or once per PR
 *  (conflicts). Read off the ordinary PR list, so it costs nothing extra. */
export function prNotifications(repo: string, prs: {
  number: number; title: string; branch: string; state: string; ciStatus: string; mergeable: string; failingChecks?: string[];
}[]): NotificationInput[] {
  const out: NotificationInput[] = [];
  for (const pr of prs) {
    if (pr.state !== "OPEN") continue;
    const base = { repo, branch: pr.branch, title: pr.title || pr.branch, link: { pr: pr.number } };
    if (pr.ciStatus === "failing") {
      const checks = [...(pr.failingChecks ?? [])].sort();
      out.push({ ...base, kind: "pr_ci_failed", key: `pr-ci:${repo}#${pr.number}:${checks.join(",")}`, body: checks.length ? oneLine(`Failing: ${checks.join(", ")}`) : "CI is failing." });
    }
    if (pr.mergeable === "CONFLICTING") {
      out.push({ ...base, kind: "pr_conflicts", key: `pr-conflict:${repo}#${pr.number}`, body: "Has merge conflicts with its base." });
    }
  }
  return out;
}

/** How many are unread (dismissed ones are gone from the centre, so they don't count). */
export const unreadCount = (list: Pick<Notification, "readAt" | "dismissedAt">[]): number =>
  list.filter((n) => !n.readAt && !n.dismissedAt).length;

/** The centre's rows grouped by calendar day, newest group (and row) first. */
export function groupByDay<T extends Pick<Notification, "createdAt">>(list: T[], now = Date.now()): { label: string; items: T[] }[] {
  const dayOf = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const today = dayOf(now);
  const label = (day: number) => day === today ? "Today" : day === today - 86_400_000 ? "Yesterday"
    : new Date(day).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const groups = new Map<number, T[]>();
  for (const n of [...list].sort((a, b) => b.createdAt - a.createdAt)) {
    const day = dayOf(n.createdAt);
    (groups.get(day) ?? groups.set(day, []).get(day)!).push(n);
  }
  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([day, items]) => ({ label: label(day), items }));
}

/** Per-kind "show a toast" preferences; a kind absent from the map is on. */
export type ToastPrefs = Partial<Record<NotificationKind, boolean>>;

/** Whether a notification pops up: not while do-not-disturb is on, not a kind switched off, and not
 *  one older than the fresh window (a catch-up after an hour away is for the centre, not the corner). */
export function shouldToast(n: Pick<Notification, "kind" | "createdAt" | "dismissedAt">, opts: { dnd: boolean; prefs: ToastPrefs; now?: number }): boolean {
  if (opts.dnd || n.dismissedAt) return false;
  if (opts.prefs[n.kind] === false) return false;
  return (opts.now ?? Date.now()) - n.createdAt < TOAST_FRESH_MS;
}

/** A browser notification while the tab is hidden: the urgent kinds only. */
export const shouldNotifyBrowser = (n: Pick<Notification, "kind">, opts: { enabled: boolean; hidden: boolean; dnd: boolean }): boolean =>
  opts.enabled && opts.hidden && !opts.dnd && KIND_META[n.kind].urgent;

/** How many toasts show in the collapsed stack. */
export const STACK_VISIBLE = 3;

/** The toast stack as rendered: newest first; collapsed, only the top few are visible (the rest are
 *  counted); expanded, all of them. Pure, so the stacking rules are testable without a DOM. */
export function toastStack<T extends Pick<Notification, "id" | "createdAt">>(toasts: T[], expanded: boolean): { visible: T[]; hidden: number; collapsed: boolean } {
  const sorted = [...toasts].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const collapsed = !expanded && sorted.length > 1;
  const visible = collapsed ? sorted.slice(0, STACK_VISIBLE) : sorted;
  return { visible, hidden: sorted.length - visible.length, collapsed };
}

/** The in-app route a notification opens: its PR page when it names one, else the workstream's page
 *  — resolved by the caller against the live rows (`rowPath`), falling back to the local page. */
export function notificationPath(n: Pick<Notification, "repo" | "branch" | "link">, rowPath?: string | null): string | undefined {
  if (n.link?.pr) return `/${n.repo}/prs/${n.link.pr}`;
  if (rowPath) return rowPath;
  if (n.branch) return `/${n.repo}/local/${encodeURIComponent(n.branch)}`;
  return undefined;
}
