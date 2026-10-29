// Subscription usage for Claude and Codex, fetched from each installed CLI's existing login.
// Both paths are read-only: Claude uses its OAuth usage endpoint; Codex uses its local app server.
import { createHash } from "crypto";
import { homedir, tmpdir } from "os";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { markDown, reachable } from "./peer";
import { scrubbedEnv } from "./env";
import { runCmd, withTimeout } from "./run";
import type { LimitLogin } from "../shared/agent";

/** A binary on the LIVE PATH, not Bun's startup snapshot — the test PATH shim (a fake `hydra`,
 *  `codex`) relies on it, the same way run.ts passes the live env for the fake `gh`. */
const which = (name: string): string | null => Bun.which(name, { PATH: process.env.PATH ?? "" });

// Overridable so a test can point at canned readings (`{token}` in the override stands in for the
// login's token, so each profile gets its own) — the real endpoint otherwise.
const claudeUsageUrl = (token: string) => (process.env.ORCA_CLAUDE_USAGE_URL || "https://api.anthropic.com/api/oauth/usage").replace("{token}", token);

export type UsageWindow = { utilization: number; resetsAt: string | null };
// Pay-as-you-go "extra usage" spend (only present when you've enabled it on your plan). Money is
// carried in MINOR units (pence/cents) + exponent so the client formats it exactly, no float drift.
export type ExtraUsage = { usedMinor: number; limitMinor: number; currency: string; exponent: number; utilization: number };
/** `fable` is the per-model weekly window (only hydra's `limits[]` parse exposes it); null/absent
 *  when the account has none or the reading came from the bare endpoint shape. */
export type ClaudeUsage = { fiveHour: UsageWindow; sevenDay: UsageWindow; extra: ExtraUsage | null; fable?: UsageWindow | null };
export type CodexUsageWindow = UsageWindow & { label: string; durationMinutes: number | null };
export type CodexUsage = { windows: CodexUsageWindow[] };
/** One Claude login as hydra reports it. `usage` is null with no reading yet (not signed in on this
 *  machine, or never fetched); `state` is hydra's verdict — "ok", "disabled", "exhausted", "locked",
 *  "token stale — refreshes on next launch", "no usage data yet", "not signed in on this machine".
 *  `fetchedAt` (ms, null if never fetched) is hydra's own `fetched_at` — the freshness signal
 *  `mergeInstanceProfiles` picks the live reading by, since usage belongs to the Claude ACCOUNT, not
 *  whichever host happened to answer. `instance`/`hosts` are set only on a MERGED profile (below):
 *  which host's reading was picked, and every host that reported this account with ITS state, so the
 *  card can show a stale host as a secondary hint and point Refresh at it specifically. */
export type ProfileUsage = {
  name: string; usage: ClaudeUsage | null; state?: string; email?: string; fetchedAt?: number | null;
  instance?: string; hosts?: { instance: string; state?: string }[];
};
/** Whether Claude launches are actually being routed. `hydra`: installed on the bridge's PATH.
 *  `shim`: the `claude` the bridge resolves is hydra's shim — the thing that routes a headless
 *  `claude -p`. Claude Code's own updater rewrites `~/.local/bin/claude`, which silently removes the
 *  shim and sends every run to the default login; this is how that becomes visible. `bin`: the real
 *  binary hydra would exec (`hydra bin`). */
export type Routing = { hydra: boolean; shim: boolean; bin?: string };
/** `claude` is the first login's usage (back-compat for the single-login meter); `profiles` is every
 *  login hydra knows, present only when hydra is installed. */
export type Usage = { claude: ClaudeUsage | null; codex: CodexUsage | null; profiles?: ProfileUsage[]; routing?: Routing };

