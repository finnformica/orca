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
import { NARROW_QUERY } from "@/lib/viewport";
import { createStore, getDefaultStore } from "jotai";
import { usageExpandedAtom } from "@/lib/atoms";
import { openTip } from "./tip";
import * as centre from "@/lib/notificationStore";
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
  act(() => centre.reset()); // the notification store is a module-level singleton that outlives this file's tests
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
  // The collapsed card's shape: a group's three window rows (5-hour, weekly, Fable), not two.
  expect(card().querySelectorAll("[data-slot='usage-skeleton'] [data-slot='row-skeleton']")).toHaveLength(3);
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
  expect(group("login:work")!.querySelector("[data-slot='usage-state']")!.textContent).toBe("Limited");
  expect(group("login:spare")!.querySelector("[data-slot='usage-state']")!.textContent).toBe("Signed-out");
  expect(openTip(group("login:spare")!.querySelector("[data-slot='usage-state']")!).textContent).toContain("Not signed in on this machine");
  expect(rows("login:spare")).toEqual([]);
  expect(group("login:spare")!.className).toContain("opacity-50");
  expect(group("login:old")!.querySelector("[data-slot='usage-state']")!.textContent).toBe("Disabled");
});

test("a login merged across instances shows the freshest ok reading, with a stale OTHER host as a secondary hint whose Refresh targets that host", async () => {
  apiFake.usageData = {
    claude: null, codex: null,
    profiles: [
      {
        name: "finnformica", email: "finnformica@gmail.com", state: "ok", instance: "cloud",
        usage: { fiveHour: { utilization: 18, resetsAt: null }, sevenDay: { utilization: 18, resetsAt: null }, extra: null },
        hosts: [{ instance: "local", state: "token stale — refreshes on next launch" }, { instance: "cloud", state: "ok" }],
      },
    ],
  };
  await mount("/usage");
  const header = () => card().querySelector<HTMLElement>("[data-slot='card-header']")!;
  await act(async () => { header().dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  const row = group("login:finnformica")!;
  expect(row.querySelector("[data-slot='usage-state']")).toBeNull(); // the picked (cloud) reading is ok — no pill
  const hint = row.querySelector("[data-slot='usage-host-hint']")!;
  expect(hint.textContent).toContain("Stale on local");
  const refresh = hint.querySelector("[data-slot='login-refresh']")!;
  await act(async () => { refresh.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(apiFake.refreshProfileCalls).toEqual([{ name: "finnformica", instance: "local" }]); // targets the STALE host, not wherever the browser is
});

test("aggregateProfiles: mean per window over the rotation, soonest reset, null when nothing is in rotation", () => {
  const w = (u: number, r: string | null = null) => ({ utilization: u, resetsAt: r });
  expect(aggregateProfiles([
    { name: "a", state: "ok", usage: { fiveHour: w(10, "2026-09-14T15:00:00Z"), sevenDay: w(20), extra: null, fable: w(30) } },
    { name: "b", state: "exhausted", usage: { fiveHour: w(90, "2026-09-14T13:00:00Z"), sevenDay: w(40), extra: null, fable: null } },
    { name: "c", state: "disabled", usage: { fiveHour: w(0), sevenDay: w(0), extra: null, fable: null } },
  ], Date.parse("2026-09-14T12:00:00Z"))).toEqual({ count: 2, exhausted: 1, fiveHour: w(50, "2026-09-14T13:00:00Z"), sevenDay: w(30), fable: w(30) });
  expect(aggregateProfiles([{ name: "x", state: "not signed in on this machine", usage: null }])).toBeNull();
});

test("warns when hydra is installed but the bridge's `claude` isn't its shim (runs silently unrouted)", async () => {
  const one = { fiveHour: { utilization: 10, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null, fable: null };
  apiFake.usageData = { claude: one, codex: null, profiles: [{ name: "work", state: "ok", usage: one }], routing: { hydra: true, shim: false } };
  await mount();
  const warn = container!.querySelector("[data-slot='routing-warning']");
  expect(warn?.textContent).toContain("routing off");
  expect(card().contains(warn)).toBe(true);
  expect(openTip(warn!.querySelector(".lucide-triangle-alert")!).textContent).toContain("install.sh --shim");
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

test("on a narrow screen the reset timer shows as the bare countdown, not hidden, keeping the row on one line", async () => {
  const realMatchMedia = window.matchMedia;
  window.matchMedia = ((q: string) => ({ matches: q === NARROW_QUERY, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  try {
    const at = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();
    apiFake.usageData = { claude: { fiveHour: { utilization: 38, resetsAt: at(125) }, sevenDay: { utilization: 55, resetsAt: null }, extra: null }, codex: null };
    await mount();
    const reset = group("claude")!.querySelector("[data-slot='usage-reset']")!;
    expect(reset.textContent).toBe("2h 5m"); // no "resets " prefix on a narrow screen
  } finally {
    window.matchMedia = realMatchMedia;
  }
});

test("a hydra login's row shows a switch on hover: flipping it disables/enables the rotation through POST /api/usage/profile", async () => {
  const login = (name: string, state: string) => ({ name, state, usage: { fiveHour: { utilization: 10, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null, fable: null } });
  apiFake.usageData = { claude: null, codex: null, profiles: [login("work", "ok")] };
  await mount("/usage");
  const mouse = (el: Element, type: "mouseover" | "mouseout") => act(async () => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: null })); await flush(); });
  const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  await click(card().querySelector("[data-slot='usage-toggle']")!); // the logins wait behind the chevron
  const header = () => group("login:work")!.querySelector<HTMLElement>("[data-slot='usage-group-header']")!;
  const row = () => group("login:work")!.querySelector<HTMLElement>("[data-slot='login-toggle']");

  // Not in the DOM at all until the row is hovered — no reserved space on a row that isn't (always
  // mounted on a touch screen, covered separately).
  expect(row()).toBeNull();
  await mouse(header(), "mouseover");
  expect(row()).not.toBeNull();
  expect(row()!.getAttribute("aria-checked")).toBe("true");
  expect(openTip(row()!).textContent).toBe("Take work out of hydra's rotation");
  // Sits right next to the login's name, not out among the state pill/subtitle.
  expect(header().querySelector("span.truncate")!.nextElementSibling).toBe(row()!.closest('[data-slot="tip"]'));

  await click(row()!);
  // No instance: the bridge applies it on every host that has the login (one decision per account).
  expect(apiFake.setProfileEnabledCalls).toEqual([{ name: "work", enabled: false, instance: undefined }]);
  expect(row()!.getAttribute("aria-checked")).toBe("false"); // flipped from the refreshed profile list
  expect(group("login:work")!.querySelector("[data-slot='usage-state']")!.textContent).toBe("Disabled");
  expect(group("login:work")!.className).toContain("opacity-50"); // muted, same as any out-of-rotation login
  expect(openTip(row()!).textContent).toBe("Put work back");

  await click(row()!); // and back
  expect(apiFake.setProfileEnabledCalls[1]).toEqual({ name: "work", enabled: true, instance: undefined });
  expect(row()!.getAttribute("aria-checked")).toBe("true");
  expect(group("login:work")!.className).not.toContain("opacity-50");

  await mouse(header(), "mouseout");
  expect(row()).toBeNull(); // leaves the DOM again once the row isn't hovered
});

test("withProfileEnabled: flips the named profile's state, pure and a no-op on an unknown name", async () => {
  const { withProfileEnabled } = await import("../web/src/workstream");
  const profiles: { name: string; state?: string }[] = [{ name: "work", state: "token stale — refreshes on next launch" }, { name: "home", state: "ok" }];
  expect(withProfileEnabled(profiles, "work", false)).toEqual([{ name: "work", state: "disabled" }, { name: "home", state: "ok" }]);
  expect(withProfileEnabled(profiles, "work", true)).toEqual([{ name: "work", state: undefined }, { name: "home", state: "ok" }]);
  expect(withProfileEnabled(profiles, "nope", false)).toEqual(profiles); // not found — untouched
  expect(profiles).toEqual([{ name: "work", state: "token stale — refreshes on next launch" }, { name: "home", state: "ok" }]); // never mutated
});

test("the switch flips optimistically, before POST /api/usage/profile has answered — no spinner, nothing disabled", async () => {
  const login = (name: string, state: string) => ({ name, state, usage: { fiveHour: { utilization: 10, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null, fable: null } });
  apiFake.usageData = { claude: null, codex: null, profiles: [login("work", "ok")] };
  apiFake.holdSetProfileEnabled = true;
  await mount("/usage");
  await act(async () => { card().querySelector("[data-slot='usage-toggle']")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  const header = group("login:work")!.querySelector<HTMLElement>("[data-slot='usage-group-header']")!;
  await act(async () => { header.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })); await flush(); });
  const row = () => group("login:work")!.querySelector<HTMLElement>("[data-slot='login-toggle']")!;
  await act(async () => { row().dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });

  // The request is still held — nothing has come back from the server — yet the switch, the state
  // pill and the row's dim styling already read disabled, and the switch is still clickable (no
  // `disabled` attribute, no spinner in the thumb).
  expect(apiFake.setProfileEnabledReleasers).toHaveLength(1);
  expect(row().hasAttribute("disabled")).toBe(false);
  expect(row().querySelector("svg.animate-spin")).toBeNull();
  expect(row().getAttribute("aria-checked")).toBe("false");
  expect(group("login:work")!.querySelector("[data-slot='usage-state']")!.textContent).toBe("Disabled");
  expect(group("login:work")!.className).toContain("opacity-50");

  await act(async () => { apiFake.setProfileEnabledReleasers[0]!(); await flush(); }); // the server catches up
  expect(row().getAttribute("aria-checked")).toBe("false"); // unchanged — it already agreed
});

test("rapid repeat clicks end in the last chosen state — a slower, now-stale response never clobbers a newer click", async () => {
  const login = (name: string, state: string) => ({ name, state, usage: { fiveHour: { utilization: 10, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null, fable: null } });
  apiFake.usageData = { claude: null, codex: null, profiles: [login("work", "ok")] };
  apiFake.holdSetProfileEnabled = true;
  await mount("/usage");
  await act(async () => { card().querySelector("[data-slot='usage-toggle']")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  const header = group("login:work")!.querySelector<HTMLElement>("[data-slot='usage-group-header']")!;
  await act(async () => { header.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })); await flush(); });
  const row = () => group("login:work")!.querySelector<HTMLElement>("[data-slot='login-toggle']")!;

  await act(async () => { row().dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); }); // disable…
  expect(row().getAttribute("aria-checked")).toBe("false");
  await act(async () => { row().dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); }); // …re-enable, before the first request answered
  expect(row().getAttribute("aria-checked")).toBe("true"); // the last click, shown at once
  expect(apiFake.setProfileEnabledCalls).toEqual([
    { name: "work", enabled: false, instance: undefined },
    { name: "work", enabled: true, instance: undefined },
  ]);
  expect(apiFake.setProfileEnabledReleasers).toHaveLength(2);

  // The SECOND (enable) request's answer lands first, then the first (disable) request's answer
  // — a genuine race — lands last. The stale disable response must not revert the row.
  const [disableReleaser, enableReleaser] = apiFake.setProfileEnabledReleasers;
  await act(async () => { enableReleaser!(); await flush(); });
  expect(row().getAttribute("aria-checked")).toBe("true");
  await act(async () => { disableReleaser!(); await flush(); });
  expect(row().getAttribute("aria-checked")).toBe("true"); // still enabled — the stale response was ignored
  expect(group("login:work")!.className).not.toContain("opacity-50");
});

test("a Stale login's row carries a Refresh button that clears the stale state through POST /api/usage/refresh", async () => {
  const login = (name: string, state: string) => ({ name, state, usage: { fiveHour: { utilization: 10, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null, fable: null } });
  apiFake.usageData = { claude: null, codex: null, profiles: [login("work", "token stale — refreshes on next launch")] };
  await mount("/usage");
  await act(async () => { card().querySelector("[data-slot='usage-toggle']")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(group("login:work")!.querySelector("[data-slot='usage-state']")!.textContent).toBe("Stale");

  const button = () => group("login:work")!.querySelector<HTMLElement>("[data-slot='login-refresh']");
  expect(button()).not.toBeNull(); // shown without hovering — a Stale row needs no discovery step

  await act(async () => { button()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(apiFake.refreshProfileCalls).toEqual([{ name: "work", instance: "laptop" }]);
  expect(group("login:work")!.querySelector("[data-slot='usage-state']")).toBeNull(); // "ok" has no pill
  expect(button()).toBeNull(); // the fix made the row healthy, so its own button is gone too
});

test("a failed refresh is a failed-action notification toast", async () => {
  apiFake.usageData = { claude: null, codex: null, profiles: [{ name: "work", state: "token stale — refreshes on next launch", usage: { fiveHour: { utilization: 10, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null, fable: null } }] };
  apiFake.refreshProfileError = "hydra: refresh failed";
  await mount("/usage");
  await act(async () => { card().querySelector("[data-slot='usage-toggle']")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  const button = group("login:work")!.querySelector<HTMLElement>("[data-slot='login-refresh']")!;
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(group("login:work")!.querySelector("[data-slot='usage-state']")!.textContent).toBe("Stale"); // unchanged — the server refused it
  const toast = container!.querySelector('[data-slot="notification-toast"][data-kind="action_failed"]')!;
  expect(toast.textContent).toContain("Refresh failed");
  expect(toast.textContent).toContain("hydra: refresh failed");
});

test("a refresh that exits clean but leaves the login stale (its own refresh token expired) is treated as a failure, not success", async () => {
  apiFake.usageData = { claude: null, codex: null, profiles: [{ name: "work", state: "token stale — refreshes on next launch", usage: { fiveHour: { utilization: 10, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null, fable: null } }] };
  apiFake.refreshProfileStaysStale = true;
  await mount("/usage");
  await act(async () => { card().querySelector("[data-slot='usage-toggle']")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  const button = group("login:work")!.querySelector<HTMLElement>("[data-slot='login-refresh']")!;
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(apiFake.refreshProfileCalls).toEqual([{ name: "work", instance: "laptop" }]); // the call itself succeeded
  expect(group("login:work")!.querySelector("[data-slot='usage-state']")!.textContent).toBe("Stale"); // still stale, not "fixed"
  const toast = container!.querySelector('[data-slot="notification-toast"][data-kind="action_failed"]')!;
  expect(toast.textContent).toContain("Refresh failed");
  expect(toast.textContent).toContain("Still stale after renewing");
  expect(toast.textContent).toContain('"hydra login work" on laptop'); // the suggested fix names the login and the machine
});

test("a failed toggle is a failed-action notification toast and the switch reverts", async () => {
  apiFake.usageData = { claude: null, codex: null, profiles: [{ name: "work", state: "ok", usage: { fiveHour: { utilization: 10, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null, fable: null } }] };
  apiFake.setProfileEnabledError = "hydra: no such profile";
  await mount("/usage");
  await act(async () => { card().querySelector("[data-slot='usage-toggle']")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  const header = group("login:work")!.querySelector<HTMLElement>("[data-slot='usage-group-header']")!;
  await act(async () => { header.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })); await flush(); });
  const row = group("login:work")!.querySelector<HTMLElement>("[data-slot='login-toggle']")!;
  await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(row.getAttribute("aria-checked")).toBe("true"); // unchanged — the server refused it
  const toast = container!.querySelector('[data-slot="notification-toast"][data-kind="action_failed"]')!;
  expect(toast.textContent).toContain("Disable failed");
  expect(toast.textContent).toContain("hydra: no such profile");
});

test("the fleet's 5-hour countdown shows even when a stale login's window already reset — that window reads empty, as hydra counts it", async () => {
  const at = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();
  apiFake.usageData = {
    claude: null, codex: null,
    profiles: [
      { name: "personal", state: "ok", usage: { fiveHour: { utilization: 38, resetsAt: at(125) }, sevenDay: { utilization: 9, resetsAt: at(5 * 1440) }, extra: null, fable: null } },
      // A stale token: its last reading says 100% with a reset time that has since passed.
      { name: "default", state: "token stale — refreshes on next launch", usage: { fiveHour: { utilization: 100, resetsAt: at(-90) }, sevenDay: { utilization: 39, resetsAt: at(3 * 1440) }, extra: null, fable: null } },
      // No 5-hour usage yet: hydra has no reset for a window that hasn't opened.
      { name: "work", state: "ok", usage: { fiveHour: { utilization: 0, resetsAt: null }, sevenDay: { utilization: 39, resetsAt: at(2 * 1440) }, extra: null, fable: null } },
    ],
  };
  await mount();
  // Mean of 38, 0 (rolled over) and 0 → 13; the soonest reset STILL TO COME is personal's.
  expect(rows("fleet")[0]).toBe("5-hour window resets 2h 5m 13% / 100%");
  expect(rows("fleet")[1]).toContain("resets 2d");
  await act(async () => { card().querySelector("[data-slot='usage-toggle']")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(rows("login:personal")[0]).toBe("5-hour window resets 2h 5m 38% / 100%");
  expect(rows("login:default")[0]).toBe("5-hour window starts on next use 0% / 100%");
  expect(rows("login:work")[0]).toBe("5-hour window starts on next use 0% / 100%");
});

test("a login's status is one word right after its name, the reason in a tooltip, and a long name truncates instead of pushing the row out", async () => {
  const one = { fiveHour: { utilization: 10, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null, fable: null };
  const long = "a-very-long-hydra-login-name-that-would-not-fit";
  apiFake.usageData = { claude: null, codex: null, profiles: [{ name: long, email: "someone@example.com", state: "token stale — refreshes on next launch", usage: one }] };
  getDefaultStore().set(usageExpandedAtom, true);
  await mount();
  const header = group(`login:${long}`)!.querySelector("[data-slot='usage-group-header']")!;
  const [left] = [...header.children];
  const title = left!.querySelector("[data-slot='usage-group-title']")!;
  const pill = left!.querySelector("[data-slot='usage-state']")!;
  expect(pill.textContent).toBe("Stale");
  expect(openTip(pill).textContent).toBe("Access token expired — Orca renews it (Refresh now, or its 30-minute check); the usage shown may be old");
  expect(title.nextElementSibling).toBe(pill.closest('[data-slot="tip"]')); // straight after the name
  expect(title.className).toContain("truncate");
  expect(title.className).toContain("min-w-0");
  expect(header.className).toContain("max-w-full");
  expect(header.lastElementChild!.className).toContain("truncate"); // the email gives way too
});

test("loginStatus: every hydra state is one word, with the full reason kept for the tooltip", async () => {
  const { loginStatus } = await import("../web/src/workstream");
  const states = ["not signed in on this machine", "disabled", "locked", "exhausted", "token stale — refreshes on next launch", "no usage data yet", "token expired", "rate-limited by upstream"];
  const labels = states.map((s) => loginStatus(s).label);
  expect(labels).toEqual(["Signed-out", "Disabled", "Locked", "Limited", "Stale", "New", "Expired", "Rate"]);
  for (const l of labels) expect(l).not.toContain(" ");
  expect(loginStatus("rate-limited by upstream").detail).toBe("Rate-limited by upstream");
});

test("hostHints: every OTHER host's non-ok state is a hint; the picked host's own state (and a single host) never duplicate as one", async () => {
  const { hostHints } = await import("../web/src/workstream");
  expect(hostHints({ instance: "cloud", state: "ok", hosts: [{ instance: "local", state: "token stale — refreshes on next launch" }, { instance: "cloud", state: "ok" }] }))
    .toEqual([{ instance: "local", state: "token stale — refreshes on next launch" }]);
  // No ok reading anywhere — the picked host's own problem is already the group's pill; don't repeat it.
  expect(hostHints({ instance: "cloud", state: "exhausted", hosts: [{ instance: "local", state: "token stale — refreshes on next launch" }, { instance: "cloud", state: "exhausted" }] }))
    .toEqual([{ instance: "local", state: "token stale — refreshes on next launch" }]);
  expect(hostHints({ instance: "local", state: "ok", hosts: [{ instance: "local", state: "ok" }] })).toEqual([]); // one host, nothing secondary to say
  // Disabled on every host is one verdict — the pill says it; no "Disabled on local" beside it.
  expect(hostHints({ instance: "cloud", state: "disabled", hosts: [{ instance: "local", state: "disabled" }, { instance: "cloud", state: "disabled" }] })).toEqual([]);
  expect(hostHints({ hosts: undefined })).toEqual([]);
});

// The header meter's number: EXACTLY UsageCard's headline Claude row (usageGroups' "fleet" group,
// or "claude" with no hydra) — never a separately selected login, so the two can't read differently
// side by side. Pure, so this is checked without mounting anything.
test("headerUsage: a single login (no hydra) is just its own 5-hour window", async () => {
  const { headerUsage } = await import("../web/src/workstream");
  expect(headerUsage(null)).toBeNull();
  expect(headerUsage({ claude: null, codex: null })).toBeNull();
  expect(headerUsage({ claude: { fiveHour: { utilization: 38, resetsAt: null }, sevenDay: { utilization: 55, resetsAt: null }, extra: null }, codex: null }))
    .toEqual({ pct: 38, tooltip: "5-hour window" });
});

test("headerUsage: several logins in rotation — the fleet MEAN, same as the card's headline row, not any one login", async () => {
  const { headerUsage, usageGroups } = await import("../web/src/workstream");
  const profile = (name: string, pct: number, state = "ok") =>
    ({ name, state, usage: { fiveHour: { utilization: pct, resetsAt: null }, sevenDay: { utilization: 0, resetsAt: null }, extra: null } });
  const u = { claude: null, codex: null, profiles: [profile("work", 80), profile("personal", 20), profile("side", 50)] };
  const r = headerUsage(u)!;
  expect(r.pct).toBe(50); // mean of 80/20/50, not the lowest (20) or highest (80) individually
  expect(r.tooltip).toBe("5-hour window · 3 logins in rotation");
  // The exact number usageGroups gives UsageCard's own "fleet" row — reused, not recomputed.
  const fleetRow = usageGroups(u).find((g) => g.key === "fleet")!.rows.find((row) => row.key === "fleet:fiveHour")!;
  expect(r.pct).toBe(fleetRow.pct);
});

test("headerUsage: exhausted/locked logins still count toward the mean — same as the card's headline row", async () => {
  const { headerUsage } = await import("../web/src/workstream");
  const profile = (name: string, pct: number, state: string) =>
    ({ name, state, usage: { fiveHour: { utilization: pct, resetsAt: null }, sevenDay: { utilization: 0, resetsAt: null }, extra: null } });
  const u = { claude: null, codex: null, profiles: [profile("work", 92, "exhausted"), profile("side", 60, "locked")] };
  const r = headerUsage(u)!;
  expect(r.pct).toBe(76); // mean of 92/60 — exhausted/locked logins still hold a real reading
  expect(r.tooltip).toBe("5-hour window · 2 logins in rotation · 2 exhausted");
});

test("headerUsage: disabled / signed-out-here logins never used — null with none left to show", async () => {
  const { headerUsage } = await import("../web/src/workstream");
  const u = { claude: null, codex: null, profiles: [{ name: "work", state: "disabled", usage: null }] };
  expect(headerUsage(u)).toBeNull();
});

// The header meter itself (components/Shell.tsx → views/Vitals.HeaderUsageMeter): a ring + percent
// beside "Ask the orchestrator", opening a HoverCard around the SAME UsageCard the Overview/Usage
// pages render. Mounted on /agents (not / or /usage) so there's exactly one usage-card in the DOM —
// the one the hover card opens — rather than two.
const headerMeter = () => container!.querySelector<HTMLButtonElement>('[data-slot="header-usage"]');
async function focusMeter() {
  await act(async () => { headerMeter()!.focus(); await new Promise((r) => setTimeout(r, 200)); });
}
async function blurMeter() {
  await act(async () => { headerMeter()!.blur(); await new Promise((r) => setTimeout(r, 150)); });
}

test("the header meter is absent with nothing signed in — no empty ring in the header", async () => {
  apiFake.usageData = null;
  await mount("/agents");
  expect(headerMeter()).toBeNull();
});

test("the header meter shows the ring + percent for a single login", async () => {
  apiFake.usageData = { claude: { fiveHour: { utilization: 38, resetsAt: null }, sevenDay: { utilization: 55, resetsAt: null }, extra: null }, codex: null };
  await mount("/agents");
  const meter = headerMeter()!;
  expect(meter).not.toBeNull();
  expect(meter.textContent).toBe("38%");
  expect(meter.querySelector("svg circle")).not.toBeNull(); // the ring
  expect(meter.getAttribute("title")).toBeNull(); // no native hover box — the HoverCard already shows the detail
  expect(meter.getAttribute("aria-label")).toBe("Claude usage — 5-hour window");
  expect(meter.className).toContain("max-md:hidden"); // hidden on phone widths
});

test("the header meter is the fleet mean across several logins, not any one of them", async () => {
  const profile = (name: string, pct: number) =>
    ({ name, state: "ok", usage: { fiveHour: { utilization: pct, resetsAt: null }, sevenDay: { utilization: 0, resetsAt: null }, extra: null } });
  apiFake.usageData = { claude: null, codex: null, profiles: [profile("work", 80), profile("personal", 20)] };
  await mount("/agents");
  const meter = headerMeter()!;
  expect(meter.textContent).toBe("50%"); // mean of 80/20 — not 80, not 20
  expect(meter.getAttribute("aria-label")).toBe("Claude usage — 5-hour window · 2 logins in rotation");
});

// The regression this guards: the header once computed its own per-login pick (33%) while the Usage
// card's headline row, visible right under it on the Overview, read the fleet mean (54%) — two
// different numbers for the same thing, side by side. Mounted on "/" where BOTH render at once.
test("the header meter's percent matches the Usage card's own headline 5-hour row, exactly, when both are visible together", async () => {
  const profile = (name: string, pct: number) =>
    ({ name, state: "ok", usage: { fiveHour: { utilization: pct, resetsAt: null }, sevenDay: { utilization: 0, resetsAt: null }, extra: null } });
  apiFake.usageData = { claude: null, codex: null, profiles: [profile("work", 80), profile("personal", 20), profile("side", 61)] };
  await mount("/");
  const meter = headerMeter()!;
  const headline = rows("fleet")[0]!; // "5-hour window 54% / 100%"
  expect(headline.startsWith("5-hour window")).toBe(true);
  expect(`${meter.textContent} / 100%`).toBe(headline.replace("5-hour window ", ""));
});

test("hovering (or focusing) the header meter opens a HoverCard with the SAME UsageCard the Overview page shows — not a second widget", async () => {
  apiFake.usageData = { claude: { fiveHour: { utilization: 38, resetsAt: null }, sevenDay: { utilization: 55, resetsAt: null }, extra: null }, codex: null };
  await mount("/agents");
  expect(document.querySelector("[data-slot='usage-card']")).toBeNull(); // not open yet
  await focusMeter();
  const panel = document.querySelector<HTMLElement>("[data-slot='usage-card']")!;
  expect(panel).not.toBeNull();
  expect(panel.textContent).toContain("5-hour window");
  expect(panel.textContent).toContain("38%");
  await blurMeter();
});
