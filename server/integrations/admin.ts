// Settings > Integrations (docs/research/integrations.md §6.1): what the page reads in one GET and
// the writes behind its buttons. Built ONLY on the core (store.ts, the registry, the dispatcher);
// the few queries the core lacked (status, last event, removals, one-row retry, people) are here so
// the core can take them over as they are. Pairing codes are the core's (store.pendingPairings, and
// the /api/integrations/pairing/approve|deny routes the page posts to).
import * as db from "../db";
import { ORCA_SECRETS } from "../env";
import { ACCESS_VALUES, CATCH_ALL, CATCH_ALL_SEND_ERROR, EVENTS_VALUES, integrationAccessRefusal, isAutomatic, leaseHolder, secretRefRefusal, LINK_LEVELS, type Access, type EventsMode, type Level, type LinkLevel, type Subscription, type TargetKind } from "../../shared/integrations";
import {
  identityProblem, integrationProblem, linkProblem,
  type DeadRow, type IntegrationCard, type IntegrationsOverview, type PersonRow,
} from "../../shared/integrationSettings";
import * as registry from "./registry";
import * as router from "./router";
import * as store from "./store";
import * as dispatcher from "./dispatcher";
import * as secretRefs from "./secretRefs";
import type { Connection } from "./adapter";

const user = () => db.currentUser();
type Status = { ok?: boolean; detail?: string; at?: number; startedAt?: number; error?: string | null; lastEventAt?: number; lastPollAt?: number; secretSet?: boolean; secretMissing?: Record<string, number> };

async function statuses(): Promise<Map<string, Status>> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT id, status FROM integration WHERE user_id = ${user()}`;
    return new Map((rows as { id: string; status: Status | null }[]).map((r) => [r.id, r.status ?? {}]));
  });
}

/** The newest event each integration brought in (source.integrationId on the envelope). */
async function lastEvents(): Promise<Map<string, number>> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT envelope->'source'->>'integrationId' AS id, MAX(created_at) AS at FROM event
      WHERE user_id = ${user()} AND envelope->'source'->>'integrationId' IS NOT NULL GROUP BY 1`;
    return new Map((rows as { id: string; at: number }[]).map((r) => [r.id, Number(r.at)]));
  });
}

async function people(): Promise<PersonRow[]> {
  return db.withRetry(async (sql) => {
    const ps = await sql`SELECT id, name, max_level FROM principal WHERE user_id = ${user()} ORDER BY name`;
    const ids = await sql`SELECT adapter, external_id, principal_id, name FROM identity WHERE user_id = ${user()} ORDER BY adapter, external_id`;
    return (ps as { id: string; name: string; max_level: PersonRow["maxLevel"] }[]).map((p) => ({
      id: p.id, name: p.name, maxLevel: p.max_level,
      identities: (ids as { adapter: string; external_id: string; principal_id: string; name: string | null }[]).filter((i) => i.principal_id === p.id)
        .map((i) => ({ adapter: i.adapter, externalId: i.external_id, ...(i.name ? { name: i.name } : {}) })),
    }));
  });
}

async function allSubscriptions(): Promise<Subscription[]> { return store.subscriptions(); }

/** The instance that runs `c` now: its pinned instance, or an Automatic row's lease holder. */
const runner = (c: Connection, now = Date.now()): string | undefined => (isAutomatic(c.instance) ? leaseHolder(c.auto, now) : c.instance);

/** Whether the secret is here: the variable set, each stored secret decryptable. Undefined when the
 *  row runs elsewhere (its env and key are not ours). */
const secretSetHere = (c: Connection, here: string, readable: Set<string>, now = Date.now()): boolean | undefined =>
  runner(c, now) !== here ? undefined : registry.secretHere(c, process.env, readable);
/** The stored secrets this bridge can decrypt, read only when some row names one. */
const readableFor = async (rows: Connection[]): Promise<Set<string>> =>
  rows.some((c) => secretRefs.storedNames(c).length) ? secretRefs.readable().catch(() => new Set<string>()) : new Set<string>();

