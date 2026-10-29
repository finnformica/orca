// One path in (docs/research/integrations.md §3.1, §3.5). `ingest` is an adapter's door: dedupe,
// gate the sender against its link (§3.7), then `publish`. `publish` is everyone's: record the event
// once by its key and plan its deliveries in the same transaction, then kick the dispatcher.
import { randomUUID } from "crypto";
import { CATCH_ALL, CATCH_ALL_SEND_ERROR, effectiveGrant, effectiveNotify, integrationAccessRefusal, sendsToCatchAll, INBOUND_LIMIT, paceWait, planDeliveries, replyToOf, type ConversationRef, type Envelope, type Grant, type InboundEnvelope, type PlannedDelivery, type ReplyTo } from "../../shared/integrations";
import { replyRefusal } from "../../shared/inbox";
import * as store from "./store";
import { loadConfig } from "../config";
import type { IngestVerdict } from "./adapter";

/** Orca's own id: time-ordered, so `ORDER BY id` is arrival order. */
export const newEventId = (now = Date.now()): string => `${now.toString(36).padStart(9, "0")}-${randomUUID().slice(0, 12)}`;

type Kick = () => void;
let kick: Kick = () => {};
/** The dispatcher registers itself here (§3.5 rule 6: kick in-process after each insert). */
export const onPublished = (fn: Kick): void => { kick = fn; };

/** Listeners for every NEW event, after it is recorded (index.ts: the scheduled wakes' `--on`,
 *  server/scheduledWake.ts). A listener never fails a publish. */
const newEventListeners: ((e: Envelope) => void)[] = [];
export const onNewEvent = (fn: (e: Envelope) => void): void => { newEventListeners.push(fn); };

/** Record one event and route it. Idempotent on `key`. `grant` is set by `ingest` only; absent =
 *  Orca's own event, with the full grant. `extra` are deliveries to explicit targets beside the
 *  subscriptions' (`orca post`, `orca ask-user`, a pairing reply). */
export async function publish(input: InboundEnvelope & { grant?: Grant }, now = Date.now(), extra: PlannedDelivery[] = []): Promise<{ status: "new" | "duplicate"; id: string; deliveries: number[] }> {
  // A catch-all link names no place: refuse a post to it here, before a row exists to die.
  if (extra.some((d) => sendsToCatchAll(d.target))) throw new Error(CATCH_ALL_SEND_ERROR);
  const e: Envelope = { ...input, id: newEventId(now) };
  const [subs, allLinks, conns, threads, inbound] = await Promise.all([
    store.subscriptions(),
    store.links(),
    store.integrations(),
    e.scope?.repo && e.scope.branch ? store.threadsForWorkstream(e.scope.repo, e.scope.branch) : Promise.resolve(new Map<string, string>()),
    e.thread ? store.threadLink(e.thread.adapter, e.thread.externalId) : Promise.resolve(undefined),
  ]);
  const kinds = new Map(conns.map((c) => [c.id, c.kind]));
  // The account policy (docs/integrations/POLICY.md): a post is a write. An explicit post to a read
  // account is refused; a subscription to one plans nothing (no dead rows, no failure notice).
  const verb = e.deleteMessage ? "delete" : "send";
  const writeRefusal = new Map(conns.map((c) => [c.id, integrationAccessRefusal(c, verb)]));
  for (const d of extra) if (d.target.kind === "link") { const r = writeRefusal.get(d.target.integrationId); if (r) throw new Error(r); }
  const links = new Map(allLinks.filter((l) => !writeRefusal.get(l.integrationId))
    .map((l) => [l.id, { integrationId: l.integrationId, adapter: kinds.get(l.integrationId) ?? "?", externalId: l.externalId, ...(l.agent ? { agent: l.agent } : {}) }]));
  // An inbound message's own link names its agent even on a read account, whose links post nothing.
  const own = e.source.linkId ? allLinks.find((l) => l.id === e.source.linkId) : undefined;
  if (own?.agent && !links.has(own.id)) links.set(own.id, { integrationId: own.integrationId, adapter: kinds.get(own.integrationId) ?? "?", externalId: own.externalId, agent: own.agent });
  const plan = planDeliveries(e, subs, links, threads, inbound);
  // The web shows an event once: an explicit web target beside a subscription's is the same row.
  const planned = [...plan, ...extra.filter((d) => d.target.kind !== "web" || !plan.some((p) => p.target.kind === "web"))];
  const r = await store.recordEvent(e, planned, now);
  if (r.status === "new" && r.deliveries.length) kick();
  if (r.status === "new") for (const fn of newEventListeners) { try { fn(e); } catch (err) { console.error("orca: new-event listener failed", err); } }
  return { ...r, id: e.id };
}

