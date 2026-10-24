// The composer's `/` command menu: a `/` that opens a line lists the commands that apply to this
// chat; typing filters; ↑/↓ + Enter/Tab run one, Escape closes; a `/` mid-sentence or in a path does
// nothing. A command never sends a chat message, and /secret's value never reaches the draft or a
// message. Pure rules first, then the real ChatPanel against the fake api.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import type { Row } from "@/store";
import { ChatPanel } from "@/views/Chat";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, SLASH_COMMANDS, filterSlashCommands, removeSlashQuery, slashActive, slashStep, slashTrigger, type SlashContext } from "@/workstream";

describe("slashTrigger", () => {
  test("fires on a / at a line start or after whitespace, anywhere in the text, up to the caret", () => {
    expect(slashTrigger("/", 1)).toEqual({ start: 0, query: "" });
    expect(slashTrigger("/com", 4)).toEqual({ start: 0, query: "com" });
    expect(slashTrigger("  /st", 5)).toEqual({ start: 2, query: "st" });
    expect(slashTrigger("first line\n/mo", 14)).toEqual({ start: 11, query: "mo" });
    expect(slashTrigger("/clear-q", 8)).toEqual({ start: 0, query: "clear-q" });
    expect(slashTrigger("fix /compact", 12)).toEqual({ start: 4, query: "compact" });
    expect(slashTrigger("please\tdo /se and more", 13)).toEqual({ start: 10, query: "se" }); // caret mid-text
    expect(slashTrigger("ok /", 4)).toEqual({ start: 3, query: "" });
  });
  test("does not fire inside a word, path or URL, after a space in the query, or off its line", () => {
    expect(slashTrigger("see src/a", 9)).toBeNull();
    expect(slashTrigger("a/b", 3)).toBeNull();
    expect(slashTrigger("run ./run.sh", 12)).toBeNull();
    expect(slashTrigger("open https://x/y", 16)).toBeNull();
    expect(slashTrigger("/usr/bin", 8)).toBeNull();
    expect(slashTrigger("./run.sh", 8)).toBeNull();
    expect(slashTrigger("https://x.dev/a", 15)).toBeNull();
    expect(slashTrigger("/compact now", 12)).toBeNull();
    expect(slashTrigger("/st\nnext", 8)).toBeNull();
  });
  test("removeSlashQuery takes out the /query and keeps the rest", () => {
    expect(removeSlashQuery("/sec", 0, 4)).toEqual({ text: "", caret: 0 });
    expect(removeSlashQuery("hi\n/st\nmore", 3, 6)).toEqual({ text: "hi\n\nmore", caret: 3 });
    expect(removeSlashQuery("fix /sec now", 4, 8)).toEqual({ text: "fix  now", caret: 4 }); // only the token
  });
});

const ctx = (over: Partial<SlashContext> = {}): SlashContext => ({
  orchestrator: false, compactable: false, running: false, stoppable: true, attach: true, queued: 0, previews: false, pr: false, mergeQueued: false, ...over,
});
const ids = (c: SlashContext) => SLASH_COMMANDS.filter((x) => x.shows(c)).map((x) => x.id);
const why = (c: SlashContext) => Object.fromEntries(SLASH_COMMANDS.filter((x) => x.shows(c)).map((x) => [x.id, x.unavailable(c)]));

