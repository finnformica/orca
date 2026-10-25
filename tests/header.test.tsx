// E2E for the console shell (App + components/Shell): Vercel's left sidebar — the Orca mark with the
// instance switcher, Find, the nav (Overview, Agents, Repos, Usage, Settings), you at the foot and a
// persisted collapse — and a top bar with the breadcrumb. "/" is the Overview; Agents is the list.
// Driven against the fake api (tests/apiFake.ts), rendered into a real DOM.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import { getDefaultStore } from "jotai";
import * as store from "@/store";
import * as centre from "@/lib/notificationStore";
import { App } from "@/App";
import { agentQueryAtom, instanceScopeAtom, sidebarCollapsedAtom } from "@/lib/atoms";
import { navigate } from "@/lib/route";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Every test file shares one process and one URL: an earlier file can leave a PR page open
// (e.g. /r/prs/7/chat). Start on "/" like afterEach does, so the first test sees the Overview.
beforeAll(async () => { await store.configReady; await act(async () => navigate("/")); });

const flush = () => new Promise((r) => setTimeout(r, 0));

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });
}

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
  centre.reset();
  localStorage.clear();
  // The atoms outlive localStorage within one run: reset what this file changes for later files.
  const s = getDefaultStore();
  s.set(sidebarCollapsedAtom, false);
  s.set(instanceScopeAtom, "all");
  s.set(agentQueryAtom, "");
  await act(async () => navigate("/"));
});

const gridEl = () => container!.querySelector(".xl\\:grid-cols-5");
const btnByText = (label: string) =>
  [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const navLabel = (b: Element) => b.querySelector('[data-slot="nav-label"]')?.textContent?.trim();
const navItem = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>('nav[aria-label="Main"] button')].find((b) => navLabel(b) === label)!;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); }); };
const crumb = () => container!.querySelector('nav[aria-label="Breadcrumb"]')!.textContent;
// Radix opens a dropdown menu on pointerdown, not click — drive it the way a pointer would.
const pointerdown = async (el: Element) => { await act(async () => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await flush(); await flush(); }); };
const key = async (el: Element, k: string) => { await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); await flush(); await flush(); }); };

