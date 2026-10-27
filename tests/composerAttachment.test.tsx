// The composer's attachment chips (components/ComposerAttachment.tsx): ONE component for an image, a
// file and a stored secret, with one remove button and one lifecycle — an image and a secret chip sit
// in the same row inside the box, a send carries every chip with the message and clears the box. A
// secret chip shows only the stored name, never a value. Rendered in a real DOM (happy-dom) against
// the fake api (tests/apiFake.ts).
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatComposer } from "@/components/ChatComposer";
import { ComposerAttachment } from "@/components/ComposerAttachment";
import { splitSecretRefs, withSecretRefs } from "@/workstream";
import { loadDraft } from "@/lib/composerDraft";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A fake key with a known shape (the guard's OpenAI-style rule). Never a real value.
const SECRET = "sk-test-FAKE0000secret0000value";
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;

beforeAll(() => store.configReady);
beforeEach(() => apiFake.reset());
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = container = undefined; localStorage.clear(); apiFake.reset(); });

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); await flush(); });
  return container;
}
const q = <T extends Element = HTMLElement>(sel: string) => container!.querySelector(sel) as T | null;
const qa = (sel: string) => [...container!.querySelectorAll<HTMLElement>(sel)];
async function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); await flush(); await flush(); }); };
async function paste(el: HTMLTextAreaElement, data: { text?: string; files?: File[] }) {
  await act(async () => {
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: {
      items: (data.files ?? []).map((f) => ({ kind: "file", getAsFile: () => f })), files: [],
      getData: (t: string) => (t === "text/plain" ? data.text ?? "" : ""),
    } });
    el.dispatchEvent(ev);
    await flush();
  });
  if (data.text) await setValue(el, `${el.value}${data.text}`); // happy-dom does not insert a paste itself
}
/** Paste a key and save it as a secret named `name`: the chip the paste guard makes. */
async function pasteSecret(el: HTMLTextAreaElement, name: string) {
  await paste(el, { text: SECRET });
  await setValue(q<HTMLInputElement>("[data-slot=paste-guard-name]")!, name);
  await click(q("[data-slot=paste-guard-save]")!);
}

describe("ComposerAttachment", () => {
  test("every kind is the same tile with one remove button; a secret shows only its name and a lock", async () => {
    const removed: string[] = [];
    await render(<div>
      <ComposerAttachment item={{ kind: "image", name: "shot.png", src: "/x.png" }} onRemove={() => removed.push("image")} />
      <ComposerAttachment item={{ kind: "file", name: "spec.docx" }} onRemove={() => removed.push("file")} />
      <ComposerAttachment item={{ kind: "secret", name: "chat/stripe_key" }} onRemove={() => removed.push("secret")} />
    </div>);
    const tiles = qa("[data-slot=composer-attachment]");
    expect(tiles.map((t) => t.dataset.attachment)).toEqual(["image", "file", "secret"]);
    expect(new Set(tiles.map((t) => t.className)).size).toBe(1); // one look
    const secret = tiles[2]!;
    expect(secret.textContent).toBe("stripe_key");
    expect(secret.querySelector("svg.lucide-lock")).not.toBeNull();
    for (const t of tiles) await click(t.querySelector("[data-slot=composer-attachment-remove]")!);
    expect(removed).toEqual(["image", "file", "secret"]);
  });

  test("on a message (look=chip) there is no remove button", async () => {
    await render(<ComposerAttachment look="chip" item={{ kind: "secret", name: "chat/gh_token" }} />);
    expect(q("[data-slot=attachment-secret]")!.textContent).toBe("gh_token");
    expect(q("[data-slot=composer-attachment-remove]")).toBeNull();
  });
});

describe("the composer's chips", () => {
  test("an image chip and a secret chip sit in one row inside the box; a send carries both and clears the box", async () => {
    const sent: { text: string; files: File[] }[] = [];
    await render(<ChatComposer persistKey="orca.test.chips" onSubmit={async (text, files) => { sent.push({ text, files }); }} />);
    const el = q<HTMLTextAreaElement>("textarea")!;
    const png = new File(["png"], "shot.png", { type: "image/png" });
    await paste(el, { files: [png] });
    await setValue(el, "deploy with ");
    await pasteSecret(el, "stripe_key");
    const row = q("[data-slot=chat-composer-attachments]")!;
    expect([...row.querySelectorAll<HTMLElement>("[data-slot=composer-attachment]")].map((c) => c.dataset.attachment)).toEqual(["image", "secret"]);
    expect(row.parentElement!.contains(q("[data-slot=chat-composer-toolbar]"))).toBe(true); // inside the box
    expect(container!.innerHTML).not.toContain(SECRET);
    // The draft keeps the chip's name, never the value.
    await act(async () => { await flush(); await flush(); });
    expect(loadDraft("orca.test.chips").secrets).toEqual(["chat/stripe_key"]);
    expect(localStorage.getItem("orca.test.chips")).not.toContain(SECRET);

    await click(q("button[aria-label=Send]")!);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe(withSecretRefs("deploy with", ["chat/stripe_key"]));
    expect(sent[0]!.files).toEqual([png]);
    expect(el.value).toBe("");
    expect(q("[data-slot=chat-composer-attachments]")).toBeNull();
    expect(qa("[data-slot=composer-attachment]")).toHaveLength(0);
    expect(localStorage.getItem("orca.test.chips")).toBeNull();
  });

  test("a secret chip alone can be sent, and its remove button takes it off", async () => {
    const sent: string[] = [];
    await render(<ChatComposer onSubmit={async (text) => { sent.push(text); }} />);
    const el = q<HTMLTextAreaElement>("textarea")!;
    await pasteSecret(el, "a");
    await pasteSecret(el, "b");
    expect(qa("[data-attachment=secret]").map((c) => c.textContent)).toEqual(["a", "b"]);
    await click(q("[aria-label='Remove Secret chat/a']")!);
    expect(qa("[data-attachment=secret]").map((c) => c.textContent)).toEqual(["b"]);
    const send = q<HTMLButtonElement>("button[aria-label=Send]")!;
    expect(send.disabled).toBe(false);
    await click(send);
    expect(sent).toEqual(["[secret chat/b stored]"]);
    expect(qa("[data-attachment=secret]")).toHaveLength(0);
  });

  test("a failed send gives the chips back to an empty box", async () => {
    await render(<ChatComposer onSubmit={async () => { throw new Error("bridge down"); }} />);
    const el = q<HTMLTextAreaElement>("textarea")!;
    await setValue(el, "use ");
    await pasteSecret(el, "k");
    await click(q("button[aria-label=Send]")!);
    expect(el.value).toBe("use");
    expect(qa("[data-attachment=secret]").map((c) => c.textContent)).toEqual(["k"]);
    expect(q("[data-slot=chat-composer-error]")!.textContent).toBe("bridge down");
  });
});

describe("secret references in a message", () => {
  test("withSecretRefs adds them after the text; splitSecretRefs takes them back out", () => {
    expect(withSecretRefs("hi", [])).toBe("hi");
    expect(withSecretRefs("", ["chat/a"])).toBe("[secret chat/a stored]");
    const msg = withSecretRefs("deploy", ["chat/a", "chat/b"]);
    expect(splitSecretRefs(msg)).toEqual({ text: "deploy", refs: ["chat/a", "chat/b"] });
    // An older message with the reference inline reads the same way.
    expect(splitSecretRefs("deploy with [secret chat/a stored] now")).toEqual({ text: "deploy with  now", refs: ["chat/a"] });
    expect(splitSecretRefs("plain text")).toEqual({ text: "plain text", refs: [] });
  });
});
