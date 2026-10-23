// Every SQL statement of the integrations layer (tables: server/db.ts step 20261017-integrations).
// Through db.withRetry like every other query, so a dropped connection is retried and an outage is
// db.DbUnavailable. Every row carries user_id (db.currentUser()).
import * as db from "../db";
import { AUTO_INSTANCE, digestWindow, PAIRING_TTL_MS, type AutoLease, type DeliveryState, type DeliveryTarget, type Envelope, type Level, type PlannedDelivery, type Subscription, type TargetKind } from "../../shared/integrations";
import type { Connection } from "./adapter";
import type { Notification } from "../../shared/notifications";
import { muteKey, OWN_EVENT, type Conversation, type OutboundRecord, type ThreadLinkRecord } from "../../shared/inbox";

const user = () => db.currentUser();

// ── integration (credentials: a variable NAME only) ─────────────────────────────────────────────

type IntegrationRow = { id: string; kind: string; name: string; instance: string; config: Record<string, unknown> | null; secret_ref: string | null; enabled: boolean; auto: AutoLease | null };
const toConnection = (r: IntegrationRow): Connection => ({
  id: r.id, kind: r.kind, name: r.name, instance: r.instance, config: r.config ?? {},
  ...(r.secret_ref ? { secretRef: r.secret_ref } : {}), enabled: r.enabled,
  ...(r.auto && typeof r.auto.holder === "string" ? { auto: { holder: r.auto.holder, until: Number(r.auto.until) } } : {}),
});

export async function addIntegration(c: Connection): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`
      INSERT INTO integration (id, user_id, kind, name, instance, config, secret_ref, enabled, created_at)
      VALUES (${c.id}, ${user()}, ${c.kind}, ${c.name}, ${c.instance}, ${c.config}, ${c.secretRef ?? null}, ${c.enabled}, ${Date.now()})
      ON CONFLICT (user_id, id) DO UPDATE SET kind = EXCLUDED.kind, name = EXCLUDED.name, instance = EXCLUDED.instance,
        config = EXCLUDED.config, secret_ref = EXCLUDED.secret_ref, enabled = EXCLUDED.enabled`;
  });
}

/** Every integration, or only those an instance may run: its own and the Automatic ones. */
export async function integrations(instance?: string): Promise<Connection[]> {
  return db.withRetry(async (sql) => {
    const rows = instance === undefined
      ? await sql`SELECT id, kind, name, instance, config, secret_ref, enabled, status->'auto' AS auto FROM integration WHERE user_id = ${user()} ORDER BY id`
      : await sql`SELECT id, kind, name, instance, config, secret_ref, enabled, status->'auto' AS auto FROM integration WHERE user_id = ${user()} AND instance IN (${instance}, ${AUTO_INSTANCE}) ORDER BY id`;
    return (rows as IntegrationRow[]).map(toConnection);
  });
}

export async function integration(id: string): Promise<Connection | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT id, kind, name, instance, config, secret_ref, enabled, status->'auto' AS auto FROM integration WHERE user_id = ${user()} AND id = ${id}`;
    const r = (rows as IntegrationRow[])[0];
    return r ? toConnection(r) : undefined;
  });
}

export async function setIntegrationStatus(id: string, status: Record<string, unknown>): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`UPDATE integration SET status = COALESCE(status, '{}'::jsonb) || ${status}::jsonb WHERE user_id = ${user()} AND id = ${id}`;
  });
}

/** Take or renew an Automatic row's lease for `here`: only when no lease is live or it is already
 *  `here`'s (`shared/integrations.ts` mayClaim, done in one UPDATE so two primaries cannot both win).
 *  Answers the lease that stands after the attempt — `here`'s, or the other holder's. */
export async function claimAuto(id: string, here: string, now: number, ttlMs: number): Promise<AutoLease | undefined> {
  return db.withRetry(async (sql) => {
    const lease = { holder: here, until: now + ttlMs };
    const won = await sql`UPDATE integration SET status = COALESCE(status, '{}'::jsonb) || jsonb_build_object('auto', ${lease}::jsonb)
      WHERE user_id = ${user()} AND id = ${id} AND instance = ${AUTO_INSTANCE} AND enabled
        AND (status->'auto' IS NULL OR status->'auto'->>'holder' = ${here} OR (status->'auto'->>'until')::bigint <= ${now})
      RETURNING id`;
    if (won.length) return lease;
    const [r] = await sql`SELECT status->'auto' AS auto FROM integration WHERE user_id = ${user()} AND id = ${id}`;
    const auto = (r as { auto: AutoLease | null } | undefined)?.auto;
    return auto && typeof auto.holder === "string" ? { holder: auto.holder, until: Number(auto.until) } : undefined;
  });
}

/** Give the lease up (shutdown, the row disabled or pinned): the next primary takes it at once. */
export async function releaseAuto(id: string, here: string): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`UPDATE integration SET status = status - 'auto' WHERE user_id = ${user()} AND id = ${id} AND status->'auto'->>'holder' = ${here}`;
  });
}

/** Record whether the secret of an Automatic row is missing on `here` (`status.secretMissing`, one
 *  key per instance), so the page names every instance that lacks it. */
export async function markSecretMissing(id: string, here: string, missing: boolean, now: number): Promise<void> {
  return db.withRetry(async (sql) => {
    await (missing
      ? sql`UPDATE integration SET status = jsonb_set(COALESCE(status, '{}'::jsonb), '{secretMissing}',
          COALESCE(status->'secretMissing', '{}'::jsonb) || jsonb_build_object(${here}::text, ${now}::bigint))
          WHERE user_id = ${user()} AND id = ${id}`
      : sql`UPDATE integration SET status = status #- ARRAY['secretMissing', ${here}::text]
          WHERE user_id = ${user()} AND id = ${id} AND status->'secretMissing'->>${here}::text IS NOT NULL`);
  });
}

// ── channel_link, principal, identity ────────────────────────────────────────────────────────────

export type Link = { id: string; integrationId: string; externalId: string; label?: string; level: Exclude<Level, "full">; repos: string[]; requireMention: boolean;
  /** The link's switches (LinkNotify); absent on a write means on. */
  notifyMe?: boolean; notifyAgent?: boolean };
type LinkRow = { id: string; integration_id: string; external_id: string; label: string | null; level: Link["level"]; repos: string[]; require_mention: boolean; notify_me: boolean | null; notify_agent: boolean | null };
const toLink = (r: LinkRow): Link => ({
  id: r.id, integrationId: r.integration_id, externalId: r.external_id, ...(r.label ? { label: r.label } : {}),
  level: r.level, repos: r.repos ?? [], requireMention: r.require_mention, notifyMe: r.notify_me !== false, notifyAgent: r.notify_agent !== false,
});

export async function addLink(l: Link): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`
      INSERT INTO channel_link (id, user_id, integration_id, external_id, label, level, repos, require_mention, notify_me, notify_agent)
      VALUES (${l.id}, ${user()}, ${l.integrationId}, ${l.externalId}, ${l.label ?? null}, ${l.level}, ${sql.array(l.repos, "TEXT")}, ${l.requireMention}, ${l.notifyMe !== false}, ${l.notifyAgent !== false})
      ON CONFLICT (user_id, id) DO UPDATE SET external_id = EXCLUDED.external_id, label = EXCLUDED.label,
        level = EXCLUDED.level, repos = EXCLUDED.repos, require_mention = EXCLUDED.require_mention,
        notify_me = EXCLUDED.notify_me, notify_agent = EXCLUDED.notify_agent`;
  });
}

export async function links(): Promise<Link[]> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT id, integration_id, external_id, label, level, repos, require_mention, notify_me, notify_agent FROM channel_link WHERE user_id = ${user()}`;
    return (rows as LinkRow[]).map(toLink);
  });
}

