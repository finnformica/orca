// E2E for the in-app dialogs that replace window.confirm / window.prompt (lib/dialogs): the promise
// helper (confirm, Cancel, Esc, a queue, the red destructive button, the copy fallback) and one call
// site — Discard in a workstream's ⋯, from the desktop dropdown and from the phone's bottom sheet,
// where the confirm must wait for the sheet (a native modal <dialog>) to close. Rendered into a real
// DOM against the fake api (tests/apiFake.ts).
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import { alertDialog, answer } from "./dialogs";
import * as store from "@/store";
import { confirmDialog, copyText, overlaysSettled } from "@/lib/dialogs";
import { NARROW_QUERY, COARSE_QUERY } from "@/lib/viewport";
import { SHEET_CLOSE_MS } from "@/components/BottomSheet";
import { WorkstreamActions } from "@/views/WorkstreamActions";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pointerdown = async (el: Element) => { await act(async () => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await flush(); await flush(); }); };
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
const waitFor = async <T,>(get: () => T | null | undefined, ms = 1000): Promise<T> => {
  for (let t = 0; t < ms; t += 10) { const v = get(); if (v) return v; await act(async () => { await sleep(10); }); }
  throw new Error("timed out");
};

// Ask inside act(), so the host's render is flushed (act would await the answer itself if returned).
const ask = (o: Parameters<typeof confirmDialog>[0]) => { let p!: Promise<boolean>; act(() => { p = confirmDialog(o); }); return p; };

const realMatchMedia = window.matchMedia;
const emulatePhone = () => {
  window.matchMedia = ((q: string) => ({ matches: q === NARROW_QUERY || q === COARSE_QUERY, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
};

let root: Root | undefined;
let container: HTMLElement | undefined;
const row: store.Row = { repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat" };
function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => { root = createRoot(container!); root.render(<WorkstreamActions row={row} menuOnly compact />); });
}

afterEach(async () => {
  window.matchMedia = realMatchMedia;
  apiFake.reset();
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  // No dialog is left open for the next test.
  while (alertDialog()) await answer(false);
});

describe("confirmDialog", () => {
  test("resolves true on the confirm button and false on Cancel; the destructive confirm is red", async () => {
    const yes = ask({ title: "Ship it?", description: "It goes to main.", confirmLabel: "Ship" });
    const d = await waitFor(alertDialog);
    expect(d.querySelector('[data-slot="alert-dialog-action"]')!.textContent).toBe("Ship");
    expect(d.querySelector('[data-slot="alert-dialog-action"]')!.className).not.toContain("bg-geist-red");
    expect(await answer(true)).toBe("Ship it? — It goes to main.");
    expect(await yes).toBe(true);

    const no = ask({ title: "Delete?", destructive: true });
    const red = await waitFor(alertDialog);
    expect(red.querySelector('[data-slot="alert-dialog-action"]')!.className).toContain("bg-geist-red");
    // Full-width, thumb-sized buttons below md.
    expect(red.querySelector('[data-slot="alert-dialog-footer"]')!.className).toContain("max-md:[&>button]:w-full");
    await answer(false);
    expect(await no).toBe(false);
  });

  test("Esc is a Cancel, and two questions asked at once show one after the other", async () => {
    const first = ask({ title: "First?" });
    const second = ask({ title: "Second?" });
    const d = await waitFor(alertDialog);
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    await act(async () => { d.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(); });
    expect(await first).toBe(false);
    expect(await answer(true)).toBe("Second? — Second?");
    expect(await second).toBe(true);
  });

  test("waits while a bottom sheet is open", () => {
    const sheet = document.createElement("dialog");
    sheet.setAttribute("data-bottom-sheet", "");
    sheet.setAttribute("open", "");
    document.body.appendChild(sheet);
    expect(overlaysSettled()).toBe(false);
    sheet.remove();
    expect(overlaysSettled()).toBe(true);
  });

  test("copyText: the clipboard when it works, else a dialog with the text selected and a Copy button", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { copied.push(t); } } });
    expect(await copyText("feat", "branch")).toBe(true);
    expect(copied).toEqual(["feat"]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
    const done = copyText("git checkout feat", "CLI command");
    const d = await waitFor(() => document.querySelector<HTMLElement>('[role="dialog"]'));
    expect(d.textContent).toContain("Copy the CLI command");
    const field = d.querySelector<HTMLInputElement>('[data-slot="copy-text"]')!;
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe("git checkout feat");
    expect([...d.querySelectorAll("button")].map((b) => b.textContent)).toContain("Copy");
    await click([...d.querySelectorAll("button")].find((b) => b.textContent === "Close")!);
    expect(await done).toBe(false);
    await waitFor(() => !document.querySelector('[role="dialog"]'));
  });
});

describe("Discard asks in the AlertDialog", () => {
  const discard = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "Discard")!;

  test("desktop: Cancel keeps the branch; Discard (red) removes it", async () => {
    mount();
    await pointerdown(container!.querySelector('button[aria-label="Actions"]')!);
    await click(discard());
    const d = await waitFor(alertDialog);
    expect(d.querySelector('[data-slot="alert-dialog-action"]')!.className).toContain("bg-geist-red");
    expect(await answer(false)).toBe('Discard "Feat"? — This removes the worktree and the branch feat. You cannot undo this.');
    expect(apiFake.calls).not.toContain("discard:feat");

    await pointerdown(container!.querySelector('button[aria-label="Actions"]')!);
    await click(discard());
    await answer(true);
    await waitFor(() => apiFake.calls.includes("discard:feat"));
  });

  test("phone: the confirm opens once the bottom sheet has slid shut, then discards", async () => {
    emulatePhone();
    mount();
    await click(container!.querySelector('button[aria-label="Actions"]')!);
    const sheet = document.querySelector<HTMLDialogElement>('dialog[data-bottom-sheet]')!;
    expect(sheet.open).toBe(true);
    await click(discard());
    expect(alertDialog()).toBeNull(); // not under the closing sheet
    await act(async () => { await sleep(SHEET_CLOSE_MS + 50); });
    expect(sheet.open).toBe(false);
    await waitFor(alertDialog);
    await answer(true);
    await waitFor(() => apiFake.calls.includes("discard:feat"));
  });
});

test("no native alert, confirm or prompt is left in the web app", async () => {
  const offenders: string[] = [];
  for await (const file of new Bun.Glob("web/src/**/*.{ts,tsx}").scan()) {
    const text = await Bun.file(file).text();
    if (/\bwindow\.(alert|confirm|prompt)\s*\(|(?<![.\w])alert\s*\(/.test(text)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
