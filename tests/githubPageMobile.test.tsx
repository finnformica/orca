// The GitHub accounts page on a phone (390×844 / 360 wide): each account was a two-column grid row
// with fixed-width inputs, which overflowed sideways and cut off a long email. AccountRowView
// (Pages.tsx) now stacks below md — login/pill, then the commits line, then the repo list (its own
// wrapping row), then full-width name/email fields and a full-width Save button — and keeps the
// original two-column grid row at md+.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { GitHubSection } from "@/views/Pages";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<GitHubSection />); await flush(); await flush(); });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
});

describe("GitHub accounts page: stacked cards below md, full-width fields and Save, no cut-off text", () => {
  test("each account row is column-stacked by default, a two-column grid at md+", async () => {
    apiFake.githubAccounts = [
      { login: "finnformica", active: true, name: "Finn Formica", email: "finn@example.com", configured: { name: "Finn Formica", email: "finn@example.com" }, repos: ["orca", "branch-demo"] },
      { login: "work-bot", active: false, name: undefined, email: "a-very-long-address-that-would-otherwise-overflow@a-long-example-domain.com", configured: {}, repos: ["chorus-server"] },
    ];
    await mount();

    const rows = [...container!.querySelectorAll('[data-slot="github-account"]')];
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.className).toContain("flex-col"); // stacked by default (below md)
      expect(row.className).toContain("md:grid"); // the original two-column grid, from md+
      expect(row.className).toContain("md:grid-cols-[minmax(12rem,1fr)_auto]");

      const form = row.querySelector("form")!;
      expect(form.className).toContain("flex-col");
      expect(form.className).toContain("md:flex-row");

      for (const input of form.querySelectorAll("input")) {
        expect(input.className).toContain("w-full"); // full width below md
        expect(input.className).toMatch(/(^|\s)h-10(\s|$)/); // >= 40px touch target
        expect(input.className).toContain("md:w-"); // a fixed width again at md+
      }
      const save = form.querySelector('button[type="submit"]')!;
      expect(save.className).toContain("w-full");
      expect(save.className).toMatch(/(^|\s)h-10(\s|$)/);
      expect(save.className).toContain("md:w-auto");
    }

    // The long email never carries an unconditional `truncate` — it wraps below md (nothing is cut
    // off, no native title= hover needed) and only truncates once the grid row returns at md+.
    const longRow = rows.find((r) => r.textContent?.includes("work-bot"))!;
    const spans = [...longRow.querySelectorAll("span")];
    const commitsLine = spans.find((s) => s.textContent?.startsWith("commits as"))!;
    expect(commitsLine.className).not.toMatch(/(^|\s)truncate(\s|$)/);
    expect(commitsLine.className).toContain("break-words");
    expect(commitsLine.className).toContain("md:truncate");
    expect(commitsLine.textContent).toContain("a-very-long-address-that-would-otherwise-overflow@a-long-example-domain.com");

    // The repo list is its own wrapping row below md (folded back into the commits line at md+).
    const repoRow = spans.find((s) => s.textContent === "chorus-server")!;
    expect(repoRow.className).toContain("md:hidden");
  });
});
