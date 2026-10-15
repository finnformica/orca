// Every image in the app opens a full-size lightbox on click (Esc / backdrop / a close button all
// close it) and carries a corner button that copies the image to the clipboard as a PNG, falling
// back to copying its URL when the browser refuses `navigator.clipboard.write`. One shared
// component (web/src/components/ExpandableImage.tsx) backs every call site; this exercises it
// directly, the same way messageQuote.test.tsx exercises MessageActions.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ExpandableImage, copyImage } from "@/components/ExpandableImage";
import { openTip } from "./tip";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = () => new Promise((r) => setTimeout(r, 0));
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };

let root: Root | undefined;
let container: HTMLElement | undefined;
function mount(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => { root = createRoot(container!); root!.render(ui); });
}

class FakeClipboardItem {
  constructor(public items: Record<string, Blob>) {}
}

const realFetch = globalThis.fetch;
const realClipboardItem = (globalThis as unknown as { ClipboardItem?: unknown }).ClipboardItem;
let written: FakeClipboardItem[][] = [];
let writtenText: string[] = [];

function setClipboard(opts: { write?: boolean } = {}) {
  written = [];
  writtenText = [];
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: {
      ...(opts.write !== false ? { write: (items: FakeClipboardItem[]) => { written.push(items); return Promise.resolve(); } } : {}),
      writeText: (t: string) => { writtenText.push(t); return Promise.resolve(); },
    },
  });
}

beforeEach(() => {
  setClipboard();
  (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = FakeClipboardItem;
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  globalThis.fetch = realFetch;
  (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = realClipboardItem;
});

// --- copyImage: the pure clipboard helper -----------------------------------------------------

test("copyImage fetches the src and writes a PNG ClipboardItem to the clipboard", async () => {
  const pngBlob = new Blob(["pixels"], { type: "image/png" });
  globalThis.fetch = (() => Promise.resolve({ ok: true, blob: () => Promise.resolve(pngBlob) })) as unknown as typeof fetch;

  const ok = await copyImage("/api/attachments/5");

  expect(ok).toBe(true);
  expect(written).toHaveLength(1);
  expect(written[0]![0]).toBeInstanceOf(FakeClipboardItem);
  expect((written[0]![0] as FakeClipboardItem).items["image/png"]).toBe(pngBlob);
  expect(writtenText).toHaveLength(0); // the real path, not the fallback
});

test("copyImage falls back to copying the absolute URL when clipboard.write is unavailable", async () => {
  setClipboard({ write: false }); // a browser that only ever offers writeText
  globalThis.fetch = (() => { throw new Error("should not be called"); }) as unknown as typeof fetch;

  const ok = await copyImage("/api/attachments/5");

  expect(ok).toBe(true);
  expect(writtenText).toEqual(["http://orca.test/api/attachments/5"]);
});

test("copyImage falls back to the URL when the fetch itself fails", async () => {
  globalThis.fetch = (() => Promise.reject(new Error("network error"))) as unknown as typeof fetch;

  const ok = await copyImage("/api/attachments/5");

  expect(ok).toBe(true);
  expect(writtenText).toEqual(["http://orca.test/api/attachments/5"]);
  expect(written).toHaveLength(0);
});

// --- the component: click opens the lightbox, Esc/backdrop/close button close it ---------------

test("clicking the thumbnail opens a full-size lightbox; the close button closes it", async () => {
  mount(<ExpandableImage src="/api/attachments/5" alt="a screenshot" imgClassName="max-h-32" />);

  const dialog = container!.querySelector<HTMLDialogElement>('[data-slot="image-lightbox"]')!;
  expect(dialog.open).toBe(false);

  await click(container!.querySelector('[data-slot="expandable-image"]')!);
  expect(dialog.open).toBe(true);
  // The full-size image and a Download link render inside, plus the Close button.
  expect(dialog.querySelectorAll("img")).toHaveLength(1);
  expect(dialog.querySelector('a[aria-label="Download image"]')!.getAttribute("href")).toBe("/api/attachments/5");

  await click(dialog.querySelector('button[aria-label="Close"]')!);
  expect(dialog.open).toBe(false);
});

test("Esc closes the lightbox (the native <dialog> cancel event, same as every other modal here)", async () => {
  mount(<ExpandableImage src="/api/attachments/5" alt="a screenshot" />);
  const dialog = container!.querySelector<HTMLDialogElement>('[data-slot="image-lightbox"]')!;

  await click(container!.querySelector('[data-slot="expandable-image"]')!);
  expect(dialog.open).toBe(true);

  await act(async () => { dialog.dispatchEvent(new Event("cancel")); await flush(); });
  expect(dialog.open).toBe(false);
});

test("clicking the backdrop (the dialog itself, not its content) closes the lightbox", async () => {
  mount(<ExpandableImage src="/api/attachments/5" alt="a screenshot" />);
  const dialog = container!.querySelector<HTMLDialogElement>('[data-slot="image-lightbox"]')!;

  await click(container!.querySelector('[data-slot="expandable-image"]')!);
  expect(dialog.open).toBe(true);

  await act(async () => { dialog.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(dialog.open).toBe(false);
});

// --- the corner copy button --------------------------------------------------------------------

test("the corner button copies the image and shows a brief Copied tick", async () => {
  const pngBlob = new Blob(["pixels"], { type: "image/png" });
  globalThis.fetch = (() => Promise.resolve({ ok: true, blob: () => Promise.resolve(pngBlob) })) as unknown as typeof fetch;
  mount(<ExpandableImage src="/api/attachments/5" alt="a screenshot" />);

  const copyBtn = container!.querySelector('button[aria-label="Copy image"]')!;
  // Always reachable on a touch screen — never fully hidden, just faded without hover.
  expect(copyBtn.className).toContain("[@media(hover:none)]:opacity-100");

  await click(copyBtn);
  expect(written).toHaveLength(1);
  // The inline tick: the tooltip content swaps to "Copied" and stays a Check icon briefly. (The
  // click closes the tooltip, as a shadcn one does; focusing the button again shows the new label.)
  const tip = openTip(copyBtn);
  expect(tip.textContent).toBe("Copied");

  // Clicking the copy button must not also open the lightbox underneath it.
  const dialog = container!.querySelector<HTMLDialogElement>('[data-slot="image-lightbox"]')!;
  expect(dialog.open).toBe(false);
});

// --- gallery navigation: Left/Right move within a set, stopping at the ends --------------------

const press = async (el: Element, key: string) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); await flush(); });

const GALLERY = [
  { src: "/api/screenshots/1", alt: "first" },
  { src: "/api/screenshots/2", alt: "second" },
  { src: "/api/screenshots/3", alt: "third" },
];

test("Right/Left move between the gallery's images, stopping at the ends, and show the index", async () => {
  mount(<ExpandableImage src={GALLERY[1]!.src} alt={GALLERY[1]!.alt} gallery={{ images: GALLERY, index: 1 }} />);
  const dialog = container!.querySelector<HTMLDialogElement>('[data-slot="image-lightbox"]')!;

  await click(container!.querySelector('[data-slot="expandable-image"]')!);
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector("img")!.getAttribute("src")).toBe(GALLERY[1]!.src);
  expect(dialog.querySelector('[data-slot="lightbox-index"]')!.textContent).toBe("2 / 3");

  await press(dialog, "ArrowRight");
  expect(dialog.querySelector("img")!.getAttribute("src")).toBe(GALLERY[2]!.src);
  expect(dialog.querySelector('[data-slot="lightbox-index"]')!.textContent).toBe("3 / 3");

  // At the last image: Right again does nothing (stop, not wrap).
  await press(dialog, "ArrowRight");
  expect(dialog.querySelector("img")!.getAttribute("src")).toBe(GALLERY[2]!.src);

  await press(dialog, "ArrowLeft");
  await press(dialog, "ArrowLeft");
  expect(dialog.querySelector("img")!.getAttribute("src")).toBe(GALLERY[0]!.src);
  expect(dialog.querySelector('[data-slot="lightbox-index"]')!.textContent).toBe("1 / 3");

  // At the first image: Left again does nothing.
  await press(dialog, "ArrowLeft");
  expect(dialog.querySelector("img")!.getAttribute("src")).toBe(GALLERY[0]!.src);
});

