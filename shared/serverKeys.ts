// Server keys: the credentials Orca itself owns (an OAuth client, a bot token, a signing secret).
// Each one comes ONLY from an environment variable of the bridge, read when it is needed — never
// from Settings, the app config or the secret store. A feature whose variable is missing is
// disabled, not an error: the API answers `{ configured: false, needs: "<VAR>" }` and the page greys
// it out with that name. A key a person pastes for their own account (Granola, Cloudflare, Linear,
// the Slack user token, a Gmail sign-in) is NOT a server key and stays where it is.
// docs/SETUP.md "Server keys". Pure: no I/O, so the server, the page and the tests share it.

export type Env = Record<string, string | undefined>;

/** The Google OAuth client of "Sign in with Google" (Gmail). */
export const GOOGLE_CLIENT_ID_ENV = "ORCA_GOOGLE_OAUTH_CLIENT_ID";
export const GOOGLE_CLIENT_SECRET_ENV = "ORCA_SECRET_GOOGLE_OAUTH";
/** Optional: a fixed public https base for Google's redirect (else the page's own https origin). */
export const GOOGLE_REDIRECT_ORIGIN_ENV = "ORCA_GOOGLE_OAUTH_REDIRECT_ORIGIN";
/** Optional, not a secret: one base URL for Google's endpoints (a fake Google in the tests, a proxy). */
export const GOOGLE_API_BASE_ENV = "ORCA_GOOGLE_API_BASE";
/** The default variables of the integration kinds whose token is a server key. */
export const DISCORD_BOT_ENV = "ORCA_SECRET_DISCORD_BOT";
export const WEBHOOK_SECRET_ENV = "ORCA_SECRET_WEBHOOK";
export const SLACK_APP_TOKEN_ENV = "SLACK_APP_TOKEN";
export const VOICE_KEY_ENV = "ORCA_SECRET_OPENAI_API_KEY";

export type ServerFeature = "googleSignIn" | "discord" | "webhook" | "slackSocketMode" | "voice";
/** Each feature: a label for people and the variables it needs (all of them). */
export const SERVER_KEYS: Record<ServerFeature, { label: string; env: string[] }> = {
  googleSignIn: { label: "Sign in with Google (Gmail)", env: [GOOGLE_CLIENT_ID_ENV, GOOGLE_CLIENT_SECRET_ENV] },
  discord: { label: "Discord bot", env: [DISCORD_BOT_ENV] },
  webhook: { label: "Webhook signing secret", env: [WEBHOOK_SECRET_ENV] },
  slackSocketMode: { label: "Slack Socket Mode (optional)", env: [SLACK_APP_TOKEN_ENV] },
  voice: { label: "Voice input", env: [VOICE_KEY_ENV] },
};

/** One feature's state on one bridge. `needs` names the missing variables, comma-separated. */
export type FeatureState = { configured: boolean; needs?: string };

const set = (env: Env, name: string): boolean => !!env[name]?.trim();

/** Whether `feature` has its variables in `env`. */
export function featureState(feature: ServerFeature, env: Env): FeatureState {
  const missing = SERVER_KEYS[feature].env.filter((n) => !set(env, n));
  return missing.length ? { configured: false, needs: missing.join(", ") } : { configured: true };
}

/** Every feature's state, for `/api/config`'s `serverKeys`. */
export function serverFeatures(env: Env): Record<ServerFeature, FeatureState> {
  return Object.fromEntries((Object.keys(SERVER_KEYS) as ServerFeature[]).map((f) => [f, featureState(f, env)])) as Record<ServerFeature, FeatureState>;
}

/** The short note the page shows beside a disabled feature. */
export const needsNote = (s: FeatureState): string => `Not set up on this server: set ${s.needs} in the server's environment and restart Orca.`;

/** The integration kinds whose row secret is a server key, with the variable a row falls back to. */
export const SERVER_KEY_KINDS: Record<string, { feature: ServerFeature; env: string }> = {
  discord: { feature: "discord", env: DISCORD_BOT_ENV },
  webhook: { feature: "webhook", env: WEBHOOK_SECRET_ENV },
};

const STORED = "secret:";
const isStored = (v: unknown): v is string => typeof v === "string" && v.trim().startsWith(STORED);

/** An integration row with every server key read from the environment. A value saved before the
 *  move (a stored secret on a Discord or webhook row or Slack's `appTokenRef`, Gmail's own client id,
 *  client secret or redirect origin) is dropped, and `ignored` says, once per value, which variable
 *  to set instead. Everything else in the row is unchanged. */
export function serverKeyRow<C extends { id: string; kind: string; secretRef?: string; config: Record<string, unknown> }>(c: C): { row: C; ignored: string[] } {
  const ignored: string[] = [];
  const note = (what: string, env: string) => ignored.push(`integration ${c.id}: ${what} is a server key and is ignored; set ${env} in the environment`);
  let row = c;
  const kind = SERVER_KEY_KINDS[c.kind];
  if (kind && isStored(c.secretRef)) {
    note(`the stored secret ${c.secretRef}`, kind.env);
    row = { ...row, secretRef: kind.env };
  }
  if (c.kind === "slack" && isStored(c.config.appTokenRef)) {
    note(`appTokenRef ${String(c.config.appTokenRef)}`, SLACK_APP_TOKEN_ENV);
    const { appTokenRef: _drop, ...config } = row.config;
    row = { ...row, config };
  }
  if (c.kind === "gmail") {
    const config = { ...row.config };
    if (typeof config.clientId === "string") { note("config.clientId", GOOGLE_CLIENT_ID_ENV); delete config.clientId; }
    if (typeof config.redirectOrigin === "string") { note("config.redirectOrigin", GOOGLE_REDIRECT_ORIGIN_ENV); delete config.redirectOrigin; }
    if (c.secretRef) note(`secret_ref ${c.secretRef}`, GOOGLE_CLIENT_SECRET_ENV);
    const { secretRef: _s, ...rest } = row;
    row = { ...(rest as C), config };
  }
  return { row, ignored };
}

/** Why a saved row names a server key the wrong way (a stored secret), else undefined. */
export function serverKeyRefusal(c: { kind: string; secretRef?: string; config?: Record<string, unknown> }): string | undefined {
  const kind = SERVER_KEY_KINDS[c.kind];
  if (kind && isStored(c.secretRef)) return `the ${SERVER_KEYS[kind.feature].label.toLowerCase()} is a server key: name an environment variable (default ${kind.env}), not a stored secret`;
  if (c.kind === "slack" && isStored(c.config?.appTokenRef)) return `appTokenRef is a server key: name an environment variable (default ${SLACK_APP_TOKEN_ENV}), not a stored secret`;
  return undefined;
}