/** Shape the raw Anthropic endpoint payload into the windows + extra-usage spend we surface. Pure. */
export function shapeUsage(raw: any): ClaudeUsage {
  const win = (w: any): UsageWindow => ({
    utilization: Math.max(0, Math.min(100, Math.round(Number(w?.utilization) || 0))),
    resetsAt: typeof w?.resets_at === "string" ? w.resets_at : null,
  });
  const eu = raw?.extra_usage;
  const extra: ExtraUsage | null = eu && eu.is_enabled && !eu.disabled_reason ? {
    usedMinor: Math.max(0, Math.round(Number(eu.used_credits) || 0)),
    limitMinor: Math.max(0, Math.round(Number(eu.monthly_limit) || 0)),
    currency: typeof eu.currency === "string" ? eu.currency : "USD",
    exponent: Number.isInteger(eu.decimal_places) ? eu.decimal_places : 2,
    utilization: Math.max(0, Math.min(100, Math.round(Number(eu.utilization) || 0))),
  } : null;
  return { fiveHour: win(raw?.five_hour), sevenDay: win(raw?.seven_day), extra };
}

function codexWindowLabel(minutes: number | null, fallback: string): string {
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "wk";
  if (minutes === 1_440) return "day";
  if (minutes && minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return fallback;
}

/** Shape Codex app-server rate limits into percentage windows suitable for the mini chart. Pure. */
export function shapeCodexUsage(rateRaw: any): CodexUsage | null {
  const snapshot = rateRaw?.rateLimits;
  const windows = ([snapshot?.primary, snapshot?.secondary] as any[])
    .map((window, index): CodexUsageWindow | null => {
      if (!window || !Number.isFinite(Number(window.usedPercent))) return null;
      const durationMinutes = Number.isFinite(Number(window.windowDurationMins)) ? Number(window.windowDurationMins) : null;
      const resetSeconds = Number(window.resetsAt);
      return {
        label: codexWindowLabel(durationMinutes, index === 0 ? "limit" : "limit2"),
        durationMinutes,
        utilization: Math.max(0, Math.min(100, Math.round(Number(window.usedPercent)))),
        resetsAt: Number.isFinite(resetSeconds) && resetSeconds > 0 ? new Date(resetSeconds * 1000).toISOString() : null,
      };
    })
    .filter((window): window is CodexUsageWindow => window !== null);
  return windows.length ? { windows } : null;
}

/** Shape `hydra status --json` into per-profile usage. Pure. hydra's buckets carry `pct` (int or
 *  null) and `resets` (epoch SECONDS, or null); a null bucket means the account has no such window.
 *  A profile with no session reading has `usage: null` but keeps its `state`, so the meter can still
 *  say why (disabled / not signed in here / no data yet). */
export function shapeHydraStatus(raw: any): ProfileUsage[] {
  const win = (b: any): UsageWindow | null => b && typeof b === "object" ? {
    utilization: Math.max(0, Math.min(100, Math.round(Number(b.pct) || 0))),
    resetsAt: Number.isFinite(Number(b.resets)) && Number(b.resets) > 0 ? new Date(Number(b.resets) * 1000).toISOString() : null,
  } : null;
  const zero: UsageWindow = { utilization: 0, resetsAt: null };
  const profiles = Array.isArray(raw?.profiles) ? raw.profiles : [];
  return profiles
    .filter((p: any) => p && typeof p.name === "string")
    .map((p: any): ProfileUsage => {
      const session = win(p.session);
      const usage: ClaudeUsage | null = session
        ? { fiveHour: session, sevenDay: win(p.weekly) ?? zero, extra: null, fable: win(p.fable) }
        : null;
      const fetchedAt = Number.isFinite(Number(p.fetched_at)) && Number(p.fetched_at) > 0 ? Number(p.fetched_at) * 1000 : null;
      return { name: p.name, usage, state: typeof p.state === "string" ? p.state : undefined, email: typeof p.email === "string" && p.email ? p.email : undefined, fetchedAt };
    });
}

/** One instance's hydra profiles, as gathered for the merge below. */
export type InstanceProfiles = { instance: string; profiles: ProfileUsage[] };

/** Merge every instance's hydra profiles into one row per Claude account (matched by email — a
 *  profile with no email, "not signed in on this machine", has nothing to match on, so it stays
 *  keyed to its own instance+name). The freshest OK reading (hydra's `fetchedAt`) wins: usage is the
 *  account's, not the host's, so the meter must not keep showing a host it happens to be talking to
 *  over a fresher reading from wherever the account actually ran. When no instance has an OK reading
 *  for an account, falls back to `preferred` (the instance that runs agents, so a login's rotation
 *  state there is what actually matters) if it reported anything, else the freshest reading of any
 *  state, else whichever came first. Every host that reported the account is kept on `hosts` — the
 *  card's secondary hint ("stale on local") and what Refresh/the rotation switch should target, since
 *  that state is genuinely per-host even though the usage numbers are not. Pure. */
export function mergeInstanceProfiles(byInstance: InstanceProfiles[], preferred?: string): ProfileUsage[] {
  type Entry = { instance: string; profile: ProfileUsage };
  const order: string[] = [];
  const groups = new Map<string, Entry[]>();
  for (const { instance, profiles } of byInstance) {
    for (const profile of profiles) {
      const key = profile.email || `${instance}:${profile.name}`;
      if (!groups.has(key)) { groups.set(key, []); order.push(key); }
      groups.get(key)!.push({ instance, profile });
    }
  }
  const freshest = (list: Entry[]): Entry | undefined =>
    list.reduce<Entry | undefined>((best, e) => (!best || (e.profile.fetchedAt ?? 0) > (best.profile.fetchedAt ?? 0) ? e : best), undefined);
  return order.map((key) => {
    const entries = groups.get(key)!;
    const ok = entries.filter((e) => e.profile.state === "ok" && e.profile.usage);
    const preferredEntry = preferred ? entries.find((e) => e.instance === preferred && e.profile.usage) : undefined;
    const chosen = freshest(ok) ?? preferredEntry ?? freshest(entries) ?? entries[0]!;
    const hosts = entries.map((e) => ({ instance: e.instance, state: e.profile.state }));
    return { ...chosen.profile, instance: chosen.instance, hosts };
  });
}

/** `GET /api/usage`'s cross-instance reading: this host's own `usage()` plus every OTHER configured
 *  instance's (`GET /api/usage/local`, never merged itself — see server/index.ts), merged by account.
 *  An unreachable or erroring peer is dropped, not awaited past its own failure — usage still shows
 *  from whoever answered. Codex and routing stay this host's own: neither is meaningfully shared
 *  across instances the way a Claude login's usage is. */
/** How long the merge waits for a reachable peer's own reading before showing this host's alone. */
export const PEER_USAGE_MS = 10_000;

export async function usageAcrossInstances(instances: Record<string, string> | undefined, self: string, preferred?: string): Promise<Usage | null> {
  const peers = Object.entries(instances ?? {}).filter(([name]) => name !== self);
  const [local, remote] = await Promise.all([
    usage(),
    Promise.all(peers.map(async ([instance, base]): Promise<InstanceProfiles | null> => {
      try {
        // An offline peer black-holes the connect: probe first (2s once, then cached), and bound the
        // answer — the peer runs hydra itself, which has its own 15s cap.
        if (!(await reachable(base))) return null;
        const res = await withTimeout(fetch(new URL("/api/usage/local", base)), PEER_USAGE_MS, "peer usage timed out")
          .catch((e) => { markDown(base); throw e; });
        if (!res.ok) return null;
        const data = (await res.json()) as Usage | null;
        return data?.profiles ? { instance, profiles: data.profiles } : null;
      } catch {
        return null;
      }
    })),
  ]);
  const byInstance: InstanceProfiles[] = [];
  if (local?.profiles) byInstance.push({ instance: self, profiles: local.profiles });
  for (const r of remote) if (r) byInstance.push(r);
  if (!byInstance.length) return local;
  const merged = mergeInstanceProfiles(byInstance, preferred);
  return { claude: merged.find((p) => p.usage)?.usage ?? local?.claude ?? null, codex: local?.codex ?? null, profiles: merged, ...(local?.routing ? { routing: local.routing } : {}) };
}

/** hydra's shim announces itself with a marker in its header; the real binary has none. Pure. */
export const isHydraShim = (head: string): boolean => head.includes("hydra-shim");

/** Is Claude routing live on this host? Reads only the first 512 bytes of whatever `claude`
 *  resolves to (the real binary is large), and asks `hydra bin` for the target. Never throws. */
export async function routingInfo(): Promise<Routing> {
  const hydra = which("hydra");
  const claude = which("claude");
  let shim = false;
  if (claude) {
    try { shim = isHydraShim(await Bun.file(claude).slice(0, 512).text()); } catch { shim = false; }
  }
  let bin: string | undefined;
  if (hydra) {
    try {
      const { stdout: out, code } = await runCmd([hydra, "bin"], { timeoutMs: 5_000, allowFail: true });
      if (code === 0 && out.trim()) bin = out.trim();
    } catch { /* advisory */ }
  }
  return { hydra: Boolean(hydra), shim, ...(bin ? { bin } : {}) };
}

// The last good hydra reading, so a slow or failed call (hydra refreshes stale profiles on this
// call, bounded by its own curl timeout) keeps the meter on the previous numbers rather than blank.
let lastGoodHydra: ProfileUsage[] | null = null;

/** Every Claude login's usage via hydra (`hydra status --json`), or null when hydra isn't installed
 *  or the call fails — the caller then falls back to the single default login. Never throws. */
export async function hydraUsage(): Promise<ProfileUsage[] | null> {
  // Live PATH, not Bun's startup snapshot — the test PATH shim (a fake `hydra`) relies on it, the same
  // way run.ts passes env for the fake `gh`.
  const hydra = which("hydra");
  if (!hydra) return null;
  try {
    const { stdout: out, code } = await runCmd([hydra, "status", "--json"], { timeoutMs: 15_000, allowFail: true });
    if (code !== 0) return lastGoodHydra;
    const shaped = shapeHydraStatus(JSON.parse(out));
    if (shaped.length) lastGoodHydra = shaped;
    return lastGoodHydra;
  } catch (error) {
    console.error("[usage] hydra status failed:", error instanceof Error ? error.message : error);
    return lastGoodHydra;
  }
}

/** The logins as a usage-limit retry reads them (`shared/agent.ts` `limitPlan`): enabled = signed
 *  in and not disabled; each window's percent and reset (epoch ms). Pure. */
export function limitLogins(raw: any): LimitLogin[] {
  const profiles = Array.isArray(raw?.profiles) ? raw.profiles : [];
  const win = (b: any) => b && typeof b === "object"
    ? [{ pct: Number(b.pct) || 0, resetsAt: Number(b.resets) > 0 ? Number(b.resets) * 1000 : null }] : [];
  return profiles.filter((p: any) => p && typeof p.name === "string").map((p: any): LimitLogin => ({
    name: p.name, enabled: p.disabled !== true && p.signed_in !== false,
    windows: [...win(p.session), ...win(p.weekly), ...win(p.fable)],
  }));
}

/** What hydra says after a run hit its login's limit: the login its next launch takes (`hydra pick`,
 *  for the run's model) and every login's resets. The failed login's reading is refreshed first, so
 *  hydra sees the limit. Read only: hydra keeps the choice of login. No hydra: no pick, no logins. */
export async function limitReading(failed: string | undefined, model?: string): Promise<{ pick?: string; logins: LimitLogin[] }> {
  const hydra = which("hydra");
  if (!hydra) return { logins: [] };
  const read = async (args: string[]) => {
    const { stdout, code } = await runCmd([hydra, ...args], { timeoutMs: 20_000, allowFail: true });
    if (code !== 0) return undefined;
    try { return JSON.parse(stdout); } catch { return undefined; }
  };
  try {
    if (failed) await runCmd([hydra, "refresh", "--force", failed], { timeoutMs: 20_000, allowFail: true });
    const logins = limitLogins(await read(["status", "--json"]));
    const pick = await read(["pick", "--json", ...(model ? ["--model", model] : [])]);
    return { ...(typeof pick?.name === "string" ? { pick: pick.name } : {}), logins };
  } catch (error) {
    console.error("[usage] hydra limit reading failed:", error instanceof Error ? error.message : error);
    return { logins: [] };
  }
}

/** Take a hydra login out of its rotation (`enabled: false`) or put it back (`true`) — `hydra
 *  disable|enable <name>`. Keeps the login signed in; it just stops being a launch target. Refuses
 *  a name hydra doesn't currently report (a stale row, a typo) rather than shelling out with it.
 *  Returns the refreshed profile list so the caller need not poll again to see the new state. */
export async function setProfileEnabled(name: string, enabled: boolean): Promise<ProfileUsage[]> {
  const hydra = which("hydra");
  if (!hydra) throw new Error("hydra is not installed on this host");
  const before = await hydraUsage();
  if (!before?.some((p) => p.name === name)) throw new Error(`"${name}" is not a hydra login on this host`);
  const { stdout: out, stderr: err, code } = await runCmd([hydra, enabled ? "enable" : "disable", name], { timeoutMs: 15_000, allowFail: true });
  if (code !== 0) throw new Error((err || out).trim() || `hydra ${enabled ? "enable" : "disable"} ${name} failed`);
  return (await hydraUsage()) ?? before;
}

/** Flip a login's rotation on EVERY host that has it: here, then each other instance by its own
 *  `/api/usage/profile` (with `instance` set, so the peer applies it to itself and never fans out
 *  again). A host that doesn't know the login is skipped, any other failure surfaces; no host
 *  knowing it is an error. Rotation is per host in hydra, but one account's rotation is one
 *  decision to the user — "disabled on local" beside an enabled cloud was the confusing half-state.
 *  Returns the merged fleet view, as the card reads it. */
export async function setProfileEnabledEverywhere(name: string, enabled: boolean, instances: Record<string, string> | undefined, self: string, preferred?: string): Promise<ProfileUsage[]> {
  const unknown = (msg: string) => /is not a hydra login on this host|hydra is not installed/.test(msg);
  let applied = 0;
  const errors: string[] = [];
  try { await setProfileEnabled(name, enabled); applied++; } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!unknown(msg)) errors.push(`${self}: ${msg}`);
  }
  await Promise.all(Object.entries(instances ?? {}).filter(([n]) => n !== self).map(async ([instance, base]) => {
    try {
      const res = await fetch(new URL("/api/usage/profile", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, enabled, instance }) });
      if (res.ok) { applied++; return; }
      const msg = String(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
      if (!unknown(msg)) errors.push(`${instance}: ${msg}`);
    } catch { /* unreachable peer: its hydra keeps its state; the card's host hint will say so */ }
  }));
  if (errors.length) throw new Error(errors.join("; "));
  if (!applied) throw new Error(`"${name}" is not a hydra login on any host`);
  return (await usageAcrossInstances(instances, self, preferred))?.profiles ?? [];
}

