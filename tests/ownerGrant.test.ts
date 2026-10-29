// The owner rule (Finn 2026-10-29): a channel message from the OWNER's own person (the app config's
// `ownerPrincipal`, set only in Settings > People) acts with the owner's full power, as in their own
// Orca chat: every repo, every verb, no scoped mode. Every other person, admin included, keeps the
// link's level and repos; a stranger still gets `notify`. Real Postgres, the real gate
// (router.ingest), the inbox and the orchestrator's queue and `orca` tool; `claude` is a fake.
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
import { removePerson } from "../server/integrations/admin";
import { configDocument, invalidateConfig, loadConfig, parseConfigDocument, saveConfigDocument, setOwnerPrincipal, type OrcaConfig } from "../server/config";
import { CHIEF } from "../shared/agents";
import { effectiveGrant, fenceExternal, grantRefusal, inboundEnvelope, ownerGrant, type Envelope } from "../shared/integrations";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO } from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, setPrListFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

const LINK = { id: "discord-all", level: "admin" as const, repos: ["site-templates"] };

test("O1 (pure): the owner's person gets full on any link; an admin keeps the link's repos; a stranger gets notify", () => {
  const owner = effectiveGrant(LINK, { id: "finn", maxLevel: "admin" }, "finn");
  expect(owner).toEqual({ level: "full", repos: [], linkId: "discord-all", principalId: "finn" });
  expect(ownerGrant(owner)).toBe(true);
  expect(grantRefusal(owner, "spawn", { repo: "bryans-motorcycle-school" })).toBeUndefined();
  expect(grantRefusal(owner, "notes", { _: ["set", "x"] })).toBeUndefined(); // the owner's chat power
  // A link at a low level does not cap the owner either.
  expect(effectiveGrant({ ...LINK, level: "ask" }, { id: "finn", maxLevel: "ask" }, "finn").level).toBe("full");
  // Another admin: min(link, person) on the link's repos, as before.
  const admin = effectiveGrant(LINK, { id: "saajan", maxLevel: "admin" }, "finn");
  expect(admin).toEqual({ level: "admin", repos: ["site-templates"], linkId: "discord-all", principalId: "saajan" });
  expect(ownerGrant(admin)).toBe(false);
  expect(grantRefusal(admin, "spawn", { repo: "bryans-motorcycle-school" })).toContain("outside it");
  expect(grantRefusal(admin, "notes", { _: ["set", "x"] })).toContain("full grant");
  // No owner set: nobody is widened.
  expect(effectiveGrant(LINK, { id: "finn", maxLevel: "admin" }).level).toBe("admin");
  // A stranger: read-only.
  expect(effectiveGrant(LINK, undefined, "finn").level).toBe("notify");
  // The wake header names the owner and the full grant.
  const e = { text: "work on bryans", source: { adapter: "discord", linkId: "discord-all" }, actor: { external: { adapter: "discord", id: "587", name: "sol1589" } }, grant: owner } as Envelope;
  const head = fenceExternal(e);
  expect(head).toContain("from the owner discord:587 (sol1589) · grant: full (the Orca owner: every repo and every verb, as in their own Orca chat)");
  expect(head).toContain("act on it as on a message in their own Orca chat");
  expect(head).not.toContain("Act only within its grant");
  expect(fenceExternal({ ...e, grant: admin })).toContain("grant: admin on site-templates");
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
  invalidateConfig();
  router.resetPace();
});
afterEach(async () => {
  await rm(hold, { force: true });
  for (let i = 0; i < 200 && agent.isRunning(orchestrator.dir(CHIEF)); i++) await new Promise((r) => setTimeout(r, 25));
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  invalidateConfig();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, repo, worktrees]) await rm(d, { recursive: true, force: true });
});

const fromDiscord = (id: string, author: string, text: string, at: number) =>
  inboundEnvelope({ adapter: "discord", channel: "C1", eventId: id, from: { adapter: "discord", id: author }, text, at });

