// The Inbox page (views/Inbox.tsx) and the workstream cards' source chips, rendered against the fake
// api (tests/apiFake.ts) in a real DOM: rows newest first with source, sender, workstream and reply
// state; the source filter in the URL; the thread view across inbound and outbound; no native title
// tooltips; and the Slack chip on the card of a workstream with a Slack thread.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import * as notificationStore from "@/lib/notificationStore";
import { inboxFacets, notificationRows, type InboxRow } from "../shared/inbox";
import type { Notification } from "../shared/notifications";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function open(path: string) {
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
}
const all = (slot: string) => [...container!.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)];
const click = async (el: HTMLElement) => act(async () => { el.click(); await flush(); await flush(); });

const now = Date.now();
const rows: InboxRow[] = [
  { id: "e4", at: now - 60_000, topic: "orca.question", kind: "question", adapter: "orca", text: "Merge #12 now?", conversation: "orca|event:e4", reply: { state: "dead", at: now - 59_000, attempts: 1, error: "channel_not_found" }, read: true, muted: false, canReply: false, canLink: false },
  { id: "e3", at: now - 600_000, topic: "ext.email.message", kind: "message", adapter: "email", sender: { name: "Ada", principalId: "ada", externalId: "ada@example.com" }, text: "Is the demo up?", conversation: "email|orca@example.com", read: false, muted: false, canReply: true, canLink: true },
  { id: "e2", at: now - 3_600_000, topic: "ext.slack.message", kind: "message", adapter: "slack", sender: { name: "Saajan", principalId: "saajan", externalId: "U1" }, text: "Can you also fix the header?", conversation: "slack|C1:1.2", workstream: { repo: "r", branch: "feat-login" }, reply: { state: "sent", at: now - 3_500_000, attempts: 1 }, read: false, muted: false, canReply: true, canLink: false },
];

