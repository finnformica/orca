// The Agents-list row's preview cell (views/PreviewControl.tsx PreviewCell): a link once a preview
// is reachable, an "Add preview" button when there isn't one, a spinner while it boots, all in the
// same fixed slot (no layout shift), disabled with a tooltip when the repo hasn't opted into
// RepoFeatures.previews. Mounts the cell directly against a synthetic row, the way
// previewPlacement.test.tsx drives PreviewControl, rather than the whole Agents page.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { PreviewCell } from "@/views/PreviewControl";
import { ToastHost } from "@/components/Notifications";
import * as centre from "@/lib/notificationStore";
import { openTip } from "./tip";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<>{node}<ToastHost /></>); await flush(); await flush(); });
}
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
afterEach(async () => { await act(async () => { root?.unmount(); }); container?.remove(); apiFake.reset(); act(() => centre.reset()); });

// repo "r" (the fake config's only repo) carries RepoFeatures.previews: true; a row on a repo the
// config knows nothing about reads as previews-disabled — there is no entry saying otherwise.
const row: store.Row = { repo: "r", hasRemote: true, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat" };
const disabledRow: store.Row = { ...row, repo: "nopreview", branch: "feat2", worktreePath: "/wt/feat2" };

const cell = () => container!.querySelector<HTMLElement>('[data-slot="preview-cell"]')!;
const stopBtn = () => container!.querySelector<HTMLButtonElement>('button[aria-label="Stop preview"]');

test("none: an enabled Add-preview button, no status dot", async () => {
  await mount(<PreviewCell row={row} />);
  const c = cell();
  expect(c.dataset.state).toBe("none");
  const btn = c.querySelector("button")!;
  expect(btn.disabled).toBe(false);
  expect(btn.getAttribute("aria-label")).toBe("Add preview");
  expect(btn.querySelector(".lucide-flask-conical")).not.toBeNull();
  expect(c.querySelector('[data-slot="status-dot"]')).toBeNull();
  expect(stopBtn()).toBeNull(); // nothing to stop yet
});

test("disabled: previews not enabled for the repo — a disabled button with a tooltip, same slot", async () => {
  await mount(<PreviewCell row={disabledRow} />);
  const c = cell();
  expect(c.dataset.state).toBe("disabled");
  const btn = c.querySelector("button")!;
  expect(btn.disabled).toBe(true);
  expect(openTip(btn).textContent).toBe("Previews aren't enabled for nopreview");
  expect(btn.querySelector(".lucide-flask-conical")).not.toBeNull();
  await click(btn); // disabled: clicking does nothing
  expect(apiFake.previewCalls).toEqual([]);
  expect(stopBtn()).toBeNull();
});

test("starting: clicking Add preview shows a spinner and a building-tone dot, in the same slot", async () => {
  // Mount with nothing running yet (the mount-time poll must see an empty list), then make the
  // "server" report the just-started service only once the click's own testLocally() asks for it.
  await mount(<PreviewCell row={row} />);
  expect(cell().dataset.state).toBe("none");
  apiFake.previewSvcs = [{ name: "frontend", port: 9001, url: "http://orca-box:9001", open: true, running: true, ready: false, startedAt: Date.now() }];
  await click(cell().querySelector("button")!);
  expect(apiFake.previewCalls).toEqual([{ key: "/wt/feat", instance: "laptop" }]);
  const c = cell();
  expect(c.dataset.state).toBe("starting");
  const btn = c.querySelector("button")!;
  expect(btn.disabled).toBe(true);
  expect(btn.querySelector(".lucide-loader-circle, svg.animate-spin")).not.toBeNull();
  const dot = c.querySelector<HTMLElement>('[data-slot="status-dot"]')!;
  expect(dot.dataset.tone).toBe("building");
  // A Stop button sits right beside it while it boots — confirm-free.
  expect(stopBtn()).not.toBeNull();
  expect(stopBtn()!.disabled).toBe(false);
});

test("running: a link to the right URL (the owner's, not localUrl on this non-local test page) with a ready-tone dot", async () => {
  await mount(<PreviewCell row={row} />);
  expect(cell().dataset.state).toBe("none");
  apiFake.previewSvcs = [{
    name: "frontend", port: 9001, url: "http://orca-box:9001", localUrl: "http://localhost:9001",
    open: true, running: true, ready: true, startedAt: Date.now(),
  }];
  await click(cell().querySelector("button")!);
  const c = cell();
  expect(c.dataset.state).toBe("ready");
  const link = c.querySelector("a")!;
  expect(link.getAttribute("href")).toBe("http://orca-box:9001"); // previewHref: not loopback here → the owner's url, never localUrl
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("aria-label")).toBe("Open preview");
  const dot = c.querySelector<HTMLElement>('[data-slot="status-dot"]')!;
  expect(dot.dataset.tone).toBe("ready");
  expect(stopBtn()).not.toBeNull();
});

