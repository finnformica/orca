// Voice input for ChatComposer: record with MediaRecorder, send the clip to the bridge
// (`/api/voice/transcribe`, server/voice.ts) and hand the text back for an edit before send.
// Chrome records audio/webm (Opus), Safari on iPhone audio/mp4 (AAC). getUserMedia needs a secure
// context: the tailnet's HTTPS name or localhost.
import { useEffect, useRef, useState } from "react";
import { api } from "@/api";

/** A clip stops by itself after this long. */
export const MAX_RECORD_MS = 2 * 60_000;

export type VoicePhase = "idle" | "recording" | "transcribing";

/** The first container this browser records, in order of preference; "" lets the browser pick. */
export function pickAudioMime(supported: (type: string) => boolean): string {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) if (supported(t)) return t;
  return "";
}

/** The upload's file name, so the bridge (and OpenAI) read the right format. */
export const clipName = (type: string): string => `voice.${type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"}`;

/** `m:ss` for the record clock. */
export function recordClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The draft with the transcript after it: a space between them, never in front of an empty draft. */
export function appendTranscript(draft: string, text: string): string {
  const t = text.trim();
  if (!t) return draft;
  if (!draft.trim()) return t;
  return /\s$/.test(draft) ? draft + t : `${draft} ${t}`;
}

/** Why the mic did not open, in words a person can act on. */
export function micError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked. Allow it in the browser's site settings.";
  if (name === "NotFoundError") return "No microphone found.";
  return e instanceof Error ? e.message : String(e);
}

/** The composer's recorder. `onText` gets the transcript; `onError` a message for the toast. */
export function useVoiceRecorder(onText: (text: string) => void, onError: (message: string) => void) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const cb = useRef({ onText, onError });
  cb.current = { onText, onError };
  const live = useRef<{ recorder: MediaRecorder; stream: MediaStream; discard: boolean; startedAt: number } | null>(null);
  const opening = useRef(false);
  const mounted = useRef(true);

  const stop = () => {
    const r = live.current?.recorder;
    if (r && r.state !== "inactive") r.stop();
  };

  const start = async () => {
    if (live.current || opening.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      cb.current.onError("This browser cannot record audio on this page. Open Orca over HTTPS.");
      return;
    }
    opening.current = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      opening.current = false;
      cb.current.onError(micError(e));
      return;
    }
    opening.current = false;
    if (!mounted.current) { stream.getTracks().forEach((t) => t.stop()); return; }
    const mime = pickAudioMime((t) => MediaRecorder.isTypeSupported?.(t) ?? false);
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      cb.current.onError(e instanceof Error ? e.message : String(e));
      return;
    }
    const chunks: Blob[] = [];
    const timer = setTimeout(stop, MAX_RECORD_MS);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      clearTimeout(timer);
      stream.getTracks().forEach((t) => t.stop()); // the phone's mic indicator goes off
      const discard = live.current?.discard ?? true;
      live.current = null;
      if (discard || !mounted.current) { setPhase("idle"); return; }
      const type = recorder.mimeType || mime || chunks[0]?.type || "audio/webm";
      const blob = new Blob(chunks, { type });
      if (!blob.size) { setPhase("idle"); cb.current.onError("No audio was recorded."); return; }
      setPhase("transcribing");
      try {
        const text = await api.transcribe(blob, clipName(type));
        if (!mounted.current) return;
        if (text.trim()) cb.current.onText(text);
        else cb.current.onError("No speech was heard in the recording.");
      } catch (e) {
        if (mounted.current) cb.current.onError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted.current) setPhase("idle");
      }
    };
    live.current = { recorder, stream, discard: false, startedAt: Date.now() };
    recorder.start();
    setElapsed(0);
    setPhase("recording");
  };

  // The clock, while a clip records.
  useEffect(() => {
    if (phase !== "recording") return;
    const id = setInterval(() => { if (live.current) setElapsed(Date.now() - live.current.startedAt); }, 250);
    return () => clearInterval(id);
  }, [phase]);

  // A composer that goes away drops its clip and frees the mic.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (live.current) { live.current.discard = true; stop(); }
    };
  }, []);

  return { phase, elapsed, start, stop, toggle: () => (phase === "recording" ? stop() : phase === "idle" ? void start() : undefined) };
}
