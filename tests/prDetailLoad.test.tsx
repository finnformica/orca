// The PR page's load states (views/PrDetail.tsx): a failed fetch says so with a Retry that refetches,
// instead of a dead end — the page used to sit blank-ish on "Loading…" or an error with no way back.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { PrDetail } from "@/views/PrDetail";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  apiFake.reset();
});

test("a failed PR load shows the error and a Retry that loads the page", async () => {
  apiFake.prDetailError = "orca: gh timed out";
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<PrDetail repo="r" number={77} sub="overview" />); await flush(); await flush(); });

  const error = container.querySelector('[data-slot="pr-error"]');
  expect(error?.textContent).toContain("Couldn't load PR #77: orca: gh timed out");
  const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
  expect(retry).toBeDefined();

  apiFake.prDetailError = null; // GitHub recovered
  await act(async () => { retry.click(); await flush(); await flush(); });
  expect(apiFake.calls.filter((c) => c === "prDetail:77")).toHaveLength(2); // Retry refetched
  expect(container.querySelector('[data-slot="pr-error"]')).toBeNull();
  expect(container.textContent).toContain("PR 77");
});
