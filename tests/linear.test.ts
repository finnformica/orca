// The Linear adapter (server/integrations/adapters/linear.ts, docs/integrations/linear.md): a poll on
// the GraphQL API with an updatedAt cursor; issues and comments for the configured user become events
// on the link of the issue's project or team; a comment on a linked issue reaches its workstream; and
// a workstream's PR event goes back to its linked issue as one comment. Real Postgres and the real
// registry, router and dispatcher; Linear itself is a fake GraphQL endpoint (fetch stubbed).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../server/db";
import * as router from "../server/integrations/router";
import * as dispatcher from "../server/integrations/dispatcher";
import * as registry from "../server/integrations/registry";
import * as store from "../server/integrations/store";
import {
  commentFilter, commentId, commentWanted, issueReason, linearAdapter, linearRequest, mentions, places, render,
  type LinearAdapter, type LinearComment, type LinearIssue, type LinearUser,
} from "../server/integrations/adapters/linear";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const dom = { fetch: globalThis.fetch, Response: globalThis.Response };
beforeAll(() => { Object.assign(globalThis, native); });
afterAll(() => { Object.assign(globalThis, dom); });

const ME: LinearUser = { id: "u-finn", name: "Finn Formica", displayName: "finn" };
const issue = (id: string, o: Partial<LinearIssue> = {}): LinearIssue => ({
  id, identifier: `ENG-${id}`, title: `Issue ${id}`, description: "", url: `https://linear.app/acme/issue/ENG-${id}`,
  updatedAt: "2026-10-17T10:00:00.000Z", assignee: null, creator: { id: "u-sam", name: "Sam" }, state: { name: "Todo" },
  team: { id: "t-eng", key: "ENG" }, project: null, ...o,
});
const comment = (id: string, on: LinearIssue, o: Partial<LinearComment> = {}): LinearComment => ({
  id, body: "looks good", url: `${on.url}#comment-${id}`, createdAt: "2026-10-17T11:00:00.000Z", updatedAt: "2026-10-17T11:00:00.000Z",
  user: { id: "u-sam", name: "Sam Lee", displayName: "sam" }, issue: on, ...o,
});

type Call = { op: string; variables: any; auth: string | null };
/** A fake Linear: answers each operation by name. */
function fakeLinear(answers: Record<string, (v: any) => unknown>, calls: Call[] = []) {
  globalThis.fetch = (async (url: any, init: any) => {
    expect(String(url)).toBe("https://api.linear.app/graphql");
    const { query, variables } = JSON.parse(init.body);
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
    calls.push({ op, variables, auth: new Headers(init.headers).get("authorization") });
    const answer = answers[op];
    if (!answer) return Response.json({ errors: [{ message: `no fake for ${op}` }] }, { status: 400 });
    const r = answer(variables);
    return r instanceof Response ? r : Response.json({ data: r });
  }) as typeof fetch;
  return calls;
}
const page = <T,>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

