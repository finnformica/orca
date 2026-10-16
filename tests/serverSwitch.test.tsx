// The server switcher, client side (web/src/lib/server.ts, components/ServerMenu.tsx): several fully
// separate Orca servers, and only this browser talks to each. Off (the default), the app calls only
// its own origin. On, every API call and the event stream go to the ONE chosen base; a change of
// server reloads the page on the home origin, so every store loads again from the new server; an
// offline or refusing server shows one inline message with a way back. GET /api/servers is mocked
// here until the server workstream's route lands.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import { subscribeTurns } from "@/lib/events";
import {
  CHOICE_KEY, MANUAL_KEY, SWITCHER_KEY, _resetServer, _setReloader, addManualServer, apiBase, apiFetch, apiUrl, mergeServers,
  serverOrigin, serverStatus, setSwitcher, switchServer,
} from "@/lib/server";
import { _resetServerList } from "@/components/ServerMenu";
import { getDefaultStore } from "jotai";
import { paletteOpenAtom } from "@/lib/atoms";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type FakeSource = { url: string; close(): void };
const opened = () => (globalThis as unknown as { EventSource: { opened: FakeSource[] } }).EventSource.opened;

beforeAll(() => store.configReady);
const flush = () => new Promise((r) => setTimeout(r, 0));

const SMF = { name: "SMF", url: "http://smf-box:8787" };
const SERVERS = { self: { name: "Work", url: "http://orca.test" }, servers: [
  { name: "Work", url: "http://orca.test", online: true, self: true },
  { name: "SMF", url: "http://smf-box:8787", online: false, self: false },
] };

// A recording fetch: what URL each call went to, and a per-URL answer.
const realFetch = globalThis.fetch;
let calls: string[] = [];
let answer: (url: string) => Promise<Response> = async () => new Response("{}", { status: 200 });
function stubFetch() {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => { const u = String(input); calls.push(u); return answer(u); }) as typeof fetch;
}
let reloads = 0;
function setup(opts: { on?: boolean; choice?: typeof SMF | null } = {}) {
  localStorage.clear();
  if (opts.on) localStorage.setItem(SWITCHER_KEY, "true");
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
  await act(async () => navigate("/"));
});

test("S1: off by default — the base is empty, even with a server stored, and every call stays on this origin", async () => {
  setup({ choice: SMF }); // a choice left from when it was on
  expect(apiBase()).toBe("");
  expect(apiUrl("/api/agents?repo=a")).toBe("/api/agents?repo=a");
  await apiFetch("/api/agents?repo=a");
  expect(calls).toEqual(["/api/agents?repo=a"]);
  const stop = subscribeTurns("r", "b", { step() {}, turn() {}, resync() {} });
  expect(opened().at(-1)!.url).toBe("/api/events");
  stop();
  // The shell: no server menu, and no call to /api/servers.
  await mount();
  expect(q('[data-slot="server-menu"]')).toBeNull();
  expect(calls.some((u) => u.includes("/api/servers"))).toBe(false);
});

test("S2: on with a server chosen — fetch, uploads, images and the event stream all use its base", async () => {
  setup({ on: true, choice: SMF });
  expect(apiBase()).toBe("http://smf-box:8787");
  expect(apiUrl("/api/attachments/7")).toBe("http://smf-box:8787/api/attachments/7");
  expect(apiUrl("data:image/png;base64,AA")).toBe("data:image/png;base64,AA"); // not an API path
  await apiFetch("/api/prs?repo=a", { method: "POST" });
  expect(calls).toEqual(["http://smf-box:8787/api/prs?repo=a"]);
  const stop = subscribeTurns("r", "b", { step() {}, turn() {}, resync() {} });
  expect(opened().at(-1)!.url).toBe("http://smf-box:8787/api/events");
  stop();
});

test("S3: the home server chosen, or the switcher on with nothing chosen, is the same origin", () => {
  setup({ on: true, choice: { name: "Work", url: "http://orca.test/" } });
  expect(apiBase()).toBe("");
  setup({ on: true });
  expect(apiBase()).toBe("");
});

