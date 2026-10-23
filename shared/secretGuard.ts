// Two pure pieces of the secret store (server/secrets.ts):
// - `secretFindings`: the chat composer's paste guard. Text that looks like a key is held before it
//   is sent, with "Save as secret" or "Send anyway".
// - `scrubSecrets`: every stored secret value replaced by its name in text that goes back to an
//   agent, into a transcript or out through a channel.

export type SecretFinding = { start: number; end: number; value: string; kind: string; suggestedName: string };

/** Known key shapes, most specific first, so a prefix two patterns both match (e.g. "sk-") is
 *  claimed by the narrower one. Each `name` is the default secret name the guard offers. Shapes
 *  taken from the gitleaks rule set (MIT), kept to well-known, low-false-positive forms. Exported
 *  so `server/handoff.ts` scans for the same shapes as this paste guard. */
export const KEY_PATTERNS: { kind: string; name: string; re: RegExp }[] = [
  { kind: "Anthropic API key", name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: "OpenRouter API key", name: "openrouter-key", re: /\bsk-or-[A-Za-z0-9_-]{20,}/g },
  { kind: "OpenAI-style API key", name: "api-key", re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "Stripe API key", name: "stripe-key", re: /\b(?:sk_live_|sk_test_|rk_live_)[A-Za-z0-9]{20,}\b/g },
  { kind: "GitHub token", name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: "GitLab personal access token", name: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "Slack token", name: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "Discord bot token", name: "discord-token", re: /\b[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,40}\b/g },
  { kind: "AWS access key", name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "Google API key", name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "Google OAuth client secret", name: "google-oauth-secret", re: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "SendGrid API key", name: "sendgrid-key", re: /\bSG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}\b/g },
  { kind: "Twilio API key", name: "twilio-key", re: /\bSK[0-9a-fA-F]{32}\b/g },
  { kind: "Twilio account SID", name: "twilio-sid", re: /\bAC[0-9a-fA-F]{32}\b/g },
  { kind: "npm token", name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "PyPI token", name: "pypi-token", re: /\bpypi-[A-Za-z0-9_-]{50,}\b/g },
  { kind: "Hugging Face token", name: "huggingface-token", re: /\bhf_[A-Za-z0-9]{34,40}\b/g },
  { kind: "Shopify token", name: "shopify-token", re: /\bsh(?:pat|pca|pss|ppa)_[0-9a-fA-F]{32}\b/g },
  { kind: "Notion token", name: "notion-token", re: /\b(?:secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{32,50})\b/g },
  { kind: "Linear API key", name: "linear-key", re: /\blin_api_[A-Za-z0-9]{40}\b/g },
  { kind: "JWT", name: "jwt", re: /\beyJ[A-Za-z0-9_-]{2,}\.eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/g },
  { kind: "private key", name: "private-key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g },
];

/** A keyword that, just before a long token on the same line, turns an otherwise plain token (hex,
 *  single case, or under 32 chars) into a finding — a context rule for the shapes above's gap: a
 *  hex-only or single-case key with no known prefix. Optional quotes and a separator (`=`, `:` or a
 *  space) may sit between the keyword and the token; a bare commit sha or UUID has no such keyword,
 *  so it stays unflagged. The gap on each side of the separator is capped at 3 characters, so the
 *  match stays linear in the input length (CodeQL flagged the uncapped version as slow). The value
 *  must also hold a digit (checked below, not here): without that, prose like "the token
 *  internationalization" is held too. */
