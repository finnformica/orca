// Named agents (docs/design/named-agents-and-memory.md §7, PR B): the Chief of Staff (today's
// orchestrator) and the Assistant share one runtime but keep separate queues, wake counts and
// sessions; events route by agent; `orca ask` hands a message on and keeps an outside grant.
// Same harness as orchestrator.test.ts: a fake `claude` on PATH, real Postgres, the real router,
// dispatcher and `orca` tool.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as agents from "../server/agents";
import * as orchestrator from "../server/orchestrator";
import * as scheduledWake from "../server/scheduledWake";
import * as store from "../server/integrations/store";
import * as router from "../server/integrations/router";
import * as dispatcher from "../server/integrations/dispatcher";
import * as inbox from "../server/integrations/inbox";
import type { OrcaConfig } from "../server/config";
import type { AgentTurn } from "../shared/agent";
import { AGENT_VERBS, ASSISTANT, CHIEF, agentMessage, agentState, agentVerbRefusal, authoredPost, inboundAgent } from "../shared/agents";
import { SEED_AGENTS } from "../server/agentSeed";
import { ORCA_EVENT_MARKER, planDeliveries, type Envelope, type Grant } from "../shared/integrations";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, WORKER_EVENT_MARKER, agentDraftOf, agentDraftPatch, agentToolsLabel, commandsFor, toggleAgentVerb, isUserMessage, orchestratorPrompt, turnSource } from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, setPrListFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

let state: string, shim: string, repo: string, worktrees: string, log: string, hold: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};

const cfg = (extra: Partial<OrcaConfig> = {}): OrcaConfig => ({
  repos: [{ name: "r", repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"] }],
  portRange: [30000, 40000], staleHours: 24, ...extra,
});

beforeEach(async () => {
  prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_FAKE_LOG", "ORCA_FAKE_HOLD"].map((k) => [k, process.env[k]]));
  [state, shim, worktrees, log] = await Promise.all(["state", "claude", "wt", "log"].map(async (n) => realpathSync(await mkdtemp(join(tmpdir(), `orca-agents-${n}-`))))) as [string, string, string, string];
  repo = await makeScratchRepo();
  hold = join(state, "hold");
  process.env.ORCA_STATE_DIR = state;
  process.env.ORCA_FAKE_LOG = log;
  process.env.ORCA_FAKE_HOLD = hold;
  process.env.PATH = `${shim}:${prev.PATH}`;
  await installFakeGh();
  await setPrListFixture([]);
  // A fake claude: records its cwd and argv (one file per launch), waits while the hold file exists, answers.
  await writeFile(join(shim, "claude"), `#!/bin/sh
printf '%s\\n%s' "$PWD" "$*" > "$ORCA_FAKE_LOG/$(date +%s%N)-$$"
while [ -f "$ORCA_FAKE_HOLD" ]; do sleep 0.02; done
printf '{"type":"result","subtype":"success","result":"## Outcome\\\\nDone.","is_error":false}'
`);
  await chmod(join(shim, "claude"), 0o755);
  pg = await freshSchema("namedagents");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await rm(hold, { force: true });
  for (let i = 0; i < 200 && (await anyRunning()); i++) await new Promise((r) => setTimeout(r, 25));
  agent.onRunFinished(undefined);
  dispatcher.configure({ adapter: () => undefined });
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, repo, worktrees, log]) await rm(d, { recursive: true, force: true });
});

const wire = (c: OrcaConfig = cfg()) => agent.onRunFinished((run) => orchestrator.onRunFinished(c, run));
const anyRunning = async () => agent.isRunning(orchestrator.dir(CHIEF)) || agent.isRunning(orchestrator.dir(ASSISTANT));
const turnsOf = (branch: string) => db.turns(ORCHESTRATOR_REPO, branch);
const blobOf = async (branch: string) => (await db.enrichment(ORCHESTRATOR_REPO))[branch] ?? {};
/** Every fake-claude launch as { cwd, argv }, oldest first. */
const launches = async () => (await Promise.all((await readdir(log)).sort().map((f) => readFile(join(log, f), "utf8"))))
  .map((t) => { const i = t.indexOf("\n"); return { cwd: t.slice(0, i), argv: t.slice(i + 1) }; });
