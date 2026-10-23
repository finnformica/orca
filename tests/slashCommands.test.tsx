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
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, SLASH_COMMANDS, filterSlashCommands, removeSlashQuery, slashTrigger, type SlashContext } from "@/workstream";

describe("slashTrigger", () => {
  test("fires on a / that opens a line, after leading whitespace, up to the caret", () => {
    expect(slashTrigger("/", 1)).toEqual({ start: 0, query: "" });
    expect(slashTrigger("/com", 4)).toEqual({ start: 0, query: "com" });
    expect(slashTrigger("  /st", 5)).toEqual({ start: 2, query: "st" });
    expect(slashTrigger("first line\n/mo", 14)).toEqual({ start: 11, query: "mo" });
    expect(slashTrigger("/clear-q", 8)).toEqual({ start: 0, query: "clear-q" });
  });
  test("does not fire mid-sentence, in a path, after a space in the query, or off its line", () => {
    expect(slashTrigger("fix /compact", 12)).toBeNull();
    expect(slashTrigger("see src/a", 9)).toBeNull();
    expect(slashTrigger("/usr/bin", 8)).toBeNull();
    expect(slashTrigger("./run.sh", 8)).toBeNull();
    expect(slashTrigger("https://x.dev/a", 15)).toBeNull();
    expect(slashTrigger("/compact now", 12)).toBeNull();
    expect(slashTrigger("/st\nnext", 8)).toBeNull();
  });
  test("removeSlashQuery takes out the /query and keeps the rest", () => {
    expect(removeSlashQuery("/sec", 0, 4)).toEqual({ text: "", caret: 0 });
    expect(removeSlashQuery("hi\n/st\nmore", 3, 6)).toEqual({ text: "hi\n\nmore", caret: 3 });
  });
});

const ctx = (over: Partial<SlashContext> = {}): SlashContext => ({
  orchestrator: false, compactable: false, running: false, stoppable: true, attach: true, queued: 0, previews: false, pr: false, mergeQueued: false, ...over,
});
const ids = (c: SlashContext) => SLASH_COMMANDS.filter((x) => x.applies(c)).map((x) => x.id);

