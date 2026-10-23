// The surface rules (docs/design/surfaces.md), the key ones pinned: the orchestrator's dock card, its
// header and its chat log are ONE surface (the page level, as the page card and its top bar), and the
// composer is a raised card on it. The Ask pill's one look open and closed is in quickAsk.test.tsx.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { AskOrchestrator, OrchestratorPanel } from "@/components/Terminal";
import { Dock } from "@/components/Shell";
import { orchestratorOpenAtom } from "@/lib/atoms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Segmented, filterChipClass } from "@/components/console";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  apiFake.reset();
  localStorage.clear();
  getDefaultStore().set(orchestratorOpenAtom, false);
});

const fills = (el: Element) => el.className.split(/\s+/).filter((c) => /^(md:)?(data-\[[^\]]+\]:)?bg-/.test(c));

test("S1: the orchestrator's dock, panel, header and chat log share the page surface; the composer is a raised card", async () => {
  apiFake.turnsData.set("@orca::orchestrator", [{ id: "run-1", provider: "claude", instruction: "hi", prompt: "p", response: "Hello.", startedAt: 1, finishedAt: 2 }]);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<><AskOrchestrator /><Dock /><OrchestratorPanel /></>); await flush(); });
  await act(async () => { getDefaultStore().set(orchestratorOpenAtom, true); await flush(); await flush(); });
  const panel = container.querySelector<HTMLElement>('[data-slot="orchestrator-panel"]')!;
  const dock = container.querySelector<HTMLElement>('[data-slot="dock"]')!;
  expect(fills(dock)).toEqual(["md:data-[painted]:bg-background"]); // the same level as the page card
  expect(fills(panel)).toEqual(["bg-background"]);
  // The header and the log paint nothing of their own: one surface, split by the header's hairline.
  const header = panel.querySelector<HTMLElement>('[data-slot="orchestrator-handle"]')!;
  expect(fills(header)).toEqual([]);
  expect(header.className).toContain("border-b");
  const log = panel.querySelector<HTMLElement>('[data-slot="chat-log"]')!;
  for (let el: HTMLElement | null = log; el && el !== panel; el = el.parentElement) expect(fills(el)).toEqual([]);
  // The composer stands out from the header and the log: a raised card with a hairline.
  const box = panel.querySelector("textarea")!.closest<HTMLElement>(".rounded-lg.border")!;
  expect(fills(box)).toEqual(["bg-card"]);
});

test("S2: a control's hover is the solid accent, never a translucent step of it", () => {
  const dir = join(import.meta.dir, "../web/src");
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".tsx") && readFileSync(p, "utf8").includes("hover:bg-accent/60")) offenders.push(p);
    }
  };
  walk(dir);
  expect(offenders).toEqual([]);
});

test("S3: controls sit on the raised surface (bg-card); a pressed chip keeps the primary fill", async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<>
      <Button data-test="outline" variant="outline">a</Button>
      <Button data-test="secondary" variant="secondary">b</Button>
      <Input data-test="input" />
      <Textarea data-test="textarea" />
      <Select value="x"><SelectTrigger data-test="select"><SelectValue /></SelectTrigger></Select>
      <Segmented label="Range" value="a" options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} onChange={() => {}} />
      <button data-test="chip-off" className={filterChipClass(false)}>off</button>
      <button data-test="chip-on" className={filterChipClass(true)}>on</button>
    </>);
    await flush();
  });
  const el = (t: string) => container!.querySelector(`[data-test="${t}"]`)!;
  for (const t of ["outline", "secondary", "input", "textarea", "select", "chip-off"]) expect(fills(el(t))).toEqual(["bg-card"]);
  expect(fills(container.querySelector('[role="group"][aria-label="Range"]')!)).toEqual(["bg-card"]);
  expect(fills(el("chip-on"))).toEqual(["bg-primary"]);
});
