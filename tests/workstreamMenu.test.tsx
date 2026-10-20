// The workstream actions menu (WorkstreamActions: the ⋯, the right-click menu and the phone sheet),
// Finn's layout: Open ▸, Copy ▸, Merge ▸, PR ▸, Agent ▸, Slack ▸, then Verified, Rename… and Close PR /
// Discard. The pure rules (workstream.workstreamMenu) decide which items each submenu shows; the DOM
// tests drive the real menu against the preloaded fake api (tests/apiFake.ts).
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import * as centre from "@/lib/notificationStore";
import { orchestratorOpenAtom, orchestratorPrefillAtom } from "@/lib/atoms";
import { WorkstreamActions } from "@/views/WorkstreamActions";
import { failingCiUrl, orchestratorAbout, prMarkdownLink, workstreamMenu, type MenuRow } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pr: MenuRow = {
  repo: "r", branch: "feat", lane: "IN_REVIEW", hasRemote: true, worktreePath: "/wt/feat",
  prNumber: 7, prUrl: "https://github.com/acme/app/pull/7", mergeable: "MERGEABLE", ciStatus: "passing",
};
const local: MenuRow = { repo: "r", branch: "feat", lane: "LOCAL", hasRemote: true, worktreePath: "/wt/feat" };
const ctx = { previewConfigured: true, moveTargets: 1 };

describe("workstreamMenu: the items of each submenu, and the hide rules", () => {
  test("an open, clean PR", () => {
    expect(workstreamMenu(pr, ctx)).toEqual({
      open: ["open.chat", "open.pr", "open.orchestrator"],
      copy: ["copy.branch", "copy.prLink", "copy.prMarkdown", "copy.slack", "copy.worktree", "copy.cli"],
      merge: ["merge.now"],
      pr: ["pr.moveToDraft", "pr.address", "pr.addPreview", "pr.autoMerge"],
      agent: ["agent.move"],
      slack: ["slack.send", "slack.bump"],
    });
  });

  test("a local branch: no PR items, PR ▸ is Create PR / Create draft PR; no Slack", () => {
    const m = workstreamMenu(local, ctx);
    expect(m.open).toEqual(["open.chat", "open.orchestrator"]);
    expect(m.copy).toEqual(["copy.branch", "copy.worktree", "copy.cli"]);
    expect(m.merge).toEqual([]);
    expect(m.pr).toEqual(["pr.create", "pr.createDraft"]);
    expect(m.slack).toEqual([]);
    // A local repo (no remote) promotes in place.
    expect(workstreamMenu({ ...local, hasRemote: false }, ctx).pr).toEqual(["pr.promote"]);
    // Promoted and clean: Merge now merges it locally.
    expect(workstreamMenu({ ...local, lane: "MERGEABLE" }, ctx).merge).toEqual(["merge.now"]);
  });

  test("preview items only with a preview", () => {
    const withPreview = workstreamMenu({ ...pr, previewUrl: "https://p.test" }, ctx);
    expect(withPreview.open).toContain("open.preview");
    expect(withPreview.copy).toContain("copy.preview");
    expect(withPreview.pr).not.toContain("pr.addPreview");
    expect(workstreamMenu({ ...pr, hasPreviewLabel: true }, ctx).pr).toContain("pr.previewPending");
    const none = workstreamMenu(pr, { ...ctx, previewConfigured: false });
    expect(none.pr).toEqual(["pr.moveToDraft", "pr.address", "pr.autoMerge"]);
    expect(none.open).not.toContain("open.preview");
    expect(none.copy).not.toContain("copy.preview");
  });

  test("Failing CI run only while CI fails; Merge now not then, auto-merge still offered", () => {
    const red = workstreamMenu({ ...pr, ciStatus: "failing" }, ctx);
    expect(red.open).toEqual(["open.chat", "open.pr", "open.ci", "open.orchestrator"]);
    expect(red.merge).toEqual([]);
    expect(red.pr).toContain("pr.autoMerge");
  });

  test("a draft PR: Mark ready, and no Merge or auto-merge items", () => {
    const m = workstreamMenu({ ...pr, isDraft: true }, ctx);
    expect(m.pr[0]).toBe("pr.markReady");
    expect(m.merge).toEqual([]);
    expect(m.pr).not.toContain("pr.autoMerge"); // GitHub rejects auto-merge on a draft
    expect(m).not.toHaveProperty("autoMerge"); // no top-level group any more
  });

  test("Agent ▸: Stop agent only while it runs; Resolve conflicts only for a local branch; Move only with a worktree and another instance", () => {
    expect(workstreamMenu({ ...pr, agentStatus: "running" }, ctx).agent).toEqual(["agent.stop", "agent.move"]);
    expect(workstreamMenu({ ...local, mergeClean: "conflict" }, ctx).agent).toEqual(["agent.resolveConflicts", "agent.move"]);
    expect(workstreamMenu({ ...pr, mergeable: "CONFLICTING" }, ctx).agent).toEqual(["agent.move"]); // a PR: Address PR does it
    expect(workstreamMenu({ ...pr, worktreePath: undefined }, ctx).agent).toEqual([]);
    expect(workstreamMenu(pr, { ...ctx, moveTargets: 0 }).agent).toEqual([]);
    expect(workstreamMenu({ ...pr, remote: true }, ctx).copy).not.toContain("copy.cli");
  });

  test("the text helpers", () => {
    expect(prMarkdownLink({ title: "Fix [x]", prUrl: "https://g/7" })).toBe("[Fix \\[x\\]](https://g/7)");
    expect(failingCiUrl({ prUrl: "https://g/7", ciStatus: "failing" })).toBe("https://g/7/checks");
    expect(failingCiUrl({ prUrl: "https://g/7", ciStatus: "passing" })).toBeUndefined();
    expect(orchestratorAbout({ repo: "r", branch: "feat", title: "Feat", prNumber: 7 })).toBe('About r#7 "Feat": ');
    expect(orchestratorAbout({ repo: "r", branch: "feat", title: "Feat" })).toBe('About r branch feat "Feat": ');
  });
});