export async function link(id: string): Promise<Link | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT id, integration_id, external_id, label, level, repos, require_mention, notify_me, notify_agent FROM channel_link WHERE user_id = ${user()} AND id = ${id}`;
    const r = (rows as LinkRow[])[0];
    return r ? toLink(r) : undefined;
  });
}

/** The link for an external place on one integration (a Slack channel id, a mailbox). */
export async function linkFor(integrationId: string, externalId: string): Promise<Link | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT id, integration_id, external_id, label, level, repos, require_mention, notify_me, notify_agent FROM channel_link
      WHERE user_id = ${user()} AND integration_id = ${integrationId} AND external_id = ${externalId}`;
    const r = (rows as LinkRow[])[0];
    return r ? toLink(r) : undefined;
  });
}

export type Principal = { id: string; name: string; maxLevel: Exclude<Level, "full"> };

export async function addPrincipal(p: Principal, identities: { adapter: string; externalId: string }[] = []): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql.begin(async (tx: Bun.SQL) => {
      await tx`INSERT INTO principal (id, user_id, name, max_level) VALUES (${p.id}, ${user()}, ${p.name}, ${p.maxLevel})
        ON CONFLICT (user_id, id) DO UPDATE SET name = EXCLUDED.name, max_level = EXCLUDED.max_level`;
      for (const i of identities) {
        await tx`INSERT INTO identity (user_id, adapter, external_id, principal_id) VALUES (${user()}, ${i.adapter}, ${i.externalId}, ${p.id})
          ON CONFLICT (user_id, adapter, external_id) DO UPDATE SET principal_id = EXCLUDED.principal_id`;
      }
    });
  });
}

/** Bind one platform identity to a person (Settings' Add identity): the same identity on another
 *  person moves here. `name` is how the People section shows it ("@saajan"); empty keeps the old one. */
export async function addIdentity(principalId: string, i: { adapter: string; externalId: string; name?: string }): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`INSERT INTO identity (user_id, adapter, external_id, principal_id, name) VALUES (${user()}, ${i.adapter}, ${i.externalId}, ${principalId}, ${i.name ?? null})
      ON CONFLICT (user_id, adapter, external_id) DO UPDATE SET principal_id = EXCLUDED.principal_id, name = COALESCE(EXCLUDED.name, identity.name)`;
  });
}

/** The paired person behind a platform user, or undefined (unknown senders get nothing inbound). */
export async function principalFor(adapter: string, externalId: string): Promise<Principal | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`
      SELECT p.id, p.name, p.max_level FROM identity i JOIN principal p ON p.user_id = i.user_id AND p.id = i.principal_id
      WHERE i.user_id = ${user()} AND i.adapter = ${adapter} AND i.external_id = ${externalId}`;
    const r = (rows as { id: string; name: string; max_level: Principal["maxLevel"] }[])[0];
    return r ? { id: r.id, name: r.name, maxLevel: r.max_level } : undefined;
  });
}

