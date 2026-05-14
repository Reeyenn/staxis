'use client';

// ─── useWalkthroughVoice — Nova TTS playback for walkthrough narration ────
//
// Sends each step's narration to /api/agent/speak (Nova voice), plays the
// returned MP3 stream through a single <Audio> element, and cancels any
// in-flight playback + fetch when the next step fires or the user hits Stop.
//
// Mirrors the voice chat's useTtsPlayer pattern but stripped down: we don't
// need a queue (one narration at a time), don't need a speaker on/off
// toggle (that's the permission prompt), don't need a per-sentence chunker
// (each narration is ~60 chars).
//
// The hook is fire-and-forget by design — speak() returns a Promise that
// resolves when audio finishes OR when aborted. Callers don't have to
// await; the walkthrough's next /step happens in parallel with the audio.
//
// 2026-05-14, walkthrough voice swap.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';

export interface SpeakResult {
  ok: boolean;
  /** HTTP status code, or 'abort' / 'error' for non-HTTP failures. */
  code?: number | string;
}

export function useWalkthroughVoice() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cleanup = useCallback(() => {
    // Cancel in-flight fetch first so we stop downloading bytes.
    abortRef.current?.abort();
    abortRef.current = null;
    // Pause + detach any playing audio.
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.src = '';
      } catch {
        /* best-effort */
      }
    }
    // Revoke the blob URL so the browser frees the audio buffer.
    if (objectUrlRef.current) {
      try { URL.revokeObjectURL(objectUrlRef.current); } catch { /* best-effort */ }
      objectUrlRef.current = null;
    }
  }, []);

  /**
   * Cancel any in-flight audio (without ending the walkthrough). Use this
   * between steps and on Stop.
   */
  const stop = useCallback(() => {
    cleanup();
  }, [cleanup]);

  /**
   * Send `text` to /api/agent/speak and play the returned MP3. Resolves when
   * the audio finishes naturally OR when interrupted by stop()/abort.
   *
   * On HTTP errors (429 cap, 502 OpenAI hiccup) the promise resolves
   * `{ ok: false, code }` and the caller decides whether to keep going.
   * The walkthrough's policy is to fall back to silent for that step.
   */
  const speak = useCallback(async (text: string, propertyId: string): Promise<SpeakResult> => {
    if (!text?.trim()) return { ok: true };
    if (!propertyId) return { ok: false, code: 'no-property' };

    // Always cancel any prior playback first. The walkthrough has at most
    // one active narration at any moment.
    cleanup();

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetchWithAuth('/api/agent/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: 'nova', propertyId }),
        signal: abort.signal,
      });
      if (!res.ok) {
        return { ok: false, code: res.status };
      }

      // Read the entire stream into a blob, then play. (The voice chat
      // pipes chunks for sentence-by-sentence speech; our narrations
      // are short enough that buffering is simpler + indistinguishable.)
      const blob = await res.blob();
      if (abort.signal.aborted) return { ok: false, code: 'abort' };

      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;

      const audio = new Audio(url);
      audioRef.current = audio;

      return await new Promise<SpeakResult>((resolve) => {
        audio.onended = () => {
          // Don't cleanup here — the next speak() call will. Avoids racing
          // with a fast-following next-step audio.
          resolve({ ok: true });
        };
        audio.onerror = () => {
          resolve({ ok: false, code: 'audio-error' });
        };
        // If the caller aborts mid-play, settle the promise.
        abort.signal.addEventListener('abort', () => {
          resolve({ ok: false, code: 'abort' });
        });
        audio.play().catch((err) => {
          // Autoplay policy / decode failure. Resolve so the loop continues.
          resolve({ ok: false, code: err?.name ?? 'play-error' });
        });
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'AbortError') return { ok: false, code: 'abort' };
      return { ok: false, code: 'fetch-error' };
    }
  }, [cleanup]);

  // Cleanup on unmount.
  useEffect(() => () => cleanup(), [cleanup]);

  // Stabilize the returned object so consumers that include it in
  // useEffect/useCallback deps don't re-run on every render. Without this,
  // the overlay's "cleanup on unmount" useEffect (which depends on stopSpeech
  // → voice.stop) would tear down every render and abort the live walkthrough.
  return useMemo(() => ({ speak, stop }), [speak, stop]);
}
