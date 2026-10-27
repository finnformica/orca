// The composer's @ PR picker: typing `@` lists the PRs the board already polled (no extra GitHub
// call), filtered as you type; ↑/↓ + Enter/Tab or a click inserts `#123` (or `repo#123`) at the
// caret, Escape closes it. Pure rules first, then the real composer against the fake api.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatComposer } from "@/components/ChatComposer";
import { Shortcuts } from "@/components/CommandPalette";
import { filterAgentMentions, filterMentions, filterPrRefs, filterWorkstreamRefs, insertPrRef, mentionLabel, prRefLabel, prTrigger, sentToLabel, workstreamRefLabel, type AgentMention, type PrRef, type WorkstreamRef } from "@/workstream";

describe("prTrigger", () => {
  test("fires on an @ at the start, after whitespace or a bracket, up to the caret", () => {
    expect(prTrigger("@", 1)).toEqual({ start: 0, query: "" });
    expect(prTrigger("see @61", 7)).toEqual({ start: 4, query: "61" });
    expect(prTrigger("fix (@6", 7)).toEqual({ start: 5, query: "6" });
    expect(prTrigger("line one\n@auth fl", 17)).toEqual({ start: 9, query: "auth fl" }); // title words
    expect(prTrigger("see @61 and more", 7)).toEqual({ start: 4, query: "61" }); // caret mid-text
  });
  test("does not fire inside a word, an email, a URL, after a lone @, or once the caret leaves the line", () => {
    expect(prTrigger("a@1", 3)).toBeNull();
    expect(prTrigger("me@x.dev", 8)).toBeNull();
    expect(prTrigger("https://x.dev/@user", 19)).toBeNull();
    expect(prTrigger("@ spaced", 8)).toBeNull();
    expect(prTrigger("@12\nnext", 8)).toBeNull();
    expect(prTrigger("no at here", 10)).toBeNull();
  });
  test("# no longer triggers it — a PR ref is still written #123, but you type @ to pick one", () => {
    expect(prTrigger("#", 1)).toBeNull();
    expect(prTrigger("see #61", 7)).toBeNull();
  });
});

const refs: PrRef[] = [
  { repo: "web", number: 6090, title: "Old merged thing", state: "merged", mergedAt: "2026-10-01T00:00:00Z" },
  { repo: "web", number: 6101, title: "Fix auth flow", state: "open" },
  { repo: "web", number: 6150, title: "Draft: billing page", state: "draft" },
  { repo: "web", number: 6095, title: "Newer merged", state: "merged", mergedAt: "2026-10-10T00:00:00Z" },
  { repo: "api", number: 42, title: "Auth tokens", state: "approved" },
];

describe("filterPrRefs", () => {
  test("open before merged; open newest number first, merged most recent first", () => {
    expect(filterPrRefs(refs, "").map((r) => r.number)).toEqual([6150, 6101, 42, 6095, 6090]);
  });
  test("each word prefixes the number, the repo or a title word", () => {
    expect(filterPrRefs(refs, "61").map((r) => r.number)).toEqual([6150, 6101]);
    expect(filterPrRefs(refs, "auth").map((r) => r.number)).toEqual([6101, 42]);
    expect(filterPrRefs(refs, "auth fl").map((r) => r.number)).toEqual([6101]);
    expect(filterPrRefs(refs, "api").map((r) => r.number)).toEqual([42]);
    expect(filterPrRefs(refs, "nothing")).toEqual([]);
  });
});