/** One paired person by Orca's id, or undefined. */
export async function principal(id: string): Promise<Principal | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT id, name, max_level FROM principal WHERE user_id = ${user()} AND id = ${id}`;
    const r = (rows as { id: string; name: string; max_level: Principal["maxLevel"] }[])[0];
    return r ? { id: r.id, name: r.name, maxLevel: r.max_level } : undefined;
  });
}

// ── subscription ─────────────────────────────────────────────────────────────────────────────────

export async function addSubscription(s: Omit<Subscription, "id">): Promise<number> {
  return db.withRetry(async (sql) => {
    const rows = await sql`
      INSERT INTO subscription (user_id, topic_pattern, filter, target_kind, target_id, digest_seconds)
      VALUES (${user()}, ${s.topicPattern}, ${s.filter}, ${s.targetKind}, ${s.targetId ?? null}, ${s.digestSeconds ?? null})
      RETURNING id`;
    return Number(rows[0].id);
  });
}

export async function removeSubscription(id: number): Promise<void> {
  return db.withRetry(async (sql) => { await sql`DELETE FROM subscription WHERE user_id = ${user()} AND id = ${id}`; });
}

export async function subscriptions(): Promise<Subscription[]> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT id, topic_pattern, filter, target_kind, target_id, digest_seconds FROM subscription
      WHERE user_id = ${user()} AND enabled ORDER BY id`;
    return (rows as { id: number; topic_pattern: string; filter: Record<string, string> | null; target_kind: TargetKind; target_id: string | null; digest_seconds: number | null }[])
      .map((r) => ({
        id: Number(r.id), topicPattern: r.topic_pattern, filter: r.filter ?? {}, targetKind: r.target_kind,
        ...(r.target_id ? { targetId: r.target_id } : {}), ...(r.digest_seconds ? { digestSeconds: r.digest_seconds } : {}),
      }));
  });
}

// ── thread_link (external thread ↔ workstream) ───────────────────────────────────────────────────

export type ThreadLink = { adapter: string; externalThreadId: string; linkId?: string; repo: string; branch: string };

/** Bind an external thread to a workstream. A thread is bound once: a second bind is ignored. */
export async function setThreadLink(t: ThreadLink): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`INSERT INTO thread_link (user_id, adapter, external_thread_id, link_id, repo, branch, created_at)
      VALUES (${user()}, ${t.adapter}, ${t.externalThreadId}, ${t.linkId ?? null}, ${t.repo}, ${t.branch}, ${Date.now()})
      ON CONFLICT (user_id, adapter, external_thread_id) DO NOTHING`;
  });
}

/** The workstream an inbound thread belongs to. */
export async function threadLink(adapter: string, externalThreadId: string): Promise<ThreadLink | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT adapter, external_thread_id, link_id, repo, branch FROM thread_link
      WHERE user_id = ${user()} AND adapter = ${adapter} AND external_thread_id = ${externalThreadId}`;
    const r = (rows as { adapter: string; external_thread_id: string; link_id: string | null; repo: string; branch: string }[])[0];
    return r ? { adapter: r.adapter, externalThreadId: r.external_thread_id, ...(r.link_id ? { linkId: r.link_id } : {}), repo: r.repo, branch: r.branch } : undefined;
  });
}

/** link id → thread id for one workstream: where an outbound post about it continues. */
export async function threadsForWorkstream(repo: string, branch: string): Promise<Map<string, string>> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT link_id, external_thread_id FROM thread_link
      WHERE user_id = ${user()} AND repo = ${repo} AND branch = ${branch} AND link_id IS NOT NULL ORDER BY created_at`;
    return new Map((rows as { link_id: string; external_thread_id: string }[]).map((r) => [r.link_id, r.external_thread_id]));
  });
}

// ── integration_cursor ───────────────────────────────────────────────────────────────────────────

export async function cursor(integrationId: string): Promise<string | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT value FROM integration_cursor WHERE user_id = ${user()} AND integration_id = ${integrationId}`;
    return (rows as { value: string }[])[0]?.value;
  });
}

export async function setCursor(integrationId: string, value: string): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`INSERT INTO integration_cursor (user_id, integration_id, value, updated_at) VALUES (${user()}, ${integrationId}, ${value}, ${Date.now()})
      ON CONFLICT (user_id, integration_id) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
  });
}

// ── event + delivery ─────────────────────────────────────────────────────────────────────────────

export type { PlannedDelivery } from "../../shared/integrations";

/** Record one event and its deliveries in ONE transaction (§3.5 rules 1-2). A known key inserts
 *  nothing and returns "duplicate", so a platform retry, a Gateway resume or a poll overlap is one
 *  event with one set of deliveries. */
export async function recordEvent(e: Envelope, planned: PlannedDelivery[], now = Date.now()): Promise<{ status: "new" | "duplicate"; deliveries: number[] }> {
  return db.withRetry(async (sql) => {
    let out: { status: "new" | "duplicate"; deliveries: number[] } = { status: "duplicate", deliveries: [] };
    await sql.begin(async (tx: Bun.SQL) => {
      const ins = await tx`INSERT INTO event (id, user_id, key, topic, envelope, created_at)
        VALUES (${e.id}, ${user()}, ${e.key}, ${e.topic}, ${e as unknown as Record<string, unknown>}, ${now})
        ON CONFLICT (user_id, key) DO NOTHING RETURNING id`;
      if (!ins.length) { out = { status: "duplicate", deliveries: [] }; return; }
      const ids: number[] = [];
      for (const d of planned) {
        // A digest subscription's delivery waits for its window's end, keyed with its siblings.
        const digest = d.digestSeconds && d.subscriptionId != null ? digestWindow(d.subscriptionId, d.digestSeconds, now) : undefined;
        const rows = await tx`INSERT INTO delivery (user_id, event_id, subscription_id, target, next_at, created_at, digest_key)
          VALUES (${user()}, ${e.id}, ${d.subscriptionId}, ${d.target as unknown as Record<string, unknown>}, ${digest?.nextAt ?? now}, ${now}, ${digest?.key ?? null})
          ON CONFLICT (event_id, subscription_id) DO NOTHING RETURNING id`;
        if (rows.length) ids.push(Number(rows[0].id));
      }
      out = { status: "new", deliveries: ids };
    });
    return out;
  });
}

