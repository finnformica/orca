// E2E for the Usage card (server/usage.shapeUsage → /api/usage → views/Vitals.UsageCard), which
// replaced the header's usage meter: Vercel's usage rows — a ring, a label, value / limit and the
// time to reset — for Claude (the fleet, and each hydra login on expand) and Codex, an empty state
// when nothing is signed in, and the routing warning. Driven against the fake api
// (tests/apiFake.ts), rendered into a real DOM. Plus the pure shapeUsage / mergeUsage checks.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { aggregateProfiles, App, mergeUsage, untilReset } from "@/App";
import { navigate } from "@/lib/route";
import { createStore, getDefaultStore } from "jotai";
import { usageExpandedAtom } from "@/lib/atoms";
import { shapeCodexUsage, shapeUsage } from "../server/usage";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(path = "/") {
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });
}

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
  localStorage.clear();
  getDefaultStore().set(usageExpandedAtom, false); // the atom outlives localStorage within a run
  navigate("/");
  await act(async () => { await store.refresh(); });
});

const card = () => container!.querySelector("[data-slot='usage-card']")!;
const group = (key: string) => card().querySelector(`[data-slot='usage-group'][data-group='${key}']`);
/** Each row as "label value / limit" (plus "resets …" when known), whitespace-collapsed. */
const rows = (key: string) => [...(group(key)?.querySelectorAll("[data-slot='usage-row']") ?? [])]
  .map((r) => [...r.children].map((c) => c.textContent?.trim()).filter(Boolean).join(" ").replace(/\s+/g, " "));

test("the Usage card shows the 5-hour and weekly windows as value / limit rows with a ring", async () => {
  apiFake.usageData = { claude: { fiveHour: { utilization: 38, resetsAt: null }, sevenDay: { utilization: 55, resetsAt: null }, extra: null }, codex: null };
  await mount();
  expect(rows("claude")).toEqual(["5-hour window 38% / 100%", "Weekly 55% / 100%"]);
  expect(group("claude")!.querySelectorAll("svg circle").length).toBeGreaterThanOrEqual(2); // the rings
});

test("shows the time left till each window resets", async () => {
  const in90m = new Date(Date.now() + 90 * 60_000).toISOString();
  apiFake.usageData = { claude: { fiveHour: { utilization: 38, resetsAt: in90m }, sevenDay: { utilization: 55, resetsAt: null }, extra: null }, codex: null };
  await mount();
  expect(rows("claude")[0]).toContain("resets 1h 30m");
});

test("untilReset formats the countdown compactly, null when unknown/past", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  expect(untilReset(null, now)).toBeNull();
  expect(untilReset("2026-07-08T11:00:00Z", now)).toBeNull(); // already past
  expect(untilReset("2026-07-08T12:45:00Z", now)).toBe("45m");
  expect(untilReset("2026-07-08T13:30:00Z", now)).toBe("1h 30m");
  expect(untilReset("2026-07-08T13:15:00Z", now)).toBe("1h 15m");
  expect(untilReset("2026-07-08T14:00:00Z", now)).toBe("2h");
  expect(untilReset("2026-07-10T12:00:00Z", now)).toBe("2d");
  expect(untilReset("2026-07-15T14:00:00Z", now)).toBe("7d 2h");
});

test("says so when no provider usage is available", async () => {
  apiFake.usageData = null;
  await mount();
  expect(card().textContent).toContain("No provider is signed in");
  expect(card().querySelector("[data-slot='usage-row']")).toBeNull();
});

test("shows skeleton rows, sized like the real ones, until the first poll answers — not the 'no provider' empty state", async () => {
  apiFake.holdUsage = true;
  await mount();
  expect(card().querySelector("[data-slot='usage-skeleton']")).not.toBeNull();
  expect(card().querySelector("[data-slot='row-skeleton']")).not.toBeNull();
  expect(card().textContent).not.toContain("No provider is signed in"); // not yet answered — not the same as answered-empty
  expect(card().querySelector("[data-slot='usage-row']")).toBeNull();
  apiFake.usageData = { claude: { fiveHour: { utilization: 38, resetsAt: null }, sevenDay: { utilization: 55, resetsAt: null }, extra: null }, codex: null };
  await act(async () => { apiFake.releaseUsage!(); await flush(); await flush(); });
  expect(card().querySelector("[data-slot='usage-skeleton']")).toBeNull();
  expect(rows("claude")).toEqual(["5-hour window 38% / 100%", "Weekly 55% / 100%"]);
});

