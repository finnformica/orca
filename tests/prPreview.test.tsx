// The GitHub PR-preview control (the deploy-preview URL the pr-preview action posts once a PR
// carries the repo's preview label) — distinct from the LOCAL preview cell (PreviewCell,
// previewCell.test.tsx): a link once the PR's `previewUrl` lands, an "Add PR preview" button before
// the label is on, a "Deploying preview" pending state once the label is on but no URL has posted
// yet (persists across reloads — it's read straight off the PR, not local-only state), hidden
// entirely without a PR or without the repo opting into a preview label / RepoFeatures.previews.
// Four surfaces share the same pure state machine (workstream.prPreviewState): the Agents-list /
// phone cell (PrPreviewCell), the agent page's header button (PrPreviewButton), the PR submenu
// item in WorkstreamActions, and the inline text link next to the model name in the Agents-list
// row's subline (PrPreviewInline) — all exercised here.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { PrPreviewCell, PrPreviewButton, PrPreviewInline } from "@/views/PreviewControl";
import { WorkstreamActions } from "@/views/WorkstreamActions";
import { prPreviewState } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); await flush(); });
}
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
afterEach(async () => { await act(async () => { root?.unmount(); }); container?.remove(); apiFake.reset(); });

describe("prPreviewState (pure)", () => {
  test("hidden without a PR, even on a configured repo", () => {
    expect(prPreviewState({}, true)).toBe("hidden");
  });
  test("hidden with a PR on an unconfigured repo, even with the label or a just-added flag", () => {
    expect(prPreviewState({ prNumber: 1 }, false)).toBe("hidden");
    expect(prPreviewState({ prNumber: 1, hasPreviewLabel: true }, false)).toBe("hidden");
    expect(prPreviewState({ prNumber: 1 }, false, true)).toBe("hidden");
  });
  test("ready on an unconfigured repo once a deploy bot posted a previewUrl", () => {
    expect(prPreviewState({ prNumber: 1, previewUrl: "https://feat.acme.pages.dev" }, false)).toBe("ready");
  });
  test("hidden without a PR, even with a previewUrl", () => {
    expect(prPreviewState({ previewUrl: "https://x" }, false)).toBe("hidden");
  });
  test("ready once previewUrl has posted, regardless of the label flag", () => {
    expect(prPreviewState({ prNumber: 1, previewUrl: "https://x", hasPreviewLabel: true }, true)).toBe("ready");
    expect(prPreviewState({ prNumber: 1, previewUrl: "https://x" }, true)).toBe("ready");
  });
  test("pending once the label is on but no URL yet — from the server flag or the optimistic one", () => {
    expect(prPreviewState({ prNumber: 1, hasPreviewLabel: true }, true)).toBe("pending");
    expect(prPreviewState({ prNumber: 1 }, true, /* justAdded */ true)).toBe("pending");
  });
  test("add: a PR on a configured repo with neither the label nor a URL yet", () => {
    expect(prPreviewState({ prNumber: 1 }, true)).toBe("add");
  });
});

