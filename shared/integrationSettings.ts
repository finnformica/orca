// Settings > Integrations (docs/research/integrations.md §6.1): the page's data shape and its pure
// decisions — a card's health tone, the subscription presets, what a row reads as, and the checks a
// form runs before it posts. Pure: the server (server/integrations/admin.ts), the page
// (web/src/views/Integrations.tsx) and the tests import it as is.
import { isAutomatic, secretRefRefusal, type AdapterMeta, type DeliveryTarget, type Level, type Subscription, type TargetKind } from "./integrations";

/** One integration as the page shows it: the row, its health and what it ran last. */
export type IntegrationCard = {
  id: string; kind: string; name: string; instance: string; enabled: boolean;
  config: Record<string, unknown>; secretRef?: string;
  /** Whether the variable `secretRef` names is set — known only on the instance that runs it
   *  (undefined elsewhere, until that instance's Test records it). Never the value. */
  secretSet?: boolean;
  /** Automatic only: the instance that holds its lease and runs it now. */
  runsOn?: string;
  /** Automatic only, with nobody running it: the instances whose primary lacks the secret. */
  secretMissingOn?: string[];
  /** `running` = this bridge runs it now; `health` = its last live check (here, or the status row). */
  running: boolean;
  health?: { ok: boolean; detail?: string; at?: number; startedAt?: number; error?: string };
  lastEventAt?: number;
};

export type LinkRow = { id: string; integrationId: string; externalId: string; label?: string; level: Exclude<Level, "full">; repos: string[]; requireMention: boolean };
export type PersonRow = { id: string; name: string; maxLevel: Exclude<Level, "full">; identities: { adapter: string; externalId: string }[] };

/** A pending pairing code (the core's server/integrations/store.ts `Pairing`): an unknown sender
 *  wrote to a link; you approve or deny them here. */
export type Pairing = {
  code: string; integrationId: string; adapter: string; externalId: string; name?: string; linkId?: string;
  createdAt: number; expiresAt: number; state: "pending" | "approved" | "denied"; principalId?: string;
};

export type DeadRow = { id: number; eventId: string; target: DeliveryTarget; attempts: number; lastError?: string; topic: string; key: string; title?: string; at?: number };

/** One instance as the page shows it: the server display name for the server's home instance, else
 *  its Tailscale host name, else the id. `host` is the Tailscale host name when known. */
export type InstanceOption = { id: string; label: string; host?: string };

export type IntegrationsOverview = {
  instance: string;
  /** Every instance (the app config's `instances`, and this one), with its display name. */
  instanceOptions?: InstanceOption[];
  kinds: AdapterMeta[];
  integrations: IntegrationCard[];
  links: LinkRow[];
  people: PersonRow[];
  pairings: Pairing[];
  subscriptions: Subscription[];
  dead: DeadRow[];
};

/** The page's names for the instances. The server identity (`serverIdentity.name`, e.g. "Flow")
 *  describes the server's home: the instance its orchestrator runs on (`home`). Every other instance
 *  goes by its Tailscale host name (`hosts`), else its id. Pure. */
export function instanceOptions(ids: string[], hosts: Record<string, string>, identityName: string | undefined, home: string | undefined): InstanceOption[] {
  return [...new Set(ids)].map((id) => {
    const host = hosts[id];
    const label = (id === home && identityName?.trim()) || host || id;
    return { id, label, ...(host ? { host } : {}) };
  });
}

/** An instance in one line: "Flow / orca-flow-box", "finns-mbp", or the id. "Automatic" for `*`. */
export function instanceText(id: string, options: InstanceOption[] = []): string {
  if (isAutomatic(id)) return "Automatic";
  const o = options.find((x) => x.id === id);
  if (!o) return id;
  return o.host && o.host !== o.label ? `${o.label} / ${o.host}` : o.label;
}

export type Tone = "ready" | "warning" | "error" | "neutral";

/** A card's dot: off is gray; a failed start or check, or a secret missing on every primary of an
 *  Automatic row, is red; a row with no live check yet, or one last seen on another instance more
 *  than 10 minutes ago, is amber; else green. */
export function healthTone(c: Pick<IntegrationCard, "enabled" | "running" | "health" | "secretSet" | "secretMissingOn" | "runsOn" | "instance">, now = Date.now()): Tone {
  if (!c.enabled) return "neutral";
  if (c.secretSet === false) return "error";
  if (isAutomatic(c.instance) && !c.runsOn && !c.running) return c.secretMissingOn?.length ? "error" : "warning";
  if (!c.health) return "warning";
  if (!c.health.ok) return "error";
  if (!c.running && c.health.at && now - c.health.at > 10 * 60_000) return "warning";
  return "ready";
}