describe("prRefLabel + insertPrRef", () => {
  test("bare #n unless another repo has the number or the composer is about another repo", () => {
    const one = [refs[1]!];
    expect(prRefLabel(refs[1]!, one, 1)).toBe("#6101"); // one repo: never qualified
    expect(prRefLabel(refs[1]!, refs, 2, "web")).toBe("#6101"); // its own repo's chat
    expect(prRefLabel(refs[1]!, refs, 2, "api")).toBe("web#6101"); // another repo's chat
    expect(prRefLabel(refs[1]!, refs, 2)).toBe("web#6101"); // the orchestrator: no repo of its own
    const clash = [...refs, { repo: "api", number: 6101, title: "Same number", state: "open" as const }];
    expect(prRefLabel(refs[1]!, clash, 2, "web")).toBe("web#6101");
  });
  test("replaces the typed @query at the caret and adds a space unless one follows", () => {
    expect(insertPrRef("see @61", 4, 7, "#6101")).toEqual({ text: "see #6101 ", caret: 10 });
    expect(insertPrRef("see @61 now", 4, 7, "#6101")).toEqual({ text: "see #6101 now", caret: 9 });
    expect(insertPrRef("@", 0, 1, "web#6101")).toEqual({ text: "web#6101 ", caret: 9 });
  });
});

const wsRefs: WorkstreamRef[] = [
  { repo: "web", branch: "orca/local-search-1a2b", title: "Local search", instance: "local" },
  { repo: "web", branch: "auth-flow", title: "Fix auth flow", prNumber: 6101 }, // has a PR: listed as #6101
  { repo: "api", branch: "rate-limits", title: "Rate limits", instance: "cloud" },
];

describe("workstream refs", () => {
  test("filterWorkstreamRefs: each word starts at a word boundary of the repo, the branch or the title", () => {
    expect(filterWorkstreamRefs(wsRefs, "").map((r) => r.branch)).toEqual(["orca/local-search-1a2b", "auth-flow", "rate-limits"]);
    expect(filterWorkstreamRefs(wsRefs, "orca/loc").map((r) => r.branch)).toEqual(["orca/local-search-1a2b"]); // whole branch
    expect(filterWorkstreamRefs(wsRefs, "search").map((r) => r.branch)).toEqual(["orca/local-search-1a2b"]); // branch word
    expect(filterWorkstreamRefs(wsRefs, "local-se").map((r) => r.branch)).toEqual(["orca/local-search-1a2b"]); // across branch words
    expect(filterWorkstreamRefs(wsRefs, "earch")).toEqual([]); // not mid-word
    expect(filterWorkstreamRefs(wsRefs, "rate lim").map((r) => r.branch)).toEqual(["rate-limits"]); // title words
    expect(filterWorkstreamRefs(wsRefs, "api").map((r) => r.branch)).toEqual(["rate-limits"]); // repo
    expect(filterWorkstreamRefs(wsRefs, "nothing")).toEqual([]);
  });
  test("workstreamRefLabel: the branch in backticks, `repo/branch` for the orchestrator or another repo of several", () => {
    const ws = wsRefs[0]!;
    expect(workstreamRefLabel(ws, 1, "web")).toBe("`orca/local-search-1a2b`");
    expect(workstreamRefLabel(ws, 2, "web")).toBe("`orca/local-search-1a2b`"); // its own repo's chat
    expect(workstreamRefLabel(ws, 2, "api")).toBe("`web/orca/local-search-1a2b`");
    expect(workstreamRefLabel(ws, 1)).toBe("`web/orca/local-search-1a2b`"); // the orchestrator: the board's name
    expect(mentionLabel({ kind: "workstream", ref: ws }, refs, 1)).toBe("`web/orca/local-search-1a2b`");
    expect(mentionLabel({ kind: "pr", ref: refs[1]! }, refs, 1)).toBe("#6101");
    expect(insertPrRef("see @loc", 4, 8, "`web/orca/local-search-1a2b`")).toEqual({ text: "see `web/orca/local-search-1a2b` ", caret: 33 });
  });
  test("filterMentions: open PRs, then workstreams with no listed PR, then merged; a workstream with a PR shows once", () => {
    const label = (m: ReturnType<typeof filterMentions>[number]) => (m.kind === "pr" ? `#${m.ref.number}` : m.kind === "agent" ? `@${m.ref.name}` : m.ref.branch);
    expect(filterMentions(refs, wsRefs, "").map(label)).toEqual(["#6150", "#6101", "#42", "orca/local-search-1a2b", "rate-limits", "#6095", "#6090"]);
    expect(filterMentions(refs, wsRefs, "auth").map(label)).toEqual(["#6101", "#42"]); // auth-flow is #6101
    // Its PR not in the list (e.g. not polled yet): the workstream itself shows.
    expect(filterMentions([], wsRefs, "auth").map(label)).toEqual(["auth-flow"]);
    expect(filterMentions(refs, wsRefs, "", 4)).toHaveLength(4);
  });

  // A PR whose title doesn't name its workstream (the bug: "More item check rules" / branch-demo
  // #6361 "feat: add compare, date, pattern checks" didn't show for a query on the workstream title).
  const titleRefs: PrRef[] = [...refs, { repo: "web", number: 6361, title: "feat: add compare, date, pattern checks", state: "open" }];
  const titleWsRefs: WorkstreamRef[] = [...wsRefs, { repo: "web", branch: "orca/item-check-rules-9f3a21", title: "More item check rules", prNumber: 6361 }];
  const label = (m: ReturnType<typeof filterMentions>[number]) => (m.kind === "pr" ? `#${m.ref.number}` : m.kind === "agent" ? `@${m.ref.name}` : m.ref.branch);

  test("filterMentions: a PR pick also matches its workstream's title", () => {
    expect(filterMentions(titleRefs, titleWsRefs, "more item").map(label)).toEqual(["#6361"]);
    expect(filterMentions(titleRefs, titleWsRefs, "check rules").map(label)).toEqual(["#6361"]);
  });

  test("filterMentions: a PR pick also matches its workstream's branch", () => {
    expect(filterMentions(titleRefs, titleWsRefs, "item-check").map(label)).toEqual(["#6361"]);
    expect(filterMentions(titleRefs, titleWsRefs, "9f3a21").map(label)).toEqual(["#6361"]);
  });

  test("filterMentions: the workstream-title match is still one row, not a duplicate workstream row", () => {
    const hits = filterMentions(titleRefs, titleWsRefs, "more item");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ kind: "pr", ref: titleRefs[5]! });
  });

  test("filterMentions: current ordering is kept (open PRs, then no-PR workstreams, then merged)", () => {
    expect(filterMentions(titleRefs, titleWsRefs, "").map(label))
      .toEqual(["#6361", "#6150", "#6101", "#42", "orca/local-search-1a2b", "rate-limits", "#6095", "#6090"]);
  });
});