export async function overview(here = db.instanceName(), now = Date.now()): Promise<IntegrationsOverview> {
  const [rows, st, last, links, persons, pairs, subs, dead, live] = await Promise.all([
    store.integrations(), statuses(), lastEvents(), store.links(), people(), store.pendingPairings(), allSubscriptions(),
    store.deliveries({ state: "dead", limit: 100 }), registry.health(),
  ]);
  const readable = await readableFor(rows);
  const cards: IntegrationCard[] = rows.map((c) => {
    const s = st.get(c.id) ?? {};
    const running = c.id in live;
    const h = running ? { ...live[c.id]!, at: Date.now(), startedAt: s.startedAt } : s.ok === undefined ? undefined
      : { ok: !!s.ok, ...(s.detail ? { detail: s.detail } : {}), ...(s.error ? { error: s.error } : {}), ...(s.at ? { at: s.at } : {}), ...(s.startedAt ? { startedAt: s.startedAt } : {}) };
    const auto = isAutomatic(c.instance);
    const runsOn = runner(c, now);
    // An Automatic row with nobody running it: the instances whose primary lacks its secret.
    const secretMissingOn = auto && !runsOn ? Object.keys(s.secretMissing ?? {}).sort() : [];
    const secretSet = secretSetHere(c, here, readable, now) ?? (auto && !runsOn ? undefined : s.secretSet);
    const lastEventAt = Math.max(last.get(c.id) ?? 0, s.lastEventAt ?? 0) || undefined;
    const lastPollAt = Math.max(live[c.id]?.lastPollAt ?? 0, s.lastPollAt ?? 0) || undefined;
    return {
      id: c.id, kind: c.kind, name: c.name, instance: c.instance, enabled: c.enabled, config: c.config,
      access: c.access ?? "read-write", events: c.events ?? "trigger",
      ...(c.secretRef ? { secretRef: c.secretRef } : {}), ...(secretSet !== undefined ? { secretSet } : {}),
      ...(auto && runsOn ? { runsOn } : {}), ...(secretMissingOn.length ? { secretMissingOn } : {}),
      running, ...(h ? { health: h } : {}), ...(lastEventAt ? { lastEventAt } : {}), ...(lastPollAt ? { lastPollAt } : {}),
    };
  });
  const deadRows: DeadRow[] = dead.map((d) => ({
    id: d.id, eventId: d.eventId, target: d.target, attempts: d.attempts, ...(d.lastError ? { lastError: d.lastError } : {}),
    topic: d.envelope.topic, key: d.envelope.key, ...(d.envelope.title ? { title: d.envelope.title } : {}), at: d.envelope.at,
  }));
  return { instance: here, kinds: registry.kinds(), integrations: cards, links, people: persons, pairings: pairs, subscriptions: subs, dead: deadRows };
}

// ── writes ───────────────────────────────────────────────────────────────────────────────────────

export class AdminError extends Error {}
const fail = (msg: string): never => { throw new AdminError(msg); };

/** Connect (or edit) one integration. The secret is a variable NAME; the value never reaches here. */
export async function saveIntegration(b: Record<string, unknown>): Promise<void> {
  const c = {
    id: String(b.id ?? "").trim(), kind: String(b.kind ?? ""), name: String(b.name ?? "").trim(), instance: String(b.instance ?? "").trim(),
    // An empty secret field takes the kind's default variable (Cloudflare: ORCA_SECRET_CLOUDFLARE).
    secretRef: typeof b.secretRef === "string" && b.secretRef.trim() ? b.secretRef.trim() : registry.meta(String(b.kind ?? ""))?.secretDefault,
    config: b.config && typeof b.config === "object" ? Object.fromEntries(Object.entries(b.config as Record<string, unknown>).filter(([, v]) => v !== "" && v != null)) : {},
    enabled: b.enabled !== false,
    // Absent keeps the stored policy (a new row gets the defaults: read-write, trigger).
    ...policyOf(b),
  };
  const problem = integrationProblem(c, registry.kinds().map((k) => k.kind), ORCA_SECRETS);
  if (problem) fail(problem);
  const isNew = !(await store.integration(c.id));
  await store.addIntegration(c);
  if (isNew) await registry.onConnect(c);
  await registry.sync().catch(() => {});
}

