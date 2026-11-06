import { expect, test } from "bun:test";
import { addressPrPrompt, chatPrompt, followUpPrompt, launchPrompt, NO_KILL_BY_NAME } from "../web/src/workstream";

// 2026-11-06: a net-worth-tracker worker ran `pkill -f <text>` to restart its own dev server and
// SIGTERMed another worker's `claude -p` process, whose argv held its own prompt (naming wrangler
// dev, vite, orca-shot). Every worker prompt must tell the agent not to kill by name or pattern.
test("every worker prompt carries the rule: stop a process only by its own PID, never by name or pattern", () => {
  expect(NO_KILL_BY_NAME).toMatch(/pkill/);
  expect(NO_KILL_BY_NAME).toMatch(/killall/);
  expect(NO_KILL_BY_NAME).toMatch(/pgrep/);
  expect(NO_KILL_BY_NAME).toMatch(/PID/);
  expect(NO_KILL_BY_NAME).toContain("orca-run");

  const ws = { title: "T", branch: "feat", prompt: "do it", prNumber: 7 };
  expect(launchPrompt(ws)).toContain(NO_KILL_BY_NAME);
  expect(followUpPrompt("tweak the copy")).toContain(NO_KILL_BY_NAME);
  expect(chatPrompt("Should we handle the empty case?")).toContain(NO_KILL_BY_NAME);
  expect(addressPrPrompt(ws, { base: "main", conflicting: false })).toContain(NO_KILL_BY_NAME);
});
