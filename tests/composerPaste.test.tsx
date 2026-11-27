// Files from the clipboard in the chat composer. iOS shows no Paste in a plain <textarea> when the
// clipboard holds only an image (lib/clipboardFiles says why), so a phone's paperclip is a menu with
// "Paste from clipboard", which reads the clipboard itself. Pure parse first, then the real
// ChatComposer in a DOM: a paste event (items, or `.files` only) and the phone menu's Paste.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./apiFake";
import * as store from "@/store";
import { ChatComposer } from "@/components/ChatComposer";
import { NARROW_QUERY } from "@/lib/viewport";
import { CLIPBOARD_EMPTY, ClipboardUnavailable, clipboardError, isFilePathText, pastedFileName, pastedFiles, readClipboard, type ClipboardEntry } from "@/lib/clipboardFiles";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const png = (name = "image.png") => new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
// Finn's case (2026-11-27): a bank statement copied in the iOS Files app.
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const xlsx = () => new File([new Uint8Array(17 * 1024)], "account_statement.xlsx", { type: XLSX });
const fileItem = (f: File) => ({ kind: "file", type: f.type, getAsFile: () => f });
const entry = (parts: Record<string, Blob>): ClipboardEntry => ({ types: Object.keys(parts), getType: async (t) => parts[t]! });

describe("pastedFiles", () => {
  test("reads the files of `items` (a desktop screenshot paste)", () => {
    const f = png();
    expect(pastedFiles({ items: [fileItem(f), { kind: "string", type: "text/plain", getAsFile: () => null }], files: [f] })).toEqual([f]);
  });
  test("falls back to `.files` when `items` has no file", () => {
    const f = png();
    expect(pastedFiles({ items: [], files: [f] })).toEqual([f]);
  });
  test("an .xlsx in `.files` only (WebKit's paste of a copied file) attaches", () => {
    const f = xlsx();
    expect(pastedFiles({ items: [], files: [f] })).toEqual([f]);
    expect(pastedFiles({ items: [fileItem(f)], files: [f] })).toEqual([f]);
  });
  test("text only, or no data, is no file", () => {
    expect(pastedFiles({ items: [{ kind: "string", type: "text/plain", getAsFile: () => null }], files: [] })).toEqual([]);
    expect(pastedFiles(null)).toEqual([]);
  });
});

describe("isFilePathText", () => {
  test("a copied file's path is not text to keep", () => {
    expect(isFilePathText("file:///private/var/mobile/Library/Mobile%20Documents/account_statement.xlsx")).toBe(true);
    expect(isFilePathText("/private/var/mobile/Containers/Shared/AppGroup/x/account_statement.xlsx\n")).toBe(true);
    expect(isFilePathText("see file:///tmp/a.xlsx")).toBe(false);
    expect(isFilePathText("https://example.com/a.xlsx")).toBe(false);
    expect(isFilePathText("")).toBe(false);
  });
});

describe("pastedFileName", () => {
  test("names by type, numbered after the first", () => {
    expect(pastedFileName("image/png", 1)).toBe("pasted-image.png");
    expect(pastedFileName("image/jpeg", 2)).toBe("pasted-image-2.jpg");
    expect(pastedFileName("application/pdf", 1)).toBe("pasted-file.pdf");
  });
});

describe("readClipboard", () => {
  test("an image (iOS gives a Photos copy as image/png) becomes a File; its text is ignored", async () => {
    const r = await readClipboard({ read: async () => [entry({ "text/uri-list": new Blob(["https://x"]), "image/png": png() })] });
    expect(r.files.map((f) => [f.name, f.type])).toEqual([["pasted-image.png", "image/png"]]);
    expect(r.text).toBe("");
  });
  test("two images get two names", async () => {
    const r = await readClipboard({ read: async () => [entry({ "image/png": png() }), entry({ "image/jpeg": new Blob(["j"], { type: "image/jpeg" }) })] });
    expect(r.files.map((f) => f.name)).toEqual(["pasted-image.png", "pasted-image-2.jpg"]);
  });
  test("text only gives the plain text", async () => {
    const r = await readClipboard({ read: async () => [entry({ "text/html": new Blob(["<b>hi</b>"]), "text/plain": new Blob(["hi"]) })] });
    expect(r).toEqual({ files: [], text: "hi" });
  });
  test("a copied .xlsx (no readable type, or only its path) reads as empty, never as a path", async () => {
    expect(await readClipboard({ read: async () => [{ types: [], getType: async () => { throw new Error("none"); } }] })).toEqual({ files: [], text: "" });
    expect(await readClipboard({ read: async () => [] })).toEqual({ files: [], text: "" });
    const path = "file:///private/var/mobile/account_statement.xlsx";
    expect(await readClipboard({ read: async () => [entry({ "text/uri-list": new Blob([path]), "text/plain": new Blob([path]) })] })).toEqual({ files: [], text: "" });
  });
  test("no read() (plain http, an old browser) throws ClipboardUnavailable", async () => {
    await expect(readClipboard({})).rejects.toBeInstanceOf(ClipboardUnavailable);
    await expect(readClipboard(undefined)).rejects.toBeInstanceOf(ClipboardUnavailable);
  });
});