export async function event(key: string): Promise<Envelope | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT envelope FROM event WHERE user_id = ${user()} AND key = ${key}`;
    return (rows as { envelope: Envelope }[])[0]?.envelope;
  });
}

export type Delivery = {
  id: number; eventId: string; subscriptionId?: number; target: DeliveryTarget; state: DeliveryState;
  attempts: number; nextAt: number; lastError?: string; externalMsgId?: string; envelope: Envelope;
  digestKey?: string;
};
type DeliveryRow = { id: number; event_id: string; subscription_id: number | null; target: DeliveryTarget; state: DeliveryState; attempts: number; next_at: number; last_error: string | null; external_msg_id: string | null; envelope: Envelope; digest_key?: string | null };
const toDelivery = (r: DeliveryRow): Delivery => ({
  id: Number(r.id), eventId: r.event_id, ...(r.subscription_id != null ? { subscriptionId: Number(r.subscription_id) } : {}),
  target: r.target, state: r.state, attempts: Number(r.attempts), nextAt: Number(r.next_at),
  ...(r.last_error ? { lastError: r.last_error } : {}), ...(r.external_msg_id ? { externalMsgId: r.external_msg_id } : {}), envelope: r.envelope,
  ...(r.digest_key ? { digestKey: r.digest_key } : {}),
});

/** Claim due deliveries (§3.5 rule 3): FOR UPDATE SKIP LOCKED, so two dispatchers never take one
 *  row. A claimed row is `sending` with a lease (`next_at` = now + leaseMs): a dispatcher that dies
 *  mid-send leaves it due again when the lease ends. `integrationIds` are the link targets this
 *  process can send to (its started adapters); `kinds` the non-link targets it serves. */
export async function claimDeliveries(opts: { now: number; limit: number; leaseMs: number; integrationIds: string[]; kinds: TargetKind[] }): Promise<Delivery[]> {
  return db.withRetry(async (sql) => {
    const ids = opts.integrationIds.length ? opts.integrationIds : [""];
    const kinds = opts.kinds.length ? opts.kinds : [""];
    const rows = await sql`
      UPDATE delivery d SET state = 'sending', attempts = d.attempts + 1, next_at = ${opts.now + opts.leaseMs}
      FROM event e
      WHERE e.id = d.event_id AND d.id IN (
        SELECT id FROM delivery
        WHERE user_id = ${user()} AND state IN ('pending', 'sending', 'failed') AND next_at <= ${opts.now}
          AND ((target->>'kind' = 'link' AND target->>'integrationId' IN ${sql(ids)}) OR (target->>'kind' <> 'link' AND target->>'kind' IN ${sql(kinds)}))
        ORDER BY next_at, id LIMIT ${opts.limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING d.id, d.event_id, d.subscription_id, d.target, d.state, d.attempts, d.next_at, d.last_error, d.external_msg_id, d.digest_key, e.envelope`;
    return (rows as DeliveryRow[]).map(toDelivery);
  });
}

/** The rest of a digest (same key) not yet claimed: claimed now, so its window goes out as ONE send
 *  even when the batch limit split it. */
export async function claimDigest(key: string, now: number, leaseMs: number): Promise<Delivery[]> {
  return db.withRetry(async (sql) => {
    const rows = await sql`
      UPDATE delivery d SET state = 'sending', attempts = d.attempts + 1, next_at = ${now + leaseMs}
      FROM event e
      WHERE e.id = d.event_id AND d.id IN (
        SELECT id FROM delivery WHERE user_id = ${user()} AND digest_key = ${key} AND state IN ('pending', 'failed')
        FOR UPDATE SKIP LOCKED
      )
      RETURNING d.id, d.event_id, d.subscription_id, d.target, d.state, d.attempts, d.next_at, d.last_error, d.external_msg_id, d.digest_key, e.envelope`;
    return (rows as DeliveryRow[]).map(toDelivery);
  });
}

/** Record the outcome of one attempt. `externalMsgId` is stored as soon as it is known (§3.5 rule 5). */
export async function finishDelivery(id: number, r: { state: DeliveryState; nextAt: number; error?: string; externalMsgId?: string; threadId?: string }): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`UPDATE delivery SET state = ${r.state}, next_at = ${r.nextAt}, last_error = ${r.error ?? null},
      external_msg_id = COALESCE(${r.externalMsgId ?? null}, external_msg_id),
      external_thread_id = COALESCE(${r.threadId ?? null}, external_thread_id)
      WHERE user_id = ${user()} AND id = ${id}`;
  });
}

/** One delivery's outcome so far (`orca post` waits on it): its state, the platform's message and
 *  thread ids once sent, the last error. Undefined for an unknown id. */
export async function deliveryResult(id: number): Promise<{ state: DeliveryState; externalMsgId?: string; threadId?: string; lastError?: string } | undefined> {
  return db.withRetry(async (sql) => {
    const [r] = await sql`SELECT state, external_msg_id, external_thread_id, last_error FROM delivery WHERE user_id = ${user()} AND id = ${id}` as { state: DeliveryState; external_msg_id: string | null; external_thread_id: string | null; last_error: string | null }[];
    return r && {
      state: r.state, ...(r.external_msg_id ? { externalMsgId: r.external_msg_id } : {}),
      ...(r.external_thread_id ? { threadId: r.external_thread_id } : {}), ...(r.last_error ? { lastError: r.last_error } : {}),
    };
  });
}

/** Put a claimed row back without spending an attempt (the outbound pace said wait). */
export async function deferDelivery(id: number, nextAt: number): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`UPDATE delivery SET state = 'pending', attempts = GREATEST(attempts - 1, 0), next_at = ${nextAt} WHERE user_id = ${user()} AND id = ${id}`;
  });
}

/** Deliveries, newest first (diagnostics, the later dead-letter card, tests). */
export async function deliveries(opts: { state?: DeliveryState; limit?: number } = {}): Promise<Delivery[]> {
  return db.withRetry(async (sql) => {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const rows = opts.state
      ? await sql`SELECT d.id, d.event_id, d.subscription_id, d.target, d.state, d.attempts, d.next_at, d.last_error, d.external_msg_id, d.digest_key, e.envelope
          FROM delivery d JOIN event e ON e.id = d.event_id WHERE d.user_id = ${user()} AND d.state = ${opts.state} ORDER BY d.id DESC LIMIT ${limit}`
      : await sql`SELECT d.id, d.event_id, d.subscription_id, d.target, d.state, d.attempts, d.next_at, d.last_error, d.external_msg_id, d.digest_key, e.envelope
          FROM delivery d JOIN event e ON e.id = d.event_id WHERE d.user_id = ${user()} ORDER BY d.id DESC LIMIT ${limit}`;
    return (rows as DeliveryRow[]).map(toDelivery);
  });
}

/** Dead deliveries back to pending (the later "Retry all" button). */
export async function retryDead(now = Date.now()): Promise<number> {
  return db.withRetry(async (sql) => {
    const rows = await sql`UPDATE delivery SET state = 'pending', attempts = 0, next_at = ${now} WHERE user_id = ${user()} AND state = 'dead' RETURNING id`;
    return rows.length;
  });
}

/** Drop events past retention (deliveries go with them). Raw payloads are debug data only. */
export const EVENT_RETENTION_MS = 30 * 24 * 3_600_000;
export async function pruneEvents(now = Date.now()): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`DELETE FROM event WHERE user_id = ${user()} AND created_at < ${now - EVENT_RETENTION_MS}
      AND NOT EXISTS (SELECT 1 FROM delivery d WHERE d.event_id = event.id AND d.state IN ('pending', 'sending', 'failed'))`;
  });
}

// ── pairing_code ─────────────────────────────────────────────────────────────────────────────────

export type Pairing = {
  code: string; integrationId: string; adapter: string; externalId: string; name?: string; linkId?: string;
  createdAt: number; expiresAt: number; state: "pending" | "approved" | "denied"; principalId?: string;
};
type PairingRow = { code: string; integration_id: string; adapter: string; external_id: string; name: string | null; link_id: string | null; created_at: number; expires_at: number; state: Pairing["state"]; principal_id: string | null };
const toPairing = (r: PairingRow): Pairing => ({
  code: r.code, integrationId: r.integration_id, adapter: r.adapter, externalId: r.external_id,
  ...(r.name ? { name: r.name } : {}), ...(r.link_id ? { linkId: r.link_id } : {}),
  createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), state: r.state, ...(r.principal_id ? { principalId: r.principal_id } : {}),
});

/** The sender's live pending code, or a new one. `fresh` says whether it was just made (only a new
 *  code is sent to the sender, so a chatty stranger gets one reply per hour, not one per message). */
export async function pairingFor(p: { integrationId: string; adapter: string; externalId: string; name?: string; linkId?: string }, newCode: () => string, now = Date.now()): Promise<{ pairing: Pairing; fresh: boolean }> {
  return db.withRetry(async (sql) => {
    const live = await sql`SELECT code, integration_id, adapter, external_id, name, link_id, created_at, expires_at, state, principal_id FROM pairing_code
      WHERE user_id = ${user()} AND adapter = ${p.adapter} AND external_id = ${p.externalId} AND state = 'pending' AND expires_at > ${now}
      ORDER BY created_at DESC LIMIT 1`;
    if (live.length) return { pairing: toPairing((live as PairingRow[])[0]!), fresh: false };
    for (let i = 0; i < 5; i++) {
      const rows = await sql`INSERT INTO pairing_code (user_id, code, integration_id, adapter, external_id, name, link_id, created_at, expires_at)
        VALUES (${user()}, ${newCode()}, ${p.integrationId}, ${p.adapter}, ${p.externalId}, ${p.name ?? null}, ${p.linkId ?? null}, ${now}, ${now + PAIRING_TTL_MS})
        ON CONFLICT (user_id, code) DO NOTHING
        RETURNING code, integration_id, adapter, external_id, name, link_id, created_at, expires_at, state, principal_id`;
      if (rows.length) return { pairing: toPairing((rows as PairingRow[])[0]!), fresh: true };
    }
    throw new Error("could not make a unique pairing code");
  });
}

/** Pending, unexpired codes, newest first (the API now, the Settings page later). */
export async function pendingPairings(now = Date.now()): Promise<Pairing[]> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT code, integration_id, adapter, external_id, name, link_id, created_at, expires_at, state, principal_id FROM pairing_code
      WHERE user_id = ${user()} AND state = 'pending' AND expires_at > ${now} ORDER BY created_at DESC`;
    return (rows as PairingRow[]).map(toPairing);
  });
}