/** An account's access and events from a body (docs/integrations/POLICY.md): each one only when set. */
function policyOf(b: Record<string, unknown>): { access?: Access; events?: EventsMode } {
  if (b.access !== undefined && !(ACCESS_VALUES as readonly unknown[]).includes(b.access)) fail(`access: ${ACCESS_VALUES.join(" or ")}`);
  if (b.events !== undefined && !(EVENTS_VALUES as readonly unknown[]).includes(b.events)) fail(`events: ${EVENTS_VALUES.join(", ")}`);
  return { ...(b.access !== undefined ? { access: b.access as Access } : {}), ...(b.events !== undefined ? { events: b.events as EventsMode } : {}) };
}

/** The card's Access and Events selects: set one or both. The core reads them per call, so the
 *  change applies at once (no adapter restart). */
export async function setPolicy(b: Record<string, unknown>): Promise<void> {
  const p = policyOf(b);
  if (!p.access && !p.events) fail("name access or events");
  if (!(await store.setPolicy(String(b.id ?? ""), p))) fail(`no integration ${String(b.id ?? "")}`);
}

/** Disconnect = the switch off: the row stays, its links and people stay, the adapter stops. */
export async function setEnabled(id: string, on: boolean): Promise<void> {
  const c = (await store.integration(id)) ?? fail(`no integration ${id}`);
  await store.addIntegration({ ...c, enabled: on });
  await registry.sync().catch(() => {});
}

/** Remove the row, its links and the subscriptions that post to them. Events and deliveries stay. */
export async function removeIntegration(id: string): Promise<void> {
  await db.withRetry(async (sql) => {
    await sql.begin(async (tx: Bun.SQL) => {
      const ls = await tx`DELETE FROM channel_link WHERE user_id = ${user()} AND integration_id = ${id} RETURNING id`;
      const ids = (ls as { id: string }[]).map((l) => l.id);
      if (ids.length) await tx`DELETE FROM subscription WHERE user_id = ${user()} AND target_kind = 'link' AND target_id IN ${tx(ids)}`;
      await tx`DELETE FROM integration_cursor WHERE user_id = ${user()} AND integration_id = ${id}`;
      await tx`DELETE FROM integration WHERE user_id = ${user()} AND id = ${id}`;
    });
  });
  await registry.sync().catch(() => {});
}

export async function saveLink(b: Record<string, unknown>): Promise<void> {
  const l = {
    id: String(b.id ?? "").trim(), integrationId: String(b.integrationId ?? ""), externalId: String(b.externalId ?? "").trim(),
    label: typeof b.label === "string" && b.label.trim() ? b.label.trim() : undefined,
    level: String(b.level ?? "") as Exclude<Level, "full">,
    repos: Array.isArray(b.repos) ? b.repos.map(String).filter(Boolean) : [], requireMention: b.requireMention !== false,
    // Absent keeps the stored value, so an edit that does not name it never turns pairing back on.
    // A switch a save omits keeps its stored value (on for a new link), so an edit never flips one back.
    ...await switches(b),
  };
  const problem = linkProblem(l);
  if (problem) fail(problem);
  if (!(await store.integration(l.integrationId))) fail(`no integration ${l.integrationId}`);
  await store.addLink(l);
}

export async function removeLink(id: string): Promise<void> {
  await db.withRetry(async (sql) => {
    await sql.begin(async (tx: Bun.SQL) => {
      await tx`DELETE FROM subscription WHERE user_id = ${user()} AND target_kind = 'link' AND target_id = ${id}`;
      await tx`DELETE FROM channel_link WHERE user_id = ${user()} AND id = ${id}`;
    });
  });
}

/** A link's Notify me / Notify agent from a save: a boolean, else the stored value, else on. */
async function switches(b: Record<string, unknown>): Promise<{ notifyMe: boolean; notifyAgent: boolean }> {
  for (const k of ["notifyMe", "notifyAgent"]) if (b[k] !== undefined && typeof b[k] !== "boolean") fail(`${k}: true or false`);
  const stored = await store.link(String(b.id ?? "").trim());
  return {
    notifyMe: typeof b.notifyMe === "boolean" ? b.notifyMe : stored?.notifyMe ?? true,
    notifyAgent: typeof b.notifyAgent === "boolean" ? b.notifyAgent : stored?.notifyAgent ?? true,
  };
}

const LEVEL_OK = (l: unknown): l is LinkLevel => (LINK_LEVELS as readonly unknown[]).includes(l);

