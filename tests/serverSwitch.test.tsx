// The server switcher, client side (web/src/lib/server.ts, components/ServerMenu.tsx): several fully
// separate Orca servers, and only this browser talks to each. With nothing chosen the app calls only
// its own origin. A chosen server gets every API call and the event stream (the ONE base); a change
// of server reloads the page on the home origin, so every store loads again from the new server; an
// offline or refusing server shows one inline message with a way back. The list merges the home
// server's GET /api/servers, the servers this browser knows and their own lists; each server's
// health is checked from the browser. fetch is a stub keyed by URL.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import { subscribeTurns } from "@/lib/events";
import {
  CHOICE_KEY, KNOWN_KEY, _resetServer, _setReloader, apiBase, apiFetch, apiUrl, currentServer, defaultServerName, knownServers,
  mergeServers, probeServer, rememberServer, serverOrigin, serverStatus, showServerMenu, switchServer, type Probe, type ServersAnswer,
} from "@/lib/server";
import { _resetServerList } from "@/components/ServerMenu";
import { _resetIdentity } from "@/lib/identity";
import { getDefaultStore } from "jotai";
import { paletteOpenAtom } from "@/lib/atoms";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type FakeSource = { url: string; close(): void };
const opened = () => (globalThis as unknown as { EventSource: { opened: FakeSource[] } }).EventSource.opened;

beforeAll(() => store.configReady);
const flush = () => new Promise((r) => setTimeout(r, 0));

const SMF = { name: "SMF", url: "http://smf-box:8787" };
// The home server (the page's origin, http://orca.test) with no Tailscale API and no config list.
const HOME: ServersAnswer = { enabled: true, source: "config", tailscaleApi: false, self: { name: "cloud", url: "http://orca-flow-box.tail1.ts.net:8787" },
  servers: [{ name: "cloud", url: "http://orca-flow-box.tail1.ts.net:8787", online: true, self: true }] };
const PERSONAL: ServersAnswer = { enabled: true, source: "config", tailscaleApi: false, self: { name: "personal", url: "http://orca-personal-box.tail1.ts.net:8787" },
  servers: [{ name: "personal", url: "http://orca-personal-box.tail1.ts.net:8787", online: true, self: true }] };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

// A recording fetch: what URL each call went to, and a per-URL answer.
const realFetch = globalThis.fetch;
let calls: string[] = [];
let answer: (url: string) => Promise<Response> = async () => new Response("{}", { status: 200 });
function stubFetch() {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => { const u = String(input); calls.push(u); return answer(u); }) as typeof fetch;
}
let reloads = 0;
function setup(opts: { choice?: typeof SMF | null } = {}) {
  localStorage.clear();
  if (opts.choice) localStorage.setItem(CHOICE_KEY, JSON.stringify(opts.choice));
  _resetServer();
  _resetServerList();
  reloads = 0;
  _setReloader(() => { reloads++; });
  stubFetch();
}

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });
}
const q = (sel: string) => container!.querySelector<HTMLElement>(sel);

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  globalThis.fetch = realFetch;
  answer = async () => new Response("{}", { status: 200 });
  localStorage.clear();
  _resetServer();
  _resetServerList();
  _resetIdentity();
  await act(async () => navigate("/"));
});

test("S1: nothing chosen — the base is empty, a choice stored by the old Settings switch is ignored, and every call stays on this origin", async () => {
  setup();
  localStorage.setItem("orca.ui.v1.server", JSON.stringify(SMF)); // the old key: never applied now
  _resetServer();
  expect(apiBase()).toBe("");
  expect(apiUrl("/api/agents?repo=a")).toBe("/api/agents?repo=a");
  await apiFetch("/api/agents?repo=a");
  expect(calls).toEqual(["/api/agents?repo=a"]);
  const stop = subscribeTurns("r", "b", { step() {}, turn() {}, resync() {} });
  expect(opened().at(-1)!.url).toBe("/api/events");
  stop();
  // The shell: an older home server (no /api/servers answer) and one server: no menu.
  await mount();
  expect(q('[data-slot="server-menu"]')).toBeNull();
});