/** `orca post`: one `orca.message` with one explicit delivery to a link, so the dispatcher sends it
 *  through the link's adapter and retries a failure. `reply` answers an inbound event where it came
 *  from: its place (a catch-all link's DM, not "*") and its thread. `channel` names the place on a
 *  catch-all link; with neither, a catch-all post is refused (it names no place). `thread` rides the envelope, so an
 *  email answer is an `In-Reply-To`. Used by `orca post [--reply]` and the inbox's Reply. */
export async function post(link: store.Link, text: string, opts: {
  reply?: ReplyTo; threadId?: string; scope?: { repo: string; branch?: string }; thread?: ConversationRef; key?: string;
  /** Open a thread for the post (`orca post --thread`; Discord: on the message it answers). */
  openThread?: boolean;
  /** `orca-attachment://` refs, sent as files (`orca post --attach`). */
  attachments?: string[];
  /** The place to post on a catch-all link (`orca post --channel`): any channel the bot can see. */
  channel?: string;
  /** Post, then open a thread with this name on the post (`orca post --new-thread`). */
  newThread?: { name: string };
  /** Delete this message instead of posting (`orca post --delete`). */
  deleteMessage?: string;
} = {}, now = Date.now()): Promise<{ id: string; delivery?: number; externalId: string; threadId?: string }> {
  const conn = await store.integration(link.integrationId);
  const threadId = opts.reply ? opts.reply.threadId : opts.threadId;
  // A reply names the message it answers (`replyToExternalMsgId`): Linear's parent comment, email's
  // In-Reply-To. The inbox's Reply passes the event's own thread; `orca post --reply` gets it here.
  const thread = opts.thread ?? (opts.reply?.threadId
    ? { adapter: conn?.kind ?? "?", externalId: opts.reply.threadId, ...(opts.reply.messageId ? { messageId: opts.reply.messageId } : {}) } : undefined);
  const externalId = opts.reply?.channel ?? (link.externalId === CATCH_ALL ? opts.channel : undefined) ?? link.externalId;
  const r = await publish({
    key: opts.key ?? `post:${randomUUID()}`, topic: "orca.message", at: now, source: { adapter: "orca", linkId: link.id },
    ...(opts.scope ? { scope: opts.scope } : {}), ...(thread ? { thread } : {}), text,
    ...(opts.openThread ? { openThread: opts.reply?.messageId ? { messageId: opts.reply.messageId } : {} } : {}),
    ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    ...(opts.newThread ? { newThread: opts.newThread } : {}), ...(opts.deleteMessage ? { deleteMessage: opts.deleteMessage } : {}),
  }, now, [{ subscriptionId: null, target: {
    kind: "link", integrationId: link.integrationId, adapter: conn?.kind ?? "?", linkId: link.id, externalId, ...(threadId ? { threadId } : {}),
  } }]);
  return { id: r.id, ...(r.deliveries[0] !== undefined ? { delivery: r.deliveries[0] } : {}), externalId, ...(threadId ? { threadId } : {}) };
}

/** The inbox's Reply (docs/research/integrations.md §6.2): `post` with the event's own `replyToOf`,
 *  the place and thread `orca post --reply` uses. The refusals are pure (shared/inbox.ts). */
