// Where inbound events land in Orca (docs/research/integrations.md §3.5 targets `orchestrator` and
// `workstream`). One function per target wraps today's entry points, so the orchestrator's queue,
// batching, wake guards and the workers' follow-up path stay exactly as they are.
import * as db from "../db";
import * as orchestrator from "../orchestrator";
import * as verbs from "../verbs";
import type { OrcaConfig } from "../config";
import * as store from "./store";
import { agentMay, fenceExternal, integrationMetaLine, integrationPlace, integrationUrl, replyToOf, type Envelope, type SendResult } from "../../shared/integrations";

/** The text an event becomes for an agent: an outside sender's fenced as data, Orca's own as is. */
export const agentText = (e: Envelope): string => (e.grant ? fenceExternal(e) : e.title ? `${e.title}: ${e.text}` : e.text);

/** An outside message for the orchestrator, with its source as a meta line, so the chat shows it as
 *  an activity row (sender, place, link) and not as your message. The link's label names the place,
 *  unless it is the catch-all link, which names no real channel; a failed read of it costs only the
 *  place, never the message. */
export async function withSource(e: Envelope): Promise<string> {
  const link = e.source.linkId ? await store.link(e.source.linkId).then((l) => l, () => undefined) : undefined;
  const place = integrationPlace(e, link), url = integrationUrl(e), sender = e.actor?.external.name ?? e.display?.sender;
  return `${agentText(e)}\n${integrationMetaLine({ adapter: e.source.adapter, ...(sender ? { sender } : {}), ...(place ? { place } : {}), ...(url ? { url } : {}) })}`;
}

/** `inbox.toOrchestrator` (§3.5). An outside sender's message goes in as a message with its grant
 *  (a separate wake from any other grant, verbs checked server-side); a person resets the wake count,
 *  a script does not. Orca's own event (a subscription of `orca.*` to the orchestrator) is a worker
 *  report: management by exception, batched like the rest. */
export async function toOrchestrator(cfg: OrcaConfig, e: Envelope): Promise<SendResult> {
  if (e.grant) {
    if (!agentMay(e)) return { ok: false, retryable: false, error: "this message may not wake an agent (notify agent is off, or a machine event under notify)" };
    // A `notify` grant is READ-ONLY: the wake may only tell you about it. No reply target (it may not
    // answer as you), and it does not reset the wake count (a stranger cannot keep it awake).
    const readOnly = e.grant.level === "notify";
    const replyTo = readOnly ? undefined : replyToOf(e);
    await orchestrator.message(cfg, await withSource(e), e.attachments ?? [], { grant: e.grant, person: !readOnly && Boolean(e.actor ?? e.display?.sender), ...(replyTo ? { replyTo } : {}) });
  } else {
    await orchestrator.deliverReport(cfg, agentText(e));
  }
  return { ok: true };
}

/** A follow-up on the workstream a thread is linked to, on the instance that holds its worktree. */
export async function toWorkstream(cfg: OrcaConfig, repoName: string, branch: string, e: Envelope): Promise<SendResult> {
  const repo = cfg.repos.find((r) => r.name === repoName);
  if (!repo) return { ok: false, retryable: false, error: `no repo named ${repoName}` };
  const instruction = agentText(e);
  const home = await verbs.placement(repo, { branch });
  if (home !== db.instanceName()) await orchestrator.viaInstance(cfg, home, "/api/workstreams/followup", { repo: repo.name, branch, instruction });
  else await verbs.followUp(cfg, repo, branch, { instruction });
  return { ok: true };
}
