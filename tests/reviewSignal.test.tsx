// The review SIGNAL on a PR (not just its state): who approved, the comments from people, the AI
// reviewers' severe findings, and how many unresolved review threads actually ask for a change.
// gh.reviewSignal is driven through the gh PATH shim; the four derivations (workstream.ts) are
// checked on real-looking Claude Code review / Gemini Code Assist / Copilot payloads; then the list
// row's review cluster and the PR page's Review panel are rendered from the fake api.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { reviewSignal, type ConversationComment, type ReviewSignal, type ReviewThreadEvidence } from "../server/gh";
import {
  actionableUnresolved, approvers, commentSeverity, firstLine, humanComments, isBotAuthor, reviewDigest, severeAiComments,
} from "@/workstream";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { Overview } from "@/views/Overview";
import { ReviewPanel } from "@/views/Review";
import { navigate } from "@/lib/route";
import { installFakeGh, makeScratchRepo, restorePath, setReviewEvidenceFixture } from "./helpers";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (min: number) => new Date(Date.UTC(2026, 9, 12, 10, min)).toISOString();

const CLAUDE_REVIEW = [
  "**Claude finished @me's task** —— [View job](https://github.com/acme/app/actions/runs/1)",
  "",
  "### Code Review",
  "🔴 **Critical: SQL injection** — `findUser` interpolates `name` into the query string.",
].join("\n");
const GEMINI_SUMMARY = [
  "## Summary of Changes",
  "",
  "Hello @me, I'm Gemini Code Assist! This pull request improves the security of token handling and adds retries.",
].join("\n");
const GEMINI_HIGH = "![high](https://www.gstatic.com/codereviewagent/high-priority.svg)\n\nThe access token is written to the log in plain text.";
const GEMINI_MEDIUM = "![medium](https://www.gstatic.com/codereviewagent/medium-priority.svg)\n\nConsider extracting this into a helper.";
const COPILOT_OVERVIEW = "## Pull Request Overview\n\nThis PR adds retry handling to the client. Critical paths are covered.";

const threads: ReviewThreadEvidence[] = [
  { id: "T1", author: "alice", body: "Please handle the empty list here", resolved: false, createdAt: at(1), path: "src/a.ts", url: "https://x/T1" },
  { id: "T2", author: "bob", body: "nit: rename to `count`", resolved: false, createdAt: at(2) },
  { id: "T3", author: "me", body: "Note to self: revisit", resolved: false, createdAt: at(3) },
  { id: "T4", author: "carol", body: "old ask", resolved: true, createdAt: at(4) },
  { id: "T5", author: "dave", body: "FYI this mirrors the old behaviour", resolved: false, createdAt: at(5) },
  { id: "T6", author: "gemini-code-assist", bot: true, body: GEMINI_HIGH, resolved: false, createdAt: at(6), url: "https://x/T6" },
  { id: "T7", author: "gemini-code-assist", bot: true, body: GEMINI_MEDIUM, resolved: false, createdAt: at(7) },
  { id: "T8", author: "claude[bot]", body: "⚠️ **Warning:** this throws when `items` is empty.", resolved: false, createdAt: at(8) },
];
const comments: ConversationComment[] = [
  { id: "R1", kind: "review", author: "alice", state: "APPROVED", body: "", createdAt: at(10) },
  { id: "R2", kind: "review", author: "alice", state: "COMMENTED", body: "", createdAt: at(11) }, // doesn't withdraw it
  { id: "R3", kind: "review", author: "bob", state: "APPROVED", body: "", createdAt: at(12) },
  { id: "R4", kind: "review", author: "bob", state: "CHANGES_REQUESTED", body: "See the inline nit.", createdAt: at(13) },
  { id: "R5", kind: "review", author: "carol", state: "CHANGES_REQUESTED", body: "", createdAt: at(14) },
  { id: "R6", kind: "review", author: "carol", state: "APPROVED", body: "", createdAt: at(15) },
  { id: "R7", kind: "review", author: "copilot-pull-request-reviewer", bot: true, state: "COMMENTED", body: COPILOT_OVERVIEW, createdAt: at(16) },
  { id: "C1", kind: "comment", author: "claude", bot: true, body: CLAUDE_REVIEW, createdAt: at(17), url: "https://x/C1" },
  { id: "C2", kind: "comment", author: "gemini-code-assist", bot: true, body: GEMINI_SUMMARY, createdAt: at(18) },
  { id: "C3", kind: "comment", author: "erin", body: "Can we get a test for the retry path?", createdAt: at(19), url: "https://x/C3" },
];
const signal: ReviewSignal = { prAuthor: "me", threads, comments };