describe("decisions (pure)", () => {
  test("a mention is @displayName or the profile link, not a longer name", () => {
    expect(mentions("cc @finn please", ME)).toBe(true);
    expect(mentions("see [@Finn](https://linear.app/acme/profiles/finn).", ME)).toBe(true);
    expect(mentions("@finnegan", ME)).toBe(false);
    expect(mentions("Finn Formica", ME)).toBe(false);
    expect(mentions(null, ME)).toBe(false);
  });

  test("an issue is an event when assigned or mentioning; a comment when on my issue or mentioning, never my own", () => {
    expect(issueReason(issue("1", { assignee: { id: "u-finn" } }), ME)).toBe("assigned");
    expect(issueReason(issue("2", { description: "ask @finn" }), ME)).toBe("mention");
    expect(issueReason(issue("3"), ME)).toBeUndefined();
    const mine = issue("1", { assignee: { id: "u-finn" } });
    expect(commentWanted(comment("c1", mine), ME)).toBe(true);
    expect(commentWanted(comment("c2", issue("3"), { body: "@finn?" }), ME)).toBe(true);
    expect(commentWanted(comment("c3", issue("3")), ME)).toBe(false);
    expect(commentWanted(comment("c4", mine, { user: { id: "u-finn" } }), ME)).toBe(false); // Orca posts with my key
    expect(commentFilter("2026-10-17T00:00:00.000Z", ME)).toMatchObject({ updatedAt: { gt: "2026-10-17T00:00:00.000Z" }, user: { id: { neq: "u-finn" } } });
  });

  test("the place: the project, then the team", () => {
    expect(places(issue("1"))).toEqual({ channel: "team:ENG", parents: [] });
    expect(places(issue("1", { project: { id: "p-1", name: "Launch" } }))).toEqual({ channel: "project:p-1", parents: ["team:ENG"] });
  });

  test("a comment id is a stable UUID v4 per delivery; the body is markdown", () => {
    expect(commentId("lin:7")).toBe(commentId("lin:7"));
    expect(commentId("lin:7")).not.toBe(commentId("lin:8"));
    expect(commentId("lin:7")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(render({ title: "#7 Add X", url: "https://gh/7", text: "CI failed" })).toBe("**[#7 Add X](https://gh/7)**\n\nCI failed");
  });

  test("errors: bad auth and a bad query are fatal; a rate limit, a 5xx and the network retry", async () => {
    const at = (status: number, body: unknown, headers: Record<string, string> = {}) => linearAndRun(() => new Response(JSON.stringify(body), { status, headers }));
    const linearAndRun = async (impl: () => Response) => { globalThis.fetch = (async () => impl()) as unknown as typeof fetch; return linearRequest("k", "query X { x }"); };
    expect(await at(401, {})).toMatchObject({ ok: false, retryable: false });
    expect(await at(400, { errors: [{ message: "Authentication required", extensions: { type: "authentication error" } }] })).toMatchObject({ ok: false, retryable: false });
    expect(await at(400, { errors: [{ message: "rate", extensions: { code: "RATELIMITED" } }] }, { "retry-after": "30" })).toEqual({ ok: false, retryable: true, retryAfterMs: 30_000, error: "rate limited" });
    expect(await at(503, {})).toMatchObject({ ok: false, retryable: true });
    expect(await at(400, { errors: [{ message: "Field x unknown" }] })).toEqual({ ok: false, retryable: false, error: "Field x unknown" });
    globalThis.fetch = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    expect(await linearRequest("k", "query X { x }")).toEqual({ ok: false, retryable: true, error: "ECONNRESET" });
  });
});

describe("with Postgres", () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE, ORCA_SECRET_LINEAR: process.env.ORCA_SECRET_LINEAR };
    process.env.ORCA_INSTANCE = "local";
    process.env.ORCA_SECRET_LINEAR = "lin_api_test";
    pg = await freshSchema("linear");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    router.resetPace();
    dispatcher.resetPace();
  });
  afterEach(async () => {
    await dispatcher.stop();
    await registry.stopAll();
    dispatcher.configure({ adapter: () => undefined });
    dispatcher.setRunning(() => []);
    globalThis.fetch = native.fetch;
    await db.close();
    await pg.drop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const setup = async () => {
    await store.addIntegration({ id: "linear", kind: "linear", name: "Linear", instance: "local", config: { pollSeconds: 3600 }, secretRef: "ORCA_SECRET_LINEAR", enabled: true });
    await store.addLink({ id: "eng", integrationId: "linear", externalId: "team:ENG", level: "work", repos: ["r"], requireMention: false });
    await store.addLink({ id: "launch", integrationId: "linear", externalId: "project:p-1", level: "ask", repos: [], requireMention: false });
    await store.addSubscription({ topicPattern: "ext.linear.issue", filter: {}, targetKind: "orchestrator" });
    await store.setCursor("linear", "2026-10-17T00:00:00.000Z");
  };

  test("poll: assigned and mentioning issues and others' comments become events on the project's or team's link; the cursor moves; a repeat is a duplicate", async () => {
    await setup();
    const assigned = issue("1", { assignee: { id: "u-finn", name: "Finn" }, updatedAt: "2026-10-17T09:00:00.000Z" });
    const inProject = issue("2", { description: "@finn can you check?", project: { id: "p-1", name: "Launch" }, updatedAt: "2026-10-17T09:30:00.000Z" });
    const unrelated = issue("3", { updatedAt: "2026-10-17T12:00:00.000Z" });
    const otherTeam = issue("4", { team: { id: "t-ops", key: "OPS" }, identifier: "OPS-4" });
    const calls = fakeLinear({
      OrcaViewer: () => ({ viewer: ME }),
      OrcaIssues: () => ({ issues: page([unrelated, inProject, assigned]) }),
      OrcaComments: () => ({ comments: page([
        comment("c1", assigned),
        comment("c2", assigned, { user: { id: "u-finn", name: "Finn" } }),
        comment("c3", otherTeam, { body: "@finn look", updatedAt: "2026-10-17T11:30:00.000Z" }),
      ]) }),
    });
    expect(await registry.sync()).toEqual(["linear"]);
    const a = registry.adapterFor("linear") as LinearAdapter;
    const first = await a.poll(); // waits for the loop's own first poll, then polls again
    expect(first.ingested).toBe(0); // everything was already taken by the loop's poll
    expect(calls[0]).toMatchObject({ op: "OrcaViewer", auth: "lin_api_test" }); // the key as is, no Bearer
    const issuesCall = calls.find((c) => c.op === "OrcaIssues")!;
    expect(issuesCall.variables.filter.updatedAt).toEqual({ gt: "2026-10-17T00:00:00.000Z" });
    expect(issuesCall.variables.filter.or).toContainEqual({ assignee: { id: { eq: "u-finn" } } });

    const e1 = await store.event("linear:linear:issue:1:assigned");
    expect(e1).toMatchObject({ topic: "ext.linear.issue", source: { adapter: "linear", channel: "team:ENG", linkId: "eng" }, thread: { adapter: "linear", externalId: "1" }, grant: { level: "work", repos: ["r"] }, link: { url: assigned.url } });
    expect(e1!.actor).toBeUndefined(); // a poller is a machine sender: no pairing code is posted on Linear
    expect(e1!.text).toContain("is assigned to Finn Formica");
    expect(await store.event("linear:linear:issue:2:mention")).toMatchObject({ source: { channel: "project:p-1", parents: ["team:ENG"], linkId: "launch" }, grant: { level: "ask" } });
    expect(await store.event("linear:linear:issue:3:assigned")).toBeUndefined();
    expect(await store.event("linear:linear:issue:3:mention")).toBeUndefined();
    expect(await store.event("linear:linear:comment:c1")).toMatchObject({ topic: "ext.linear.message", thread: { externalId: "1", messageId: "c1" }, mentioned: false, title: "sam on ENG-1 Issue 1" });
    expect(await store.event("linear:linear:comment:c2")).toBeUndefined(); // my own (and Orca's) comment
    expect(await store.event("linear:linear:comment:c3")).toBeUndefined(); // OPS has no link: rejected
    expect(await store.cursor("linear")).toBe("2026-10-17T12:00:00.000Z");
    // The issue went to the orchestrator by its subscription; the comment by the inbound default.
    const targets = (await store.deliveries()).map((d) => `${d.envelope.key}>${d.target.kind}`).sort();
    expect(targets).toEqual(["linear:linear:comment:c1>orchestrator", "linear:linear:issue:1:assigned>orchestrator", "linear:linear:issue:2:mention>orchestrator"]);
    const next = calls.filter((c) => c.op === "OrcaIssues").at(-1)!;
    expect(next.variables.filter.updatedAt).toEqual({ gt: "2026-10-17T12:00:00.000Z" });
  });

  test("a comment on a linked issue reaches its workstream; a PR event goes back to the issue as one comment", async () => {
    await setup();
    const assigned = issue("1", { assignee: { id: "u-finn" } });
    const created: any[] = [];
    let comments: LinearComment[] = [];
    fakeLinear({
      OrcaViewer: () => ({ viewer: ME }),
      OrcaIssues: () => ({ issues: page([]) }),
      OrcaComments: () => ({ comments: page(comments) }),
      OrcaCommentCreate: (v) => {
        if (created.some((c) => c.id === v.input.id)) return Response.json({ errors: [{ message: "Entity already exists" }] }, { status: 400 });
        created.push(v.input);
        return { commentCreate: { success: true, comment: { id: v.input.id } } };
      },
    });
    await registry.sync();
    const a = registry.adapterFor("linear") as LinearAdapter;
    await a.poll();
    // `orca thread link linear 1 --repo r --branch feat --link eng`
    await store.setThreadLink({ adapter: "linear", externalThreadId: "1", linkId: "eng", repo: "r", branch: "feat" });
    comments = [comment("c9", assigned, { body: "please also handle the empty state" })];
    await a.poll();
    expect((await store.deliveries()).find((d) => d.envelope.key === "linear:linear:comment:c9")!.target).toEqual({ kind: "workstream", repo: "r", branch: "feat" });

    await store.addSubscription({ topicPattern: "orca.pr.*", filter: {}, targetKind: "link", targetId: "eng" });
    dispatcher.configure({ adapter: registry.adapterFor });
    dispatcher.setRunning(registry.runningIds);
    const pr = (branch: string, key: string) => router.publish({ key, topic: "orca.pr.ci_failed", at: Date.now(), source: { adapter: "orca" }, scope: { repo: "r", branch }, title: "#7 Add X", text: "CI failed: test", link: { url: "https://github.com/o/r/pull/7" } });
    await pr("feat", "pr-ci:r#7@abc");
    await pr("other", "pr-ci:r#8@def"); // no linked issue: skipped, not dead
    await dispatcher.dispatchOnce();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ issueId: "1", body: "**[#7 Add X](https://github.com/o/r/pull/7)**\n\nCI failed: test" });
    const sent = (await store.deliveries()).filter((d) => d.target.kind === "link");
    expect(sent.map((d) => d.state)).toEqual(["sent", "sent"]);
    // The same delivery sent again (a crash after the send) is the same comment, not a second one.
    const again = await a.send({ externalId: "team:ENG", threadId: "1" }, { text: "x" }, String(sent.find((d) => d.envelope.key === "pr-ci:r#7@abc")!.id));
    expect(again).toMatchObject({ ok: true, externalMsgId: created[0].id });
    expect(created).toHaveLength(1);
  });

  test("a list cut at the page cap holds the cursor at its newest row read, so nothing after it is skipped", async () => {
    await setup();
    const at = (h: number) => new Date(Date.UTC(2026, 9, 17, h)).toISOString();
    fakeLinear({
      OrcaViewer: () => ({ viewer: ME }),
      // Every page says there is more: the adapter stops after 10 pages.
      OrcaIssues: (v) => { const n = Number(v.after ?? 0); return { issues: { nodes: [issue(`i${n}`, { assignee: { id: "u-finn" }, updatedAt: at(n) })], pageInfo: { hasNextPage: true, endCursor: String(n + 1) } } }; },
      OrcaComments: () => ({ comments: page([comment("late", issue("x", { assignee: { id: "u-finn" } }), { updatedAt: at(20) })]) }),
    });
    await registry.sync();
    const r = await (registry.adapterFor("linear") as LinearAdapter).poll();
    expect(r.cursor).toBe(at(9));
    expect(await store.event("linear:linear:issue:i9:assigned")).toBeDefined();
    expect(await store.event("linear:linear:comment:late")).toBeUndefined(); // the next poll reads it
  });

  test("start: a bad key does not start, and the registry records why", async () => {
    await setup();
    fakeLinear({ OrcaViewer: () => Response.json({ errors: [{ message: "Authentication required, not authenticated", extensions: { type: "authentication error" } }] }, { status: 400 }) });
    expect(await registry.sync()).toEqual([]);
    expect((await store.integration("linear"))).toBeDefined();
    const a = linearAdapter({ id: "x", kind: "linear", name: "x", instance: "local", config: {}, secretRef: "ORCA_SECRET_LINEAR", enabled: true });
    expect(await a.health()).toMatchObject({ ok: false, detail: expect.stringContaining("authentication failed") });
  });
});