test("S2: on with a server chosen — fetch, uploads, images and the event stream all use its base", async () => {
  setup({ choice: SMF });
  expect(apiBase()).toBe("http://smf-box:8787");
  expect(apiUrl("/api/attachments/7")).toBe("http://smf-box:8787/api/attachments/7");
  expect(apiUrl("data:image/png;base64,AA")).toBe("data:image/png;base64,AA"); // not an API path
  await apiFetch("/api/prs?repo=a", { method: "POST" });
  expect(calls).toEqual(["http://smf-box:8787/api/prs?repo=a"]);
  const stop = subscribeTurns("r", "b", { step() {}, turn() {}, resync() {} });
  expect(opened().at(-1)!.url).toBe("http://smf-box:8787/api/events");
  stop();
});

test("S3: the home server chosen, or nothing chosen, is the same origin", () => {
  setup({ choice: { name: "Work", url: "http://orca.test/" } });
  expect(apiBase()).toBe("");
  setup();
  expect(apiBase()).toBe("");
});

test("S4: a server change stores and remembers the choice, moves the event stream and reloads every store from the new server", () => {
  setup();
  const stop = subscribeTurns("r", "b", { step() {}, turn() {}, resync() {} });
  const before = opened().at(-1)!;
  expect(before.url).toBe("/api/events");
  switchServer(SMF);
  expect(JSON.parse(localStorage.getItem(CHOICE_KEY)!)).toEqual(SMF);
  expect(knownServers()).toEqual([SMF]); // this browser has opened it: it stays in the list
  expect(apiBase()).toBe("http://smf-box:8787");
  expect(opened()).not.toContain(before); // the old stream is closed …
  expect(opened().at(-1)!.url).toBe("http://smf-box:8787/api/events"); // … and one is open on the new base
  expect(reloads).toBe(1); // the reload (same origin) drops every cached store and loads it again
  // Back home: the base is empty again, and the page reloads again.
  switchServer(null);
  expect(apiBase()).toBe("");
  expect(opened().at(-1)!.url).toBe("/api/events");
  expect(reloads).toBe(2);
  stop();
});

const online = (answer: ServersAnswer): Probe => ({ health: "online", answer });

test("S5: discovery merge without the Tailscale API — home, its list, known servers, their lists; one row per server (pure)", () => {
  const home = "http://orca.test";
  const known = [
    { name: "100.101.1.2", url: "http://100.101.1.2:8787" }, // added by IP: answers as "personal"
    { name: "orca-personal-box", url: "http://orca-personal-box:8787" }, // the same server by short name: dropped once it answers
    { name: "lab", url: "http://lab-box:8787" },
  ];
  const withSmf: ServersAnswer = { ...PERSONAL, servers: [...PERSONAL.servers, { name: "smf", url: "http://smf-box:8787", online: true, self: false }] };
  const probes: Record<string, Probe> = {
    "http://100.101.1.2:8787": online(withSmf), "http://orca-personal-box:8787": online(PERSONAL), "http://lab-box:8787": { health: "offline" },
  };
  expect(mergeServers(home, HOME, known, probes)).toMatchObject([
    { name: "cloud", url: home, self: true, health: "online" }, // the page's own origin, under its own name
    { name: "personal", url: "http://100.101.1.2:8787", health: "online" }, // its own name, once
    { name: "lab", url: "http://lab-box:8787", health: "offline" },
    { name: "smf", url: "http://smf-box:8787", health: "checking" }, // from personal's own list, not checked yet
  ]);
  // The home server's config list comes before the known servers; its own entry is never a second row.
  const listed: ServersAnswer = { ...HOME, servers: [...HOME.servers, { name: "personal", url: "http://orca-personal-box.tail1.ts.net:8787", online: true, self: false }] };
  expect(mergeServers(home, listed, [{ name: "cloud", url: "http://orca-flow-box.tail1.ts.net:8787" }], {}).map((s) => s.name)).toEqual(["cloud", "personal"]);
  // No answer (an older home server): it is still listed, as "This server".
  expect(mergeServers(home, null, [], {})).toMatchObject([{ name: "This server", url: home, self: true, health: "online" }]);
});

