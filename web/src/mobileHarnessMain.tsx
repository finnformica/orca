// A throwaway harness, not linked from the app and not part of `vite build`'s default entry (only
// index.html is): it mounts the WHOLE App (shell, bottom bar, every page) over a seeded fake of the
// api layer, for orca-shot screenshots of the phone layout with test data — a read-only preview
// bridge shows the shared database's real conversations, which must never land in a PR. The api is
// patched BEFORE the store loads (a dynamic import: the store reads config at module load), so every
// page sees the same small board. `?path=/agents` picks the route; everything the seed does not
// answer fails as it would offline.
import "./styles.css";
import "./lib/theme"; // applies the OS theme, so `orca-shot --dark` shows the dark app
import { api } from "@/api";
import type { AgentTurn } from "../../shared/agent";
import type { InboxRow } from "../../shared/inbox";
import { inboxFacets } from "../../shared/inbox";

const now = Date.now();
const min = (n: number) => now - n * 60_000;

const REPO = "demo";
const turn = (id: string, instruction: string, response: string, startedAt: number, extra: Partial<AgentTurn> = {}): AgentTurn =>
  ({ id, provider: "claude", instruction, prompt: "", response, startedAt, finishedAt: startedAt + 90_000, ...extra } as AgentTurn);

const ORCHESTRATOR_TURNS: AgentTurn[] = [
  turn("o1", "Start a workstream for the dark mode toggle in settings. Use Opus.", "Spawned **Dark mode toggle** on `demo` (Opus 5.5). The brief: a Switch in Settings, the theme token on `<html>`, a test for the persisted choice.", min(95)),
  turn("o2", "How is the admin access fix going?", "The worker fixed the permission check and pushed. CI is red: one test asserts the old project list order. I sent it a follow-up to fix the test.\n\n- PR #7 — conflicts with main, the worker is on it\n- Dark mode toggle — running, 2 commits so far", min(40)),
  turn("o3", "Merge #7 when it is green.", "Marked PR #7 **merge when green**. I will tell you when it lands.", min(12)),
];

const WORKER_TURNS: AgentTurn[] = [
  turn("w1", "Fix the admin access bug: promoting a user to Admin fails for some orgs.", "Found it: the permission check compares the project list by name, not by id. Fixed in `server/access.ts` and added a test.\n\n```ts\nconst same = (a: Project, b: Project) => a.id === b.id;\n```\n\nCommits: `a1b2c3d` fix admin promotion for orgs with renamed projects.", min(80)),
  turn("w2", "CI failed: tests/access.test.ts asserts the old order. Fix the test.", "Updated the test to compare ids. CI is green now. Pushed `d4e5f6a`.", min(30)),
];

const INBOX: InboxRow[] = [
  { id: "e1", at: min(1), topic: "orca.question", kind: "question", adapter: "orca", text: "Merge #7 now, or wait for the review?", conversation: "orca|event:e1", read: false, muted: false, canReply: false, canLink: false },
  { id: "e2", at: min(25), topic: "ext.slack.message", kind: "message", adapter: "slack", sender: { name: "Ada", principalId: "ada", externalId: "U1" }, place: "DM", text: "Can you also fix the header on the settings page? It overlaps the title on my phone.", conversation: "slack|D1", workstream: { repo: REPO, branch: "fix-admin-access" }, reply: { state: "sent", at: min(24), attempts: 1 }, read: false, muted: false, canReply: true, canLink: false },
  { id: "e3", at: min(240), topic: "ext.linear.message", kind: "message", adapter: "linear", sender: { name: "Sam", principalId: "sam", externalId: "L2" }, place: "DEMO-42", text: "Assigned you DEMO-42: dark mode for the settings page.", conversation: "linear|DEMO-42", read: true, muted: false, canReply: true, canLink: true },
];

const PRS = [
  { number: 7, branch: "fix-admin-access", title: "Fix admin access bug", url: "https://example.test/7", base: "main", isDraft: false, autoMergeEnabled: false, externalFeedback: 1, additions: 42, deletions: 9, head: "d4e5f6a", state: "OPEN", ciStatus: "passing", reviewStatus: "review_required", mergeable: "CONFLICTING" },
  { number: 9, branch: "settings-dark-mode", title: "Settings: dark mode toggle", url: "https://example.test/9", base: "main", isDraft: true, autoMergeEnabled: false, externalFeedback: 0, additions: 120, deletions: 4, head: "0a1b2c3", state: "OPEN", ciStatus: "pending", reviewStatus: "review_required", mergeable: "MERGEABLE" },
];

const AGENTS = [
  { branch: "fix-admin-access", worktreePath: "/wt/demo/fix-admin-access", head: "d4e5f6a", agentStatus: "done", agentResult: "CI is green now." },
  { branch: "settings-dark-mode", worktreePath: "/wt/demo/settings-dark-mode", head: "0a1b2c3", agentStatus: "running", agentStartedAt: min(14) },
  { branch: "inbox-digest", worktreePath: "/wt/demo/inbox-digest", head: "9f8e7d6", agentStatus: "error", agentError: "exit 1: bun test failed (2 tests)" },
];

