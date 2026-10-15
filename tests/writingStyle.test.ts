import { describe, expect, test } from "bun:test";
import { OUTCOME_CONTRACT, handoffPrompt } from "../shared/agent";
import { WRITING_STYLE } from "../shared/writingStyle";
import {
  addressPrPrompt, addressReviewPrompt, chatPrompt, followUpPrompt, investigateReportPrompt, launchPrompt,
  orchestratorPrompt, prDescriptionPrompt, promptInstruction, rerunFailedPrompt, resolveCiPrompt, resolveConflictsPrompt,
} from "../web/src/workstream";

// Finn's standing rule: every model Orca prompts writes its human-facing prose in ASD-STE100 STE.
// The rules live in ONE constant; this proves each prompt builder carries it, once.
describe("STE writing standard", () => {
  const ws = { title: "Add rate limit", branch: "feat", prompt: "Add a rate limit.", prNumber: 7 };
  const prompts: Record<string, string> = {
    launch: launchPrompt(ws),
    followUp: followUpPrompt("Also handle the empty case."),
    chat: chatPrompt("What do you think?"),
    investigate: investigateReportPrompt("Why is it slow?"),
    rerun: rerunFailedPrompt({ original: "Add a rate limit." }),
    conflicts: resolveConflictsPrompt(ws, "main"),
    ci: resolveCiPrompt(ws, ["test"]),
    review: addressReviewPrompt(ws),
    addressPr: addressPrPrompt(ws, { base: "main", conflicting: true, ci: {} }),
    prDescription: prDescriptionPrompt({ diff: "+x", commits: ["Add x"] }),
    orchestratorFresh: orchestratorPrompt({ fresh: true, board: "(empty)", messages: ["hi"] }),
    orchestratorResumed: orchestratorPrompt({ fresh: false, board: "(empty)", messages: ["hi"] }),
  };

  for (const [name, prompt] of Object.entries(prompts)) {
    test(`${name} includes the STE rules exactly once`, () => {
      expect(prompt.split(WRITING_STYLE).length - 1).toBe(1);
    });
  }

  test("the rules name STE, the sentence limits, and the scope that keeps code untouched", () => {
    expect(WRITING_STYLE).toContain("ASD-STE100 Simplified Technical English");
    expect(WRITING_STYLE).toContain("at most 20 words in a procedure, at most 25 words in a description");
    expect(WRITING_STYLE).toContain("Do not apply STE to code, identifiers, file paths, commands, hashes, quoted error text or quoted user words");
  });

  test("a handoff keeps the STE rules its wrapped prompt already carries", () => {
    const p = handoffPrompt([], followUpPrompt("Continue."), "codex", "claude");
    expect(p).toContain(WRITING_STYLE);
  });

  test("the chat still shows only the user's words, for new and old contract wording", () => {
    expect(promptInstruction(followUpPrompt("Add a test."))).toBe("Add a test.");
    expect(promptInstruction(`Fix it.\n\n${OUTCOME_CONTRACT}`)).toBe("Fix it.");
    expect(promptInstruction("Fix it.\n\nFinish your final response with these concise sections:\n## Outcome")).toBe("Fix it.");
  });
});