// ---- the real menu ----

beforeAll(() => store.configReady);
const flush = () => new Promise((r) => setTimeout(r, 0));
const pointerdown = async (el: Element) => { await act(async () => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await flush(); await flush(); }); };
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')];
const menuitem = (text: string) => items().find((i) => i.textContent?.trim() === text);
const labels = () => items().map((i) => i.textContent?.trim());

let copied: string[] = [];
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  value: { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } },
});

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(row: store.Row) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<WorkstreamActions row={row} />); await flush(); });
  await pointerdown([...container!.querySelectorAll("button")].find((b) => b.textContent?.includes("Actions"))!);
}
// Close whatever menu is open (Esc), then open the ⋯ again: a pointerdown on an open trigger closes it.
async function reopen() {
  const open = document.body.querySelector('[role="menu"]');
  if (open) await act(async () => { open.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await flush(); await flush(); });
  await pointerdown([...container!.querySelectorAll("button")].find((b) => b.textContent?.includes("Actions"))!);
}
async function openSub(label: string) {
  const t = menuitem(label)!;
  expect(t).not.toBeUndefined();
  await pointerdown(t);
  await click(t);
}

afterEach(async () => {
  apiFake.reset();
  act(() => centre.reset());
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  copied = [];
});

const prRow: store.Row = {
  repo: "r", hasRemote: true, branch: "feat", title: "Feat", prompt: "", lane: "IN_REVIEW", worktreePath: "/wt/feat",
  prNumber: 7, prUrl: "https://github.com/acme/app/pull/7", mergeable: "MERGEABLE", ciStatus: "passing",
};