test("stop: clicking the Stop button next to the link stops the preview, no confirm, same slot clears to idle", async () => {
  await mount(<PreviewCell row={row} />);
  apiFake.previewSvcs = [{ name: "frontend", port: 9001, url: "http://orca-box:9001", open: true, running: true, ready: true, startedAt: Date.now() }];
  await click(cell().querySelector("button")!);
  expect(cell().dataset.state).toBe("ready");
  await click(stopBtn()!);
  expect(apiFake.previewStopCalls).toEqual([{ key: "/wt/feat", instance: "laptop" }]);
  expect(cell().dataset.state).toBe("none");
  expect(stopBtn()).toBeNull(); // gone once there's nothing running
});

const actionToasts = () => [...document.body.querySelectorAll<HTMLElement>('[data-slot="notification-toast"][data-kind="action_failed"]')];

test("stop failure: the preview stays up and the error goes to a failed-action notification toast, not the row", async () => {
  await mount(<PreviewCell row={row} />);
  apiFake.previewSvcs = [{ name: "frontend", port: 9001, url: "http://orca-box:9001", open: true, running: true, ready: true, startedAt: Date.now() }];
  await click(cell().querySelector("button")!);
  apiFake.previewStopError = "stop failed: port busy";
  await click(stopBtn()!);
  expect(cell().dataset.state).toBe("ready"); // the control doesn't lie about a preview still running
  expect(stopBtn()).not.toBeNull();
  expect(actionToasts()).toHaveLength(1);
  expect(actionToasts()[0]!.textContent).toContain("Preview failed");
  expect(actionToasts()[0]!.textContent).toContain("stop failed: port busy");
});

test("failed: a crashed service reaps to a retry icon with an error-tone dot, same slot", async () => {
  await mount(<PreviewCell row={row} />);
  expect(cell().dataset.state).toBe("none");
  apiFake.previewSvcs = [{ name: "frontend", port: 9001, url: "http://orca-box:9001", open: true, running: false, ready: false, startedAt: Date.now(), error: "boom" }];
  await click(cell().querySelector("button")!);
  await act(async () => { await flush(); await flush(); }); // the auto-reap effect settles after the crash is observed
  const c = cell();
  expect(c.dataset.state).toBe("failed");
  const btn = c.querySelector("button")!;
  expect(btn.disabled).toBe(false); // clicking retries
  expect(openTip(btn).textContent).toBe("Preview failed — boom");
  expect(btn.querySelector(".lucide-triangle-alert")).not.toBeNull();
  const dot = c.querySelector<HTMLElement>('[data-slot="status-dot"]')!;
  expect(dot.dataset.tone).toBe("error");
  expect(stopBtn()).toBeNull(); // already reaped — nothing left to stop
  // No failed-action toast for a crash: the bridge's watcher reports it as `preview_failed`, and one
  // crash is one notification (tests/actionToast.test.tsx T4 pushes that and counts the stack).
  expect(actionToasts()).toEqual([]);
});
