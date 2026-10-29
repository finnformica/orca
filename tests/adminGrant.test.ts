// The admin rule (Finn 2026-10-29: "ALL admins should have the same power"): a channel message from a
// person whose max level is `admin` acts with the owner's full power, as in the owner's own Orca chat:
// every repo, every verb, no scoped mode. A person below admin (work, ask, notify) keeps the link's
// level and repos; a stranger still gets `notify`. Real Postgres, the real gate (router.ingest), the
// inbox and the orchestrator's queue and `orca` tool; `claude` is a fake. A stored secret value never
// leaves in a channel post: tests/secrets.test.ts proves the dispatcher's scrub.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as orchestrator from "../server/orchestrator";
import * as store from "../server/integrations/store";
import * as router from "../server/integrations/router";
import * as inbox from "../server/integrations/inbox";
import type { OrcaConfig } from "../server/config";
import { CHIEF } from "../shared/agents";
import { adminGrant, effectiveGrant, fenceExternal, grantRefusal, inboundEnvelope, type Envelope } from "../shared/integrations";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO } from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, setPrListFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

const LINK = { id: "discord-all", level: "admin" as const, repos: ["site-templates"] };

test("A1 (pure): an admin person gets full on any link; a work person keeps the link's repos; a stranger gets notify", () => {
  const admin = effectiveGrant(LINK, { id: "finn", maxLevel: "admin" });
  expect(admin).toEqual({ level: "full", repos: [], linkId: "discord-all", principalId: "finn" });
  expect(adminGrant(admin)).toBe(true);
  expect(grantRefusal(admin, "spawn", { repo: "bryans-motorcycle-school" })).toBeUndefined();
  expect(grantRefusal(admin, "notes", { _: ["set", "x"] })).toBeUndefined(); // the owner's chat power
  // The link's own level does not cap an admin person.
  expect(effectiveGrant({ ...LINK, level: "ask" }, { id: "saajan", maxLevel: "admin" }).level).toBe("full");
  // A person below admin: min(link, person) on the link's repos, as before.
  const work = effectiveGrant(LINK, { id: "ana", maxLevel: "work" });
  expect(work).toEqual({ level: "work", repos: ["site-templates"], linkId: "discord-all", principalId: "ana" });
  expect(adminGrant(work)).toBe(false);
  expect(grantRefusal(work, "spawn", { repo: "bryans-motorcycle-school" })).toContain("outside it");
  expect(grantRefusal(work, "spawn", { repo: "site-templates" })).toBeUndefined();
  expect(effectiveGrant(LINK, { id: "vi", maxLevel: "ask" }).level).toBe("ask");
  // A stranger: read-only.
  expect(effectiveGrant(LINK, undefined).level).toBe("notify");
  // The wake header names the admin and the full grant, and keeps secret values out of the reply.
  const e = { text: "work on bryans", source: { adapter: "discord", linkId: "discord-all" }, actor: { external: { adapter: "discord", id: "587", name: "sol1589" } }, grant: admin } as Envelope;
  const head = fenceExternal(e);
  expect(head).toContain("from the admin discord:587 (sol1589) · grant: full (an admin: every repo and every verb, as in the owner's own Orca chat)");
  expect(head).toContain("Never put a secret value in a channel reply");
  expect(head).not.toContain("Act only within its grant");
  expect(fenceExternal({ ...e, grant: work })).toContain("grant: work on site-templates");
});

let state: string, shim: string, repo: string, worktrees: string, hold: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};

