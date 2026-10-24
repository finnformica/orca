// Where an integration's secret comes from (docs/integrations/ADAPTERS.md "Secrets"). A row's
// secret_ref — and any config key ending in `Ref` (Slack's `appTokenRef`) — is an environment variable name, or `secret:<name>` for a value in Orca's
// encrypted secret store (server/secrets.ts). The registry decrypts every stored ref of a row when
// it starts the adapter (`load`), keeps the values HERE, in this process's memory only, and starts
// the adapter again when a stored value changes (`stale`: rotation). An adapter reads every secret
// through `secretValue(ref)`, never `process.env` directly, so both forms work everywhere.
// Nothing here writes a value to a file, a log, the environment or an agent's spawn.
import * as db from "../db";
import * as secrets from "../secrets";
import { storedSecretName } from "../../shared/integrations";
import type { Connection } from "./adapter";

type Loaded = { value: string; updatedAt: number };
const loaded = new Map<string, Loaded>(); // stored name as the ref gives it → value

/** The value a ref names: the environment variable, or the stored secret this process loaded. */
export function secretValue(ref: string | undefined | null, env: Record<string, string | undefined> = process.env): string | undefined {
  if (!ref) return undefined;
  const name = storedSecretName(ref);
  if (name !== undefined) return loaded.get(name)?.value;
  return env[ref] || undefined;
}

/** Every secret ref a row names: its secret_ref, then each config string under a key ending in
 *  `Ref`, nested objects included. Pure. */
export function refsOf(c: Pick<Connection, "secretRef" | "config">): string[] {
  const out: string[] = c.secretRef ? [c.secretRef] : [];
  const walk = (o: unknown, depth: number): void => {
    if (!o || typeof o !== "object" || depth > 3) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === "string" && /Ref$/i.test(k) && v.trim()) out.push(v.trim());
      else if (v && typeof v === "object" && !Array.isArray(v)) walk(v, depth + 1);
    }
  };
  walk(c.config, 0);
  return [...new Set(out)];
}

/** The stored names among a row's refs. Pure. */
export const storedNames = (c: Pick<Connection, "secretRef" | "config">): string[] =>
  refsOf(c).map(storedSecretName).filter((n): n is string => !!n);

/** Decrypt every stored secret a row names into this process's memory. One audit row per secret
 *  (secrets.reveal). Throws when one is missing or was stored with another key. */
export async function load(c: Pick<Connection, "id" | "kind" | "secretRef" | "config">): Promise<void> {
  for (const name of storedNames(c)) {
    const row = await secrets.resolve(name);
    const value = await secrets.reveal(name, `integration ${c.id}`, c.kind);
    loaded.set(name, { value, updatedAt: row.updatedAt });
  }
}

/** Load a row's stored secrets that this process has not loaded yet, or that changed since (an
 *  `orca <kind>` verb on a bridge that does not run the adapter: policy.useAccount). No stored
 *  secret: nothing to do, no query. */
export async function ensureLoaded(c: Pick<Connection, "id" | "kind" | "secretRef" | "config">): Promise<void> {
  const names = storedNames(c);
  if (!names.length) return;
  if (names.some((n) => !loaded.has(n)) || await stale(c)) await load(c);
}

/** The stored secrets this bridge can decrypt, by every name a ref may use (`name`, `scope/name`). */
export async function readable(): Promise<Set<string>> {
  const rows = await db.secrets();
  if (!rows.length) return new Set();
  const key = secrets.keyInfo().id;
  return new Set(rows.filter((r) => r.keyId === key).flatMap((r) => [r.name, `${r.scope}/${r.name}`]));
}

/** Whether a stored secret of the row changed (rotated or deleted) since `load`. One query per call. */
export async function stale(c: Pick<Connection, "secretRef" | "config">, rows?: db.SecretRow[]): Promise<boolean> {
  const names = storedNames(c);
  if (!names.length) return false;
  const all = rows ?? await db.secrets();
  return names.some((n) => {
    const slash = n.indexOf("/");
    const row = all.find((r) => (slash > 0 ? r.scope === n.slice(0, slash) && r.name === n.slice(slash + 1) : r.name === n));
    return !row || row.updatedAt !== loaded.get(n)?.updatedAt;
  });
}

/** Forget every loaded value (tests). */
export function clear(): void { loaded.clear(); }