async function settled(read: () => Promise<AgentTurn[]>, n: number): Promise<AgentTurn[]> {
  for (let i = 0; i < 400; i++) {
    await agent.afterRunsSettled();
    const turns = await read();
    if (turns.length >= n && turns.every((t) => t.finishedAt) && !(await anyRunning())) return turns;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never settled at ${n} turn(s)`);
}
const report = (status: "done" | "error") => `${WORKER_EVENT_MARKER} r/feat "Add cache" — ${status}\nOutcome: ${status === "done" ? "Done." : "It broke."}`;

test("A1: the two agents have separate queues, wake counts, sessions and directories", async () => {
  wire();
  await writeFile(hold, "");
  expect((await orchestrator.message(cfg(), "hello chief")).status).toBe("running");
  expect((await orchestrator.message(cfg(), "hello assistant", [], { agent: ASSISTANT })).status).toBe("running");
  // While both wakes run, a message to one queues on ITS queue only.
  expect((await orchestrator.message(cfg(), "second for the assistant", [], { agent: ASSISTANT })).status).toBe("queued");
  expect((await db.queuedMessages(ORCHESTRATOR_REPO, ASSISTANT)).map((m) => m.instruction)).toEqual(["second for the assistant"]);
  expect(await db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH)).toEqual([]);
  await rm(hold, { force: true });
  const chief = await settled(() => turnsOf(ORCHESTRATOR_BRANCH), 1);
  const assistant = await settled(() => turnsOf(ASSISTANT), 2);
  expect(chief.map((t) => t.instruction)).toEqual(["hello chief"]);
  expect(assistant.map((t) => t.instruction)).toEqual(["hello assistant", "second for the assistant"]);
  // Each agent its own directory: the Chief of Staff keeps the orchestrator's; the Assistant's is new.
  const runs = await launches();
  expect(runs.filter((r) => r.cwd === orchestrator.dir(CHIEF))).toHaveLength(1);
  expect(orchestrator.dir(CHIEF)).toEndWith("/orchestrator");
  expect(orchestrator.dir(ASSISTANT)).toEndWith("/agents/assistant");
  const asst = runs.filter((r) => r.cwd === orchestrator.dir(ASSISTANT));
  expect(asst).toHaveLength(2);
  // The Assistant: its own role and Sonnet, and the Chief of Staff's tools (shell, every verb).
  expect(asst[0]!.argv).toContain("You are Orca's Assistant");
  expect(asst[0]!.argv).toContain("--model claude-sonnet-5-5");
  expect(asst[0]!.argv).toContain("bypassPermissions"); // every seeded agent has the shell (Finn narrows one in Settings)
  expect(asst[0]!.argv).toContain("orca spawn --repo");
  expect(asst[0]!.argv).toContain("orca ask <agent>");
  // Separate sessions; the second Assistant wake resumed the Assistant's own.
  const [cb, ab] = [await blobOf(ORCHESTRATOR_BRANCH), await blobOf(ASSISTANT)];
  expect(cb.sessionId).toBeTruthy();
  expect(ab.sessionId).toBeTruthy();
  expect(cb.sessionId).not.toBe(ab.sessionId);
  expect(asst[1]!.argv).toContain(`--resume ${ab.sessionId}`);
  // Separate wake counts: a report to one counts on that one only.
  await orchestrator.deliverReport(cfg(), report("error"));
  await settled(() => turnsOf(ORCHESTRATOR_BRANCH), 2);
  expect((await blobOf(ORCHESTRATOR_BRANCH)).wakes).toBe(1);
  expect((await blobOf(ASSISTANT)).wakes ?? 0).toBe(0);
  // Status per agent, and the list for the tabs.
  const all = await orchestrator.statuses(cfg());
  expect(all.map((s) => [s.agent, s.displayName, s.branch, s.state])).toEqual([[CHIEF, "Chief of Staff", ORCHESTRATOR_BRANCH, "idle"], [ASSISTANT, "Assistant", ASSISTANT, "idle"], ["research", "Research", "research", "idle"]]);
});

test("A2: a narrowed agent cannot spawn, merge, send or post as the user; agent add is the user's word, to any agent", async () => {
  const as = { _agent: ASSISTANT };
  // Every seeded agent has every verb: Finn narrows one in Settings. Here, the Assistant's old list.
  expect(await agents.get(ASSISTANT)).toMatchObject({ tools: { shell: true, verbs: "all" } });
  await agents.edit(ASSISTANT, { tools: { shell: false, verbs: OLD_ASSISTANT_VERBS } });
  const brief = { repo: "r", title: "Add cache", model: "claude-sonnet-5-5", objective: "x", output: "y", boundaries: "z" };
  await expect(orchestrator.tool(cfg(), "spawn", { ...brief, ...as })).rejects.toThrow(/Assistant may not run "spawn".*orca ask <agent>/);
  const refused: [string, Record<string, unknown>][] = [["merge", { repo: "r", pr: "1", "when-green": true }], ["send", { repo: "r", branch: "b", _: ["hi"] }], ["sweep", {}], ["archive", { repo: "r", branch: "b" }]];
  for (const [verb, args] of refused) {
    await expect(orchestrator.tool(cfg(), verb, { ...args, ...as })).rejects.toThrow(/may not run/);
  }
  await expect(orchestrator.tool(cfg(), "slack", { _: ["post", "#eng", "hi"], ...as })).rejects.toThrow(/posts as the user/);
  await expect(orchestrator.tool(cfg(), "preview", { repo: "r", branch: "b", ...as })).rejects.toThrow(/only preview --status/);
  // Its reads work.
  expect(await orchestrator.tool(cfg(), "board", as)).toBeString();
  // `agent add`: never an agent's own idea (no wake of only the user's messages), for any agent.
  await expect(orchestrator.tool(cfg(), "agent", { _: ["add", "scout"], display: "Scout", role: "Look around.", ...as })).rejects.toThrow(/user's alone/);
  await expect(orchestrator.tool(cfg(), "agent", { _: ["add", "scout"], display: "Scout", role: "Look around." })).rejects.toThrow(/user's alone/);
  // On the user's word it works, in ANY agent's wake (here the Assistant's), and the new agent gets
  // what every seeded agent got: a shell and every verb.
  await db.patchEnrichment(ORCHESTRATOR_REPO, ASSISTANT, { wakeFromUser: true });
  expect(await orchestrator.tool(cfg(), "agent", { _: ["add", "scout"], display: "Scout", role: "Look around.", ...as })).toContain("Added the agent scout");
  const scout = await agents.get("scout");
  expect(scout).toMatchObject({ displayName: "Scout", role: "Look around.", branch: "scout", tools: { shell: true, verbs: "all" } });
  expect(agentVerbRefusal(scout!, "spawn", [], {})).toBeUndefined();
  expect((await orchestrator.tool(cfg(), "agent", { _: ["list"] })).split("\n")).toEqual([
    "chief · Chief of Staff · idle", "assistant · Assistant · idle · limited verbs", "research · Research · idle", "scout · Scout · idle",
  ]);
});

test("A3: a stored orchestrator delivery reaches the Chief of Staff; an agent delivery its agent", async () => {
  wire();
  dispatcher.configure({
    adapter: () => undefined,
    orchestrator: (e) => inbox.toOrchestrator(cfg(), e),
    agent: (name, e) => inbox.toAgent(cfg(), name, e),
  });
  const ev = (key: string) => ({ key, topic: "orca.pr.ci_failed" as const, at: Date.now(), source: { adapter: "orca" }, scope: { repo: "r", branch: "feat" }, title: "Add cache", text: "Failing: ci" });
  // A row planned before named agents ({ kind: "orchestrator" }), and one for the Assistant.
  await router.publish(ev("old"), Date.now(), [{ subscriptionId: null, target: { kind: "orchestrator" } }]);
  await router.publish(ev("new"), Date.now(), [{ subscriptionId: null, target: { kind: "agent", name: ASSISTANT } }]);
  expect(await dispatcher.dispatchOnce()).toBe(2);
  const [chief] = await settled(() => turnsOf(ORCHESTRATOR_BRANCH), 1);
  const [asst] = await settled(() => turnsOf(ASSISTANT), 1);
  expect(chief!.instruction).toStartWith(`${ORCA_EVENT_MARKER} orca.pr.ci_failed`);
  expect(asst!.instruction).toStartWith(`${ORCA_EVENT_MARKER} orca.pr.ci_failed`);
  // A subscription may target an agent by name.
  await store.addSubscription({ topicPattern: "orca.pr.*", filter: {}, targetKind: "agent", targetId: ASSISTANT });
  const r = await router.publish(ev("sub"), Date.now());
  expect(r.deliveries).toHaveLength(1);
});

test("A4: an inbound message goes to its link's agent, @chief to the Chief of Staff, a thread reply to the agent that opened it", async () => {
  dispatcher.configure({ adapter: () => undefined }); // plan only: nothing is sent here
  await store.addIntegration({ id: "disc", kind: "discord", name: "Discord", instance: "local", config: {}, enabled: true });
  await store.addLink({ id: "L1", integrationId: "disc", externalId: "C1", label: "#ops", level: "work", repos: ["r"], requireMention: false });
  await store.addLink({ id: "L2", integrationId: "disc", externalId: "C2", label: "#lead", level: "work", repos: ["r"], requireMention: false, agent: CHIEF });
  await store.addPrincipal({ id: "ana", name: "Ana", maxLevel: "work" });
  await store.addIdentity("ana", { adapter: "discord", externalId: "U1" });
  const msg = (id: string, channel: string, text: string, thread?: string) => ({
    key: `discord:${id}`, topic: "ext.discord.message" as const, at: Date.now(), source: { adapter: "discord", channel },
    actor: { external: { adapter: "discord", id: "U1", name: "ana" } }, text, ...(thread ? { thread: { adapter: "discord", externalId: thread } } : {}),
  });
  const targets = async (key: string) => (await db.withRetry((sql) => sql`SELECT d.target FROM delivery d JOIN event e ON e.id = d.event_id WHERE e.key = ${key}`) as { target: { kind: string; name?: string } }[])
    .map((r) => r.target).filter((t) => t.kind !== "web");
  expect(await router.ingest("disc", msg("1", "C1", "is CI green?"))).toBe("new");
  expect(await targets("discord:1")).toEqual([{ kind: "orchestrator" }]); // no link agent: the default agent
  expect(await store.link("L2")).toMatchObject({ agent: CHIEF });
  await router.ingest("disc", msg("2", "C2", "status?"));
  expect(await targets("discord:2")).toEqual([{ kind: "agent", name: CHIEF }]); // the link's agent
  await router.ingest("disc", msg("3", "C1", "@chief merge order for the auth series?"));
  expect(await targets("discord:3")).toEqual([{ kind: "agent", name: CHIEF }]); // work grant + @chief
  // A thread the Assistant opened is linked to its branch; a reply there comes back to it, even on L2.
  await store.setThreadLink({ adapter: "discord", externalThreadId: "T9", linkId: "L2", repo: ORCHESTRATOR_REPO, branch: ASSISTANT });
  await router.ingest("disc", msg("4", "C2", "thanks", "T9"));
  expect(await targets("discord:4")).toEqual([{ kind: "agent", name: ASSISTANT }]);
});

test("A5: a clean report goes to cleanReportsTo; a problem report always to the default agent", async () => {
  const toAssistant = cfg({ agents: { cleanReportsTo: ASSISTANT } });
  wire(toAssistant);
  expect(await orchestrator.reportTarget(cfg(), report("done"))).toBe(CHIEF); // no setting: the first agent
  expect(await orchestrator.reportTarget(toAssistant, report("done"))).toBe(ASSISTANT);
  expect(await orchestrator.reportTarget(toAssistant, report("error"))).toBe(CHIEF);
  // A default agent setting moves problems (and unset clean reports) there; a gone name falls back.
  expect(await orchestrator.reportTarget(cfg({ agents: { default: "research" } }), report("error"))).toBe("research");
  expect(await orchestrator.reportTarget(cfg({ agents: { default: "research" } }), report("done"))).toBe("research");
  expect(await orchestrator.reportTarget(cfg({ agents: { default: "gone", cleanReportsTo: "gone" } }), report("done"))).toBe(CHIEF);
  await orchestrator.report(toAssistant, report("done"));
  await orchestrator.report(toAssistant, report("error"));
  const [asst] = await settled(() => turnsOf(ASSISTANT), 1);
  const [chief] = await settled(() => turnsOf(ORCHESTRATOR_BRANCH), 1);
  expect(asst!.instruction).toEndWith("Done.");
  expect(chief!.instruction).toEndWith("It broke.");
  expect(asst!.source).toBe("agents");
});

test("A6: orca ask hands a message on as [from <agent>], keeps an outside grant, and agent:<name> wakes the asker", async () => {
  wire();
  const grant: Grant = { level: "ask", repos: [], linkId: "L1" };
  // The Assistant is mid-wake for an outside sender (its blob holds the wake's grant); the Chief of
  // Staff is busy, so the message queues and we can read it.
  // The Assistant waits for the reply: `--on agent:chief` is a wake of its own (set from its own
  // chat: an outside "ask" wake may not set one).
  expect(await orchestrator.tool(cfg(), "wake", { on: "agent:chief", note: "Relay the merge order", _agent: ASSISTANT })).toContain("on agent:chief");
  await db.patchEnrichment(ORCHESTRATOR_REPO, ASSISTANT, { wakeGrant: grant, wakeReplyTo: { linkId: "L1", channel: "C1" } });
  await writeFile(hold, "");
  await orchestrator.message(cfg(), "busy", []);
  const out = await orchestrator.tool(cfg(), "ask", { _: ["chief", "Ana", "asks", "for", "the", "merge", "order"], memory: "m4", _agent: ASSISTANT });
  expect(out).toContain("Asked the Chief of Staff (queued");
  const [q] = await db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH);
  expect(q!.instruction).toBe(agentMessage(ASSISTANT, "Ana asks for the merge order\nMemories: m4 (orca memory show <id>)"));
  expect(q!.grant).toMatchObject(grant); // the hop gains nothing
  expect(q!.replyTo).toMatchObject({ linkId: "L1" });
  await rm(hold, { force: true });
  const chief = await settled(() => turnsOf(ORCHESTRATOR_BRANCH), 2);
  // Its own wake (one grant per wake), with the outside grant, under From other agents — never the user.
  expect(chief[1]!.prompt).toContain("## From other agents");
  expect(chief[1]!.prompt).not.toContain("## From the user");
  expect(chief[1]!.source).toBe("agents");
  // The Chief of Staff's finished wake fired the Assistant's wake.
  const asst = await settled(() => turnsOf(ASSISTANT), 1);
  expect(asst[0]!.instruction).toContain("on agent:chief");
  expect(asst[0]!.instruction).toContain("Relay the merge order");
  expect((await scheduledWake.list({ all: true }))[0]).toMatchObject({ state: "fired", agent: ASSISTANT });
  // An outside wake may ask (a read verb under "ask"), but not under "notify".
  await db.patchEnrichment(ORCHESTRATOR_REPO, ASSISTANT, { wakeGrant: { level: "notify", repos: [] } });
  await expect(orchestrator.tool(cfg(), "ask", { _: ["chief", "hi"], _agent: ASSISTANT })).rejects.toThrow(/outside sender/);
});

test("A7: visible state — the agent sets waiting, a user message clears it; a pause reads blocked", async () => {
  expect(await orchestrator.tool(cfg(), "agent", { _: ["state", "waiting"], note: "waiting on Finn: merge order", _agent: ASSISTANT })).toContain("State: waiting");
  expect(await orchestrator.status(cfg(), ASSISTANT)).toMatchObject({ state: "waiting", stateNote: "waiting on Finn: merge order" });
  await orchestrator.message(cfg(), "the order is A then B", [], { agent: ASSISTANT });
  await settled(() => turnsOf(ASSISTANT), 1);
  expect((await orchestrator.status(cfg(), ASSISTANT)).state).toBe("idle");
  await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakes: orchestrator.MAX_WAKES });
  expect(await orchestrator.status(cfg())).toMatchObject({ state: "blocked", stateNote: "paused: reply to resume", paused: true });
  await expect(orchestrator.tool(cfg(), "agent", { _: ["state", "working"] })).rejects.toThrow(/usage/);
});

test("A8: the pure rules — routing, the prefix, the classifiers, the prompt and its command list", () => {
  const [chiefSeed, assistantSeed] = SEED_AGENTS;
  expect(inboundAgent("@chief hi", "work")).toBe(CHIEF);
  expect(inboundAgent("chief: hi", "admin", "assistant")).toBe(CHIEF);
  expect(inboundAgent("@chief hi", "ask")).toBeUndefined(); // a lower grant: the link's agent only, here none = the default agent
  expect(inboundAgent("hi", "work", "assistant")).toBe(ASSISTANT);
  expect(inboundAgent("hi", "work", "scout")).toBe("scout");
  expect(authoredPost(assistantSeed!, "on it")).toBe("**Assistant**: on it");
  expect(authoredPost(chiefSeed!, "on it")).toBe("on it");
  expect(agentState({ running: true, paused: true, stored: "waiting" })).toEqual({ state: "working" });
  expect(agentState({ running: false, paused: false, stored: "done", note: "shipped" })).toEqual({ state: "done", note: "shipped" });
  const asked = agentMessage(ASSISTANT, "please merge #7");
  expect(isUserMessage(asked)).toBe(false);
  expect(turnSource([asked])).toBe("agents");
  // Outside an agent's thread or with no link agent, the plan names the Assistant.
  const inbound = { topic: "ext.slack.message", source: { adapter: "slack", linkId: "L1" }, grant: { level: "work" as const, repos: ["r"] }, actor: { external: { adapter: "slack", id: "U1" } }, text: "hi" } as unknown as Envelope;
  expect(planDeliveries(inbound, [], new Map([["L1", { integrationId: "s", adapter: "slack", externalId: "C1", agent: "scout" }]]))).toEqual([{ subscriptionId: null, target: { kind: "agent", name: "scout" } }]);
  // A narrowed agent (no spawn): its role and verbs, no Models, no notes.
  const p = orchestratorPrompt({ fresh: true, board: "(empty)", messages: ["hi"], role: assistantSeed!.role, verbs: OLD_ASSISTANT_VERBS, agent: { name: ASSISTANT, displayName: "Assistant" } });
  expect(p).toContain("You are Orca's Assistant");
  expect(p).not.toContain("## Models");
  expect(p).not.toContain("## Your notes");
  expect(p).not.toContain("You are Orca's orchestrator");
  const cmds = commandsFor(["board", "slack", "ask"]);
  expect(cmds).toContain("orca board");
  expect(cmds).toContain("orca slack read");
  expect(cmds).not.toContain("orca slack post");
  expect(cmds).not.toContain("orca spawn");
  // The Chief of Staff's prompt is the orchestrator's, plus the line about its team.
  const chief = orchestratorPrompt({ fresh: true, board: "(empty)", messages: ["hi"], role: chiefSeed!.role });
  expect(chief).toContain("You are Orca's orchestrator");
  expect(chief).toContain("You are the Chief of Staff of a small team of named agents");
  expect(chief).toContain("## Models");
});

// ── Agents defined by rows (server/agents.ts, named step 20261027-agent-definitions) ──

/** The Assistant's verbs as the code enforced them before the move: the seed must equal them. */
const OLD_ASSISTANT_VERBS = [
  "board", "channels", "machine", "chats", "read", "post", "thread", "ask-user", "ask-form",
  "memory", "wake", "ask", "agent", "status", "preview", "slack", "gmail", "cloudflare",
];

test("A9: the migration seeds three agents with equal tools, Research's role and Fable", async () => {
  const all = await agents.all();
  expect(all.map((a) => a.name)).toEqual([CHIEF, ASSISTANT, "research"]);
  for (const a of all) expect(a).toMatchObject({ tools: { shell: true, verbs: "all" }, maxGrant: "full" });
  expect(all.map((a) => a.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]);
  expect(all[0]!.role).toStartWith("You are Orca's orchestrator.");
  expect(all[1]!.role).toStartWith("You are Orca's Assistant");
  expect(all[2]!.role).toStartWith("You research features and ideas before any code is written.");
  expect(all[2]).toMatchObject({ displayName: "Research", branch: "research" });

  // The live database: Finn added `research` (no shell, the old Assistant verbs, Opus, his role), no
  // other row, and a link with no agent (= the Assistant then). The step keeps his role and its state,
  // gives it Fable and every verb, writes the other two, and names the Assistant on the link.
  const { seedAgentsSql } = await import("../server/agentSeed");
  await db.withRetry((sql) => sql`DELETE FROM agent`);
  await db.withRetry((sql) => sql`INSERT INTO agent (user_id, name, display_name, role, model, branch, tools, state, created_at, updated_at)
    VALUES ('me', 'research', 'Research', 'Finn wrote this.', 'claude-opus-5-5', 'research', ${{ shell: false, verbs: OLD_ASSISTANT_VERBS }}, 'waiting', 500, 500)`);
  await store.addIntegration({ id: "disc", kind: "discord", name: "Discord", instance: "local", config: {}, enabled: true });
  await store.addLink({ id: "L1", integrationId: "disc", externalId: "C1", label: "#ops", level: "work", repos: [], requireMention: false });
  await db.withRetry((sql) => sql.unsafe(seedAgentsSql()));
  expect((await agents.all()).map((a) => a.name)).toEqual([CHIEF, ASSISTANT, "research"]);
  expect(await agents.get("research")).toMatchObject({ role: "Finn wrote this.", model: "claude-fable-5-1", tools: { shell: true, verbs: "all" }, state: "waiting" });
  expect(await agents.get(CHIEF)).toMatchObject({ model: "claude-opus-5-5", tools: { shell: true, verbs: "all" } });
  expect(await store.link("L1")).toMatchObject({ agent: ASSISTANT });
  // A re-run never undoes an edit made in Settings, nor a link set to the default agent since.
  await agents.edit(ASSISTANT, { tools: { shell: false, verbs: ["board"] }, role: "Edited." });
  await db.withRetry((sql) => sql`UPDATE channel_link SET agent = NULL`);
  await db.withRetry((sql) => sql.unsafe(seedAgentsSql()));
  expect(await agents.get(ASSISTANT)).toMatchObject({ role: "Edited.", tools: { verbs: ["board"] } });
  expect((await store.link("L1"))!.agent).toBeFalsy();
});

test("A10: the verb check reads the row, and an edit applies to the next call with no restart", async () => {
  const as = { _agent: ASSISTANT };
  expect(await orchestrator.tool(cfg(), "board", as)).toBeString();
  await agents.edit(ASSISTANT, { tools: { shell: false, verbs: ["chats"] } });
  await expect(orchestrator.tool(cfg(), "board", as)).rejects.toThrow(/Assistant may not run "board"/);
  await agents.edit(ASSISTANT, { tools: { shell: false, verbs: "all" } });
  expect(await orchestrator.tool(cfg(), "board", as)).toBeString();
  // The Chief of Staff is a row like any other: a narrowed row narrows it.
  await agents.edit(CHIEF, { tools: { shell: true, verbs: ["chats"] } });
  await expect(orchestrator.tool(cfg(), "board", {})).rejects.toThrow(/Chief of Staff may not run "board"/);
  // A bad edit is refused and changes nothing.
  await expect(agents.edit(CHIEF, { tools: { shell: true, verbs: ["rm-rf"] } })).rejects.toThrow(/unknown verb rm-rf/);
  await expect(agents.edit(CHIEF, { role: "  " })).rejects.toThrow(/role text is required/);
  expect((await agents.get(CHIEF))!.tools).toEqual({ shell: true, verbs: ["chats"] });
});

test("A11: an edited role and model reach the next fresh wake", async () => {
  wire();
  await agents.edit(ASSISTANT, { role: "You are the Night Watch. Read and report.", model: "claude-haiku-4-5-20251001", displayName: "Night Watch" });
  await orchestrator.message(cfg(), "hello", [], { agent: ASSISTANT });
  await settled(() => turnsOf(ASSISTANT), 1);
  const [run] = (await launches()).filter((l) => l.cwd === orchestrator.dir(ASSISTANT));
  expect(run!.argv).toContain("You are the Night Watch. Read and report.");
  expect(run!.argv).not.toContain("You are Orca's Assistant");
  expect(run!.argv).toContain("claude-haiku-4-5-20251001");
  expect((await orchestrator.status(cfg(), ASSISTANT)).displayName).toBe("Night Watch");
});

test("A12: no agent edits or archives an agent; any agent archives but the last one", async () => {
  await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakeFromUser: true }); // even on the user's word
  for (const sub of ["edit", "remove", "archive"]) {
    await expect(orchestrator.tool(cfg(), "agent", { _: [sub, ASSISTANT], verbs: "all" })).rejects.toThrow(/user's alone: Settings > Agents/);
    await expect(orchestrator.tool(cfg(), "agent", { _: [sub, ASSISTANT], _agent: ASSISTANT })).rejects.toThrow(/user's alone/);
  }
  // Every agent has every verb: the agent verb's rule comes first.
  await expect(orchestrator.tool(cfg(), "agent", { _: ["edit", CHIEF], _agent: ASSISTANT })).rejects.toThrow(/user's alone/);
  await expect(orchestrator.tool(cfg(), "agent", { _: ["add", "scout"], display: "S", role: "r", _agent: ASSISTANT })).rejects.toThrow(/user's alone/);
  // Any row archives, the Chief of Staff's too; the last one stays.
  await agents.remove(CHIEF);
  await agents.remove("research");
  await expect(agents.remove(ASSISTANT)).rejects.toThrow(/assistant is the last agent/);
  expect((await agents.all()).map((a) => a.name)).toEqual([ASSISTANT]);
  await agents.add({ name: "scout", displayName: "Scout", role: "Look around." });
  await agents.remove(ASSISTANT);
  expect((await agents.all()).map((a) => a.name)).toEqual(["scout"]);
});

test("A14: with the Chief of Staff archived, everything that names no agent reaches the default agent", async () => {
  wire();
  await agents.remove(CHIEF);
  // No setting: the first active agent (the Assistant). The panel's main chat (status with no agent).
  expect((await orchestrator.status(cfg())).agent).toBe(ASSISTANT);
  // The setting picks another; a gone name falls back to the first active agent.
  const toResearch = cfg({ agents: { default: "research" } });
  await setDefaultAgentForTest("research");
  expect((await orchestrator.status(toResearch)).agent).toBe("research");
  // A message to no agent, a problem worker report and a stored "orchestrator" delivery: all to Research.
  await orchestrator.message(toResearch, "hello default");
  await settled(() => turnsOf("research"), 1);
  await orchestrator.deliverReport(toResearch, report("error"));
  await inbox.toOrchestrator(toResearch, { key: "k1", topic: "orca.pr.ci", at: Date.now(), source: { adapter: "orca" }, text: "CI red on #1" } as unknown as Envelope);
  // A delivery to an archived agent goes to the default agent too, never an error.
  expect(await inbox.toAgent(toResearch, CHIEF, { key: "k2", topic: "orca.pr.ci", at: Date.now(), source: { adapter: "orca" }, text: "CI red on #2" } as unknown as Envelope)).toEqual({ ok: true });
  await rm(hold, { force: true });
  const turns = await settled(() => turnsOf("research"), 2);
  expect(turns[0]!.instruction).toContain("hello default");
  expect(turns.map((t) => t.instruction).join("\n")).toContain("It broke.");
  expect(await turnsOf(ORCHESTRATOR_BRANCH)).toEqual([]);
  expect(await turnsOf(ASSISTANT)).toEqual([]);
  // `orca` with no agent (an old bin/orca) runs as the default agent.
  expect(await orchestrator.tool(toResearch, "agent", { _: ["state", "waiting"], note: "on Finn" })).toContain("State: waiting");
  expect(await agents.get("research")).toMatchObject({ state: "waiting" });
});

/** Settings' setter, on the test's own config document (the store reads `agents.default` from it). */
async function setDefaultAgentForTest(name: string) {
  const { setDefaultAgent, saveConfigDocument, invalidateConfig } = await import("../server/config");
  await saveConfigDocument(cfg());
  await setDefaultAgent(name);
  invalidateConfig();
}

test("A13: AGENT_VERBS is every verb of the tool route; the Settings form's pure helpers", async () => {
  const src = await readFile(join(import.meta.dir, "../server/orchestrator.ts"), "utf8");
  const cases = [...src.slice(src.indexOf("export async function tool(")).matchAll(/^\s+case "([a-z-]+)":/gm)].map((m) => m[1]!);
  expect([...new Set(cases)].sort()).toEqual([...AGENT_VERBS].sort());
  const def = { name: "a", displayName: "A", role: "r", model: "m", tools: { shell: false, verbs: ["board", "chats"] } };
  expect(agentDraftPatch(def, agentDraftOf(def))).toEqual({});
  expect(agentDraftPatch(def, { ...agentDraftOf(def), verbs: ["chats", "board"] })).toEqual({});
  expect(agentDraftPatch(def, { ...agentDraftOf(def), model: "", verbs: "all" })).toEqual({ model: null, tools: { shell: false, verbs: "all" } });
  expect(toggleAgentVerb(["board"], "ask", true)).toEqual(["ask", "board"]);
  expect(toggleAgentVerb("all", "ask", false)).toEqual([]);
  expect(agentToolsLabel({ verbs: [] })).toBe("no verbs");
});