/** Approve a code: in one transaction, make the principal (or reuse one: an id that exists keeps its
 *  name and level unless given) and bind the sender's identity to it. A new principal defaults to
 *  the sender's display name and "ask". Refuses an unknown, used or expired code. */
export async function approvePairing(code: string, principal: { id: string; name?: string; maxLevel?: Exclude<Level, "full"> }, now = Date.now()): Promise<Pairing> {
  return db.withRetry(async (sql) => {
    let out: Pairing | undefined;
    await sql.begin(async (tx: Bun.SQL) => {
      const rows = await tx`SELECT code, integration_id, adapter, external_id, name, link_id, created_at, expires_at, state, principal_id FROM pairing_code
        WHERE user_id = ${user()} AND code = ${code.trim().toUpperCase()} FOR UPDATE`;
      const p = (rows as PairingRow[])[0];
      if (!p) throw new Error(`no pairing code ${code}`);
      if (p.state !== "pending") throw new Error(`pairing code ${code} is already ${p.state}`);
      if (Number(p.expires_at) <= now) throw new Error(`pairing code ${code} has expired; ask the sender to write again for a new one`);
      await tx`INSERT INTO principal (id, user_id, name, max_level)
        VALUES (${principal.id}, ${user()}, ${principal.name ?? p.name ?? p.external_id}, ${principal.maxLevel ?? "ask"})
        ON CONFLICT (user_id, id) DO UPDATE SET name = COALESCE(${principal.name ?? null}::text, principal.name),
          max_level = COALESCE(${principal.maxLevel ?? null}::text, principal.max_level)`;
      await tx`INSERT INTO identity (user_id, adapter, external_id, principal_id, name) VALUES (${user()}, ${p.adapter}, ${p.external_id}, ${principal.id}, ${p.name})
        ON CONFLICT (user_id, adapter, external_id) DO UPDATE SET principal_id = EXCLUDED.principal_id, name = COALESCE(EXCLUDED.name, identity.name)`;
      const done = await tx`UPDATE pairing_code SET state = 'approved', principal_id = ${principal.id}, decided_at = ${now}
        WHERE user_id = ${user()} AND code = ${p.code}
        RETURNING code, integration_id, adapter, external_id, name, link_id, created_at, expires_at, state, principal_id`;
      out = toPairing((done as PairingRow[])[0]!);
    });
    return out!;
  });
}

