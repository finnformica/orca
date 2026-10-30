// One queued message per non-user sender (server/db.ts `queueMessage` with `replace`): an agent's or
// Orca's second message while its first is still undispatched replaces that one, in its place in the
// queue. The user's messages are never touched, and a user may queue any number. Real Postgres: the
// replace is one transaction under the queue's advisory lock, and the races below run against it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as db from "../server/db";
import { autofixInstruction, backgroundResumeInstruction } from "../shared/agent";
import { agentSide, orcaSide, queueListText } from "../shared/rooms";
import { freshSchema, type TestDb } from "./pg";

let pg: TestDb;
let prevUrl: string | undefined;
beforeEach(async () => {
  prevUrl = process.env.ORCA_DATABASE_URL;
  pg = await freshSchema("queuereplace");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await db.close();
  await pg.drop();
  if (prevUrl === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prevUrl;
});

const base = { repo: "r", branch: "b", worktreePath: "/wt/b", attachments: [] as string[] };
const chief = agentSide("chief");
/** What an agent's `orca send` queues (verbs.followUp): its sender, with replace on. */
const agentSend = (instruction: string, sender = chief) => db.queueMessage({ ...base, instruction, sender }, { replace: true });
/** What the chat composer queues (/api/agent): no sender, no replace. */
const userSend = (instruction: string) => db.queueMessage({ ...base, instruction });
const pending = async () => (await db.queuedMessages("r", "b")).map((m) => m.instruction);

test("QR1: an agent's second queued message replaces its first and keeps its place", async () => {
  const first = await agentSend("Add the TTL");
  const user = await userSend("typed in the chat");
  const second = await agentSend("Add the TTL and its tests");
  expect(second.replaces).toBe(first.id);
  const rows = await db.queuedMessages("r", "b");
  expect(rows.map((m) => m.id)).toEqual([second.id, user.id]);
  expect(rows[0]).toMatchObject({ instruction: "Add the TTL and its tests", replaces: first.id, sender: chief });
  // The old row is not lost: it is kept, marked dispatched with the id of its replacement.
  const old = await db.queuedMessageById(first.id);
  expect(old).toMatchObject({ instruction: "Add the TTL", replacedBy: second.id, sender: chief });
  expect(old?.dispatchedAt).toBeNumber();
  // The dispatcher sends the replacement first, in the old message's place.
  expect((await db.claimQueuedMessage("r", "b"))?.id).toBe(second.id);
  expect((await db.claimQueuedMessage("r", "b"))?.id).toBe(user.id);
  expect(await db.claimQueuedMessage("r", "b")).toBeUndefined();
  // orca queue shows it.
  expect(queueListText("r/b", [{ ...rows[0]!, createdAt: Date.UTC(2026, 9, 29, 9) }], chief).split("\n")[1])
    .toBe(`  #${second.id}  2026-10-29 09:00 UTC  agent chief (you)  (replaced #${first.id})  Add the TTL and its tests`);
});

test("QR2: user messages between two agent sends stay in order and untouched", async () => {
  const u1 = await userSend("user one");
  const a1 = await agentSend("agent v1");
  const u2 = await userSend("user two");
  const a2 = await agentSend("agent v2");
  const u3 = await userSend("user three");
  const a3 = await agentSend("agent v3");
  expect(a3.replaces).toBe(a2.id);
  expect(a2.replaces).toBe(a1.id);
  const rows = await db.queuedMessages("r", "b");
  expect(rows.map((m) => m.id)).toEqual([u1.id, a3.id, u2.id, u3.id]);
  expect(rows.map((m) => m.instruction)).toEqual(["user one", "agent v3", "user two", "user three"]);
  // The user's rows are the same rows, with no replace mark.
  for (const u of [u1, u2, u3]) expect(await db.queuedMessageById(u.id)).not.toHaveProperty("replacedBy");
});

test("QR3: a user's messages are never replaced, and never replace", async () => {
  await userSend("one");
  await userSend("two");
  // Even with replace asked for, a person's message (no sender, no origin, no Orca marker) queues.
  const three = await db.queueMessage({ ...base, instruction: "three" }, { replace: true });
  expect(three.replaces).toBeUndefined();
  // An agent's message does not replace a user's.
  const a = await agentSend("from chief");
  expect(a.replaces).toBeUndefined();
  expect(await pending()).toEqual(["one", "two", "three", "from chief"]);
});

test("QR4: a message dispatched in between is not replaced; the new one queues normally", async () => {
  const a1 = await agentSend("agent v1");
  const user = await userSend("typed");
  expect((await db.claimQueuedMessage("r", "b"))?.id).toBe(a1.id); // a run took it
  const a2 = await agentSend("agent v2");
  expect(a2.replaces).toBeUndefined();
  expect((await db.queuedMessages("r", "b")).map((m) => m.id)).toEqual([user.id, a2.id]);
  expect(await db.queuedMessageById(a1.id)).not.toHaveProperty("replacedBy");
});

test("QR5: concurrent agent sends end as one queued message, and a claim racing a replace sends each text at most once", async () => {
  const sent = await Promise.all(["v1", "v2", "v3", "v4", "v5"].map((t) => agentSend(t)));
  const rows = await db.queuedMessages("r", "b");
  expect(rows.length).toBe(1);
  // Every other one is kept as a replaced row, and the replace chain names each exactly once.
  const replaced = sent.filter((m) => m.id !== rows[0]!.id);
  for (const m of replaced) expect((await db.queuedMessageById(m.id))?.replacedBy).toBeNumber();
  expect(new Set(sent.map((m) => m.replaces).filter(Boolean)).size).toBe(4);

  // A claim and a replace at once: either the claim took the old row (and the new one queues on its
  // own) or the replace went first (and the claim takes the replacement). Never a replaced row sent.
  for (let i = 0; i < 5; i++) {
    if (!(await db.queuedMessages("r", "b")).length) await agentSend(`seed ${i}`);
    const [claimed, made] = await Promise.all([db.claimQueuedMessage("r", "b"), agentSend(`race ${i}`)]);
    expect(claimed).toBeDefined();
    expect(claimed).not.toHaveProperty("replacedBy");
    const left = await db.queuedMessages("r", "b");
    if (made.replaces === claimed!.id) throw new Error("replaced a message that was claimed");
    expect(left.map((m) => m.id)).toEqual(made.id === claimed!.id ? [] : [made.id]);
  }
});

test("QR6: different agents each keep one queued message", async () => {
  await agentSend("chief v1");
  await agentSend("assistant v1", agentSide("assistant"));
  await agentSend("chief v2");
  await agentSend("assistant v2", agentSide("assistant"));
  await db.queueMessage({ ...base, instruction: "Address the PR: conflicts, CI, review", sender: orcaSide("upkeep") }, { replace: true });
  expect(await pending()).toEqual(["chief v2", "assistant v2", "Address the PR: conflicts, CI, review"]);
});

test("QR7: Orca's identical automated nudges collapse into one; each kind keeps its own", async () => {
  const check = { command: "bun run check", ok: false, exitCode: 1, output: "1 fail", durationMs: 5 };
  // What server/agent.ts queues after a failed check: no sender, the autofix marker, replace on.
  const f1 = await db.queueMessage({ ...base, instruction: autofixInstruction(check) }, { replace: true });
  const user = await userSend("typed");
  const f2 = await db.queueMessage({ ...base, instruction: autofixInstruction({ ...check, output: "2 fail" }) }, { replace: true });
  const bg = await db.queueMessage({ ...base, instruction: backgroundResumeInstruction([{ id: "t1", command: "bun test" }], "exit", 30) }, { replace: true });
  expect(f2.replaces).toBe(f1.id);
  expect(bg.replaces).toBeUndefined();
  const rows = await db.queuedMessages("r", "b");
  expect(rows.map((m) => m.id)).toEqual([f2.id, user.id, bg.id]);
  expect(rows[0]!.instruction).toContain("2 fail");
  // An autofix from the agent's own send is the agent's, not Orca's: it does not take Orca's place.
  const a = await agentSend("chief's own message");
  expect(a.replaces).toBeUndefined();
});
