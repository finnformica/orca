// The notification centre, server side (shared/notifications.ts + server/notify.ts + db.ts): every
// event kind is recorded ONCE — a run finishing (done / asked a question / failed / stopped), Orca's
// check failing, a PR's CI failing or conflicting, a preview coming up or not — pushed on the bus,
// deduped across a restart (the same run finished twice) and across instances (the same key from
// another machine), pruned after 30 days, and marked read through the db API (never deleted by you). Same
// harness as verifyGate.test.ts: a fake `claude` on PATH, a scratch repo, real Postgres.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as bus from "../server/bus";
import * as notify from "../server/notify";
import * as preview from "../server/preview";
import { eventStream, RELAYED } from "../server/events";
import { asksForInput, checkNotification, filterNotifications, groupByDay, prNotifications, previewNotification, runNotification, shouldToast, stripMarkdown, toastStack, unreadCount, type Notification } from "../shared/notifications";
import { makeScratchRepo } from "./helpers";
import { freshSchema, type TestDb } from "./pg";
import { native } from "./happydom";

// The preload swaps in happy-dom's fetch for component tests; the preview watcher probes a real port.
const dom = { fetch: globalThis.fetch, Response: globalThis.Response, AbortSignal: globalThis.AbortSignal, AbortController: globalThis.AbortController };
beforeAll(() => { Object.assign(globalThis, native); });
afterAll(() => { Object.assign(globalThis, dom); });