export async function replyToEvent(eventId: string, text: string, now = Date.now()): Promise<{ eventId: string; delivery?: number }> {
  const e = await store.eventById(eventId);
  if (!e) throw new Error(`no event ${eventId}`);
  const link = e.source.linkId ? await store.link(e.source.linkId) : undefined;
  const refusal = replyRefusal(e, text, link);
  if (refusal) throw new Error(refusal);
  const r = await post(link!, text.trim(), {
    reply: replyToOf(e), ...(e.scope?.repo ? { scope: { repo: e.scope.repo, ...(e.scope.branch ? { branch: e.scope.branch } : {}) } } : {}),
    ...(e.thread ? { thread: e.thread } : {}), key: `reply:${eventId}:${randomUUID()}`,
  }, now);
  return { eventId: r.id, ...(r.delivery !== undefined ? { delivery: r.delivery } : {}) };
}

// Inbound pace per sender (§3.8): in memory, per process — one primary runs the adapters.
const recent = new Map<string, number[]>();

/** Reset the inbound pace (tests). */
export const resetPace = (): void => recent.clear();

/** The core's half of `ctx.ingest`. */
export async function ingest(integrationId: string, e: InboundEnvelope, now = Date.now()): Promise<IngestVerdict> {
  // Dedupe first, so a platform retry of an accepted event is "duplicate", never a second pace hit.
  if (await store.event(e.key)) return "duplicate";
  // A link for the exact place, else for a wider place that holds it (`source.parents`), else the
  // integration's catch-all link (external_id "*": DMs, a bot's every channel). No link = nobody
  // said Orca may listen there.
  const link = e.source.linkId ? await store.link(e.source.linkId) : e.source.channel ? await firstLink(integrationId, [e.source.channel, ...(e.source.parents ?? []), CATCH_ALL]) : undefined;
  if (!link || link.integrationId !== integrationId) return "rejected"; // no link = nobody said Orca may listen here
  if (link.requireMention && e.mentioned === false) return "rejected";
  const who = `${integrationId}:${e.actor?.external.id ?? link.id}`;
  const times = recent.get(who) ?? [];
  if (paceWait(times, now, INBOUND_LIMIT.count, INBOUND_LIMIT.windowMs) > 0) return "rejected";
  recent.set(who, [...times.filter((t) => now - t < INBOUND_LIMIT.windowMs), now]);
  // A link's switches (both on by default): Notify me shows the message to you, Notify agent lets
  // it wake an agent. The account's events mode narrows them (`record`: no agent; `off`: neither),
  // never widens them (docs/integrations/POLICY.md). Both off: nothing is recorded.
  const conn = await store.integration(integrationId);
  const notify = effectiveNotify({ me: link.notifyMe !== false, agent: link.notifyAgent !== false }, conn?.events);
  if (!notify.me && !notify.agent) return "rejected";
  // A person keeps the grant of who they are; an unknown sender (no principal) gets `notify`: a
  // READ-ONLY wake (no verb, no reply) and a notification. No pairing code: People is the manual way.
  // A sender with no person behind it (a webhook, a poller) is authenticated by its integration and
  // takes the link's level.
  const principal = e.actor ? await store.principalFor(e.actor.external.adapter, e.actor.external.id) : undefined;
  // The owner's own person (Settings > People) acts with the full grant; nobody else is widened.
  const owner = principal ? (await loadConfig()).ownerPrincipal : undefined;
  const grant: Grant = e.actor ? effectiveGrant(link, principal, owner) : { level: link.level, repos: link.repos, linkId: link.id };
  // A notify link takes no machine event in — except, when its integration says so
  // (`config.machineEventsOnNotify`): recorded and fanned out to its subscriptions with the grant
  // "notify", so no agent acts on it (shared/integrations.ts agentMay).
  if (grant.level === "notify" && !e.actor && conn?.config.machineEventsOnNotify !== true) return "rejected";
  const principalId = grant.principalId;
  const r = await publish({
    ...e, source: { ...e.source, integrationId, linkId: link.id },
    ...(e.actor && principalId ? { actor: { ...e.actor, principalId } } : {}),
    grant, notify,
  }, now, notify.me ? [{ subscriptionId: null, target: { kind: "web" } }] : []);
  // No agent will answer it (read-only, or Notify agent off): the adapter opens no thread for it.
  return r.status === "new" && (grant.level === "notify" || !notify.agent) ? "noted" : r.status;
}

async function firstLink(integrationId: string, places: string[]): Promise<store.Link | undefined> {
  for (const p of places) { const l = await store.linkFor(integrationId, p); if (l) return l; }
  return undefined;
}
