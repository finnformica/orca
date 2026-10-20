// Voice input: POST /api/voice/transcribe (server/voice.ts) with OpenAI's API faked by an injected
// fetch, plus the composer's pure recorder helpers (web/src/lib/voice.ts).
import { describe, expect, test } from "bun:test";
import { MAX_AUDIO_BYTES, TRANSCRIBE_MODEL, TRANSCRIBE_URL, VOICE_KEY_ENV, audioFileName, handleTranscribe, redact, voiceAvailable } from "../server/voice";
import { appendTranscript, clipName, pickAudioMime, recordClock } from "../web/src/lib/voice";
import { native } from "./happydom";

const KEY = "sk-proj-TESTKEY1234567890abcdef";
const env = { [VOICE_KEY_ENV]: KEY };

/** A multipart body built the way a browser sends it (as tests/attachmentsRelay.test.ts does): the
 *  happy-dom preload swaps in a FormData that cannot be read back reliably — `handleTranscribe`'s
 *  own `req.formData()` call read "no audio recorded" for every real clip once enough other test
 *  files had run before this one. `native.Request` is Bun's own, captured before happy-dom replaced
 *  the global, so its `.formData()` uses Bun's multipart parser, not happy-dom's. */
function multipartBody(fields: { name: string; filename?: string; type?: string; bytes: Uint8Array }[]): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const boundary = `----orcaVoiceTest${crypto.randomUUID()}`;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const f of fields) {
    const disposition = f.filename ? `form-data; name="${f.name}"; filename="${f.filename}"` : `form-data; name="${f.name}"`;
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${f.type ? `Content-Type: ${f.type}\r\n` : ""}\r\n`), f.bytes, enc.encode("\r\n"));
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { body.set(p, at); at += p.byteLength; }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

// Bun's own multipart parser (now that `upload()` goes through it, not happy-dom's) does not carry a
// part's Content-Type into File.type — `audio.type` always reads "". `handleTranscribe` already
// expects this: it falls back to the upload's filename extension, which is why the real client
// (web/src/lib/voice.ts) always names the clip with `clipName(type)` ("voice.webm", "voice.m4a").
// An unrecognised type (the "unsupported" test) keeps a plain name, same as a browser never would
// send one for it.
const EXT: Record<string, string> = { "audio/webm": "webm", "audio/mp4": "m4a" };

function upload(bytes: number | Uint8Array<ArrayBuffer>, type = "audio/webm", headers: Record<string, string> = {}): Request {
  const fileBytes = typeof bytes === "number" ? new Uint8Array(bytes) : bytes;
  const filename = EXT[type] ? `clip.${EXT[type]}` : "clip";
  const { body, contentType } = multipartBody([{ name: "audio", filename, type, bytes: fileBytes }]);
  return new native.Request("http://127.0.0.1/api/voice/transcribe", { method: "POST", headers: { "content-type": contentType, ...headers }, body });
}

type Seen = { url: string; auth: string | null; file: File; model: string };
function fakeOpenAI(answer: () => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const form = init.body as FormData;
    seen.push({ url, auth: new Headers(init.headers).get("authorization"), file: form.get("file") as File, model: String(form.get("model")) });
    return answer();
  }) as unknown as typeof fetch;
  return { fetch: f, seen };
}

describe("POST /api/voice/transcribe", () => {
  test("sends the clip to OpenAI with gpt-4o-transcribe and answers the text", async () => {
    const ai = fakeOpenAI(() => Response.json({ text: "  fix the flaky test  " }));
    const r = await handleTranscribe(upload(new Uint8Array([1, 2, 3])), { env, fetch: ai.fetch });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ text: "fix the flaky test" });
    expect(ai.seen).toHaveLength(1);
    expect(ai.seen[0]!.url).toBe(TRANSCRIBE_URL);
    expect(ai.seen[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(ai.seen[0]!.model).toBe(TRANSCRIBE_MODEL);
    expect(ai.seen[0]!.file.name).toBe("voice.webm");
    expect(new Uint8Array(await ai.seen[0]!.file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("Safari's audio/mp4 goes up as m4a", async () => {
    const ai = fakeOpenAI(() => Response.json({ text: "hi" }));
    const r = await handleTranscribe(upload(4, "audio/mp4"), { env, fetch: ai.fetch });
    expect(r.status).toBe(200);
    expect(ai.seen[0]!.file.name).toBe("voice.m4a");
  });

  test("no key: 503, and OpenAI is never called", async () => {
    const ai = fakeOpenAI(() => Response.json({ text: "x" }));
    const r = await handleTranscribe(upload(4), { env: {}, fetch: ai.fetch });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toContain(VOICE_KEY_ENV);
    expect(ai.seen).toHaveLength(0);
    expect(voiceAvailable({})).toBe(false);
    expect(voiceAvailable({ [VOICE_KEY_ENV]: "  " })).toBe(false);
    expect(voiceAvailable(env)).toBe(true);
  });

  test("too large audio: 413 by the file's size, and by a declared length before the body is read", async () => {
    const ai = fakeOpenAI(() => Response.json({ text: "x" }));
    const big = await handleTranscribe(upload(MAX_AUDIO_BYTES + 1), { env, fetch: ai.fetch });
    expect(big.status).toBe(413);
    // A stub: a real Request computes its own content-length. Its body must never be read.
    const huge = { headers: new Headers({ "content-length": String(MAX_AUDIO_BYTES * 2) }), formData: () => { throw new Error("body read"); } } as unknown as Request;
    const declared = await handleTranscribe(huge, { env, fetch: ai.fetch });
    expect(declared.status).toBe(413);
    expect(ai.seen).toHaveLength(0);
  });

  test("an empty clip, a missing field and an unknown type are refused", async () => {
    const ai = fakeOpenAI(() => Response.json({ text: "x" }));
    expect((await handleTranscribe(upload(0), { env, fetch: ai.fetch })).status).toBe(400);
    const { body: emptyBody, contentType: emptyType } = multipartBody([]);
    const noField = new native.Request("http://127.0.0.1/api/voice/transcribe", { method: "POST", headers: { "content-type": emptyType }, body: emptyBody });
    expect((await handleTranscribe(noField, { env, fetch: ai.fetch })).status).toBe(400);
    expect((await handleTranscribe(upload(4, "image/png"), { env, fetch: ai.fetch })).status).toBe(415);
    expect(ai.seen).toHaveLength(0);
  });

  test("an OpenAI error is a 502 with its message, and the key never comes back", async () => {
    const ai = fakeOpenAI(() => Response.json({ error: { message: `Incorrect API key provided: ${KEY}. Also sk-abcdefghijkl.` } }, { status: 401 }));
    const r = await handleTranscribe(upload(4), { env, fetch: ai.fetch });
    expect(r.status).toBe(502);
    const text = await r.text();
    expect(text).toContain("transcription failed (401)");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("sk-abcdefghijkl");
  });

  test("an unreachable OpenAI is a 502 without the key", async () => {
    const f = (async () => { throw new Error(`connect failed with ${KEY}`); }) as unknown as typeof fetch;
    const r = await handleTranscribe(upload(4), { env, fetch: f });
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain(KEY);
  });

  test("helpers: file names and redaction", () => {
    expect(audioFileName("audio/webm;codecs=opus")).toBe("voice.webm");
    expect(audioFileName("audio/mp4")).toBe("voice.m4a");
    expect(audioFileName("text/plain")).toBe("");
    expect(redact(`a ${KEY} b`, KEY)).toBe("a [redacted] b");
  });
});

describe("recorder helpers", () => {
  test("pickAudioMime: webm in Chrome, mp4 in Safari, the browser's own pick otherwise", () => {
    expect(pickAudioMime((t) => t.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(pickAudioMime((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickAudioMime(() => false)).toBe("");
  });
  test("clipName, recordClock and appendTranscript", () => {
    expect(clipName("audio/mp4;codecs=mp4a.40.2")).toBe("voice.m4a");
    expect(clipName("audio/webm;codecs=opus")).toBe("voice.webm");
    expect(recordClock(0)).toBe("0:00");
    expect(recordClock(75_400)).toBe("1:15");
    expect(appendTranscript("", " hello ")).toBe("hello");
    expect(appendTranscript("fix", "the test")).toBe("fix the test");
    expect(appendTranscript("fix\n", "the test")).toBe("fix\nthe test");
    expect(appendTranscript("keep", "  ")).toBe("keep");
  });
});