const ENRICHMENT: Record<string, Record<string, unknown>> = {
  "fix-admin-access": { title: "Fix admin access bug", prompt: "Fix the admin access bug: promoting a user to Admin fails for some orgs.", orchestrated: true, preferredModel: "claude-opus-5-5" },
  "settings-dark-mode": { title: "Dark mode toggle", prompt: "Add a dark mode Switch to Settings.", orchestrated: true, preferredModel: "claude-opus-5-5" },
  "inbox-digest": { title: "Inbox daily digest", prompt: "Send one digest of the inbox each morning.", preferredModel: "claude-sonnet-5-5" },
};

const reject = () => Promise.reject(new Error("harness: no backend"));
Object.assign(api, {
  config: async () => ({ repos: [{ name: REPO, baseBranch: "main", hasRemote: true, features: { previews: true } }], staleHours: 24, agentProviders: ["claude", "codex", "cursor"], apiPort: 8787, instance: "local", instances: [], instanceUrls: {}, instanceHourlyUsd: {} }),
  agents: async () => AGENTS,
  prs: async () => PRS,
  mergedPrs: async () => [],
  enrichment: async () => ENRICHMENT,
  patchEnrichment: async () => ({ ok: true }),
  turns: async (_r: string, branch: string) => (branch === "orchestrator" ? ORCHESTRATOR_TURNS : WORKER_TURNS),
  turnPage: async (_r: string, branch: string) => ({ turns: branch === "orchestrator" ? ORCHESTRATOR_TURNS : WORKER_TURNS, older: null }),
  turnSteps: async () => [],
  queued: async () => [],
  shots: async () => [],
  orchestrator: async () => ({ key: "/state/orchestrator", running: false, paused: false, notes: "", model: "claude-opus-5-5", contextPct: 42, lastWakeUsd: 0.4 }),
  orchestratorMessage: reject,
  inbox: async () => ({ rows: INBOX, facets: inboxFacets(INBOX), older: null }),
  inboxUnread: async () => ({ others: 2, mutedKinds: [] }),
  inboxNotices: async () => ({ notices: [] }),
  inboxThread: async () => ({
    conversation: { adapter: "slack", id: "D1" }, workstream: { repo: REPO, branch: "fix-admin-access" }, replyTo: "e2", canLink: false,
    sender: { eventId: "e2", name: "Ada", muted: false }, unread: ["e2"],
    items: [
      { dir: "in", id: "e2", at: min(25), adapter: "slack", topic: "ext.slack.message", sender: { name: "Ada" }, text: "Can you also fix the header on the settings page? It overlaps the title on my phone." },
      { dir: "out", id: "d1", at: min(24), adapter: "slack", topic: "orca.message", to: "Ada", text: "On it — a worker is on the admin fix and will take the header next.", state: "sent", attempts: 1 },
    ],
  }),
  threadLinks: async () => ({ links: [] }),
  notifications: async () => [],
  handoffBadge: async () => ({ unsent: 0 }),
  previews: async () => [],
  previewStatus: async () => [],
  usage: async () => null,
  health: async () => ({ instance: "local", hostname: "local", cores: 4, cpuPct: 12, load1: 0.4, load5: 0.5, memUsedGb: 6.1, memTotalGb: 16, uptimeS: 86_400, at: now }),
  healthHistory: async () => [],
  healthLive: reject,
  summary: async () => ({ files: [{ path: "server/access.ts" }, { path: "tests/access.test.ts" }], commits: [{ hash: "d4e5f6a1b2c3", subject: "fix admin promotion for orgs with renamed projects", author: "worker", date: new Date(min(30)).toISOString() }], additions: 42, deletions: 9 }),
  prDetail: async (_r: string, n: number) => ({
    number: n, title: PRS.find((p) => p.number === n)?.title ?? `PR ${n}`, url: `https://example.test/${n}`, head: "fix-admin-access", base: "main", author: "me",
    additions: 42, deletions: 9, changedFiles: 2, state: "OPEN", ciStatus: "passing", reviewStatus: "review_required", mergeable: "CONFLICTING",
    body: "Fixes the admin promotion for orgs with renamed projects.\n\n## Changes\n- compare projects by id\n- a test for the renamed case",
    checks: [{ name: "check", status: "COMPLETED", conclusion: "SUCCESS", url: "https://example.test/check" }], reviews: [], comments: [],
  }),
  prDiff: async () => ({ diff: "" }),
  reviewSignal: async () => ({ prAuthor: "me", threads: [], comments: [] }),
  reviewEvidence: async () => [],
  prComments: async () => [],
  ciEvidence: async () => [],
  githubAccounts: async () => ({ accounts: [] }),
  integrations: async () => ({ instance: "local", kinds: [], integrations: [], links: [], people: [], pairings: [], subscriptions: [], dead: [] }),
  handoffs: async () => ({ self: "here", packs: [] }),
  secretNames: async () => ({ secrets: [] }),
});

const path = new URLSearchParams(location.search).get("path") ?? "/";
history.replaceState(null, "", path);

const { createRoot } = await import("react-dom/client");
const { App } = await import("@/App"); // after the patch: App pulls in the store, which reads config at load
createRoot(document.getElementById("root")!).render(<App />);