test("S5b: with the Tailscale API the home server's list is the whole list; the chosen server is always listed (pure)", () => {
  const api: ServersAnswer = { ...HOME, source: "tailscale", tailscaleApi: true, servers: [...HOME.servers, { name: "personal", url: "http://orca-personal-box.tail1.ts.net:8787", online: false, self: false }] };
  const rows = mergeServers("http://orca.test", api, [{ name: "lab", url: "http://lab-box:8787" }], {}, { name: "smf", url: "http://smf-box:8787" });
  expect(rows.map((s) => [s.name, s.health])).toEqual([["cloud", "online"], ["personal", "checking"], ["smf", "checking"]]);
  // The API's "offline" is not trusted: only this browser's check sets the health.
  // The menu shows with two servers, or with one when there is no API (Add server and the hint).
  const one = mergeServers("http://orca.test", HOME, [], {});
  expect(showServerMenu(HOME, one)).toBe(true);
  expect(showServerMenu({ ...HOME, tailscaleApi: true }, one)).toBe(false);
  expect(showServerMenu({ ...HOME, tailscaleApi: true }, rows)).toBe(true);
  expect(showServerMenu({ ...HOME, enabled: false }, rows)).toBe(false); // the server turned it off
  expect(showServerMenu(null, one)).toBe(false);
});

// Two real boxes: their own answer's self name is now the Tailscale host (its MagicDNS name's
// first label), not the Orca instance name (server/servers.ts selfInfo).
const FLOW: ServersAnswer = { enabled: true, source: "config", tailscaleApi: false, self: { name: "orca-flow-box", url: "http://orca-flow-box.tail1.ts.net:8787" },
  servers: [{ name: "orca-flow-box", url: "http://orca-flow-box.tail1.ts.net:8787", online: true, self: true },
    { name: "orca-personal-box", url: "http://orca-personal-box.tail1.ts.net:8787", online: true, self: false }] };
const PERSONAL_BOX: ServersAnswer = { enabled: true, source: "config", tailscaleApi: false, self: { name: "orca-personal-box", url: "http://orca-personal-box.tail1.ts.net:8787" },
  servers: [{ name: "orca-personal-box", url: "http://orca-personal-box.tail1.ts.net:8787", online: true, self: true }] };

test("S5c: a server's name is the Tailscale host from its own answer's self name, for the home row and a probed server alike (pure)", () => {
  const home = "http://orca-flow-box.tail1.ts.net:8787";
  const probes: Record<string, Probe> = { "http://orca-personal-box.tail1.ts.net:8787": online(PERSONAL_BOX) };
  expect(mergeServers(home, FLOW, [], probes)).toMatchObject([
    { name: "orca-flow-box", url: home, self: true, health: "online" }, // the home row, under its own answer's self name
    { name: "orca-personal-box", url: "http://orca-personal-box.tail1.ts.net:8787", health: "online" }, // a probed box, under its own self name
  ]);
});

test("S5d: a localhost home is not listed (not an Orca box); the default selection is the first box (pure)", () => {
  setup();
  for (const home of ["http://localhost:8788", "http://127.0.0.1:8788"]) {
    const list = mergeServers(home, FLOW, [], {});
    expect(list).toMatchObject([{ name: "orca-personal-box", url: "http://orca-personal-box.tail1.ts.net:8787", health: "checking" }]);
    expect(currentServer(list)).toEqual(list[0]!); // no choice made: defaults to the first box, not a phantom self row
  }
  // A localhost URL learned any other way (known, a probe's own answer) is never listed either,
  // even on a different port from the home origin (so it is not merely deduped as "the same server").
  const known = [{ name: "home", url: "http://localhost:9000" }];
  const probes: Record<string, Probe> = { "http://127.0.0.1:9001": { health: "online", answer: { ...PERSONAL_BOX, self: { name: "x", url: "http://127.0.0.1:9001" } } } };
  expect(mergeServers("http://localhost:8788", FLOW, known, probes).map((s) => s.url)).toEqual(["http://orca-personal-box.tail1.ts.net:8787"]);
});

test("S5e: a box home (not localhost) is listed as the self row (pure)", () => {
  const home = "http://orca-flow-box.tail1.ts.net:8787";
  const list = mergeServers(home, FLOW, [], {});
  expect(list[0]).toMatchObject({ name: "orca-flow-box", url: home, self: true, health: "online" });
  setup();
  expect(currentServer(list)).toEqual(list[0]!); // no choice made: defaults to the home (self) row
});

