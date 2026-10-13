// Queueing an action on a busy agent, client side (web/src/store.ts's launchOnRow): Address PR /
// Resolve conflicts / a follow-up landing on a worktree the bridge reports as already running used
// to surface the server's 409 as the action-error toast. The bridge now queues instead and answers
// `{ status: "queued" }` (server/index.ts's /api/agent) — this pins that the store treats that as
// success (never throws) and shows a neutral INFO toast, not the error one. Driven against the real
// store + apiFake (tests/apiFake.ts), same style as activeFollowing.test.tsx; a tiny probe component
// reads the toast stack (lib/toast) without mounting the whole App.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import type { Row } from "@/store";
import { resetToasts, useToasts, type Toast } from "@/lib/toast";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

let root: Root | undefined;
let container: HTMLElement | undefined;
let seen: Toast[] = [];

/** Mounts a probe that mirrors the live toast stack into `seen`, so a test can assert on it without
 *  rendering the Toaster (which needs the orchestrator panel's atoms wired up). */
function Probe() {
  seen = useToasts();
  return null;
}
async function mountProbe() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<Probe />); });
}

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  seen = [];
  apiFake.reset();
  act(() => resetToasts());
});

const row: Row = {
  repo: "r", hasRemote: true, branch: "feat", title: "Feat", prompt: "", lane: "IN_REVIEW",
  worktreePath: "/wt/feat", prNumber: 7, prUrl: "https://x/7",
};

test("Address PR on a busy worktree: the store doesn't throw, and an info Queued toast appears — never the error toast", async () => {
  await mountProbe();
  apiFake.agentQueued = { id: 1, repo: "r", branch: "feat", worktreePath: "/wt/feat", instruction: "Address the PR: conflicts, CI, review", attachments: [], createdAt: Date.now() };
  await act(async () => { await store.addressPr(row); });

  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ kind: "info", title: "Queued" });
  expect(seen[0]!.body).toContain("finishes");
});

test("Resolve conflicts on a busy worktree queues the same way", async () => {
  await mountProbe();
  apiFake.agentQueued = { id: 2, repo: "r", branch: "feat", worktreePath: "/wt/feat", instruction: "Resolve merge conflicts with main", attachments: [], createdAt: Date.now() };
  await act(async () => { await store.resolveConflicts({ ...row, prNumber: undefined, prUrl: undefined, lane: "LOCAL" }); });

  expect(seen).toHaveLength(1);
  expect(seen[0]!.kind).toBe("info");
});

test("a follow-up that actually launches (not queued) shows no toast at all", async () => {
  await mountProbe();
  await act(async () => { await store.followUp(row, "carry on"); });
  expect(seen).toHaveLength(0);
});

test("a genuinely failed launch still raises the error toast, not the queued one", async () => {
  await mountProbe();
  apiFake.claudeError = "launch rejected";
  await expect(store.addressPr(row)).rejects.toThrow("launch rejected");
  // addressPr itself doesn't raise the action-error toast (its caller, e.g. ActionButton, does) —
  // the point here is just that nothing queued-shaped was shown for a real failure.
  expect(seen.some((t) => t.title === "Queued")).toBe(false);
});
