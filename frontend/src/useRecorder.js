// src/useRecorder.js
//
// Custom hook that handles the full mic -> backend -> text pipeline.
//
// Strategy:
//   1. getUserMedia once when recording starts. Keep the MediaStream alive
//      for the whole session so we don't re-prompt for permission.
//   2. Every 30s, stop the current MediaRecorder (which flushes a complete,
//      self-contained webm blob) and immediately start a new one on the same
//      stream. Each blob is a valid file Whisper can decode standalone.
//   3. Each blob is POSTed to /transcribe as fire-and-forget. Uploads don't
//      block chunking — if one request is slow, the next chunk still goes out
//      on schedule.
//   4. When a response arrives, call onTranscript(text) so the component can
//      append to UI state.
//
// Notes / tradeoffs:
//   - There's a tiny gap (tens of ms) between stop and start where audio is
//     dropped. Invisible for meeting-copilot purposes; spec says "roughly
//     every 30s" so exact continuity isn't required.
//   - We pick a mime type the browser supports. Chrome/Firefox prefer
//     audio/webm;codecs=opus. Safari only has audio/mp4. The backend's
//     Whisper call infers codec from the filename extension, so we pass
//     the right extension with each upload.

import { useEffect, useRef, useState } from "react";
import { API_BASE, getApiKey } from "./api";

// Picks the best supported mime type for this browser.
// Returns { mimeType, extension } or null if none work.
function pickMimeType() {
  const candidates = [
    { mimeType: "audio/webm;codecs=opus", extension: "webm" },
    { mimeType: "audio/webm", extension: "webm" },
    { mimeType: "audio/mp4", extension: "mp4" }, // Safari
    { mimeType: "audio/ogg;codecs=opus", extension: "ogg" },
  ];
  for (const c of candidates) {
    if (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(c.mimeType)
    ) {
      return c;
    }
  }
  return null;
}

const CHUNK_MS = 30_000;

export function useRecorder({ isRecording, onTranscript }) {
  const [error, setError] = useState(null);

  // Refs for everything that shouldn't trigger re-renders.
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunkTimerRef = useRef(null);
  const mimeRef = useRef(null);
  // Keep latest onTranscript without re-subscribing the effect on every render.
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    if (!isRecording) return undefined;

    let cancelled = false;

    const uploadBlob = async (blob, chunkStartedAt) => {
      if (!blob || blob.size === 0) return;

      const apiKey = getApiKey();
      if (!apiKey) {
        setError("No Groq API key set. Add one in Settings.");
        return;
      }

      const ext = mimeRef.current?.extension || "webm";
      const form = new FormData();
      form.append("audio_file", blob, `chunk.${ext}`);
      form.append("api_key", apiKey);

      try {
        const res = await fetch(`${API_BASE}/transcribe`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          setError(
            `Transcription failed (${res.status}): ${detail.slice(0, 160)}`,
          );
          return;
        }
        const data = await res.json();
        const segments = Array.isArray(data?.segments) ? data.segments : [];
        const fullText = (data?.text || "").trim();

        if (segments.length > 0) {
          // Preferred path: one entry per segment with real timestamps.
          onTranscriptRef.current?.({
            type: "segments",
            chunkStartedAt,
            segments, // [{ start, end, text }, ...]
            fullText,
          });
        } else if (fullText) {
          // Fallback: no segments returned, use one blob with chunk-start time.
          onTranscriptRef.current?.({
            type: "segments",
            chunkStartedAt,
            segments: [{ start: 0, end: 0, text: fullText }],
            fullText,
          });
        }
        if (!cancelled) setError(null);
      } catch (e) {
        setError(`Network error uploading audio: ${e.message}`);
      }
    };

    // Start a fresh MediaRecorder on the persistent stream. When it stops,
    // ondataavailable fires with one complete blob, which we upload.
    const startNewRecorder = () => {
      if (!streamRef.current || cancelled) return;
      const { mimeType } = mimeRef.current;
      const rec = new MediaRecorder(streamRef.current, { mimeType });
      const chunkStartedAt = Date.now();

      const parts = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) parts.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(parts, { type: mimeType });
        uploadBlob(blob, chunkStartedAt);
      };
      rec.onerror = (e) => {
        setError(`Recorder error: ${e.error?.message || "unknown"}`);
      };

      rec.start();
      recorderRef.current = rec;
    };

    // Every CHUNK_MS: stop the current recorder (flushes a blob) and immediately
    // start a new one. The stream stays alive across this rotation.
    const rotate = () => {
      const current = recorderRef.current;
      if (current && current.state !== "inactive") {
        current.stop(); // triggers onstop -> upload
      }
      startNewRecorder();
    };

    (async () => {
      // Pick codec.
      const mime = pickMimeType();
      if (!mime) {
        setError("This browser doesn't support MediaRecorder audio formats.");
        return;
      }
      mimeRef.current = mime;

      // Ask for mic permission + get the stream.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        setError(null);
      } catch (e) {
        setError(
          e.name === "NotAllowedError"
            ? "Microphone permission denied. Allow mic access and try again."
            : `Could not access microphone: ${e.message}`,
        );
        return;
      }

      // Kick off the first recorder and the 30s rotation timer.
      startNewRecorder();
      chunkTimerRef.current = setInterval(rotate, CHUNK_MS);
    })();

    // Cleanup when isRecording flips to false or component unmounts.
    return () => {
      cancelled = true;
      if (chunkTimerRef.current) {
        clearInterval(chunkTimerRef.current);
        chunkTimerRef.current = null;
      }
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        // Final flush — this blob will upload after the stop event fires.
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
      }
      recorderRef.current = null;

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [isRecording]);

  return { error };
}