test("Esc still closes a gallery lightbox", async () => {
  mount(<ExpandableImage src={GALLERY[0]!.src} alt={GALLERY[0]!.alt} gallery={{ images: GALLERY, index: 0 }} />);
  const dialog = container!.querySelector<HTMLDialogElement>('[data-slot="image-lightbox"]')!;

  await click(container!.querySelector('[data-slot="expandable-image"]')!);
  await press(dialog, "ArrowRight"); // navigate first, so Esc is exercised mid-gallery
  expect(dialog.querySelector("img")!.getAttribute("src")).toBe(GALLERY[1]!.src);

  await act(async () => { dialog.dispatchEvent(new Event("cancel")); await flush(); });
  expect(dialog.open).toBe(false);
});

test("a single image shows no chevrons or index, even with a one-item gallery", async () => {
  mount(<ExpandableImage src={GALLERY[0]!.src} alt={GALLERY[0]!.alt} gallery={{ images: [GALLERY[0]!], index: 0 }} />);
  const dialog = container!.querySelector<HTMLDialogElement>('[data-slot="image-lightbox"]')!;

  await click(container!.querySelector('[data-slot="expandable-image"]')!);
  expect(dialog.querySelector('[data-slot="lightbox-index"]')).toBeNull();
  expect(dialog.querySelector('button[aria-label="Previous screenshot"]')).toBeNull();
  expect(dialog.querySelector('button[aria-label="Next screenshot"]')).toBeNull();
});

test("reopening the same thumbnail resets the gallery to the image that was clicked", async () => {
  mount(<ExpandableImage src={GALLERY[0]!.src} alt={GALLERY[0]!.alt} gallery={{ images: GALLERY, index: 0 }} />);
  const dialog = container!.querySelector<HTMLDialogElement>('[data-slot="image-lightbox"]')!;

  await click(container!.querySelector('[data-slot="expandable-image"]')!);
  await press(dialog, "ArrowRight");
  expect(dialog.querySelector("img")!.getAttribute("src")).toBe(GALLERY[1]!.src);

  await click(dialog.querySelector('button[aria-label="Close"]')!);
  expect(dialog.open).toBe(false);

  await click(container!.querySelector('[data-slot="expandable-image"]')!);
  expect(dialog.querySelector("img")!.getAttribute("src")).toBe(GALLERY[0]!.src);
});
