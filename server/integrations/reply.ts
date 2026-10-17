// Reply to an inbound event where it came from (the unified inbox's Reply, docs/research/integrations.md
// §6.2). The same path as `orca post`: one `orca.message` event with one explicit delivery to the
// link, so the dispatcher sends it through the source adapter and retries a failure. The decision
// (which place, which thread) is pure: shared/inbox.ts `replyPlan`.
import { replyPlan } from "../../shared/inbox";
import { publish } from "./router";
import * as store from "./store";

export async function replyTo(eventId: string, text: string, now = Date.now()): Promise<{ eventId: string; delivery?: number }> {
  const e = await store.eventById(eventId);
  if (!e) throw new Error(`no event ${eventId}`);
  const link = e.source.linkId ? await store.link(e.source.linkId) : undefined;
  const conn = link ? await store.integration(link.integrationId) : undefined;
  const plan = replyPlan(e, text, link, conn?.kind, `reply:${eventId}:${crypto.randomUUID()}`, now);
  if (typeof plan === "string") throw new Error(plan);
  const r = await publish(plan.envelope, now, [{ subscriptionId: null, target: plan.target }]);
  return { eventId: r.id, ...(r.deliveries[0] !== undefined ? { delivery: r.deliveries[0] } : {}) };
}