describe("which commands show, and why one is disabled", () => {
  test("every command of the chat's kind shows; the orchestrator never gets the worker-only ones", () => {
    expect(ids(ctx({ orchestrator: true }))).toEqual(["compact", "stop", "clear-queue", "model", "attach", "secret"]);
    expect(ids(ctx())).toEqual(["compact", "stop", "clear-queue", "model", "attach", "secret", "preview", "merge", "rename"]);
  });
  test("a command that does not apply now carries a short reason", () => {
    expect(why(ctx())).toEqual({
      compact: "only after a reply", stop: "nothing is running", "clear-queue": "queue is empty", model: null, attach: null, secret: null,
      preview: "no preview for this repo", merge: "no PR yet", rename: null,
    });
    const busy = why(ctx({ running: true, compactable: true, queued: 2, previews: true, pr: true, mergeQueued: true }));
    expect(busy).toMatchObject({ compact: "wait for the run to end", stop: null, "clear-queue": null, preview: null, merge: "already queued to merge" });
    expect(why(ctx({ compactable: true })).compact).toBeNull();
    expect(why(ctx({ running: true, stoppable: false })).stop).toBe("this run cannot be stopped here");
    expect(why(ctx({ attach: false })).attach).toBe("no attachments here");
  });
  test("slashActive / slashStep skip disabled rows and wrap", () => {
    const off = [true, false, true, false];
    expect(slashActive(off, 0)).toBe(1);
    expect(slashActive(off, 2)).toBe(3);
    expect(slashActive([true, true], 0)).toBe(-1);
    expect(slashStep(off, 1, 1)).toBe(3);
    expect(slashStep(off, 3, 1)).toBe(1);
    expect(slashStep(off, 1, -1)).toBe(3);
  });
  test("filterSlashCommands: a name prefix first, then a name substring, then a description word", () => {
    const all = SLASH_COMMANDS.map((c) => ({ name: c.id, description: c.description }));
    expect(filterSlashCommands(all, "").map((c) => c.name)).toEqual(all.map((c) => c.name));
    expect(filterSlashCommands(all, "c").map((c) => c.name).slice(0, 2)).toEqual(["compact", "clear-queue"]);
    expect(filterSlashCommands(all, "re")[0]!.name).toBe("rename");
    expect(filterSlashCommands(all, "queue").map((c) => c.name)).toEqual(["clear-queue"]);
    expect(filterSlashCommands(all, "files").map((c) => c.name)).toEqual(["attach"]); // "Attach files"
    expect(filterSlashCommands(all, "zzz")).toEqual([]);
  });
});

// ---- the real ChatPanel ----

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
let sent: string[] = [];

const worker: Row = {
  repo: "r", hasRemote: true, branch: "feat", title: "Feat", prompt: "", lane: "IN_REVIEW",
  worktreePath: "/wt/feat", agentProvider: "claude", prNumber: 7,
};
const orchestrator: Row = {
  repo: ORCHESTRATOR_REPO, hasRemote: false, branch: ORCHESTRATOR_BRANCH, title: "Orca", prompt: "", lane: "LOCAL", worktreePath: "/state/orchestrator", agentStatus: "idle",
};

beforeEach(() => { localStorage.clear(); apiFake.reset(); sent = []; });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  document.querySelectorAll('[data-slot="slash-merge"]').forEach((el) => el.remove());
  apiFake.reset();
});

async function mount(row: Row) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<ChatPanel row={row} send={async (t) => { sent.push(t); }} />);
    await flush(); await flush();
  });
  return container.querySelector<HTMLTextAreaElement>('textarea[role="combobox"]')!;
}
const setNative = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
};
async function type(box: HTMLTextAreaElement, text: string) {
  await act(async () => {
    setNative(box, text);
    box.setSelectionRange(text.length, text.length);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}
async function fill(el: HTMLInputElement, text: string) {
  await act(async () => { setNative(el, text); el.dispatchEvent(new Event("input", { bubbles: true })); await flush(); });
}
async function key(box: HTMLTextAreaElement, k: string) {
  await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); await flush(); await flush(); });
}
async function click(el: Element) {
  await act(async () => { (el as HTMLElement).click(); await flush(); await flush(); });
}
const menu = () => container!.querySelector('[data-slot="chat-composer-commands"]');
const names = () => [...container!.querySelectorAll("[data-command]")].map((o) => o.getAttribute("data-command"));
const disabled = () => [...container!.querySelectorAll("[data-command][aria-disabled='true']")].map((o) => o.getAttribute("data-command"));
const reason = (name: string) => container!.querySelector(`[data-command="${name}"] [data-slot="command-reason"]`)?.textContent;
const selected = () => container!.querySelector('[data-command][aria-selected="true"]')?.getAttribute("data-command");

