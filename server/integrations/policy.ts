// The account policy's CLI door (docs/integrations/POLICY.md): every `orca <kind> <verb>` that uses a
// connected account picks it here and passes the ONE access check (shared/integrations.ts
// integrationAccessRefusal) before it runs. Adapter verbs (send, delete) are checked in publish and
// the dispatcher; this is the same decision for the CLI.
import { integrationAccessRefusal, pickAccount, type AdapterKind } from "../../shared/integrations";
import type { Connection } from "./adapter";
import * as registry from "./registry";
import * as store from "./store";

export class PolicyError extends Error {}

/** The account `orca <kind> <verb> [--account <id or name>]` uses, after the access check. Throws a
 *  PolicyError the model can act on. Undefined when no account of the kind is connected: the verb
 *  keeps its old path (the token from the bridge's environment), so a setup with no row still works. */
export async function useAccount(kind: AdapterKind, verb: string, account?: unknown): Promise<Connection | undefined> {
  const want = typeof account === "string" ? account : undefined;
  if (account !== undefined && !want?.trim()) throw new PolicyError(`--account needs an account id or name (orca channels lists the ${kind} accounts)`);
  const { account: c, error } = pickAccount(await store.integrations(), kind, want);
  if (error) throw new PolicyError(error);
  if (!c) return undefined;
  const refusal = integrationAccessRefusal(c, verb, registry.verbsFor(kind));
  if (refusal) throw new PolicyError(refusal);
  return c;
}

/** The environment a CLI tool reads, with the account's token in the variable the tool expects:
 *  the row's `secretRef` value as `tokenVar`, plus `extra` (an account id from its config). No row:
 *  the bridge's own environment, unchanged. The value is read here and never printed or logged. */
export function accountEnv(c: Connection | undefined, tokenVar: string, extra: Record<string, string | undefined> = {}, env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  if (!c) return env;
  const set = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
  return { ...env, ...(c.secretRef ? { [tokenVar]: env[c.secretRef] } : {}), ...set };
}
