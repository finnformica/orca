// Orca's ONE writing standard for human-facing prose a model writes: ASD-STE100 Simplified Technical
// English (STE). Finn asked for it ALWAYS, so every prompt Orca sends includes this block — worker
// launches and follow-ups (through `withOutcomeContract` and `chatPrompt`), the orchestrator's every
// wake, and the PR description. Edit the rules here, never a copy of them in a prompt.

/** The STE rules, as a prompt section. Prose only: code and quoted text keep their exact form. */
export const WRITING_STYLE = [
  "## Writing",
  "Write all prose for humans in ASD-STE100 Simplified Technical English (STE): replies, reports, outcome sections, PR titles and descriptions, commit messages, review replies and notes.",
  "- Use simple words with one meaning each. Technical names and technical verbs are allowed (PR, commit, branch, merge, CI, deploy).",
  "- Use one name for each thing. Do not change the name later.",
  "- Keep sentences short: at most 20 words in a procedure, at most 25 words in a description.",
  "- Write one instruction in each sentence. Write instructions as commands (\"Run the tests.\").",
  "- Use the active voice and simple tenses. Do not use -ing words as nouns or adjectives. Do not hedge with \"would\" or \"could\".",
  "- Keep paragraphs short. Use a numbered list for steps and a bulleted list for other sequences.",
  "- Do not apply STE to code, identifiers, file paths, commands, hashes, quoted error text or quoted user words. Keep those exactly as they are.",
].join("\n");

/** When to emit a snippet block: the chat renders each fenced block as a card with one Copy button
 *  (web/src/components/Snippet.tsx). Worker prompts and every orchestrator wake carry it — NOT the PR
 *  description prompt, whose whole output is the text to paste. */
export const SNIPPETS = [
  "## Snippets",
  "Put text that the user will paste in a fenced code block: commands, PR text, plans and config. The chat shows each block with a Copy button.",
  "- Give the language after the fence. Add a title when it helps: ```bash title=Deploy",
  "- Use ```plan or ```md for a plan or PR text. The chat shows it as formatted text, and Copy gives the markdown.",
].join("\n");