test("shows extra-usage spend as money in the plan's currency, used / cap", async () => {
  apiFake.usageData = {
    claude: {
      fiveHour: { utilization: 20, resetsAt: null }, sevenDay: { utilization: 30, resetsAt: null },
      extra: { usedMinor: 8535, limitMinor: 20000, currency: "GBP", exponent: 2, utilization: 43 },
    },
    codex: null,
  };
  await mount();
  expect(rows("claude")).toContain("Extra usage £85.35 / £200.00"); // 8535 minor / 10^2, GBP → pound-formatted
});

test("shapeUsage clamps/rounds utilization, defaults windows to 0%, and extracts extra-usage spend", () => {
  expect(shapeUsage({ five_hour: { utilization: 37.6, resets_at: "2026-07-08T20:00:00Z" }, seven_day: { utilization: 120 } }))
    .toEqual({ fiveHour: { utilization: 38, resetsAt: "2026-07-08T20:00:00Z" }, sevenDay: { utilization: 100, resetsAt: null }, extra: null });
  expect(shapeUsage(null)).toEqual({ fiveHour: { utilization: 0, resetsAt: null }, sevenDay: { utilization: 0, resetsAt: null }, extra: null });

  // enabled extra_usage → surfaced in minor units + currency; disabled → null (widget skips it)
  const withExtra = shapeUsage({ extra_usage: { is_enabled: true, used_credits: 8535, monthly_limit: 20000, currency: "GBP", decimal_places: 2, utilization: 42.7, disabled_reason: null } });
  expect(withExtra.extra).toEqual({ usedMinor: 8535, limitMinor: 20000, currency: "GBP", exponent: 2, utilization: 43 });
  expect(shapeUsage({ extra_usage: { is_enabled: false } }).extra).toBeNull();
});

