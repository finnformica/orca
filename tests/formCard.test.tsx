// The chat's form card (`orca ask-form`, components/FormCard.tsx) and the composer's paste guard
// (components/ChatComposer.tsx), in a real DOM against the fake api (tests/apiFake.ts). A secret
// field is masked with a reveal toggle and its value leaves the card only in the submit call; a
// key-like paste is held before it is sent, with "Save as secret" or "Send anyway".
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { FormCard } from "@/components/FormCard";
import { ChatComposer } from "@/components/ChatComposer";
import { parseFormSpec, type FormView } from "../shared/forms";
import { EVERY_TYPE } from "./formFixture";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SECRET = "sk-test-FAKE0000secret0000value";
const ID = "0b9f3c1e-1111-4222-8333-444455556666";
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
const field = (name: string) => q<HTMLInputElement>(`[name="${name}"]`)!;
async function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    await flush();
  });
}
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); await flush(); await flush(); }); };

const form = (): FormView => ({ ...parseFormSpec({ title: "Set up billing", intro: "Two minutes.", fields: EVERY_TYPE }), id: ID, state: "open", createdAt: 1_700_000_000_000 });

describe("form card", () => {
  test("one input per field type; a secret is masked with a reveal toggle", async () => {
    apiFake.formById.set(ID, form());
    await render(<FormCard id={ID} />);
    const types = [...container!.querySelectorAll("[data-slot=form-field]")].map((e) => e.getAttribute("data-type"));
    expect(types).toEqual(EVERY_TYPE.map((f) => f.type));
    expect(field("project").type).toBe("text");
    expect(field("notes").tagName).toBe("TEXTAREA");
    expect(field("replicas")).toMatchObject({ type: "number", value: "2" }); // its default
    expect(field("launch").type).toBe("date");
    expect(field("window").type).toBe("datetime-local");
    expect(field("region").tagName).toBe("SELECT");
    expect(container!.querySelectorAll("[data-slot=form-multiselect] [role=checkbox]")).toHaveLength(3);
    expect(field("homepage").type).toBe("url");
    expect(field("contact").type).toBe("email");
    const secret = field("api_key");
    expect(secret.type).toBe("password");
    expect(secret.getAttribute("autocomplete")).toBe("new-password");
    await click(q("[data-slot=form-secret-reveal]")!);
    expect(field("api_key").type).toBe("text");
    await click(q("[data-slot=form-secret-reveal]")!);
    expect(field("api_key").type).toBe("password");
  });

  test("Submit checks every field first; a valid submit sends the values once, and the answered card shows a secret only as stored", async () => {
    apiFake.formById.set(ID, form());
    await render(<FormCard id={ID} />);
    await click(q("[data-slot=form-submit]")!);
    const errors = [...container!.querySelectorAll("[data-slot=form-field-error]")].map((e) => e.textContent);
    expect(errors).toEqual(["Project name is required", "Region is required", "Features choose at least 1", "I accept the terms is required", "API key is required"]);
    expect(apiFake.formCalls.filter(([k]) => k === "submit")).toEqual([]);

    await setValue(field("project"), "orca");
    await setValue(field("region") as unknown as HTMLSelectElement, "us-east-1");
    await click(container!.querySelector("[data-slot=form-multiselect] [role=checkbox]")!);
    await click(container!.querySelector("[data-type=checkbox] [role=checkbox]")!);
    await setValue(field("contact"), "nope");
    await click(q("[data-slot=form-submit]")!);
    expect([...container!.querySelectorAll("[data-slot=form-field-error]")].map((e) => e.textContent)).toEqual(["Contact email must be an email address", "API key is required"]);
    await setValue(field("contact"), "a@example.com");
    await setValue(field("api_key"), SECRET);
    await click(q("[data-slot=form-submit]")!);

    const submits = apiFake.formCalls.filter(([k]) => k === "submit");
    expect(submits).toHaveLength(1);
    expect(submits[0]![2]).toMatchObject({ project: "orca", region: "us-east-1", features: ["auth"], agree: true, contact: "a@example.com", api_key: SECRET, replicas: "2" });
    expect(q("[data-slot=chat-form]")!.getAttribute("data-state")).toBe("submitted");
    expect(q("[data-slot=form-answers]")!.textContent).toContain("Stored as secret billing/api_key");
    expect(container!.innerHTML).not.toContain(SECRET);
  });

  test("Cancel closes the form; the server's field errors show on their fields", async () => {
    apiFake.formById.set(ID, form());
    apiFake.submitFormError = { message: "fix the form: contact must be an email address", errors: { contact: "must be an email address" } };
    await render(<FormCard id={ID} />);
    for (const [n, v] of [["project", "orca"], ["contact", "a@example.com"], ["api_key", SECRET]] as const) await setValue(field(n), v);
    await setValue(field("region") as unknown as HTMLSelectElement, "eu-west-2");
    await click(container!.querySelector("[data-slot=form-multiselect] [role=checkbox]")!);
    await click(container!.querySelector("[data-type=checkbox] [role=checkbox]")!);
    await click(q("[data-slot=form-submit]")!);
    expect(q("[data-slot=form-error]")!.textContent).toContain("fix the form");
    expect([...container!.querySelectorAll("[data-slot=form-field-error]")].map((e) => e.textContent)).toEqual(["Contact email must be an email address"]);
    await click(q("[data-slot=form-cancel]")!);
    expect(q("[data-slot=chat-form]")!.getAttribute("data-state")).toBe("cancelled");
    expect(q("[data-slot=form-state]")!.textContent).toBe("Cancelled");
  });
});