export async function denyPairing(code: string, now = Date.now()): Promise<boolean> {
  return db.withRetry(async (sql) => {
    const rows = await sql`UPDATE pairing_code SET state = 'denied', decided_at = ${now}
      WHERE user_id = ${user()} AND code = ${code.trim().toUpperCase()} AND state = 'pending' RETURNING code`;
    return rows.length > 0;
  });
}

// ── the unified inbox (shared/inbox.ts) ─────────────────────────────────────────────────────────
// Read-only. The inbox topics are `ext.*` and `orca.question` (shared/inbox.ts `isInboxTopic`).

/** The newest inbox events, before an event id (ids are time-ordered) or a time (`beforeAt`, ms —
 *  the inbox's cursor, shared with the notifications), newest first. */
export async function inboxEvents(opts: { before?: string; beforeAt?: number; limit: number }): Promise<Envelope[]> {
  return db.withRetry(async (sql) => {
    const rows = opts.beforeAt !== undefined
      ? await sql`SELECT envelope FROM event WHERE user_id = ${user()} AND (topic LIKE 'ext.%' OR topic = 'orca.question') AND created_at < ${opts.beforeAt} AND COALESCE(envelope->'notify'->>'me', 'true') <> 'false'
          ORDER BY id DESC LIMIT ${opts.limit}`
      : opts.before
      ? await sql`SELECT envelope FROM event WHERE user_id = ${user()} AND (topic LIKE 'ext.%' OR topic = 'orca.question') AND id < ${opts.before} AND COALESCE(envelope->'notify'->>'me', 'true') <> 'false'
          ORDER BY id DESC LIMIT ${opts.limit}`
      : await sql`SELECT envelope FROM event WHERE user_id = ${user()} AND (topic LIKE 'ext.%' OR topic = 'orca.question') AND COALESCE(envelope->'notify'->>'me', 'true') <> 'false'
          ORDER BY id DESC LIMIT ${opts.limit}`;
    return (rows as { envelope: Envelope }[]).map((r) => r.envelope);
  });
}

/** The notices (shared/inbox.ts Notice) at or after `since`, newest first: a message the gate recorded
 *  with Notify me on (`envelope.notify`) that no agent took — no orchestrator or workstream delivery.
 *  The orchestrator's chat shows them between its turns; a message an agent took is its wake there. */
export async function noticeEvents(opts: { since: number; limit: number }): Promise<Envelope[]> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT e.envelope FROM event e WHERE e.user_id = ${user()} AND e.topic LIKE 'ext.%' AND e.created_at >= ${opts.since}
      AND e.envelope ? 'notify' AND e.envelope->'notify'->>'me' = 'true'
      AND NOT EXISTS (SELECT 1 FROM delivery d WHERE d.event_id = e.id AND d.target->>'kind' IN ('orchestrator', 'workstream'))
      ORDER BY e.id DESC LIMIT ${opts.limit}`;
    return (rows as { envelope: Envelope }[]).map((r) => r.envelope);
  });
}

type OutboundRow = { id: number; event_id: string; subscription_id: number | null; created_at: number; state: DeliveryState; attempts: number; last_error: string | null; target: DeliveryTarget; envelope: Envelope };
const toOutbound = (r: OutboundRow): OutboundRecord => ({
  deliveryId: Number(r.id), eventId: r.event_id, ...(r.subscription_id != null ? { subscriptionId: Number(r.subscription_id) } : {}), at: Number(r.created_at), state: r.state, attempts: Number(r.attempts),
  ...(r.last_error ? { lastError: r.last_error } : {}), target: r.target,
  envelope: { key: r.envelope.key, topic: r.envelope.topic, text: r.envelope.text, ...(r.envelope.title ? { title: r.envelope.title } : {}), ...(r.envelope.scope ? { scope: r.envelope.scope } : {}) },
});

/** Every delivery to a link planned since `since`, newest first: the replies the inbox rows show. */
export async function linkDeliveries(since: number, limit = 1000): Promise<OutboundRecord[]> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT d.id, d.event_id, d.subscription_id, d.created_at, d.state, d.attempts, d.last_error, d.target, e.envelope
      FROM delivery d JOIN event e ON e.id = d.event_id
      WHERE d.user_id = ${user()} AND d.target->>'kind' = 'link' AND d.created_at >= ${since}
      ORDER BY d.id DESC LIMIT ${limit}`;
    return (rows as OutboundRow[]).map(toOutbound);
  });
}