// ---- the real composer: keyboard navigation, click, Escape ----

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
let sent: string[] = [];
let opened: string[] = [];

afterEach(async () => {
  apiFake.reset();
  localStorage.clear();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  sent = [];
  opened = [];
});

async function mountComposer(shortcuts = false, agents?: AgentMention[], onSubmit?: (t: string, f: File[], to: string[]) => Promise<void>) {
  apiFake.prsData = [
    { branch: "auth", number: 6101, title: "Fix auth flow", url: "u", isDraft: false, reviewStatus: "approved" },
    { branch: "bill", number: 6150, title: "Billing page", url: "u", isDraft: true },
  ];
  await act(async () => { await store.refresh(); });
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<>{shortcuts && <Shortcuts />}<ChatComposer repo="r" agents={agents} onOpenAgent={(n) => { opened.push(n); }} onSubmit={onSubmit ?? (async (t) => { sent.push(t); })} /></>);
    await flush();
  });
  return container.querySelector("textarea")!;
}
async function type(box: HTMLTextAreaElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.setSelectionRange(text.length, text.length);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}
async function key(box: HTMLTextAreaElement, k: string) {
  await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); await flush(); });
}
const options = () => [...container!.querySelectorAll('[role="option"]')];
const selected = () => container!.querySelector('[role="option"][aria-selected="true"]');