describe("WorkstreamActions: the redesigned menu", () => {
  test("top level in Finn's order; Follow up…, Follow PR and Hand off… are gone", async () => {
    await mount(prRow);
    expect(labels()).toEqual(["Open", "Copy", "Merge", "PR", "Agent", "Slack", "Mark verified", "Rename…", "Close PR"]);
    for (const gone of ["Follow up…", "Follow PR (auto-fix)", "Hand off…", "Merge when green"]) expect(labels()).not.toContain(gone);
    expect(menuitem("Close PR")!.className).toContain("text-destructive");
  });

  test("a local branch: no Merge, auto-merge or Slack; PR ▸ Create PR / Create draft PR; Discard last", async () => {
    await mount({ ...prRow, lane: "LOCAL", prNumber: undefined, prUrl: undefined, mergeable: undefined, ciStatus: undefined });
    expect(labels()).toEqual(["Open", "Copy", "PR", "Agent", "Rename…", "Discard"]); // Verified needs a PR
    await openSub("PR");
    expect(menuitem("Create PR")).not.toBeUndefined();
    expect(menuitem("Create draft PR")).not.toBeUndefined();
  });

  test("Open ▸ Orchestrator opens it with the card's name and PR in the composer, and sends nothing", async () => {
    const s = getDefaultStore();
    s.set(orchestratorOpenAtom, false);
    await mount(prRow);
    await openSub("Open");
    expect(labels()).toEqual(expect.arrayContaining(["Agent chat", "PR on GitHub", "Orchestrator"]));
    expect(labels()).not.toContain("Failing CI run"); // CI passes
    await click(menuitem("Orchestrator")!);
    expect(s.get(orchestratorOpenAtom)).toBe(true);
    expect(s.get(orchestratorPrefillAtom)?.text).toBe('About r#7 "Feat": ');
    expect(apiFake.orchestratorMessages).toEqual([]); // not sent
    s.set(orchestratorOpenAtom, false);
  });

  test("Open ▸ Agent chat goes to the chat tab; Failing CI run opens the PR's checks", async () => {
    const opened: string[] = [];
    const prevOpen = window.open;
    window.open = ((u: string) => { opened.push(u); return null; }) as typeof window.open;
    try {
      await mount({ ...prRow, ciStatus: "failing" });
      await openSub("Open");
      await click(menuitem("Failing CI run")!);
      expect(opened).toEqual(["https://github.com/acme/app/pull/7/checks"]);
      await reopen();
      await openSub("Open");
      await click(menuitem("Agent chat")!);
      expect(location.pathname).toBe("/r/prs/7/chat");
    } finally { window.open = prevOpen; }
  });

  test("Copy ▸ every item copies its text", async () => {
    const row = { ...prRow, previewUrl: "https://feat.preview.test" };
    const expected: Array<[string, string]> = [
      ["Branch name", "feat"],
      ["PR link", "https://github.com/acme/app/pull/7"],
      ["PR as markdown link", "[Feat](https://github.com/acme/app/pull/7)"],
      // The message Send message posts, as Slack pastes it (no ClipboardItem here: the plain flavour).
      ["Slack message text", "#7 Feat\nhttps://github.com/acme/app/pull/7\nPR Preview: https://feat.preview.test"],
      ["Preview URL", "https://feat.preview.test"],
      ["Worktree path", "/wt/feat"],
    ];
    await mount(row);
    await openSub("Copy");
    expect(labels()).toEqual(expect.arrayContaining([...expected.map(([l]) => l), "CLI command"]));
    for (const [label, text] of expected) {
      copied = [];
      await click(menuitem(label)!);
      expect(copied).toEqual([text]);
      await reopen();
      await openSub("Copy");
    }
    expect(apiFake.slackSends).toEqual([]); // a copy never posts
  });

  test("Merge ▸ Merge now only; Enable/Disable auto-merge is in PR ▸", async () => {
    await mount(prRow);
    expect(labels()).not.toContain("Enable auto-merge"); // not a top-level item
    await openSub("Merge");
    expect(labels()).toContain("Merge now (unreviewed)");
    expect(menuitem("Merge when green")).toBeUndefined();
    expect(menuitem("Enable auto-merge")).toBeUndefined();
  });

  test("PR ▸ Enable auto-merge toggles to Disable auto-merge", async () => {
    await mount(prRow);
    await openSub("PR");
    expect(labels()).toContain("Enable auto-merge");
    await click(menuitem("Enable auto-merge")!);
    expect(apiFake.calls).toContain("autoMerge:7");
    act(() => root!.render(<WorkstreamActions row={{ ...prRow, autoMergeEnabled: true }} />));
    await reopen();
    expect(labels()).not.toContain("Disable auto-merge"); // not a top-level item
    await openSub("PR");
    expect(labels()).toContain("Disable auto-merge");
    expect(labels()).not.toContain("Enable auto-merge");
    await click(menuitem("Disable auto-merge")!);
    expect(apiFake.calls).toContain("disableAutoMerge:7");
  });

  test("Agent ▸ Stop agent shows only while the agent runs, and stops it through /api/agent/stop", async () => {
    await mount(prRow);
    await openSub("Agent");
    expect(menuitem("Stop agent")).toBeUndefined();
    act(() => root!.render(<WorkstreamActions row={{ ...prRow, agentStatus: "running" }} />));
    await reopen();
    await openSub("Agent");
    expect(labels()).toEqual(expect.arrayContaining(["Stop agent", "Move to cloud"]));
    await click(menuitem("Stop agent")!);
    expect(apiFake.stopped).toEqual(["/wt/feat"]);
  });

  test("PR ▸ and Slack ▸ keep their verbs", async () => {
    await mount(prRow);
    await openSub("PR");
    expect(labels()).toEqual(expect.arrayContaining(["Move to draft", "Address PR", "Add preview"]));
    await reopen();
    await openSub("Slack");
    expect(labels()).toEqual(expect.arrayContaining(["Send message", "Send bump"]));
  });
});
