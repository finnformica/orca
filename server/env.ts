// The environment every process Orca spawns gets. Orca's own secrets never reach anything that runs
// code Orca doesn't own — an agent, a check, a preview's dev server, a git hook in an agent-edited
// worktree, a browser, a provider session — so a prompt injection that reads the environment finds
// no Slack token or database URL. Provider keys (ANTHROPIC_*, OPENAI_*) are deliberately left alone:
// they are the CLI's, not ours.

/** Orca's secrets. Add one here and every spawn drops it. */
export const ORCA_SECRETS = ["SLACK_TOKEN", "ORCA_DATABASE_URL", "ORCA_TEST_DATABASE_URL"] as const;

export type Env = Record<string, string | undefined>;

/** The bridge's LIVE environment (Bun.spawn otherwise snapshots PATH at startup, which defeats a
 *  test's PATH shim) minus Orca's secrets, with `extra` laid over it — a key set to `undefined` is
 *  removed. `keep` names secrets this one spawn may still see (a deliberate, named allow-back). */
export function scrubbedEnv(extra: Env = {}, opts: { keep?: readonly string[] } = {}): Record<string, string> {
  const env: Env = { ...process.env };
  for (const key of ORCA_SECRETS) if (!opts.keep?.includes(key)) delete env[key];
  Object.assign(env, extra);
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env as Record<string, string>;
}

/** `bin/worker` holds the tools every run may use — `orca-shot`, the one way to take a screenshot
 *  (server/screenshot.ts). Not `bin/`: `orca` there is the orchestrator's, not a worker's. */
export const WORKER_BIN = new URL("../bin/worker", import.meta.url).pathname;

/** The environment a spawned agent (or its check) gets: scrubbed, with `bin/worker` first on PATH.
 *  Which Claude LOGIN a run uses is not Orca's call: `claude` on PATH is hydra's shim, which picks
 *  the account with the most headroom per launch (see CLAUDE.md "Handover ladder"). */
export function agentEnv(extra: Env = {}): Record<string, string> {
  return scrubbedEnv({ PATH: `${WORKER_BIN}:${process.env.PATH ?? ""}`, ...extra });
}