describe("ChatComposer @ picker", () => {
  test("↑/↓ move the active option (aria-activedescendant), Enter inserts it instead of sending", async () => {
    const box = await mountComposer();
    await type(box, "look at @");
    expect(container!.querySelector('[role="listbox"]')).not.toBeNull();
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(options().map((o) => o.textContent)).toEqual(["#6150Billing pagedraft", "#6101Fix auth flowapproved"]);
    expect(box.getAttribute("aria-activedescendant")).toBe(selected()!.id);

    await key(box, "ArrowDown");
    expect(selected()!.textContent).toContain("6101");
    expect(box.getAttribute("aria-activedescendant")).toBe(selected()!.id);
    await key(box, "ArrowDown"); // wraps
    expect(selected()!.textContent).toContain("6150");
    await key(box, "ArrowUp"); // wraps back
    expect(selected()!.textContent).toContain("6101");

    await key(box, "Enter");
    expect(box.value).toBe("look at #6101 ");
    expect(sent).toEqual([]); // Enter picked, it didn't send
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
    expect(box.getAttribute("aria-expanded")).toBe("false");
  });

  test("filters as you type; Tab picks; a click picks", async () => {
    const box = await mountComposer();
    await type(box, "@bill");
    expect(options()).toHaveLength(1);
    await key(box, "Tab");
    expect(box.value).toBe("#6150 ");

    await type(box, "and @fix");
    await act(async () => { options()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    expect(box.value).toBe("and #6101 ");
  });

  test("Escape closes it for that @, and Enter then sends as usual", async () => {
    const box = await mountComposer();
    await type(box, "ship @61");
    expect(options()).toHaveLength(2);
    await key(box, "Escape");
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
    await type(box, "ship @610"); // still the dismissed @
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
    await type(box, "ship "); // that @ is gone…
    await type(box, "ship @6"); // …so a new one at the same spot re-arms it
    expect(options()).toHaveLength(2);
    await key(box, "Escape");
    await key(box, "Enter");
    expect(sent).toEqual(["ship @6"]);
  });

  test("Esc closes the picker first and keeps you typing; the next Esc leaves the field (the one Shortcuts listener)", async () => {
    const box = await mountComposer(true);
    box.focus();
    await type(box, "ship @61");
    await key(box, "Escape");
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(box); // the picker consumed it
    await key(box, "Escape");
    expect(document.activeElement).not.toBe(box); // nothing else did: blurred, the draft kept
    expect(box.value).toBe("ship @61");
  });

  test("a worktree with no PR is listed as a workstream; a pick inserts its branch", async () => {
    apiFake.agentsData = [{ branch: "orca/local-search", worktreePath: "/wt/local-search", agentStatus: "idle" }];
    const box = await mountComposer();
    await type(box, "see @local");
    expect(options().map((o) => o.textContent)).toEqual(["orca/local-search"]);
    await key(box, "Enter");
    expect(box.value).toBe("see `orca/local-search` ");
    await type(box, "@fix"); // auth's PR row: once, as its PR
    expect(options().map((o) => o.textContent)).toEqual(["#6101Fix auth flowapproved"]);
  });

  test("an @ inside a word or URL opens nothing, and # opens nothing at all", async () => {
    const box = await mountComposer();
    await type(box, "https://x.dev/@6");
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
    await type(box, "abc@6");
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
    await type(box, "look at #");
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
    await type(box, "#61");
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
  });
});

// Named agents in the `@` picker (the orchestrator's panel and quick-ask): listed first, and a pick
// is a recipient chip, not text.
const team: AgentMention[] = [
  { name: "chief", displayName: "Chief of Staff" },
  { name: "research", displayName: "Research" },
  { name: "assistant", displayName: "Assistant" },
];

describe("agent mentions (pure)", () => {
  test("filterAgentMentions: each word starts the name or a display-name word", () => {
    expect(filterAgentMentions(team, "").map((a) => a.name)).toEqual(["chief", "research", "assistant"]);
    expect(filterAgentMentions(team, "res").map((a) => a.name)).toEqual(["research"]);
    expect(filterAgentMentions(team, "staff").map((a) => a.name)).toEqual(["chief"]);
    expect(filterAgentMentions(team, "@as").map((a) => a.name)).toEqual(["assistant"]);
    expect(filterAgentMentions(team, "earch")).toEqual([]); // not mid-word
  });
  test("filterMentions: agents first on a match, then the PR/workstream order; none without the agents argument", () => {
    const agentsFirst = filterMentions(refs, wsRefs, "", 8, team);
    expect(agentsFirst.slice(0, 3).map((m) => m.kind)).toEqual(["agent", "agent", "agent"]);
    expect(agentsFirst.slice(3).map((m) => m.kind === "pr" ? `#${m.ref.number}` : m.kind)).toEqual(["#6150", "#6101", "#42", "workstream", "workstream"]);
    expect(filterMentions(refs, wsRefs, "auth").every((m) => m.kind !== "agent")).toBe(true);
    // An agent that also matches still comes first: `a` hits Assistant and the `api` PR.
    expect(filterMentions(refs, wsRefs, "a", 8, team).map((m) => m.kind === "agent" ? m.ref.name : m.kind)[0]).toBe("assistant");
    expect(mentionLabel({ kind: "agent", ref: team[1]! }, refs, 1)).toBe("@research");
  });
  test("sentToLabel joins names in plain words", () => {
    expect(sentToLabel(["Research"])).toBe("Research");
    expect(sentToLabel(["Research", "Assistant"])).toBe("Research and Assistant");
    expect(sentToLabel(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("ChatComposer @ agent recipients", () => {
  const chips = () => [...container!.querySelectorAll<HTMLElement>('[data-attachment="agent"]')];

  test("a workstream chat (no agents) lists no agent", async () => {
    const box = await mountComposer();
    await type(box, "@");
    expect(container!.querySelector('[data-mention="agent"]')).toBeNull();
  });

  test("an agent pick removes the @query and adds a 'To …' chip with its avatar; ✕ removes it", async () => {
    const box = await mountComposer(false, team);
    await type(box, "please @res");
    expect(options()[0]!.getAttribute("data-mention")).toBe("agent");
    expect(options()[0]!.textContent).toBe("Research@research");
    expect(options()[0]!.querySelector('svg[data-slot="agent-avatar"]')).not.toBeNull();
    await key(box, "Enter");
    expect(box.value).toBe("please ");
    expect(chips().map((c) => c.textContent)).toEqual(["To Research"]);
    expect(chips()[0]!.querySelector('svg[data-slot="agent-avatar"][data-agent="research"]')).not.toBeNull();
    // A second pick of the same agent adds no second chip.
    await type(box, "please @res");
    await key(box, "Enter");
    expect(chips()).toHaveLength(1);
    await act(async () => { chips()[0]!.querySelector<HTMLElement>('[data-slot="composer-attachment-remove"]')!.click(); await flush(); });
    expect(chips()).toHaveLength(0);
  });

  test("the send passes the chosen names, clears the chips and shows 'Sent to … · Open'", async () => {
    const got: { text: string; to: string[] }[] = [];
    const box = await mountComposer(false, team, async (text, _f, to) => { got.push({ text, to }); });
    await type(box, "@res");
    await key(box, "Enter");
    await type(box, "@ass");
    await key(box, "Enter");
    await type(box, "dig into the flake");
    await key(box, "Enter");
    expect(got).toEqual([{ text: "dig into the flake", to: ["research", "assistant"] }]);
    expect(chips()).toHaveLength(0);
    const receipt = container!.querySelector('[data-slot="chat-composer-sent-to"]')!;
    expect(receipt.textContent).toBe("Sent to Research and Assistant·Open");
    await act(async () => { receipt.querySelector("button")!.click(); await flush(); });
    expect(opened).toEqual(["research"]);
    expect(container!.querySelector('[data-slot="chat-composer-sent-to"]')).toBeNull();
  });

  test("typed @name text with no chip stays text and sends with no recipients", async () => {
    const got: string[][] = [];
    const box = await mountComposer(false, team, async (_t, _f, to) => { got.push(to); });
    await type(box, "ask @research");
    await key(box, "Escape");
    await key(box, "Enter");
    expect(got).toEqual([[]]);
    expect(container!.querySelector('[data-slot="chat-composer-sent-to"]')).toBeNull();
  });

  test("a failed send gives the chips back", async () => {
    const box = await mountComposer(false, team, async () => { throw new Error("bridge down"); });
    await type(box, "@res");
    await key(box, "Enter");
    await type(box, "hello");
    await key(box, "Enter");
    expect(box.value).toBe("hello");
    expect(chips().map((c) => c.textContent)).toEqual(["To Research"]);
  });
});
