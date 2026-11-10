// `orca secret show <name>`: an agent shows a stored value to the user in the Orca chat. The tool
// result holds only a token, `orca-secret://<ref>~<at>~<mac>` (server/secrets.ts `show`), and the
// mask `[secret <ref>]`. The chat draws a card for each token in a turn's tool results and asks the
// owner-only reveal route (server/secretRoutes.ts) for the value. So the value is on the user's screen
// only: never in the stored transcript, memory, a channel post or the model's context. Pure.

export const SECRET_SHOW_REF = "orca-secret://";
/** The mac's length in hex characters (64 bits of HMAC-SHA256). */
export const SHOW_MAC_HEX = 16;
/** A card shows the value at once while its token is this young; an older one waits for Reveal. */
export const SHOW_FRESH_MS = 15 * 60_000;

export type SecretShow = { token: string; ref: string; at: number; mac: string };

export const secretShowRef = (ref: string, at: number, mac: string): string => `${SECRET_SHOW_REF}${ref}~${at}~${mac}`;

const TOKEN = /orca-secret:\/\/([A-Za-z0-9_.-]{1,64}(?:\/[A-Za-z0-9_.-]{1,64})?)~(\d{10,16})~([0-9a-f]{16})/g;

/** Every show token in a text, in order, each once. Pure. */
export function parseSecretShows(text: string | undefined): SecretShow[] {
  const out: SecretShow[] = [];
  for (const m of (text ?? "").matchAll(TOKEN)) {
    if (out.some((s) => s.token === m[0])) continue;
    out.push({ token: m[0], ref: m[1]!, at: Number(m[2]), mac: m[3]! });
  }
  return out;
}

/** The show tokens of a turn: those in its loaded tool results (a running turn's steps arrive on the
 *  stream) plus those the bridge linked (`turn.secretShows`), each once. Only a tool RESULT counts,
 *  never the reply text: a card needs a real `orca secret show` call. Pure. */
export function turnSecretShows(turn: { secretShows?: string[]; steps?: { kind: string; output?: string; isError?: boolean }[] }): SecretShow[] {
  const out = parseSecretShows((turn.secretShows ?? []).join("\n"));
  for (const s of turn.steps ?? []) {
    if (s.kind !== "result" || s.isError) continue;
    for (const t of parseSecretShows(s.output)) if (!out.some((o) => o.token === t.token)) out.push(t);
  }
  return out;
}

/** Does the card show the value without a click? Only while the show is fresh: a later read of the
 *  chat (another day, a shared screen) waits for Reveal. Pure. */
export const showFresh = (at: number, now: number): boolean => now - at >= -60_000 && now - at < SHOW_FRESH_MS;

/** What `orca secret show` prints for the agent: the mask and the token, never the value. */
export function showToolText(ref: string, token: string): string {
  return [
    `Shown to the user in the Orca chat: [secret ${ref}] (${token}).`,
    "Only the Orca chat shows the value. You, the transcript, memory and channel posts see only the mask.",
    "Do not try to read, repeat or post the value.",
  ].join("\n");
}