describe("paste guard", () => {
  async function mount(sent: string[]) {
    await render(<ChatComposer onSubmit={async (t) => { sent.push(t); }} />);
    return q<HTMLTextAreaElement>("textarea")!;
  }
  async function paste(el: HTMLTextAreaElement, text: string) {
    await act(async () => {
      const ev = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", { value: { items: [], files: [], getData: (t: string) => (t === "text/plain" ? text : "") } });
      el.dispatchEvent(ev);
      await flush();
    });
    await setValue(el, `${el.value}${text}`); // happy-dom does not insert a paste itself
  }
  const enter = async (el: HTMLTextAreaElement) => { await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await flush(); }); };

  test("a pasted key is held: Enter does not send; Send anyway sends it as it is", async () => {
    const sent: string[] = [];
    const el = await mount(sent);
    await setValue(el, "use ");
    await paste(el, SECRET);
    expect(q("[data-slot=paste-guard]")!.textContent).toContain("This looks like an OpenAI-style API key");
    expect(q<HTMLInputElement>("[data-slot=paste-guard-name]")!.value).toBe("api-key");
    await enter(el);
    expect(sent).toEqual([]);
    await click(q("[data-slot=paste-guard-send]")!);
    expect(sent).toEqual([`use ${SECRET}`]);
    expect(q("[data-slot=paste-guard]")).toBeNull();
  });

  test("Save as secret stores the value and sends only its name", async () => {
    const sent: string[] = [];
    const el = await mount(sent);
    await setValue(el, "deploy with ");
    await paste(el, SECRET);
    await setValue(q<HTMLInputElement>("[data-slot=paste-guard-name]")!, "stripe_key");
    await click(q("[data-slot=paste-guard-save]")!);
    expect(apiFake.secretSaves).toEqual([{ name: "stripe_key", scope: "chat", value: SECRET }]);
    expect(sent).toEqual(["deploy with [secret chat/stripe_key stored]"]);
    expect(sent.join()).not.toContain(SECRET);
  });

  test("a typed key is held at send too; ordinary text is not", async () => {
    const sent: string[] = [];
    const el = await mount(sent);
    await setValue(el, "merge 3f2a9c1d7e5b4a6f8c0d2e4f6a8b0c2d4e6f8a0b when green");
    await enter(el);
    expect(sent).toEqual(["merge 3f2a9c1d7e5b4a6f8c0d2e4f6a8b0c2d4e6f8a0b when green"]);
    await setValue(el, "key AKIAIOSFODNN7EXAMPLE");
    await enter(el);
    expect(sent).toHaveLength(1);
    expect(q("[data-slot=paste-guard]")!.textContent).toContain("AWS access key");
  });
});