/** Every thread link (a small table: one row per external thread bound to a workstream). */
export async function threadLinks(): Promise<ThreadLinkRecord[]> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT adapter, external_thread_id, link_id, repo, branch FROM thread_link WHERE user_id = ${user()} ORDER BY created_at`;
    return (rows as { adapter: string; external_thread_id: string; link_id: string | null; repo: string; branch: string }[])
      .map((r) => ({ adapter: r.adapter, externalThreadId: r.external_thread_id, ...(r.link_id ? { linkId: r.link_id } : {}), repo: r.repo, branch: r.branch }));
  });
}

/** principal id → name. */
export async function principalNames(): Promise<Map<string, string>> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT id, name FROM principal WHERE user_id = ${user()}`;
    return new Map((rows as { id: string; name: string }[]).map((r) => [r.id, r.name]));
  });
}

/** One conversation (shared/inbox.ts `Conversation`): the inbox events in it, oldest first, and the
 *  link deliveries that went to it (at the place itself, only explicit posts: a subscription's
 *  broadcast to a channel is not part of one person's conversation there). A thread linked to a workstream also takes the post that started
 *  it: the newest delivery to that link about that workstream, with no thread, before the bind. */
export async function conversation(c: Conversation, limit = 500): Promise<{ events: Envelope[]; outbound: OutboundRecord[]; link?: ThreadLinkRecord }> {
  return db.withRetry(async (sql) => {
    const own = c.id.startsWith(OWN_EVENT) ? c.id.slice(OWN_EVENT.length) : null;
    const evRows = own
      ? await sql`SELECT envelope FROM event WHERE user_id = ${user()} AND id = ${own}`
      : await sql`SELECT envelope FROM event WHERE user_id = ${user()} AND (topic LIKE 'ext.%' OR topic = 'orca.question') AND (
          (envelope->'thread'->>'adapter' = ${c.adapter} AND envelope->'thread'->>'externalId' = ${c.id})
          OR (envelope->'thread' IS NULL AND envelope->'source'->>'adapter' = ${c.adapter} AND envelope->'source'->>'channel' = ${c.id}))
          ORDER BY id LIMIT ${limit}`;
    const events = (evRows as { envelope: Envelope }[]).map((r) => r.envelope);
    const ids = events.map((e) => e.id);
    const outRows = await sql`SELECT d.id, d.event_id, d.subscription_id, d.created_at, d.state, d.attempts, d.last_error, d.target, e.envelope
      FROM delivery d JOIN event e ON e.id = d.event_id
      WHERE d.user_id = ${user()} AND d.target->>'kind' = 'link' AND (
        (d.target->>'adapter' = ${c.adapter} AND (d.target->>'threadId' = ${c.id} OR (d.target->>'threadId' IS NULL AND d.target->>'externalId' = ${c.id} AND d.subscription_id IS NULL AND e.key NOT LIKE 'pairing:%')))
        OR d.event_id = ANY(${sql.array(ids, "TEXT")}))
      ORDER BY d.id LIMIT ${limit}`;
    const outbound = (outRows as OutboundRow[]).map(toOutbound);
    const tlRows = await sql`SELECT adapter, external_thread_id, link_id, repo, branch, created_at FROM thread_link
      WHERE user_id = ${user()} AND adapter = ${c.adapter} AND external_thread_id = ${c.id}`;
    const tl = (tlRows as { adapter: string; external_thread_id: string; link_id: string | null; repo: string; branch: string; created_at: number }[])[0];
    if (!tl) return { events, outbound };
    const link: ThreadLinkRecord = { adapter: tl.adapter, externalThreadId: tl.external_thread_id, ...(tl.link_id ? { linkId: tl.link_id } : {}), repo: tl.repo, branch: tl.branch };
    if (tl.link_id) {
      const start = await sql`SELECT d.id, d.event_id, d.subscription_id, d.created_at, d.state, d.attempts, d.last_error, d.target, e.envelope
        FROM delivery d JOIN event e ON e.id = d.event_id
        WHERE d.user_id = ${user()} AND d.target->>'kind' = 'link' AND d.target->>'linkId' = ${tl.link_id} AND d.target->>'threadId' IS NULL
          AND e.envelope->'scope'->>'repo' = ${tl.repo} AND e.envelope->'scope'->>'branch' = ${tl.branch} AND d.created_at <= ${Number(tl.created_at)}
        ORDER BY d.id DESC LIMIT 1`;
      const first = (start as OutboundRow[]).map(toOutbound)[0];
      if (first && !outbound.some((d) => d.deliveryId === first.deliveryId)) outbound.unshift(first);
    }
    return { events, outbound, link };
  });
}

/** One event by Orca's id. */
export async function eventById(id: string): Promise<Envelope | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT envelope FROM event WHERE user_id = ${user()} AND id = ${id}`;
    return (rows as { envelope: Envelope }[])[0]?.envelope;
  });
}

/** Which of these events you have read: opened in the inbox, or read as the bell's copy of it (a
 *  notification with the same key — the web adapter writes one per event it shows). One read state. */
export async function readEvents(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT e.id FROM event e WHERE e.user_id = ${user()} AND e.id = ANY(${sql.array(ids, "TEXT")}) AND (
        EXISTS (SELECT 1 FROM inbox_read r WHERE r.user_id = e.user_id AND r.event_id = e.id)
        OR EXISTS (SELECT 1 FROM notification n WHERE n.user_id = e.user_id AND n.key = e.key AND n.read_at IS NOT NULL))`;
    return new Set((rows as { id: string }[]).map((r) => r.id));
  });
}