/** A compact duration: "now", "4m", "3h", "2d". */
export function span(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
const ago = (ms: number): string => (span(ms) === "now" ? "just now" : `${span(ms)} ago`);

/** The one line under a card's name: off, the error, or "Connected 2h · last event 3m ago". An
 *  Automatic row that no bridge runs names the variable and every instance that lacks it. */
export function healthLine(c: IntegrationCard, now = Date.now(), options: InstanceOption[] = []): string {
  if (!c.enabled) return "Disconnected";
  const auto = isAutomatic(c.instance);
  const on = (id: string) => instanceText(id, options);
  const where = auto ? (c.runsOn ? on(c.runsOn) : undefined) : on(c.instance);
  if (auto && !c.runsOn && c.secretMissingOn?.length) {
    return `${c.secretRef ?? "The token variable"} is not set on ${c.secretMissingOn.map(on).join(", ")}. Set it there and restart Orca.`;
  }
  if (c.secretSet === false) return `${c.secretRef ?? "The token variable"} is not set on ${where ?? "the primary bridge"}`;
  const parts: string[] = [];
  if (auto && !c.runsOn && !c.running) parts.push("Automatic: no primary bridge runs it yet");
  else if (!c.health) parts.push(c.running ? "Starting" : `Not checked yet on ${where}`);
  else if (!c.health.ok) parts.push(c.health.error ?? c.health.detail ?? "Not healthy");
  else parts.push(c.health.startedAt ? `Connected ${span(now - c.health.startedAt)}` : c.health.detail ?? "Connected");
  parts.push(c.lastEventAt ? `last event ${ago(now - c.lastEventAt)}` : "no events yet");
  return parts.join(" · ");
}

/** §6.1's presets: one click adds the subscription to a link. */
export const SUBSCRIPTION_PRESETS: { id: string; label: string; topicPattern: string; digestSeconds?: number }[] = [
  { id: "pr", label: "PR events", topicPattern: "orca.pr.*" },
  { id: "done", label: "Worker done", topicPattern: "orca.run.finished" },
  { id: "questions", label: "Questions for me", topicPattern: "orca.question" },
  { id: "ci", label: "CI failures (digest 10 min)", topicPattern: "orca.pr.ci_failed", digestSeconds: 600 },
];

export const TARGET_KINDS: TargetKind[] = ["link", "orchestrator", "workstream", "web"];

/** A subscription's target as words: "#eng (Work Slack)", "the orchestrator", "orca::main", "this web app". */
export function targetLabel(s: Pick<Subscription, "targetKind" | "targetId">, links: LinkRow[], cards: Pick<IntegrationCard, "id" | "name">[]): string {
  if (s.targetKind === "orchestrator") return "the orchestrator";
  if (s.targetKind === "web") return "the web app";
  if (s.targetKind === "workstream") return s.targetId ?? "?";
  const l = links.find((x) => x.id === s.targetId);
  if (!l) return `link ${s.targetId ?? "?"} (removed)`;
  const card = cards.find((c) => c.id === l.integrationId);
  return `${l.label ?? l.externalId}${card ? ` · ${card.name}` : ""}`;
}

export const filterText = (f: Record<string, string>): string =>
  Object.entries(f).map(([k, v]) => `${k}=${v}`).join(", ");

/** "repo=orca, adapter=slack" → {repo: "orca", adapter: "slack"}; undefined when malformed. */
export function parseFilter(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^([a-z]+)\s*=\s*(\S+)$/);
    if (!m || !["repo", "branch", "adapter"].includes(m[1]!)) return undefined;
    out[m[1]!] = m[2]!;
  }
  return out;
}

/** Where a dead delivery went, as words. */
export const deadTargetLabel = (t: DeliveryTarget): string =>
  t.kind === "link" ? `${t.adapter} ${t.externalId}` : t.kind === "workstream" ? `${t.repo}::${t.branch}` : t.kind;

const ID = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

/** Why a Connect form cannot be saved, or undefined. Server and page run the same check. */
export function integrationProblem(i: { id?: string; kind?: string; name?: string; instance?: string; secretRef?: string }, kinds: string[], stripped: readonly string[]): string | undefined {
  if (!i.id || !ID.test(i.id)) return "id: use lower-case letters, digits, '-', '_' or '.'";
  if (!i.kind || !kinds.includes(i.kind)) return `kind: one of ${kinds.join(", ")}`;
  if (!i.name?.trim()) return "name is required";
  if (!i.instance?.trim()) return "instance is required";
  return secretRefRefusal(i.secretRef || undefined, stripped);
}

export function linkProblem(l: { id?: string; integrationId?: string; externalId?: string; level?: string; repos?: string[] }): string | undefined {
  if (!l.id || !ID.test(l.id)) return "id: use lower-case letters, digits, '-', '_' or '.'";
  if (!l.integrationId) return "integration is required";
  if (!l.externalId?.trim()) return "the external place is required";
  if (!["notify", "ask", "work"].includes(l.level ?? "")) return "level: notify, ask or work";
  if (l.level === "work" && !l.repos?.length) return "a work link needs at least one repo";
  return undefined;
}
