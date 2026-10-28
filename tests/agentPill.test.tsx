// The ONE Agent pill (components/AgentPill): the agent's identicon and its name, the same in every
// place an agent shows. Its text is the name alone.
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentPill } from "@/components/AgentPill";

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(async () => { await act(async () => { root?.unmount(); }); container?.remove(); });
const mount = async (node: React.ReactNode) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); });
  return container;
};

test("the pill is the agent's identicon and its name, and its text is the name alone", async () => {
  const c = await mount(<AgentPill name="chief" label="Chief of Staff" />);
  const pill = c.querySelector<HTMLElement>('[data-slot="agent-pill"]')!;
  expect(pill.dataset.agent).toBe("chief");
  expect(pill.textContent).toBe("Chief of Staff");
  const avatar = pill.querySelector('svg[data-slot="agent-avatar"]')!;
  expect(avatar.getAttribute("data-agent")).toBe("chief");
  expect(avatar.getAttribute("width")).toBe("16"); // sm, the default
  expect(pill.className).toContain("rounded-full");
});

test("md is the header's size: a larger avatar; the name truncates in a narrow place", async () => {
  const c = await mount(<AgentPill name="research" label="Research" size="md" />);
  const pill = c.querySelector<HTMLElement>('[data-slot="agent-pill"]')!;
  expect(pill.querySelector("svg")!.getAttribute("width")).toBe("20");
  expect(pill.querySelector("span")!.className).toContain("truncate");
});