/** Mark events read (or unread again), and the bell's copy of each with them. An id with no event is skipped. */
export async function setRead(ids: string[], read: boolean, now = Date.now()): Promise<void> {
  if (!ids.length) return;
  return db.withRetry(async (sql) => {
    if (read) {
      await sql`INSERT INTO inbox_read (user_id, event_id, read_at)
        SELECT ${user()}, id, ${now} FROM event WHERE user_id = ${user()} AND id = ANY(${sql.array(ids, "TEXT")})
        ON CONFLICT (user_id, event_id) DO NOTHING`;
      await sql`UPDATE notification n SET read_at = ${now} FROM event e
        WHERE n.user_id = ${user()} AND n.read_at IS NULL AND e.user_id = n.user_id AND e.key = n.key AND e.id = ANY(${sql.array(ids, "TEXT")})`;
    } else {
      await sql`DELETE FROM inbox_read WHERE user_id = ${user()} AND event_id = ANY(${sql.array(ids, "TEXT")})`;
      await sql`UPDATE notification n SET read_at = NULL FROM event e
        WHERE n.user_id = ${user()} AND e.user_id = n.user_id AND e.key = n.key AND e.id = ANY(${sql.array(ids, "TEXT")})`;
    }
  });
}

/** Orca's own notifications for the inbox, newest first, created before `before` (ms). A row that is
 *  the bell's copy of an inbox event (same key: an outside message, a question) is left out: the
 *  event's own row shows it. */
export async function inboxNotifications(opts: { before?: number; limit: number }): Promise<Notification[]> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT n.id, n.repo, n.branch, n.kind, n.title, n.body, n.link, n.created_at, n.read_at, n.instance FROM notification n
      WHERE n.user_id = ${user()} AND n.kind <> 'external_message' AND n.created_at < ${opts.before ?? Number.MAX_SAFE_INTEGER}
        AND NOT EXISTS (SELECT 1 FROM event e WHERE e.user_id = n.user_id AND e.key = n.key AND (e.topic LIKE 'ext.%' OR e.topic = 'orca.question'))
      ORDER BY n.created_at DESC, n.id DESC LIMIT ${opts.limit}`;
    return (rows as { id: string; repo: string; branch: string | null; kind: Notification["kind"]; title: string; body: string; link: Notification["link"] | null; created_at: string; read_at: string | null; instance: string }[])
      .map((r) => ({
        id: Number(r.id), instance: r.instance, repo: r.repo, ...(r.branch ? { branch: r.branch } : {}), kind: r.kind, title: r.title, body: r.body,
        ...(r.link ? { link: r.link } : {}), createdAt: Number(r.created_at), ...(r.read_at ? { readAt: Number(r.read_at) } : {}),
      }));
  });
}

/** One notification's kind (the inbox mutes a notification row by its kind). */
export async function notificationKind(id: number): Promise<string | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT kind FROM notification WHERE user_id = ${user()} AND id = ${id}`;
    return (rows as { kind: string }[])[0]?.kind;
  });
}

/** Mark notifications unread again (the bell's own write, db.markNotificationsRead, only reads). */
export async function markNotificationsUnread(ids: number[]): Promise<void> {
  if (!ids.length) return;
  return db.withRetry(async (sql) => {
    await sql`UPDATE notification SET read_at = NULL WHERE user_id = ${user()} AND id = ANY(${sql.array(ids, "INT8")})`;
  });
}

/** The unread inbox events the bell has no copy of, in the newest `limit`, minus muted senders: the
 *  inbox's half of the one unread count (shared/inbox.ts `unreadTotal`). */
export async function unreadWithoutCopy(limit: number): Promise<number> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT count(*)::int AS n FROM (
        SELECT e.id, e.key, e.envelope FROM event e WHERE e.user_id = ${user()} AND (e.topic LIKE 'ext.%' OR e.topic = 'orca.question')
          AND COALESCE(e.envelope->'notify'->>'me', 'true') <> 'false'
        ORDER BY e.id DESC LIMIT ${limit}) e
      WHERE NOT EXISTS (SELECT 1 FROM notification n WHERE n.user_id = ${user()} AND n.key = e.key)
        AND NOT EXISTS (SELECT 1 FROM inbox_read r WHERE r.user_id = ${user()} AND r.event_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM inbox_mute m WHERE m.user_id = ${user()}
          AND m.adapter = e.envelope->'actor'->'external'->>'adapter' AND m.external_id = e.envelope->'actor'->'external'->>'id')`;
    return Number((rows as { n: number }[])[0]?.n ?? 0);
  });
}

/** Every muted sender, as shared/inbox.ts `muteKey`s. */
export async function mutedSenders(): Promise<Set<string>> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT adapter, external_id FROM inbox_mute WHERE user_id = ${user()}`;
    return new Set((rows as { adapter: string; external_id: string }[]).map((r) => muteKey(r.adapter, r.external_id)));
  });
}

export async function setMuted(adapter: string, externalId: string, muted: boolean, name?: string, now = Date.now()): Promise<void> {
  return db.withRetry(async (sql) => {
    if (muted) {
      await sql`INSERT INTO inbox_mute (user_id, adapter, external_id, name, created_at) VALUES (${user()}, ${adapter}, ${externalId}, ${name ?? null}, ${now})
        ON CONFLICT (user_id, adapter, external_id) DO NOTHING`;
    } else {
      await sql`DELETE FROM inbox_mute WHERE user_id = ${user()} AND adapter = ${adapter} AND external_id = ${externalId}`;
    }
  });
}
