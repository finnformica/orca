// E2E for Add New (components/Shell.AddNew): a proper dialog, not a popover. The sidebar's button —
// or `C` from anywhere outside a text field — opens a modal <dialog> holding the New-draft box; the
// composer's selects portal INTO the dialog (a modal makes the rest of the page inert, so a select
// in <body> would be unclickable); sending closes it and raises a "Sent" side notification (the one
// toast surface, components/Notifications.tsx) with Undo and Open, instead of a bottom-centre toast
// of its own; closing keeps what you typed. Driven against the fake api (tests/apiFake.ts) in a real DOM.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { TOAST_EXIT_MS } from "../shared/notifications";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });
}
afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
  localStorage.clear();
  await act(async () => { await store.refresh(); });
});

const dialog = () => container!.querySelector<HTMLDialogElement>('[data-slot="add-new-dialog"]')!;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); await flush(); await flush(); }); };
async function type(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}

test("Add New opens a modal dialog with the New-draft box — not a popover", async () => {
  await mount();
  expect(dialog().open).toBe(false);
  await click(container!.querySelector('[data-slot="add-new"]')!);
  expect(dialog().open).toBe(true);
  expect(dialog().textContent).toContain("New agent");
  expect(dialog().querySelector("textarea")).not.toBeNull(); // the composer lives in the dialog
  expect(document.activeElement).toBe(dialog().querySelector("textarea")); // and you start typing in it
  expect(document.querySelector("[data-radix-popper-content-wrapper]")).toBeNull(); // no popover
  // The repo picker's list renders INSIDE the dialog, where a modal leaves it clickable.
  await act(async () => {
    const trigger = dialog().querySelector<HTMLElement>('[data-slot="select-trigger"]')!;
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await flush(); await flush();
  });
  const list = document.querySelector('[role="listbox"]');
  expect(list).not.toBeNull();
  expect(dialog().contains(list)).toBe(true);
});

test("sending closes the dialog and raises a Sent side notification with Undo; Undo tears the draft down", async () => {
  await mount();
  await click(container!.querySelector('[data-slot="add-new"]')!);
  await type(dialog().querySelector("textarea")!, "Add a fancy widget");
  await act(async () => {
    dialog().querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush(); await flush();
  });
  expect(dialog().open).toBe(false);
  expect(apiFake.orchestratorMessages).toEqual([{ text: "[new draft] repo: r\n\nAdd a fancy widget", attachments: [] }]); // Auto → the orchestrator
  expect(container!.querySelector('[data-slot="sent-toast"]')).toBeNull(); // no bottom-centre toast of its own any more
  const toast = container!.querySelector<HTMLElement>('[data-slot="notification-toast"][data-kind="draft_sent"]')!;
  expect(toast).not.toBeNull(); // the one toast surface (Notifications.tsx) carries it instead
  expect(toast.textContent).toContain("Sent to r");
  await click(toast.querySelector('button[aria-label="Undo"]')!);
  expect(toast.getAttribute("data-removed")).toBe("true"); // marked read (and Undo fired) at once; the exit plays…
  await act(async () => { await wait(TOAST_EXIT_MS + 30); });
  expect(container!.querySelector('[data-slot="notification-toast"][data-kind="draft_sent"]')).toBeNull(); // …then it's gone
});

test("closing keeps what you typed; `C` opens it from anywhere outside a text field", async () => {
  await mount();
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true })); await flush(); await flush(); });
  expect(dialog().open).toBe(true);
  await type(dialog().querySelector("textarea")!, "Half a thought");
  await click(dialog().querySelector('button[aria-label="Close"]')!);
  expect(dialog().open).toBe(false);
  await click(container!.querySelector('[data-slot="add-new"]')!);
  expect(dialog().querySelector("textarea")!.value).toBe("Half a thought"); // the draft survived
});