test("shows Claude then Codex, each window a row, without lifetime tokens", async () => {
  apiFake.usageData = {
    claude: { fiveHour: { utilization: 38, resetsAt: null }, sevenDay: { utilization: 55, resetsAt: null }, extra: null },
    codex: { windows: [{ label: "wk", durationMinutes: 10_080, utilization: 20, resetsAt: null }] },
  };
  await mount();
  expect(rows("codex")).toEqual(["Weekly 20% / 100%"]);
  expect(card().textContent).not.toContain("total");
  expect(group("claude")!.compareDocumentPosition(group("codex")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("mergeUsage keeps a provider's last-good value when a poll returns it null", () => {
  const claude = { fiveHour: { utilization: 40, resetsAt: null }, sevenDay: { utilization: 50, resetsAt: null }, extra: null };
  const codex = { windows: [{ label: "wk", durationMinutes: 10_080, utilization: 20, resetsAt: null }] };
  // Both present, then a poll where Codex transiently failed → Codex is retained, not dropped.
  expect(mergeUsage({ claude, codex }, { claude, codex: null })).toEqual({ claude, codex });
  // Cold start filling in over two polls: Claude first, then Codex, each preserved.
  expect(mergeUsage({ claude, codex: null }, { claude: null, codex })).toEqual({ claude, codex });
  // Nothing seen yet → just the new snapshot.
  expect(mergeUsage(null, { claude, codex: null })).toEqual({ claude, codex: null });
});

test("shapeCodexUsage maps app-server windows and unix reset timestamps", () => {
  expect(shapeCodexUsage({ rateLimits: {
    primary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 76, windowDurationMins: 300, resetsAt: null },
  } })).toEqual({
    windows: [
      { label: "wk", durationMinutes: 10_080, utilization: 20, resetsAt: "2027-01-15T08:00:00.000Z" },
      { label: "5h", durationMinutes: 300, utilization: 76, resetsAt: null },
    ],
  });
  expect(shapeCodexUsage(null)).toBeNull();
});

test("with hydra's logins, the card leads with the fleet (mean per window, Fable included); every login is one click away", async () => {
  apiFake.usageData = {
    claude: { fiveHour: { utilization: 95, resetsAt: null }, sevenDay: { utilization: 60, resetsAt: null }, extra: null },
    codex: null,
    profiles: [
      { name: "personal", state: "ok", usage: { fiveHour: { utilization: 95, resetsAt: null }, sevenDay: { utilization: 60, resetsAt: null }, extra: null, fable: { utilization: 21, resetsAt: null } } },
      { name: "work", state: "ok", usage: { fiveHour: { utilization: 12, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null, fable: null } },
    ],
  };
  await mount();
  // The fleet mean: 5h (95+12)/2 → 54, 1w (60+5)/2 → 33, Fable over the logins that have one → 21.
  expect(group("fleet")!.textContent).toContain("2 logins in rotation");
  expect(rows("fleet")).toEqual(["5-hour window 54% / 100%", "Weekly 33% / 100%", "Fable weekly 21% / 100%"]);
  expect(group("login:personal")).toBeNull(); // collapsed on the Overview
  const more = card().querySelector("[data-slot='usage-toggle']")!;
  expect(more.textContent).toContain("Show 2 logins");
  await act(async () => { more.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(rows("login:personal")).toEqual(["5-hour window 95% / 100%", "Weekly 60% / 100%", "Fable weekly 21% / 100%"]);
  expect(rows("login:work")).toEqual(["5-hour window 12% / 100%", "Weekly 5% / 100%"]); // no Fable window
  expect(group("login:personal")!.querySelector("[data-slot='usage-state']")).toBeNull(); // "ok" needs no tag
});

test("logins that can't be routed to are excluded from the fleet mean but still listed with their reason; exhausted ones count and are flagged", async () => {
  apiFake.usageData = {
    claude: null, codex: null,
    profiles: [
      { name: "work", state: "exhausted", usage: { fiveHour: { utilization: 95, resetsAt: null }, sevenDay: { utilization: 40, resetsAt: null }, extra: null, fable: null } },
      { name: "spare", state: "not signed in on this machine", usage: null },
      { name: "old", state: "disabled", usage: null },
    ],
  };
  await mount("/usage"); // the Usage page lists every login, once its own card is opened
  const header = () => card().querySelector<HTMLElement>("[data-slot='card-header']")!;
  await act(async () => { header().dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(group("fleet")!.textContent).toContain("1 login in rotation · 1 exhausted"); // only `work` is in rotation…
  expect(rows("fleet")[0]).toBe("5-hour window 95% / 100%");                          // …so the mean IS its reading
  expect(group("login:work")!.querySelector("[data-slot='usage-state']")!.textContent).toBe("exhausted");
  expect(group("login:spare")!.textContent).toContain("not signed in on this machine");
  expect(rows("login:spare")).toEqual([]);
  expect(group("login:spare")!.className).toContain("opacity-50");
  expect(group("login:old")!.textContent).toContain("disabled");
});

test("aggregateProfiles: mean per window over the rotation, soonest reset, null when nothing is in rotation", () => {
  const w = (u: number, r: string | null = null) => ({ utilization: u, resetsAt: r });
  expect(aggregateProfiles([
    { name: "a", state: "ok", usage: { fiveHour: w(10, "2026-09-14T15:00:00Z"), sevenDay: w(20), extra: null, fable: w(30) } },
    { name: "b", state: "exhausted", usage: { fiveHour: w(90, "2026-09-14T13:00:00Z"), sevenDay: w(40), extra: null, fable: null } },
    { name: "c", state: "disabled", usage: { fiveHour: w(0), sevenDay: w(0), extra: null, fable: null } },
  ])).toEqual({ count: 2, exhausted: 1, fiveHour: w(50, "2026-09-14T13:00:00Z"), sevenDay: w(30), fable: w(30) });
  expect(aggregateProfiles([{ name: "x", state: "not signed in on this machine", usage: null }])).toBeNull();
});

test("warns when hydra is installed but the bridge's `claude` isn't its shim (runs silently unrouted)", async () => {
  const one = { fiveHour: { utilization: 10, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null, fable: null };
  apiFake.usageData = { claude: one, codex: null, profiles: [{ name: "work", state: "ok", usage: one }], routing: { hydra: true, shim: false } };
  await mount();
  const warn = container!.querySelector("[data-slot='routing-warning']");
  expect(warn?.textContent).toContain("routing off");
  expect(card().contains(warn)).toBe(true);
  expect(warn?.getAttribute("title")).toContain("install.sh --shim");
});

test("no warning when the shim is active, or when hydra isn't installed at all", async () => {
  const one = { fiveHour: { utilization: 10, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null };
  apiFake.usageData = { claude: one, codex: null, profiles: [{ name: "work", state: "ok", usage: one }], routing: { hydra: true, shim: true, bin: "/v/2.1.268" } };
  await mount();
  expect(container!.querySelector("[data-slot='routing-warning']")).toBeNull();
  act(() => root?.unmount()); container?.remove();
  apiFake.usageData = { claude: one, codex: null, routing: { hydra: false, shim: false } }; // no hydra → nothing to warn about
  await mount();
  expect(container!.querySelector("[data-slot='routing-warning']")).toBeNull();
});

test("mergeUsage keeps the last-known routing verdict across a poll that omitted it", () => {
  const claude = { fiveHour: { utilization: 40, resetsAt: null }, sevenDay: { utilization: 50, resetsAt: null }, extra: null };
  const routing = { hydra: true, shim: true };
  expect(mergeUsage({ claude, codex: null, routing }, { claude, codex: null })).toEqual({ claude, codex: null, profiles: undefined, routing });
});

test("the card collapses again: Vercel's chevron and the header row both toggle, and the choice is remembered", async () => {
  const login = (name: string, five: number) => ({ name, state: "ok", usage: { fiveHour: { utilization: five, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null, fable: null } });
  apiFake.usageData = { claude: null, codex: null, profiles: [login("work", 40), login("home", 20)] };
  await mount();
  const toggle = () => card().querySelector<HTMLElement>("[data-slot='usage-toggle']")!;
  const header = () => card().querySelector<HTMLElement>("[data-slot='card-header']")!;
  const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(group("login:work")).toBeNull();
  await click(toggle()); // the chevron at the foot opens it…
  expect(group("login:work")).not.toBeNull();
  expect(toggle().textContent).toContain("Show less");
  expect(header().getAttribute("aria-expanded")).toBe("true");
  expect(localStorage.getItem("orca.ui.v1.usageExpanded")).toBe("true");
  // …and a remount (a reload) keeps it open.
  act(() => root?.unmount()); container?.remove();
  await mount();
  expect(group("login:work")).not.toBeNull();
  await click(toggle()); // the chevron closes it too
  expect(group("login:work")).toBeNull();
  expect(localStorage.getItem("orca.ui.v1.usageExpanded")).toBe("false");
  await click(header()); // and the header row toggles it, as on Vercel
  expect(group("login:home")).not.toBeNull();
  await click(header());
  expect(group("login:home")).toBeNull();
  // The Usage page renders the SAME card: the fleet rows show, the logins wait behind the same
  // chevron, and the one remembered toggle carries over between the pages.
  act(() => root?.unmount()); container?.remove();
  await mount("/usage");
  expect(group("login:work")).toBeNull();
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  await click(toggle());
  expect(group("login:work")).not.toBeNull();
  expect(localStorage.getItem("orca.ui.v1.usageExpanded")).toBe("true");
  act(() => root?.unmount()); container?.remove();
  await mount(); // back on the Overview, still expanded
  expect(group("login:work")).not.toBeNull();
});

test("the Usage page shows the high-level rows at once — with no hydra logins there is nothing to expand", async () => {
  apiFake.usageData = { claude: { fiveHour: { utilization: 38, resetsAt: null }, sevenDay: { utilization: 55, resetsAt: null }, extra: null }, codex: null };
  await mount("/usage");
  expect(rows("claude")).toEqual(["5-hour window 38% / 100%", "Weekly 55% / 100%"]);
  expect(card().querySelector("[data-slot='usage-toggle']")).toBeNull();
  expect(card().querySelector("[data-slot='card-header']")!.getAttribute("aria-expanded")).toBeNull();
});

test("the usage toggle reads back on a reload: default collapsed, bad JSON falls back, a pre-v1 choice carries over", () => {
  // A fresh jotai store is a reload: mounting the atoms reads localStorage.
  const reload = () => { const s = createStore(); s.sub(usageExpandedAtom, () => {}); return s; };
  expect(reload().get(usageExpandedAtom)).toBe(false);
  localStorage.setItem("orca.ui.v1.usageExpanded", "true");
  expect(reload().get(usageExpandedAtom)).toBe(true);
  localStorage.setItem("orca.ui.v1.usageExpanded", "{not json");
  expect(reload().get(usageExpandedAtom)).toBe(false);
  localStorage.setItem("orca.ui.v1.usageExpanded", '"yes"'); // the wrong shape
  expect(reload().get(usageExpandedAtom)).toBe(false);
  localStorage.clear();
  localStorage.setItem("orca.usageExpanded", "true"); // saved before the versioned key existed
  expect(reload().get(usageExpandedAtom)).toBe(true);
});