describe("review signal derivations (pure)", () => {
  test("bots: [bot] logins, GitHub Bot accounts and the known AI reviewers, case-insensitively", () => {
    expect(isBotAuthor("dependabot[bot]")).toBe(true);
    expect(isBotAuthor("Gemini-Code-Assist")).toBe(true);
    expect(isBotAuthor("coderabbitai")).toBe(true);
    expect(isBotAuthor("some-app", true)).toBe(true);
    expect(isBotAuthor("alice")).toBe(false);
  });

  test("approvers: latest decisive review is APPROVED (a later plain comment doesn't withdraw it)", () => {
    expect(approvers(signal)).toEqual(["alice", "carol"]);
    expect(approvers({ threads: [], comments: [] })).toEqual([]);
  });

  test("severity: emoji markers, Gemini priority badges and severity words near the top", () => {
    expect(commentSeverity(CLAUDE_REVIEW)).toBe("critical");
    expect(commentSeverity(GEMINI_HIGH)).toBe("critical");
    expect(commentSeverity(GEMINI_MEDIUM)).toBeUndefined();
    expect(commentSeverity("⚠️ **Warning:** this throws")).toBe("warning");
    expect(commentSeverity("🟠 Possible race")).toBe("warning");
    expect(commentSeverity("This must fix the retry")).toBe("critical");
    expect(commentSeverity(`${"x".repeat(400)} critical`)).toBeUndefined(); // past the first 300 chars
  });

  test("human comments: people only, unresolved threads not opened by the author, bare approvals skipped, newest first", () => {
    expect(humanComments(signal).map((i) => i.id)).toEqual(["C3", "R4", "T5", "T2", "T1"]);
  });

  test("severe AI comments: bots flagging severity; a summary's prose ('security', 'Critical paths') is not a finding", () => {
    const severe = severeAiComments(signal);
    expect(severe.map((i) => [i.id, i.severity])).toEqual([["C1", "critical"], ["T8", "warning"], ["T6", "critical"]]);
    expect(severe.map((i) => i.line)).toEqual([
      "🔴 Critical: SQL injection — `findUser` interpolates `name` into the query string.", // the flagged line
      "⚠️ Warning: this throws when `items` is empty.",
      "The access token is written to the log in plain text.", // Gemini's badge line has no text
    ]);
  });

  test("actionable unresolved: excludes resolved, the author's own, status updates and summaries; nits counted but flagged", () => {
    expect(actionableUnresolved(signal)).toEqual({ count: 5, nits: 1 }); // T1 T2 T6 T7 T8
    expect(actionableUnresolved({ prAuthor: "me", threads: [{ id: "S", author: "x[bot]", body: "## Summary\nAll good", resolved: false }], comments: [] }).count).toBe(0);
    const d = reviewDigest(signal);
    expect(d.worst).toBe("critical");
  });

  test("first line drops badges, HTML comments and markdown marks", () => {
    expect(firstLine(GEMINI_HIGH)).toBe("The access token is written to the log in plain text.");
    expect(firstLine("<!-- auto -->\n## Summary of Changes\nbody")).toBe("Summary of Changes");
  });
});

describe("gh.reviewSignal (PATH shim)", () => {
  let repo: string;
  beforeAll(async () => { await installFakeGh(); repo = await makeScratchRepo(); });
  afterAll(() => restorePath());

  test("one GraphQL call: reviews with state (bodiless approvals too), comments and every thread, the author's comments dropped", async () => {
    await setReviewEvidenceFixture({ data: { repository: { pullRequest: {
      author: { login: "me" },
      reviews: { nodes: [
        { id: "R1", author: { __typename: "User", login: "alice" }, state: "APPROVED", body: "", submittedAt: at(1), url: "https://x/R1" },
        { id: "R2", author: { __typename: "User", login: "me" }, state: "COMMENTED", body: "self", submittedAt: at(2) },
      ] },
      comments: { nodes: [
        { id: "C1", author: { __typename: "Bot", login: "gemini-code-assist" }, body: GEMINI_SUMMARY, createdAt: at(3) },
        { id: "C2", author: { __typename: "User", login: "me" }, body: "my reply", createdAt: at(4) },
        { id: "C3", author: { __typename: "User", login: "bob" }, body: "  ", createdAt: at(5) },
      ] },
      reviewThreads: { nodes: [
        { id: "T1", isResolved: false, isOutdated: true, path: "a.ts", line: null, originalLine: 3, comments: { nodes: [{ author: { __typename: "User", login: "carol" }, body: "Fix this", url: "https://x/T1", createdAt: at(6) }] } },
        { id: "T2", isResolved: true, isOutdated: false, comments: { nodes: [{ author: { __typename: "Bot", login: "claude" }, body: "x".repeat(2_000), createdAt: at(7) }] } },
      ] },
    } } } });
    const s = await reviewSignal(repo, 42);
    expect(s.prAuthor).toBe("me");
    expect(s.comments.map((c) => [c.id, c.state, c.bot])).toEqual([["R1", "APPROVED", false], ["C1", undefined, true]]);
    expect(s.threads[0]).toMatchObject({ id: "T1", author: "carol", resolved: false, outdated: true, line: 3, path: "a.ts", bot: false });
    expect(s.threads[1]).toMatchObject({ id: "T2", resolved: true, bot: true });
    expect(s.threads[1]!.body.length).toBeLessThan(700); // bounded
    expect(approvers(s)).toEqual(["alice"]);
  });
});

