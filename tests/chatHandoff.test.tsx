// The handoff review widget in the orchestrator's chat (views/Handoffs.tsx `HandoffWidget`, drawn by
// views/Chat.tsx under the reply of the turn that made the pack). It is the Handoffs page's own row,
// so Send is the page's one path: export here, import on the target, mark sent here. States: ready,
// sent, failed, discarded. Rendered into a real DOM against the fake api (tests/apiFake.ts).
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import { answer } from "./dialogs";
import * as store from "@/store";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";
import { rememberServer } from "@/lib/server";
import { handoffRef } from "@/workstream";
import type { PackView } from "../server/handoff";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let root: Root | undefined;
let container: HTMLElement | undefined;
const realFetch = globalThis.fetch;

const row: Row = { repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat", agentProvider: "claude" };
const ID = "pack-aaaa1111-2222";
const PERSONAL = "http://100.64.0.9:8787";

function pack(over: Partial<PackView> = {}): PackView {
  return {
    id: ID, direction: "out", title: "Discord setup", message: "Set up the Discord integration.", target: "personal", source: "orca-work-box",
    createdAt: 1_700_000_000_000,
    files: [
      { name: "design.md", kind: "file", attachmentId: "a1", size: 2048, mimeType: "text/markdown" },
      { name: "chat-7-discord-design.md", kind: "chat", attachmentId: "a2", size: 300, mimeType: "text/markdown" },
    ],
    preview: [
      { name: "design.md", kind: "file", size: 2048, mimeType: "text/markdown", text: "# Discord design" },
      { name: "chat-7-discord-design.md", kind: "chat", size: 300, mimeType: "text/markdown", text: "## Turn 1" },
    ],
    problems: [],
    wouldSay: "[handoff from orca-work-box] Discord setup\n\nSet up the Discord integration.",
    ...over,
  };
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<ChatPanel row={row} />); await flush(); await flush(); });
  await settle();
}
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await sleep(5); }); };
const widget = () => container!.querySelector<HTMLElement>('[data-slot="chat-handoff"]');
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); }); };
const sendButton = () => [...widget()!.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Send to"))!;

beforeEach(() => {
  localStorage.clear();
  apiFake.reset();
  // The server list's health probes never leave the test.
  globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  rememberServer({ url: PERSONAL, name: "personal" });
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  globalThis.fetch = realFetch;
  apiFake.reset();
});

// The bridge linked the pack to the turn (`turn.handoffs`, from the CLI's `orca-handoff://` line).
const linkedTurn = () => apiFake.turnsData.set("r::feat", [
  { id: "run-1", provider: "claude", prompt: "pack the Discord work for personal", response: "I made the pack. Review it and click Send.", finishedAt: 2, handoffs: [ID] },
]);

test("ready: the widget under the reply shows the title, target, message, files, chats and sizes", async () => {
  apiFake.handoffPackById.set(ID, pack());
  linkedTurn();
  await mount();
  const w = widget()!;
  expect(w).toBeTruthy();
  expect(w.dataset.state).toBe("ready");
  // Under the reply of the turn that made it.
  expect(w.closest('[data-slot="chat-reply"]')).toBeTruthy();
  const text = w.textContent!;
  expect(text).toContain("Discord setup");
  expect(text).toContain("for personal");
  expect(text).toContain("Set up the Discord integration.");
  expect(text).toContain("design.md");
  expect(text).toContain("file · 2.0 KB");
  expect(text).toContain("chat-7-discord-design.md");
  expect(text).toContain("chat · 300 B");
  expect(sendButton().disabled).toBe(false);
  expect(w.querySelector('[aria-label="Open on the Handoffs page"]')).toBeTruthy();
  expect(w.querySelector('[aria-label="Delete pack"]')).toBeTruthy();
  // Nothing is sent without the click.
  expect(apiFake.handoffCalls.filter(([k]) => k !== "get")).toEqual([]);
});

test("narrow-safe layout: its own container, the badge in the title's flow, one row of actions with Send first", async () => {
  apiFake.handoffPackById.set(ID, pack({ title: "Integrations: new direction (Funnel webhooks, GitHub App, Slack paused)" }));
  linkedTurn();
  await mount();
  const w = widget()!;
  // The layout follows the widget's width (the chat panel is narrow on a wide viewport), never the viewport's.
  expect(w.className).toContain("@container/handoff");
  expect(w.innerHTML).not.toMatch(/\bmd:flex-row\b/);
  // The badge is inside the title element, after the text, so it wraps with the last word.
  const title = w.querySelector('[data-slot="handoff-title"]')!;
  expect(title.querySelector('[data-slot="handoff-badge"]')!.textContent).toBe("ready");
  expect(title.textContent).toBe("Integrations: new direction (Funnel webhooks, GitHub App, Slack paused) ready");
  // The metadata line wraps only between whole items.
  const meta = [...w.querySelectorAll<HTMLElement>('[data-slot="handoff-meta"] > span')];
  expect(meta.map((m) => m.className)).toEqual(meta.map(() => "whitespace-nowrap"));
  expect(meta.map((m) => m.textContent)).toEqual(["for personal", "· 2 files", "· 2.3 KB", "· from orca-work-box", "· hide preview"]);
  // One row of actions under the title: Send (the main button), then open and delete as icon buttons.
  const actions = w.querySelector<HTMLElement>('[data-slot="handoff-actions"]')!;
  expect(actions.className).toMatch(/\bflex\b/);
  expect(actions.className).not.toMatch(/(^| )flex-col/);
  const buttons = [...actions.querySelectorAll("button")].filter((b) => b.getAttribute("role") !== "combobox"); // not the server picker
  expect(buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Send to personal", "Open on the Handoffs page", "Delete pack"]);
  expect(buttons[0]!.textContent).toBe("Send to personal"); // the labelled main button
  for (const b of buttons.slice(1)) { expect(b.textContent).toBe(""); expect(b.querySelector("svg")).toBeTruthy(); } // icon-only
});

test("sent: Send is the page's path (export, import on the target, mark sent), then the result shows", async () => {
  apiFake.handoffPackById.set(ID, pack());
  linkedTurn();
  await mount();
  await click(sendButton());
  expect(await answer(true)).toContain('Send "Discord setup" to personal?');
  await settle();
  expect(apiFake.handoffCalls.filter(([k]) => k !== "get")).toEqual([["export", ID], ["import", PERSONAL, ID], ["sent", ID, "personal"]]);
  const w = widget()!;
  expect(w.dataset.state).toBe("sent");
  expect(w.textContent).toContain("sent to personal");
  expect(w.querySelector('[data-slot="handoff-result"]')!.textContent).toBe("The orchestrator on personal got the message and 2 files.");
  expect(sendButton()).toBeUndefined(); // sent once; no second Send
});

test("failed: a refused import shows the error in the widget, and the pack stays ready to send again", async () => {
  apiFake.handoffPackById.set(ID, pack());
  apiFake.handoffImportError = "Import refused: the caller is not a Tailscale user device.";
  linkedTurn();
  await mount();
  await click(sendButton());
  await answer(true);
  await settle();
  const w = widget()!;
  expect(w.dataset.state).toBe("failed");
  expect(w.querySelector('[data-slot="handoff-error"]')!.textContent).toBe("Send failed: Import refused: the caller is not a Tailscale user device.");
  expect(apiFake.handoffCalls.some(([k]) => k === "sent")).toBe(false);
  expect(sendButton().disabled).toBe(false);
});

test("discarded: Delete removes the pack and the widget says it was not sent", async () => {
  apiFake.handoffPackById.set(ID, pack());
  linkedTurn();
  await mount();
  await click(widget()!.querySelector('[aria-label="Delete pack"]')!);
  await answer(true);
  await settle();
  expect(apiFake.handoffCalls).toContainEqual(["delete", ID]);
  expect(widget()!.dataset.state).toBe("discarded");
  expect(widget()!.textContent).toBe("Handoff pack deleted. It was not sent.");
});

test("a running turn shows its pack from the tool result in its steps, before the bridge links it", async () => {
  apiFake.handoffPackById.set(ID, pack());
  apiFake.turnsData.set("r::feat", [{
    id: "run-2", provider: "claude", prompt: "pack it", response: "",
    steps: [
      { at: 1, kind: "tool", id: "t1", name: "Bash", input: { command: "orca handoff create --to personal --title 'Discord setup'" } },
      { at: 2, kind: "result", id: "t1", output: `Pack pack-aaa "Discord setup" for personal: 2 files.\nPack id: ${handoffRef(ID)}\nIt is NOT sent.` },
      // A failed call made no pack.
      { at: 3, kind: "result", id: "t2", isError: true, output: `Pack id: ${handoffRef("pack-bbbb3333")}` },
    ],
  }]);
  await mount();
  const all = container!.querySelectorAll('[data-slot="chat-handoff"]');
  expect(all.length).toBe(1);
  expect((all[0] as HTMLElement).dataset.state).toBe("ready");
  expect(apiFake.handoffCalls).toEqual([["get", ID]]);
});