export async function savePerson(b: Record<string, unknown>): Promise<void> {
  const id = String(b.id ?? "").trim(), name = String(b.name ?? "").trim();
  if (!id || !name) fail("a person needs an id and a name");
  if (!LEVEL_OK(b.maxLevel)) fail("max level: notify, ask, work or admin");
  await store.addPrincipal({ id, name, maxLevel: b.maxLevel as LinkLevel });
}

/** Remove a person and every identity paired to them: their messages are dropped again. */
export async function removePerson(id: string): Promise<void> {
  await db.withRetry(async (sql) => {
    await sql.begin(async (tx: Bun.SQL) => {
      await tx`DELETE FROM identity WHERE user_id = ${user()} AND principal_id = ${id}`;
      await tx`DELETE FROM principal WHERE user_id = ${user()} AND id = ${id}`;
    });
  });
}

/** Add identity: bind a platform id to a person by hand, as an approved pairing does. */
export async function addIdentity(b: Record<string, unknown>): Promise<void> {
  const i = { principal: String(b.principal ?? "").trim(), adapter: String(b.adapter ?? "").trim(), externalId: String(b.externalId ?? "").trim() };
  const problem = identityProblem(i, registry.kinds().map((k) => k.kind));
  if (problem) fail(problem);
  if (!(await store.principal(i.principal))) fail(`no person ${i.principal}`);
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().replace(/^@/, "") : undefined;
  await store.addIdentity(i.principal, { adapter: i.adapter, externalId: i.externalId, ...(name ? { name } : {}) });
}

export async function removeIdentity(adapter: string, externalId: string): Promise<void> {
  await db.withRetry(async (sql) => { await sql`DELETE FROM identity WHERE user_id = ${user()} AND adapter = ${adapter} AND external_id = ${externalId}`; });
}

export async function addSubscription(b: Record<string, unknown>): Promise<number> {
  const topicPattern = String(b.topicPattern ?? "").trim();
  const targetKind = String(b.targetKind ?? "") as TargetKind;
  if (!/^[a-z*][a-z0-9_.*]*$/.test(topicPattern)) fail("topic pattern: dot segments, * for one, e.g. orca.pr.*");
  if (!["link", "orchestrator", "workstream", "web"].includes(targetKind)) fail("target: link, orchestrator, workstream or web");
  const targetId = typeof b.targetId === "string" && b.targetId ? b.targetId : undefined;
  const target = targetKind === "link" && targetId ? await store.link(targetId) : undefined;
  if (targetKind === "link" && !target) fail("pick a link");
  if (target?.externalId === CATCH_ALL) fail(CATCH_ALL_SEND_ERROR);
  if (targetKind === "workstream" && !/^[^:]+::.+$/.test(targetId ?? "")) fail("workstream target: repo::branch");
  const filter = b.filter && typeof b.filter === "object" ? Object.fromEntries(Object.entries(b.filter as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {};
  const digestSeconds = Number(b.digestSeconds) > 0 ? Math.round(Number(b.digestSeconds)) : undefined;
  return store.addSubscription({ topicPattern, filter, targetKind, ...(targetId ? { targetId } : {}), ...(digestSeconds ? { digestSeconds } : {}) });
}

/** One dead delivery back to pending (its own Retry). `id` absent = every dead one (Retry all). */
export async function retry(id?: number, now = Date.now()): Promise<number> {
  const n = id === undefined ? await store.retryDead(now) : await db.withRetry(async (sql) =>
    (await sql`UPDATE delivery SET state = 'pending', attempts = 0, next_at = ${now} WHERE user_id = ${user()} AND id = ${id} AND state = 'dead' RETURNING id`).length);
  if (n) dispatcher.kick();
  return n;
}

// ── Test ─────────────────────────────────────────────────────────────────────────────────────────

/** The card's Test: the adapter's live check, on the instance that runs it (the caller forwards
 *  there). Recorded on the status row, with whether the secret is set, so every instance sees it. */
export async function testIntegration(id: string, here = db.instanceName()): Promise<{ ok: boolean; detail?: string }> {
  const c = (await store.integration(id)) ?? fail(`no integration ${id}`);
  const on = runner(c);
  if (on && on !== here) fail(`${id} runs on ${on}`);
  const secretSet = secretSetHere(c, here, await readableFor([c]));
  const refusal = secretRefRefusal(c.secretRef, ORCA_SECRETS);
  const running = registry.adapterFor(id);
  const r = refusal ? { ok: false, detail: refusal }
    : !c.enabled ? { ok: false, detail: "disconnected" }
    : running ? await running.health().catch((e) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }))
    : { ok: false, detail: "not running on this instance's primary bridge" };
  await store.setIntegrationStatus(id, { ok: r.ok, detail: r.detail ?? null, error: r.ok ? null : r.detail ?? "failed", at: Date.now(), secretSet: !!secretSet });
  return { ok: r.ok, ...(r.detail ? { detail: r.detail } : {}) };
}

