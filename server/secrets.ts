// The secret store: values the user gave through a form's secret field (server/forms.ts) or the
// composer's paste guard, kept so an agent can USE them without seeing them.
//
// Security model (also in docs/secrets.md):
// - A value is stored only as AES-256-GCM ciphertext in Postgres (`secret`). The key comes from
//   ORCA_SECRETS_KEY, else from `<state dir>/secrets.key` (made on first use, mode 0600). The key is
//   in ORCA_SECRETS (server/env.ts), so no agent's environment has it.
// - An agent gets names only: `orca secret list` (names, scope, dates), and a value goes straight from
//   here into ONE command it names — on stdin (`pipe`) or in that command's env (`env`). The command
//   runs in the bridge, and its output comes back scrubbed.
// - `scrub` replaces every stored value with `[secret <ref>]` in tool output, transcripts, turns and
//   outbound channel posts. It reads an in-memory cache of the values this bridge can decrypt.
// - Every store, use and delete writes one audit row (`secret_use`: who, command name, when).
// What it is NOT: a sandbox. An agent with a shell as the same OS user can read the key file, and a
// command it names can transform a value (base64) so the scrub misses it. The store keeps values out
// of the model's context and the logs; the owner-only grant on `orca secret` limits who can name one.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as db from "./db";
import { agentEnv } from "./env";
import { stateDir, statePath } from "./state";
import { DEFAULT_SECRET_SCOPE, SCOPE, secretRef } from "../shared/forms";
import { scrubDeep, scrubSecrets } from "../shared/secretGuard";

export const SECRETS_KEY_ENV = "ORCA_SECRETS_KEY";
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
/** How long one `orca secret pipe|env` command may run. */
export const SECRET_RUN_TIMEOUT_MS = 10 * 60_000;
/** The output of one command that comes back to the agent (the tail). */
export const SECRET_OUTPUT_MAX = 64 * 1024;

export class SecretError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// ---- the key ----

type Key = { bytes: Buffer; id: string; source: "env" | "file" };
let cachedKey: Key | undefined;
let cachedKeyPath: string | undefined;

/** The 32-byte key: ORCA_SECRETS_KEY (base64 of 32 bytes, or any text, hashed), else the state dir's
 *  `secrets.key`, made on first use. Logged once when it is made, with its path. */
export function key(): Key {
  const env = process.env[SECRETS_KEY_ENV]?.trim();
  const from = (raw: string, source: Key["source"]): Key => {
    const b64 = Buffer.from(raw, "base64");
    const bytes = b64.length === 32 && /^[A-Za-z0-9+/=]+$/.test(raw) ? b64 : createHash("sha256").update(raw).digest();
    return { bytes, id: createHash("sha256").update(bytes).digest("hex").slice(0, 12), source };
  };
  if (env) {
    if (cachedKey?.source !== "env" || cachedKey.id !== from(env, "env").id) cachedKey = from(env, "env");
    return cachedKey;
  }
  const path = keyPath();
  if (cachedKey?.source === "file" && cachedKeyPath === path && existsSync(path)) return cachedKey;
  if (!existsSync(path)) {
    writeFileSync(path, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
    console.log(`[secrets] made a new secret store key in ${path} (mode 0600). Set ${SECRETS_KEY_ENV} to its content on every instance that must read these secrets.`);
  }
  try { if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600); } catch { /* best effort */ }
  cachedKey = from(readFileSync(path, "utf8").trim(), "file");
  cachedKeyPath = path;
  return cachedKey;
}

export const keyPath = (): string => statePath("secrets.key");

/** Where the key comes from, for `orca secret list` and /api/config: never the key itself. */
export function keyInfo(): { id: string; source: string } {
  const k = key();
  return { id: k.id, source: k.source === "env" ? SECRETS_KEY_ENV : keyPath() };
}

