// Settings > Agents (web/src/views/AgentSettings.tsx): every agent's row with its model, shell and
// verbs; the default agent's pill and Select; Edit sends only what changed; every agent has Archive
// while more than one is left; Add starts from a shell and every verb, and sends what is ticked. The fake api, a real DOM. The server side (rows, the verb check, the seed) is
// tests/namedAgents.test.ts A9–A13.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;

beforeAll(() => store.configReady);
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
  localStorage.clear();
  navigate("/");
});

async function open(path: string) {
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); });
  await act(async () => { await flush(); await flush(); });
}
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); await flush(); await flush(); }); };
const row = (name: string) => document.querySelector<HTMLElement>(`[data-slot="agent-row"][data-agent="${name}"]`)!;
const verb = (v: string) => document.querySelector<HTMLElement>(`[data-slot="agent-verb"][data-verb="${v}"]`)!;
/** Type into a controlled input: React listens for the native setter + an input event. */
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); await flush(); });
}

const defs = [
  { name: "chief", displayName: "Chief of Staff", branch: "orchestrator", role: "You are Orca's orchestrator.", model: "claude-opus-5-5", tools: { shell: true, verbs: "all" }, maxGrant: "full", state: "idle" },
  { name: "assistant", displayName: "Assistant", branch: "assistant", role: "You are Orca's Assistant.", model: "claude-sonnet-5-5", tools: { shell: false, verbs: ["board", "chats"] }, maxGrant: "full", state: "idle" },
  { name: "scout", displayName: "Scout", branch: "scout", role: "Look around.", tools: { shell: false, verbs: [] }, maxGrant: "full", state: "idle" },
];

test("AS1: the rows show model, shell and verbs; the default agent; Archive on every row but a last one", async () => {
  apiFake.agentDefsData = defs;
  await open("/settings");
  expect(row("chief").textContent).toContain("default");
  expect(row("assistant").textContent).not.toContain("default");
  expect(document.querySelector('[data-slot="agent-default-select"]')!.textContent).toContain("First agent (Chief of Staff)");
  expect(row("chief").textContent).toContain("shell");
  expect(row("chief").textContent).toContain("all verbs");
  expect(row("assistant").textContent).toContain("no shell");
  expect(row("assistant").textContent).toContain("2 verbs");
  expect(row("scout").textContent).toContain("no verbs");
  expect(row("scout").textContent).toContain("default model");
  for (const n of ["chief", "assistant", "scout"]) expect(row(n).querySelector('[data-slot="agent-archive"]')).not.toBeNull();
});

test("AS1b: the last agent has no Archive", async () => {
  apiFake.agentDefsData = [defs[2]!];
  await open("/settings");
  expect(row("scout").querySelector('[data-slot="agent-archive"]')).toBeNull();
});

test("AS2: Edit sends only what changed: the verb list, then the role", async () => {
  apiFake.agentDefsData = defs;
  await open("/settings");
  await click(row("assistant").querySelector('[data-slot="agent-edit"]')!);
  expect(verb("board").getAttribute("aria-checked")).toBe("true");
  expect(verb("spawn").getAttribute("aria-checked")).toBe("false");
  await click(verb("board"));
  await click(verb("spawn"));
  await click(row("assistant").querySelector('[data-slot="agent-save"]')!);
  expect(apiFake.agentDefCalls).toEqual([["edit", "assistant", { tools: { shell: false, verbs: ["chats", "spawn"] } }]]);

  await click(row("chief").querySelector('[data-slot="agent-edit"]')!);
  // "All verbs" ticks every box and disables them.
  expect(verb("ask").getAttribute("aria-checked")).toBe("true");
  expect(verb("ask").hasAttribute("disabled")).toBe(true);
  await type(row("chief").querySelector<HTMLTextAreaElement>('[data-slot="agent-role"]')!, "You are the boss.");
  await click(row("chief").querySelector('[data-slot="agent-save"]')!);
  expect(apiFake.agentDefCalls[1]).toEqual(["edit", "chief", { role: "You are the boss." }]);
});

test("AS3: Add sends the new row with the verbs ticked; Archive asks first", async () => {
  apiFake.agentDefsData = defs;
  await open("/settings");
  await click(document.querySelector('[data-slot="agent-add"]')!);
  const form = document.querySelector<HTMLElement>('[data-slot="agent-editor"]')!;
  await type(form.querySelector<HTMLInputElement>('[data-slot="agent-name"]')!, "triage");
  await type(form.querySelector<HTMLInputElement>('[data-slot="agent-display"]')!, "Triage");
  await type(form.querySelector<HTMLTextAreaElement>('[data-slot="agent-role"]')!, "Sort the inbox.");
  // A new agent starts like every seeded one: a shell and every verb. Narrow it to one verb, no shell.
  expect(form.querySelector('[data-slot="agent-shell"]')!.getAttribute("aria-checked")).toBe("true");
  expect(form.querySelector('[data-slot="agent-verbs-all"]')!.getAttribute("aria-checked")).toBe("true");
  await click(form.querySelector('[data-slot="agent-shell"]')!);
  await click(form.querySelector('[data-slot="agent-verbs-all"]')!);
  await click(verb("board"));
  await click(form.querySelector('[data-slot="agent-save"]')!);
  expect(apiFake.agentDefCalls).toEqual([["add", "triage", { name: "triage", displayName: "Triage", role: "Sort the inbox.", tools: { shell: false, verbs: ["board"] } }]]);

  await click(row("scout").querySelector('[data-slot="agent-archive"]')!);
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => b.textContent === "Archive")!;
  await click(confirm);
  expect(apiFake.agentDefCalls[1]).toEqual(["archive", "scout", null]);
});
