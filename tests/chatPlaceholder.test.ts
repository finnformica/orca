// The chat composer's placeholder (web/src/workstream.ts `chatPlaceholder`): short enough to fit a
// 390px-wide composer on one line while busy, and never names the model while idle — the model chip
// already shows it.
import { expect, test } from "bun:test";
import { chatPlaceholder, ORCHESTRATOR_REPO } from "@/workstream";

test("busy placeholder is a short phrase, not the old sentence that overflowed on mobile", () => {
  const placeholder = chatPlaceholder(true, "some-repo");
  expect(placeholder).toBe("Queue a message…");
  expect(placeholder.length).toBeLessThanOrEqual(20);
});

test("idle placeholder for a workstream chat names neither a model nor Fable", () => {
  const placeholder = chatPlaceholder(false, "some-repo");
  expect(placeholder).toBe("Reply…");
  expect(placeholder).not.toMatch(/fable|opus|sonnet|haiku/i);
});

test("idle placeholder for the orchestrator names neither a model nor Fable", () => {
  const placeholder = chatPlaceholder(false, ORCHESTRATOR_REPO);
  expect(placeholder).toBe("Message the orchestrator…");
  expect(placeholder).not.toMatch(/fable|opus|sonnet|haiku/i);
});

test("busy beats idle regardless of which chat it is", () => {
  expect(chatPlaceholder(true, ORCHESTRATOR_REPO)).toBe("Queue a message…");
});