// ---- the UI ----

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
}

describe("review cluster + Review panel", () => {
  beforeAll(() => store.configReady);
  afterEach(async () => {
    apiFake.reset();
    store._resetReviewSignals();
    await act(async () => { await store.refresh(); });
    act(() => root?.unmount());
    container?.remove();
    root = container = undefined;
    localStorage.clear();
    navigate("/");
  });

  test("a PR row shows approver chips, `N unresolved` and a red dot for a severe AI comment, fetched once per PR", async () => {
    apiFake.prsData = [{ number: 7, title: "feat", branch: "feat-x", url: "https://x/7", state: "OPEN", isDraft: false, ciStatus: "passing", reviewStatus: "approved", mergeable: "MERGEABLE", autoMergeEnabled: false }];
    apiFake.agentsData = [{ branch: "local-only", worktreePath: "/wt/local-only", agentStatus: "done" }];
    apiFake.reviewEvidenceData = threads;
    apiFake.prCommentsData = comments;
    await mount(<Overview />);
    const row = container!.querySelector<HTMLElement>('[data-branch="feat-x"]')!;
    const cluster = row.querySelector<HTMLElement>('[data-slot="review-cluster"]')!;
    expect(cluster).not.toBeNull();
    expect([...cluster.querySelectorAll('[data-slot="approver"]')].map((a) => a.getAttribute("title"))).toEqual(["Approved by alice", "Approved by carol"]);
    expect(cluster.querySelector('[data-slot="unresolved"]')!.textContent).toBe("5 unresolved");
    expect(cluster.querySelector('[data-slot="unresolved"]')!.getAttribute("title")).toContain("1 nit");
    const dot = cluster.querySelector<HTMLElement>('[data-slot="severe-dot"]')!;
    expect(dot.dataset.severity).toBe("critical");
    expect(dot.getAttribute("title")).toContain("SQL injection");
    // Lazy: only the PR row fetched it, once — a further poll doesn't refetch an unchanged PR.
    await act(async () => { await store.refresh(); await flush(); });
    expect(apiFake.reviewSignalCalls).toEqual(["r#7"]);
    expect(container!.querySelector('[data-branch="local-only"] [data-slot="review-cluster"]')).toBeNull();
  });

  test("the PR page's Review panel lists severe AI findings and people's comments with author and link", async () => {
    apiFake.reviewEvidenceData = threads;
    apiFake.prCommentsData = comments;
    await mount(<ReviewPanel repo="r" prNumber={7} />);
    const panel = container!.querySelector<HTMLElement>('[data-slot="review-panel"]')!;
    expect(panel.textContent).toContain("Approved by alice, carol");
    expect(panel.textContent).toContain("5 unresolved (1 nit)");
    const items = [...panel.querySelectorAll<HTMLElement>('[data-slot="review-item"]')];
    expect(items[0]!.textContent).toContain("claude");
    expect(items[0]!.textContent).toContain("🔴 Critical: SQL injection — `findUser`"); // the flagged line, not the job header
    expect(items.some((i) => i.textContent!.includes("erin") && i.textContent!.includes("Can we get a test for the retry path?"))).toBe(true);
    expect(panel.querySelector('a[href="https://x/C3"]')).not.toBeNull();
    expect(panel.textContent).not.toContain("Summary of Changes"); // a bot summary is neither human nor severe
  });
});
