// E2E for optimistic follow-up submit: hitting send on the follow-up box must close it the instant
// you send — launching the agent (ensureWorktree + upload + claude) takes a few seconds and the old
// behaviour left a spinner up the whole time. The typed prompt stays persisted, so if the launch
// FAILS the box reopens with the same text (and the error is a failed-action notification toast, lib/notificationStore); on SUCCESS the draft
// is dropped. Driven
// against the preloaded fake `api` (tests/apiFake.ts, no network) and rendered into a real DOM.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { WorkstreamActions } from "@/views/WorkstreamActions";
import { ToastHost } from "@/components/Notifications";
import * as centre from "@/lib/notificationStore";
import { openTip } from "./tip";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));

// A promoted local branch with a worktree already, so ensureWorktree returns without a round-trip.
const row: store.Row = { repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat" };
const draftKey = `orca.followup.${row.repo}::${row.branch}`;

// The card's actions, and the toast stack App mounts once — where a failure's message goes.
const tree = (r: store.Row) => <><div data-slot="actions"><WorkstreamActions row={r} /></div><ToastHost /></>;
let root: Root | undefined;
let container: HTMLElement | undefined;
function mount(): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => { root = createRoot(container!); root.render(tree(row)); });
  return container;
}
const btn = (text: string) => [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const textarea = () => container!.querySelector("textarea");
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); }); };
const type = async (el: HTMLTextAreaElement, text: string) => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { set.call(el, text); el.dispatchEvent(new Event("input", { bubbles: true })); await flush(); });
};

afterEach(async () => {
  localStorage.clear();
  apiFake.reset();
  act(() => centre.reset());
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
});

describe("optimistic follow-up submit", () => {
  test("offers a model picker (not a provider one) without a redundant chat-mode selector", async () => {
    mount();
    await click(btn("Follow up")!);
    const mode = container!.querySelector('[role="combobox"][aria-label="Chat mode"]');
    const model = container!.querySelector('[role="combobox"][aria-label="Model"]');
    expect(mode).toBeNull();
    expect(container!.querySelector('[role="combobox"][aria-label="Agent provider"]')).toBeNull();
    expect(model?.textContent).toBe("Claude · Fable 5.1");
  });

  test("defaults to and tracks the card's current model", async () => {
    mount();
    await click(btn("Follow up")!);
    const selected = () => container!.querySelector('[role="combobox"][aria-label="Model"]')?.textContent ?? "";
    expect(selected()).toBe("Claude · Fable 5.1");

    await act(async () => { root!.render(tree({ ...row, agentProvider: "codex" })); await flush(); });
    expect(selected()).toBe("Codex · GPT-5.5");   // last ran on Codex, nothing pinned → its first model
    await act(async () => { root!.render(tree({ ...row, agentProvider: "codex", preferredModel: "claude-fable-5-1" })); await flush(); });
    expect(selected()).toBe("Claude · Fable 5.1");   // a pinned model wins, and implies its CLI
  });

  test("closes the box immediately on send and clears the draft on success", async () => {
    mount();
    await click(btn("Follow up")!);
    await flush(); // let the composer hydrate so edits start persisting
    await type(textarea()!, "please retry");
    expect(JSON.parse(localStorage.getItem(draftKey)!).text).toBe("please retry"); // persisted

    await click(container!.querySelector('button[aria-label="Send"]')!);
    expect(textarea()).toBeNull(); // closed instantly, no spinner waiting on the launch
    expect(apiFake.claudePrompts.some((p) => p.includes("please retry"))).toBe(true); // launch fired
    expect(localStorage.getItem(draftKey)).toBeNull(); // succeeded → draft dropped
  });

  test("shows a spinner on the Follow up button while the launch is in flight", async () => {
    apiFake.holdClaude = true; // block the launch so we can observe the in-flight state
    mount();
    await click(btn("Follow up")!);
    await flush();
    await type(textarea()!, "please retry");
    await click(container!.querySelector('button[aria-label="Send"]')!);

    // Box closed, launch still running: the Follow up button shows a spinner and is disabled.
    expect(textarea()).toBeNull();
    const follow = btn("Follow up")!;
    expect(follow.querySelector(".animate-spin")).not.toBeNull();
    expect((follow as HTMLButtonElement).disabled).toBe(true);

    // Launch resolves: the spinner clears and the button is usable again.
    await act(async () => { apiFake.releaseClaude!(); await flush(); });
    expect(btn("Follow up")!.querySelector(".animate-spin")).toBeNull();
    expect((btn("Follow up")! as HTMLButtonElement).disabled).toBe(false);
  });

  test("reopens with the previous prompt (and an error) when the launch fails", async () => {
    apiFake.claudeError = "worktree busy";
    mount();
    await click(btn("Follow up")!);
    await flush();
    await type(textarea()!, "fix the flake");
    await click(container!.querySelector('button[aria-label="Send"]')!);
    await flush();

    // Failed launch: the box is back, pre-filled with what was typed, and a toast says why — the
    // card's own toolbar never holds the message (only the ⋯'s ✗ and its tooltip).
    expect(textarea()).not.toBeNull();
    expect(textarea()!.value).toBe("fix the flake");
    const t = container!.querySelector('[data-slot="notification-toast"][data-kind="action_failed"]')!;
    expect(t.textContent).toContain("Feat");
    expect(t.textContent).toContain("Follow up failed");
    expect(t.textContent).toContain("worktree busy");
    expect(container!.querySelector('[data-slot="actions"]')!.textContent).not.toContain("worktree busy");
    expect(openTip(container!.querySelector<HTMLElement>('button[aria-label="Actions"]')!).textContent).toBe("worktree busy");
    expect(JSON.parse(localStorage.getItem(draftKey)!).text).toBe("fix the flake"); // draft kept
  });
});