describe("clipboardError", () => {
  test("names the cause", () => {
    expect(clipboardError(new ClipboardUnavailable())).toContain("https address");
    expect(clipboardError(new DOMException("denied", "NotAllowedError"))).toContain("not allowed");
    expect(clipboardError(new DOMException("none", "DataError"))).toBe(CLIPBOARD_EMPTY);
    expect(clipboardError(new Error("boom"))).toBe("Paste failed: boom");
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
const realMatchMedia = window.matchMedia;
const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
beforeAll(() => store.configReady);
beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  act(() => root?.unmount()); container?.remove(); root = container = undefined; localStorage.clear();
  window.matchMedia = realMatchMedia;
  if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
  else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

const phone = () => {
  window.matchMedia = ((query: string) => ({ matches: query === NARROW_QUERY, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
};
const setClipboard = (read: () => Promise<ClipboardEntry[]>) =>
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read, writeText: async () => {} } });

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<ChatComposer onSubmit={async () => {}} />);
    await flush();
  });
  return container.querySelector("textarea")!;
}
const chips = () => container!.querySelectorAll('[data-slot="chat-composer-attachments"] > *').length;
async function pasteEvent(el: HTMLElement, data: object) {
  await act(async () => {
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { getData: () => "", ...data } });
    el.dispatchEvent(ev);
    await flush();
  });
}
async function pasteFromMenu() {
  const trigger = container!.querySelector('[data-slot="composer-attach"]')!;
  await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); await flush(); await flush(); });
  const item = document.querySelector<HTMLElement>('[data-slot="composer-paste"]');
  expect(item).not.toBeNull();
  await act(async () => { item!.click(); await flush(); await flush(); await flush(); });
}

test("a paste event with an image in `items` attaches it (desktop, unchanged)", async () => {
  const el = await mount();
  await pasteEvent(el, { items: [fileItem(png())], files: [] });
  expect(chips()).toBe(1);
});

test("a paste event with the image only in `.files` attaches it too", async () => {
  const el = await mount();
  await pasteEvent(el, { items: [], files: [png()] });
  expect(chips()).toBe(1);
});

test("a paste event with an .xlsx (iOS long-press Paste of a copied file) attaches it", async () => {
  const el = await mount();
  await pasteEvent(el, { items: [], files: [xlsx()] });
  expect(chips()).toBe(1);
  expect(container!.querySelector('[data-slot="chat-composer-attachments"]')?.textContent).toContain("account_statement.xlsx");
});

test("a paste of only a file's path puts no path in the box and says how to attach", async () => {
  const el = await mount();
  await pasteEvent(el, { items: [], files: [], getData: (t: string) => (t === "text/plain" ? "file:///private/var/mobile/account_statement.xlsx" : "") });
  expect(el.value).toBe("");
  expect(container!.querySelector('[data-slot="chat-composer-error"]')?.textContent).toBe(CLIPBOARD_EMPTY);
});

test("desktop: the paperclip is a plain button, no menu", async () => {
  await mount();
  const attach = container!.querySelector('[data-slot="composer-attach"]')!;
  expect(attach.getAttribute("aria-haspopup")).toBeNull();
});

test("phone: Paste from clipboard attaches a copied photo", async () => {
  phone();
  setClipboard(async () => [entry({ "image/png": png() })]);
  await mount();
  await pasteFromMenu();
  expect(chips()).toBe(1);
  expect(container!.querySelector('[data-slot="chat-composer-error"]')).toBeNull();
});

test("phone: Paste from clipboard with text puts the text in the box", async () => {
  phone();
  setClipboard(async () => [entry({ "text/plain": new Blob(["hello"]) })]);
  const el = await mount();
  await pasteFromMenu();
  expect(el.value).toBe("hello");
  expect(chips()).toBe(0);
});

test("phone: Paste from clipboard with a copied .xlsx says to use Photo or file", async () => {
  phone();
  setClipboard(async () => [{ types: [], getType: async () => { throw new Error("none"); } }]);
  const el = await mount();
  await pasteFromMenu();
  expect(chips()).toBe(0);
  expect(el.value).toBe("");
  expect(container!.querySelector('[data-slot="chat-composer-error"]')?.textContent).toBe(CLIPBOARD_EMPTY);
});

test("phone: an .xlsx picked with Photo or file attaches", async () => {
  phone();
  await mount();
  const input = container!.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [xlsx()] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await flush(); });
  expect(chips()).toBe(1);
  expect(container!.querySelector('[data-slot="chat-composer-attachments"]')?.textContent).toContain("account_statement.xlsx");
});

test("phone: a refused read shows why in the error line", async () => {
  phone();
  setClipboard(async () => { throw new DOMException("denied", "NotAllowedError"); });
  await mount();
  await pasteFromMenu();
  expect(container!.querySelector('[data-slot="chat-composer-error"]')?.textContent).toContain("not allowed");
});

test("phone: Photo or file opens the file picker", async () => {
  phone();
  await mount();
  const input = container!.querySelector<HTMLInputElement>('input[type="file"]')!;
  let opened = 0;
  input.click = () => { opened++; };
  const trigger = container!.querySelector('[data-slot="composer-attach"]')!;
  await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); await flush(); await flush(); });
  await act(async () => { document.querySelector<HTMLElement>('[data-slot="composer-attach-file"]')!.click(); await flush(); });
  expect(opened).toBe(1);
});
