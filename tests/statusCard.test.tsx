// The agent status chip's hover card: `rowStatus` (workstream.ts) returns the tone the label comes
// from AND the real inputs behind it, so the card explains the status instead of guessing. The pure
// derivation is checked per status first; then the card is opened in a real DOM.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./apiFake";
import * as store from "@/store";
import { rowStatus, rowTone, type OverviewRow } from "@/workstream";
import { StatusHoverCard } from "@/views/StatusCard";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const NOW = Date.parse("2026-10-16T12:00:00Z");
const MIN = 60_000;
const row = (over: Partial<OverviewRow>): OverviewRow => ({ repo: "r", branch: "b", title: "t", lane: "LOCAL", ...over });

describe("rowStatus (pure)", () => {
  test("Running: elapsed time, model and queued messages; the tone is rowTone's", () => {
    const r = row({ agentStatus: "running", agentStartedAt: NOW - 12 * MIN, agentMeta: { model: "Opus 5.5" }, queued: 2 });
    const s = rowStatus(r, { now: NOW });
    expect(s.tone).toBe("running");
    expect(s.tone).toBe(rowTone(r));
    expect(s.reasons).toEqual(["The agent runs on Opus 5.5 for 12m.", "2 messages queued, sent when this run ends."]);
    expect(s.action).toBeUndefined(); // an agent is on it
    // No live start or model from the bridge yet: the open turn's start and the card's pinned model.
    const pinned = rowStatus(row({ agentStatus: "running", transcript: [{ provider: "claude", prompt: "", startedAt: NOW - 3 * MIN }] }), { now: NOW, model: "Sonnet 5" });
    expect(pinned.reasons).toEqual(["The agent runs on Sonnet 5 for 3m."]);
  });

  test("Needs you: conflicts, review threads and a question, with Address PR", () => {
    const r = row({
      lane: "IN_REVIEW", prNumber: 7, mergeable: "CONFLICTING", reviewStatus: "changes_requested",
      transcript: [{ provider: "claude", prompt: "", response: "Done the first half.\n\nShould I also rename the table?", startedAt: NOW - 5 * MIN, finishedAt: NOW - 4 * MIN }],
    });
    const s = rowStatus(r, { now: NOW, unresolved: 2 });
    expect(s.tone).toBe("attention");
    expect(s.reasons).toEqual([
      "The PR has merge conflicts with its base.",
      "A reviewer requested changes.",
      "The agent asked a question: Should I also rename the table?",
      "2 unresolved review threads.",
    ]);
    expect(s.action).toBe("address");
  });

  test("Error: CI failed on the head commit with the failing checks; a failed check and run say why", () => {
    const ci = rowStatus(row({ lane: "IN_REVIEW", prNumber: 3, ciStatus: "failing", prHead: "abc1234def", failingChecks: ["test", "lint"] }), { now: NOW });
    expect(ci.tone).toBe("failed");
    expect(ci.reasons).toEqual(["CI failed on commit abc1234: test, lint."]);
    expect(ci.action).toBe("address");
    const run = rowStatus(row({ agentStatus: "error", agentError: "spawn claude ENOENT\nstack…", agentCheck: { ok: false, command: "bun run check", exitCode: 1 } }), { now: NOW });
    expect(run.tone).toBe("failed");
    expect(run.reasons).toEqual(["Orca's check failed on the last commit: `bun run check` exited 1.", "The last run failed: spawn claude ENOENT."]);
    expect(run.action).toBeUndefined(); // no PR: Address PR does not apply
  });

  test("Needs you: a stopped run and a held message", () => {
    const s = rowStatus(row({ agentStatus: "idle", queued: 1, transcript: [{ provider: "claude", prompt: "", stopped: true, startedAt: NOW - 3 * MIN }] }), { now: NOW });
    expect(s.tone).toBe("attention");
    expect(s.reasons).toEqual(["You stopped the last run.", "1 queued message wait, and no run is active to send them."]);
  });

  test("Ready: approved, CI passes on the commit, merges clean; merged says when", () => {
    const s = rowStatus(row({ lane: "MERGEABLE", prNumber: 4, ciStatus: "passing", mergeable: "MERGEABLE", prHead: "0123456789" }), { now: NOW });
    expect(s.tone).toBe("ready");
    expect(s.reasons).toEqual(["The PR is approved.", "CI passes on commit 0123456.", "The PR merges clean."]);
    expect(s.action).toBeUndefined();
    const done = rowStatus(row({ lane: "DONE", prNumber: 5, mergedAt: new Date(NOW - 30 * MIN).toISOString() }), { now: NOW, unresolved: 3 });
    expect(done.reasons).toEqual(["The PR merged 30m ago."]); // threads on a merged PR are not news
  });

  test("Idle: since when, the last run's one-line outcome, the PR's wait, and a blocked cleanup", () => {
    const r = row({
      lane: "IN_REVIEW", prNumber: 9, ciStatus: "pending", agentStatus: "done",
      cleanupBlocked: { why: "uncommitted changes" },
      transcript: [{ provider: "claude", prompt: "", response: "x", structured: { outcome: "Added the hover card.\nMore.", verification: [], decisions: [], remaining: [], commits: [] }, startedAt: NOW - 50 * MIN, finishedAt: NOW - 45 * MIN }],
    });
    const s = rowStatus(r, { now: NOW });
    expect(s.tone).toBe("neutral");
    expect(s.reasons).toEqual([
      "Idle since 45m ago.",
      "Last run done: Added the hover card.",
      "The PR waits for an approval.",
      "CI still runs.",
      "Cleanup blocked: uncommitted changes.",
    ]);
    expect(rowStatus(row({}), { now: NOW }).reasons).toEqual(["No agent ran on it yet."]);
  });
});