/** `v1:<iv>:<tag>:<ciphertext>`, base64 parts. */
export function encrypt(value: string, k: Key = key()): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k.bytes, iv);
  const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(blob: string, k: Key = key()): string {
  const [v, iv, tag, ct] = blob.split(":");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new SecretError("the stored secret is not in a known format");
  const d = createDecipheriv("aes-256-gcm", k.bytes, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

// ---- the scrub cache ----

let cache: { ref: string; value: string }[] = [];
let cacheAt = 0;

/** Read every value this bridge's key can decrypt into the scrub cache. A secret stored with
 *  another instance's key is skipped (that instance scrubs it). Never throws. */
export async function refresh(): Promise<void> {
  try {
    const k = key();
    const rows = await db.secretCiphers();
    const next: typeof cache = [];
    for (const r of rows) {
      if (r.keyId !== k.id) continue;
      try { next.push({ ref: secretRef(r.scope, r.name), value: decrypt(r.ciphertext, k) }); } catch { /* a damaged row: skip */ }
    }
    cache = next;
    cacheAt = Date.now();
  } catch (e) {
    if (!db.isDbError(e)) console.error(`[secrets] refresh: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** When the cache was last read (0: never). */
export const cachedAt = (): number => cacheAt;

/** `text` with every stored value replaced by `[secret <ref>]`. Synchronous, from the cache. */
export const scrub = (text: string): string => scrubSecrets(text, cache);
export const scrubValue = <T>(value: T): T => scrubDeep(value, cache);

/** Keep the cache fresh: at once when the database is reachable, then every minute (another
 *  instance may store one). Started by server/index.ts. */
export function startScrubCache(everyMs = 60_000): () => void {
  const off = db.onAvailable(() => refresh());
  const timer = setInterval(() => void refresh(), everyMs);
  timer.unref?.();
  return () => { off(); clearInterval(timer); };
}

// ---- store, list, delete ----

/** `scope/name` or `name` → the secret. A bare name in two scopes is ambiguous. */
export async function resolve(ref: string): Promise<db.SecretRow & { ciphertext: string }> {
  const r = ref.trim();
  if (!r) throw new SecretError("name the secret: orca secret list shows them");
  const rows = await db.secretCiphers();
  const slash = r.indexOf("/");
  const hits = slash > 0 ? rows.filter((x) => x.scope === r.slice(0, slash) && x.name === r.slice(slash + 1)) : rows.filter((x) => x.name === r);
  if (!hits.length) throw new SecretError(`no secret "${r}" (orca secret list shows them)`, 404);
  if (hits.length > 1) throw new SecretError(`"${r}" is in more than one scope: name one of ${hits.map((h) => secretRef(h.scope, h.name)).join(", ")}`);
  return hits[0]!;
}

/** Store (or replace) a value. `who` and `source` go to the audit. Returns the reference agents use. */
export async function store(input: { scope?: string; name: string; value: string; who: string; source?: string }): Promise<{ ref: string; created: boolean }> {
  const scope = input.scope?.trim() || DEFAULT_SECRET_SCOPE;
  const name = input.name.trim();
  if (!NAME.test(name)) throw new SecretError(`secret name "${name}" must start with a letter or "_" and use only letters, digits, "_", "." or "-" (at most 64)`);
  if (!SCOPE.test(scope)) throw new SecretError(`secret scope "${scope}" must be 1-64 letters, digits, "_", "." or "-"`);
  if (typeof input.value !== "string" || !input.value) throw new SecretError("the secret value is empty");
  const k = key();
  const created = await db.putSecret({ scope, name, ciphertext: encrypt(input.value, k), keyId: k.id, source: input.source });
  await db.addSecretUse({ scope, name, action: "store", who: input.who, at: Date.now() });
  // At once, not at the next refresh: the next output that echoes it must already be scrubbed.
  cache = [...cache.filter((c) => c.ref !== secretRef(scope, name)), { ref: secretRef(scope, name), value: input.value }];
  return { ref: secretRef(scope, name), created };
}

export async function list(): Promise<db.SecretRow[]> {
  return db.secrets();
}

export async function remove(ref: string, who: string): Promise<string> {
  const s = await resolve(ref);
  await db.deleteSecret(s.scope, s.name);
  await db.addSecretUse({ scope: s.scope, name: s.name, action: "delete", who, at: Date.now() });
  const name = secretRef(s.scope, s.name);
  cache = cache.filter((c) => c.ref !== name);
  return name;
}

const when = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "never");

/** `orca secret list`: one line per secret, never a value. */
export function listText(rows: db.SecretRow[], k = keyInfo()): string {
  if (!rows.length) return `No stored secrets. (key ${k.id}, from ${k.source})`;
  return [
    ...rows.map((r) => `${secretRef(r.scope, r.name)} · scope ${r.scope} · created ${when(r.createdAt)} · last used ${when(r.lastUsedAt)}${r.source ? ` · from ${r.source}` : ""}${r.keyId !== k.id ? ` · stored with another key (${r.keyId}): this bridge cannot use it` : ""}`),
    `(key ${k.id}, from ${k.source})`,
  ].join("\n");
}

/** The value of one stored secret, for the bridge's own use (an integration's token). It never
 *  leaves the bridge, so it writes no audit row; the store and the delete do. Throws a SecretError
 *  when the secret is missing or was stored with another instance's key. */
export async function valueOf(ref: string): Promise<string> {
  const s = await resolve(ref);
  const k = key();
  if (s.keyId !== k.id) throw new SecretError(`"${secretRef(s.scope, s.name)}" was stored with key ${s.keyId}, but this bridge has key ${k.id}. Set ${SECRETS_KEY_ENV} to the same key on every instance.`);
  return decrypt(s.ciphertext, k);
}

// ---- use ----

/** A stored value for a BRIDGE-side caller only (an integration's token, `secret:<name>`:
 *  server/integrations/secretRefs.ts). It never goes to an agent, an env file or a log; the caller keeps it in memory.
 *  One audit row per call (`action` "integration", `command` = what used it). */
export async function reveal(ref: string, who: string, use: string): Promise<string> {
  const s = await resolve(ref);
  const k = key();
  if (s.keyId !== k.id) throw new SecretError(`"${secretRef(s.scope, s.name)}" was stored with key ${s.keyId}, but this bridge has key ${k.id}. Run it on the instance that stored it, or set ${SECRETS_KEY_ENV} to the same key on every instance.`);
  const value = decrypt(s.ciphertext, k);
  await db.addSecretUse({ scope: s.scope, name: s.name, action: "integration", command: use, who, at: Date.now() });
  return value;
}

/** The env variable for `env <name>[=VAR]`: VAR, else the name in capitals ("openai-key" → OPENAI_KEY). */
export function envVarFor(spec: string): { ref: string; variable: string } {
  const eq = spec.indexOf("=");
  const ref = eq > 0 ? spec.slice(0, eq) : spec;
  const variable = eq > 0 ? spec.slice(eq + 1) : (ref.split("/").pop() ?? ref).replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new SecretError(`"${variable}" is not a valid environment variable name`);
  return { ref, variable };
}

/** Run ONE command with a secret on its stdin (`pipe`) or in its env (`env`), in `cwd`, with an
 *  agent's scrubbed environment. The value never comes back: the output is scrubbed of every stored
 *  value (this one included). One audit row per run. */
export async function run(input: { ref: string; mode: "pipe" | "env"; variable?: string; cmd: string[]; cwd?: string; who: string; timeoutMs?: number }): Promise<{ exitCode: number; output: string; ref: string }> {
  if (!input.cmd.length || !input.cmd[0]) throw new SecretError(`the command is required: orca secret ${input.mode} <name>${input.mode === "env" ? "[=VAR]" : ""} -- <command…>`);
  const s = await resolve(input.ref);
  const k = key();
  if (s.keyId !== k.id) throw new SecretError(`"${secretRef(s.scope, s.name)}" was stored with key ${s.keyId}, but this bridge has key ${k.id}. Set ${SECRETS_KEY_ENV} to the same key on every instance.`);
  const value = decrypt(s.ciphertext, k);
  const ref = secretRef(s.scope, s.name);
  const cwd = input.cwd && existsSync(input.cwd) ? input.cwd : join(stateDir(), "secrets-run");
  mkdirSync(cwd, { recursive: true });
  await db.addSecretUse({ scope: s.scope, name: s.name, action: input.mode, command: basename(input.cmd[0]), who: input.who, at: Date.now() });
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(input.cmd, {
      cwd,
      env: agentEnv(input.mode === "env" ? { [input.variable!]: value } : {}),
      stdin: input.mode === "pipe" ? new TextEncoder().encode(value) : "ignore",
      stdout: "pipe", stderr: "pipe",
    });
  } catch (e) {
    throw new SecretError(`could not start ${basename(input.cmd[0])}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const timer = setTimeout(() => proc.kill(), input.timeoutMs ?? SECRET_RUN_TIMEOUT_MS);
  const [out, err, exitCode] = await Promise.all([Bun.readableStreamToText(proc.stdout as ReadableStream), Bun.readableStreamToText(proc.stderr as ReadableStream), proc.exited]);
  clearTimeout(timer);
  const both = [out, err].filter(Boolean).join(out && err && !out.endsWith("\n") ? "\n" : "");
  const tail = both.length > SECRET_OUTPUT_MAX ? `…(output cut to the last ${SECRET_OUTPUT_MAX} characters)…\n${both.slice(-SECRET_OUTPUT_MAX)}` : both;
  // This value first (a secret from another key is not in the cache), then every cached one.
  return { exitCode, ref, output: scrub(scrubSecrets(tail, [{ ref, value }])) };
}
