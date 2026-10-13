// The composer's @ PR picker: typing `@` lists the PRs the board already polled (no extra GitHub
// call), filtered as you type; ↑/↓ + Enter/Tab or a click inserts `#123` (or `repo#123`) at the
// caret, Escape closes it. Pure rules first, then the real composer against the fake api.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatComposer } from "@/components/ChatComposer";
import { filterPrRefs, insertPrRef, prRefLabel, prTrigger, type PrRef } from "@/workstream";

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

// ---- the real composer: keyboard navigation, click, Escape ----

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
let sent: string[] = [];

afterEach(async () => {
  apiFake.reset();
  localStorage.clear();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  sent = [];
});

async function mountComposer() {
  apiFake.prsData = [
    { branch: "auth", number: 6101, title: "Fix auth flow", url: "u", isDraft: false, reviewStatus: "approved" },
    { branch: "bill", number: 6150, title: "Billing page", url: "u", isDraft: true },
  ];
  await act(async () => { await store.refresh(); });
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<ChatComposer repo="r" onSubmit={async (t) => { sent.push(t); }} />);
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
