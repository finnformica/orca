// The Integrations page (views/Integrations.tsx) against the fake api (tests/apiFake.ts) in a real DOM:
// People come first as their own section, each person with identities across adapters ("Discord @ana")
// and one level named plainly ("Admin", never "Up to Admin"); Add identity posts to the person; an
// approval preselects the person of the same name; the Discord card leads with its catch-all link,
// which says it posts to any channel with --channel.
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
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
  integrations: [{ id: "discord", kind: "discord", name: "Discord", instance: "*", enabled: true, config: {}, access: "read-write", events: "trigger", running: true, health: { ok: true } }],
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

  test("each account shows its Access and Events; an account's events turn a link's switch off, never on", async () => {
    const data = overview();
    apiFake.integrationsData = data;
    await open("/integrations");
    const card = all("integration-card")[0]!;
    expect(card.querySelector('[aria-label="Discord access"]')!.textContent).toBe("Read and write");
    expect(card.querySelector('[aria-label="Discord events"]')!.textContent).toBe("Wake an agent");
    const agentSwitch = () => all("integration-link")[0]!.querySelector<HTMLElement>('[data-slot="link-notify-agent"] [role="switch"]')!;
    expect(agentSwitch().getAttribute("aria-checked")).toBe("true");
    expect(agentSwitch().hasAttribute("disabled")).toBe(false);
    act(() => root?.unmount());
    container?.remove();

    apiFake.integrationsData = { ...data, integrations: [{ ...data.integrations[0]!, access: "read", events: "record" }] };
    await open("/integrations");
    const ro = all("integration-card")[0]!;
    expect(ro.querySelector('[aria-label="Discord access"]')!.textContent).toBe("Read");
    expect(ro.querySelector('[aria-label="Discord events"]')!.textContent).toBe("Inbox only");
    expect(agentSwitch().getAttribute("aria-checked")).toBe("false"); // the link says on; the account says no agent
    expect(agentSwitch().hasAttribute("disabled")).toBe(true);
    expect(all("integration-link")[0]!.querySelector<HTMLElement>('[data-slot="link-notify-me"] [role="switch"]')!.getAttribute("aria-checked")).toBe("true");
  });

  test("each link has two switches, Notify me and Notify agent, on unless the link says off; a click saves that one switch", async () => {
    const data = overview();
    data.links = [{ ...data.links[0]!, notifyAgent: false } as typeof data.links[0], data.links[1]!];
    apiFake.integrationsData = data;
    await open("/integrations");
    const byLabel = (l: string) => all("integration-link").find((e) => e.textContent!.includes(l))!;
    const sw = (l: string, slot: string) => byLabel(l).querySelector<HTMLElement>(`[data-slot="${slot}"] [role="switch"]`)!;
    expect(sw("#chan", "link-notify-me").getAttribute("aria-checked")).toBe("true");
    expect(sw("#chan", "link-notify-agent").getAttribute("aria-checked")).toBe("false");
    expect(sw("#chan", "link-notify-agent").getAttribute("aria-label")).toBe("Notify agent for #chan");
    expect(sw("All channels and DMs", "link-notify-me").getAttribute("aria-checked")).toBe("true");
    expect(sw("All channels and DMs", "link-notify-agent").getAttribute("aria-checked")).toBe("true");
    expect(container!.textContent).not.toContain("Unknown senders");
    await click(sw("All channels and DMs", "link-notify-me"));
    expect(apiFake.integrationPosts).toEqual([{ path: "links/save", body: expect.objectContaining({ id: "discord-all", notifyMe: false }) }]);
    expect(apiFake.integrationPosts[0]!.body.notifyAgent).toBeUndefined(); // only the switch you flipped
  });

  const GMAIL_DOCS = "https://github.com/finnformica/orca/blob/main/docs/integrations/gmail.md";
  const gmailKind = { kind: "gmail", label: "Gmail", caps: {}, place: "sender address", oauth: { provider: "google", label: "Sign in with Google", docs: GMAIL_DOCS }, switches: { checkAuth: true },
    config: [{ key: "query", label: "Gmail query" }, { key: "checkAuth", label: "Require auth" }], help: "Your Gmail, read only." };
  const gmailCard = (oauth?: Record<string, unknown>) => ({ id: "gm", kind: "gmail", name: "My Gmail", instance: "*", enabled: true, access: "read", events: "off", config: {}, running: true, health: { ok: !oauth?.reconnect }, ...(oauth ? { oauth } : {}) });
  // This test page is plain http (http://orca.test): a server with a fixed https redirect origin lets sign-in run.
  const fixedKind = { ...gmailKind, oauth: { ...gmailKind.oauth, fixedOrigin: true } };

  test("Connect > Gmail: ONE Sign in with Google button, no name, id or secret; a click adds an account by Google's consent URL", async () => {
    apiFake.integrationsData = { ...overview(), kinds: [fixedKind, ...kinds], integrations: [], links: [], pairings: [] }; // Gmail first: the dialog opens on it
    apiFake.integrationPostAnswers["oauth/google/start"] = { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=cid", redirectUri: "x" };
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      await open("/integrations");
      await click(all("integration-connect")[0]!);
      const d = dialog()!;
      expect(d.querySelector("#int-kind")!.textContent).toContain("Gmail"); // the kind Select stays, to pick another kind
      expect(d.querySelectorAll("input")).toHaveLength(0); // nothing to type
      expect(d.querySelector("#int-name, #int-id, #int-secret, #int-stored-secret")).toBeNull();
      expect(d.textContent).not.toContain("Save");
      const buttons = all("oauth-sign-in", d);
      expect(buttons).toHaveLength(1);
      expect(buttons[0]!.textContent).toBe("Sign in with Google");
      expect(buttons[0]!.querySelector('[data-slot="brand-icon"][data-kind="gmail"]')).not.toBeNull();
      await click(buttons[0]!);
      expect(apiFake.integrationPosts).toEqual([{ path: "oauth/google/start", body: { origin: window.location.origin } }]); // no id: a new account
      expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?client_id=cid");
    } finally { assign.mockRestore(); }
  });

  test("Connect > Granola: ONE password field for the pasted key (no secret variable); Save sends it once, a bad paste is refused", async () => {
    const granola = { kind: "granola", label: "Granola", caps: {}, apiKey: { label: "Granola API key", placeholder: "grn_…", prefix: "grn_", hint: "Make it in the Granola desktop app: Settings > Connectors > API keys." } };
    apiFake.integrationsData = { ...overview(), kinds: [granola, ...kinds], integrations: [], links: [], pairings: [] };
    await open("/integrations");
    await click(all("integration-connect")[0]!);
    const d = dialog()!;
    expect(d.querySelector("#int-kind")!.textContent).toContain("Granola");
    expect(d.querySelector("#int-secret, #int-stored-secret")).toBeNull();
    const key = d.querySelector<HTMLInputElement>('[data-slot="integration-api-key"]')!;
    expect(key.type).toBe("password");
    expect(d.textContent).toContain("Settings > Connectors > API keys");
    await type(d.querySelector<HTMLInputElement>("#int-name")!, "Granola");
    const submit = () => act(async () => { d.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await flush(); await flush(); });
    await submit();
    expect(d.textContent).toContain("paste the API key");
    await type(key, "sk-wrong");
    await submit();
    expect(d.textContent).toContain("a Granola API key starts with grn_");
    expect(apiFake.integrationPosts).toEqual([]);
    await type(key, "grn_abc123");
    await submit();
    expect(apiFake.integrationPosts).toEqual([{ path: "save", body: expect.objectContaining({ id: "granola", kind: "granola", name: "Granola", apiKey: "grn_abc123", secretRef: "" }) }]);
  });

  test("Connect > Gmail when the server has no OAuth client: one line with the setup guide, no button", async () => {
    const setup = "Gmail sign-in is not set up: the server has no Google OAuth client ID.";
    apiFake.integrationsData = { ...overview(), kinds: [{ ...fixedKind, oauth: { ...fixedKind.oauth, setup } }], integrations: [], links: [], pairings: [] };
    await open("/integrations");
    await click(all("integration-connect")[0]!);
    const line = all("oauth-setup", dialog()!)[0]!;
    expect(line.textContent).toContain(setup);
    expect(line.querySelector("a")!.getAttribute("href")).toBe(GMAIL_DOCS);
    expect(all("oauth-sign-in", dialog()!)).toHaveLength(0);
  });

  test("Connect > Gmail from a plain-http page: one line says to open the https address, no button", async () => {
    apiFake.integrationsData = { ...overview(), kinds: [gmailKind], integrations: [], links: [], pairings: [] };
    await open("/integrations");
    await click(all("integration-connect")[0]!);
    expect(all("oauth-origin", dialog()!)[0]!.textContent).toContain("(plain http)");
    expect(all("oauth-sign-in", dialog()!)).toHaveLength(0);
  });

  test("a Gmail card not connected: Sign in with Google reconnects that row", async () => {
    apiFake.integrationsData = { ...overview(), kinds: [...kinds, fixedKind], integrations: [gmailCard()], links: [], pairings: [] };
    apiFake.integrationPostAnswers["oauth/google/start"] = { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=cid", redirectUri: "x" };
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      await open("/integrations");
      const row = all("integration-oauth")[0]!;
      expect(row.textContent).toContain("Not connected");
      const button = all("oauth-connect", row)[0]!;
      expect(button.textContent).toBe("Sign in with Google");
      await click(button);
      expect(apiFake.integrationPosts).toEqual([{ path: "oauth/google/start", body: { id: "gm", origin: window.location.origin } }]);
      expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?client_id=cid");
    } finally { assign.mockRestore(); }
  });

  test("from a plain-http page with no https redirect origin, the card's sign-in is off and says to open the https address", async () => {
    apiFake.integrationsData = { ...overview(), kinds: [...kinds, gmailKind], integrations: [gmailCard()], links: [], pairings: [] };
    await open("/integrations");
    const row = all("integration-oauth")[0]!;
    expect(all("oauth-origin", row)[0]!.textContent).toContain("works only from Orca's https address");
    expect(all("oauth-origin", row)[0]!.textContent).toContain("(plain http)");
    const button = all("oauth-connect", row)[0]! as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await click(button);
    expect(apiFake.integrationPosts).toEqual([]);
  });

  test("Rename on the card: the account keeps everything but its name", async () => {
    apiFake.integrationsData = { ...overview(), kinds: [fixedKind], integrations: [{ ...gmailCard({ account: "finn@example.com", scopes: [] }), name: "finn@example.com" }], links: [], pairings: [] };
    await open("/integrations");
    await click(container!.querySelector<HTMLElement>('[aria-label="Rename finn@example.com"]')!);
    const input = dialog()!.querySelector<HTMLInputElement>('[data-slot="integration-rename"]')!;
    expect(input.value).toBe("finn@example.com");
    await type(input, "Personal");
    await act(async () => { dialog()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await flush(); await flush(); });
    expect(apiFake.integrationPosts).toEqual([{ path: "save", body: { id: "gm", kind: "gmail", name: "Personal", instance: "*", secretRef: "", config: {}, enabled: true } }]);
  });

  test("the Gmail logo is Google's multicolour M", async () => {
    apiFake.integrationsData = { ...overview(), kinds: [fixedKind], integrations: [gmailCard()], links: [], pairings: [] };
    await open("/integrations");
    const icon = all("integration-card")[0]!.querySelector<SVGElement>('[data-slot="brand-icon"][data-kind="gmail"]')!;
    expect(icon.tagName.toLowerCase()).toBe("svg");
    expect([...icon.querySelectorAll("path")].map((p) => p.getAttribute("fill"))).toEqual(["#4285F4", "#34A853", "#FBBC04", "#EA4335", "#C5221F"]);
  });

  test("the Cloudflare logo is its own two-tone orange cloud", async () => {
    apiFake.integrationsData = { ...overview(), kinds: [{ kind: "cloudflare", label: "Cloudflare", caps: {}, place: "place" }],
      integrations: [{ id: "cf", kind: "cloudflare", name: "Cloudflare", instance: "*", enabled: true, config: {}, access: "read", events: "trigger", running: true, health: { ok: true } }], links: [], pairings: [] };
    await open("/integrations");
    const icon = all("integration-card")[0]!.querySelector<SVGElement>('[data-slot="brand-icon"][data-kind="cloudflare"]')!;
    expect(icon.tagName.toLowerCase()).toBe("svg");
    expect([...icon.querySelectorAll("path")].map((p) => p.getAttribute("fill"))).toEqual(["#F38020", "#FBAE40"]);
  });

  test("Settings > Google sign-in: the operator sets the client id and points the secret at a stored secret", async () => {
    apiFake.googleOAuthData = { clientId: "", secretRef: "", redirectOrigin: "", envClientId: false, defaultSecretRef: "ORCA_SECRET_GOOGLE_OAUTH" };
    apiFake.holdConfig = false; // another file may leave config held (reset() keeps it)
    await open("/settings");
    // The card reads /api/config on mount: wait for it (bounded).
    for (let i = 0; i < 50 && !all("settings-google-oauth").length; i++) await act(async () => { await flush(); });
    const card = all("settings-google-oauth")[0]!;
    expect(card.textContent).toContain("/api/integrations/oauth/google/callback");
    expect(card.textContent).toContain("None: use ORCA_SECRET_GOOGLE_OAUTH in .env");
    await type(card.querySelector<HTMLInputElement>('[data-slot="google-client-id"]')!, "cid.apps.googleusercontent.com");
    await click(all("google-oauth-save", card)[0]!);
    expect(apiFake.setGoogleOAuthCalls).toEqual([{ clientId: "cid.apps.googleusercontent.com", secretRef: "", redirectOrigin: "" }]);
  });

  test("a connected Gmail card names the account and scopes; a refused grant says reconnect needed and offers Reconnect", async () => {
    apiFake.integrationsData = { ...overview(), kinds: [...kinds, gmailKind], links: [], pairings: [], integrations: [gmailCard({
      account: "finn@example.com", scopes: ["https://www.googleapis.com/auth/gmail.readonly"], reconnect: "reconnect needed: Google refused the grant",
    })] };
    await open("/integrations");
    const row = all("integration-oauth")[0]!;
    expect(row.textContent).toContain("Signed in as finn@example.com · read only");
    expect(all("oauth-reconnect", row)[0]!.textContent).toBe("reconnect needed: Google refused the grant");
    expect(all("oauth-connect", row)[0]!.textContent).toBe("Reconnect with Google");
    expect(row.textContent).toContain("Disconnect");
  });

  test("an account switched to read-write whose grant lacks gmail.send: Reconnect to allow sending", async () => {
    const read = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/gmail.readonly"];
    apiFake.integrationsData = { ...overview(), kinds: [...kinds, gmailKind], links: [], pairings: [], integrations: [gmailCard({
      account: "finn@example.com", scopes: read, missing: ["https://www.googleapis.com/auth/gmail.send"], reconnect: null,
    })] };
    await open("/integrations");
    const row = all("integration-oauth")[0]!;
    expect(row.textContent).toContain("· read only");
    expect(all("oauth-connect", row)[0]!.textContent).toBe("Reconnect to allow sending");
  });

  test("a Gmail card carries the core policy row (Access, Events) beside Sign in with Google", async () => {
    apiFake.integrationsData = { ...overview(), kinds: [gmailKind], integrations: [gmailCard()], links: [], pairings: [] };
    await open("/integrations");
    const card = all("integration-card")[0]!;
    expect(all("integration-policy", card)).toHaveLength(1);
    expect(card.querySelector('[aria-label="My Gmail access"]')!.textContent).toBe("Read");
    expect(card.querySelector('[aria-label="My Gmail events"]')!.textContent).toBe("Off");
    expect(all("integration-oauth", card)).toHaveLength(1);
  });

  test("back from Google with a failure: one action-failed notification, and the query leaves the URL", async () => {
    apiFake.integrationsData = { ...overview(), kinds: [gmailKind], integrations: [gmailCard()], links: [], pairings: [] };
    await open("/integrations?oauth=failed&id=gm&detail=you%20did%20not%20allow%20access%20at%20Google");
    expect(window.location.search).toBe("");
    expect(document.body.textContent).toContain("you did not allow access at Google");
  });
});
