// The Integrations page (views/Integrations.tsx) against the fake api (tests/apiFake.ts) in a real DOM:
// People come first as their own section, each person with identities across adapters ("Discord @ana")
// and one level named plainly ("Admin", never "Up to Admin"); Add identity posts to the person; an
// approval preselects the person of the same name; the Discord card leads with its catch-all link,
// which says it posts to any channel with --channel.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import * as notificationStore from "@/lib/notificationStore";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function open(path: string) {
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
}
const all = (slot: string, within: ParentNode = container!) => [...within.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)];
const click = async (el: HTMLElement) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });
const type = async (input: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
});
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

const kinds = [
  { kind: "discord", label: "Discord", caps: {}, place: "channel" },
  { kind: "slack", label: "Slack", caps: {}, place: "channel" },
  { kind: "email", label: "Email", caps: {}, place: "address" },
];
const overview = () => ({
  instance: "local", kinds,
  integrations: [{ id: "discord", kind: "discord", name: "Discord", instance: "*", enabled: true, config: {}, running: true, health: { ok: true } }],
  links: [
    { id: "discord-chan", integrationId: "discord", externalId: "C1", label: "#chan", level: "ask", repos: [], requireMention: true },
    { id: "discord-all", integrationId: "discord", externalId: "*", label: "All channels and DMs", level: "admin", repos: ["r"], requireMention: true },
  ],
  people: [{ id: "ana", name: "Ana", maxLevel: "admin", identities: [
    { adapter: "discord", externalId: "D1", name: "ana" }, { adapter: "email", externalId: "ana@example.com" }, { adapter: "slack", externalId: "S1", name: "ana.s" },
  ] }],
  pairings: [{ code: "ABC123", integrationId: "discord", adapter: "discord", externalId: "D2", name: "Ana", createdAt: Date.now(), expiresAt: Date.now() + 600_000, state: "pending" }],
  subscriptions: [], dead: [],
});

describe("the Integrations page", () => {
  beforeAll(() => store.configReady);
  afterEach(async () => {
    apiFake.reset();
    notificationStore.reset();
    await act(async () => { await store.refresh(); });
    act(() => root?.unmount());
    container?.remove();
    root = container = undefined;
    localStorage.clear();
    navigate("/");
  });

  test("People is its own first section: identities across adapters, plain level names, Add identity", async () => {
    apiFake.integrationsData = overview();
    await open("/integrations");
    const people = all("integration-people")[0]!;
    const list = all("integrations-list")[0]!;
    expect(people.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(all("person-identity").map((e) => e.textContent)).toEqual(["Discord @ana", "Email ana@example.com", "Slack @ana.s"]);
    expect(people.querySelector('[aria-label="Ana max level"]')!.textContent).toBe("Admin");
    expect(container!.textContent).not.toContain("Up to");
    // The pairing names its platform the same way.
    expect(all("pairing")[0]!.textContent).toContain("Discord @Ana");

    await click(people.querySelector<HTMLElement>('[aria-label="Add identity to Ana"]')!);
    expect(dialog()!.textContent).toContain("Add an identity to Ana");
    await type(document.getElementById("identity-id") as HTMLInputElement, "D9");
    await type(document.getElementById("identity-name") as HTMLInputElement, "ana2");
    await act(async () => { dialog()!.querySelector("form")!.requestSubmit(); await flush(); await flush(); });
    expect(apiFake.integrationPosts).toContainEqual({ path: "identities/add", body: { principal: "ana", adapter: "discord", externalId: "D9", name: "ana2" } });
  });

  test("a pairing from another platform preselects the person of the same name", async () => {
    apiFake.integrationsData = overview();
    await open("/integrations");
    await click([...all("pairing")[0]!.querySelectorAll("button")].find((b) => b.textContent === "Approve")!);
    expect(document.getElementById("pair-person")!.textContent).toBe("Ana");
    await act(async () => { dialog()!.querySelector("form")!.requestSubmit(); await flush(); await flush(); });
    expect(apiFake.integrationPosts).toContainEqual({ path: "pairing/approve", body: { code: "ABC123", principal: "ana" } });
  });

  test("the Discord card leads with the catch-all link: its level and repos, and posts with --channel", async () => {
    apiFake.integrationsData = overview();
    await open("/integrations");
    const [first, second] = all("integration-link");
    expect(first!.textContent).toContain("All channels and DMs");
    expect(all("link-level", first)[0]!.textContent).toBe("Admin");
    expect(first!.textContent).toContain("r");
    expect(all("link-catch-all", first)[0]!.textContent).toContain("orca post --link discord-all --channel <id>");
    expect(first!.textContent).not.toContain("only receives");
    expect(second!.textContent).toContain("#chan");
    expect(all("link-level", second)[0]!.textContent).toBe("Viewer");
  });
});