describe("decisions (pure)", () => {
  const base = { repo: "r", branch: "feat", runId: "run-1", title: "Login form" };

  test("a finished run → finished; a reply ending in a question → needs input; error / stopped; compact and continued are silent", () => {
    expect(runNotification({ ...base, status: "done", response: "## Outcome\nDone." })).toMatchObject({ kind: "finished", key: "run:run-1:finished", title: "Login form", body: "Done." });
    const asked = runNotification({ ...base, status: "done", outcome: { outcome: "Built it.\nShould I also migrate the old rows?", verification: [], decisions: [], remaining: [], commits: [] } });
    expect(asked).toMatchObject({ kind: "needs_input", body: "Should I also migrate the old rows?" });
    expect(asksForInput({ response: "All done **now?**" })).toBe(true);
    expect(asksForInput({ response: "Done.\n\nNext steps?\nNo." })).toBe(false);
    expect(asksForInput({ stopReason: "requires_action", response: "" })).toBe(true);
    expect(runNotification({ ...base, status: "error", error: "claude: not logged in" })).toMatchObject({ kind: "failed", body: "claude: not logged in" });
    expect(runNotification({ ...base, status: "stopped" })).toMatchObject({ kind: "stopped" });
    expect(runNotification({ ...base, status: "done", response: "Done.", compact: true })).toBeUndefined();
    expect(runNotification({ ...base, status: "done", response: "Done.", continued: true })).toBeUndefined();
    expect(runNotification({ ...base, title: undefined, status: "done", response: "Done." })?.title).toBe("feat"); // the branch when untitled
  });

  test("a report's markdown is stripped to plain text before it reaches the one-line card", () => {
    expect(stripMarkdown("**Title:** changed from `old` to **new**, see [the doc](https://x/y)")).toBe("Title: changed from old to new, see the doc");
    expect(stripMarkdown("## Comment dispositions\n- resolved: renamed the field\n1. also this")).toBe("Comment dispositions\nresolved: renamed the field\nalso this");
    const finished = runNotification({ ...base, status: "done", outcome: {
      outcome: "**Item names:** now pass `entityName` through. See [the PR](https://x/y).", verification: [], decisions: [], remaining: [], commits: [],
    } });
    expect(finished).toMatchObject({ kind: "finished", body: "Item names: now pass entityName through. See the PR." });
  });

  test("the orchestrator's own wake: only a problem or a question is reported, and it opens the window", () => {
    const o = { ...base, orchestrator: true };
    expect(runNotification({ ...o, status: "done", response: "Spawned two workers." })).toBeUndefined();
    expect(runNotification({ ...o, status: "stopped" })).toBeUndefined();
    expect(runNotification({ ...o, status: "done", response: "Which repo should the fix go to?" })).toMatchObject({ kind: "needs_input", link: { orchestrator: true } });
    expect(runNotification({ ...o, status: "error", error: "budget" })).toMatchObject({ kind: "failed", link: { orchestrator: true } });
  });

  test("a failed check is its own event (a continued autofix doesn't hide it); a passed one is nothing", () => {
    const check = { command: "bun run check", ok: false, exitCode: 1, output: "1 fail", durationMs: 5 };
    expect(checkNotification({ ...base, check })).toMatchObject({ kind: "check_failed", key: "check:run-1", body: "bun run check exited 1" });
    expect(checkNotification({ ...base, check: { ...check, ok: true } })).toBeUndefined();
    expect(checkNotification({ ...base })).toBeUndefined();
  });

  test("PRs: CI failing once per head commit, conflicts once per PR, open PRs only", () => {
    const pr = { number: 7, title: "Add login", branch: "feat", state: "OPEN", ciStatus: "failing", mergeable: "CONFLICTING", failingChecks: ["test", "lint"], head: "abc123" };
    const out = prNotifications("r", [pr, { ...pr, number: 8, state: "MERGED" }]);
    expect(out.map((n) => [n.kind, n.key])).toEqual([["pr_ci_failed", "pr-ci:r#7@abc123"], ["pr_conflicts", "pr-conflict:r#7"]]);
    // Checks flapping on ONE commit (a re-run, a check finishing later) is the same event: same key.
    const key = (p: Parameters<typeof prNotifications>[1][number]) => prNotifications("r", [p])[0]!.key;
    expect(key({ ...pr, failingChecks: ["lint"] })).toBe(key({ ...pr, failingChecks: ["test"] }));
    // A new push failing again is a new event; with no head known, it is once per PR.
    expect(key({ ...pr, head: "def456" })).toBe("pr-ci:r#7@def456");
    expect(key({ ...pr, head: undefined })).toBe("pr-ci:r#7");
    expect(out[0]).toMatchObject({ body: "Failing: lint, test", link: { pr: 7 }, title: "Add login" });
    expect(prNotifications("r", [{ ...pr, ciStatus: "passing", mergeable: "MERGEABLE" }])).toEqual([]);
  });

  test("previews: ready carries the URL to open; failed carries the reason; a re-spin is a new key", () => {
    const p = { repo: "r", branch: "feat", title: "Login form", key: "/wt/feat", startedAt: 1_000 };
    expect(previewNotification({ ...p, ready: true, url: "http://box:4000" })).toMatchObject({ kind: "preview_ready", key: "preview:/wt/feat:1000:ready", link: { url: "http://box:4000" } });
    expect(previewNotification({ ...p, startedAt: 2_000, ready: false, error: "web: exited" })).toMatchObject({ kind: "preview_failed", key: "preview:/wt/feat:2000:failed", body: "web: exited" });
  });

  test("the UI's cuts: unread count, grouping by day, the stack, what pops", () => {
    const NOW = Date.parse("2026-10-12T12:00:00");
    const n = (id: number, ago: number, extra: Partial<Notification> = {}): Notification => ({ id, instance: "local", repo: "r", kind: "finished", title: "t", body: "", createdAt: NOW - ago, ...extra });
    const list = [n(1, 60_000), n(2, 26 * 3_600_000, { readAt: NOW }), n(3, 3 * 86_400_000), n(4, 10, { readAt: NOW })];
    expect(unreadCount(list)).toBe(2);
    // The centre's one filter: Unread drops the read rows, All keeps every one (nothing is deleted).
    expect(filterNotifications(list, "unread").map((i) => i.id)).toEqual([1, 3]);
    expect(filterNotifications(list, "all").map((i) => i.id)).toEqual([1, 2, 3, 4]);
    expect(groupByDay(list, NOW).map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([["Today", [4, 1]], ["Yesterday", [2]], ["Fri 9 Oct", [3]]]);
    const stack = toastStack([n(1, 3), n(2, 2), n(3, 1), n(4, 0)]);
    expect(stack.hidden).toBe(1); // three show, collapsed or expanded (sonner's cut); the bell has the rest
    expect(stack.visible.map((t) => t.id)).toEqual([4, 3, 2]); // newest on top
    expect(stack.ordered.map((t) => t.id)).toEqual([4, 3, 2, 1]);
    expect(shouldToast(n(1, 0), { dnd: false, prefs: {}, now: NOW })).toBe(true);
    expect(shouldToast(n(1, 0), { dnd: true, prefs: {}, now: NOW })).toBe(false);
    expect(shouldToast(n(1, 0, { readAt: NOW }), { dnd: false, prefs: {}, now: NOW })).toBe(false); // read elsewhere first
    expect(shouldToast(n(1, 0), { dnd: false, prefs: { finished: false }, now: NOW })).toBe(false);
    expect(shouldToast(n(1, 3_600_000), { dnd: false, prefs: {}, now: NOW })).toBe(false); // an hour old: for the centre, not the corner
    expect(RELAYED).toContain("notification");
  });
});

describe("emitting, once", () => {
  let state: string;
  let shim: string;
  let repo: string;
  let pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  const heard: Notification[] = [];
  let off = () => {};

  beforeEach(async () => {
    prev = { ORCA_STATE_DIR: process.env.ORCA_STATE_DIR, ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, PATH: process.env.PATH, ORCA_INSTANCE: process.env.ORCA_INSTANCE };
    state = await mkdtemp(join(tmpdir(), "orca-notify-"));
    shim = await mkdtemp(join(tmpdir(), "orca-claude-"));
    repo = await makeScratchRepo();
    process.env.ORCA_STATE_DIR = state;
    process.env.ORCA_INSTANCE = "local";
    process.env.PATH = `${shim}:${prev.PATH}`;
    pg = await freshSchema("notify");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    heard.length = 0;
    off = bus.subscribe((e) => { if (e.kind === "notification") heard.push(e.notification); });
  });
  afterEach(async () => {
    off();
    agent.onRunFinished(undefined);
    await agent.flushHistory();
    await agent.afterRunsSettled();
    await db.close();
    await pg.drop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const d of [state, shim, repo]) await rm(d, { recursive: true, force: true });
  });

  /** A fake claude: optionally commits, then replies with `result` (or fails). */
  async function fakeClaude(result: string, opts: { commit?: boolean; fail?: boolean; sleep?: number } = {}): Promise<void> {
    const lines = [
      "#!/bin/sh",
      ...(opts.sleep ? [`sleep ${opts.sleep}`] : []),
      ...(opts.commit ? [`git commit -q --allow-empty -m "agent work"`] : []),
      ...(opts.fail ? ["echo 'claude: not logged in' >&2", "exit 1"] : [`cat "${join(shim, "result.json")}"`]),
    ];
    await writeFile(join(shim, "result.json"), JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
    await writeFile(join(shim, "claude"), lines.join("\n") + "\n");
    await chmod(join(shim, "claude"), 0o755);
  }
  /** Run the fake agent on the scratch repo as r/feat and wait for its after-run path. */
  async function runAndSettle(opts: Parameters<typeof agent.runAgent>[2] = {}): Promise<void> {
    agent.onRunFinished((run) => notify.onRunFinished(run));
    await agent.runAgent(repo, "do it", { repo: "r", branch: "feat", provider: "claude", instruction: "do it", ...opts });
    for (let i = 0; i < 400 && agent.isRunning(repo); i++) await new Promise((r) => setTimeout(r, 25));
    await agent.afterRunsSettled();
    await agent.flushHistory();
  }

  test("a run that finished → one `finished` row, headed by the card's title, pushed on the bus", async () => {
    await db.patchEnrichment("r", "feat", { title: "Login form" });
    await fakeClaude("## Outcome\nForm built.");
    await runAndSettle();
    const rows = await db.notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "finished", title: "Login form", body: "Form built.", repo: "r", branch: "feat", instance: "local" });
    expect(rows[0]!.readAt).toBeUndefined();
    expect(heard.map((n) => n.kind)).toEqual(["finished"]);
  });

  test("a reply that asks you something → `needs_input`; a failed run → `failed`; a stopped run → `stopped`", async () => {
    await fakeClaude("## Outcome\nBuilt it. Should the old rows be migrated too?");
    await runAndSettle();
    expect((await db.notifications()).map((n) => [n.kind, n.body])).toEqual([["needs_input", "Built it. Should the old rows be migrated too?"]]);

    await fakeClaude("", { fail: true });
    await runAndSettle();
    expect((await db.notifications())[0]).toMatchObject({ kind: "failed", body: "claude: not logged in" });

    // Stop is the route's doing (a stopped run is superseded in agent.ts and never reaches the hook).
    await fakeClaude("never", { sleep: 30 });
    agent.onRunFinished((run) => notify.onRunFinished(run));
    const { runId } = await agent.runAgent(repo, "go", { repo: "r", branch: "feat", provider: "claude", instruction: "go" });
    expect(agent.stop(repo)).toBe(runId);
    await notify.stopped(runId);
    await notify.stopped(runId); // a second press is not a second row
    for (let i = 0; i < 400 && agent.isRunning(repo); i++) await new Promise((r) => setTimeout(r, 25));
    expect((await db.notifications()).map((n) => n.kind)).toEqual(["stopped", "failed", "needs_input"]);
    expect(heard.map((n) => n.kind)).toEqual(["needs_input", "failed", "stopped"]);
  });

  test("a commit that fails Orca's check → `check_failed` beside the run's own event", async () => {
    await fakeClaude("## Outcome\nDone.", { commit: true });
    await runAndSettle({ check: { command: "echo boom; exit 3", autofix: false } });
    const kinds = (await db.notifications()).map((n) => n.kind).sort();
    expect(kinds).toEqual(["check_failed", "finished"]);
    expect((await db.notifications()).find((n) => n.kind === "check_failed")!.body).toBe("echo boom; exit 3 exited 3");
  });

  test("once: the same run finished again (a restart's adoption), or the same key from another instance, adds no row", async () => {
    const run = {
      key: repo, cwd: repo, runId: "run-x", options: { repo: "r", branch: "feat" }, status: "done" as const, result: "## Outcome\nDone.",
      continued: false, exit: { code: 0, timedOut: false, budgetReached: false, stderr: "" },
    };
    await notify.onRunFinished(run);
    await notify.onRunFinished(run); // the exit handler and the adopted-lease path both report it
    process.env.ORCA_INSTANCE = "cloud";
    await notify.onRunFinished(run); // the other machine, same database
    expect(await db.notifications()).toHaveLength(1);
    expect(heard).toHaveLength(1); // and pushed once
    expect(await db.addNotification({ key: "run:run-x:finished", repo: "r", kind: "finished", title: "t", body: "" })).toBeUndefined();
  });

  test("the orchestrator's own wake that asks you something is a row titled \"Orca\", the name the UI uses", async () => {
    await notify.onRunFinished({
      key: "/state/orchestrator", cwd: "/state/orchestrator", runId: "run-orca", options: { repo: "@orca", branch: "orchestrator" }, status: "done" as const,
      result: "Which PR should I merge first?", continued: false, exit: { code: 0, timedOut: false, budgetReached: false, stderr: "" },
    });
    const rows = await db.notifications();
    expect(rows.map((n) => [n.kind, n.title])).toEqual([["needs_input", "Orca"]]);
  });

  test("PRs: CI failing and conflicts, once per PR — a second poll, a check flap or the other instance adds nothing", async () => {
    const prs = [{ number: 7, title: "Add login", branch: "feat", state: "OPEN", ciStatus: "failing", mergeable: "CONFLICTING", failingChecks: ["test"], head: "abc" }];
    await notify.prs("r", prs);
    await notify.prs("r", prs);
    await notify.prs("r", [{ ...prs[0]!, failingChecks: ["lint", "test"] }]); // another check failed on the same commit
    process.env.ORCA_INSTANCE = "cloud";
    await notify.prs("r", [{ ...prs[0]!, failingChecks: ["lint"] }]); // re-run: test passed, lint still red — answered by the box
    const rows = await db.notifications();
    expect(rows.map((n) => n.kind).sort()).toEqual(["pr_ci_failed", "pr_conflicts"]);
    expect(rows[0]!.link).toEqual({ pr: 7 });
    await notify.prs("r", [{ ...prs[0]!, head: "def" }]); // a new push failing again IS news
    expect((await db.notifications()).filter((n) => n.kind === "pr_ci_failed")).toHaveLength(2);
  });

  test("a preview is watched until it answers (→ ready, with the URL) or dies (→ failed); a stopped one is forgotten", async () => {
    notify.previewWatch.everyMs = 50;
    const range: [number, number] = [41000, 41900];
    const serve = `bun -e "Bun.serve({ port: {port}, hostname: '127.0.0.1', fetch: () => new Response('ok') }); setInterval(() => {}, 1000)"`;
    await preview.start(repo, repo, [{ name: "web", command: serve, open: true }], range);
    await notify.watchPreview({ key: repo, repo: "r", branch: "feat", title: "Login form", host: "box" });
    const ready = (await db.notifications())[0]!;
    expect(ready).toMatchObject({ kind: "preview_ready", title: "Login form", branch: "feat" });
    expect(ready.link?.url).toMatch(/^http:\/\/box:41\d{3}$/);
    preview.stop(repo);

    await preview.start(repo, repo, [{ name: "web", command: "echo nope; exit 1", open: true }], range);
    await notify.watchPreview({ key: repo, repo: "r", branch: "feat", title: "Login form", host: "box" });
    expect((await db.notifications())[0]).toMatchObject({ kind: "preview_failed", body: "web: nope" });
    preview.stop(repo);

    await preview.start(repo, repo, [{ name: "web", command: "sleep 30", open: true }], range);
    const watch = notify.watchPreview({ key: repo, repo: "r", branch: "feat", title: "Login form", host: "box" });
    preview.stop(repo); // you stopped it mid-boot
    notify.forgetPreview(repo);
    await watch;
    expect(await db.notifications()).toHaveLength(2); // nothing new
  });

  test("the centre's API: newest first, `since` catches up, mark read (some or all) keeps every row, pruned past 30 days", async () => {
    const t0 = Date.now() - 10_000;
    const old = await db.addNotification({ key: "k-old", repo: "r", kind: "finished", title: "old", body: "" }, t0 - 31 * 86_400_000);
    const a = (await db.addNotification({ key: "k-a", repo: "r", kind: "finished", title: "a", body: "" }, t0))!;
    const b = (await db.addNotification({ key: "k-b", repo: "r", kind: "failed", title: "b", body: "" }, t0 + 1_000))!;
    const c = (await db.addNotification({ key: "k-c", repo: "r", kind: "needs_input", title: "c", body: "" }, t0 + 2_000))!;
    expect(old).toBeDefined(); // written…
    expect((await db.notifications()).map((n) => n.title)).toEqual(["c", "b", "a"]); // …and pruned by the next insert
    expect((await db.notifications({ since: t0 })).map((n) => n.title)).toEqual(["c", "b"]);
    expect(await db.markNotificationsRead([a.id, b.id])).toBe(2);
    expect(await db.markNotificationsRead([a.id])).toBe(0); // already read
    expect((await db.notifications()).map((n) => [n.title, Boolean(n.readAt)])).toEqual([["c", false], ["b", true], ["a", true]]);
    expect(await db.markNotificationsRead("all")).toBe(1);
    // Read is the only state change: nothing leaves the centre but the 30-day prune.
    expect((await db.notifications()).map((n) => [n.title, Boolean(n.readAt)])).toEqual([["c", true], ["b", true], ["a", true]]);
    expect("dismissNotifications" in db).toBe(false);
    // A row "cleared" back when the centre had Clear (dismissed_at set, read with it) is back, as read.
    const d = (await db.addNotification({ key: "k-d", repo: "r", kind: "failed", title: "d", body: "" }, t0 + 3_000))!;
    const sql = await db.open();
    await sql`UPDATE notification SET dismissed_at = ${t0 + 4_000}, read_at = ${t0 + 4_000} WHERE id = ${d.id}`;
    expect((await db.notifications()).find((n) => n.id === d.id)).toMatchObject({ title: "d", readAt: t0 + 4_000 });
  });

  test("the tab's stream carries a `notification` frame", async () => {
    const ctl = new AbortController();
    const res = eventStream(new Request("http://orca.test/api/events", { signal: ctl.signal }), []);
    const reader = res.body!.getReader();
    let buf = ""; // the stream enqueues whole frames as strings
    const read = async (until: string) => {
      for (let i = 0; i < 50 && !buf.includes(until); i++) { const r = await reader.read(); if (r.done) break; buf += String(r.value); }
    };
    await read("event: ready");
    await notify.emit({ key: "k-stream", repo: "r", branch: "feat", kind: "finished", title: "Stream me", body: "ok" });
    await read("event: notification");
    const frame = buf.slice(buf.indexOf("event: notification"));
    expect(JSON.parse(frame.split("\n")[1]!.replace(/^data: /, ""))).toMatchObject({ kind: "finished", title: "Stream me", repo: "r" });
    ctl.abort();
  });
});