describe("StatusHoverCard (DOM)", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;
  // The card reads the review digest cache, which other files in this process fill (agentsList: r#7).
  beforeEach(() => store._resetReviewSignals());
  afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; });

  test("focus on the chip opens the card with the reasons and Address PR", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const r = { repo: "r", hasRemote: true, branch: "b", title: "t", prompt: "", lane: "IN_REVIEW" as const, prNumber: 7, mergeable: "CONFLICTING" as const };
    act(() => root!.render(<StatusHoverCard row={r}><span>Needs you</span></StatusHoverCard>));
    const trigger = host.querySelector<HTMLElement>("[data-slot=status-trigger]")!;
    expect(trigger.textContent).toBe("Needs you"); // the label is untouched
    await act(async () => { trigger.focus(); await new Promise((res) => setTimeout(res, 250)); });
    const card = document.querySelector("[data-slot=status-card]")!;
    expect(card.getAttribute("data-tone")).toBe("attention");
    expect([...card.querySelectorAll("[data-slot=status-reason]")].map((e) => e.textContent)).toEqual(["The PR has merge conflicts with its base."]);
    expect(card.textContent).toContain("Address PR");
  });

  test("the header carries the elapsed time of a running agent, and a finished run's duration", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const r = { repo: "r", hasRemote: true, branch: "b", title: "t", prompt: "", lane: "LOCAL" as const, agentStatus: "running" as const, agentStartedAt: Date.now() - 65_000 };
    act(() => root!.render(<StatusHoverCard row={r}><span>Running</span></StatusHoverCard>));
    const trigger = host.querySelector<HTMLElement>("[data-slot=status-trigger]")!;
    expect(trigger.querySelector("[data-slot=elapsed]")).toBeNull(); // the chip itself is untouched
    await act(async () => { trigger.focus(); await new Promise((res) => setTimeout(res, 250)); });
    const head = document.querySelector("[data-slot=status-card] [data-slot=status-card-duration]")!;
    expect(head.querySelector("[data-slot=elapsed]")!.textContent).toMatch(/^1:0[56]$/);
  });
});