const cfg = (): OrcaConfig => ({
  repos: ["site-templates", "bryans-motorcycle-school"].map((name) => ({ name, repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude" as const] })),
  portRange: [30000, 40000], staleHours: 24,
});

beforeEach(async () => {
  prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_FAKE_HOLD"].map((k) => [k, process.env[k]]));
  [state, shim, worktrees] = await Promise.all(["state", "claude", "wt"].map(async (n) => realpathSync(await mkdtemp(join(tmpdir(), `orca-owner-${n}-`))))) as [string, string, string];
  repo = await makeScratchRepo();
  hold = join(state, "hold");
  process.env.ORCA_STATE_DIR = state;
  process.env.ORCA_FAKE_HOLD = hold;
  process.env.PATH = `${shim}:${prev.PATH}`;
  await installFakeGh();
  await setPrListFixture([]);
  // A fake claude: waits while the hold file exists, then answers.
  await writeFile(join(shim, "claude"), `#!/bin/sh
while [ -f "$ORCA_FAKE_HOLD" ]; do sleep 0.02; done
printf '{"type":"result","subtype":"success","result":"## Outcome\\\\nDone.","is_error":false}'
`);
  await chmod(join(shim, "claude"), 0o755);
  pg = await freshSchema("ownergrant");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  router.resetPace();
});
afterEach(async () => {
  await rm(hold, { force: true });
  for (let i = 0; i < 200 && agent.isRunning(orchestrator.dir(CHIEF)); i++) await new Promise((r) => setTimeout(r, 25));
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, repo, worktrees]) await rm(d, { recursive: true, force: true });
});

const fromDiscord = (id: string, author: string, text: string, at: number) =>
  inboundEnvelope({ adapter: "discord", channel: "C1", eventId: id, from: { adapter: "discord", id: author }, text, at });

test("A2: admins Finn and Saajan can spawn outside the link's repos from Discord; a work person cannot; a stranger gets nothing", async () => {
  const c = cfg();
  await store.addIntegration({ id: "discord", kind: "discord", name: "Discord", instance: "local", config: {}, secretRef: "ORCA_SECRET_DISCORD", enabled: true });
  await store.addLink({ id: "discord-all", integrationId: "discord", externalId: "*", label: "Discord (all)", level: "admin", repos: ["site-templates"], requireMention: false });
  await store.addPrincipal({ id: "finn", name: "Finn", maxLevel: "admin" }, [{ adapter: "discord", externalId: "587649244719087646" }]);
  await store.addPrincipal({ id: "saajan", name: "Saajan", maxLevel: "admin" }, [{ adapter: "discord", externalId: "U-saajan" }]);
  await store.addPrincipal({ id: "ana", name: "Ana", maxLevel: "work" }, [{ adapter: "discord", externalId: "U-ana" }]);

  const ask = "Start work on bryans-motorcycle-school";
  expect(await router.ingest("discord", fromDiscord("M1", "587649244719087646", ask, 1_000), 1_000)).toBe("new");
  expect(await router.ingest("discord", fromDiscord("M2", "U-saajan", ask, 2_000), 2_000)).toBe("new");
  expect(await router.ingest("discord", fromDiscord("M3", "U-ana", ask, 3_000), 3_000)).toBe("new");
  expect(await router.ingest("discord", fromDiscord("M4", "U-stranger", ask, 4_000), 4_000)).toBe("noted");
  const [finn, saajan, ana] = await Promise.all(["M1", "M2", "M3"].map(async (id) => (await store.event(`discord:${id}`))!));
  expect(finn!.grant).toMatchObject({ level: "full", principalId: "finn" });
  expect(saajan!.grant).toMatchObject({ level: "full", principalId: "saajan" });
  expect(ana!.grant).toMatchObject({ level: "work", repos: ["site-templates"], principalId: "ana" });
  expect((await store.event("discord:M4"))!.grant).toMatchObject({ level: "notify" });

  // The Chief of Staff is busy, so each message queues with the grant its wake will run under.
  await writeFile(hold, "");
  await orchestrator.message(c, "busy", []);
  for (const e of [finn!, saajan!, ana!]) expect(await inbox.toAgent(c, CHIEF, e)).toEqual({ ok: true });
  const queued = await db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH);
  const row = (id: string) => queued.find((m) => m.instruction.includes(id))!;
  // An admin's wake is the owner's own chat: no grant, so no scoped mode and a shell. The reply target stays.
  for (const id of ["discord:587649244719087646", "discord:U-saajan"]) {
    expect(row(id).grant).toBeUndefined();
    expect(row(id).replyTo).toMatchObject({ linkId: "discord-all" });
    expect(row(id).instruction).toContain("grant: full (an admin");
  }
  expect(row("discord:U-ana").grant).toMatchObject({ level: "work", repos: ["site-templates"] });

  // `orca spawn` under each wake's grant (as wake() stores it before the launch). An admin's passes
  // the grant check and stops only at the brief; the work person's is refused as outside the link's repos.
  const spawn = { repo: "bryans-motorcycle-school", model: "claude-sonnet-5-5" };
  const under = async (grant: unknown) => {
    await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakeGrant: (grant ?? null) as never });
    return orchestrator.tool(c, "spawn", spawn).then(() => "", (e: Error) => e.message);
  };
  for (const id of ["discord:587649244719087646", "discord:U-saajan"]) {
    const err = await under(row(id).grant);
    expect(err).not.toContain("outside sender");
    expect(err).toContain("brief");
  }
  expect(await under(row("discord:U-ana").grant)).toContain("outside it");
  await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakeGrant: null as never });
  await rm(hold, { force: true });
});