test("S4: a server change stores the choice, moves the event stream and reloads every store from the new server", () => {
  setup({ on: true });
  const stop = subscribeTurns("r", "b", { step() {}, turn() {}, resync() {} });
  const before = opened().at(-1)!;
  expect(before.url).toBe("/api/events");
  switchServer(SMF);
  expect(JSON.parse(localStorage.getItem(CHOICE_KEY)!)).toEqual(SMF);
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

test("S5: switching the switcher off while on another server goes back home", () => {
  setup({ on: true, choice: SMF });
  setSwitcher(false);
  expect(apiBase()).toBe("");
  expect(reloads).toBe(1);
  setSwitcher(true); // on again: the stored choice applies again
  expect(apiBase()).toBe("http://smf-box:8787");
  expect(reloads).toBe(2);
});

test("S6: the header menu lists the home server's servers with their online state, and picks one", async () => {
  setup({ on: true });
  answer = async (u) => (u === "/api/servers" ? new Response(JSON.stringify(SERVERS), { status: 200, headers: { "content-type": "application/json" } }) : new Response("{}"));
  addManualServer("lab-box:9000", "Lab");
  await mount();
  await act(async () => { await flush(); await flush(); });
  const trigger = q('[data-slot="server-menu"]')!;
  expect(trigger.textContent).toContain("Work"); // the side's label
  // In front of the repo menu (when there is one): the server menu is the top bar's first switcher.
  const bar = q('[data-slot="topbar"]')!;
  const repo = bar.querySelector('[data-slot="repo-switcher"]');
  if (repo) expect(trigger.compareDocumentPosition(repo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); await flush(); await flush(); });
  const items = [...document.querySelectorAll<HTMLElement>("[data-server]")];
  expect(items.map((i) => i.getAttribute("aria-label"))).toEqual(["Work, online", "SMF, offline", "Lab, added by hand"]);
  await act(async () => { items[1]!.click(); await flush(); });
  expect(JSON.parse(localStorage.getItem(CHOICE_KEY)!)).toEqual(SMF);
  expect(reloads).toBe(1);
});

test("S6b: the command palette offers every other server, and Add server", async () => {
  setup({ on: true });
  answer = async (u) => (u === "/api/servers" ? new Response(JSON.stringify(SERVERS), { status: 200 }) : new Response("{}"));
  await mount();
  await act(async () => { getDefaultStore().set(paletteOpenAtom, true); await flush(); await flush(); });
  const text = document.querySelector('[data-slot="command-palette"]')!.textContent!;
  expect(text).toContain("Switch server: SMF");
  expect(text).not.toContain("Switch server: Work"); // the side you are on
  expect(text).toContain("Add server by URL");
  await act(async () => { getDefaultStore().set(paletteOpenAtom, false); await flush(); });
});

test("S7: an offline server shows ONE inline message, retrying, with a way back home", async () => {
  setup({ on: true, choice: SMF });
  answer = async (u) => { if (u.startsWith("http://smf-box")) throw new TypeError("Failed to fetch"); return new Response(JSON.stringify(SERVERS)); };
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
  setup({ on: true, choice: SMF });
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
  setup({ on: true, choice: SMF });
  answer = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
  await apiFetch("/api/agents").catch(() => {});
  expect(serverStatus()).toBe("ok");
  setup({ on: true });
  answer = async () => { throw new TypeError("Failed to fetch"); };
  await apiFetch("/api/agents").catch(() => {});
  expect(serverStatus()).toBe("ok");
});

test("S10: URLs and the merged list (pure)", () => {
  expect(serverOrigin("smf-box:8787")).toBe("http://smf-box:8787");
  expect(serverOrigin("http://smf-box:8787/some/path/")).toBe("http://smf-box:8787");
  expect(serverOrigin("ftp://x")).toBeNull();
  expect(serverOrigin("")).toBeNull();
  // No answer from the home server (an older one without the route): it is still listed, as Home.
  expect(mergeServers(null, [{ name: "SMF", url: "http://smf-box:8787" }], "http://orca.test")).toEqual([
    { name: "Home", url: "http://orca.test", self: true, online: true },
    { name: "SMF", url: "http://smf-box:8787", manual: true },
  ]);
  // A server added by hand that the list already has is shown once.
  expect(mergeServers(SERVERS, [{ name: "smf", url: "http://smf-box:8787/" }], "http://orca.test").map((s) => s.name)).toEqual(["Work", "SMF"]);
  setup();
  expect(addManualServer("not a url")).toBeNull();
  expect(JSON.parse(localStorage.getItem(MANUAL_KEY) ?? "[]")).toEqual([]);
});
