// An integration's secret: the variable its `secret_ref` names, else an Orca stored secret of the
// same name (server/secrets.ts; `orca secret`, a form's secret field, the composer's /secret). Shared
// plumbing for every adapter, kept apart from the registry so another branch can reuse it as is.
// The env var wins, so an existing setup does not change. A stored secret is looked up in the
// `integrations` scope first, then the default scope. Only the bridge reads a value: agents get
// neither the env var (env.ts strips ORCA_SECRET_*) nor the store's key.
import * as secrets from "../secrets";

/** The scope Orca's own integration secrets go in (the Gmail refresh token, a stored client secret). */
export const INTEGRATION_SCOPE = "integrations";

const storedRefs = (ref: string): string[] => [`${INTEGRATION_SCOPE}/${ref}`, ref];

/** The value, synchronously: the env var, else the scrub cache of stored secrets (refreshed each
 *  minute and at once on a store). For the registry's checks and `AdapterContext.secret()`. */
export function secretValue(ref: string | undefined, env: Record<string, string | undefined> = process.env): string | undefined {
  if (!ref) return undefined;
  if (env[ref]) return env[ref];
  for (const r of storedRefs(ref)) { const v = secrets.cachedValue(r); if (v) return v; }
  return undefined;
}

/** The value, from the env var or the database (not the cache), and where it came from. Undefined
 *  when neither has it. Throws a SecretError for a stored secret this bridge cannot decrypt. */
export async function resolveSecret(ref: string | undefined, env: Record<string, string | undefined> = process.env): Promise<{ value: string; source: "env" | "stored" } | undefined> {
  if (!ref) return undefined;
  if (env[ref]) return { value: env[ref]!, source: "env" };
  for (const r of storedRefs(ref)) {
    try { return { value: await secrets.valueOf(r), source: "stored" }; }
    catch (e) { if (!(e instanceof secrets.SecretError) || e.status !== 404) throw e; }
  }
  return undefined;
}