describe("ChatPanel / menu", () => {
  test("a chat lists every command of its kind; one that does not apply is greyed out with its reason", async () => {
    let box = await mount(worker);
    await type(box, "/");
    expect(menu()).not.toBeNull();
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(names()).toEqual(["compact", "stop", "clear-queue", "model", "attach", "secret", "preview", "merge", "rename"]);
    expect(disabled()).toEqual(["compact", "stop", "clear-queue"]); // idle, no queue, nothing to compact
    expect(reason("stop")).toBe("nothing is running");
    expect(reason("clear-queue")).toBe("queue is empty");
    expect(reason("compact")).toBe("only after a reply");
    expect(reason("model")).toBeUndefined();
    expect(selected()).toBe("model"); // the first enabled row
    await act(async () => { root?.unmount(); });
    container?.remove();

    box = await mount(orchestrator);
    await type(box, "/");
    expect(names()).toEqual(["compact", "stop", "clear-queue", "model", "attach", "secret"]); // no /preview, /merge, /rename
  });

  test("Enter or a click on a disabled command does nothing", async () => {
    const box = await mount(worker);
    await type(box, "/stop");
    expect(names()).toEqual(["stop"]);
    expect(disabled()).toEqual(["stop"]);
    expect(box.getAttribute("aria-activedescendant")).toBeNull();
    await key(box, "Enter");
    await click(container!.querySelector('[data-command="stop"]')!);
    expect(apiFake.stopped).toEqual([]);
    expect(box.value).toBe("/stop"); // not taken out, not sent
    expect(sent).toEqual([]);
  });

  test("a merge-queued PR shows /merge disabled with its reason", async () => {
    const box = await mount({ ...worker, autoMergeEnabled: true });
    await type(box, "/mer");
    expect(disabled()).toEqual(["merge"]);
    expect(reason("merge")).toBe("already queued to merge");
  });

  test("stop shows only while the agent runs, and runs api.stopAgent without a message", async () => {
    const box = await mount({ ...worker, agentStatus: "running" });
    await type(box, "/st");
    expect(names()[0]).toBe("stop");
    await key(box, "Enter");
    expect(apiFake.stopped).toEqual(["/wt/feat"]);
    expect(box.value).toBe(""); // the /query is gone
    expect(sent).toEqual([]);
  });

  test("↑/↓ move the active command, skip disabled ones and wrap; Tab runs it; Escape closes the menu", async () => {
    const box = await mount(worker);
    await type(box, "/");
    expect(selected()).toBe("model");
    expect(box.getAttribute("aria-activedescendant")).toBe(container!.querySelector('[data-command="model"]')!.id);
    await key(box, "ArrowDown");
    expect(selected()).toBe("attach");
    await key(box, "ArrowUp");
    await key(box, "ArrowUp"); // past the disabled /compact, /stop, /clear-queue: wraps to the last
    expect(selected()).toBe("rename");
    await key(box, "Escape");
    expect(menu()).toBeNull();
    expect(box.value).toBe("/"); // Escape keeps the text
    await key(box, "Enter"); // the menu is closed: Enter sends the text as typed
    expect(sent).toEqual(["/"]);
  });

  test("typing filters the list; a / inside a word, path or URL opens nothing", async () => {
    const box = await mount(worker);
    await type(box, "/ren");
    expect(names()).toEqual(["rename"]);
    await type(box, "/zzz");
    expect(menu()).toBeNull();
    await type(box, "look at /usr/bin");
    expect(menu()).toBeNull();
    for (const t of ["src/a", "see a/b", "run ./run.sh", "open https://x/y"]) {
      await type(box, t);
      expect(menu()).toBeNull();
    }
    await type(box, "@");
    expect(menu()).toBeNull(); // the @ picker's trigger is not the command menu's
  });

  test("a / mid-sentence opens the menu; a pick takes out only the /query and keeps the rest", async () => {
    const box = await mount(worker);
    let clicked = 0;
    container!.querySelector<HTMLInputElement>('input[type="file"]')!.click = () => { clicked++; };
    const text = "see the log /att and the diff";
    const caret = "see the log /att".length;
    await act(async () => {
      setNative(box, text);
      box.setSelectionRange(caret, caret);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    expect(menu()).not.toBeNull();
    expect(names()).toEqual(["attach"]);
    await key(box, "Enter");
    expect(clicked).toBe(1);
    expect(box.value).toBe("see the log  and the diff");
    expect(box.selectionStart).toBe("see the log ".length);
    expect(sent).toEqual([]);
  });

  test("clear-queue drops every queued message and does not put it back in the box", async () => {
    apiFake.queuedData.set("feat", [{ id: 1, instruction: "one", attachments: [] }, { id: 2, instruction: "two", attachments: [] }]);
    const box = await mount({ ...worker, agentStatus: "running" });
    await type(box, "/clear");
    expect(names()).toEqual(["clear-queue"]);
    await key(box, "Enter");
    await act(async () => { await flush(); await flush(); });
    expect(apiFake.queuedData.get("feat")).toEqual([]);
    expect(box.value).toBe("");
    expect(sent).toEqual([]);
  });

  test("model opens the model picker; attach opens the file picker", async () => {
    const box = await mount(worker);
    await type(box, "/model");
    await key(box, "Enter");
    expect(container!.querySelector('[aria-label="Model"]')!.getAttribute("aria-expanded")).toBe("true");
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(); });

    let clicked = 0;
    const file = container!.querySelector<HTMLInputElement>('input[type="file"]')!;
    file.click = () => { clicked++; };
    await type(box, "/att");
    await key(box, "Tab");
    expect(clicked).toBe(1);
    expect(sent).toEqual([]);
  });

  test("compact is enabled where the context ring offers Compact, and runs api.compact", async () => {
    let box = await mount(worker);
    await type(box, "/comp");
    expect(disabled()).toEqual(["compact"]); // no context reading: no Compact today
    expect(reason("compact")).toBe("only after a reply");
    await act(async () => { root?.unmount(); });
    container?.remove();
    localStorage.clear(); // the first box saved "/comp" as its draft

    box = await mount({ ...worker, agentMeta: { model: "claude-opus-5-5", contextPct: 60 } } as Row);
    await type(box, "/comp");
    expect(names()).toEqual(["compact"]);
    await key(box, "Enter");
    expect(apiFake.calls).toContain("compact:r:feat");
    expect(sent).toEqual([]);
  });

  test("preview starts the workstream's preview when none runs", async () => {
    const box = await mount(worker);
    await type(box, "/prev");
    await key(box, "Enter");
    await act(async () => { await flush(); await flush(); });
    expect(apiFake.previewCalls.length).toBe(1);
    expect(container!.querySelector('[data-slot="slash-notice"]')?.textContent).toContain("Preview started");
    expect(sent).toEqual([]);
  });

  test("rename opens the rename dialog, seeded with the title", async () => {
    const box = await mount(worker);
    await type(box, "/rename");
    await key(box, "Enter");
    const field = container!.querySelector<HTMLInputElement>('input[aria-label="Card title"]');
    expect(field?.value).toBe("Feat");
    expect(sent).toEqual([]);
  });

  test("merge asks first, then marks the PR merge-when-green", async () => {
    const box = await mount(worker);
    await type(box, "/merge");
    await key(box, "Enter");
    const confirm = document.querySelector('[data-slot="slash-merge-confirm"]');
    expect(confirm).not.toBeNull();
    expect(apiFake.calls.some((c) => c.startsWith("mergeWhenGreen"))).toBe(false);
    await click(confirm!);
    expect(apiFake.calls).toContain("mergeWhenGreen:7:feat");
    expect(sent).toEqual([]);
  });

  const textBox = () => container!.querySelector<HTMLTextAreaElement>('textarea[role="combobox"]');
  const widget = () => container!.querySelector('[data-slot="chat-composer-top"] [data-slot="slash-secret"]');
  const collapse = () => container!.querySelector('[data-slot="collapse"]');
  const closed = () => new Promise((r) => setTimeout(r, 250)); // the close transition (COLLAPSE_MS) ends
  const noSecretStored = () => { for (let i = 0; i < localStorage.length; i++) expect(localStorage.getItem(localStorage.key(i)!) ?? "").not.toContain("TOPSECRET"); };

  test("/secret opens a card inside the box, above the text; the text and toolbar stay; Enter in the card saves", async () => {
    const box = await mount(worker);
    await type(box, "/sec");
    await key(box, "Enter");
    // In the composer's box, not a modal and not in the box's place: the text and Send are still there.
    expect(widget()).not.toBeNull();
    expect(textBox()).not.toBeNull();
    expect(container!.querySelector('[data-slot="chat-composer-toolbar"] button[aria-label="Send"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    const top = container!.querySelector('[data-slot="chat-composer-top"]')!;
    expect(top.compareDocumentPosition(textBox()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // above the text
    expect(collapse()!.getAttribute("data-state")).toBe("open");
    const name = container!.querySelector<HTMLInputElement>('[data-slot="slash-secret-name"]')!;
    expect(document.activeElement).toBe(name);
    const value = container!.querySelector<HTMLInputElement>("#slash-secret-value")!;
    expect(value.type).toBe("password");
    // Tab goes Name → Value → Save → the text: the reveal toggle and ✕ are out of the Tab order.
    expect(container!.querySelector<HTMLElement>('[data-slot="form-secret-reveal"]')!.tabIndex).toBe(-1);
    expect(container!.querySelector<HTMLElement>('[data-slot="slash-secret-cancel"]')!.tabIndex).toBe(-1);
    await click(container!.querySelector('[data-slot="form-secret-reveal"]')!);
    expect(value.type).toBe("text");
    await fill(name, "stripe-key");
    await fill(value, "sk_live_TOPSECRET123");
    // Enter in a field submits its form (implicit submission): the form's submit is the save.
    await act(async () => { value.form!.requestSubmit(); await flush(); await flush(); });
    expect(apiFake.secretSaves).toEqual([{ name: "stripe-key", scope: "chat", value: "sk_live_TOPSECRET123" }]);
    // The card collapses (closed, then gone once the transition ends); the text has the focus.
    expect(collapse()!.getAttribute("data-state")).toBe("closed");
    expect(document.activeElement).toBe(textBox());
    await act(async () => { await closed(); });
    expect(widget()).toBeNull();
    expect(collapse()).toBeNull();
    const chip = container!.querySelector('[data-slot="slash-notice"]')!;
    expect(chip.textContent).toContain("chat/stripe-key");
    // Nowhere else: not the box, not the persisted draft, not a sent message, not the page.
    expect(textBox()!.value).toBe("");
    noSecretStored();
    expect(sent).toEqual([]);
    expect(document.body.innerHTML).not.toContain("TOPSECRET");
  });

  test("/secret: with the card open, the text takes typing and Enter there sends the draft only", async () => {
    const box = await mount(worker);
    await type(box, "/secret");
    await key(box, "Enter");
    const value = container!.querySelector<HTMLInputElement>("#slash-secret-value")!;
    await fill(container!.querySelector<HTMLInputElement>('[data-slot="slash-secret-name"]')!, "db-pass");
    await fill(value, "sk_live_TOPSECRET123");
    // Click into the text and type: the card stays open with its fields as they were.
    await act(async () => { textBox()!.focus(); await flush(); });
    await type(textBox()!, "please check the build");
    expect(widget()).not.toBeNull();
    expect(textBox()!.value).toBe("please check the build");
    noSecretStored();
    await key(textBox()!, "Enter");
    expect(sent).toEqual(["please check the build"]);
    expect(apiFake.secretSaves).toEqual([]);
    expect(widget()).not.toBeNull(); // a send does not close the card
    expect(value.value).toBe("sk_live_TOPSECRET123");
    noSecretStored();
  });

  test("/secret: Esc closes the card, saves nothing and keeps the draft", async () => {
    const box = await mount(worker);
    await type(box, "keep this draft\n/secret");
    await key(box, "Enter");
    expect(widget()).not.toBeNull();
    const value = container!.querySelector<HTMLInputElement>("#slash-secret-value")!;
    await fill(value, "sk_live_TOPSECRET123");
    await act(async () => { value.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await flush(); await flush(); });
    expect(collapse()!.getAttribute("data-state")).toBe("closed");
    await act(async () => { await closed(); });
    expect(widget()).toBeNull();
    expect(apiFake.secretSaves).toEqual([]);
    expect(textBox()!.value).toBe("keep this draft\n");
    expect(document.activeElement).toBe(textBox());
    expect(textBox()!.selectionStart).toBe("keep this draft\n".length);
    noSecretStored();
    // Send the draft: the message is the draft only.
    await key(textBox()!, "Enter");
    expect(sent).toEqual(["keep this draft"]);
    expect(document.body.innerHTML).not.toContain("TOPSECRET");
  });
});
