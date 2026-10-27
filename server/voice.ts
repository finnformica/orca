// Voice input for the chat composer: the browser records a clip (MediaRecorder: audio/webm in Chrome,
// audio/mp4 in Safari on iPhone) and posts it here; this bridge sends it to OpenAI's transcription
// API and answers the text, which goes into the composer for an edit before send. The key is read
// ONLY here, per request, from `ORCA_SECRET_OPENAI_API_KEY` — the `ORCA_SECRET_` prefix means
// `scrubbedEnv` drops it from every spawn, so no agent or preview sees it. The key is never logged
// and never answered; an upstream error is passed on with any key-like text masked.

import { VOICE_KEY_ENV } from "../shared/serverKeys";
export { VOICE_KEY_ENV };
export const TRANSCRIBE_MODEL = "gpt-4o-transcribe";
export const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
/** A two-minute clip is 1–3 MB in either format; OpenAI's own limit is 25 MB. */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60_000;

/** Whether the mic shows: a boolean only, never the key. */
export const voiceAvailable = (env: Record<string, string | undefined> = process.env): boolean => Boolean(env[VOICE_KEY_ENV]?.trim());

/** The file name OpenAI reads the format from. Safari's audio/mp4 is AAC in MP4; Chrome's audio/webm is Opus. */
export function audioFileName(mime: string): string {
  const t = mime.split(";")[0]!.trim().toLowerCase();
  const ext = t === "audio/mp4" || t === "audio/x-m4a" || t === "audio/m4a" ? "m4a"
    : t === "audio/webm" || t === "video/webm" ? "webm"
    : t === "audio/ogg" ? "ogg"
    : t === "audio/wav" || t === "audio/x-wav" ? "wav"
    : t === "audio/mpeg" ? "mp3"
    : "";
  return ext ? `voice.${ext}` : "";
}

/** Upstream text with the key (and anything that looks like an OpenAI key) masked. */
export function redact(text: string, key: string): string {
  let out = key ? text.split(key).join("[redacted]") : text;
  out = out.replace(/sk-[A-Za-z0-9_*-]{6,}/g, "[redacted]");
  return out.slice(0, 300);
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

/** POST /api/voice/transcribe: multipart field `audio` → `{ text }`. */
export async function handleTranscribe(req: Request, opts: { env?: Record<string, string | undefined>; fetch?: typeof fetch } = {}): Promise<Response> {
  const key = (opts.env ?? process.env)[VOICE_KEY_ENV]?.trim();
  if (!key) return json({ error: `voice input is off: ${VOICE_KEY_ENV} is not set on this bridge` }, 503);
  // Refuse a big body before reading it. A form's own overhead is small, so allow 64 KB of it.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_AUDIO_BYTES + 64 * 1024) return json({ error: `audio is too large (max ${MAX_AUDIO_BYTES / 1024 / 1024} MB)` }, 413);
  let audio: File | undefined;
  try {
    const f = (await req.formData()).get("audio");
    audio = typeof f === "string" || !f ? undefined : f;
  } catch {
    return json({ error: "expected a multipart form with an audio field" }, 400);
  }
  if (!audio || audio.size === 0) return json({ error: "no audio recorded" }, 400);
  if (audio.size > MAX_AUDIO_BYTES) return json({ error: `audio is too large (max ${MAX_AUDIO_BYTES / 1024 / 1024} MB)` }, 413);
  const name = audioFileName(audio.type) || audioFileName(`audio/${audio.name.split(".").pop() ?? ""}`);
  if (!name) return json({ error: `unsupported audio type: ${audio.type || "unknown"}` }, 415);

  const form = new FormData();
  form.append("file", new File([await audio.arrayBuffer()], name, { type: audio.type }));
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "json");
  let r: Response;
  try {
    r = await (opts.fetch ?? fetch)(TRANSCRIBE_URL, {
      method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    return json({ error: `transcription service unreachable: ${redact(e instanceof Error ? e.message : String(e), key)}` }, 502);
  }
  const body = await r.text();
  if (!r.ok) {
    let msg = body;
    try { msg = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body; } catch { /* plain text */ }
    return json({ error: `transcription failed (${r.status}): ${redact(msg, key)}` }, 502);
  }
  try {
    const text = (JSON.parse(body) as { text?: unknown }).text;
    if (typeof text !== "string") throw new Error("no text");
    return json({ text: text.trim() });
  } catch {
    return json({ error: "transcription service answered without text" }, 502);
  }
}