// repo "r" (the fake config's only repo) carries RepoFeatures.previews: true, so it's "configured";
// a row on a repo the config knows nothing about ("nopreview") reads as unconfigured.
const noPr: store.Row = { repo: "r", hasRemote: true, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL" };
const addRow: store.Row = { ...noPr, branch: "feat-pr", lane: "IN_REVIEW", prNumber: 6, prUrl: "https://github.com/acme/app/pull/6" };
const unconfiguredRow: store.Row = { ...addRow, repo: "nopreview" };

const cellOf = () => container!.querySelector<HTMLElement>('[data-slot="pr-preview-cell"]');

describe("PrPreviewCell (Agents list / phone row)", () => {
  test("hidden: no PR on the row", async () => {
    await mount(<PrPreviewCell row={noPr} />);
    expect(cellOf()).toBeNull();
  });

  test("hidden: a PR exists but the repo has no preview label / previews feature configured", async () => {
    await mount(<PrPreviewCell row={unconfiguredRow} />);
    expect(cellOf()).toBeNull();
  });

  test("ready on an unconfigured repo: a deploy bot's previewUrl is enough for the link", async () => {
    await mount(<PrPreviewCell row={{ ...unconfiguredRow, previewUrl: "https://feat-ruminate.acme.workers.dev" }} />);
    const c = cellOf()!;
    expect(c.dataset.state).toBe("ready");
    expect(c.querySelector("a")!.getAttribute("href")).toBe("https://feat-ruminate.acme.workers.dev");
  });

  test("add: an enabled 'Add PR preview' button before the label is on", async () => {
    await mount(<PrPreviewCell row={addRow} />);
    const c = cellOf()!;
    expect(c.dataset.state).toBe("add");
    const btn = c.querySelector("button")!;
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("aria-label")).toBe("Add PR preview");
    expect(btn.querySelector(".lucide-globe")).not.toBeNull();
  });

  test("pending: clicking Add posts the repo's preview label and flips to a disabled spinner at once", async () => {
    await mount(<PrPreviewCell row={addRow} />);
    await click(cellOf()!.querySelector("button")!);
    expect(apiFake.calls).toContain("addPreviewLabel:6");
    const c = cellOf()!;
    expect(c.dataset.state).toBe("pending");
    const btn = c.querySelector("button")!;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-label")).toBe("Deploying preview");
    expect(btn.querySelector(".lucide-loader-circle, svg.animate-spin")).not.toBeNull();
  });

  test("pending survives a reload: the server's hasPreviewLabel alone renders pending, no click needed", async () => {
    await mount(<PrPreviewCell row={{ ...addRow, hasPreviewLabel: true }} />);
    expect(cellOf()!.dataset.state).toBe("pending");
  });

  test("ready: a link to the PR preview URL once it has posted", async () => {
    await mount(<PrPreviewCell row={{ ...addRow, previewUrl: "https://feat-6.preview.branch-demo.dev" }} />);
    const c = cellOf()!;
    expect(c.dataset.state).toBe("ready");
    const link = c.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://feat-6.preview.branch-demo.dev");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("aria-label")).toBe("PR preview");
  });
});

describe("PrPreviewButton (agent page header)", () => {
  test("hidden without a PR", async () => {
    await mount(<PrPreviewButton row={noPr} />);
    expect(container!.querySelector("button, a")).toBeNull();
  });

  test("hidden: repo not configured for a preview label / previews feature", async () => {
    await mount(<PrPreviewButton row={unconfiguredRow} />);
    expect(container!.querySelector("button, a")).toBeNull();
  });

  test("Add PR preview → Deploying preview after a click", async () => {
    await mount(<PrPreviewButton row={addRow} />);
    const btn = container!.querySelector("button")!;
    expect(btn.textContent).toContain("Add PR preview");
    expect(btn.disabled).toBe(false);
    await click(btn);
    expect(apiFake.calls).toContain("addPreviewLabel:6");
    const after = container!.querySelector("button")!;
    expect(after.textContent).toContain("Deploying preview");
    expect(after.disabled).toBe(true);
  });

  test("Open PR preview once previewUrl is set", async () => {
    await mount(<PrPreviewButton row={{ ...addRow, previewUrl: "https://feat-6.preview.branch-demo.dev" }} />);
    const link = container!.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://feat-6.preview.branch-demo.dev");
    expect(link.textContent).toContain("Open PR preview");
  });
});

