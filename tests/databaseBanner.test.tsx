// The database banner: while the bridge's database is unreachable, every answer carries
// `x-orca-database: unreachable since <iso>`; the page shows ONE bar under the top bar (never a toast
// per failed poll), and it goes away with the first answer that has no header.
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DatabaseBanner } from "@/components/Freshness";
import { _resetRefresh, trackedFetch } from "@/lib/refresh";
import { databaseBannerText, databaseDownSince } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;
let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  globalThis.fetch = realFetch;
  _resetRefresh();
});

test("databaseDownSince reads the header; anything else is 'reachable'", () => {
  expect(databaseDownSince("unreachable since 2026-10-16T14:32:00.000Z")).toBe(Date.parse("2026-10-16T14:32:00.000Z"));
  expect(databaseDownSince(null)).toBeNull();
  expect(databaseDownSince("ok")).toBeNull();
  expect(databaseDownSince("unreachable since nonsense")).toBeNull();
});

test("databaseBannerText names the time, with the day once it is not today", () => {
  const since = new Date(2026, 9, 16, 9, 5).getTime();
  expect(databaseBannerText(since, new Date(2026, 9, 16, 12, 0).getTime())).toBe("Database unreachable since 09:05 · showing cached data · retrying");
  expect(databaseBannerText(since, new Date(2026, 9, 17, 8, 0).getTime())).toMatch(/^Database unreachable since \S+ 16 09:05 · showing cached data · retrying$|^Database unreachable since 16 \S+ 09:05/);
});

test("the banner shows while answers say the database is down, and goes with the first answer that doesn't", async () => {
  const since = new Date(2026, 9, 16, 14, 32);
  let header: string | null = `unreachable since ${since.toISOString()}`;
  globalThis.fetch = (() => Promise.resolve(new Response("{}", { headers: header ? { "x-orca-database": header } : {} }))) as unknown as typeof fetch;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<DatabaseBanner now={since.getTime() + 60_000} />));
  expect(container.querySelector('[data-slot="database-banner"]')).toBeNull();

  // Many failing polls: still one banner.
  await act(async () => { for (let i = 0; i < 5; i++) await trackedFetch("/api/agents"); });
  const banners = container.querySelectorAll('[data-slot="database-banner"]');
  expect(banners).toHaveLength(1);
  expect(banners[0]!.textContent).toBe("Database unreachable since 14:32 · showing cached data · retrying");
  expect(banners[0]!.getAttribute("role")).toBe("status");
  expect(container.querySelector("[title]")).toBeNull(); // no native hover box

  header = null; // the database is back
  await act(async () => { await trackedFetch("/api/agents"); });
  expect(container.querySelector('[data-slot="database-banner"]')).toBeNull();
});
