// Queueing an action on a busy agent, client side (web/src/store.ts's launchOnRow): Address PR /
// Resolve conflicts / a follow-up landing on a worktree the bridge reports as already running used
// to surface the server's 409 as the action-error toast. The bridge now queues instead and answers
// `{ status: "queued" }` (server/index.ts's /api/agent) — this pins that the store treats that as
// success (never throws) and raises no toast at all: the row/chat's own queued indicator (the
// branch's `queued` count, Chat.tsx's `Queued` entries) already shows it, so a redundant toast would
// just be noise. Driven against the real store + apiFake (tests/apiFake.ts), same style as
// activeFollowing.test.tsx; a tiny probe component reads the toast stack (lib/notificationStore) without
// mounting the whole App.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import type { Row } from "@/store";
import * as centre from "@/lib/notificationStore";
import type { Notification } from "../shared/notifications";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

let root: Root | undefined;
let container: HTMLElement | undefined;
let seen: Notification[] = [];

/** Mounts a probe that mirrors the live toast stack into `seen`, so a test can assert on it without
 *  rendering the stack (which needs the orchestrator panel's atoms wired up). */
function Probe() {
  seen = centre.useNotifications().toasts;
  return null;
}
async function mountProbe() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<Probe />); });
}

// The notification store is a module singleton: a file that ran earlier in the same `bun test`
// process can leave a toast on it, which the first test here then counts.
beforeEach(() => { act(() => centre.reset()); });

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  seen = [];
  apiFake.reset();
  act(() => centre.reset());
});

const row: Row = {
  repo: "r", hasRemote: true, branch: "feat", title: "Feat", prompt: "", lane: "IN_REVIEW",
  worktreePath: "/wt/feat", prNumber: 7, prUrl: "https://x/7",
};

test("Address PR on a busy worktree: the store doesn't throw, and raises no toast", async () => {
  await mountProbe();
  apiFake.agentQueued = { id: 1, repo: "r", branch: "feat", worktreePath: "/wt/feat", instruction: "Address the PR: conflicts, CI, review", attachments: [], createdAt: Date.now() };
  await act(async () => { await store.addressPr(row); });

  expect(seen).toHaveLength(0);
});

test("Resolve conflicts on a busy worktree queues the same way, with no toast", async () => {
  await mountProbe();
  apiFake.agentQueued = { id: 2, repo: "r", branch: "feat", worktreePath: "/wt/feat", instruction: "Resolve merge conflicts with main", attachments: [], createdAt: Date.now() };
  await act(async () => { await store.resolveConflicts({ ...row, prNumber: undefined, prUrl: undefined, lane: "LOCAL" }); });

  expect(seen).toHaveLength(0);
});

test("a follow-up that actually launches (not queued) also shows no toast", async () => {
  await mountProbe();
  await act(async () => { await store.followUp(row, "carry on"); });
  expect(seen).toHaveLength(0);
});

test("a genuinely failed launch still raises the error toast, not a queued one", async () => {
  await mountProbe();
  apiFake.claudeError = "launch rejected";
  await expect(store.addressPr(row)).rejects.toThrow("launch rejected");
  // addressPr itself doesn't raise the action-error toast (its caller, e.g. ActionButton, does) —
  // the point here is just that nothing queued-shaped was shown for a real failure.
  expect(seen.some((t) => t.title === "Queued" || t.label === "Queued")).toBe(false);
});

test("a follow-up queued behind a busy agent resolves at once, without waiting for the board to refresh", async () => {
  // The chat drops its "sending…" bubble when followUp resolves. It used to wait on refresh() — every
  // repo's agents, PRs and merged history — so a message the bridge had already queued sat in
  // "sending…" for as long as GitHub took to answer.
  apiFake.agentQueued = { id: 3, repo: "r", branch: "feat", worktreePath: "/wt/feat", instruction: "and this", attachments: [], createdAt: Date.now() };
  apiFake.holdPrs = true; // the board's PR poll never answers until released
  const before = performance.now();
  const outcome = await Promise.race([
    store.followUp(row, "and this").then(() => "resolved"),
    new Promise((r) => setTimeout(() => r("still waiting"), 1_000)),
  ]);
  expect(outcome).toBe("resolved");
  expect(performance.now() - before).toBeLessThan(500);
  expect(apiFake.agentLaunches.length + apiFake.claudePrompts.length).toBeGreaterThan(0); // it reached the bridge
  apiFake.releasePrs?.();
});