/** What `hydra refresh <name> --force` said about one login: its line is `<name>  <status>`, the
 *  status `ok`, `stale` (the usage endpoint answered 401: the access token lapsed), `rate-limited`
 *  (429), `offline`, `no-auth`, `http-<code>`… — always exit 0, so the line is the only verdict.
 *  Null when the login has no line. Pure. */
export function refreshVerdict(out: string, name: string): string | null {
  for (const line of out.split("\n")) {
    const [n, ...rest] = line.trim().split(/\s+/);
    if (n === name && rest.length) return rest.join(" ");
  }
  return null;
}

export const isStaleState = (state: string | undefined): boolean => Boolean(state?.startsWith("token stale"));

/** The message for a login the renew launch could not fix: its refresh token has gone too, which
 *  only a browser sign-in on that host replaces. */
export const loginNeededMessage = (name: string, host?: string): string =>
  `Still stale after renewing — the refresh token itself has expired. Run "hydra login ${name}"${host ? ` on ${host}` : ""}.`;
export const rateLimitedMessage = (name: string): string =>
  `The usage endpoint is rate-limiting ${name} (429) — its token may be fine; try again in a few minutes.`;

/** How long the renew launch may take before it is killed. */
export const RENEW_TIMEOUT_MS = 60_000;

/** Renew one login's OAuth access token. hydra only READS usage; it never renews a token — Claude
 *  Code does, when it launches. So the renewal is one launch of the real binary under that login
 *  (`hydra exec <name>`, which knows the default profile must run WITHOUT CLAUDE_CONFIG_DIR — and
 *  falls through to a plain launch when one is set, so it is stripped here): a single print turn,
 *  no tools, no MCP, no skills, no session file, on the cheapest model, from a fresh empty temp dir
 *  (never a repo, so no CLAUDE.md is loaded), time-limited, output discarded — neither the reply
 *  nor any credential is read or logged. True when the launch exited 0. */