describe("the Inbox page", () => {
  beforeAll(() => store.configReady);
  afterEach(async () => {
    apiFake.reset();
    notificationStore.reset();
    await act(async () => { await store.refresh(); });
    act(() => root?.unmount());
    container?.remove();
    root = container = undefined;
    localStorage.clear();
    navigate("/");
  });

  const seed = () => {
    apiFake.agentsData = [{ branch: "feat-login", worktreePath: "/wt/feat-login", agentStatus: "done" }];
    apiFake.enrichmentData.set("r::feat-login", { title: "Login form" });
    apiFake.inboxData = { rows, facets: inboxFacets(rows), older: null };
    apiFake.inboxThreads.set("slack|C1:1.2", {
      conversation: { adapter: "slack", id: "C1:1.2" }, workstream: { repo: "r", branch: "feat-login" },
      replyTo: "e2", canLink: false, sender: { eventId: "e2", name: "Saajan", muted: false }, unread: ["e2"],
      items: [
        { dir: "out", id: "d1", at: now - 4_000_000, adapter: "slack", topic: "orca.run.finished", to: "#eng", text: "Login form is done", state: "sent", attempts: 1 },
        { dir: "in", id: "e2", at: now - 3_600_000, adapter: "slack", topic: "ext.slack.message", sender: { name: "Saajan" }, text: "Can you also fix the header?" },
        { dir: "out", id: "d2", at: now - 3_500_000, adapter: "slack", topic: "orca.message", to: "#eng", text: "On it.", state: "failed", attempts: 2, error: "rate limited" },
      ],
    });
    apiFake.threadLinksData = [{ adapter: "slack", externalThreadId: "C1:1.2", linkId: "eng", repo: "r", branch: "feat-login" }];
  };

  test("an unknown sender's message: its place and a Read-only tag; Add to person joins an existing person", async () => {
    const notice: InboxRow = { id: "e5", at: now - 30_000, topic: "ext.slack.message", kind: "message", adapter: "slack", sender: { name: "Mira", externalId: "U9" }, place: "DM", readOnly: true, text: "are you free?", conversation: "slack|D9", read: false, muted: false, canReply: true, canLink: true };
    apiFake.inboxData = { rows: [notice, ...rows], facets: inboxFacets([notice, ...rows]), older: null };
    apiFake.integrationsData = { instance: "local", kinds: [], integrations: [], links: [], people: [{ id: "ana", name: "Ana", maxLevel: "ask", identities: [] }], pairings: [], subscriptions: [], dead: [] };
    await open("/inbox");
    const [first, , , known] = all("inbox-row");
    expect(first!.querySelector('[data-slot="inbox-place"]')!.textContent).toBe("DM");
    expect(first!.querySelector('[data-slot="inbox-read-only"]')!.textContent).toBe("Read-only");
    expect(known!.querySelector('[data-slot="inbox-read-only"]')).toBeNull();
    const pointerdown = async (el: Element) => act(async () => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await flush(); await flush(); });
    // A sender with a person has no Add to person.
    await pointerdown(known!.querySelector('[data-slot="row-actions"]')!);
    expect(document.querySelector('[data-slot="action-add-person"]')).toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(); });
    await pointerdown(first!.querySelector('[data-slot="row-actions"]')!);
    const sub = document.querySelector<HTMLElement>('[data-slot="action-add-person"]')!;
    expect(sub.textContent).toBe("Add to person");
    await act(async () => { sub.focus(); sub.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); await flush(); await flush(); });
    const items = [...document.querySelectorAll<HTMLElement>('[data-slot="add-person-new"], [data-slot="add-person-existing"]')];
    expect(items.map((i) => i.textContent)).toEqual(["New person…", "Ana"]);
    await click(items[1]!);
    expect(apiFake.integrationPosts).toEqual([{ path: "identities/add", body: { principal: "ana", adapter: "slack", externalId: "U9", name: "Mira" } }]);
  });

  test("rows newest first: source, sender, workstream chip, reply state; the source filter is in the URL", async () => {
    seed();
    await open("/inbox");
    const list = all("inbox-row");
    expect(list.map((r) => r.querySelector('[data-slot="inbox-sender"]')!.textContent)).toEqual(["Orca", "Ada", "Saajan"]);
    expect(list.map((r) => r.querySelector('[data-slot="source-chip"]')!.getAttribute("data-source"))).toEqual(["orca", "email", "slack"]);
    expect(list.map((r) => r.querySelector('[data-slot="delivery-state"]')?.getAttribute("data-state") ?? null)).toEqual(["dead", null, "sent"]);
    expect(list[2]!.querySelector('[data-slot="workstream-chip"]')!.textContent).toContain("Login form");
    expect(list[0]!.getAttribute("data-kind")).toBe("question");
    // No native title tooltips anywhere on the page.
    expect(container!.querySelectorAll("main [title]")).toHaveLength(0);
    // The source chips carry their counts; one click filters and is in the URL.
    const slack = all("inbox-source").find((b) => b.getAttribute("data-source") === "slack")!;
    expect(slack.textContent).toBe("Slack1");
    await click(slack);
    expect(location.search).toBe("?source=slack");
    expect(apiFake.inboxCalls.at(-1)).toMatchObject({ source: "slack" });
    expect(all("inbox-row").map((r) => r.querySelector('[data-slot="inbox-sender"]')!.textContent)).toEqual(["Saajan"]);
  });

  test("the thread view: the whole conversation in and out, oldest first, with each delivery's state", async () => {
    seed();
    await open("/inbox");
    await click(all("inbox-row")[2]!);
    expect(new URLSearchParams(location.search).get("thread")).toBe("slack|C1:1.2");
    await act(async () => { await flush(); await flush(); });
    const items = all("thread-item");
    expect(items.map((i) => i.getAttribute("data-dir"))).toEqual(["out", "in", "out"]);
    expect(items[1]!.textContent).toContain("Saajan");
    expect(items[2]!.querySelector('[data-slot="delivery-state"]')!.getAttribute("data-state")).toBe("failed");
    expect(all("inbox-thread")[0]!.querySelector('[data-slot="workstream-chip"]')).not.toBeNull();
    expect(all("inbox-row")[2]!.getAttribute("aria-current")).toBe("true");
  });

  test("each integration row shows its real logo; a notification about one shows that logo; Orca's own rows keep the bot", async () => {
    const list: InboxRow[] = [
      { id: "c1", at: now - 30_000, topic: "ext.cloudflare.deploy", kind: "event", adapter: "cloudflare", sender: { name: "Cloudflare" }, title: "Deploy of site-worker failed", text: "Worker site-worker: deploy failed", conversation: "cloudflare|zone:example.com", read: false, muted: false, canReply: false, canLink: false },
      { id: "n:5", at: now - 40_000, topic: "orca.notification.integration_failed", kind: "event", adapter: "orca", icon: "discord", sender: { name: "Delivery failed", externalId: "kind:integration_failed" }, title: "Delivery to discord C1 failed", text: "after 6 attempts", conversation: "", read: false, muted: false, canReply: false, canLink: false },
      ...rows,
    ];
    apiFake.inboxData = { rows: list, facets: inboxFacets(list), older: null };
    await open("/inbox");
    const chip = (source: string) => all("source-chip").filter((c) => c.getAttribute("data-source") === source);
    const cfLogo = chip("cloudflare")[0]!.querySelector('[data-slot="brand-icon"]')!;
    expect(cfLogo.getAttribute("data-kind")).toBe("cloudflare");
    expect([...cfLogo.querySelectorAll("path")].map((p) => p.getAttribute("fill"))).toEqual(["#F38020", "#FBAE40"]);
    expect(chip("slack")[0]!.querySelector('[data-slot="brand-icon"]')!.getAttribute("data-kind")).toBe("slack");
    const orca = chip("orca");
    expect(orca.map((c) => c.querySelector('[data-slot="brand-icon"]')?.getAttribute("data-kind") ?? "bot")).toEqual(["discord", "bot"]);
  });

  test("a workstream with a Slack thread shows the Slack chip on its Agents row", async () => {
    seed();
    await open("/agents");
    await act(async () => { await flush(); await flush(); });
    const row = container!.querySelector<HTMLElement>('[data-slot="workstream-row"][data-branch="feat-login"]')!;
    expect(row.querySelector('[data-slot="thread-chips"] [data-source="slack"]')).not.toBeNull();
  });
  test("Unread: a dot and a bold sender until read; the Unread chip filters; opening a thread marks it read", async () => {
    seed();
    await open("/inbox");
    const dots = () => all("inbox-row").map((r) => !!r.querySelector('[data-slot="unread-dot"]'));
    expect(dots()).toEqual([false, true, true]);
    expect(all("inbox-unread")[0]!.textContent).toBe("Unread2");
    await click(all("inbox-unread")[0]!);
    expect(location.search).toBe("?unread=1");
    expect(apiFake.inboxCalls.at(-1)).toMatchObject({ unread: true });
    expect(all("inbox-row").map((r) => r.querySelector('[data-slot="inbox-sender"]')!.textContent)).toEqual(["Ada", "Saajan"]);
    // Opening Saajan's thread marks its unread event read, and the row loses its dot.
    await click(all("inbox-row")[1]!);
    await act(async () => { await flush(); await flush(); await flush(); });
    expect(apiFake.inboxActions).toContainEqual(["read", ["e2"], true]);
    expect(all("inbox-row").find((r) => r.textContent!.includes("Saajan"))?.querySelector('[data-slot="unread-dot"]') ?? null).toBeNull();
  });

  test("Reply in the thread view: the composer opens, Enter sends through the orca post route, a failure keeps the text", async () => {
    seed();
    await open("/inbox?thread=" + encodeURIComponent("slack|C1:1.2"));
    await act(async () => { await flush(); await flush(); });
    await click(all("thread-reply-open")[0]!);
    const box = all("reply-box")[0]!.querySelector("textarea")!;
    expect(document.activeElement).toBe(box);
    expect(box.getAttribute("placeholder")).toBe("Reply to Saajan…");
    const type = async (text: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    apiFake.inboxReplyError = "the link \"eng\" no longer exists";
    await type("On it.");
    await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await flush(); await flush(); });
    expect(apiFake.inboxActions).toContainEqual(["reply", "e2", "On it."]);
    expect(box.value).toBe("On it."); // kept for another try
    apiFake.inboxReplyError = null;
    await act(async () => { all("reply-send")[0]!.click(); await flush(); await flush(); });
    expect(apiFake.inboxActions.filter((a) => a[0] === "reply")).toHaveLength(2);
    expect(all("reply-box")).toHaveLength(0); // closed after a send
    expect(all("thread-reply-open")).toHaveLength(1);
  });

  test("Orca's notifications are rows too: one count with the bell, Open goes where the bell's goes and reads it, See all", async () => {
    seed();
    const ci: Notification = { id: 41, instance: "local", repo: "r", branch: "feat-login", kind: "pr_ci_failed", title: "Login form", body: "test failed", link: { pr: 7 }, createdAt: now - 120_000 };
    apiFake.notificationsData = [ci];
    const mixed = [...rows, ...notificationRows([ci])].sort((a, b) => b.at - a.at);
    apiFake.inboxData = { rows: mixed, facets: inboxFacets(mixed), older: null };
    apiFake.inboxUnreadData = { others: 2, mutedKinds: [] }; // Ada and Saajan's messages: no bell copy
    await open("/inbox");
    await act(async () => { await flush(); await flush(); });
    const list = all("inbox-row");
    expect(list.map((r) => r.querySelector('[data-slot="source-chip"]')!.getAttribute("data-source"))).toEqual(["orca", "orca", "email", "slack"]);
    const note = list[1]!;
    expect(note.querySelector('[data-slot="inbox-sender"]')!.textContent).toBe("Login form");
    expect(note.querySelector('[data-slot="inbox-badge"]')!.textContent).toBe("CI failing");
    expect(note.querySelector('[data-slot="unread-dot"]')).not.toBeNull();
    // One count: the bell's unread row plus the two messages, on the bell and the Inbox nav item.
    expect(all("notifications-unread")[0]!.textContent).toBe("3");
    expect(all("inbox-unread-count")[0]!.textContent).toBe("3");
    // Both badges are the one shared CountBadge: same colour, size, radius, font and padding.
    const sharedClasses = ["bg-foreground", "text-background", "h-4", "min-w-4", "rounded-full", "text-[10px]", "font-semibold"];
    for (const c of sharedClasses) {
      expect(all("notifications-unread")[0]!.className.split(" ")).toContain(c);
      expect(all("inbox-unread-count")[0]!.className.split(" ")).toContain(c);
    }
    // Open: the PR's Chat tab with the composer focused (the bell's Open), and the bell's row is read.
    await click(note);
    expect(location.pathname + location.search).toBe("/r/prs/7/chat?reply=1");
    expect(apiFake.notificationCalls).toContainEqual({ verb: "read", ids: [41] });
    expect(all("notifications-unread")[0]!.textContent).toBe("2");
    expect(all("inbox-unread-count")[0]!.textContent).toBe("2");
    // The bell keeps a quick view, and See all opens the Inbox.
    await click(all("notifications-bell")[0]!);
    const seeAll = document.querySelector<HTMLElement>('[data-slot="notification-see-all"]')!;
    expect(seeAll.textContent).toContain("See all");
    expect(document.querySelector('[aria-label="Mark all as read"]')).not.toBeNull();
    await click(seeAll);
    expect(location.pathname).toBe("/inbox");
  });

  test("a kind muted in the Inbox leaves the bell's count and its quick view", async () => {
    seed();
    const ci: Notification = { id: 42, instance: "local", repo: "r", branch: "feat-login", kind: "pr_ci_failed", title: "Login form", body: "test failed", createdAt: now - 120_000 };
    const done: Notification = { id: 43, instance: "local", repo: "r", branch: "feat-login", kind: "finished", title: "Login form", body: "done", createdAt: now - 100_000 };
    apiFake.notificationsData = [ci, done];
    apiFake.inboxUnreadData = { others: 0, mutedKinds: ["pr_ci_failed"] };
    await open("/inbox");
    await act(async () => { await flush(); await flush(); });
    expect(all("notifications-unread")[0]!.textContent).toBe("1");
    await click(all("notifications-bell")[0]!);
    expect([...document.querySelectorAll('[data-slot="notification-row"]')].map((r) => r.getAttribute("data-kind"))).toEqual(["finished"]);
  });
});