test("O2: the owner's Discord message can spawn on a repo outside the link; a non-owner admin cannot; a stranger gets nothing", async () => {
  const c = cfg();
  await saveConfigDocument(parseConfigDocument({ ...c, repos: c.repos }).config!);
  await store.addIntegration({ id: "discord", kind: "discord", name: "Discord", instance: "local", config: {}, secretRef: "ORCA_SECRET_DISCORD", enabled: true });
  await store.addLink({ id: "discord-all", integrationId: "discord", externalId: "*", label: "Discord (all)", level: "admin", repos: ["site-templates"], requireMention: false });
  await store.addPrincipal({ id: "finn", name: "Finn", maxLevel: "admin" }, [{ adapter: "discord", externalId: "587649244719087646" }]);
  await store.addPrincipal({ id: "saajan", name: "Saajan", maxLevel: "admin" }, [{ adapter: "discord", externalId: "U-saajan" }]);
  // Only Settings > People sets the owner (the app config's ownerPrincipal).
  await setOwnerPrincipal("finn");
  expect((await loadConfig()).ownerPrincipal).toBe("finn");

  expect(await router.ingest("discord", fromDiscord("M1", "587649244719087646", "Start work on bryans-motorcycle-school", 1_000), 1_000)).toBe("new");
  expect(await router.ingest("discord", fromDiscord("M2", "U-saajan", "Start work on bryans-motorcycle-school", 2_000), 2_000)).toBe("new");
  expect(await router.ingest("discord", fromDiscord("M3", "U-stranger", "Start work on bryans-motorcycle-school", 3_000), 3_000)).toBe("noted");
  const owner = (await store.event("discord:M1"))!;
  const admin = (await store.event("discord:M2"))!;
  expect(owner.grant).toMatchObject({ level: "full", principalId: "finn" });
  expect(admin.grant).toMatchObject({ level: "admin", repos: ["site-templates"], principalId: "saajan" });
  expect((await store.event("discord:M3"))!.grant).toMatchObject({ level: "notify" });

  // The Chief of Staff is busy, so each message queues with the grant its wake will run under.
  await writeFile(hold, "");
  await orchestrator.message(c, "busy", []);
  for (const e of [owner, admin]) expect(await inbox.toAgent(c, CHIEF, e)).toEqual({ ok: true });
  const queued = await db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH);
  const [ownerRow, adminRow] = [queued.find((m) => m.instruction.includes("from the owner")), queued.find((m) => !m.instruction.includes("from the owner"))];
  // The owner's wake is the owner's own chat: no grant, so no scoped mode and a shell. The reply target stays.
  expect(ownerRow!.grant).toBeUndefined();
  expect(ownerRow!.replyTo).toMatchObject({ linkId: "discord-all" });
  expect(ownerRow!.instruction).toContain("grant: full (the Orca owner");
  expect(adminRow!.grant).toMatchObject({ level: "admin", repos: ["site-templates"] });

  // `orca spawn` under each wake's grant (as wake() stores it before the launch). The owner's passes
  // the grant check and stops only at the brief; the admin's is refused as outside the link's repos.
  const spawn = { repo: "bryans-motorcycle-school", model: "claude-sonnet-5-5" };
  await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakeGrant: (ownerRow!.grant ?? null) as never });
  const ownerErr = await orchestrator.tool(c, "spawn", spawn).then(() => "", (e: Error) => e.message);
  expect(ownerErr).not.toContain("outside sender");
  expect(ownerErr).toContain("brief");
  await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakeGrant: adminRow!.grant as never });
  await expect(orchestrator.tool(c, "spawn", spawn)).rejects.toThrow(/outside it/);
  await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakeGrant: null as never });
  await rm(hold, { force: true });
});

test("O3: the stored document keeps the owner, and removing the owner's person clears it", async () => {
  const c = cfg();
  await saveConfigDocument(parseConfigDocument({ ...c }).config!);
  await store.addPrincipal({ id: "finn", name: "Finn", maxLevel: "admin" });
  await setOwnerPrincipal("finn");
  // The stored document round-trips it, so every other Settings setter keeps it.
  expect(parseConfigDocument(await configDocument()).config!.ownerPrincipal).toBe("finn");
  expect(parseConfigDocument({ ...c, ownerPrincipal: 7 }).errors).toEqual(["ownerPrincipal must be a person id"]);
  await removePerson("finn");
  invalidateConfig();
  expect((await loadConfig()).ownerPrincipal).toBeUndefined();
});