export const TEST_WAIT_MS = 8_000;

/** A link's Test: "Orca test message" through the real delivery path — one event and one delivery
 *  to that link, sent by the dispatcher on the link's instance. Waits a few seconds for the outcome;
 *  a slow one answers `pending` (the dead list shows it later if it fails for good). */
export async function testLink(linkId: string, opts: { waitMs?: number; now?: number } = {}): Promise<{ state: string; error?: string; deliveryId?: number }> {
  const l = (await store.link(linkId)) ?? fail(`no link ${linkId}`);
  if (l.externalId === CATCH_ALL) fail(CATCH_ALL_SEND_ERROR);
  const c = (await store.integration(l.integrationId)) ?? fail(`no integration ${l.integrationId}`);
  const denied = integrationAccessRefusal(c, "send");
  if (denied) fail(denied);
  const now = opts.now ?? Date.now();
  const e = {
    id: router.newEventId(now), key: `test:${linkId}:${now}`, topic: "orca.integration.test" as const, at: now,
    source: { adapter: "orca" }, title: "Orca test message", text: `Orca test message for ${l.label ?? l.externalId} (${c.name}).`,
  };
  const r = await store.recordEvent(e, [{ subscriptionId: null, target: { kind: "link", integrationId: c.id, adapter: c.kind, linkId, externalId: l.externalId } }], now);
  const deliveryId = r.deliveries[0];
  if (deliveryId === undefined) fail("the test delivery was not recorded");
  dispatcher.kick();
  const until = Date.now() + (opts.waitMs ?? TEST_WAIT_MS);
  for (;;) {
    const d = await db.withRetry(async (sql) => (await sql`SELECT state, last_error FROM delivery WHERE user_id = ${user()} AND id = ${deliveryId}`)[0] as { state: string; last_error: string | null } | undefined);
    if (d && (d.state === "sent" || d.state === "dead" || (d.state === "failed" && d.last_error))) return { state: d.state, ...(d.last_error ? { error: d.last_error } : {}), deliveryId };
    if (Date.now() >= until) return { state: "pending", deliveryId };
    await Bun.sleep(250);
  }
}

/** Every POST the page makes, by path. Returns undefined for a path that is not the page's. */
export async function route(p: string, b: Record<string, unknown>): Promise<unknown | undefined> {
  switch (p) {
    case "/api/integrations/save": await saveIntegration(b); return { ok: true };
    case "/api/integrations/policy": await setPolicy(b); return { ok: true };
    case "/api/integrations/enabled": await setEnabled(String(b.id), b.on === true); return { ok: true };
    case "/api/integrations/remove": await removeIntegration(String(b.id)); return { ok: true };
    case "/api/integrations/links/save": await saveLink(b); return { ok: true };
    case "/api/integrations/links/remove": await removeLink(String(b.id)); return { ok: true };
    case "/api/integrations/links/test": return testLink(String(b.id));
    case "/api/integrations/people/save": await savePerson(b); return { ok: true };
    case "/api/integrations/people/remove": await removePerson(String(b.id)); return { ok: true };
    case "/api/integrations/identities/add": await addIdentity(b); return { ok: true };
    case "/api/integrations/identities/remove": await removeIdentity(String(b.adapter), String(b.externalId)); return { ok: true };
    case "/api/integrations/subscriptions/add": return { ok: true, id: await addSubscription(b) };
    case "/api/integrations/subscriptions/remove": await store.removeSubscription(Number(b.id)); return { ok: true };
    case "/api/integrations/deliveries/retry": return { ok: true, retried: await retry(b.id === undefined ? undefined : Number(b.id)) };
    default: return undefined;
  }
}