describe("console shell", () => {
  test("'/' is the Overview: usage, the agents snapshot, instances and recent activity — not the kanban grid", async () => {
    await mount();
    for (const slot of ["usage-card", "agents-card", "recent-activity"]) expect(container!.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    expect(container!.querySelector('[data-slot^="instance-"]')).not.toBeNull();
    expect(gridEl()).toBeNull();
    expect(crumb()).toContain("Overview");
    // The health chip is gone: its numbers live in the instance card now. The header's compact
    // usage meter (views/Vitals.HeaderUsageMeter) is covered end-to-end in usageMeter.test.tsx —
    // here it's simply absent because this test's fake api answers /api/usage with nothing signed in.
    expect(container!.querySelector('[data-slot="header-usage"]')).toBeNull();
    expect(container!.querySelector('[data-slot="instance-health"]')).toBeNull();
  });

  test("the header usage meter sits immediately left of \"Ask the orchestrator\" in the top bar, both right-aligned", async () => {
    apiFake.usageData = { claude: { fiveHour: { utilization: 38, resetsAt: null }, sevenDay: { utilization: 55, resetsAt: null }, extra: null }, codex: null };
    await mount();
    const bar = container!.querySelector<HTMLElement>('[data-slot="topbar"]')!;
    const meter = bar.querySelector('[data-slot="header-usage"]')!;
    const ask = bar.querySelector('[data-slot="ask-orchestrator"]')!;
    expect(meter.nextElementSibling).toBe(ask); // nothing else between them
    const group = ask.parentElement!;
    expect(group.className).toContain("ml-auto"); // the pair, not either one alone, owns the right alignment
    expect(group.parentElement).toBe(bar); // the right-aligned slot is a direct child of the top bar
    expect([...bar.children].at(-1)).toBe(group); // the rightmost thing in the bar
  });

  // The bug this guards: while the app is still loading, HeaderUsageMeter renders nothing (no poll
  // answer yet), and "Ask the orchestrator" used to collapse against the breadcrumbs because it had
  // no stable right-aligning element before it.
  test("\"Ask the orchestrator\" stays right-aligned even while the usage meter has not loaded yet", async () => {
    apiFake.holdUsage = true; // the usage poll never answers — HeaderUsageMeter renders null throughout
    await mount();
    const bar = container!.querySelector<HTMLElement>('[data-slot="topbar"]')!;
    expect(bar.querySelector('[data-slot="header-usage"]')).toBeNull(); // still loading
    const ask = bar.querySelector('[data-slot="ask-orchestrator"]')!;
    const group = ask.parentElement!;
    expect(group.className).toContain("ml-auto");
    expect(group.parentElement).toBe(bar);
    expect([...bar.children].at(-1)).toBe(group); // still the rightmost thing, loaded or not
  });

  // "Ask Orca" fits its content (min-w-fit), not a fixed rem width sized for the retired, longer
  // "Ask the orchestrator" label. A classic scrollbar can still take ~15px off the right when the
  // page grows past the viewport, which does not show in a DOM-only render, so this also pins the
  // scrollbar-gutter rule that holds the rest of the top bar still.
  test("\"Ask the orchestrator\" fits its content, and the scrollbar gutter is reserved", async () => {
    await mount();
    const ask = container!.querySelector<HTMLElement>('[data-slot="ask-orchestrator"]')!;
    expect(ask.className.split(/\s+/)).toContain("min-w-fit"); // sized to its content, not a fixed rem width
    expect(ask.className.split(/\s+/)).not.toContain("w-[12.25rem]");
    const label = ask.querySelector<HTMLElement>('[data-slot="ask-orchestrator-label"]')!;
    expect(label.textContent).toBe("Ask Orca");
    expect(ask.getAttribute("aria-label")).toBe("Ask Orca");
    const css = readFileSync(join(import.meta.dir, "..", "web", "src", "styles.css"), "utf8");
    // A phone reserves it on <html>; a desktop on the page column, which scrolls on its own there.
    expect(css).toMatch(/@media \(max-width: 767px\)\s*\{\s*\/\*[^*]*\*\/\s*html\s*\{\s*scrollbar-gutter:\s*stable;/);
    expect(container!.querySelector('[data-slot="page-scroll"]')!.className.split(/\s+/)).toContain("md:[scrollbar-gutter:stable]");
    // Radix's scroll lock would add the reserved gutter again as a body margin on every menu open.
    expect(css).toMatch(/html body\[data-scroll-locked\]\s*\{\s*margin-right:\s*0 !important;/);
  });

  test("the top bar is opaque: a solid background, no translucency or blur for scrolled content to show through", async () => {
    await mount();
    const bar = container!.querySelector<HTMLElement>('[data-slot="topbar"]')!;
    const cls = bar.className.split(/\s+/);
    expect(cls).toContain("bg-background");
    expect(cls).toContain("sticky");
    expect(cls.filter((c) => /^bg-background\/|^backdrop-blur/.test(c))).toEqual([]);
  });

  test("the sidebar: Orca mark + server button, Find, the pages, and the active one marked", async () => {
    await mount();
    const sidebar = container!.querySelector('[data-slot="sidebar"]')!;
    expect(sidebar.querySelector("svg")).not.toBeNull(); // the orca mark
    expect(sidebar.textContent).toContain("Orca");
    // Top left: the mark with the server's status dot — not a link to Overview, and no subtext under
    // the name. With one server and no /api/servers answer there is nothing to switch to, so it opens
    // no menu (serverSwitch.test.tsx covers the menu), and there is no instance menu here any more.
    const brand = sidebar.querySelector<HTMLElement>('[data-slot="server-brand"]')!;
    expect(brand.tagName).toBe("DIV");
    expect(brand.querySelector('[data-health]')).not.toBeNull();
    expect(brand.querySelector('[data-slot="round-mark"]')).not.toBeNull();
    expect(brand.closest("[aria-haspopup]") === null).toBe(true);
    expect(sidebar.querySelector('[data-slot="server-menu"], [data-slot="instance-switcher"]') === null).toBe(true);
    expect(sidebar.querySelector('input[aria-label="Find agents"]')).not.toBeNull();
    const items = [...sidebar.querySelectorAll('nav[aria-label="Main"] button')].map(navLabel);
    expect(items).toEqual(["Overview", "Agents", "Board", "Inbox", "Memory", "Previews", "Integrations", "Handoffs", "Settings"]);
    expect(navItem("Overview").getAttribute("aria-current")).toBe("page");
    for (const [label, path, slot] of [["Agents", "/agents", "workstream-list"], ["Inbox", "/inbox", "inbox-unread"], ["Integrations", "/integrations", "integrations-page"], ["Settings", "/settings", "settings-appearance"]] as const) {
      await click(navItem(label));
      expect(location.pathname).toBe(path);
      expect(navItem(label).getAttribute("aria-current")).toBe("page");
      expect(crumb()).toContain(label);
      expect(container!.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    }
  });

  test("the instance scope scopes the pages to one machine, and remembers it", async () => {
    await mount();
    getDefaultStore().set(instanceScopeAtom, "cloud");
    await act(flush);
    // The Overview now shows that machine's card only.
    expect(container!.querySelector('[data-slot="instance-cloud"]')).not.toBeNull();
    expect(container!.querySelector('[data-slot="instance-laptop"]')).toBeNull();
    expect(localStorage.getItem("orca.ui.v1.instanceScope")).toBe('"cloud"');
  });

  test("Find: typing filters the Agents list (going there), and 'F' focuses it from anywhere", async () => {
    await mount();
    const find = container!.querySelector<HTMLInputElement>('input[aria-label="Find agents"]')!;
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
      await flush();
    });
    expect(document.activeElement).toBe(find);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(find, "gauge");
      find.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    expect(location.pathname).toBe("/agents");
    expect(container!.querySelector<HTMLInputElement>('input[aria-label="Search workstreams"]')!.value).toBe("gauge"); // one query, shared
  });

  test("the sidebar's foot: Add New is the last action, an outline button; you on ONE thin line below it, no divider; collapsed, the expand button sits above you", async () => {
    await mount();
    const profile = container!.querySelector<HTMLElement>('[data-slot="profile"]')!;
    expect(profile.className).toContain("h-9"); // one line, a nav row's height
    expect(profile.textContent).toBe("You"); // no Tailscale user here: the fallback
    expect(profile.querySelector("svg.lucide-chevrons-up-down")).not.toBeNull(); // it opens a menu, as branch-demo's user row
    // Add New is an outline button, full width on the lower surface, so it stands apart from the
    // content below — the nav rows' height and icon column, so it still lines up with them.
    const addNew = container!.querySelector<HTMLElement>('[data-slot="add-new"]')!;
    const navItem = container!.querySelector<HTMLElement>('nav[aria-label="Main"] button:not([aria-current])')!;
    for (const c of ["h-9", "px-2.5", "gap-3", "rounded-md"]) { expect(addNew.className).toContain(c); expect(navItem.className).toContain(c); }
    expect(addNew.className).toContain("border bg-card"); // the outline variant
    expect(addNew.className).toContain("w-full");
    expect(container!.querySelector<HTMLElement>('[data-slot="notifications-bell"]')!.className).toContain("size-9");
    const actions = container!.querySelector<HTMLElement>('[data-slot="sidebar-actions"]')!;
    const foot = container!.querySelector<HTMLElement>('[data-slot="sidebar-foot"]')!;
    expect(actions.querySelector('[data-slot="add-new"]')).not.toBeNull();
    expect(actions.nextElementSibling).toBe(foot); // straight above you
    expect(foot.className).not.toContain("border-t"); // no divider line above you any more
    expect(foot.querySelector('[data-slot="add-new"]')).toBeNull();
    await click(container!.querySelector('button[aria-label="Collapse sidebar"]')!);
    const you = container!.querySelector<HTMLElement>('[data-slot="sidebar-you"]')!;
    expect(you.className).toContain("md:flex-col-reverse"); // the toggle renders above the avatar
    expect(you.lastElementChild!.querySelector("button")!.getAttribute("aria-label")).toBe("Expand sidebar"); // the toggle, now wrapped in its tooltip
    expect(container!.querySelector('[data-slot="sidebar-actions"] [data-slot="add-new"]')!.getAttribute("aria-label")).toBe("Add New"); // an icon now
  });

  test("the sidebar collapses to icons and stays collapsed across a reload", async () => {
    await mount();
    await click(container!.querySelector('button[aria-label="Collapse sidebar"]')!);
    expect(container!.querySelector('[data-slot="sidebar"]')!.getAttribute("data-collapsed")).toBe("true");
    expect(localStorage.getItem("orca.ui.v1.sidebarCollapsed")).toBe("true");
    act(() => root?.unmount());
    container?.remove();
    await mount();
    expect(container!.querySelector('button[aria-label="Expand sidebar"]')).not.toBeNull();
  });

  test("collapsed, the logo centres on the same axis as a nav icon; expanded, neither carries that class", async () => {
    await mount();
    const navButton = () => container!.querySelector<HTMLElement>('nav[aria-label="Main"] button')!;
    const logoButton = () => container!.querySelector<HTMLElement>('[data-slot="round-mark"]')!.closest<HTMLElement>('[data-slot="server-brand"]')!;
    expect(navButton().className).not.toContain("justify-center"); // expanded: neither centres
    expect(logoButton().className).not.toContain("justify-center");
    await click(container!.querySelector('button[aria-label="Collapse sidebar"]')!);
    // Same centring class on both, so they sit on the same horizontal axis in the icon rail.
    expect(navButton().className).toContain("md:justify-center");
    expect(logoButton().className).toContain("md:justify-center");
  });

  test("Inbox nav badge and bell badge share one CountBadge: same classes, collapsed or not", async () => {
    centre.reset();
    apiFake.notificationsData = [{ id: 1, instance: "local", repo: "r", branch: "b", kind: "finished", title: "x", body: "y", createdAt: Date.now() }];
    await mount();
    await act(async () => { await flush(); await flush(); });
    const bellBadge = () => container!.querySelector('[data-slot="notifications-unread"]')!;
    const inboxBadge = () => container!.querySelector('[data-slot="inbox-unread-count"]')!;
    // Collapsed to the icon rail: the Inbox nav badge pins to the icon's corner, exactly as the bell's does.
    await click(container!.querySelector('button[aria-label="Collapse sidebar"]')!);
    expect(inboxBadge().className).toBe(bellBadge().className);
    expect(inboxBadge().textContent).toBe("1");
    expect(bellBadge().textContent).toBe("1");
    // Expanded: the row's own badge sits inline, but still the same colour, size, radius, font and padding.
    await click(container!.querySelector('button[aria-label="Expand sidebar"]')!);
    for (const c of ["bg-foreground", "text-background", "h-4", "min-w-4", "rounded-full", "text-[10px]", "font-semibold"]) {
      expect(inboxBadge().className.split(" ")).toContain(c);
      expect(bellBadge().className.split(" ")).toContain(c);
    }
  });

  test("Handoffs nav badge: outgoing packs not sent yet only; a received pack never counts", async () => {
    apiFake.handoffBadgeData = { unsent: 1 };
    apiFake.handoffPacks = [
      { id: "o1", direction: "out", title: "Pending", message: "", target: "box-b", source: "here", files: [], createdAt: 1, preview: [], problems: [], wouldSay: "" },
      { id: "i1", direction: "in", title: "From B", message: "", target: "here", source: "box-b", files: [], createdAt: 2, sentAt: 2, preview: [], problems: [], wouldSay: "" },
    ];
    await mount();
    const badge = () => container!.querySelector('[data-slot="handoffs-count"]');
    // The one CountBadge, inline on the Handoffs row, named for a screen reader.
    expect(navItem("Handoffs").contains(badge())).toBe(true);
    expect(badge()!.textContent).toBe("1");
    expect(badge()!.getAttribute("aria-label")).toBe("1 packs waiting to send");
    // Collapsed to the icon rail: pinned to the icon's corner, like the Inbox badge.
    await click(container!.querySelector('button[aria-label="Collapse sidebar"]')!);
    expect(badge()!.className).toContain("absolute");
    await click(container!.querySelector('button[aria-label="Expand sidebar"]')!);
    // The phone reaches Handoffs from Settings → Navigate: the same count there.
    await act(async () => { navigate("/settings"); await flush(); });
    expect(container!.querySelector('[data-slot="settings-mobile-nav"] [data-slot="handoffs-count"]')!.textContent).toBe("1");
    // Open the page: the received pack still shows as new (its own tag, unrelated to the badge),
    // and the badge count is untouched by that visit.
    await act(async () => { navigate("/handoffs"); await flush(); await flush(); });
    expect(apiFake.handoffSeenCalls).toBe(1);
    expect(container!.querySelector('[data-slot="handoffs-received"] [data-slot="handoff-new"]')).not.toBeNull();
    expect(navItem("Handoffs").querySelector('[data-slot="handoffs-count"]')!.textContent).toBe("1");
    // Sent (the count reaches zero): no badge, and the keycap keeps its place at the row's edge.
    apiFake.handoffBadgeData = { unsent: 0 };
    await act(async () => { navigate("/"); await flush(); });
    await act(async () => { navigate("/handoffs"); await flush(); await flush(); });
    expect(badge()).toBeNull();
  });

  test("Agents: the list only — no List | Board toggle", async () => {
    navigate("/agents");
    await mount();
    expect(container!.querySelector('[data-slot="workstream-list"]')).not.toBeNull();
    expect(container!.querySelector('[role="group"][aria-label="View"]')).toBeNull();
    // The Board is its own page now (the sidebar's Board entry), never a toggle on this one.
    expect(btnByText("Board")).toBeUndefined();
    expect(navItem("Board").closest('nav[aria-label="Main"]') !== null).toBe(true);
    expect(gridEl()).toBeNull();
    expect(container!.querySelector('button[aria-label^="Switch to"]')).toBeNull();
  });
});