export async function renewToken(name: string): Promise<boolean> {
  const hydra = which("hydra");
  if (!hydra) return false;
  const cwd = await mkdtemp(join(tmpdir(), "orca-renew-"));
  try {
    const env = scrubbedEnv({ CLAUDE_CONFIG_DIR: undefined });
    const proc = Bun.spawn([hydra, "exec", name, "-p", "--model", "haiku", "--tools", "", "--strict-mcp-config",
      "--disable-slash-commands", "--no-session-persistence", "ok"], { cwd, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), RENEW_TIMEOUT_MS);
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0;
  } catch (error) {
    console.error(`[usage] renewing ${name} failed:`, error instanceof Error ? error.message : error);
    return false;
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

async function hydraRefresh(hydra: string, name: string): Promise<string | null> {
  const { stdout: out, stderr: err, code } = await runCmd([hydra, "refresh", name, "--force"], { timeoutMs: 15_000, allowFail: true });
  if (code !== 0) throw new Error((err || out).trim() || `hydra refresh ${name} --force failed`);
  lastGoodHydra = null; // the re-read after this must be the fresh state, never a cached one
  return refreshVerdict(out, name);
}

// One renewal per login at a time: the Refresh button and the background pass share it.
const renewing = new Map<string, Promise<ProfileUsage[]>>();

/** Fix a "token stale" login — the Refresh button's action (`POST /api/usage/refresh`), and the
 *  background pass's. Re-queries usage (`hydra refresh <name> --force`); if that still finds the
 *  token stale (401), renews it with one minimal launch (`renewToken`) and re-queries. Throws, so
 *  the card says so, when the endpoint rate-limits (429 — a different problem from a stale token)
 *  and when the login is still stale after renewing (its refresh token is gone: `hydra login`).
 *  Refuses a name hydra doesn't currently report, without shelling out. `host` only names the
 *  machine in the login message. */
export async function refreshProfile(name: string, opts: { renew?: (name: string) => Promise<boolean>; host?: string } = {}): Promise<ProfileUsage[]> {
  const hydra = which("hydra");
  if (!hydra) throw new Error("hydra is not installed on this host");
  const before = await hydraUsage();
  if (!before?.some((p) => p.name === name)) throw new Error(`"${name}" is not a hydra login on this host`);
  const inFlight = renewing.get(name);
  if (inFlight) return inFlight;
  const run = (async () => {
    const stateOf = (list: ProfileUsage[] | null) => list?.find((p) => p.name === name)?.state;
    let verdict = await hydraRefresh(hydra, name);
    if (verdict === "rate-limited") throw new Error(rateLimitedMessage(name));
    let after = (await hydraUsage()) ?? before;
    if (verdict !== "stale" && !isStaleState(stateOf(after))) return after;
    await (opts.renew ?? renewToken)(name);
    verdict = await hydraRefresh(hydra, name);
    if (verdict === "rate-limited") throw new Error(rateLimitedMessage(name));
    after = (await hydraUsage()) ?? after;
    if (verdict === "stale" || isStaleState(stateOf(after))) throw new Error(loginNeededMessage(name, opts.host));
    return after;
  })();
  renewing.set(name, run);
  try { return await run; } finally { renewing.delete(name); }
}

/** How often the primary bridge renews this host's stale logins (`renewStaleLogins`). */
export const RENEW_POLL_MS = 30 * 60_000;

/** The background half of the fix: every login on THIS host that hydra reads as "token stale" —
 *  enabled ones only (hydra reports a disabled login as "disabled" before it would say stale, and
 *  rotation never picks it) — is renewed like the Refresh button does, so hydra's rotation never
 *  routes a launch to a login whose token lapsed overnight. Only where `held()` (the instance's
 *  primary bridge — one renewer per host); each instance renews its own logins, since hydra and the
 *  credentials are per host. One login at a time. Never throws; returns what it did, for the log
 *  and the tests. */
export async function renewStaleLogins(held: () => boolean, opts: { renew?: (name: string) => Promise<boolean> } = {}): Promise<{ name: string; ok: boolean; error?: string }[]> {
  if (!held()) return [];
  const profiles = await hydraUsage();
  const stale = (profiles ?? []).filter((p) => isStaleState(p.state));
  const results: { name: string; ok: boolean; error?: string }[] = [];
  for (const p of stale) {
    try {
      await refreshProfile(p.name, opts);
      results.push({ name: p.name, ok: true });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[usage] background renew of ${p.name}: ${error}`);
      results.push({ name: p.name, ok: false, error });
    }
  }
  return results;
}

export const DEFAULT_CLAUDE_DIR = join(homedir(), ".claude");

/** The macOS Keychain service the CLI stores a login's OAuth token under. Read out of the CLI
 *  itself (2.1.263): the default directory uses the bare name; any `CLAUDE_CONFIG_DIR` appends a
 *  dash and the first 8 hex chars of the SHA-256 of the directory path (NFC-normalised). The path
 *  must be byte-identical to what the CLI saw in its environment, so Orca always passes the same
 *  expanded absolute path it hashes here. */
export function keychainService(configDir: string): string {
  if (configDir === DEFAULT_CLAUDE_DIR) return "Claude Code-credentials";
  return `Claude Code-credentials-${createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

// Reads a login's OAuth access token from wherever the CLI stored it: `.credentials.json` in its
// config dir (Linux/others), else the macOS Keychain. Returns null if that dir isn't logged in.
export async function readClaudeToken(configDir = DEFAULT_CLAUDE_DIR): Promise<string | null> {
  const parse = (raw: string): string | null => {
    try { return JSON.parse(raw)?.claudeAiOauth?.accessToken ?? null; } catch { return null; }
  };
  const file = Bun.file(join(configDir, ".credentials.json"));
  if (await file.exists()) return parse(await file.text());
  if (process.platform === "darwin") {
    // Bounded: a locked Keychain prompting for access must not hang the usage poll.
    const { stdout: out, code } = await runCmd(["security", "find-generic-password", "-s", keychainService(configDir), "-w"], { timeoutMs: 5_000, allowFail: true });
    if (code === 0) return parse(out.trim());
  }
  return null;
}

// Last good reading per login, so a transient endpoint failure keeps the meter (and the profile
// picker's view of headroom) on the previous value rather than blanking it.
const lastGoodClaude = new Map<string, ClaudeUsage>();
let lastGoodCodex: CodexUsage | null = null;

// A box with no `codex` on PATH logged "Executable not found" on every usage poll — dozens of
// lines an hour in journalctl, for something that will never change until the next restart. Said
// once, not every poll.
let loggedMissingCodex = false;

async function claudeUsage(configDir = DEFAULT_CLAUDE_DIR): Promise<ClaudeUsage | null> {
  try {
    const token = await readClaudeToken(configDir);
    if (!token) return lastGoodClaude.get(configDir) ?? null;
    // Bun.fetch, not the global: the test DOM shim swaps global fetch for one without file:// support.
    // No AbortSignal: under the test DOM shim the global AbortSignal isn't Bun's, and Bun rejects it.
    const response = await withTimeout(
      Bun.fetch(claudeUsageUrl(token), { headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" } }),
      8000, "usage fetch timed out");
    if (!response.ok) return lastGoodClaude.get(configDir) ?? null;
    lastGoodClaude.set(configDir, shapeUsage(await response.json()));
  } catch (error) {
    console.error("[usage] Claude fetch failed:", error instanceof Error ? error.message : error);
  }
  return lastGoodClaude.get(configDir) ?? null;
}

/** Ask the installed Codex CLI for the same percentage limits shown by `/usage`. `codex: null` in
 *  the payload covers both "not installed" and "installed but the read failed" — the meter has
 *  nothing to show either way; this function only controls how noisy getting there is. */
async function codexUsage(): Promise<CodexUsage | null> {
  // Live PATH, not Bun's startup snapshot — the test PATH shim relies on it, same as hydraUsage.
  const codex = which("codex");
  if (!codex) {
    if (!loggedMissingCodex) {
      loggedMissingCodex = true;
      console.error("[usage] codex not found on PATH; not installed, so Codex usage will read null until the bridge restarts");
    }
    return null;
  }
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    // The resolved path and the live env: Bun.spawn's own PATH is the startup snapshot.
    const child = Bun.spawn([codex, "app-server", "--listen", "stdio://"], { env: scrubbedEnv(), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    proc = child;
    const requests = [
      { id: 1, method: "initialize", params: { clientInfo: { name: "orca", title: "Orca", version: "0.1.0" }, capabilities: { experimentalApi: true } } },
      { id: 2, method: "account/rateLimits/read", params: null },
    ];
    child.stdin.write(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
    await child.stdin.flush();

    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let rateRaw: any = null;
    const timeout = setTimeout(() => proc?.kill(), 8000);
    try {
      while (!rateRaw) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const message = JSON.parse(line.trim());
            if (message.id === 2 && message.result) rateRaw = message.result;
          } catch { /* app-server diagnostics and partial lines are safe to skip */ }
        }
      }
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
    }
    const shaped = shapeCodexUsage(rateRaw);
    if (shaped) lastGoodCodex = shaped;
  } catch (error) {
    console.error("[usage] Codex read failed:", error instanceof Error ? error.message : error);
  } finally {
    proc?.kill();
  }
  return lastGoodCodex;
}

/** Current usage for every locally authenticated provider. Claude comes from hydra when it is
 *  installed (every login, three windows each), else from the default login's endpoint reading;
 *  Codex from its app server. Null only when nothing at all is available. */
export async function usage(): Promise<Usage | null> {
  const [profiles, codex, routing] = await Promise.all([hydraUsage(), codexUsage(), routingInfo()]);
  const claude = profiles ? (profiles[0]?.usage ?? null) : await claudeUsage();
  if (!claude && !profiles?.some((p) => p.usage) && !codex) return null;
  return { claude, codex, ...(profiles ? { profiles } : {}), routing };
}