/** The fetch stub: home answers HOME, personal answers, lab never answers. */
function network(extra: (u: string) => Response | undefined = () => undefined) {
  answer = async (u) => {
    const r = extra(u);
    if (r) return r;
    if (u === "/api/servers") return json(HOME);
    if (u === "http://orca-personal-box:8787/api/servers") return json(PERSONAL);
    if (u.startsWith("http://lab-box")) throw new TypeError("Failed to fetch");
    return new Response("{}");
  };
}
const openMenu = async () => {
  await act(async () => { q('[data-slot="server-menu"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); await flush(); await flush(); });
  return [...document.querySelectorAll<HTMLElement>("[data-server]")];
};

test("S6: the top bar menu — repos-selector look, current checked, status dot and name, offline disabled, Add server and the env hint", async () => {
  setup();
  rememberServer({ name: "orca-personal-box", url: "http://orca-personal-box:8787" });
  rememberServer({ name: "lab", url: "http://lab-box:8787" });
  network();
  await mount();
  await act(async () => { await flush(); await flush(); await flush(); });
  const trigger = q('[data-slot="server-menu"]')!;
  expect(trigger.textContent).toBe("cloud"); // the home server's own name
  expect(trigger.className).toContain("hover:bg-accent/60"); // the repos selector's trigger, not a tinted pill
  const bar = q('[data-slot="topbar"]')!;
  const repo = bar.querySelector('[data-slot="repo-switcher"]');
  if (repo) expect(trigger.compareDocumentPosition(repo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const items = await openMenu();
  expect(items.map((i) => i.getAttribute("aria-label"))).toEqual(["cloud, online", "personal, online", "lab, offline"]);
  expect(items.map((i) => i.querySelector("[data-health]")!.getAttribute("data-health"))).toEqual(["online", "online", "offline"]);
  expect(items[0]!.getAttribute("aria-checked")).toBe("true");
  expect(items[0]!.querySelectorAll(".lucide-check").length).toBe(1); // a check mark, not a second dot
  expect(items[2]!.hasAttribute("data-disabled")).toBe(true);
  expect(knownServers().find((s) => s.url === "http://orca-personal-box:8787")!.name).toBe("personal"); // renamed from its answer
  expect(document.querySelector('[data-slot="add-server"]')!.textContent).toContain("Add server");
  const hint = document.querySelector('[data-slot="server-hint"]')!.textContent!;
  expect(hint).toContain("TS_OAUTH_CLIENT_ID");
  expect(hint).toContain("TS_OAUTH_CLIENT_SECRET");
  // The checks ran from the browser, against each server directly.
  expect(calls).toContain("http://orca-personal-box:8787/api/servers");
  expect(calls).toContain("http://lab-box:8787/api/servers");
  await act(async () => { items[1]!.click(); await flush(); });
  expect(JSON.parse(localStorage.getItem(CHOICE_KEY)!)).toEqual({ name: "personal", url: "http://orca-personal-box:8787" });
  expect(reloads).toBe(1);
});

test("S6e: the ACTIVE server's identity — title, accent, favicon and sidebar name — and each menu row's name and colour", async () => {
  const WORK = { ...HOME, self: { ...HOME.self, label: "Work", color: "#2f6feb", identity: { name: "Work", color: "#2f6feb" } } };
  const PERSONAL_ID = { ...PERSONAL, self: { ...PERSONAL.self, label: "Personal", color: "#1f9d55", identity: { name: "Personal" } } };
  const icon = document.createElement("link");
  icon.rel = "icon"; icon.href = "/favicon.svg";
  document.head.appendChild(icon);
  // The page came from the work box, but the tab talks to the personal one.
  setup({ choice: { name: "personal", url: "http://orca-personal-box:8787" } });
  network((u) => (u === "/api/servers" ? json(WORK) : u === "http://orca-personal-box:8787/api/servers" ? json(PERSONAL_ID) : undefined));
  await mount();
  await act(async () => { await flush(); await flush(); await flush(); });
  expect(calls).toContain("http://orca-personal-box:8787/api/servers"); // asked of the chosen server, cross-origin
  expect(document.title).toBe("Orca | Personal");
  expect(document.documentElement.style.getPropertyValue("--server")).toBe("#1f9d55");
  expect(decodeURIComponent(icon.href)).toContain('fill="#1f9d55"');
  expect(q('[data-slot="server-identity"]')!.textContent).toBe("Personal"); // beside the mark, top left
  expect(q('[data-slot="server-label"]')!.textContent).toBe("Personal");
  const items = await openMenu();
  expect(items.map((i) => i.getAttribute("aria-label"))).toEqual(["Work, online", "Personal, online"]);
  expect(items.map((i) => i.getAttribute("data-server"))).toEqual(["cloud", "personal"]); // still matched by host name
  const swatches = items.map((i) => i.querySelector<HTMLElement>('[data-slot="server-swatch"]')!.getAttribute("style"));
  expect(swatches[0]).toMatch(/#2f6feb|rgb\(47, 111, 235\)/);
  expect(swatches[1]).toMatch(/#1f9d55|rgb\(31, 157, 85\)/);
  // The same answer, cached per server, paints the next load before the fetch lands.
  expect(localStorage.getItem("orca.ui.v1.server.identity:http://orca-personal-box:8787")).toContain("Personal");
  icon.remove();
});

test("S6b: with the Tailscale API and one server there is no menu, and no hint when the API is set", async () => {
  setup();
  network((u) => (u === "/api/servers" ? json({ ...HOME, tailscaleApi: true, source: "tailscale" }) : undefined));
  await mount();
  await act(async () => { await flush(); await flush(); });
  expect(q('[data-slot="server-menu"]')).toBeNull();
  act(() => root?.unmount());
  container?.remove();
  _resetServerList();
  network((u) => (u === "/api/servers" ? json({ ...HOME, tailscaleApi: true, source: "tailscale", servers: [...HOME.servers, { name: "personal", url: "http://orca-personal-box:8787", online: true, self: false }] }) : undefined));
  await mount();
  await act(async () => { await flush(); await flush(); });
  await openMenu();
  expect(document.querySelector('[data-slot="server-hint"]')).toBeNull();
  expect([...document.querySelectorAll("[data-server]")].map((i) => i.getAttribute("data-server"))).toEqual(["cloud", "personal"]);
});

test("S6c: the command palette offers every other server that answers, and Add server", async () => {
  setup();
  rememberServer({ name: "orca-personal-box", url: "http://orca-personal-box:8787" });
  rememberServer({ name: "lab", url: "http://lab-box:8787" });
  network();
  await mount();
  await act(async () => { await flush(); await flush(); await flush(); });
  await act(async () => { getDefaultStore().set(paletteOpenAtom, true); await flush(); await flush(); });
  const text = document.querySelector('[data-slot="command-palette"]')!.textContent!;
  expect(text).toContain("Switch server: personal");
  expect(text).not.toContain("Switch server: cloud"); // the side you are on
  expect(text).not.toContain("Switch server: lab"); // offline
  expect(text).toContain("Add server");
  await act(async () => { getDefaultStore().set(paletteOpenAtom, false); await flush(); });
});

const type = (input: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

test("S6d: Add server keeps the focus in its dialog, asks the server, and switches to it under its own name", async () => {
  setup();
  network();
  await mount();
  await act(async () => { await flush(); await flush(); });
  await openMenu(); // one server and no API: the menu still shows, for Add server
  const dialog = document.querySelector<HTMLDialogElement>('[data-slot="add-server-dialog"]')!;
  await act(async () => { (document.querySelector('[data-slot="add-server"]') as HTMLElement).click(); await flush(); });
  // The dialog opens once the menu has closed (its close animation, then its focus hand-back).
  for (let i = 0; i < 100 && !dialog.open; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  expect(dialog.open).toBe(true);
  const input = dialog.querySelector("input")!;
  expect(document.activeElement).toBe(input); // the menu did not take the focus back to its trigger
  // A server that does not answer: kept in the list as offline, no switch.
  await act(async () => { type(input, "lab-box:8787"); await flush(); });
  await act(async () => { dialog.querySelector("form")!.requestSubmit(); await flush(); await flush(); });
  expect(dialog.querySelector('[data-slot="add-server-error"]')!.textContent).toContain("lab-box did not answer");
  expect(knownServers().map((s) => s.name)).toContain("lab-box");
  expect(reloads).toBe(0);
  // One that answers: remembered under its own name, and the app switches to it.
  await act(async () => { type(input, "orca-personal-box:8787"); await flush(); });
  await act(async () => { dialog.querySelector("form")!.requestSubmit(); await flush(); await flush(); });
  expect(JSON.parse(localStorage.getItem(CHOICE_KEY)!)).toEqual({ name: "personal", url: "http://orca-personal-box:8787" });
  expect(reloads).toBe(1);
});

test("S7: an offline server shows ONE inline message, retrying, with a way back home", async () => {
  setup({ choice: SMF });
  answer = async (u) => { if (u.startsWith("http://smf-box")) throw new TypeError("Failed to fetch"); return json(HOME); };
  await apiFetch("/api/agents").catch(() => {});
  await apiFetch("/api/prs").catch(() => {});
  expect(serverStatus()).toBe("unreachable");
  await mount();
  const msgs = container!.querySelectorAll('[data-slot="server-offline"]');
  expect(msgs.length).toBe(1);
  expect(msgs[0]!.textContent).toContain("SMF server unreachable, retrying");
  expect(document.querySelectorAll('[data-slot="toast"]').length).toBe(0); // no toast for it
  expect(calls.some((u) => u === "http://smf-box:8787/api/config")).toBe(true); // it retries
  await act(async () => { q('[data-slot="server-home"]')!.click(); await flush(); });
  expect(JSON.parse(localStorage.getItem(CHOICE_KEY)!)).toBeNull();
  expect(apiBase()).toBe("");
  expect(reloads).toBe(1);
});

test("S8: a 403 reads as refused; the server answering again clears the message", async () => {
  setup({ choice: SMF });
  answer = async () => new Response("{}", { status: 403 });
  await apiFetch("/api/agents");
  expect(serverStatus()).toBe("refused");
  await mount();
  expect(q('[data-slot="server-offline"]')!.textContent).toContain("SMF server refused this browser");
  answer = async () => new Response("{}", { status: 200 });
  await act(async () => { await apiFetch("/api/agents"); await flush(); });
  expect(q('[data-slot="server-offline"]')).toBeNull();
});

test("S9: an abort says nothing about the server; the home server is never judged", async () => {
  setup({ choice: SMF });
  answer = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
  await apiFetch("/api/agents").catch(() => {});
  expect(serverStatus()).toBe("ok");
  setup();
  answer = async () => { throw new TypeError("Failed to fetch"); };
  await apiFetch("/api/agents").catch(() => {});
  expect(serverStatus()).toBe("ok");
});

test("S11: probeServer tells a CORS-blocked origin apart from a dead server with a no-cors fallback", async () => {
  setup();
  // The first (cors) fetch fails exactly as it would for a dead server; the server answers the
  // second (no-cors) one, so it is alive, just not trusting this origin — "refused", not "offline".
  let noCorsCalls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.mode === "no-cors") { noCorsCalls++; return new Response(null, { status: 200 }); }
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  expect(await probeServer("http://box-b:8787")).toEqual({ health: "refused" });
  expect(noCorsCalls).toBe(1);
});

test("S12: probeServer reads a server that fails both the cors and no-cors fetch as offline", async () => {
  setup();
  globalThis.fetch = (async (_input: RequestInfo | URL) => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
  expect(await probeServer("http://ghost-box:8787")).toEqual({ health: "offline" });
});

test("S10: URLs and names (pure)", () => {
  expect(serverOrigin("smf-box:8787")).toBe("http://smf-box:8787");
  expect(serverOrigin("http://smf-box:8787/some/path/")).toBe("http://smf-box:8787");
  expect(serverOrigin("ftp://x")).toBeNull();
  expect(serverOrigin("")).toBeNull();
  // The preview showed "0" for a server added as 127.0.0.1: an IP keeps its whole host.
  expect(defaultServerName("http://100.101.1.2:8787")).toBe("100.101.1.2");
  expect(defaultServerName("http://orca-personal-box.tail1.ts.net:8787")).toBe("orca-personal-box");
  setup();
  expect(rememberServer({ url: "not a url" })).toBeNull();
  expect(JSON.parse(localStorage.getItem(KNOWN_KEY) ?? "[]")).toEqual([]);
});