describe("PrPreviewInline (next to the model name in the Agents-list subline)", () => {
  test("hidden without a PR: no leading separator, nothing rendered", async () => {
    await mount(<PrPreviewInline row={noPr} />);
    expect(container!.querySelector('[data-slot="pr-preview-inline"]')).toBeNull();
    expect(container!.textContent).toBe("");
  });

  test("hidden: repo not configured for a preview label / previews feature", async () => {
    await mount(<PrPreviewInline row={unconfiguredRow} />);
    expect(container!.querySelector('[data-slot="pr-preview-inline"]')).toBeNull();
  });

  test("ready on an unconfigured repo: 'Preview' as the link text, the URL as its tooltip, no Add", async () => {
    await mount(<PrPreviewInline row={{ ...unconfiguredRow, previewUrl: "https://feat-ruminate.acme.workers.dev" }} />);
    const el = container!.querySelector<HTMLElement>('[data-slot="pr-preview-inline"]')!;
    expect(el.dataset.state).toBe("ready");
    expect(el.tagName).toBe("A");
    expect(el.textContent).toBe("Preview");
    expect(el.getAttribute("href")).toBe("https://feat-ruminate.acme.workers.dev");
    expect(el.closest('[data-slot="tip"]')).not.toBeNull(); // the full URL is its hover tooltip (Tip)
  });

  test("add: a '+ Add preview' text link before the label is on", async () => {
    await mount(<PrPreviewInline row={addRow} />);
    const el = container!.querySelector<HTMLElement>('[data-slot="pr-preview-inline"]')!;
    expect(el.dataset.state).toBe("add");
    expect(el.tagName).toBe("BUTTON");
    expect(el.textContent).toContain("Add preview");
    expect(el.querySelector(".lucide-plus")).not.toBeNull();
  });

  test("clicking Add posts the repo's preview label and flips to pending", async () => {
    await mount(<PrPreviewInline row={addRow} />);
    await click(container!.querySelector('[data-slot="pr-preview-inline"]')!);
    expect(apiFake.calls).toContain("addPreviewLabel:6");
    const el = container!.querySelector<HTMLElement>('[data-slot="pr-preview-inline"]')!;
    expect(el.dataset.state).toBe("pending");
    expect(el.textContent).toContain("Deploying preview");
  });

  test("ready: 'Preview' as the link text followed by an external-link icon, the full URL in href and its tooltip", async () => {
    await mount(<PrPreviewInline row={{ ...addRow, previewUrl: "https://feat-6.preview.branch-demo.dev" }} />);
    const el = container!.querySelector<HTMLElement>('[data-slot="pr-preview-inline"]')!;
    expect(el.dataset.state).toBe("ready");
    expect(el.tagName).toBe("A");
    expect(el.getAttribute("href")).toBe("https://feat-6.preview.branch-demo.dev");
    expect(el.getAttribute("target")).toBe("_blank");
    expect(el.textContent).toBe("Preview");
    expect(el.closest('[data-slot="tip"]')).not.toBeNull(); // the full URL is its hover tooltip (Tip)
    const icon = el.querySelector(".lucide-external-link")!;
    expect(icon).not.toBeNull();
    expect(el.lastElementChild).toBe(icon); // the icon is the LAST child — after the text label
    expect(el.className).toContain("underline"); // always underlined, not just on hover
  });
});

// Radix opens menus/submenus on pointerdown, not click — drive it the way a pointer would (see
// copyWorktreeAction.test.tsx).
const pointerdown = async (el: Element) => { await act(async () => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await flush(); await flush(); }); };
const menuitem = (text: string) => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === text);
async function openPrSubmenu() {
  await pointerdown([...container!.querySelectorAll("button")].find((b) => b.textContent?.includes("Actions"))!);
  const prTrigger = menuitem("PR")!;
  await pointerdown(prTrigger);
  await click(prTrigger);
}

describe("WorkstreamActions → PR submenu", () => {
  test("Add preview runs addPreviewLabel", async () => {
    await mount(<WorkstreamActions row={addRow} />);
    await openPrSubmenu();
    expect(menuitem("Add preview")).not.toBeUndefined();
    await click(menuitem("Add preview")!);
    expect(apiFake.calls).toContain("addPreviewLabel:6");
  });

  test("Deploying preview… is a disabled placeholder once the label is on but no URL has posted", async () => {
    await mount(<WorkstreamActions row={{ ...addRow, hasPreviewLabel: true }} />);
    await openPrSubmenu();
    const item = menuitem("Deploying preview…")!;
    expect(item).not.toBeUndefined();
    await click(item);
    expect(apiFake.calls.filter((c) => c.startsWith("addPreviewLabel"))).toEqual([]); // disabled — no call fires
  });

  test("once previewUrl is set: no Add preview; Open ▸ PR preview opens it", async () => {
    const opened: string[] = [];
    const prevOpen = window.open;
    window.open = ((u: string) => { opened.push(u); return null; }) as typeof window.open;
    try {
      await mount(<WorkstreamActions row={{ ...addRow, previewUrl: "https://x.preview.test" }} />);
      await openPrSubmenu();
      expect(menuitem("Add preview")).toBeUndefined();
      const openTrigger = menuitem("Open")!;
      await pointerdown(openTrigger);
      await click(openTrigger);
      await click(menuitem("PR preview")!);
      expect(opened).toEqual(["https://x.preview.test"]);
    } finally { window.open = prevOpen; }
  });

  test("hidden entirely on a repo with no preview label / previews feature configured", async () => {
    await mount(<WorkstreamActions row={unconfiguredRow} />);
    await openPrSubmenu();
    expect(menuitem("Add preview")).toBeUndefined();
    expect(menuitem("PR preview")).toBeUndefined();
    expect(menuitem("Deploying preview…")).toBeUndefined();
  });
});