describe("where each command applies", () => {
  test("the orchestrator never gets the worker-only commands", () => {
    expect(ids(ctx({ orchestrator: true, previews: true, pr: true }))).toEqual(["model", "attach", "secret"]);
    expect(ids(ctx({ previews: true, pr: true }))).toEqual(["model", "attach", "secret", "preview", "merge", "rename"]);
  });
  test("stop only while it runs, compact only when offered and idle, clear-queue only with a queue", () => {
    expect(ids(ctx({ running: true, compactable: true, queued: 2 }))).toEqual(["stop", "clear-queue", "model", "attach", "secret", "rename"]);
    expect(ids(ctx({ compactable: true }))).toContain("compact");
    expect(ids(ctx({ running: true, stoppable: false }))).not.toContain("stop");
    expect(ids(ctx({ pr: true, mergeQueued: true }))).not.toContain("merge");
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
const selected = () => container!.querySelector('[data-command][aria-selected="true"]')?.getAttribute("data-command");

describe("ChatPanel / menu", () => {
  test("a worker chat lists its commands; the orchestrator's hides the worker-only ones", async () => {
    let box = await mount(worker);
    await type(box, "/");
    expect(menu()).not.toBeNull();
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(names()).toEqual(["model", "attach", "secret", "preview", "merge", "rename"]); // idle, no queue, nothing to compact
    await act(async () => { root?.unmount(); });
    container?.remove();

    box = await mount(orchestrator);
    await type(box, "/");
    expect(names()).toEqual(["model", "attach", "secret"]);
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

  test("↑/↓ move the active command and wrap; Tab runs it; Escape closes the menu", async () => {
    const box = await mount(worker);
    await type(box, "/");
    expect(selected()).toBe("model");
    expect(box.getAttribute("aria-activedescendant")).toBe(container!.querySelector('[data-command="model"]')!.id);
    await key(box, "ArrowDown");
    expect(selected()).toBe("attach");
    await key(box, "ArrowUp");
    await key(box, "ArrowUp"); // wraps to the last
    expect(selected()).toBe("rename");
    await key(box, "Escape");
    expect(menu()).toBeNull();
    expect(box.value).toBe("/"); // Escape keeps the text
    await key(box, "Enter"); // the menu is closed: Enter sends the text as typed
    expect(sent).toEqual(["/"]);
  });

  test("typing filters the list; a / mid-sentence or in a path opens nothing", async () => {
    const box = await mount(worker);
    await type(box, "/ren");
    expect(names()).toEqual(["rename"]);
    await type(box, "/zzz");
    expect(menu()).toBeNull();
    await type(box, "look at /usr/bin");
    expect(menu()).toBeNull();
    await type(box, "src/a");
    expect(menu()).toBeNull();
    await type(box, "@");
    expect(menu()).toBeNull(); // the @ picker's trigger is not the command menu's
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

  test("compact shows where the context ring offers Compact, and runs api.compact", async () => {
    let box = await mount(worker);
    await type(box, "/comp");
    expect(menu()).toBeNull(); // no context reading: no Compact today, so no /compact
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
  const widget = () => container!.querySelector('[data-slot="chat-composer-replaced"] [data-slot="slash-secret"]');

  test("/secret opens an inline widget in the box's place; Enter saves; the value never enters the box, the draft or a message", async () => {
    const box = await mount(worker);
    await type(box, "/sec");
    await key(box, "Enter");
    // In the composer, not a modal: the box is gone while the widget is open, and Name has focus.
    expect(widget()).not.toBeNull();
    expect(textBox()).toBeNull();
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    const name = container!.querySelector<HTMLInputElement>('[data-slot="slash-secret-name"]')!;
    expect(document.activeElement).toBe(name);
    const value = container!.querySelector<HTMLInputElement>("#slash-secret-value")!;
    expect(value.type).toBe("password");
    await click(container!.querySelector('[data-slot="form-secret-reveal"]')!);
    expect(value.type).toBe("text");
    await fill(name, "stripe-key");
    await fill(value, "sk_live_TOPSECRET123");
    // Enter in a field submits its form (implicit submission): the form's submit is the save.
    await act(async () => { value.form!.requestSubmit(); await flush(); await flush(); });
    expect(apiFake.secretSaves).toEqual([{ name: "stripe-key", scope: "chat", value: "sk_live_TOPSECRET123" }]);
    expect(widget()).toBeNull(); // closed: the box is back, with focus
    expect(document.activeElement).toBe(textBox());
    const chip = container!.querySelector('[data-slot="slash-notice"]')!;
    expect(chip.textContent).toContain("chat/stripe-key");
    // Nowhere else: not the box, not the persisted draft, not a sent message, not the page.
    expect(textBox()!.value).toBe("");
    for (let i = 0; i < localStorage.length; i++) expect(localStorage.getItem(localStorage.key(i)!) ?? "").not.toContain("TOPSECRET");
    expect(sent).toEqual([]);
    expect(document.body.innerHTML).not.toContain("TOPSECRET");
  });

  test("/secret: Esc closes the widget, saves nothing and gives the previous draft back", async () => {
    const box = await mount(worker);
    await type(box, "keep this draft\n/secret");
    await key(box, "Enter");
    expect(widget()).not.toBeNull();
    const value = container!.querySelector<HTMLInputElement>("#slash-secret-value")!;
    await fill(value, "sk_live_TOPSECRET123");
    await act(async () => { value.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await flush(); await flush(); });
    expect(widget()).toBeNull();
    expect(apiFake.secretSaves).toEqual([]);
    expect(textBox()!.value).toBe("keep this draft\n");
    expect(document.activeElement).toBe(textBox());
    expect(textBox()!.selectionStart).toBe("keep this draft\n".length);
    for (let i = 0; i < localStorage.length; i++) expect(localStorage.getItem(localStorage.key(i)!) ?? "").not.toContain("TOPSECRET");
    // Send the draft: the message is the draft only.
    await key(textBox()!, "Enter");
    expect(sent).toEqual(["keep this draft"]);
    expect(document.body.innerHTML).not.toContain("TOPSECRET");
  });
});