const CONTEXT_KEY_RE = /(?<=\b(?:api[_-]?key|key|token|secret|password|passwd|pwd|auth|bearer)\b[ \t]{0,3}[:=]?[ \t]{0,3}["']?)[A-Za-z0-9_-]{16,}/gi;

/** True when `text` just before `start` ends with a base64 data URI header (`data:<mime>;base64,`),
 *  so the payload after it — which reads as high-entropy mixed-case-plus-digit noise, or sits right
 *  after a word like "key" in a mime type — is never treated as a credential. Pure. */
function afterDataUriHeader(text: string, start: number): boolean {
  return /data:[\w.+-]+\/[\w.+-]+;base64,[ \t]{0,3}["']?$/i.test(text.slice(Math.max(0, start - 200), start));
}

/** Shannon entropy of a string, in bits per character. Pure. */
export function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

/** A long token with no spaces that mixes letters and digits and has high entropy: a random key.
 *  A hex hash (a commit sha) and a UUID read as random too, but they are not secrets, so hex-only
 *  and UUID shapes are left out. A URL or a path is left out too. Pure. */
export function looksRandom(token: string): boolean {
  if (token.length < 32 || token.length > 512) return false;
  if (/[/\\:@.]/.test(token) && !/^[A-Za-z0-9+/=_-]+$/.test(token)) return false;
  if (/^[0-9a-f-]+$/i.test(token)) return false; // a sha, a UUID
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[0-9]/.test(token)) return false;
  return entropy(token) >= 4;
}

/** Every key-like piece of `text`, in order, never overlapping. Pure. */
export function secretFindings(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const taken = (s: number, e: number) => out.some((f) => s < f.end && e > f.start);
  for (const p of KEY_PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      const start = m.index!, end = start + m[0].length;
      if (!taken(start, end)) out.push({ start, end, value: m[0], kind: p.kind, suggestedName: p.name });
    }
  }
  for (const m of text.matchAll(/[A-Za-z0-9+/=_-]{32,}/g)) {
    const start = m.index!, end = start + m[0].length;
    if (!taken(start, end) && !afterDataUriHeader(text, start) && looksRandom(m[0])) out.push({ start, end, value: m[0], kind: "long random string", suggestedName: "secret" });
  }
  // Last: only a token the fallback above left alone (hex-only, single case, or under 32 chars),
  // that holds a digit, is not a base64 data URI payload, and sits right after one of the
  // keywords in CONTEXT_KEY_RE.
  for (const m of text.matchAll(CONTEXT_KEY_RE)) {
    const start = m.index!, end = start + m[0].length;
    if (taken(start, end) || !/[0-9]/.test(m[0]) || afterDataUriHeader(text, start)) continue;
    out.push({ start, end, value: m[0], kind: "key-like value", suggestedName: "secret" });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** `text` with each finding replaced by `replace(finding, index)`. Pure. */
export function replaceFindings(text: string, findings: SecretFinding[], replace: (f: SecretFinding, i: number) => string): string {
  let out = "", at = 0;
  [...findings].sort((a, b) => a.start - b.start).forEach((f, i) => { out += text.slice(at, f.start) + replace(f, i); at = f.end; });
  return out + text.slice(at);
}

/** The shortest value the scrub replaces. A shorter one ("1", "yes") would cut ordinary words out of
 *  every log; such a value is still stored, but it is not a credential worth that cost. */
export const SCRUB_MIN_LENGTH = 6;

/** `text` with every stored secret value replaced by `[secret <ref>]`. Longest value first, so a
 *  value that contains another is replaced whole. Pure; the caller passes the values it holds. */
export function scrubSecrets(text: string, secrets: readonly { ref: string; value: string }[]): string {
  if (!text || !secrets.length) return text;
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.value.length - a.value.length)) {
    if (s.value.length < SCRUB_MIN_LENGTH || !out.includes(s.value)) continue;
    out = out.split(s.value).join(`[secret ${s.ref}]`);
  }
  return out;
}

/** Every string in a JSON-like value scrubbed (a structured outcome, a tool's input). Pure. */
export function scrubDeep<T>(value: T, secrets: readonly { ref: string; value: string }[]): T {
  if (!secrets.length) return value;
  if (typeof value === "string") return scrubSecrets(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, secrets)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, secrets)])) as T;
  return value;
}
